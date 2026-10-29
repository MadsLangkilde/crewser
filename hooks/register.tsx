import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, Register, RenderChildren, Timer } from 'claude-code'

import type { CrewAttention, CrewBoard, CrewMe, CrewPeerRow, CrewUsage } from '../types'
import * as L from './lib'
import * as S from './strategy'
import { CROPS, guessKind, KIND_NAMES, KINDS } from './town/kinds'
import * as Ledger from './town/ledger'
import { World, ZOOMS } from './town/world'
import type { CrewSession, Snapshot, TownBuilding } from './town/world'

const meA = atom({ plugin: 'crewser', key: 'me' } as const, null)
const usageA = atom({ plugin: 'crewser', key: 'usage' } as const, {})
const attentionA = atom({ plugin: 'crewser', key: 'attention' } as const, null)
const pulseA = atom({ plugin: 'crewser', key: 'pulse' } as const, 0)
const peersA = atom({ plugin: 'crewser', key: 'peers' } as const, [])
const taskA = atom({ plugin: 'crewser', key: 'task' } as const, null)
const boardA = atom({ plugin: 'crewser', key: 'board' } as const, { mode: 'manage', index: 0, v: 0 } as CrewBoard)

const PANE = 'crew'
/** How a crew's sessions open: a window each, tiled, or tabs in its lead's window; chosen when the task starts or resumes. */
type OpenAs = 'windows' | 'tabs'
const ROLES = ['Implementer', 'Reviewer', 'Tester', 'Researcher']
const MODELS = ['opus', 'sonnet', 'haiku']

const options = (o: PluginOptions) => ({
  showBand: o.showBand !== false,
  barsPosition: String(o.barsPosition ?? 'below'),
  showContext: o.showContext !== false,
  showSessionLimit: o.showSessionLimit !== false,
  showWeeklyLimit: o.showWeeklyLimit !== false,
  showCost: o.showCost === true,
  barStyle: String(o.barStyle ?? 'blocks') as L.BarStyle,
  barWidth: Number(o.barWidth ?? 12),
  barColors: String(o.barColors ?? 'traffic'),
  autoName: o.autoName !== false,
  colorTarget: String(o.colorTarget ?? 'prompt'),
  tintStrength: Number(o.tintStrength ?? 14),
  macNotify: o.macNotify !== false,
  flashOnPing: o.flashOnPing !== false,
  autoKickoff: o.autoKickoff !== false,
  strategiesFolder: String(o.strategiesFolder ?? ''),
  townFolder: String(o.townFolder ?? ''),
})

// The module's own view of the disk; rebuilt from the files and $.state on every load.
let opt = options({})
let d: L.Dirs | null = null
let disk: L.DiskSession | null = null
let all: L.DiskSession[] = []
let tasks: L.DiskTask[] = []
let pulseTimer: Timer | null = null
let focusStreak = 0
let ticking = false
let toolsUp = false
/** Whether this window has been in a crew task: only such a window looks for an invitation back into a resumed one. */
let wasCrew = false
let idleTicks = 0
let pendingTitle: string | null = null
let termInfo: { tty: string | null; term: string; profile: string | null } = { tty: null, term: '', profile: null }
const baseColors = new Map<string, string>()

const usesPrompt = () => opt.colorTarget === 'prompt' || opt.colorTarget === 'both'
const usesBackground = () => opt.colorTarget === 'background' || opt.colorTarget === 'both'

const others = (t: number) =>
  all.filter(s => disk !== null && s.id !== disk.id && L.isLive(s, t) && !!s.task && s.task.id === disk.task?.id)
const teammates = (t: number) => (disk?.task ? others(t).filter(s => s.task?.id === disk?.task?.id) : [])

// ---- host helpers

async function osa($: EngineInterface, script: string) {
  const r = await $.process.run(['osascript', '-e', script], { timeoutMs: 5000 }).catch(() => null)
  return r?.exitCode === 0 ? r.stdout.trim() : null
}

async function toTty($: EngineInterface, tty: string, seq: string) {
  await $.process
    .run(['sh', '-c', 'printf "%b" "$1" > "$2"', 'sh', seq, tty], { timeoutMs: 3000 })
    .catch(() => undefined)
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return null
  }
}

async function readDir($: EngineInterface, dir: string): Promise<unknown[]> {
  const entries = await $.fs.list(dir).catch(() => [])
  const files = entries.filter(f => f.kind === 'file' && f.name.endsWith('.json'))
  const rows = await Promise.all(files.map(f => readJson($, `${dir}/${f.name}`)))
  return rows.filter(r => r !== null)
}

async function loadDisk($: EngineInterface) {
  if (!d) return
  all = (await readDir($, d.sessions)) as L.DiskSession[]
  const t = await $.clock.now()
  tasks = ((await readDir($, d.tasks)) as L.DiskTask[]).filter(
    k => !k.ended && (k.creator === disk?.id || all.some(s => s.id === k.creator && L.isLive(s, t)) || (!!k.pendingLead && t - k.createdAt < 3 * 60_000)),
  )
}

// ---- a task's history: what happened in it, so it can be picked up later and the overseer can follow it. Each session
// writes its own file per task (~/.claude/crew/history/<task>/<session>.json); read together, oldest first.

const myHistory = new Map<string, L.HistoryEvent[]>()

async function logEvent($: EngineInterface, taskId: string, kind: L.HistoryKind, text: string, feature?: L.HistoryEvent['feature']) {
  if (!d || !disk || !taskId) return
  const path = `${d.root}/history/${taskId}/${disk.id}.json`
  // by file: a /clear goes on under a new session id, in a file of its own
  const mine = myHistory.get(path) ?? (((await readJson($, path)) as L.HistoryEvent[] | null) ?? [])
  const next = [...mine, { at: await $.clock.now(), by: disk.name || 'someone', kind, text: L.gist(text, 300), ...(feature ? { feature } : {}) }].slice(-300)
  myHistory.set(path, next)
  await $.fs.write(path, JSON.stringify(next)).catch(err => note($, 'history', err))
}

async function readHistory($: EngineInterface, taskId: string): Promise<L.HistoryEvent[]> {
  if (!d) return []
  const rows = await readDir($, `${d.root}/history/${taskId}`)
  return rows.filter(Array.isArray).flat().filter((e): e is L.HistoryEvent => !!e && typeof (e as L.HistoryEvent).at === 'number').sort((a, b) => a.at - b.at)
}

/** Only crew members are on disk: a session outside a task writes nothing, except the one record saying it left. */
async function save($: EngineInterface, force = false) {
  if (!d || !disk || (!disk.task && !disk.overseer && !force)) return
  disk.beat = await $.clock.now()
  await $.fs.write(`${d.sessions}/${disk.id}.json`, JSON.stringify(disk))
}

async function writeTask($: EngineInterface, task: L.DiskTask) {
  if (d) await $.fs.write(`${d.tasks}/${task.id}.json`, JSON.stringify(task))
}

// ---- the town: every building a project's crews have put up, kept across tasks, one file per building in the
// project's `.crewser/town` (or the folder the town setting names), so it is committed and merged like code

type Town = { v: 2; project: string; folder: string; buildings: TownBuilding[] }

/** The folders a session keeps things in, from the settings: empty means inside the project. */
function folderFor(setting: string, root: string, kind: 'town' | 'strategies') {
  const raw = setting.trim()
  if (!raw) return `${root}/.crewser/${kind}`
  const home = d?.home ?? ''
  const at = raw === '~' ? home : raw.startsWith('~/') ? `${home}/${raw.slice(2)}` : raw.startsWith('/') ? raw : `${root}/${raw}`
  // one shared folder holds every project's town, a folder each
  return (kind === 'town' ? `${at.replace(/\/+$/, '')}/${S.slug(L.basename(root))}` : at.replace(/\/+$/, ''))
}

/** Every building in a town folder; files git left both sides in are merged and written back clean. */
async function loadTown($: EngineInterface, folder: string, project = L.basename(folder.replace(/\/\.crewser\/town$/, ''))): Promise<Town> {
  const entries = await $.fs.list(folder).catch(() => [])
  const files = entries.filter(f => f.kind === 'file' && f.name.endsWith('.json'))
  const t = await $.clock.now()
  const rows = await Promise.all(files.map(async f => {
    const text = await $.fs.read(`${folder}/${f.name}`).catch(() => '')
    const { ledger, merged } = Ledger.read(text)
    if (ledger && merged) {
      await $.fs.write(`${folder}/${f.name}`, Ledger.write(ledger)).catch(() => undefined)
      mergedNow.add(ledger.name.toLowerCase())
    }
    return ledger
  }))
  // a burnt building is drawn ten minutes, so a town opened meanwhile still sees it burn; its file stays, so a merge
  // from someone who has not seen it burn does not bring it back
  const buildings = rows
    .filter((l): l is Ledger.Ledger => !!l && (l.status !== 'removed' || t - l.at < 10 * 60_000))
    .sort((a, b) => a.since - b.since)
    .map(Ledger.built)
  return { v: 2, project, folder, buildings }
}

/** Buildings merged from two people's changes since the view last looked: they get a little celebration. */
const mergedNow = new Set<string>()

/** The town this session's task builds in: the lead's project's. */
function taskTown(): string {
  const k = tasks.find(x => x.id === disk?.task?.id)
  return all.find(s => s.id === k?.creator)?.town ?? k?.town ?? disk?.town ?? ''
}

/** The legacy town file (~/.claude/crew/towns/<project>.json), moved into the town folder the first time it is read. */
async function adoptLegacyTown($: EngineInterface, folder: string, project: string) {
  if (!d || !folder) return
  const old = `${d.root}/towns/${S.slug(project)}.json`
  if (!(await $.fs.exists(old).catch(() => false))) return
  const raw = (await readJson($, old)) as { buildings?: unknown[] } | null
  const have = await $.fs.list(folder).catch(() => [])
  const taken = new Map<string, string>()
  for (const f of have) taken.set(f.name, f.name)
  if (!have.some(f => f.name.endsWith('.json'))) {
    for (const b of raw?.buildings ?? []) {
      const l = Ledger.shape(b)
      if (!l) continue
      const file = Ledger.fileFor(l.name, taken)
      taken.set(file, l.name)
      await $.fs.write(`${folder}/${file}`, Ledger.write(l))
    }
  }
  await $.process.run(['mv', old, `${old}.moved`], { timeoutMs: 3000 }).catch(() => undefined)
}

/** Reads one building's file by name (null when it has none), and the file name it has or gets. */
async function ledgerOf($: EngineInterface, folder: string, name: string) {
  const entries = (await $.fs.list(folder).catch(() => [])).filter(f => f.kind === 'file' && f.name.endsWith('.json'))
  const taken = new Map<string, string>()
  let found: { file: string; ledger: Ledger.Ledger } | null = null
  for (const f of entries) {
    const { ledger } = Ledger.read(await $.fs.read(`${folder}/${f.name}`).catch(() => ''))
    if (!ledger) continue
    taken.set(f.name, ledger.name)
    if (ledger.name.toLowerCase() === name.toLowerCase() && (!found || ledger.at > found.ledger.at)) found = { file: f.name, ledger }
  }
  return found ?? { file: Ledger.fileFor(name, taken), ledger: null }
}

/** A feature started, finished or dropped: a new building, an existing one rebuilt a level up, or one that burns down. */
async function recordBuilding($: EngineInterface, name: string, status: 'building' | 'done' | 'removed', t: number, what: { kind?: string; parent?: string; crop?: string } = {}) {
  const folder = taskTown()
  if (!d || !disk || !folder) return null
  const { file, ledger } = await ledgerOf($, folder, name)
  const before = ledger && ledger.status !== 'removed' ? Ledger.built(ledger) : null
  const next = Ledger.record(ledger, name, status, t, { by: disk.name, color: disk.color }, what)
  if (next) await $.fs.write(`${folder}/${file}`, Ledger.write(next))
  return before
}

/** Where the town view placed new buildings, kept in each building's file so they never move. */
async function keepPlacements($: EngineInterface, folder: string, spots: { name: string; dx: number; dy: number }[]) {
  for (const p of spots) {
    const { file, ledger } = await ledgerOf($, folder, p.name)
    if (ledger && ledger.status !== 'removed' && (ledger.dx !== p.dx || ledger.dy !== p.dy)) {
      await $.fs.write(`${folder}/${file}`, Ledger.write({ ...ledger, dx: p.dx, dy: p.dy }))
    }
  }
}

async function setMe($: EngineInterface, patch: Partial<CrewMe>) {
  await update($, meA, me => (me ? { ...me, ...patch } : me))
}

/** Notes why the engine refused something, for the next time we look: ~/.claude/crew/debug.log. */
async function note($: EngineInterface, what: string, err: unknown) {
  if (!d) return
  const line = `${new Date().toISOString()} ${what}: ${String((err as Error)?.message ?? err).slice(0, 300)}\n`
  const before = await $.fs.read(`${d.root}/debug.log`).catch(() => '')
  await $.fs.write(`${d.root}/debug.log`, (before + line).slice(-20_000)).catch(() => undefined)
}

/**
 * /color only takes effect as the person's own command; a plugin's run of it may be refused.
 * Then it is put in the prompt box, ready: one Enter applies it.
 */
async function setColor($: EngineInterface, colorName: string) {
  if (!opt.autoName || !usesPrompt()) return
  const cc = L.ccOf(colorName)
  const ran = await $.command
    .run({ command: 'color', args: cc })
    .then(r => !/invalid|cannot|unknown|not available/i.test(r.text ?? ''))
    .catch(async err => (await note($, 'color', err), false))
  if (ran) return
  const { isFilled } = await $.prompt.fill({ text: `/color ${cc}`, mode: 'replace' }).catch(() => ({ isFilled: false }))
  $.ui.toast(isFilled ? `Press Enter to give this session its crew color (${cc})` : `Run /color ${cc} to give this session its crew color`, { timeoutMs: 10_000 })
}

/**
 * The session's full title: its name with its task's name and short code (`Checkout flow #4821 · Implementer #1`),
 * so sessions of several tasks are told apart in windows, tabs and Claude's session list. The overseer's names its project.
 */
function currentTitle() {
  if (!disk) return ''
  if (disk.task) return L.titleOf(disk.name, tasks.find(k => k.id === disk?.task?.id) ?? disk.task)
  return disk.overseer ? `${disk.name} · ${disk.project}` : disk.name
}

/** The name goes on through the prompt hook's sessionTitle, the way settings hooks retitle a session. */
function rename($: EngineInterface, name: string) {
  if (!opt.autoName) return
  pendingTitle = name
  void $.command.run({ command: 'rename', args: name }).catch(err => note($, 'rename', err))
}

// ---- the terminal

/** Paints a color onto the terminal: a background tint (Terminal.app) or the tab color (iTerm2). */
async function paint($: EngineInterface, me: CrewMe, hex: string, strength: number) {
  if (!me.tty) return
  if (me.term === 'Apple_Terminal' && me.profile) {
    const base =
      baseColors.get(me.profile) ??
      (await osa($, `tell application "Terminal" to get background color of settings set "${me.profile}"`))
    if (base) baseColors.set(me.profile, base)
    const parts = (base ?? '5866, 5866, 5866').split(',').map(n => Number(n.trim()) / 257)
    const share = Math.max(0, Math.min(0.6, strength / 100))
    const [r, g, b] = L.mix(parts, L.hexToRgb(hex), share).map(v => Math.round(v * 257))
    await osa($, L.inTab(me.tty, `set background color of t to {${r}, ${g}, ${b}}\n return "ok"`))
  } else if (me.term === 'iTerm.app') {
    await toTty($, me.tty, L.iTermTab(hex))
  }
}

async function unpaint($: EngineInterface, me: CrewMe) {
  if (!me.tty) return
  if (me.term === 'Apple_Terminal' && me.profile) {
    await osa(
      $,
      L.inTab(me.tty, `set background color of t to (background color of settings set "${me.profile}")\n return "ok"`),
    )
  } else if (me.term === 'iTerm.app') {
    await toTty($, me.tty, L.ITERM_RESET)
  }
}

async function tint($: EngineInterface) {
  const me = await read($, meA)
  if (!me) return
  if (usesBackground()) await paint($, me, me.color, opt.tintStrength)
  else await unpaint($, me)
}

/** Whether this session's window is in front: null where it cannot tell. */
/** Whether this session's window can be watched for focus; elsewhere a ping is acknowledged by a prompt or Seen. */
const seesFocus = (me: CrewMe | null) => !!me?.tty && me.term === 'Apple_Terminal'

async function isFocused($: EngineInterface, me: CrewMe) {
  if (!seesFocus(me) || !me.tty) return null
  const r = await osa(
    $,
    L.inTab(me.tty, 'return ((frontmost as text) & "," & (index of w as text) & "," & (selected of t as text))'),
  )
  if (!r) return null
  const [front, index, selected] = r.split(',')
  return front === 'true' && index === '1' && selected === 'true'
}

async function nudge($: EngineInterface, me: CrewMe, title: string, body: string) {
  if (me.tty) await toTty($, me.tty, me.term === 'iTerm.app' ? L.ITERM_ATTENTION : L.BELL)
  if (opt.macNotify) {
    await osa($, `display notification "${L.asText(body)}" with title "${L.asText(title)}" sound name "Glass"`)
  }
}

// ---- start

async function init($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? '/tmp'
  const root = `${home}/.claude/crew`
  d = { root, sessions: `${root}/sessions`, tasks: `${root}/tasks`, home }
  const t = await $.clock.now()
  const id = await $.session.id()
  await loadDisk($)
  const own = all.find(s => s.id === id) ?? null
  wasCrew = !!own
  const live = all.filter(s => s.id !== id && L.isLive(s, t))
  const found = await $.process.run(['sh', '-c', L.TTY_SCRIPT], { timeoutMs: 4000 }).catch(() => null)
  const ttyText = found?.stdout.trim() ?? ''
  const tty = /^\/dev\/tty[\w.]+$/.test(ttyText) ? ttyText : null
  const term = (await $.env.get('TERM_PROGRAM')) ?? ''
  const profile = tty && term === 'Apple_Terminal' ? await osa($, L.inTab(tty, 'return name of current settings of t')) : null
  termInfo = { tty, term, profile }

  // a session stays anonymous until it starts or joins a task; a reload or resume keeps what it had
  let me = await read($, meA)
  if (me && me.id !== id) me = null
  const resumed = own && !own.ended && own.task && tasks.some(k => k.id === own.task?.id) ? own : null
  if (!me && resumed) {
    me = {
      id, codename: resumed.codename, name: resumed.name, colorName: resumed.colorName, color: resumed.color,
      ...termInfo, ackedAt: resumed.ackedAt,
    }
    const kept = me
    await update($, meA, () => kept)
  }

  const cwd = await $.session.cwd()
  // the project is the git repository the session is in (its folder when it is in none): strategies and the town live
  // in its main checkout, also for a crew in a worktree of it, so every crew of the project shares them
  const git = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir'], { timeoutMs: 3000 }).catch(() => null)
  const [topLine = '', common = ''] = git?.exitCode === 0 ? git.stdout.trim().split('\n') : []
  const top = topLine.trim() || cwd
  const projectRoot = common.trim().endsWith('/.git') ? common.trim().slice(0, -5) : top
  const town = folderFor(opt.townFolder, projectRoot, 'town')
  disk = {
    v: 1, id, name: me?.name ?? '', codename: me?.codename ?? '', colorName: me?.colorName ?? '', color: me?.color ?? '',
    tty, term, cwd, project: L.basename(projectRoot), root: projectRoot, top, town, model: await $.session.model(),
    startedAt: own?.startedAt ?? t, beat: t, status: 'idle', activity: own?.activity ?? 'just arrived',
    lastPrompt: own?.lastPrompt ?? '', tool: '', detail: '', features: resumed?.features ?? [], ctx: null, five: null, week: null, cost: null,
    task: resumed?.task ?? null, agents: [], pings: resumed?.pings ?? [], posts: resumed?.posts ?? [],
    ackedAt: me?.ackedAt ?? t, relaySeenAt: resumed?.relaySeenAt ?? t, attention: false, ended: false,
  }
  await update($, taskA, () =>
    disk?.task ? { ...disk.task, isLead: tasks.some(k => k.id === disk?.task?.id && k.creator === disk?.id) } : null,
  )
  if (disk.task) {
    await registerTools($)
    await save($)
    await tint($)
  }
  // an overseer reloaded (or resumed) stays the overseer
  if (own?.overseer && !own.ended && !disk.task && me) {
    disk.overseer = true
    await registerTools($)
    await registerOverseerTools($)
    await save($)
  }
  // only what sessions leave behind is swept: their records and orders after a day, ended tasks after a month.
  // Strategies and towns are never touched (they live in the project, or the folders the settings name).
  await $.process
    .run(['sh', '-c', 'find "$1/sessions" "$1/orders" -name "*.json" -mmin +1440 -delete; find "$1/tasks" "$1/history" -name "*.json" -mtime +30 -delete; find "$1/history" -mindepth 1 -type d -empty -delete', 'sh', root], { timeoutMs: 5000 })
    .catch(() => undefined)
  await adoptLegacyTown($, town, L.basename(projectRoot)).catch(err => note($, 'town', err))
  const u = await $.session.usage().catch(() => null)
  if (u) await applyUsage($, u.context, u.rateLimits, u.cost?.usd)
  await tick($)
  $.clock.after(1500, () => void autoJoin($))
}

/** Names this session as the person chose and gives it a /color no other crew member has. */
async function ensureIdentity($: EngineInterface, name: string) {
  if (!disk) return
  await loadDisk($)
  const t = await $.clock.now()
  let me = await read($, meA)
  if (!me || me.id !== disk.id) {
    const live = all.filter(s => s.id !== disk?.id && L.isLive(s, t) && s.task && s.colorName)
    const used = new Set(live.map(s => s.colorName))
    const free = L.PALETTE.filter(([n]) => !used.has(n))
    const [colorName, color] = L.pick(free.length > 0 ? free : L.PALETTE)
    me = { id: disk.id, codename: name, name, colorName, color, ...termInfo, ackedAt: t }
  } else {
    me = { ...me, codename: name, name }
  }
  const next = me
  await update($, meA, () => next)
  Object.assign(disk, { name, codename: name, colorName: me.colorName, color: me.color, ended: false })
  const colorName = me.colorName
  $.clock.after(1500, () => (rename($, currentTitle()), void setColor($, colorName)))
  await registerTools($)
  await tint($)
}

/** Asks the person for this session's name; the default is "<Role> #<n>". */
async function askName($: EngineInterface, taskId: string, role: string) {
  const t = await $.clock.now()
  const same = all.filter(s => s.id !== disk?.id && L.isLive(s, t) && s.task?.id === taskId && s.task.role === role).length
  const fallback = `${role} #${same + 1}`
  const current = (await read($, meA))?.name
  const options = [fallback, ...(current && current !== fallback ? [current] : [`${role} (${disk?.project ?? ''})`])]
  const answer = (await $.ui.ask(`Name this session (type a name, or pick one)`, { header: 'Name', options })).trim()
  return answer ? L.gist(answer, 32) : fallback
}

async function applyUsage(
  $: EngineInterface,
  context: { tokens?: number; window: number; percent?: number },
  limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
  cost: number | undefined,
) {
  const five = limits.find(l => l.kind === 'five_hour')
  const week = limits.find(l => l.kind === 'seven_day')
  const next: CrewUsage = {
    ctx: context.percent, ctxTokens: context.tokens, ctxWindow: context.window,
    five: five?.percentUsed, fiveResetsAt: five?.resetsAt,
    week: week?.percentUsed, weekResetsAt: week?.resetsAt, cost,
  }
  await update($, usageA, () => next)
  if (disk) {
    disk.ctx = next.ctx ?? null
    disk.five = next.five ?? null
    disk.week = next.week ?? null
    disk.cost = next.cost ?? null
  }
}

// ---- the shared loop: heartbeat, peers, pings, task liveness, relayed posts

async function tick($: EngineInterface) {
  if (!d || !disk || ticking) return
  ticking = true
  try {
    const t = await $.clock.now()
    const id = await $.session.id()
    if (id !== disk.id) {
      // a /clear: the same window goes on under a new session id
      disk = { ...disk, id, startedAt: t, pings: [], posts: [], agents: [], ended: false }
      await setMe($, { id })
    }
    const me = disk
    if (me.overseer && !me.task) {
      await loadDisk($)
      await takeOrders($)
      // finished crews whose branch waits for the person, now and then
      if (++idleTicks % 4 === 0) waitingList = await waitingBranches($)
      if (idleTicks % 2 === 0) await loadHistories($)
      await save($)
      await update($, overviewA, v => v + 1)
      return
    }
    if (!me.task) {
      if ((await read($, peersA)).length) await update($, peersA, () => [])
      if (await read($, attentionA)) await stopAttention($)
      // a window that was in a task its lead has resumed goes back into it by itself
      if (wasCrew && ++idleTicks % 2 === 0) await joinInvited($, t)
      return
    }
    await loadDisk($)
    const mine = tasks.find(k => k.id === me.task?.id && k.creator === me.id)
    if (mine) await keepRoster($, mine, t)

    await syncAgents($)
    await takeOrders($)

    // pings for me
    const pending = others(t)
      .flatMap(s => s.pings.filter(p => p.to === me.id && p.at > me.ackedAt).map(p => ({ s, p })))
      .sort((a, b) => b.p.at - a.p.at)
    const cur = await read($, attentionA)
    const top = pending[0]
    if (top && cur?.pingId !== top.p.id) await startAttention($, top.s, top.p)
    if (!top && cur) await stopAttention($)

    // my pings: done once seen, gone or old
    const seen: string[] = []
    me.pings = me.pings.filter(p => {
      const target = all.find(s => s.id === p.to)
      if (!target || !L.isLive(target, t)) return false
      if (target.ackedAt >= p.at) {
        seen.push(target.name)
        return false
      }
      return t - p.at < 30 * 60_000
    })
    for (const name of seen) $.ui.toast(`👀 ${name} saw your ping`)

    // a task outlives nobody but its creator
    if (me.task && !tasks.some(k => k.id === me.task?.id)) {
      $.ui.toast(`⚑ Task "${me.task.name}" ended: its creator left`, { timeoutMs: 8000 })
      await exitCrew($)
      return
    }

    // teammates' posts that SendMessage could not deliver come through the files
    const fresh = teammates(t)
      .flatMap(s =>
        s.posts.filter(p => p.relay && p.at > me.relaySeenAt && (p.to === me.id || p.to === 'all')).map(p => ({ s, p })),
      )
      .sort((a, b) => a.p.at - b.p.at)
    for (const { s, p } of fresh) {
      me.relaySeenAt = Math.max(me.relaySeenAt, p.at)
      void $.prompt
        .submit({ text: `[crew] ${s.name} (${s.task?.role ?? 'teammate'}) says: ${p.text}` })
        .catch(() => undefined)
    }

    me.attention = Boolean(await read($, attentionA))
    await save($)
    await update($, peersA, () => rows(t))
  } finally {
    ticking = false
  }
}

/** Orders the person gave this session from the town: one file, read once, then gone. */
async function takeOrders($: EngineInterface) {
  if (!d || !disk) return
  const path = `${d.root}/orders/${disk.id}.json`
  if (!(await $.fs.exists(path).catch(() => false))) return
  const order = (await readJson($, path)) as { text?: string; leaveAt?: number } | null
  await $.process.run(['rm', '-f', path], { timeoutMs: 3000 }).catch(() => undefined)
  if (!order?.text) return
  // moved to another crew by the overseer: hand over first, then leave
  if (order.leaveAt) {
    const wait = Math.max(5000, order.leaveAt - (await $.clock.now()))
    $.clock.after(wait, () => void leaveTask($).then(text => $.ui.toast(text, { timeoutMs: 8000 })))
  }
  $.ui.toast(order.text.startsWith('[overseer') ? '◆ Orders from the overseer' : '⚑ New orders from the town')
  void $.prompt.submit({ text: order.text }).catch(() => undefined)
}

/** The subagents running in this session right now, background ones included, as the engine lists them. */
async function syncAgents($: EngineInterface) {
  if (!disk) return
  const t = await $.clock.now()
  const listed = await $.agent.list().catch(() => [])
  const before = new Map(disk.agents.map(a => [a.id, a.at]))
  disk.agents = listed
    .filter(a => a.status === 'pending' || a.status === 'running' || a.status === 'waiting')
    .slice(0, 12)
    .map(a => ({ id: a.id, kind: a.type, desc: L.gist(a.description || a.type, 40), at: before.get(a.id) ?? t }))
}

function rows(t: number): CrewPeerRow[] {
  if (!disk?.task) return []
  const mine = all.filter(s => s.id !== disk?.id && L.isLive(s, t) && s.task?.id === disk?.task?.id)
  return [disk, ...mine]
    .map(s => ({
      id: s.id, name: s.name, color: s.color, status: s.status, project: s.project,
      activity: s.activity, task: s.task ? `${L.taskLabel(s.task)}·${s.task.role}` : '', ctx: s.ctx,
      isMe: s.id === disk?.id,
    }))
    .sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.name.localeCompare(b.name))
}

// ---- attention

async function startAttention($: EngineInterface, from: L.DiskSession, ping: L.DiskPing) {
  const att: CrewAttention = {
    pingId: ping.id, fromName: from.name, fromColor: from.color, reason: ping.reason, at: ping.at,
  }
  await update($, attentionA, () => att)
  focusStreak = 0
  const me = await read($, meA)
  if (me && (await isFocused($, me)) !== true) {
    await nudge($, me, `👀 ${me.name}: eyes needed`, `${from.name}: ${ping.reason}`)
  }
  $.ui.toast(`👀 ${from.name} wants eyes here: ${ping.reason}`, { timeoutMs: 10_000 })
  pulseTimer?.cancel()
  pulseTimer = $.clock.every(700, () => void pulse($))
}

async function pulse($: EngineInterface) {
  const n = (await read($, pulseA)) + 1
  await update($, pulseA, () => n)
  const me = await read($, meA)
  if (!me) return
  if (usesBackground() || opt.flashOnPing) {
    await paint($, me, me.color, n % 2 ? Math.max(opt.tintStrength * 3, 40) : usesBackground() ? opt.tintStrength : 0)
  }
  // looking at the window is the acknowledgement: focused on two beats in a row, about a second
  const focused = await isFocused($, me)
  focusStreak = focused ? focusStreak + 1 : 0
  if (focusStreak >= 2) await ack($)
}

async function stopAttention($: EngineInterface) {
  pulseTimer?.cancel()
  pulseTimer = null
  await update($, attentionA, () => null)
  await tint($)
}

async function ack($: EngineInterface) {
  const t = await $.clock.now()
  if (disk) disk.ackedAt = t
  await setMe($, { ackedAt: t })
  await stopAttention($)
  await save($)
}

// ---- what the model reads

function section(): string | null {
  if (disk?.overseer && !disk.task) return overseerSection()
  if (!disk?.task) return null
  const lines = [
    '# Crew',
    `This Claude Code session is "${disk.codename}" (its full title, with the task's name and short code: "${currentTitle()}"). To get the user to look at a teammate's window, flag it with mcp__crewser__ping.`,
  ]
  {
    const k = tasks.find(x => x.id === disk?.task?.id)
    lines.push(
      `## Crew task "${disk.task.name}"`,
      `${k?.goal ? `Goal: ${k.goal}\n` : ''}Your role: ${disk.task.role}. Lead: ${k?.creatorName ?? 'unknown'}.`,
      'You collaborate with other Claude Code sessions in this task. mcp__crewser__team shows teammates, roles and recent posts; ' +
        'mcp__crewser__post messages one teammate by name or "all". Teammates’ messages reach you as peer messages. ' +
        'When you begin a distinct part of the task (a feature, component or milestone) call mcp__crewser__feature with status "start", and "done" when it is finished; ' +
        'when the user decides to drop a feature that was built or started, call it with status "remove". ' +
        'On start, give it the `kind` that fits what it is (it is built as that in the town: a house, a shop, a farm, a dock, a statue...) and, for a part of a bigger feature, its `parent`. ' +
        'Stay in your role, hand work off explicitly, keep posts short, and post when you finish or are blocked.',
    )
    lines.push('When the user wants more people on the crew (one more implementer, a UI expert in a session of its own), mcp__crewser__add_members opens them; /crew-add does the same in a board.')
    if (k?.creator === disk.id) {
      lines.push('As lead, keep the task\'s status with mcp__crewser__status: when a feature is done, when the crew is blocked, when the plan changes, and before the task ends. ' +
        'It is what whoever resumes the task later reads first, and what the overseer sees.')
    }
    if (k?.branch) lines.push(`This crew works in its own git worktree (${k.worktree}) on the branch ${k.branch}, while other crews work on other things: commit your work there. The user decides at the end whether it is merged.`)
    if (k?.paused) lines.push('The overseer has paused this crew: finish the step you are on, then take no new work until it is resumed.')
    if (all.some(s => s.overseer && s.root === disk?.root && !s.ended)) {
      lines.push('The project has an overseer above the leads of all its crews. Follow its briefs (they arrive as messages headed [overseer] or [overseer → …]). ' +
        (k?.creator === disk.id
          ? 'Your mcp__crewser__status reaches it too; answer its questions and briefs with mcp__crewser__post to "overseer".'
          : 'Answer it with mcp__crewser__post to "overseer" when it writes to you.'))
    }
    if (k?.strategy && disk.task.roleId) lines.push('## Strategy', S.brief(k.strategy, disk.task.roleId, disk.task.extra))
    else if (disk.task.extra && k?.strategy) lines.push('## Strategy', S.brief(k.strategy, disk.task.extra.id, disk.task.extra))
  }
  return lines.join('\n')
}

// ---- task flow

/** /crew-task: the board's first step (start, resume, join or leave), or straight to naming a new task when that is all there is to do. */
async function taskFlow($: EngineInterface): Promise<string> {
  if (!d || !disk) return 'Crew is not ready yet.'
  await loadDisk($)
  // the ideas for a new task are asked for now, so they are there, whole, by the time the first step shows
  const ready = await ideasReady($)
  if (!ready) void prepareIdeas($)
  pastList = await pastTasks($)
  waitingList = await waitingBranches($)
  const menu = hasMenu()
  pendingStart = menu ? null : { name: '', goal: '' }
  letGo()
  typed = ''
  if (menu) {
    await openBoard($, 'pick', { view: 'menu' })
    return 'Start, resume, join or leave a task in the board.'
  }
  if (ready) shownIdeas = ideas?.list ?? []
  await openBoard($, 'pick', ready ? { view: 'name' } : { view: 'busy', note: LOOKING })
  if (!ready) void toNameStep($)
  return 'Pick what the crew works on in the board.'
}

/** Whether /crew-task has more to offer than starting one: a task to resume, join or leave. */
const hasMenu = () => !!disk?.task || !!disk?.overseer || tasks.some(k => k.id !== disk?.task?.id) || pastList.length > 0 || waitingList.length > 0

// ---- resuming a task that ended: the same name, goal, strategy and town, and the same crew carrying on

/** This project's tasks that are not running now, the last worked on first. */
let pastList: L.DiskTask[] = []
/** Crews of this project that ended with work on a branch nobody has decided about yet. */
let waitingList: L.DiskTask[] = []

async function waitingBranches($: EngineInterface): Promise<L.DiskTask[]> {
  if (!d || !disk) return []
  const rows = (await readDir($, d.tasks)) as L.DiskTask[]
  return rows.filter(k => k?.ended && k.branch && !k.outcome && k.root === disk?.root).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
}

const GIT_FAIL = { exitCode: 1, stdout: '', stderr: '' }

/** What becomes of a crew's branch, as the person chose: merged into the main checkout's branch, a pull request, or kept. */
async function finishBranch($: EngineInterface, task: L.DiskTask, choice: 'merge' | 'pr' | 'keep'): Promise<string> {
  const { worktree, root, branch } = task
  if (!worktree || !root || !branch) return ''
  const run = (args: string[], timeoutMs = 60_000) => $.process.run(args, { timeoutMs }).catch(err => ({ ...GIT_FAIL, stderr: String(err) }))
  const git = (cwd: string, ...args: string[]) => run(['git', '-C', cwd, ...args])
  // what the crew left uncommitted goes with it
  if (choice !== 'keep' && (await git(worktree, 'status', '--porcelain')).stdout.trim()) {
    await git(worktree, 'add', '-A')
    await git(worktree, 'commit', '-m', `${task.name} (crew)`)
  }
  let outcome: L.DiskTask['outcome'] = 'kept'
  let text = `Kept the branch ${branch} (worktree ${worktree}).`
  if (choice === 'merge') {
    const into = (await git(root, 'branch', '--show-current')).stdout.trim() || 'the main checkout'
    const r = await git(root, 'merge', '--no-ff', '--no-edit', branch)
    if (r.exitCode !== 0) {
      await git(root, 'merge', '--abort')
      return `Could not merge ${branch} into ${into}: ${L.gist(r.stderr || r.stdout, 240)}. Nothing changed; merge it by hand, or open a pull request instead.`
    }
    outcome = 'merged'
    text = `Merged ${branch} into ${into}. The worktree stays at ${worktree}: \`git worktree remove ${worktree}\` once its windows are closed.`
  } else if (choice === 'pr') {
    const pushed = await git(worktree, 'push', '-u', 'origin', branch)
    if (pushed.exitCode !== 0) return `Could not push ${branch}: ${L.gist(pushed.stderr || pushed.stdout, 240)}`
    const pr = await run(['sh', '-c', 'cd "$1" && gh pr create --head "$2" --title "$3" --body "$4"', 'sh', worktree, branch, task.name, task.goal || task.name], 90_000)
    if (pr.exitCode !== 0) return `Pushed ${branch}, but could not open the pull request: ${L.gist(pr.stderr || pr.stdout, 240)}`
    outcome = 'pr'
    text = `Opened a pull request for ${branch}: ${pr.stdout.trim().split('\n').pop() ?? ''}`
  }
  await writeTask($, { ...task, outcome, outcomeNote: text })
  await logEvent($, task.id, 'branch', text)
  return text
}

/** Asks what to do with a crew's branch. */
async function askBranch($: EngineInterface, task: L.DiskTask): Promise<string> {
  if (!task.branch || !task.root) return ''
  const into = (await $.process.run(['git', '-C', task.root, 'branch', '--show-current'], { timeoutMs: 5000 }).catch(() => null))?.stdout.trim() || 'main'
  const answer = await $.ui.ask(`"${task.name}" worked on the branch ${task.branch}. What should happen to its work?`, {
    header: 'Branch', options: [`Merge it into ${into}`, 'Open a pull request', 'Keep the branch'],
  })
  return finishBranch($, task, answer.startsWith('Merge') ? 'merge' : answer.startsWith('Open') ? 'pr' : 'keep')
}

/** /crew-task → the crews that ended with work on a branch: pick one (when there are several), then merge, a pull request, or keep. */
async function decideBranches($: EngineInterface): Promise<string> {
  const list = await waitingBranches($)
  if (!list.length) return 'No crew work is waiting.'
  const label = (k: L.DiskTask) => L.gist(`${k.name} (${k.branch})`, 60)
  const answer = list.length === 1 ? label(list[0] as L.DiskTask) : await $.ui.ask("Which crew's work?", { header: 'Branch', options: list.slice(0, 4).map(label) })
  const task = list.find(k => label(k) === answer)
  return task ? askBranch($, task) : 'Nothing chosen.'
}

async function pastTasks($: EngineInterface): Promise<L.DiskTask[]> {
  if (!d || !disk) return []
  const rows = (await readDir($, d.tasks)) as L.DiskTask[]
  const running = new Set(tasks.map(k => k.id))
  const project = disk.project
  const list = rows
    .filter(k => k && typeof k.name === 'string' && !running.has(k.id))
    .filter(k => (k.project ?? all.find(s => s.id === k.creator)?.project) === project)
    .sort((a, b) => L.lastWorked(b) - L.lastWorked(a))
    .slice(0, 8)
  pastHistory = new Map(await Promise.all(list.map(async k => [k.id, await readHistory($, k.id)] as const)))
  return Promise.all(list.map(async k => (L.crewOf(k, all).length ? k : { ...k, members: await crewFromTranscripts($, k) })))
}

/** The histories of the tasks to resume, and the few sentences a small model wrote on each (or is writing). */
let pastHistory = new Map<string, L.HistoryEvent[]>()
const summaries = new Map<string, { text: string; at: number } | 'busy' | 'none'>()

/** What a task to resume is about, what was done and what is left: a small model reads its history, once per change. */
async function summarize($: EngineInterface, k: L.DiskTask) {
  const hist = pastHistory.get(k.id) ?? []
  const last = hist[hist.length - 1]?.at ?? 0
  if (!hist.length) return
  if (k.summary && k.summary.at >= last) return void summaries.set(k.id, k.summary)
  const had = summaries.get(k.id)
  if (had === 'busy' || (typeof had === 'object' && had.at >= last)) return
  summaries.set(k.id, 'busy')
  const r = await $.model.complete({ model: 'haiku', prompt: L.summaryPrompt(k, hist), maxTokens: 300, effort: 'low', timeoutMs: 25_000 }).catch(() => null)
  const text = r?.isAnswered ? L.gist(r.text.trim(), 600) : ''
  if (!text) {
    summaries.set(k.id, 'none')
    return setBoard($, {})
  }
  const summary = { text, at: last }
  summaries.set(k.id, summary)
  // kept with the ended task, so the next look needs no model
  const file = (await readJson($, `${d?.tasks}/${k.id}.json`)) as L.DiskTask | null
  if (file?.ended) await writeTask($, { ...file, summary })
  await setBoard($, {})
}

/**
 * The crew of a task from before tasks kept theirs: every session of the project whose transcript has the task's
 * kickoff in it ('...the crew task "<name>"...'), named and colored as its last record says.
 */
async function crewFromTranscripts($: EngineInterface, k: L.DiskTask): Promise<L.TaskMember[]> {
  if (!d || !disk) return []
  const here = disk
  const dir = `${d.root.replace(/\/crew$/, '')}/projects/${here.cwd.replace(/[^a-zA-Z0-9]/g, '-')}`
  const needle = `crew task \\"${k.name}\\"` // as the transcript's JSON writes it
  const r = await $.process.run(['sh', '-c', 'cd "$1" 2>/dev/null && grep -l -F -e "$2" -- *.jsonl', 'sh', dir, needle], { timeoutMs: 6000 }).catch(() => null)
  const ids = (r?.stdout ?? '').split('\n').map(f => f.trim().replace(/\.jsonl$/, '')).filter(id => id && id !== k.creator)
  return ids.map(id => {
    const s = all.find(x => x.id === id)
    const name = s?.name ?? 'Member'
    const role = name.replace(/ #\d+$/, '')
    return { id, name, role, roleId: k.strategy?.roles.find(x => x.name === role)?.id, cwd: s?.cwd ?? here.cwd, color: s?.color ?? '#8a8a8a', lastSeen: s?.beat ?? 0 }
  })
}

/**
 * Starts an ended task again with this session as its lead. With its crew, every member comes back carrying on its
 * own conversation: a window opened again for each that was closed (`claude --resume`), an invitation for each still
 * open, which rejoins by itself.
 */
async function resumeTask($: EngineInterface, past: L.DiskTask, withCrew: boolean, openAs: OpenAs = 'windows'): Promise<string> {
  if (!d || !disk) return ''
  if (disk.task) await leaveTask($)
  await loadDisk($)
  const t = await $.clock.now()
  const me = disk.id
  const crew = withCrew ? L.crewOf(past, all).filter(m => m.id !== me) : []
  const state = (m: L.TaskMember) => {
    const s = all.find(x => x.id === m.id)
    return !s || !L.isLive(s, t) ? 'closed' : s.task ? 'busy' : 'open'
  }
  const open = crew.filter(m => state(m) === 'open')
  const closed = crew.filter(m => state(m) === 'closed')
  const busy = crew.filter(m => state(m) === 'busy')
  const leadRole = past.strategy?.roles[0]
  await ensureIdentity($, (await read($, meA))?.name ?? leadRole?.name ?? 'Lead')
  const task: L.DiskTask = {
    ...past, creator: me, creatorName: disk.name, ended: false, endedAt: undefined, resumedAt: t, openAs,
    project: past.project ?? disk.project, town: past.town ?? disk.town, members: L.crewOf(past, all), invite: open.length ? open.map(m => m.id) : undefined,
  }
  await writeTask($, task)
  disk.task = { id: task.id, name: task.name, role: 'Lead', lead: disk.name, roleId: leadRole?.id, code: L.codeOf(task) }
  wasCrew = true
  tasks = [...tasks.filter(k => k.id !== task.id), task]
  await update($, taskA, () => ({ id: task.id, name: task.name, role: 'Lead', isLead: true }))
  await save($)
  $.ui.invalidate('prompt.section')
  const seats: Seat[] = closed.map(m => ({ role: roleOf(past, m), n: 1, of: 1, name: m.name, resume: m.id }))
  const opened = await openSeats($, task, seats, 1)
  await logEvent($, task.id, 'resume', `Resumed${withCrew && crew.length ? ` with the crew (${openAs})` : ', the lead alone'}`)
  if (seats.length && disk.tty && openAs === 'windows') {
    const area = await desktop($)
    const [x1, y1, x2, y2] = cell(area, 0, crew.length + 1)
    await osa($, L.inTab(disk.tty, `set bounds of w to {${x1}, ${y1}, ${x2}, ${y2}}\n return "ok"`))
  }
  if (crew.length && openAs === 'windows') $.clock.after(12_000, () => void retile($))
  if (leadRole) $.clock.after(2500, () => void applySetup($, leadRole.model, leadRole.effort))
  const lines = [`⚑ Resumed "${task.name}" as its lead${task.goal ? `. Goal: ${task.goal}` : ''}.`]
  if (opened) lines.push(`Reopened ${opened} ${openAs === 'tabs' ? 'tab' : 'window'}${opened > 1 ? 's' : ''}, each carrying on its own conversation: ${closed.map(m => m.name).join(', ')}.`)
  else if (closed.length) lines.push('Could not reopen the windows (Terminal.app only): start Claude there by hand and /crew-task → Join.')
  if (open.length) lines.push(`Still open, rejoining by themselves: ${open.map(m => m.name).join(', ')}.`)
  if (busy.length) lines.push(`Busy in another task now: ${busy.map(m => m.name).join(', ')}.`)
  if (!withCrew) lines.push('Just you for now: /crew-add brings members in.')
  return lines.join(' ')
}

// ---- what to work on next: a few ideas for a new task, from the project's recent work

type Idea = { name: string; goal: string }
let ideas: { project: string; at: number; list: Idea[]; busy: boolean } | null = null
let ideasJob: Promise<void> | null = null
/** The ideas the first step shows, fixed when it first shows: nothing appears or changes in it while it is up. */
let shownIdeas: Idea[] = []
const LOOKING = 'Looking at the project for what could come next…'

/** Whether this project's ideas are at hand: some came, less than ten minutes ago. */
async function ideasReady($: EngineInterface) {
  return !!disk && ideas?.project === disk.project && !ideas.busy && ideas.list.length > 0 && (await $.clock.now()) - ideas.at < 10 * 60_000
}

/** Starts thinking of ideas unless they are at hand or on their way; resolves when they are in. */
function prepareIdeas($: EngineInterface): Promise<void> {
  ideasJob ??= thinkOfTasks($)
    .catch(() => undefined)
    .finally(() => {
      ideasJob = null
    })
  return ideasJob
}

/** On to the first step, whole: while the ideas are still on their way the board says it is looking (twelve seconds at most). */
async function toNameStep($: EngineInterface) {
  if (!(await ideasReady($))) {
    const job = prepareIdeas($)
    if ((await read($, boardA)).view !== 'busy') await setBoard($, { view: 'busy', note: LOOKING })
    await Promise.race([job, new Promise<void>(done => void $.clock.after(12_000, () => done()))])
    // cancelled, or gone elsewhere, while it waited
    if (!pendingStart || (await read($, boardA)).view !== 'busy') return
  }
  const project = disk?.project ?? 'project'
  shownIdeas = ideas?.project === project && ideas.list.length ? ideas.list : plainIdeas(project)
  await setBoard($, { view: 'name', typing: null, note: '' })
}

/** Asks a small model for the likely next tasks, from the git log and status, the town's features, earlier tasks and the README. */
async function thinkOfTasks($: EngineInterface) {
  if (!d || !disk) return
  const project = disk.project
  if (await ideasReady($)) return
  ideas = { project, at: await $.clock.now(), list: [], busy: true }
  const cwd = disk.cwd
  const run = async (args: string[]) => {
    const r = await $.process.run(args, { timeoutMs: 4000 }).catch(() => null)
    return r?.exitCode === 0 ? r.stdout.trim() : ''
  }
  const [log, status, readme, town] = await Promise.all([
    run(['git', '-C', cwd, 'log', '--format=%s (%cr)', '-15']),
    run(['git', '-C', cwd, 'status', '--short']),
    $.fs.read(`${cwd}/README.md`).catch(() => ''),
    loadTown($, disk?.town ?? '', project).catch(() => null),
  ])
  const built = (town?.buildings ?? []).filter(b => b.status !== 'removed').map(b => `${b.name} (${b.status === 'building' ? 'being built' : 'done'})`)
  const earlier = (pastList.length ? pastList : await pastTasks($)).map(k => `${k.name}${k.goal ? `: ${k.goal}` : ''}`)
  const prompt = [
    `Suggest what a crew of Claude Code sessions should work on next in the software project "${project}".`,
    `Recent commits:\n${log || '(none)'}`,
    `Uncommitted changes:\n${status.split('\n').slice(0, 25).join('\n') || '(none)'}`,
    `Features so far:\n${built.join('\n') || '(none)'}`,
    `Earlier crew tasks:\n${earlier.join('\n') || '(none)'}`,
    `README (start):\n${readme.slice(0, 2500) || '(none)'}`,
    'Give 4 tasks, the most likely next first: finishing work in progress, fixing what looks broken, the next feature, tests or a review. ' +
      'Each name is short and plain (at most 32 characters, like "Checkout tests" or "Finish wishlist"); each goal is one sentence saying what done looks like. ' +
      'Reply with JSON only: [{"name": "...", "goal": "..."}]',
  ].join('\n\n')
  const r = await $.model.complete({ model: 'haiku', prompt, maxTokens: 600, effort: 'low', timeoutMs: 12_000 }).catch(() => null)
  const list = r?.isAnswered ? L.parseIdeas(r.text) : []
  ideas = { project, at: await $.clock.now(), list, busy: false }
}

/** When no ideas came: the plain kinds of task. */
const plainIdeas = (project: string): Idea[] => [
  { name: `${project}-feature`, goal: '' },
  { name: `${project}-bugfix`, goal: '' },
  { name: `${project}-review`, goal: '' },
]

// ---- strategies: one JSON file each, in the project's `.crewser/strategies` (or the folder the setting names), so a
// plugin update never touches them and the team shares them with the code. The templates come from the plugin; one
// saved under a template's id stands in for it, and a deleted template leaves a small marker so it stays deleted.

function strategiesDir() {
  return folderFor(opt.strategiesFolder, disk?.root ?? disk?.cwd ?? '.', 'strategies')
}

/** Where strategies were kept before 0.13: still read, so nothing made earlier goes missing. */
const legacyStrategiesDir = () => (d ? `${d.root}/strategies` : '')

async function strategyFiles($: EngineInterface, dir: string): Promise<{ id: string; raw: Record<string, unknown> }[]> {
  if (!dir) return []
  const entries = await $.fs.list(dir).catch(() => [])
  const rows = await Promise.all(entries.filter(e => e.kind === 'file' && e.name.endsWith('.json')).map(async e => ({ id: e.name.replace(/\.json$/, ''), raw: (await readJson($, `${dir}/${e.name}`)) as Record<string, unknown> | null })))
  return rows.filter((r): r is { id: string; raw: Record<string, unknown> } => !!r.raw && typeof r.raw === 'object')
}

async function loadStrategies($: EngineInterface): Promise<S.Strategy[]> {
  const byId = new Map<string, S.Strategy>()
  for (const t of S.TEMPLATES) byId.set(t.id, S.clean(t))
  const legacy = (await strategyFiles($, legacyStrategiesDir())).filter(f => !f.raw.builtIn)
  const own = await strategyFiles($, strategiesDir())
  for (const f of [...legacy, ...own]) {
    if (f.raw.hidden) byId.delete(f.id)
    else if (Array.isArray(f.raw.roles)) {
      const s = S.clean(f.raw)
      byId.set(s.id, s)
    }
  }
  // the project's own first, then the templates
  return [...byId.values()].sort((a, b) => Number(!!a.builtIn) - Number(!!b.builtIn) || a.name.localeCompare(b.name))
}

/** Saves a changed strategy over the one it came from (`previousId`), or a new one under a name of its own. */
async function saveStrategy($: EngineInterface, s: S.Strategy, previousId?: string) {
  let clean = S.clean({ ...s, builtIn: false })
  if (!previousId) {
    const taken = new Set((await loadStrategies($)).map(x => x.id))
    const base = S.slug(clean.name)
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    clean = { ...clean, id }
  } else clean = { ...clean, id: previousId }
  await $.fs.write(`${strategiesDir()}/${clean.id}.json`, JSON.stringify(clean, null, 2) + '\n')
  return clean
}

/** Deletes a saved strategy; a template or one from the old folder is hidden with a marker in the project's folder. */
async function deleteStrategy($: EngineInterface, id: string) {
  const safe = S.slug(id)
  await $.process.run(['rm', '-f', `${strategiesDir()}/${safe}.json`, `${legacyStrategiesDir()}/${safe}.json`], { timeoutMs: 3000 }).catch(() => undefined)
  if (S.TEMPLATES.some(t => t.id === safe)) await $.fs.write(`${strategiesDir()}/${safe}.json`, JSON.stringify({ v: 2, id: safe, hidden: true }) + '\n')
}

async function findStrategy($: EngineInterface, query: string) {
  const list = await loadStrategies($)
  const q = query.trim().toLowerCase()
  return list.find(s => s.id === S.slug(q) || s.name.toLowerCase() === q) ?? list.find(s => q && s.name.toLowerCase().includes(q)) ?? null
}

// ---- the strategy board: one pane of menus to pick, create and change strategies

const BOARD = 'strategies'
let boardList: S.Strategy[] = []
/** The task being set up in the board's steps (name, goal, strategy); the last step starts it. */
let pendingStart: { name: string; goal: string } | null = null
/** What is typed in the name or goal field so far, for its Next button. */
let typed = ''
/**
 * The strategy being looked at and changed: `chosen` the saved one it came from (null for a new one), `working` the
 * version with the changes asked for so far, `changes` those asks in words; `editing` the copy the role editor changes.
 */
let chosen: S.Strategy | null = null
let working: S.Strategy | null = null
let changes: string[] = []
let editing: S.Strategy | null = null

type BoardView = NonNullable<CrewBoard['view']>

const MODEL_CHOICES = ['opus', 'sonnet', 'haiku', 'Same model as the lead']
const asTier = (answer: string): S.Tier => (S.TIERS.includes(answer.trim() as S.Tier) ? (answer.trim() as S.Tier) : 'inherit')

async function setBoard($: EngineInterface, patch: Partial<CrewBoard>) {
  await update($, boardA, x => ({ ...x, ...patch, v: x.v + 1 }))
}

/** Forgets the strategy being looked at and changed. */
function letGo() {
  chosen = null
  working = null
  changes = []
  editing = null
}

/** Starts the waiting task from a board button: no questions, the lead takes its role's name; its crew opens as asked. */
async function startFromBoard($: EngineInterface, strategy: S.Strategy | null, openAs: OpenAs = 'windows') {
  const p = pendingStart
  if (!p) return setBoard($, { view: 'name', note: 'Name the task first.' })
  pendingStart = null
  letGo()
  await setBoard($, { view: 'busy', note: `Starting "${p.name}"${strategy ? ` with ${strategy.name}` : ''}: opening the ${openAs}…` })
  const start = launchPlan().here ? startWith($, strategy, p.name, p.goal, false, openAs) : startElsewhere($, strategy, p.name, p.goal, openAs)
  const text = await start.catch(async err => {
    await note($, 'start', err)
    return `Could not start: ${String((err as Error)?.message ?? err)}`
  })
  await closeBoard($)
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }).catch(() => $.ui.toast(text.split('\n')[0] ?? text, { timeoutMs: 10_000 }))
}

/** The strategy the task starts with, once chosen: its last step asks whether the crew opens as tabs or windows. */
let launching: S.Strategy | null = null

/** On to starting with a strategy: straight away for one session alone, else the choice of tabs or windows. */
async function toLaunch($: EngineInterface, s: S.Strategy) {
  if (S.sessionsIn(s) === 0) return startFromBoard($, s)
  launching = s
  await setBoard($, { view: 'launch', typing: null, note: '' })
}

/** Looks at one strategy: its drawing, and whether to change it first. */
async function chooseInBoard($: EngineInterface, s: S.Strategy, view: BoardView = 'chosen') {
  chosen = s
  working = structuredClone(s)
  changes = []
  editing = null
  await setBoard($, { view, typing: null, note: '' })
}

/** Changes `working` as the person asked in words: a model redraws the team, keeping what was not mentioned. */
async function changeInWords($: EngineInterface, request: string) {
  const base = working
  if (!base || !request.trim()) return setBoard($, { note: 'Say what to change first.' })
  await setBoard($, { view: 'busy', note: 'Changing the team…' })
  const r = await $.model.complete({ model: 'sonnet', prompt: S.changePrompt(base, request), maxTokens: 2000, effort: 'low', timeoutMs: 60_000 }).catch(() => null)
  const next = r?.isAnswered ? S.fromReply(r.text) : null
  // gone elsewhere (Cancel, Back) while the model thought
  if ((await read($, boardA)).view !== 'busy' || working !== base) return
  if (!next) return setBoard($, { view: 'change', note: 'Could not make that change. Try saying it another way, or change the roles by hand.' })
  working = { ...next, id: base.id, builtIn: base.builtIn }
  changes = [...changes, L.gist(request, 80)]
  await setBoard($, { view: 'changed', typing: null, note: '' })
}

/** After a save: the next step of the task's start, or back to the list on the saved one. */
async function afterSave($: EngineInterface, saved: S.Strategy, use: boolean) {
  $.ui.toast(`Saved "${saved.name}" to ${strategiesDir().replace(`${disk?.root ?? ''}/`, '')}`)
  if (use && pendingStart) return toLaunch($, saved)
  letGo()
  boardList = await loadStrategies($)
  await setBoard($, { view: 'list', typing: null, index: Math.max(0, boardList.findIndex(z => z.id === saved.id)), hover: null, note: '' })
}

/** Opens the board: the list of strategies, or straight to a view (`change` with a strategy to change). */
async function openBoard($: EngineInterface, mode: CrewBoard['mode'], o: { focusId?: string; view?: BoardView; change?: S.Strategy; note?: string } = {}) {
  boardList = await loadStrategies($)
  const index = Math.max(0, boardList.findIndex(s => s.id === o.focusId))
  if (o.change) {
    chosen = boardList.find(s => s.id === o.change?.id) ?? null
    working = structuredClone(o.change)
    changes = []
  }
  const view: BoardView = o.view ?? (o.change ? 'change' : 'list')
  await update($, boardA, b => ({ mode, index, v: (b?.v ?? 0) + 1, view, note: o.note ?? '', role: null, typing: null, hover: null }))
  // tall and wide enough for the list, a drawing beside it and its buttons: the window grows first, so the pane gets the rows it asks for
  await fitWindow($, BOARD_SIZE.columns, BOARD_SIZE.rows + 12)
  await $.ui.open({ id: BOARD, title: mode === 'pick' ? 'Crew task' : mode === 'crew' ? 'Crew' : 'Strategies', focus: true, closeOnEscape: true, ...BOARD_SIZE })
}

// ---- adding to a running crew: more of a role, or new roles, each a session of its own; the task's strategy keeps them

/** The running task's crew as its strategy has it (a lead alone for a task started as one session), before the change. */
let crewBase: S.Strategy | null = null

/** /crew-add: the board on the running task's crew, to say who joins; `inPlace` when the board is open already. */
async function openCrewBoard($: EngineInterface, inPlace = false): Promise<string> {
  if (!d || !disk?.task) return 'Not in a crew task: /crew-task starts or joins one.'
  await loadDisk($)
  const task = tasks.find(k => k.id === disk?.task?.id)
  if (!task) return 'The task has ended.'
  crewBase = structuredClone(task.strategy ?? S.leadAlone(task.name))
  chosen = crewBase
  working = structuredClone(crewBase)
  changes = []
  editing = null
  pendingStart = null
  if (inPlace) await setBoard($, { mode: 'crew', view: 'crew', note: '', typing: null })
  else await openBoard($, 'crew', { view: 'crew' })
  return 'Say who joins the crew in the board.'
}

/**
 * Opens a session for everyone a change to the crew adds, as tabs or windows, and keeps the change as the task's
 * strategy: briefs name the new roles, and a later resume brings them back. The lead keeps its own role.
 */
async function growCrew($: EngineInterface, next: S.Strategy, openAs: OpenAs): Promise<string> {
  if (!disk?.task) return 'Not in a crew task.'
  await loadDisk($)
  const task = tasks.find(k => k.id === disk?.task?.id)
  if (!task) return 'The task has ended.'
  const base = task.strategy ?? S.leadAlone(task.name)
  const adds = S.added(base, next)
  if (!adds.length) return 'Nothing to add: that change opens no new sessions.'
  const t = await $.clock.now()
  const live = all.filter(s => s.task?.id === task.id && L.isLive(s, t))
  const strategy: S.Strategy = { ...next, roles: [(base.roles[0] ?? next.roles[0]) as S.Role, ...next.roles.filter(r => r.kind !== 'lead')] }
  const grown: L.DiskTask = { ...task, strategy, openAs }
  await writeTask($, grown)
  tasks = tasks.map(k => (k.id === task.id ? grown : k))
  // a lead that started alone now plays the strategy's lead role, so its brief names the crew
  if (task.creator === disk.id && !disk.task.roleId) {
    disk.task = { ...disk.task, roleId: strategy.roles[0]?.id }
    await save($)
  }
  const seats = adds.flatMap(({ role, add }) => {
    const have = live.filter(s => s.task?.roleId === role.id || s.task?.role === role.name).length
    return Array.from({ length: add }, (_, i): Seat => ({ role, n: have + i + 1, of: have + add > 1 ? 2 : 1 }))
  })
  const lead = all.find(s => s.id === task.creator)
  const opened = await openSeats($, grown, seats, live.length, { cwd: dirOf(task) || disk.cwd, beside: lead?.tty ?? disk.tty })
  const what = adds.map(({ role, add }) => `${add} ${role.name} (${role.model === 'inherit' ? 'same model as the lead' : role.model})`).join(', ')
  await logEvent($, task.id, 'crew', `Added ${what}, in ${openAs}`)
  $.ui.invalidate('prompt.section')
  if (!opened) return `Could not open the ${openAs} (Terminal.app only). The task's strategy has them now: start Claude by hand in ${dirOf(task) || disk.cwd} and /crew-task → Join.`
  await broadcast($, `New crew members are joining: ${what}.`, 'all')
  if (openAs === 'windows') $.clock.after(12_000, () => void retile($))
  return `⚑ Adding ${what} to "${task.name}": ${opened} ${openAs === 'tabs' ? 'tab' : 'window'}${opened > 1 ? 's' : ''} opening, joining by themselves. The task's strategy keeps them, so a resume brings them back too.`
}

const BOARD_SIZE = { rows: 50, columns: 150 }

async function closeBoard($: EngineInterface) {
  await $.ui.close({ id: BOARD }).catch(() => undefined)
}

/** Cancel or Esc: nothing starts, nothing half-made stays behind. */
function forgetBoard($: EngineInterface) {
  const waiting = pendingStart
  pendingStart = null
  letGo()
  typed = ''
  if (waiting) $.ui.toast(waiting.name ? `"${waiting.name}" was not started: /crew-task starts it again.` : 'No task started.')
}

/** The role editor on a copy of what is being changed. */
async function editInBoard($: EngineInterface) {
  if (!working) return
  editing = structuredClone(working)
  await setBoard($, { view: 'edit', role: editing.roles[0]?.id ?? null, typing: null, note: '' })
}

/** A role added in the editor: the first common name not taken yet, then its name is asked right away. */
function addRole(s: S.Strategy, kind: 'worker' | 'advisor'): S.Role {
  const names = kind === 'advisor' ? ['Security advisor', 'Code reviewer', 'Architect', 'Database advisor', 'UX advisor'] : ['Implementer', 'Tester', 'Researcher', 'Documenter']
  const taken = new Set(s.roles.map(r => r.name.toLowerCase()))
  const name = names.find(n => !taken.has(n.toLowerCase())) ?? `${kind === 'advisor' ? 'Advisor' : 'Worker'} ${s.roles.length}`
  const firstWorker = s.roles.find(r => r.kind === 'worker')
  const role: S.Role = {
    id: `${S.slug(name)}-${L.uid().slice(0, 3)}`, name, kind, model: 'inherit', effort: '', count: 1,
    duty: kind === 'advisor' ? `Reviews ${firstWorker?.name ?? 'the lead'}'s work in its area and answers questions; does not edit.` : 'Does the work the lead hands out and reports back.',
    links: kind === 'advisor' ? [firstWorker?.id ?? s.roles[0]?.id ?? 'lead'] : [],
  }
  s.roles.push(role)
  return role
}

/** A strategy in a chat message: the compact drawing, which wraps nowhere in a terminal of 64 columns or more. */
const art = (s: S.Strategy) => '```\n' + S.diagram(s, 62).join('\n') + '\n```'

// ---- windows: one per session, tiled across the screen

/** The usable area (no menu bar, no Dock) of the screen the lead's window is on. */
async function desktop($: EngineInterface) {
  const jxa =
    'ObjC.import("AppKit"); const s = $.NSScreen.screens; const main = s.objectAtIndex(0).frame; const out = [];' +
    'for (let i = 0; i < s.count; i++) { const f = s.objectAtIndex(i).visibleFrame;' +
    ' out.push([f.origin.x, main.size.height - (f.origin.y + f.size.height), f.size.width, f.size.height].map(Math.round).join(",")) }; out.join(";")'
  const r = await $.process.run(['osascript', '-l', 'JavaScript', '-e', jxa], { timeoutMs: 5000 }).catch(() => null)
  const screens = (r?.stdout.trim() ?? '').split(';').map(t => t.split(',').map(Number)).filter(a => a.length === 4 && a.every(Number.isFinite)) as [number, number, number, number][]
  const fallback = { x: 0, y: 25, w: 1440, h: 875 }
  if (screens.length === 0) return fallback
  const at = disk?.tty ? await osa($, L.inTab(disk.tty, 'return bounds of w')) : null
  const [bx1 = 0, by1 = 0, bx2 = 0, by2 = 0] = (at ?? '').split(',').map(n => Number(n.trim()))
  const cx = (bx1 + bx2) / 2
  const cy = (by1 + by2) / 2
  const [x, y, w, h] = screens.find(([sx, sy, sw, sh]) => cx >= sx && cx < sx + sw && cy >= sy && cy < sy + sh) ?? screens[0] ?? [0, 25, 1440, 875]
  return { x, y, w, h }
}

/**
 * Grows the lead's Terminal.app window (never shrinks it) to at least `cols` × `rows` cells, then keeps it on its
 * screen: moved back inside, and no bigger than the screen. Other terminals are left alone.
 */
async function fitWindow($: EngineInterface, cols: number, rows: number) {
  const tty = disk?.tty ?? termInfo.tty
  if (!tty || termInfo.term !== 'Apple_Terminal') return
  const grown = await osa($, L.inTab(tty, `if number of columns of t < ${cols} then set number of columns of t to ${cols}
        if number of rows of t < ${rows} then set number of rows of t to ${rows}
        return bounds of w`))
  const [x1, y1, x2, y2] = (grown ?? '').split(',').map(n => Number(n.trim()))
  if (![x1, y1, x2, y2].every(n => Number.isFinite(n)) || x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return
  const area = await desktop($)
  const w = Math.min(x2 - x1, area.w)
  const h = Math.min(y2 - y1, area.h)
  const nx = Math.max(area.x, Math.min(x1, area.x + area.w - w))
  const ny = Math.max(area.y, Math.min(y1, area.y + area.h - h))
  if (nx !== x1 || ny !== y1 || w !== x2 - x1 || h !== y2 - y1) await osa($, L.inTab(tty, `set bounds of w to {${nx}, ${ny}, ${nx + w}, ${ny + h}}\n return "ok"`))
}

/** The grid cell for window `i` of `n`: as square as the screen allows. */
function cell(area: { x: number; y: number; w: number; h: number }, i: number, n: number) {
  const cols = Math.ceil(Math.sqrt(n * (area.w / area.h) / 1.6))
  const rows = Math.ceil(n / Math.max(1, cols))
  const c = i % cols
  const r = Math.floor(i / cols)
  const w = Math.floor(area.w / cols)
  const h = Math.floor(area.h / rows)
  return [area.x + c * w, area.y + r * h, area.x + (c + 1) * w, area.y + (r + 1) * h].map(Math.round)
}

/** A window to open for a role; `resume` a member's earlier session to carry on, under the `name` it had. */
type Seat = { role: S.Role; n: number; of: number; name?: string; resume?: string; lead?: boolean }

// the seat travels to the new window in an environment variable, as hex of its UTF-8 JSON
const toHex = (s: string) => [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, '0')).join('')
const fromHex = (h: string) => new TextDecoder().decode(Uint8Array.from(h.match(/../g) ?? [], x => Number.parseInt(x, 16)))

const seatName = (seat: Seat) => seat.name ?? (seat.of > 1 ? `${seat.role.name} #${seat.n}` : seat.role.name)

/**
 * Whether this session can open Terminal tabs: Terminal has no command for a new tab, so it gets ⌘T, and macOS lets
 * it send keys only once Terminal is allowed under Privacy & Security → Accessibility.
 */
async function tabsAllowed($: EngineInterface) {
  if (termInfo.term !== 'Apple_Terminal') return false
  return (await osa($, 'tell application "System Events" to get UI elements enabled')) === 'true'
}

/** A choice of tabs on the board, held while the board explains the permission tabs need. */
let tabsGate: { what: string; go: () => unknown; windows: () => unknown; back: () => unknown } | null = null

/** Runs `go` when Terminal may open tabs; else the board says what tabs need, with windows as the way on. */
async function viaTabs($: EngineInterface, what: string, go: () => unknown, windows: () => unknown, back: () => unknown) {
  if (await tabsAllowed($)) return go()
  tabsGate = { what, go, windows, back }
  await setBoard($, { view: 'tabs', typing: null, note: '' })
}

/**
 * Opens a Terminal session per seat; each starts Claude with the role's model and joins the task by itself. As the
 * task says: windows of their own, tiled across the screen, or tabs in the window of the session `beside` (the
 * lead's, by default). A lead seat always gets a window: a crew is a window, its members its tabs.
 */
async function openSeats($: EngineInterface, task: L.DiskTask, seats: Seat[], tileWith: number, o: { cwd?: string; beside?: string | null } = {}) {
  if (!disk || seats.length === 0) return 0
  const cwd = o.cwd ?? disk.cwd
  const beside = o.beside === undefined ? disk.tty : o.beside
  const area = await desktop($)
  const total = tileWith + seats.length
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const as = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  let tabs = task.openAs === 'tabs' && !!beside && termInfo.term === 'Apple_Terminal'
  if (tabs && !(await tabsAllowed($))) {
    tabs = false
    $.ui.toast('Tabs need Terminal allowed under System Settings → Privacy & Security → Accessibility: opening windows instead.', { timeoutMs: 12_000 })
  }
  let opened = 0
  let tabbed = 0
  for (const [i, seat] of seats.entries()) {
    const payload = toHex(JSON.stringify({ t: task.id, r: seat.role, n: seat.n, of: seat.of, nm: seat.name, rs: seat.resume ? 1 : 0, ld: seat.lead ? 1 : 0 }))
    const flags = [seat.role.model !== 'inherit' ? `--model ${seat.role.model}` : '', seat.role.effort ? `--effort ${seat.role.effort}` : ''].filter(Boolean).join(' ')
    // a member coming back carries on its own conversation; if that is gone, it starts a new one
    const run = seat.resume ? `(claude --resume ${q(seat.resume)} ${flags} || claude ${flags})` : `claude ${flags}`
    const cmd = `cd ${q(cwd)} && export CREW_JOIN=${q(payload)} && ${run}`
    if (tabs && !seat.lead && beside) {
      // a new tab in the lead's window: Terminal has no command for it, so its window comes to the front and gets ⌘T
      const script = `${L.inTab(beside, 'set index of w to 1\n        set selected of t to true\n        activate')}
delay 0.2
tell application "System Events" to keystroke "t" using command down
delay 0.6
tell application "Terminal"
  do script "${as(cmd)}" in selected tab of front window
  set custom title of selected tab of front window to "${as(L.titleOf(seatName(seat), task))}"
end tell`
      const r = await $.process.run(['osascript', '-e', script], { timeoutMs: 10_000 }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
      if (r.exitCode === 0) {
        opened++
        tabbed++
        continue
      }
      await note($, 'open tab', r.stderr)
      // the keystroke failed all the same (System Events refused, say): windows for the rest
      tabs = false
      $.ui.toast('Could not open a tab: opening windows instead.', { timeoutMs: 12_000 })
    }
    const [x1, y1, x2, y2] = cell(area, tileWith + i, total)
    const script = `tell application "Terminal"
  set t to do script "${as(cmd)}"
  set custom title of t to "${as(L.titleOf(seatName(seat), task))}"
  set bounds of front window to {${x1}, ${y1}, ${x2}, ${y2}}
end tell`
    const r = await $.process.run(['osascript', '-e', script], { timeoutMs: 8000 }).catch(err => (void note($, 'open window', err), null))
    if (r?.exitCode === 0) opened++
    else if (r) await note($, 'open window', r.stderr)
  }
  // back to the lead's own tab
  if (tabbed && beside) await osa($, L.inTab(beside, 'set selected of t to true\n        return "ok"'))
  return opened
}

/** Lays the crew's windows out in a grid again: the lead first, then by role. */
async function retile($: EngineInterface) {
  if (!disk?.task) return
  await loadDisk($)
  const t = await $.clock.now()
  const task = tasks.find(k => k.id === disk?.task?.id)
  // a crew in tabs shares one window: nothing to lay out
  if (task?.openAs === 'tabs') return
  const order = (s: L.DiskSession) => (s.task?.role === 'Lead' || s.id === task?.creator ? -1 : (task?.strategy?.roles.findIndex(r => r.id === s.task?.roleId) ?? 99))
  const crew = all.filter(s => s.task?.id === disk?.task?.id && L.isLive(s, t) && s.tty).sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
  if (crew.length === 0) return
  const area = await desktop($)
  for (const [i, s] of crew.entries()) {
    const [x1, y1, x2, y2] = cell(area, i, crew.length)
    if (s.tty) await osa($, L.inTab(s.tty, `set bounds of w to {${x1}, ${y1}, ${x2}, ${y2}}\n return "ok"`))
  }
}

const seatsFor = (roles: S.Role[]): Seat[] =>
  roles.filter(r => r.kind !== 'lead').flatMap(r => Array.from({ length: Math.max(1, r.count) }, (_, i) => ({ role: r, n: i + 1, of: Math.max(1, r.count) })))

// ---- starting, joining, growing a task

/** Model, effort and advisor are the person's own commands; what a plugin may not run waits in the prompt box. */
async function applySetup($: EngineInterface, model: S.Tier, effort: S.Effort) {
  const steps: [string, string][] = []
  if (model !== 'inherit') steps.push(['model', model])
  if (effort) steps.push(['effort', effort])
  for (const [command, args] of steps) {
    const ok = await $.command
      .run({ command, args })
      .then(r => !/invalid|cannot|unknown|not available/i.test(r.text ?? ''))
      .catch(async err => (await note($, command, err), false))
    if (!ok) waiting.push(`/${command} ${args}`)
  }
  await fillNext($)
}

let waiting: string[] = []

async function fillNext($: EngineInterface) {
  const next = waiting[0]
  if (!next) return
  const { isFilled } = await $.prompt.fill({ text: next, mode: 'replace' }).catch(() => ({ isFilled: false }))
  const left = waiting.length
  $.ui.toast(isFilled ? `Press Enter to apply ${next}${left > 1 ? ` (${left - 1} more after it)` : ''}` : `Run ${waiting.join(', then ')}`, { timeoutMs: 10_000 })
  if (!isFilled) waiting = []
}

function kickoff(task: L.DiskTask, role: string, duty: string) {
  return (
    `You just joined the crew task "${task.name}" as ${role}${duty ? ` (${duty})` : ''}. Call mcp__crewser__team, then post a one-line hello ` +
    `to the lead saying what you will take on, and wait for or pick up work.`
  )
}

/** The folder a task's crew works in (tasks from before 0.14 knew no root: their lead's folder). */
function dirOf(k: L.DiskTask) {
  return L.taskDir(k) || all.find(s => s.id === k.creator)?.top || all.find(s => s.id === k.creator)?.cwd || ''
}

/** Whether a crew is at work in this folder already: a new one then gets a worktree of its own. */
const folderBusy = (folder: string) => tasks.some(k => !k.ended && dirOf(k) === folder)

/** Where a new crew starts: led by this session, here; or by a lead window of its own (this session leads another crew, or oversees), in a worktree when another crew works here. */
function launchPlan() {
  const folder = disk?.top ?? disk?.cwd ?? ''
  const worktree = folderBusy(folder)
  return { here: !disk?.task && !disk?.overseer && !worktree, worktree }
}

/** A new git worktree beside the main checkout, on a branch of its own: `<project>-<task>` on `crew/<task>`. */
async function makeWorktree($: EngineInterface, root: string, name: string): Promise<{ worktree: string; branch: string } | { error: string }> {
  const git = (...args: string[]) => $.process.run(['git', '-C', root, ...args], { timeoutMs: 30_000 }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  if ((await git('rev-parse', '--git-dir')).exitCode !== 0) return { error: `Another crew is at work in ${L.basename(root)}, and a second one needs a git worktree, but ${root} is not a git repository.` }
  const parent = root.replace(/\/[^/]+$/, '')
  const base = S.slug(name)
  for (let n = 1; n < 20; n++) {
    const tag = n > 1 ? `${base}-${n}` : base
    const branch = `crew/${tag}`
    const worktree = `${parent}/${L.basename(root)}-${tag}`
    if ((await git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)).exitCode === 0) continue
    if (await $.fs.exists(worktree).catch(() => false)) continue
    const made = await git('worktree', 'add', '-b', branch, worktree, 'HEAD')
    if (made.exitCode !== 0) return { error: `Could not make a worktree for "${name}": ${L.gist(made.stderr || made.stdout, 200)}` }
    return { worktree, branch }
  }
  return { error: `Could not find a free name for a worktree for "${name}".` }
}

/** Creates the task here, names the lead, then opens and tiles a window for every other seat of the strategy. */
async function startWith($: EngineInterface, strategy: S.Strategy | null, name: string, goal: string, askForName = true, openAs: OpenAs = 'windows'): Promise<string> {
  if (!d || !disk) return ''
  if (disk.task) await leaveTask($)
  const id = `${L.slug(name)}-${L.uid()}`
  const leadRole = strategy?.roles[0]
  await ensureIdentity($, askForName ? await askName($, id, leadRole?.name ?? 'Lead') : ((await read($, meA))?.name ?? leadRole?.name ?? 'Lead'))
  const task: L.DiskTask = {
    v: 1, id, code: L.newCode(tasks.map(L.codeOf)), name, goal, creator: disk.id, creatorName: disk.name, createdAt: await $.clock.now(), ended: false, strategy,
    project: disk.project, town: disk.town, root: disk.root, openAs,
  }
  await writeTask($, task)
  disk.task = { id: task.id, name, role: 'Lead', lead: disk.name, roleId: leadRole?.id, code: L.codeOf(task) }
  await logEvent($, task.id, 'start', `Started${goal ? ` (goal: ${goal})` : ''}${strategy ? ` with the strategy "${strategy.name}"` : ', the lead alone'}`)
  tasks = [...tasks, task]
  await update($, taskA, () => ({ id: task.id, name, role: 'Lead', isLead: true }))
  await save($)
  $.ui.invalidate('prompt.section')
  if (leadRole) $.clock.after(2500, () => void applySetup($, leadRole.model, leadRole.effort))
  return openCrew($, task, strategy)
}

/** The lead's part once its task is written: a window per seat of the strategy, tiled with the lead's. */
async function openCrew($: EngineInterface, task: L.DiskTask, strategy: S.Strategy | null): Promise<string> {
  if (!disk) return ''
  const where = task.branch ? ` It works in its own worktree, ${task.worktree}, on the branch ${task.branch}.` : ''
  if (!strategy) return `⚑ Started task "${task.name}" as Lead.${where} Others join with /crew-task → Join, or add members with /crew-add. It ends when this session exits.`
  const seats = seatsFor(strategy.roles)
  const opened = await openSeats($, task, seats, 1)
  const inTabs = task.openAs === 'tabs'
  if (disk.tty && !inTabs) {
    const area = await desktop($)
    const [x1, y1, x2, y2] = cell(area, 0, seats.length + 1)
    await osa($, L.inTab(disk.tty, `set bounds of w to {${x1}, ${y1}, ${x2}, ${y2}}\n return "ok"`))
  }
  if (!inTabs) $.clock.after(12_000, () => void retile($))
  return (
    `⚑ Started "${task.name}" with the strategy "${strategy.name}".${where} ` +
    (opened ? `Opened ${opened} ${inTabs ? 'tab' : 'window'}${opened > 1 ? 's' : ''}; they join by themselves.` : seats.length ? 'Could not open the windows: start them by hand and /crew-task → Join.' : '') +
    ` More members mid-task: /crew-add.\n\n${art(strategy)}`
  )
}

/**
 * Starts a crew led by a window of its own: when this session already leads a crew or oversees the project. It works
 * here when no crew does, else in a new worktree; the lead window takes the task when it starts and opens its crew.
 */
async function startElsewhere($: EngineInterface, strategy: S.Strategy | null, name: string, goal: string, openAs: OpenAs = 'windows'): Promise<string> {
  if (!d || !disk) return ''
  await loadDisk($)
  const root = disk.root ?? disk.cwd
  const folder = disk.top ?? disk.cwd
  let worktree: string | undefined
  let branch: string | undefined
  if (folderBusy(folder)) {
    const made = await makeWorktree($, root, name)
    if ('error' in made) return made.error
    ;({ worktree, branch } = made)
  }
  const leadRole: S.Role = strategy?.roles[0] ?? { id: 'lead', name: 'Lead', kind: 'lead', model: 'inherit', effort: '', count: 1, duty: 'Coordinates the crew and owns the result.', links: [] }
  const task: L.DiskTask = {
    v: 1, id: `${L.slug(name)}-${L.uid()}`, code: L.newCode(tasks.map(L.codeOf)), name, goal, creator: '', creatorName: leadRole.name, createdAt: await $.clock.now(), ended: false, strategy,
    project: disk.project, town: disk.town, root, worktree, branch, pendingLead: true, openAs,
  }
  await writeTask($, task)
  tasks = [...tasks, task]
  await logEvent($, task.id, 'start', `Started${goal ? ` (goal: ${goal})` : ''}${strategy ? ` with the strategy "${strategy.name}"` : ''}${branch ? `, in its own worktree on ${branch}` : ''}`)
  const opened = await openSeats($, task, [{ role: leadRole, n: 1, of: 1, lead: true }], 0, { cwd: worktree ?? folder })
  if (!opened) return `Could not open a window for the lead of "${name}" (Terminal.app only).${worktree ? ` Its worktree is ready: cd ${worktree} && claude, then /crew-task → Join.` : ''}`
  return `⚑ "${name}" starts with a lead window of its own${openAs === 'tabs' ? ' (its crew opens as tabs in it)' : ''}${worktree ? `, in the worktree ${worktree} on the branch ${branch} (uncommitted changes here are not in it)` : ''}; the lead opens its crew.`
}

/** A lead window opened for a task: it takes the task, then opens the crew. */
async function becomeLead($: EngineInterface, task: L.DiskTask) {
  if (!disk) return
  const role = task.strategy?.roles[0]
  // leads of several crews are told apart by their title, which carries the task's name and code
  await ensureIdentity($, role?.name ?? 'Lead')
  const mine: L.DiskTask = { ...task, creator: disk.id, creatorName: disk.name, pendingLead: undefined }
  await writeTask($, mine)
  tasks = [...tasks.filter(k => k.id !== task.id), mine]
  disk.task = { id: task.id, name: task.name, role: 'Lead', lead: disk.name, roleId: role?.id, code: L.codeOf(task) }
  wasCrew = true
  await update($, taskA, () => ({ id: task.id, name: task.name, role: 'Lead', isLead: true }))
  await save($)
  $.ui.invalidate('prompt.section')
  const text = await openCrew($, mine, task.strategy ?? null)
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }).catch(() => $.ui.toast(text.split('\n')[0] ?? text))
  if (opt.autoKickoff) {
    void $.prompt.submit({
      text: `You lead the crew task "${task.name}"${task.goal ? ` (goal: ${task.goal})` : ''}${task.branch ? `, in the worktree ${task.worktree} on the branch ${task.branch}: commit your crew's work there` : ''}. ` +
        'Your crew is joining now. Plan the work, hand it out with mcp__crewser__post, and keep the overseer (if the project has one) posted.',
    }).catch(() => undefined)
  }
}

/** A window opened for a seat joins its task with no questions asked. */
async function autoJoin($: EngineInterface) {
  const spec = await $.env.get('CREW_JOIN')
  if (!spec || !disk || disk.task) return
  let seat: { t: string; r: S.Role; n: number; of: number; nm?: string; rs?: number; ld?: number } | null = null
  try {
    seat = JSON.parse(fromHex(spec))
  } catch {
    return note($, 'join', `bad CREW_JOIN ${spec.slice(0, 40)}`)
  }
  if (!seat) return
  await loadDisk($)
  const task = tasks.find(k => k.id === seat?.t)
  if (!task) return $.ui.toast('That crew task has ended.')
  if (seat.ld) return becomeLead($, task)
  const role = S.clean({ roles: [{ kind: 'lead', name: 'x' }, seat.r] }).roles[1] ?? seat.r
  await joinAs($, task, role, seatName({ role, n: seat.n, of: seat.of, name: seat.nm }), !!seat.rs)
}

/** Into a task in a role, under a name; `back` for a member returning to a resumed task, who carries on its work. */
async function joinAs($: EngineInterface, task: L.DiskTask, role: S.Role, name: string, back: boolean) {
  if (!disk) return
  const inStrategy = task.strategy?.roles.some(r => r.id === role.id)
  await ensureIdentity($, name)
  disk.task = { id: task.id, name: task.name, role: role.name, lead: task.creatorName, roleId: role.id, extra: inStrategy ? undefined : role, code: L.codeOf(task) }
  wasCrew = true
  await update($, taskA, () => ({ id: task.id, name: task.name, role: role.name, isLead: false }))
  await save($)
  $.ui.invalidate('prompt.section')
  await broadcast($, back ? `${disk.name} is back on "${task.name}" as ${role.name}.` : `${disk.name} joined "${task.name}" as ${role.name}.`, 'all')
  await logEvent($, task.id, 'join', back ? `Back as ${role.name}` : `Joined as ${role.name}`)
  if (opt.autoKickoff) void $.prompt.submit({ text: back ? welcomeBack(task, role.name) : kickoff(task, role.name, role.duty) }).catch(() => undefined)
}

function welcomeBack(task: L.DiskTask, role: string) {
  return (
    `The crew task "${task.name}" was resumed${task.goal ? ` (goal: ${task.goal})` : ''} and you are back on it as ${role}, lead ${task.creatorName}. ` +
    `Call mcp__crewser__team, look at where you left off, post the lead a one-line status, and carry on.`
  )
}

/** A member's role in a task: its strategy role, the role added for it, or a plain worker's under its role's name. */
function roleOf(task: L.DiskTask, m: L.TaskMember): S.Role {
  const role = task.strategy?.roles.find(r => r.id === m.roleId) ?? m.extra
  return S.clean({ roles: [{ kind: 'lead', name: 'x' }, role ?? { kind: 'worker', name: m.role }] }).roles[1] ?? (role as S.Role)
}

async function joinTask($: EngineInterface, joinable: L.DiskTask[]): Promise<string> {
  if (!d || !disk) return ''
  const label = (k: L.DiskTask) => L.gist(`${L.taskLabel(k)} (lead ${k.creatorName})`, 60)
  const picked =
    joinable.length === 1 && joinable[0]
      ? label(joinable[0])
      : await $.ui.ask('Which task?', { header: 'Join', options: joinable.slice(0, 4).map(label) })
  const task = joinable.find(k => label(k) === picked || k.name.toLowerCase() === picked.toLowerCase() || `#${L.codeOf(k)}` === picked.trim().toLowerCase().replace(/^#?/, '#'))
  if (!task) return `No running task is called "${picked}".`
  // with a strategy, its roles are the ones on offer, each with its model
  const roles = (task.strategy?.roles ?? []).filter(r => r.kind !== 'lead')
  const roleAnswer = await $.ui.ask(`Your role in "${task.name}"? (or type one)`, {
    header: 'Role',
    options: roles.length ? roles.slice(0, 4).map(r => L.gist(`${r.name} · ${r.model}`, 40)) : ROLES,
  })
  const strategic = roles.find(r => L.gist(`${r.name} · ${r.model}`, 40) === roleAnswer)
  const roleName = strategic ? strategic.name : L.gist(roleAnswer, 32)
  let model: S.Tier = strategic?.model ?? 'inherit'
  if (!strategic) model = asTier(await $.ui.ask('Which model for this role?', { header: 'Model', options: [...MODELS, 'Keep this one'] }))
  if (disk.task) await leaveTask($)
  await ensureIdentity($, await askName($, task.id, roleName))
  disk.task = { id: task.id, name: task.name, role: roleName, lead: task.creatorName, roleId: strategic?.id, code: L.codeOf(task) }
  await update($, taskA, () => ({ id: task.id, name: task.name, role: roleName, isLead: false }))
  await save($)
  $.ui.invalidate('prompt.section')
  $.clock.after(2500, () => void applySetup($, model, strategic?.effort ?? ''))
  await broadcast($, `${disk.name} joined "${task.name}" as ${roleName}.`, 'all')
  await logEvent($, task.id, 'join', `Joined as ${roleName}`)
  if (opt.autoKickoff) void $.prompt.submit({ text: kickoff(task, roleName, strategic?.duty ?? '') }).catch(() => undefined)
  return `⚑ Joined "${task.name}" as ${roleName}${model !== 'inherit' ? ` (${model})` : ''}.`
}

/** A team described in words, drawn up by a model as a strategy. */
async function draftFrom($: EngineInterface, description: string) {
  const r = await $.model.complete({ model: 'sonnet', prompt: S.parsePrompt(description), maxTokens: 1500, effort: 'low', timeoutMs: 45_000 })
  return r.isAnswered ? S.fromReply(r.text) : null
}

async function newStrategy($: EngineInterface, description: string): Promise<string> {
  const mode = pendingStart ? 'pick' : 'manage'
  if (!description.trim()) {
    await openBoard($, mode, { view: 'create' })
    return 'Describe the team in the board, or start from one of the strategies there.'
  }
  const parsed = await draftFrom($, description)
  if (!parsed) return 'Could not make a strategy of that description. Try naming the roles, how many of each, and their models.'
  await openBoard($, mode, { view: 'changed', change: parsed })
  chosen = null
  changes = [L.gist(description, 80)]
  await setBoard($, {})
  return `Drafted "${parsed.name}": change it, save it, or use it right away in the board.\n\n${art(parsed)}`
}

async function configStrategy($: EngineInterface, query: string): Promise<string> {
  const s = query ? await findStrategy($, query) : null
  if (!s) {
    await openBoard($, pendingStart ? 'pick' : 'manage')
    return query ? `No strategy called "${query}": pick one in the board, then Change.` : 'Pick a strategy in the board, then Change.'
  }
  await openBoard($, pendingStart ? 'pick' : 'manage', { change: s, focusId: s.id })
  return `Changing "${s.name}" in the board.`
}

async function useStrategy($: EngineInterface, query: string): Promise<string> {
  const s = await findStrategy($, query)
  if (!s) return `No strategy called "${query}". /crew-strategy-manage lists them.`
  await closeBoard($)
  if (!pendingStart) {
    if (!disk) return ''
    const name = L.gist(await $.ui.ask(`Name the task for "${s.name}"`, { header: 'Name', options: [`${disk.project}-feature`, `${disk.project}-bugfix`] }), 48)
    pendingStart = { name, goal: '' }
  }
  // a crew of several: the board's last step asks tabs or windows
  if (S.sessionsIn(s) > 0) {
    launching = s
    await openBoard($, 'pick', { view: 'launch' })
    return `Start "${pendingStart.name}" with the crew in tabs or in windows, in the board.`
  }
  const p = pendingStart
  pendingStart = null
  return launchPlan().here ? startWith($, s, p.name, p.goal) : startElsewhere($, s, p.name, p.goal)
}

async function leaveTask($: EngineInterface): Promise<string> {
  if (!d || !disk?.task) return 'Not in a task.'
  const left = disk.task
  const task = tasks.find(k => k.id === left.id)
  const isLead = task?.creator === disk.id
  let branch = ''
  if (task && isLead) {
    await logEvent($, task.id, 'end', 'Ended the task')
    const ended: L.DiskTask = { ...task, ended: true, endedAt: await $.clock.now(), invite: undefined }
    await writeTask($, ended)
    tasks = tasks.filter(k => k.id !== task.id)
    // a crew in a worktree: the person decides what becomes of its branch (asked again from /crew-task if this is dismissed)
    if (ended.branch) branch = await askBranch($, ended).catch(err => `Its branch ${ended.branch} is kept: ${String(err)}`)
  } else {
    await broadcast($, `${disk.name} left the task.`, 'all')
    await logEvent($, left.id, 'leave', 'Left the task')
  }
  await exitCrew($)
  return `Left "${left.name}"${isLead ? ' and ended it' : ''}.${branch ? ` ${branch}` : ''}`
}

// ---- stopping a crew at once: the task ends, every session of it quits, its Terminal windows close

/**
 * Stops a crew now, from one of its members or the overseer: the task ends (kept to resume, its branch waiting for a
 * decision), every member's Claude quits, and the Terminal windows that hold only the crew close, the caller's too.
 */
async function stopCrew($: EngineInterface, taskId: string, by: string): Promise<string> {
  if (!d || !disk) return ''
  await loadDisk($)
  const t = await $.clock.now()
  const k = tasks.find(x => x.id === taskId)
  if (!k) return 'That crew is not running.'
  await keepRoster($, k, t)
  const task = tasks.find(x => x.id === taskId) ?? k
  const crew = all.filter(s => s.task?.id === taskId && L.isLive(s, t))
  await logEvent($, taskId, 'end', `Stopped by ${by}: every session of the crew closed`)
  await writeTask($, { ...task, ended: true, endedAt: t, invite: undefined, paused: undefined })
  tasks = tasks.filter(x => x.id !== taskId)
  // the members' files say so at once, so nobody counts them while they close
  for (const s of crew) if (s.id !== disk.id) await $.fs.write(`${d.sessions}/${s.id}.json`, JSON.stringify({ ...s, ended: true, status: 'idle' })).catch(() => undefined)
  const ttys = [...new Set(crew.map(s => s.tty).filter((x): x is string => !!x && /^\/dev\/tty[\w.]+$/.test(x)))]
  // a window closes when every tab in it is the crew's: tabs of other sessions keep theirs
  const listed = await osa($, `if application "Terminal" is running then
  tell application "Terminal"
    set out to ""
    repeat with w in windows
      set acc to (id of w as text)
      repeat with t in tabs of w
        set acc to acc & " " & (tty of t)
      end repeat
      set out to out & acc & linefeed
    end repeat
    return out
  end tell
end if`)
  const windows = (listed ?? '').split('\n').map(r => r.trim().split(/\s+/)).filter(([id, ...tabs]) => /^\d+$/.test(id ?? '') && tabs.length > 0 && tabs.every(x => ttys.includes(x))).map(([id]) => id as string)
  const inCrew = crew.some(s => s.id === disk?.id)
  if (ttys.length) {
    // detached in a session of its own, so it outlives this one when this window is the crew's
    await $.process.run(['sh', '-c', `nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' sh -c "$1" >/dev/null 2>&1 &`, 'sh', L.stopScript(ttys, windows)], { timeoutMs: 5000 })
      .catch(err => note($, 'stop crew', err))
  }
  if (inCrew) await exitCrew($)
  const others = crew.filter(s => s.id !== disk?.id).length
  return `■ Stopped "${task.name}": ${others ? `${others} session${others > 1 ? 's' : ''} closing` : 'nobody else was in it'}${windows.length ? `, ${windows.length} window${windows.length > 1 ? 's' : ''} closing` : ''}${inCrew ? ', this one too' : ''}.${task.branch ? ` Its branch ${task.branch} waits for a decision.` : ''}`
}

/** The lead keeps who works on its task in the task's file, so a later /crew-task → Resume can bring the same crew back. */
async function keepRoster($: EngineInterface, k: L.DiskTask, t: number) {
  const roster = new Map((k.members ?? []).map(m => [m.id, m]))
  let changed = false
  for (const s of all) {
    if (s.id === k.creator || s.task?.id !== k.id || !L.isLive(s, t)) continue
    const m: L.TaskMember = { id: s.id, name: s.name, role: s.task.role, roleId: s.task.roleId, extra: s.task.extra, cwd: s.cwd, color: s.color, lastSeen: t }
    const was = roster.get(s.id)
    if (!was || was.name !== m.name || was.role !== m.role || t - was.lastSeen > 60_000) {
      roster.set(s.id, m)
      changed = true
    }
  }
  // an invitation lasts until its member is back, or two minutes
  const invite = (k.invite ?? []).filter(id => t - (k.resumedAt ?? 0) < 120_000 && !all.some(s => s.id === id && s.task?.id === k.id))
  if (invite.length !== (k.invite ?? []).length) changed = true
  if (!changed) return
  const next: L.DiskTask = { ...k, members: [...roster.values()], invite: invite.length ? invite : undefined }
  tasks = tasks.map(x => (x.id === k.id ? next : x))
  await writeTask($, next)
}

/** A window still open from a task's earlier run: when its lead resumes the task, it rejoins in the role it had. */
async function joinInvited($: EngineInterface, t: number) {
  if (!d || !disk || disk.task) return
  const rows = (await readDir($, d.tasks)) as L.DiskTask[]
  const id = disk.id
  const k = rows.find(x => !x.ended && x.invite?.includes(id))
  if (!k) return
  all = (await readDir($, d.sessions)) as L.DiskSession[]
  if (!all.some(s => s.id === k.creator && L.isLive(s, t))) return
  tasks = [...tasks.filter(x => x.id !== k.id), k]
  const m = k.members?.find(x => x.id === id)
  const role = m ? roleOf(k, m) : S.clean({ roles: [{ kind: 'lead', name: 'x' }, { kind: 'worker', name: 'Member' }] }).roles[1]
  if (role) await joinAs($, k, role, m?.name ?? role.name, true)
}

/** Out of the task: the record says so once, and the session drops off every member's view. */
async function exitCrew($: EngineInterface) {
  if (!disk) return
  wasCrew = true
  disk.task = null
  disk.ended = true
  await save($, true)
  disk.ended = false
  disk.pings = []
  all = []
  await update($, taskA, () => null)
  await update($, peersA, () => [])
  if (await read($, attentionA)) await stopAttention($)
  $.ui.invalidate('prompt.section')
}

/** Sends to teammates through SendMessage; what it cannot deliver goes through the files. */
async function broadcast($: EngineInterface, text: string, to: string) {
  if (!disk) return []
  const t = await $.clock.now()
  const targets = to === 'all' ? teammates(t) : teammates(t).filter(s => s.id === to)
  const out: string[] = []
  let relay = false
  for (const s of targets) {
    const sent = await $.session
      .send({ to: { sessionId: s.id }, text: `[crew · ${disk.name}, ${disk.task?.role ?? ''}] ${text}` })
      .catch(() => ({ isDelivered: false as const, reason: 'send failed' }))
    if (!sent.isDelivered) relay = true
    out.push(`${s.name}: ${sent.isDelivered ? 'delivered' : 'queued via crew files'}`)
  }
  disk.posts = [...disk.posts, { at: t, to, text: L.gist(text, 280), relay }].slice(-12)
  await save($)
  return out
}

function findSession(t: number, query: string) {
  const q = query.toLowerCase().trim()
  const live = others(t)
  const title = (s: L.DiskSession) => L.titleOf(s.name, s.task)
  return (
    live.find(s => s.id === query || L.namesSession(q, s.name, title(s)) === 'exact') ??
    (q ? live.find(s => s.name.toLowerCase().includes(q) || s.id.startsWith(q)) ?? live.find(s => L.namesSession(q, s.name, title(s))) : undefined)
  )
}

async function goTo($: EngineInterface, id: string) {
  const s = all.find(x => x.id === id)
  if (!s?.tty) return
  if (s.term === 'Apple_Terminal') await osa($, L.inTab(s.tty, 'set index of w to 1\n set selected of t to true\n activate\n return "ok"'))
  else $.ui.toast(`Jumping to a window works in Terminal.app; ${s.name} runs on ${s.tty}.`)
}

async function pingFromPane($: EngineInterface, id: string) {
  if (!disk) return
  const t = await $.clock.now()
  disk.pings = [...disk.pings.filter(p => p.to !== id), { id: L.uid(), to: id, reason: `${disk.name} wants a look`, at: t }]
  await save($)
  $.ui.toast(`Pinged ${all.find(s => s.id === id)?.name ?? 'session'}`)
}

async function registerAll($: EngineInterface) {
  await $.command.register({ name: 'crew-task', description: 'Start, resume, join or leave a crew task shared by several sessions' })
  await $.command.register({ name: 'crew', description: 'Show the members of your crew task; jump to one or ping it' })
  await $.command.register({ name: 'crew-strategy-manage', description: 'Browse the crew strategies as diagrams: change, delete or make new ones' })
  await $.command.register({ name: 'crew-strategy-new', description: 'Describe a team in words and get a strategy to save or use', argumentHint: '[description]' })
  await $.command.register({ name: 'crew-strategy-config', description: "Change a strategy: a role's model, its sessions, what it does, roles added or removed", argumentHint: '[strategy]' })
  await $.command.register({ name: 'crew-strategy-use', description: 'Start a crew task with a strategy, its crew in tabs or windows', argumentHint: '[strategy]' })
  await $.command.register({ name: 'crew-strategy-delete', description: 'Delete a saved strategy', argumentHint: '[strategy]' })
  await $.command.register({ name: 'crew-add', description: "Add to the running task's crew: one more of a role, or a new one (\"a UI expert on opus\"), a session each" })
  await $.command.register({ name: 'crew-stop', description: 'Stop the whole crew of this task now: every session quits and its Terminal windows close' })
  await $.command.register({ name: 'crew-tile', description: "Lay the crew's Terminal windows out in a grid again" })
  await $.command.register({ name: 'crew-overseer', description: 'Make this session the overseer of every crew in the project, above their leads (stop: /crew-overseer stop)', argumentHint: '[stop]' })
}

/** The model's crew tools arrive with the first task, so a session outside one carries none. */
async function registerTools($: EngineInterface) {
  if (toolsUp) return
  toolsUp = true
  await $.tool.register({
    name: 'ping',
    description: 'Flag a teammate in the crew task so its window pulses and notifies until the user looks at it.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Teammate name (or part of it) as mcp__crewser__team lists it' },
        reason: { type: 'string', description: 'Why it needs eyes, a few words' },
      },
      required: ['session', 'reason'],
    },
  })
  await $.tool.register({
    name: 'team',
    description: 'Show this session’s crew task: goal, members with roles and models, and recent posts.',
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'post',
    description: 'Message crew teammates in the current task: one by name, or "all".',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, to: { type: 'string', description: 'Teammate name, "all" (default), or "overseer" (the project\'s overseer, above the leads)' } },
      required: ['text'],
    },
  })
  await $.tool.register({
    name: 'add_members',
    description:
      "Add sessions to this crew task now, when the user asks for more people on it: more of a role the crew has (use its name), or a new role (\"UI expert\"). " +
      "Each opens in a Terminal tab or window of its own with its model and joins by itself; the task's strategy keeps the role, so a resume brings it back. Ask the user tabs or windows if they did not say.",
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'The role, 1-3 words: one the crew has, or a new one' },
        count: { type: 'number', description: 'How many more sessions of it (1-6, default 1)' },
        model: { type: 'string', enum: S.TIERS, description: 'For a new role: its model (inherit = the lead\'s)' },
        duty: { type: 'string', description: 'For a new role: what it does, a sentence' },
        kind: { type: 'string', enum: ['worker', 'advisor'], description: 'For a new role: a worker (default) or an advisor others consult' },
        advises: { type: 'string', description: 'For a new advisor: the role it advises (default the lead)' },
        open_as: { type: 'string', enum: ['tabs', 'windows'], description: "Tabs in the lead's window, or a window each" },
      },
      required: ['role'],
    },
  })
  await $.tool.register({
    name: 'status',
    description:
      "Record where the crew task stands now, in a line or two: what is done, what is in progress, what is next or what blocks it (say \"blocked\" and on what). " +
      "It is kept in the task's history: shown to whoever resumes the task later, and to the project's overseer. " +
      'The lead calls it when a feature is done, when the crew is blocked, when the plan changes, and before the task ends.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  })
  await $.tool.register({
    name: 'feature',
    description:
      'Record that you start, finish or drop a distinct part of the crew task (a feature, component or milestone). ' +
      'Each one is built in the project’s town, kept across tasks, as the kind of thing that fits it best: choose `kind` when you start it. ' +
      'A big area of work made of parts is a farm (or a harbor) and its parts are fields (or docks) with `parent` set to it. ' +
      'To improve something built before, start it under the same name (mcp__crewser__team lists what stands) and it goes a level up when you mark it done. ' +
      'When the user decides to get rid of a feature, record it with status "remove": it burns down.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name, 1-3 words' },
        status: { type: 'string', enum: ['start', 'done', 'remove'], description: 'start when you begin it, done when it is finished, remove when the user drops it' },
        kind: {
          type: 'string', enum: KIND_NAMES,
          description: 'What the town shows it as, on start: ' + KIND_NAMES.map(k => `${k} = ${KINDS[k].about}`).join('; '),
        },
        parent: { type: 'string', description: 'The name of the bigger feature this is a part of (a field of a farm, a dock of a harbor), if any' },
        crop: { type: 'string', enum: [...CROPS], description: 'For a field: what grows in it' },
      },
      required: ['name', 'status'],
    },
  })
}

// ---- the overseer: one session, started on purpose with /crew-overseer, above the leads of every crew in the project.
// It is in no crew; it reads every crew from the files and steers through the leads with orders.

const OVERVIEW = 'crew-overview'
const overviewA = atom({ plugin: 'crewser', key: 'overview' } as const, 0)
/** The crew whose lead (or whole crew) is being written to in the Overview pane, and to whom; task '*' for every lead. */
let briefing: { task: string; to: 'lead' | 'all' } | null = null

/** The histories the Overview shows, by task: the crews at work, those waiting for a decision, and the one inspected. */
let crewHistory = new Map<string, L.HistoryEvent[]>()
/** The task whose history the Overview shows instead of the crews. */
let inspecting: string | null = null
/** The crew whose ■ Stop was pressed in the Overview: its card asks before it closes anything. */
let stopAsk: string | null = null

async function loadHistories($: EngineInterface) {
  const t = await $.clock.now()
  const ids = new Set([...L.crewsIn(disk?.town ?? '', tasks, all, t).map(c => c.task.id), ...waitingList.map(k => k.id), ...(inspecting ? [inspecting] : [])])
  crewHistory = new Map(await Promise.all([...ids].map(async id => [id, await readHistory($, id)] as const)))
}

/** A crew's status: what it last recorded (mcp__crewser__status), or its last report to the overseer, the newer. */
function crewStatus(c: L.CrewView): { text: string; at: number; by: string } | undefined {
  const recorded = L.statusOf(crewHistory.get(c.task.id) ?? [])
  const report = L.lastStatus(c, disk)
  if (recorded && (!report || recorded.at >= report.at)) return { text: recorded.text.replace(/^To the overseer: /, ''), at: recorded.at, by: recorded.by }
  return report ? { text: report.text, at: report.at, by: report.from.split(' · ').pop() ?? '' } : undefined
}

/** The live overseer of this session's project, other than this session. */
const overseerOf = (t: number) => all.find(s => s.overseer && s.root === disk?.root && s.id !== disk?.id && L.isLive(s, t))

/** The crews of this project and what is known of them. */
async function projectCrews($: EngineInterface) {
  await loadDisk($)
  const t = await $.clock.now()
  return L.crewsIn(disk?.town ?? '', tasks, all, t)
}

/** An order for a session: run as its next prompt within a couple of seconds; one that is waiting gets this added. */
async function sendOrder($: EngineInterface, sessionId: string, text: string, extra: { leaveAt?: number } = {}) {
  if (!d) return
  const path = `${d.root}/orders/${sessionId}.json`
  const was = (await readJson($, path)) as { text?: string; leaveAt?: number } | null
  await $.fs.write(path, JSON.stringify({ at: await $.clock.now(), text: was?.text ? `${was.text}\n\n${text}` : text, leaveAt: extra.leaveAt ?? was?.leaveAt }))
}

/** A crew by its task's code (`4821`, `#4821`) or name (or part of it), among this project's. */
async function crewNamed($: EngineInterface, query: string) {
  const crews = await projectCrews($)
  const q = query.trim().toLowerCase()
  const code = q.replace(/^#/, '')
  return (
    crews.find(c => L.codeOf(c.task) === code || c.task.name.toLowerCase() === q || c.task.id === query || L.taskLabel(c.task).toLowerCase() === q) ??
    (q ? crews.find(c => c.task.name.toLowerCase().includes(q) || q.includes(`#${L.codeOf(c.task)}`)) : undefined)
  )
}

/** The crew a tool call names, or a line listing the crews there are. */
async function crewOr($: EngineInterface, input: Record<string, unknown>): Promise<L.CrewView | string> {
  const name = typeof input.crew === 'string' ? input.crew : ''
  const c = await crewNamed($, name)
  return c ?? `No crew called "${name}". ${(await projectCrews($)).map(x => L.taskLabel(x.task)).join(', ') || 'No crews are at work.'}`
}

const REPLY = 'Answer the overseer (a status, a question back, or "done") with mcp__crewser__post to "overseer".'

/** Keeps what the overseer sent in its record: the Overview's conversation, and the crews tool's. */
async function keepSent($: EngineInterface, to: string, text: string) {
  if (!disk) return
  disk.posts = [...disk.posts, { at: await $.clock.now(), to, text: L.gist(text, 280) }].slice(-30)
  await save($)
}

/** The overseer's message to a crew's lead (or the whole crew): their next prompt, within a couple of seconds. */
async function brief($: EngineInterface, c: L.CrewView, text: string, to: 'lead' | 'all') {
  const targets = to === 'all' ? c.members : c.lead ? [c.lead] : []
  for (const s of targets) await sendOrder($, s.id, `[overseer → ${to === 'all' ? `the crew of "${c.task.name}"` : `the lead of "${c.task.name}"`}] ${text}\n\n${REPLY}`)
  if (!targets.length) return `${L.taskLabel(c.task)} has no one to brief right now.`
  await keepSent($, `crew:${c.task.id}`, to === 'all' ? `(whole crew) ${text}` : text)
  await logEvent($, c.task.id, 'brief', `The overseer to ${to === 'all' ? 'the crew' : 'the lead'}: ${text}`)
  return `Sent to ${targets.map(s => L.titleOf(s.name, c.task)).join(', ')}. Replies arrive here as messages and in the Overview.`
}

/** The same message to the lead of every crew at work: a question for all, a change for all. */
async function briefLeads($: EngineInterface, text: string) {
  const crews = (await projectCrews($)).filter(c => c.lead)
  for (const c of crews) await sendOrder($, c.lead?.id ?? '', `[overseer → every lead] ${text}\n\n${REPLY}`)
  if (!crews.length) return 'No crew has a lead at work right now.'
  await keepSent($, 'leads', text)
  for (const c of crews) await logEvent($, c.task.id, 'brief', `The overseer to every lead: ${text}`)
  return `Sent to ${crews.length} lead${crews.length > 1 ? 's' : ''}: ${crews.map(c => L.taskLabel(c.task)).join(', ')}. Replies arrive here as messages and in the Overview.`
}

async function setPaused($: EngineInterface, c: L.CrewView, paused: boolean, why = '') {
  await writeTask($, { ...c.task, paused: paused || undefined })
  const text = paused
    ? `The overseer paused the crew "${c.task.name}"${why ? ` (${why})` : ''}: finish the step you are on, commit or note where you are, then take no new work until it is resumed.`
    : `The overseer resumed the crew "${c.task.name}": carry on with the work.`
  for (const s of c.members) await sendOrder($, s.id, `[overseer] ${text}`)
  await logEvent($, c.task.id, 'pause', paused ? `Paused by the overseer${why ? `: ${why}` : ''}` : 'Resumed by the overseer')
  return `${paused ? 'Paused' : 'Resumed'} "${c.task.name}".`
}

async function retarget($: EngineInterface, c: L.CrewView, goal?: string, priority?: number) {
  const next: L.DiskTask = { ...c.task, ...(goal ? { goal: L.gist(goal, 300) } : {}), ...(priority !== undefined ? { priority } : {}) }
  await writeTask($, next)
  const said = [goal ? `the goal is now: ${goal}` : '', priority !== undefined ? `its priority is now ${priority} (1 goes first)` : ''].filter(Boolean).join('; ')
  if (c.lead && said) await sendOrder($, c.lead.id, `[overseer] For "${c.task.name}", ${said}. Replan with your crew.`)
  if (said) await logEvent($, c.task.id, 'goal', `The overseer: ${said}`)
  return `Updated "${c.task.name}": ${said || 'nothing changed'}.`
}

/** A member's role moved to another crew: a new window takes it up there; the member hands over and leaves its crew. */
async function moveMember($: EngineInterface, who: string, toCrew: string) {
  const crews = await projectCrews($)
  const every = crews.flatMap(c => c.members.map(s => ({ c, s, title: L.titleOf(s.name, c.task) })))
  const exact = every.filter(x => L.namesSession(who, x.s.name, x.title) === 'exact')
  const found = exact.length ? exact : every.filter(x => L.namesSession(who, x.s.name, x.title))
  if (found.length > 1) return `"${who}" could be ${found.map(x => `"${x.title}"`).join(' or ')}: add the crew's code, e.g. "${found[0]?.s.name} #${L.codeOf(found[0]?.c.task ?? { id: '' })}".`
  const from = found[0]?.c
  const member = found[0]?.s
  const target = await crewNamed($, toCrew)
  if (!from || !member?.task) return `No crew member is called "${who}".`
  if (!target) return `No crew is called "${toCrew}".`
  if (target.task.id === from.task.id) return `${member.name} is in "${target.task.name}" already.`
  if (member.id === from.task.creator) return `${member.name} leads "${from.task.name}": a lead stays with its crew.`
  const role = target.task.strategy?.roles.find(r => r.name === member.task?.role && r.kind !== 'lead')
    ?? S.clean({ roles: [{ kind: 'lead', name: 'x' }, { ...(member.task.extra ?? { kind: 'worker', name: member.task.role }), id: `${S.slug(member.task.role)}-${L.uid().slice(0, 3)}` }] }).roles[1] as S.Role
  const have = target.members.filter(s => s.task?.role === role.name).length
  const opened = await openSeats($, target.task, [{ role, n: have + 1, of: have + 1 }], target.members.length, { cwd: dirOf(target.task), beside: target.lead?.tty ?? null })
  if (!opened) return `Could not open a window for ${role.name} in "${target.task.name}" (Terminal.app only).`
  const t = await $.clock.now()
  await sendOrder($, member.id, `[overseer] Your role moves to the crew "${target.task.name}", where a new session takes it up. Post your lead a short hand-over of where you are now; this session then leaves "${from.task.name}".`, { leaveAt: t + 90_000 })
  return `A ${role.name} window opens in "${target.task.name}"; ${member.name} hands over and leaves "${from.task.name}" in about a minute and a half.`
}

async function startCrew($: EngineInterface, name: string, goal: string, strategyName: string, openAs: OpenAs = 'windows') {
  const strategy = strategyName.trim() ? await findStrategy($, strategyName) : null
  if (strategyName.trim() && !strategy) return `No strategy called "${strategyName}". The strategies: ${(await loadStrategies($)).map(x => x.name).join(', ')}.`
  return startElsewhere($, strategy, L.gist(name, 48), goal, openAs)
}

async function becomeOverseer($: EngineInterface): Promise<string> {
  if (!d || !disk) return 'Crew is not ready yet.'
  if (disk.task) return `This session is in "${disk.task.name}". The overseer stands above the crews and is in none of them: open a new Claude session in ${disk.project} and run /crew-overseer there.`
  await loadDisk($)
  const other = overseerOf(await $.clock.now())
  if (other) return `${other.name} already oversees ${disk.project}: there is one overseer per project.`
  await ensureIdentity($, 'Overseer')
  disk.overseer = true
  wasCrew = true
  await save($)
  await registerOverseerTools($)
  $.ui.invalidate('prompt.section')
  await openOverview($)
  const crews = await projectCrews($)
  return (
    `◆ This session now oversees every crew in ${disk.project} (${crews.length} at work). The Overview pane shows them, what each member is doing ` +
    'and your conversation with the leads. Talk to me about any of it ("ask every lead for a status", "tell the checkout lead to wait for search", ' +
    '"pause sound"), or write to a lead straight from the Overview with ✉. Their answers come back here. /crew-overseer opens the Overview again; /crew-overseer stop ends it.'
  )
}

async function stopOverseeing($: EngineInterface) {
  if (!disk?.overseer) return 'This session is not the overseer.'
  disk.overseer = false
  disk.ended = true
  await save($, true)
  disk.ended = false
  await $.ui.close({ id: OVERVIEW }).catch(() => undefined)
  $.ui.invalidate('prompt.section')
  return 'No longer overseeing. The crews carry on under their leads.'
}

async function openOverview($: EngineInterface) {
  // what the crews are doing now, not as of the last heartbeat
  await loadDisk($)
  waitingList = await waitingBranches($)
  inspecting = null
  await loadHistories($)
  await fitWindow($, 130, 56)
  await $.ui.open({ id: OVERVIEW, title: `Overview · ${disk?.project ?? ''}`, closeOnEscape: true, rows: 40, columns: 120 })
}

let overseerTools = false
async function registerOverseerTools($: EngineInterface) {
  if (overseerTools) return
  overseerTools = true
  const crew = { type: 'string', description: "The crew, by its task's code (#4821) or name (or part of it), as mcp__crewser__crews lists it" }
  await $.tool.register({
    name: 'crews',
    description: 'The overseer\'s view of every crew in the project: goal, lead, members and what each is doing, features, cost, priority, paused or not, branch; files more than one crew is changing; finished branches waiting for the user; the tokens left.',
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'brief',
    description:
      "Message the leads from the overseer: instructions, a question, or a request for a status. To one crew's lead (or its whole crew), or with crew \"*\" to the lead of every crew at once. " +
      'It arrives as their next prompt within a couple of seconds; they answer with a post that comes back to you as a message (and shows in mcp__crewser__crews).',
    inputSchema: {
      type: 'object',
      properties: {
        crew: { type: 'string', description: 'The crew, by its code (#4821) or name, as mcp__crewser__crews lists it; "*" for every lead' },
        text: { type: 'string' },
        to: { type: 'string', enum: ['lead', 'all'], description: "lead (default) or the crew's every member" },
      },
      required: ['crew', 'text'],
    },
  })
  await $.tool.register({
    name: 'start_crew',
    description: 'Start a new crew on a task: a lead window of its own opens and opens its crew. When another crew works in the main checkout, it gets its own git worktree and branch.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short task name' }, goal: { type: 'string' },
        strategy: { type: 'string', description: 'A saved strategy by name; empty for a lead alone' },
        open_as: { type: 'string', enum: ['windows', 'tabs'], description: "How its crew opens: a window each (default), or tabs in its lead's window; ask the user when it matters" },
      },
      required: ['name', 'goal'],
    },
  })
  await $.tool.register({
    name: 'pause',
    description: 'Pause a crew: every member finishes the step it is on and takes no new work until resumed. Use it for lower-priority crews when the tokens run low or two crews collide.',
    inputSchema: { type: 'object', properties: { crew, reason: { type: 'string' } }, required: ['crew'] },
  })
  await $.tool.register({
    name: 'resume',
    description: 'Resume a paused crew.',
    inputSchema: { type: 'object', properties: { crew }, required: ['crew'] },
  })
  await $.tool.register({
    name: 'stop_crew',
    description: 'Stop a crew at once: its task ends (it can be resumed later), every member session quits and their Terminal windows close. Only when the user asks for it; to hold a crew for a while, pause it instead.',
    inputSchema: { type: 'object', properties: { crew }, required: ['crew'] },
  })
  await $.tool.register({
    name: 'retarget',
    description: "Change a crew's goal and/or priority (1 goes first); its lead is told and replans.",
    inputSchema: { type: 'object', properties: { crew, goal: { type: 'string' }, priority: { type: 'number' } }, required: ['crew'] },
  })
  await $.tool.register({
    name: 'move',
    description: "Move a member's role to another crew: a new session takes the role up there (its window opens), and the member hands over and leaves its crew.",
    inputSchema: { type: 'object', properties: { member: { type: 'string', description: 'The member by name, with its crew\'s code when two crews have one of that name ("Implementer #1 #4821")' }, to: crew }, required: ['member', 'to'] },
  })
}

/** What the overseer reads in its system prompt. */
function overseerSection(): string {
  return [
    '# Overseer',
    `This session oversees every crew in the project "${disk?.project ?? ''}". Each crew has a lead who orchestrates one task or feature; you stand above the leads, in no crew yourself.`,
    'Crews are named by their task and a short code ("Checkout flow #4821"); every session\'s title is "<task> #<code> · <name>". Use the code to name a crew or, with a member\'s name, a member.',
    'mcp__crewser__crews gives the whole picture: every crew, what each member is doing and for how long, features, cost, priority, its last status to you, your conversation with the leads, files more than one crew is changing, finished branches waiting, and the tokens left (shared by all crews). Call it before you answer the user about the crews.',
    'Talk to the leads with mcp__crewser__brief: one crew\'s lead (or the whole crew), or every lead at once with crew "*" (e.g. to ask all of them for a status). It reaches them within seconds. Their answers come back to you as messages headed "[<task> #<code> · <name> → overseer]": tell the user what they said, briefly.',
    'Steer with mcp__crewser__retarget (goal, priority), mcp__crewser__pause and mcp__crewser__resume, mcp__crewser__move (a member to another crew), mcp__crewser__start_crew (a new crew; it gets its own worktree when another crew works in the main checkout).',
    'Leads post you short status lines. When two crews change the same files, decide the order their work should merge in and tell both leads. When the tokens run low, pause the lowest-priority crews first. A crew whose last status says it is blocked needs you or the user: say so.',
    "Merging a crew's branch, opening a pull request or keeping it is the user's decision: tell the user when one is waiting (they decide in /crew-task or the Overview pane). Do not edit the project's files yourself unless the user asks.",
  ].join('\n')
}

// ---- the bars

type Drawable = Parameters<EngineInterface['ui']['resolve']>[0]

async function barsRow($: EngineInterface, e: Drawable, columns: number) {
  const task = await read($, taskA)
  const me = task ? await read($, meA) : null // name and color belong to crew members
  const u = await read($, usageA)
  if (!me && u.ctx === undefined && u.five === undefined && u.week === undefined) return null
  const { Box, Text } = $.ui.resolve(e)
  const peers = (await read($, peersA)).filter(p => !p.isMe).length
  const t = Date.now()
  const width = columns < 90 ? Math.min(opt.barWidth, 6) : opt.barWidth

  const meter = (label: string, pct: number | undefined, extra = '') => {
    if (pct === undefined) return null
    const { fill, rest } = L.bar(pct, width, opt.barStyle)
    const color = opt.barColors === 'session' ? (me?.color ?? 'claude') : opt.barColors === 'mono' ? 'text' : L.traffic(pct)
    return (
      <Box key={`m-${label}`} marginRight={2}>
        <Text dimColor>{label} </Text>
        {opt.barStyle === 'ascii' && <Text dimColor>[</Text>}
        <Text color={color}>{fill}</Text>
        <Text dimColor>{rest}</Text>
        {opt.barStyle === 'ascii' && <Text dimColor>]</Text>}
        <Text color={color}> {Math.round(pct)}%</Text>
        {extra && <Text dimColor> ↻{extra}</Text>}
      </Box>
    )
  }

  return (
    <Box key="bars" flexDirection="row" flexWrap="wrap">
      {me && (
        <Box marginRight={2}>
          <Text color={me.color} bold>
            ● {me.name}
          </Text>
        </Box>
      )}
      {opt.showContext && meter('ctx', u.ctx)}
      {opt.showSessionLimit && meter('5h', u.five, L.fmtLeft(u.fiveResetsAt, t))}
      {opt.showWeeklyLimit && meter('wk', u.week, L.fmtLeft(u.weekResetsAt, t))}
      {opt.showCost && u.cost !== undefined && (
        <Box marginRight={2}>
          <Text dimColor>${u.cost.toFixed(2)}</Text>
        </Box>
      )}
      {task && me && (
        <Box marginRight={2}>
          <Text color={me.color}>
            ⚑ {L.taskLabel(tasks.find(k => k.id === task.id) ?? task)}·{task.role}
          </Text>
        </Box>
      )}
      {peers > 0 && <Text dimColor>👥 {peers}</Text>}
    </Box>
  )
}

// ---- hooks

export const register: Register = (on, o) => {
  opt = options(o)

  on('session.start', async ($, e, next) => {
    await registerAll($)
    await startTown($)
    await init($)
    $.clock.every(2500, () => void tick($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (d && disk) {
      disk.ended = true
      disk.status = 'idle'
      if (disk.task) await save($, true).catch(() => undefined)
      const t = await $.clock.now()
      for (const k of tasks.filter(x => x.creator === disk?.id)) {
        // stopped by someone: its ending, and its roster, are written already
        if (((await readJson($, `${d.tasks}/${k.id}.json`)) as L.DiskTask | null)?.ended) continue
        await writeTask($, { ...k, ended: true, endedAt: t, invite: undefined })
        await logEvent($, k.id, 'end', 'The lead closed its window').catch(() => undefined)
      }
      const me = await read($, meA)
      if (me && disk.task && e.reason !== 'clear') await unpaint($, me).catch(() => undefined)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && disk) {
      if (await read($, attentionA)) await ack($)
      disk.lastPrompt = L.gist(e.text, 90)
      disk.activity = disk.lastPrompt
      disk.userAt = await $.clock.now()
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // a prompt carries the crew name as the session's title: the same field a settings hook sets
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    const me = await read($, meA)
    const title = pendingTitle ?? ((disk?.task || disk?.overseer) && me ? currentTitle() : null)
    if (!title) return r
    pendingTitle = null
    return { ...r, sessionTitle: title }
  })

  on('turn.start', async ($, e, next) => {
    if (disk) {
      disk.status = 'working'
      disk.busySince = await $.clock.now()
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (disk) {
      disk.status = 'idle'
      disk.tool = ''
      disk.detail = ''
      disk.busySince = undefined
      disk.idleSince = await $.clock.now()
      await save($)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!disk) return next(e)
    const name = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    // conversations: with a teammate or another agent, or the advisor
    const talk =
      name === 'SendMessage' ? String(input.to ?? input.recipient ?? 'someone')
      : name === 'mcp__crewser__post' ? String(input.to ?? 'all')
      : /advis/i.test(name) ? 'advisor'
      : ''
    if (talk) {
      disk.talkTo = talk
      disk.talkAt = await $.clock.now()
      if (disk.task) await save($)
    }
    if (name.startsWith('mcp__crewser__')) return next(e)
    // what it edits, relative to the folder it works in, so the overseer sees two crews on one file
    const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
    if (file && /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) {
      const base = `${disk.top ?? disk.cwd}/`
      const rel = file.startsWith(base) ? file.slice(base.length) : file
      disk.files = [rel, ...(disk.files ?? []).filter(f => f !== rel)].slice(0, 30)
    }
    disk.tool = name
    disk.detail = L.describeCall(String(e.tool), e as unknown as Record<string, unknown>)
    return next(e)
  }).catch(($, e, next) => next(e))

  // a new subagent shows up on teammates' maps at once, not at the next heartbeat
  on('command.run', async ($, e, next) => {
    const r = await next(e)
    const head = waiting[0]
    if (head && e.origin.kind === 'composer' && head.startsWith(`/${e.command} `)) {
      waiting = waiting.slice(1)
      $.clock.after(400, () => void fillNext($))
    }
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (disk?.task) {
      await syncAgents($)
      await save($)
    }
    return r
  })

  on('session.measure', async ($, e, next) => {
    await applyUsage($, e.context, e.rateLimits, e.cost?.usd)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const text = section()
    return text ? { sections: [...composed.sections, { id: 'crew', text, scope: 'session' as const }] } : composed
  })

  on('tool.call', { tool: 'mcp__crewser__ping' }, async ($, e) => {
    const input = e as unknown as { session?: string; reason?: string }
    const t = await $.clock.now()
    const target = findSession(t, input.session ?? '')
    if (!target || !disk) return { result: `No teammate matches "${input.session}". Call mcp__crewser__team first.` }
    disk.pings = [
      ...disk.pings.filter(p => p.to !== target.id),
      { id: L.uid(), to: target.id, reason: L.gist(input.reason ?? 'needs a look', 80), at: t },
    ]
    await save($)
    return { result: `Pinged ${target.name}: its window pulses until the user focuses it.` }
  })

  on('tool.call', { tool: 'mcp__crewser__team' }, async $ => {
    await tick($)
    const me = disk
    if (!me?.task) return { result: 'This session is in no crew task. The user starts or joins one with /crew-task.' }
    const t = await $.clock.now()
    const task = tasks.find(k => k.id === me.task?.id)
    const members = [me, ...teammates(t)]
    const town = taskTown() ? await loadTown($, taskTown()) : null
    const built = (town?.buildings ?? []).filter(b => b.status !== 'removed').map(b => `${b.name} (${b.kind ?? 'house'}${b.parent ? ` of ${b.parent}` : ''}, level ${b.level}${b.status === 'building' ? ', being worked on' : ''})`)
    const posts = members
      .flatMap(s => s.posts.map(p => ({ s, p })))
      .sort((a, b) => a.p.at - b.p.at)
      .slice(-10)
      .map(({ s, p }) => `  ${s.name}${p.to !== 'all' ? ` → ${all.find(x => x.id === p.to)?.name ?? p.to}` : ''}: ${p.text}`)
    return {
      result: [
        `Task "${me.task.name}"${task?.goal ? ` — goal: ${task.goal}` : ''} (lead ${task?.creatorName ?? '?'})`,
        'Members:',
        ...members.map(
          s => `  ${s.name}${s.id === me.id ? ' (you)' : ''} · ${s.task?.role} · ${s.model} · ${s.status} · ${s.lastPrompt || s.activity}`,
        ),
        ...members.flatMap(s => s.features.map(f => `  feature ${f.name}: ${f.status === 'done' ? 'done' : 'in progress'} (${s.name})`)),
        built.length ? `Town buildings (${town?.project}), to improve under the same name: ${built.join(', ')}` : 'The town has no buildings yet.',
        posts.length ? 'Recent posts:' : 'No posts yet.',
        ...posts,
      ].join('\n'),
    }
  })

  on('tool.call', { tool: 'mcp__crewser__feature' }, async ($, e) => {
    const input = e as unknown as { name?: string; status?: string; kind?: string; parent?: string; crop?: string }
    if (!disk?.task) return { result: 'Not in a crew task.' }
    const name = L.gist(input.name ?? 'feature', 28)
    const parent = input.parent?.trim() ? L.gist(input.parent.trim(), 28) : undefined
    const guess = guessKind(name, parent)
    const kind = (KIND_NAMES as string[]).includes(input.kind ?? '') ? input.kind : guess.kind
    const crop = (CROPS as readonly string[]).includes(input.crop ?? '') ? input.crop : kind === 'field' ? guess.crop : undefined
    const what = { kind, ...(parent ? { parent } : {}), ...(crop ? { crop } : {}) }
    const t = await $.clock.now()
    const rest = disk.features.filter(f => f.name.toLowerCase() !== name.toLowerCase())
    const was = disk.features.find(f => f.name.toLowerCase() === name.toLowerCase())
    if (input.status === 'remove') {
      disk.features = rest
      await save($)
      const gone = await recordBuilding($, name, 'removed', t).catch(err => (void note($, 'town', err), null))
      await logEvent($, disk.task.id, 'feature', `Dropped ${name}`, { name, status: 'removed' })
      return { result: gone ? `Removed "${gone.name}": its building burns down in the town, and the plot is free for something new.` : `No building is called "${name}"; mcp__crewser__team lists them.` }
    }
    const status: L.DiskFeature['status'] = input.status === 'done' ? 'done' : 'building'
    const keep = was?.kind ? { kind: was.kind, parent: was.parent, crop: was.crop } : what
    disk.features = [...rest, { id: was?.id ?? L.uid(), name, status, at: t, ...keep }].slice(-10)
    await save($)
    const before = await recordBuilding($, name, status, t, what).catch(err => (void note($, 'town', err), null))
    if (status !== was?.status) await logEvent($, disk.task.id, 'feature', status === 'done' ? `Finished ${name}` : `Started ${name} (${keep.kind ?? 'house'})`, { name, status })
    const as = `${before?.kind ?? keep.kind}${keep.parent ? ` (part of ${keep.parent})` : ''}`
    if (status === 'done') return { result: `Marked "${name}" done.${before && before.level > 0 && before.status === 'building' ? ` It is now level ${before.level + 1}.` : ''}` }
    return { result: before ? `Started improving "${before.name}" (a ${as}, level ${before.level}): it goes up a level when you mark it done.` : `Started "${name}": the town builds it as a ${as}.` }
  })

  on('tool.call', { tool: 'mcp__crewser__add_members' }, async ($, e) => {
    const i = e as unknown as Record<string, unknown>
    if (!disk?.task) return { result: 'Not in a crew task.' }
    await loadDisk($)
    const task = tasks.find(k => k.id === disk?.task?.id)
    if (!task) return { result: 'The task has ended.' }
    const base = task.strategy ?? S.leadAlone(task.name)
    const name = L.gist(String(i.role ?? '').trim(), 32)
    if (!name) return { result: 'Name the role to add.' }
    const count = Math.max(1, Math.min(6, Math.round(Number(i.count) || 1)))
    const has = base.roles.find(r => r.kind !== 'lead' && r.name.toLowerCase() === name.toLowerCase())
    let next: S.Strategy
    if (has) next = { ...base, roles: base.roles.map(r => (r === has ? { ...r, count: Math.min(6, r.count + count) } : r)) }
    else {
      const kind = i.kind === 'advisor' ? 'advisor' : 'worker'
      const advises = typeof i.advises === 'string' ? base.roles.find(r => r.name.toLowerCase() === i.advises?.toString().toLowerCase()) : undefined
      next = S.clean({
        ...base,
        roles: [...base.roles, { name, kind, model: typeof i.model === 'string' ? i.model : 'inherit', count, duty: typeof i.duty === 'string' ? i.duty : '', links: kind === 'advisor' ? [advises?.id ?? base.roles[0]?.id ?? 'lead'] : [] }],
      })
    }
    return { result: await growCrew($, next, i.open_as === 'tabs' ? 'tabs' : i.open_as === 'windows' ? 'windows' : (task.openAs ?? 'windows')) }
  })

  on('tool.call', { tool: 'mcp__crewser__status' }, async ($, e) => {
    const text = String((e as unknown as { text?: string }).text ?? '').trim()
    if (!disk?.task) return { result: 'Not in a crew task.' }
    if (!text) return { result: 'Say where the task stands in a line or two.' }
    const t = await $.clock.now()
    await logEvent($, disk.task.id, 'status', text)
    const o = overseerOf(t)
    if (o) {
      const said = `[${currentTitle()} → overseer] Status: ${text}`
      const sent = await $.session.send({ to: { sessionId: o.id }, text: said }).catch(() => ({ isDelivered: false as const }))
      if (!sent.isDelivered) await sendOrder($, o.id, said)
      disk.posts = [...disk.posts, { at: t, to: 'overseer', text: L.gist(`Status: ${text}`, 280) }].slice(-12)
      await save($)
    }
    return { result: `Recorded the task's status${o ? ' and told the overseer' : ''}. It is shown when the task is resumed later.` }
  })

  on('tool.call', { tool: 'mcp__crewser__post' }, async ($, e) => {
    const input = e as unknown as { text?: string; to?: string }
    if (!disk?.task) return { result: 'Not in a crew task.' }
    const t = await $.clock.now()
    if (input.to?.trim().toLowerCase() === 'overseer') {
      const o = overseerOf(t)
      if (!o) return { result: 'The project has no overseer right now.' }
      const text = `[${currentTitle()} → overseer] ${input.text ?? ''}`
      const sent = await $.session.send({ to: { sessionId: o.id }, text }).catch(() => ({ isDelivered: false as const }))
      if (!sent.isDelivered) await sendOrder($, o.id, text)
      disk.posts = [...disk.posts, { at: t, to: 'overseer', text: L.gist(input.text ?? '', 280) }].slice(-12)
      await save($)
      await logEvent($, disk.task.id, 'report', `To the overseer: ${input.text ?? ''}`)
      return { result: 'Posted to the overseer.' }
    }
    const to = !input.to || input.to.toLowerCase() === 'all' ? 'all' : findSession(t, input.to)?.id
    if (!to) return { result: `No teammate matches "${input.to}".` }
    const out = await broadcast($, input.text ?? '', to)
    return { result: out.length ? `Posted. ${out.join('; ')}` : 'Posted, but no teammate is online right now.' }
  })

  on('command.run', { command: 'crew-task' }, async $ => ({ text: await taskFlow($) }))

  on('command.run', { command: 'crew-strategy-manage' }, async $ => {
    await openBoard($, 'manage')
    return { text: 'The strategy board is open: pick one to see it drawn.' }
  })

  on('command.run', { command: 'crew-strategy-new' }, async ($, e) => ({ text: await newStrategy($, e.args) }))

  on('command.run', { command: 'crew-strategy-config' }, async ($, e) => ({ text: await configStrategy($, e.args.trim()) }))

  on('command.run', { command: 'crew-strategy-use' }, async ($, e) => {
    if (e.args.trim()) return { text: await useStrategy($, e.args.trim()) }
    const naming = !pendingStart
    if (naming) pendingStart = { name: '', goal: '' }
    await openBoard($, 'pick', { view: naming ? 'busy' : 'list', note: naming ? LOOKING : '' })
    if (naming) void toNameStep($)
    return { text: naming ? 'Name the task in the board, then pick its strategy.' : 'Pick a strategy in the board.' }
  })

  on('command.run', { command: 'crew-strategy-delete' }, async ($, e) => {
    const list = await loadStrategies($)
    const name = e.args.trim() || (await $.ui.ask('Delete which strategy?', { header: 'Delete', options: list.slice(0, 4).map(s => s.name) }))
    const s = await findStrategy($, name)
    if (!s) return { text: `No strategy called "${name}".` }
    const sure = await $.ui.ask(`Delete "${s.name}" for good?`, { header: 'Delete', options: ['Delete it', 'Keep it'] })
    if (!sure.startsWith('Delete')) return { text: 'Kept.' }
    await deleteStrategy($, s.id)
    boardList = await loadStrategies($)
    await setBoard($, { index: 0 })
    return { text: `Deleted "${s.name}".` }
  })

  on('command.run', { command: 'crew-add' }, async $ => ({ text: await openCrewBoard($) }))

  on('command.run', { command: 'crew-stop' }, async $ => {
    if (!disk?.task) return { text: disk?.overseer ? 'The overseer stops a crew from the Overview: ■ on its card.' : 'Not in a crew task.' }
    await openBoard($, 'manage', { view: 'stop' })
    return { text: `Stop "${disk.task.name}"? Answer in the board.` }
  })

  on('command.run', { command: 'crew-tile' }, async $ => {
    await retile($)
    return { text: disk?.task ? 'Tiled the crew’s windows.' : 'Not in a crew task.' }
  })

  // ↑ ↓ through the strategy list: the drawing beside it follows the focus
  on('ui.focus', { requestId: BOARD }, async ($, e, next) => {
    const b = await read($, boardA)
    const key = e.element ?? ''
    if ((b.view ?? 'list') === 'list') {
      const at = boardList.findIndex(s => `pick-${s.id}` === key)
      if (at >= 0 && (at !== b.index || b.hover)) await setBoard($, { index: at, hover: null })
      else if ((key === 'new' || key === 'none') && b.hover !== key) await setBoard($, { hover: key })
    }
    return next(e)
  })

  // ---- the overseer's commands, tools and pane

  on('command.run', { command: 'crew-overseer' }, async ($, e) => ({
    text: /^\s*(stop|off|end|quit)\b/i.test(e.args) ? await stopOverseeing($) : disk?.overseer ? (await openOverview($), 'Overview opened.') : await becomeOverseer($),
  }))

  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const NOT = 'Only the overseer (/crew-overseer) can do this.'

  on('tool.call', { tool: 'mcp__crewser__crews' }, async $ => {
    if (!disk?.overseer) return { result: NOT }
    const crews = await projectCrews($)
    return { result: L.overview(crews, disk.five ?? null, await waitingBranches($), await $.clock.now(), disk) }
  })
  on('tool.call', { tool: 'mcp__crewser__brief' }, async ($, e) => {
    if (!disk?.overseer) return { result: NOT }
    const i = e as unknown as Record<string, unknown>
    if (/^\s*(\*|all|every( lead)?|leads)?\s*$/i.test(str(i.crew))) return { result: await briefLeads($, str(i.text)) }
    const c = await crewOr($, i)
    return { result: typeof c === 'string' ? c : await brief($, c, str(i.text), i.to === 'all' ? 'all' : 'lead') }
  })
  on('tool.call', { tool: 'mcp__crewser__pause' }, async ($, e) => {
    if (!disk?.overseer) return { result: NOT }
    const i = e as unknown as Record<string, unknown>
    const c = await crewOr($, i)
    return { result: typeof c === 'string' ? c : await setPaused($, c, true, str(i.reason)) }
  })
  on('tool.call', { tool: 'mcp__crewser__resume' }, async ($, e) => {
    if (!disk?.overseer) return { result: NOT }
    const c = await crewOr($, e as unknown as Record<string, unknown>)
    return { result: typeof c === 'string' ? c : await setPaused($, c, false) }
  })
  on('tool.call', { tool: 'mcp__crewser__stop_crew' }, async ($, e) => {
    if (!disk?.overseer) return { result: NOT }
    const c = await crewOr($, e as unknown as Record<string, unknown>)
    if (typeof c === 'string') return { result: c }
    const text = await stopCrew($, c.task.id, 'the overseer')
    waitingList = await waitingBranches($)
    await update($, overviewA, v => v + 1)
    return { result: text }
  })
  on('tool.call', { tool: 'mcp__crewser__retarget' }, async ($, e) => {
    if (!disk?.overseer) return { result: NOT }
    const i = e as unknown as Record<string, unknown>
    const c = await crewOr($, i)
    return { result: typeof c === 'string' ? c : await retarget($, c, str(i.goal) || undefined, typeof i.priority === 'number' ? i.priority : undefined) }
  })
  on('tool.call', { tool: 'mcp__crewser__move' }, async ($, e) => {
    if (!disk?.overseer) return { result: NOT }
    const i = e as unknown as Record<string, unknown>
    return { result: await moveMember($, str(i.member), str(i.to)) }
  })
  on('tool.call', { tool: 'mcp__crewser__start_crew' }, async ($, e) => {
    if (!disk?.overseer) return { result: NOT }
    const i = e as unknown as Record<string, unknown>
    return { result: await startCrew($, str(i.name), str(i.goal), str(i.strategy), i.open_as === 'tabs' ? 'tabs' : 'windows') }
  })

  on('ui.close', { id: OVERVIEW }, async ($, e, next) => {
    briefing = null
    stopAsk = null
    inspecting = null
    return next(e)
  })

  // the Overview, in sections that read apart: the crews at work (a card each, in its crew's color), files two of them
  // change, finished work waiting for the person's decision (a box of its own), and the conversation with the leads
  on('ui.render', { component: 'Pane', requestId: OVERVIEW }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>The Overview needs the terminal or the desktop app.</Text>
    }
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    await read($, overviewA)
    const t = await $.clock.now()
    const crews = L.crewsIn(disk?.town ?? '', tasks, all, t)
    const both = L.overlaps(crews)
    const waiting = waitingList
    const five = disk?.five ?? null
    const total = crews.reduce((n, c) => n + c.cost, 0)
    const people = crews.flatMap(c => c.members)
    const busy = people.filter(s => s.status === 'working').length
    const talk = L.feed(disk, crews, 8)
    const cols = Math.max(40, e.props.bodyColumns)
    const redraw = () => update($, overviewA, v => v + 1)
    const say = (text: string) => $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }).catch(() => $.ui.toast(text, { timeoutMs: 8000 }))
    const clock = (at: number) => new Date(at).toTimeString().slice(0, 5)
    const inspect = async (id: string | null) => {
      inspecting = id
      if (id) crewHistory.set(id, await readHistory($, id))
      await redraw()
    }
    // a section's heading: its name and count, then a rule to the edge
    const heading = (key: string, title: string, color: string, sub?: string) => (
      <Box key={key} flexDirection="column" marginTop={1}>
        <Box key="rule" flexDirection="row">
          {/* the title never wraps or shrinks: the rule after it gives way */}
          <Box key="title" flexShrink={0}><Text bold color={color} wrap="truncate-end">{`${title} `}</Text></Box>
          <Box key="line" flexGrow={1} flexShrink={1} minWidth={0}><Text color={color} dimColor wrap="truncate-end">{'─'.repeat(cols)}</Text></Box>
        </Box>
        {sub ? <Text key="sub" dimColor wrap="wrap">{sub}</Text> : null}
      </Box>
    )
    // one line to write in: to a crew's lead, its whole crew, or ('*') every lead
    const writer = (task: string, c?: L.CrewView) =>
      briefing?.task === task ? (
        <Box key={`write-${task}`} flexDirection="column" marginTop={1}>
          <Input key={`brieftext-${task}`} label={task === '*' ? 'To every lead: ' : briefing.to === 'all' ? 'To the whole crew: ' : 'To the lead: '}
            placeholder={task === '*' ? 'e.g. post me a one-line status' : 'what should they do, or what do you want to know?'} submitLabel="send" autoFocus
            onSubmit={async v => {
              if (!v.trim()) return
              const to = briefing?.to ?? 'lead'
              briefing = null
              await say(c ? await brief($, c, v.trim(), to) : await briefLeads($, v.trim()))
              await loadDisk($)
              await redraw()
            }} />
          {c && <Button key="briefall" label={briefing.to === 'all' ? 'Only the lead' : 'The whole crew'} dimColor onPress={() => ((briefing = { task, to: briefing?.to === 'all' ? 'lead' : 'all' }), redraw())} />}
          <Button key="briefcancel" label="Cancel" dimColor onPress={() => ((briefing = null), redraw())} />
        </Box>
      ) : null
    // ---- one task's history: where it stands, its features, and every change, newest first
    if (inspecting) {
      const id = inspecting
      const k = [...tasks, ...waitingList, ...pastList].find(x => x.id === id)
      const hist = crewHistory.get(id) ?? []
      const c = crews.find(x => x.task.id === id)
      const color = c?.lead?.color ?? '#8a8a8a'
      const st = c ? crewStatus(c) : (() => { const e = L.statusOf(hist); return e ? { text: e.text, at: e.at, by: e.by } : undefined })()
      const feats = L.featuresOf(hist)
      const groups: { day: string; events: L.HistoryEvent[] }[] = []
      for (const ev of [...hist].reverse().slice(0, 120)) {
        const day = new Date(ev.at).toDateString()
        const g = groups[groups.length - 1]
        if (g?.day === day) g.events.push(ev)
        else groups.push({ day, events: [ev] })
      }
      const byWidth = Math.min(22, Math.max(8, ...hist.map(ev => ev.by.length + 2)))
      const back = (key: string) => <Button key={key} label="← Back to the overview" variant="primary" autoFocus={key === 'back-top' ? true : undefined} onPress={() => inspect(null)} />
      return (
        <Box flexDirection="column">
          <Box key="top" flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
            <Text bold color={color} wrap="truncate-end">{`☰ History · ⚑ ${k ? L.taskLabel(k) : 'a task'}`}</Text>
            <Text dimColor wrap="truncate-end">
              {[c ? 'running' : k?.ended ? (k.branch && !k.outcome ? 'finished, waiting for your decision' : 'finished') : 'not running', k ? `started ${L.ago(t - k.createdAt)}` : '', k?.strategy ? `strategy ${k.strategy.name}` : '', k?.branch ? `branch ${k.branch}` : '', `${hist.length} event${hist.length === 1 ? '' : 's'}`].filter(Boolean).join('  ·  ')}
            </Text>
            {k?.goal ? <Text wrap="wrap"><Text bold>Goal  </Text>{k.goal}</Text> : null}
            <Text wrap="wrap">
              <Text bold>Status  </Text>
              {st ? <Text><Text color={L.saysBlocked(st.text) ? 'error' : undefined}>{st.text}</Text><Text dimColor>{`  (${st.by}, ${L.ago(t - st.at)})`}</Text></Text> : <Text dimColor>none recorded</Text>}
            </Text>
            {feats.length > 0 && (
              <Text wrap="wrap">
                <Text bold>Features  </Text>
                {feats.map(f => `${f.name} ${f.status === 'done' ? '✓' : f.status === 'removed' ? '✗' : '…'}`).join('   ')}
              </Text>
            )}
            <Box key="acts" flexDirection="column" marginTop={1}>{back('back-top')}</Box>
          </Box>
          {heading('h-timeline', `TIMELINE · NEWEST FIRST`, 'claude', hist.length ? undefined : 'Nothing was recorded for this task (tasks from before version 0.18 kept no history).')}
          {groups.map(g => (
            <Box key={`day-${g.day}`} flexDirection="column" marginTop={1}>
              <Text dimColor bold>{g.day}</Text>
              {g.events.map((ev, i) => (
                <Box key={`ev-${ev.at}-${i}`} flexDirection="row">
                  <Text dimColor>{`${clock(ev.at)}  `}</Text>
                  <Box width={3}><Text color={ev.kind === 'status' ? 'success' : ev.kind === 'brief' ? 'claude' : ev.kind === 'end' ? 'warning' : undefined}>{L.HISTORY_ICON[ev.kind]}</Text></Box>
                  <Box width={byWidth}><Text bold wrap="truncate-end">{ev.by}</Text></Box>
                  <Box flexGrow={1}><Text wrap="wrap" color={ev.kind === 'status' && L.saysBlocked(ev.text) ? 'error' : undefined}>{ev.kind === 'status' ? `Status: ${ev.text}` : ev.text}</Text></Box>
                </Box>
              ))}
            </Box>
          ))}
          {hist.length > 12 && <Box key="acts-end" flexDirection="column" marginTop={1}>{back('back-end')}</Box>}
        </Box>
      )
    }

    const card = (c: L.CrewView) => {
      const k = c.task
      const color = c.lead?.color ?? c.members[0]?.color ?? '#8a8a8a'
      const done = c.features.filter(f => f.status === 'done').length
      const working = c.members.filter(s => s.status === 'working').length
      const status = crewStatus(c)
      const blocked = !!status && L.saysBlocked(status.text)
      // a crew with everyone idle a while waits for something: worth a look
      const idleFor = working === 0 && c.members.length ? Math.min(...c.members.map(s => t - (s.idleSince ?? t))) : 0
      const nameWidth = Math.min(24, Math.max(12, ...c.members.map(s => s.name.length + 3)))
      const state = k.paused ? ['PAUSED', 'warning'] : blocked ? ['BLOCKED', 'error'] : idleFor > 5 * 60_000 ? [`IDLE ${L.dur(idleFor)}`, 'warning'] : working ? ['WORKING', 'success'] : ['IDLE', 'subtle']
      return (
        <Box key={`crew-${k.id}`} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginTop={1}>
          <Box key="head" flexDirection="row">
            <Box flexGrow={1}><Text color={color} bold wrap="truncate-end">{`⚑ ${L.taskLabel(k)}`}</Text></Box>
            <Text color={state[1]} bold>{` ${state[0]}`}</Text>
          </Box>
          <Text key="meta" dimColor wrap="truncate-end">
            {[`lead ${c.lead?.name ?? k.creatorName}`, k.branch ? `branch ${k.branch}` : 'main checkout', `${working} of ${c.members.length} working`, c.features.length ? `${done}/${c.features.length} features done` : 'no features yet', `$${c.cost.toFixed(2)}`, k.priority !== undefined ? `priority ${k.priority}` : ''].filter(Boolean).join('  ·  ')}
          </Text>
          {k.goal ? <Text key="goal" wrap="wrap"><Text dimColor>Goal  </Text>{k.goal}</Text> : null}
          <Text key="status" wrap="wrap">
            <Text bold>Status  </Text>
            {status ? (
              <Text>
                <Text color={blocked ? 'error' : undefined}>{status.text}</Text>
                <Text dimColor>{`  (${status.by}, ${L.dur(t - status.at)} ago)`}</Text>
              </Text>
            ) : <Text dimColor>none recorded yet</Text>}
          </Text>
          <Box key="team" flexDirection="column" marginTop={1}>
            {c.members.map(m => (
              <Box key={`m-${m.id}`} flexDirection="row">
                <Text color={color}>{m.status === 'working' ? '● ' : '○ '}</Text>
                <Box width={nameWidth}><Text color={m.color} bold={m.id === k.creator} wrap="truncate-end">{m.id === k.creator ? `★ ${m.name}` : m.name}</Text></Box>
                <Box width={8}><Text dimColor wrap="truncate-end">{m.model}</Text></Box>
                <Box flexGrow={1}>
                  <Text wrap="truncate-end" color={m.status === 'working' ? undefined : 'subtle'}>{L.doing(m, t)}</Text>
                </Box>
                {m.ctx !== null && cols >= 90 && <Text color={L.traffic(m.ctx)}>{` ctx ${Math.round(m.ctx)}% `}</Text>}
                <Button key={`go-${m.id}`} label="Go" dimColor onPress={() => goTo($, m.id)} />
              </Box>
            ))}
          </Box>
          {c.features.length > 0 && (
            <Text key="features" wrap="wrap"><Text dimColor>Features  </Text>{c.features.map(f => `${f.name} ${f.status === 'done' ? '✓' : '…'}`).join('   ')}</Text>
          )}
          <Box key="acts" flexDirection="column" marginTop={1}>
            <Button key={`history-${k.id}`} label="☰ History: what changed and when" dimColor onPress={() => inspect(k.id)} />
            <Button key={`brief-${k.id}`} label="✉ Message the lead…" dimColor onPress={() => ((briefing = { task: k.id, to: 'lead' }), redraw())} />
            <Button key={`briefcrew-${k.id}`} label="✉ Message the whole crew…" dimColor onPress={() => ((briefing = { task: k.id, to: 'all' }), redraw())} />
            <Button key={`pause-${k.id}`} label={k.paused ? '▶ Resume the crew' : '⏸ Pause the crew'} dimColor onPress={async () => (await say(await setPaused($, c, !k.paused)), await loadDisk($), redraw())} />
            {c.lead && <Button key={`go-${k.id}`} label="⧉ Go to the lead's window" dimColor onPress={() => goTo($, c.lead?.id ?? '')} />}
            {stopAsk === k.id ? (
              <Box key={`stopask-${k.id}`} flexDirection="column" marginTop={1}>
                <Text color="warning" wrap="wrap">{`Stop "${k.name}" now? Its ${c.members.length} session${c.members.length === 1 ? '' : 's'} quit at once and their Terminal windows close.${k.branch ? ` Its branch then waits for your decision below.` : ''}`}</Text>
                <Button key={`stopyes-${k.id}`} label="■ Yes, stop the crew and close its windows" onPress={async () => {
                  stopAsk = null
                  await say(await stopCrew($, k.id, 'the overseer'))
                  waitingList = await waitingBranches($)
                  await redraw()
                }} />
                <Button key={`stopno-${k.id}`} label="Keep it running" autoFocus onPress={() => ((stopAsk = null), redraw())} />
              </Box>
            ) : (
              <Button key={`stop-${k.id}`} label="■ Stop the crew and close its windows…" dimColor onPress={() => ((stopAsk = k.id), redraw())} />
            )}
          </Box>
          {writer(k.id, c)}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Box key="top" flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Text bold color="claude">{`◆ Overseer · ${disk?.project ?? ''}`}</Text>
          <Text wrap="truncate-end">
            <Text bold>{`${crews.length}`}</Text><Text dimColor>{` crew${crews.length === 1 ? '' : 's'} running  ·  `}</Text>
            <Text bold>{`${busy} of ${people.length}`}</Text><Text dimColor>{' working  ·  '}</Text>
            <Text bold color={five === null ? undefined : L.traffic(five)}>{five === null ? '?' : `${Math.max(0, Math.round(100 - five))}%`}</Text><Text dimColor>{' of the 5h limit left  ·  '}</Text>
            <Text bold>{`$${total.toFixed(2)}`}</Text>
            {waiting.length > 0 && <Text color="success" bold>{`  ·  ${waiting.length} waiting for your decision`}</Text>}
          </Text>
          {!disk?.overseer && <Text color="warning">This session is not the overseer: /crew-overseer makes it one.</Text>}
          <Box key="acts" flexDirection="column" marginTop={1}>
            {crews.length > 0 && <Button key="writeall" label="✉ Message every lead…" variant="primary" onPress={() => ((briefing = { task: '*', to: 'lead' }), redraw())} />}
            <Button key="newcrew" label="+ Start a crew" variant={crews.length ? undefined : 'primary'} onPress={() => taskFlow($)} />
            <Button key="closeov" label="Close" role="dismiss" dimColor onPress={() => $.ui.close({ id: OVERVIEW })} />
          </Box>
          {writer('*')}
        </Box>

        {heading('h-crews', `⚑ RUNNING CREWS (${crews.length})`, 'claude', crews.length ? undefined : 'No crews at work. Start one above, or ask me to.')}
        {crews.map(card)}

        {both.length > 0 && heading('h-overlaps', `⚠ FILES MORE THAN ONE CREW IS CHANGING (${both.length})`, 'warning', 'Their work will meet when the branches merge: decide the order, and tell the leads.')}
        {both.length > 0 && (
          <Box key="overlaps" flexDirection="column" paddingLeft={2}>
            {both.slice(0, 8).map(o => <Text key={`o-${o.file}`} wrap="truncate-end"><Text color="warning">{o.file}</Text><Text dimColor>{`  ${o.crews.join(', ')}`}</Text></Text>)}
          </Box>
        )}

        {waiting.length > 0 && heading('h-done', `⎇ FINISHED · WAITING FOR YOUR DECISION (${waiting.length})`, 'success', 'These crews have stopped working. What they did is on a branch of its own: merge it, open a pull request, or keep it as it is.')}
        {waiting.length > 0 && (
          <Box key="waiting" flexDirection="column">
            {waiting.map(k => (
              <Box key={`w-${k.id}`} flexDirection="column" borderStyle="round" borderColor="success" paddingX={1} marginTop={1}>
                <Text wrap="truncate-end"><Text bold>{`✓ ${L.taskLabel(k)}`}</Text><Text dimColor>{`  ·  branch ${k.branch}${k.endedAt ? `  ·  finished ${L.ago(t - k.endedAt)}` : ''}`}</Text></Text>
                {k.goal ? <Text dimColor wrap="truncate-end">{`  ${k.goal}`}</Text> : null}
                {(() => {
                  const st = L.statusOf(crewHistory.get(k.id) ?? [])
                  return st ? <Text wrap="truncate-end"><Text bold>{'  Status  '}</Text>{st.text}</Text> : null
                })()}
                <Box key="choices" flexDirection="column" paddingLeft={2}>
                  {(['merge', 'pr', 'keep'] as const).map(choice => (
                    <Button key={`${choice}-${k.id}`} label={choice === 'merge' ? '⤵ Merge it into the main branch' : choice === 'pr' ? '⇪ Open a pull request' : '⎇ Keep the branch as it is'} dimColor={choice === 'keep'}
                      onPress={async () => {
                        await say(await finishBranch($, k, choice))
                        waitingList = await waitingBranches($)
                        await redraw()
                      }} />
                  ))}
                  <Button key={`history-${k.id}`} label="☰ History: what the crew did" dimColor onPress={() => inspect(k.id)} />
                </Box>
              </Box>
            ))}
          </Box>
        )}

        {heading('h-talk', '✉ CONVERSATION WITH THE CREWS', 'claude', talk.length ? undefined : 'Nothing yet. Message every lead above, or ask me to.')}
        {talk.length > 0 && (
          <Box key="talk" flexDirection="column" paddingLeft={2}>
            {talk.map((f, i) => (
              <Text key={`f-${i}-${f.at}`} wrap="truncate-end">
                <Text dimColor>{`${clock(f.at)}  `}</Text>
                {f.up ? <Text color={f.color || undefined} bold>{`${f.from} → you`}</Text> : <Text color="claude" bold>{`you → ${f.to}`}</Text>}
                <Text dimColor>{'  '}</Text>
                <Text bold={f.up && t - f.at < 120_000}>{f.text}</Text>
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.close', { id: BOARD }, async ($, e, next) => {
    forgetBoard($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: BOARD }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>The strategy board needs the terminal or the desktop app.</Text>
    }
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const b = await read($, boardA)
    const cols = Math.max(24, e.props.bodyColumns)
    const picking = b.mode === 'pick'
    // adding to the running task's crew (/crew-add)
    const growing = b.mode === 'crew'
    const view = b.view ?? 'list'
    const set = (patch: Partial<CrewBoard>) => setBoard($, patch)
    const note = b.note ? <Text color="warning" wrap="wrap">{b.note}</Text> : null
    const project = disk?.project ?? 'project'
    // the step on a line of its own, then what the step asks, then a line on how
    const heading = (title: string, sub?: string, step?: number) => (
      <Box key="heading" flexDirection="column" marginBottom={1}>
        {step && picking ? <Text key="step" dimColor>{`Step ${step} of 3`}</Text> : null}
        <Text key="title" bold color="claude" wrap="wrap">{title}</Text>
        {sub ? <Text key="sub" dimColor wrap="wrap">{sub}</Text> : null}
      </Box>
    )
    const stepped = picking ? 3 : undefined
    // every line of the drawing is cut, never wrapped, so the boxes keep their shape at any width
    const picture = (s: S.Strategy, width: number) => (
      <Box key="picture" flexDirection="column" marginTop={1}>
        {S.diagram(s, width).map(line => <Text color="claude" wrap="truncate-end">{line || ' '}</Text>)}
      </Box>
    )
    const duties = (s: S.Strategy) => (
      <Box key="duties" flexDirection="column" marginTop={1}>
        {s.roles.map(r => (
          <Text wrap="wrap">
            <Text bold>{r.name}</Text>
            <Text dimColor>: {r.duty || 'no duty written yet'}</Text>
          </Text>
        ))}
      </Box>
    )
    // options always stack, one per line: side by side they would read as ← → when ↑ ↓ moves between them
    const actions = (key: string, ...buttons: RenderChildren[]) => (
      <Box key={key} flexDirection="column" marginTop={1}>
        {buttons}
      </Box>
    )
    // every step ends the same way: Back to the step before, then Cancel for the whole thing (Close outside a task's start), each on its line
    const nav = (back?: () => unknown, keys = true) => (
      <Box key="nav" flexDirection="column" marginTop={1}>
        {back && <Button key="back" label="← Back" hotkey={keys ? 'b' : undefined} onPress={back} />}
        <Button key="cancel" label={picking || growing ? 'Cancel' : 'Close'} role="dismiss" onPress={() => closeBoard($)} />
      </Box>
    )
    const sessions = (s: S.Strategy) => `${S.sessionsIn(s) + 1} session${S.sessionsIn(s) ? 's' : ''}`

    if (view === 'busy') {
      return (
        <Box flexDirection="column">
          {heading(b.note || 'Drawing the team up…', undefined, b.note === LOOKING ? 1 : pendingStart?.name ? 3 : undefined)}
          <Text color="warning">One moment…</Text>
          {b.note === LOOKING ? nav() : null}
        </Box>
      )
    }

    // ---- the first step of /crew-task: start, resume, join or leave
    if (view === 'menu') {
      const mine = disk?.task
      const joinable = tasks.filter(k => k.id !== mine?.id)
      return (
        <Box flexDirection="column">
          {heading('Crew task', mine
            ? `You are in "${L.gist(mine.name, 40)}". Another crew can work on something else at the same time, with a lead window of its own.`
            : 'Start a task with a crew, resume one from before, join one that is running, or leave yours.')}
          <Box key="choices" flexDirection="column">
            <Button key="start" label={mine || disk?.overseer ? '▶ Start another crew' : '▶ Start a new task'} variant="primary" autoFocus onPress={() => {
              pendingStart = { name: pendingStart?.name ?? '', goal: pendingStart?.goal ?? '' }
              return toNameStep($)
            }} />
            {mine && <Button key="addcrew" label="⊕ Add to this crew: more sessions or new roles" onPress={() => openCrewBoard($, true)} />}
            {pastList.length > 0 && (
              <Button key="resume" label={`↻ Resume a task from before (${pastList.length})`} onPress={() => set({ view: 'resume', note: '' })} />
            )}
            {joinable.length > 0 && (
              <Button key="join" label={`⇢ Join a running task (${joinable.length})`} onPress={async () => {
                await closeBoard($)
                const text = await joinTask($, joinable.sort((p, q) => q.createdAt - p.createdAt)).catch(err => `Could not join: ${String((err as Error)?.message ?? err)}`)
                await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }).catch(() => $.ui.toast(text))
              }} />
            )}
            {waitingList.length > 0 && (
              <Button key="branches" label={`⎇ Crew work waiting to be merged (${waitingList.length})`} onPress={async () => {
                await closeBoard($)
                const text = await decideBranches($).catch(err => `Could not finish it: ${String((err as Error)?.message ?? err)}`)
                await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }).catch(() => $.ui.toast(text, { timeoutMs: 10_000 }))
              }} />
            )}
            {mine && (
              <Button key="leave" label={`⏏ Leave "${L.gist(mine.name, 30)}"`} onPress={async () => {
                const text = await leaveTask($)
                await closeBoard($)
                $.ui.toast(text)
              }} />
            )}
            {mine && <Button key="stopcrew" label="■ Stop the whole crew and close its windows…" onPress={() => set({ view: 'stop', note: '' })} />}
          </Box>
          {note}
          {nav()}
        </Box>
      )
    }

    // ---- resume: the project's tasks that ended, the last worked on first; then one of them, with its crew
    if (view === 'resume' || view === 'resumeone') {
      const now = await $.clock.now()
      const when = (k: L.DiskTask) => L.ago(now - L.lastWorked(k))
      const past = view === 'resumeone' ? pastList[b.index] : undefined
      if (!past) {
        return (
          <Box flexDirection="column">
            {heading('Resume a task', 'Brings back a task that ended: its name, goal, strategy and crew, each member carrying on its own conversation.')}
            <Box key="past" flexDirection="column">
              {pastList.map((k, i) => {
                const crew = L.crewOf(k, all)
                return (
                  <Box key={`past-${k.id}`} flexDirection="column" marginBottom={1}>
                    <Button key={`rs-${k.id}`} plain hotkey={i < 9 ? String(i + 1) : undefined} label={L.taskLabel(k)} autoFocus={i === 0 ? true : undefined}
                      onPress={() => (void summarize($, k), set({ view: 'resumeone', index: i, note: '' }))} />
                    <Text dimColor wrap="wrap">{`   ${[k.goal, crew.length ? `crew of ${crew.length + 1}` : 'the lead alone', k.strategy?.name, when(k)].filter(Boolean).join(' · ')}`}</Text>
                    {(() => {
                      const st = L.statusOf(pastHistory.get(k.id) ?? [])
                      return st ? <Text wrap="truncate-end">{'   '}<Text bold>Status </Text>{st.text}</Text> : null
                    })()}
                  </Box>
                )
              })}
              {pastList.length === 0 && <Text dimColor>No earlier tasks in this project.</Text>}
            </Box>
            {note}
            {nav(() => set({ view: 'menu' }))}
          </Box>
        )
      }
      const crew = L.crewOf(past, all)
      const state = (m: L.TaskMember) => {
        const s = all.find(x => x.id === m.id)
        return !s || !L.isLive(s, now) ? 'opens again, carrying on its conversation' : s.task ? `busy in "${L.gist(s.task.name, 24)}"` : 'window still open: rejoins by itself'
      }
      const go = async (withCrew: boolean, openAs: OpenAs = 'windows') => {
        await set({ view: 'busy', note: `Resuming "${past.name}"…` })
        const text = await resumeTask($, past, withCrew, openAs).catch(err => `Could not resume: ${String((err as Error)?.message ?? err)}`)
        pastList = []
        await closeBoard($)
        await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }).catch(() => $.ui.toast(text, { timeoutMs: 10_000 }))
      }
      const hist = pastHistory.get(past.id) ?? []
      const st = L.statusOf(hist)
      const feats = L.featuresOf(hist)
      const about = summaries.get(past.id) ?? (past.summary && past.summary.at >= (hist[hist.length - 1]?.at ?? 0) ? past.summary : undefined)
      const recent = [...hist].reverse().filter(ev => ev.kind !== 'join' && ev.kind !== 'leave').slice(0, 5)
      const field = (key: string, name: string, body: RenderChildren) => (
        <Box key={key} flexDirection="row">
          <Box width={12} flexShrink={0}><Text bold>{name}</Text></Box>
          <Box flexGrow={1} flexDirection="column">{body}</Box>
        </Box>
      )
      return (
        <Box flexDirection="column">
          {heading(`↻ ${L.taskLabel(past)}`, `Last worked on ${when(past)}${past.strategy ? ` · strategy ${past.strategy.name}` : ''}${past.branch ? ` · branch ${past.branch}` : ''}`)}
          <Box key="brief" flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
            {field('f-about', 'About', typeof about === 'object'
              ? <Text wrap="wrap">{about.text}</Text>
              : about === 'busy' ? <Text color="warning">Reading back what was done…</Text>
              : <Text wrap="wrap">{past.goal || 'No goal was written down.'}</Text>)}
            {typeof about === 'object' && past.goal ? field('f-goal', 'Goal', <Text wrap="wrap" dimColor>{past.goal}</Text>) : null}
            {field('f-status', 'Status', st
              ? <Text wrap="wrap"><Text color={L.saysBlocked(st.text) ? 'error' : undefined}>{st.text}</Text><Text dimColor>{`  (${st.by}, ${L.ago(now - st.at)})`}</Text></Text>
              : <Text dimColor wrap="wrap">{hist.length ? 'No status was recorded.' : 'Nothing was recorded for this task (from before version 0.18).'}</Text>)}
            {feats.length > 0 && field('f-done', 'Done', <Text wrap="wrap">{feats.filter(f => f.status === 'done').map(f => `${f.name} ✓`).join('   ') || 'nothing finished yet'}</Text>)}
            {feats.some(f => f.status === 'building') && field('f-going', 'In progress', <Text wrap="wrap">{feats.filter(f => f.status === 'building').map(f => `${f.name} …`).join('   ')}</Text>)}
            {recent.length > 0 && field('f-recent', 'Lately', (
              <Box flexDirection="column">
                {recent.map((ev, i) => (
                  <Text key={`r-${i}`} wrap="truncate-end"><Text dimColor>{`${L.ago(now - ev.at)}  `}</Text>{`${L.HISTORY_ICON[ev.kind]} ${ev.by}: ${ev.text}`}</Text>
                ))}
              </Box>
            ))}
          </Box>
          {past.strategy ? picture(past.strategy, cols) : null}
          <Box key="crew" flexDirection="column" marginTop={1}>
            <Text bold>Crew</Text>
            <Text wrap="wrap"><Text color="claude">● </Text>You<Text dimColor>{` · lead (was ${past.creatorName})`}</Text></Text>
            {crew.map(m => (
              <Text wrap="wrap"><Text color={m.color}>● </Text>{m.name}<Text dimColor>{` · ${m.role} · ${state(m)}`}</Text></Text>
            ))}
            {crew.length === 0 && <Text dimColor>Nobody else worked on it.</Text>}
          </Box>
          {note}
          {actions('do',
            crew.length > 0 && <Button key="resumetabs" label="▶ Resume the task with the crew in tabs" variant="primary" autoFocus
              onPress={() => viaTabs($, 'resume the task', () => go(true, 'tabs'), () => go(true, 'windows'), () => set({ view: 'resumeone', note: '' }))} />,
            crew.length > 0 && <Button key="resumewindows" label="▶ Resume the task with the crew in windows" variant="primary" onPress={() => go(true, 'windows')} />,
            <Button key="resumealone" label={crew.length ? '▶ Resume the task, just me' : '▶ Resume the task'} variant={crew.length ? undefined : 'primary'}
              autoFocus={crew.length ? undefined : true} onPress={() => go(false)} />,
          )}
          {nav(() => set({ view: 'resume' }))}
        </Box>
      )
    }

    // ---- step 1: what to work on: a few ideas from the project's recent work, or a name of one's own
    if (view === 'name') {
      const list = shownIdeas.length ? shownIdeas : plainIdeas(project)
      const fromProject = shownIdeas.length > 0 && shownIdeas === ideas?.list
      const typing = b.typing === 'task'
      const pick = (idea: Idea) => {
        pendingStart = { name: L.gist(idea.name, 48), goal: idea.goal }
        typed = ''
        // an idea brings its goal along: on to the strategy, and Back reaches the goal to change it
        return set({ view: idea.goal ? 'list' : 'goal', typing: null, note: '' })
      }
      const own = (name: string) => {
        if (!name.trim()) return set({ note: 'Type a name first.' })
        pendingStart = { name: L.gist(name.trim(), 48), goal: '' }
        typed = ''
        return set({ view: 'goal', typing: null, note: '' })
      }
      return (
        <Box flexDirection="column">
          {heading(
            'What should the crew work on?',
            fromProject ? 'Ideas from the project\'s recent work: pick one, or name your own.' : 'Pick one, or name your own.',
            1,
          )}
          <Box key="ideas" flexDirection="column">
            {list.map((idea, k) => (
              <Box key={`idea-row-${k}`} flexDirection="column" marginBottom={idea.goal ? 1 : 0}>
                <Button key={`idea-${k}`} plain hotkey={typing ? undefined : String(k + 1)} label={idea.name} autoFocus={k === 0 && !typing ? true : undefined} onPress={() => pick(idea)} />
                {idea.goal ? <Text dimColor wrap="wrap">{`   ${idea.goal}`}</Text> : null}
              </Box>
            ))}
            <Box key="own" marginTop={list.length ? 0 : 1}>
              {typing ? (
                <Input key="taskname" label="Name: " value={typed} placeholder="what the task is called" submitLabel="next" autoFocus onInput={v => void (typed = v)} onSubmit={v => own(v)} />
              ) : (
                <Button key="typename" plain hotkey="t" label="✎ Type a name of your own…" autoFocus={list.length ? undefined : true} onPress={() => set({ typing: 'task', note: '' })} />
              )}
            </Box>
          </Box>
          {note}
          {typing && actions('steps', <Button key="next-step" label="Next →" variant="primary" onPress={() => own(typed)} />)}
          {nav(typing ? () => set({ typing: null, note: '' }) : hasMenu() ? () => set({ view: 'menu', typing: null }) : undefined, !typing)}
        </Box>
      )
    }

    // ---- step 2: the goal
    if (view === 'goal') {
      const name = pendingStart?.name ?? 'the task'
      const next = (goal: string) => {
        pendingStart = { name, goal: goal.trim() }
        typed = ''
        return set({ view: 'list', note: '' })
      }
      return (
        <Box flexDirection="column">
          {heading(`What is the goal of "${name}"?`, 'Type it and press Enter, or decide later.', 2)}
          <Input key="taskgoal" label="Goal: " value={pendingStart?.goal ?? ''} placeholder="what should the crew achieve?" submitLabel="next" autoFocus onInput={v => void (typed = v)} onSubmit={v => next(v)} />
          <Box key="quick" flexDirection="column" marginTop={1}>
            <Button key="later" label="Decide later" dimColor onPress={() => next('')} />
            <Button key="same" label="Same as the name" dimColor onPress={() => next(name)} />
          </Box>
          {note}
          {actions('steps', <Button key="next-step" label="Next →" variant="primary" onPress={() => next(typed || pendingStart?.goal || '')} />)}
          {nav(() => ((typed = ''), set({ view: 'name' })), false)}
        </Box>
      )
    }

    // ---- a new one: describe it, or start from one and say what to change
    if (view === 'create') {
      const starts = [...boardList, S.BLANK]
      const from = (t: S.Strategy) => {
        chosen = null
        working = { ...structuredClone(t), id: 'new', name: t.id === 'blank' ? 'My strategy' : `My ${t.name}`, builtIn: false }
        changes = []
        return set({ view: 'change', note: '' })
      }
      return (
        <Box flexDirection="column">
          {heading('Create a strategy', 'Describe the team in one sentence and it is drawn for you, or start from one below and say what to change.', stepped)}
          <Input key="describe" label="Team: " placeholder="lead on opus, 2 sonnet implementers, a haiku tester" submitLabel="draw it" autoFocus
            onSubmit={async text => {
              if (!text.trim()) return set({ note: 'Describe the team first.' })
              await set({ view: 'busy', note: 'Drawing the team up…' })
              const parsed = await draftFrom($, text).catch(() => null)
              if ((await read($, boardA)).view !== 'busy') return
              if (!parsed) return set({ view: 'create', note: 'Could not read that as a team: name the roles, how many of each, and their models.' })
              chosen = null
              working = { ...parsed, id: 'new' }
              changes = [L.gist(text, 80)]
              return set({ view: 'changed', note: '' })
            }} />
          <Text dimColor wrap="wrap">e.g. lead on sonnet, 2 opus implementers with an opus implementation advisor, a haiku tester</Text>
          <Box key="starts" flexDirection="column" marginTop={1}>
            <Text dimColor>Or start from one and change it:</Text>
            {starts.slice(0, 12).map(t => (
              <Button key={`from-${t.id}`} plain dimColor label={L.gist(`  ${t.name} · ${sessions(t)} — ${t.description || S.summary(t)}`, cols - 2)} onPress={() => from(t)} />
            ))}
          </Box>
          {note}
          {nav(() => set({ view: 'list', note: '' }), false)}
        </Box>
      )
    }

    // ---- one strategy picked: its drawing, then whether to edit it first
    if (view === 'chosen' && working) {
      const s = working
      return (
        <Box flexDirection="column">
          {heading(s.name, [s.description, sessions(s)].filter(Boolean).join(' · '), stepped)}
          {picture(s, cols)}
          {duties(s)}
          <Box key="ask" marginTop={1}>
            <Text bold>{picking ? (S.sessionsIn(s) > 0 ? 'Start the task, with the crew in tabs or in windows, or edit the strategy first?' : 'Start the task, or edit the strategy first?') : 'What do you want to do with it?'}</Text>
          </Box>
          {note}
          {picking && S.sessionsIn(s) > 0 ? <Text key="how" dimColor wrap="wrap">Tabs: every member opens as a tab in this window. Windows: a window each, tiled on the screen.</Text> : null}
          {picking
            ? actions('do',
                ...(S.sessionsIn(s) > 0
                  ? [
                      <Button key="use" label="▶ Start task with tabs" variant="primary" autoFocus
                        onPress={() => viaTabs($, 'start the task', () => startFromBoard($, chosen ?? s, 'tabs'), () => startFromBoard($, chosen ?? s, 'windows'), () => set({ view: 'chosen', note: '' }))} />,
                      <Button key="usewindows" label="▶ Start task with windows" variant="primary" onPress={() => startFromBoard($, chosen ?? s, 'windows')} />,
                    ]
                  : [<Button key="use" label="▶ Start task" variant="primary" autoFocus onPress={() => startFromBoard($, chosen ?? s)} />]),
                <Button key="edit" label="✎ Edit the strategy first" onPress={() => set({ view: 'change', note: '' })} />,
              )
            : actions('do',
                <Button key="edit" label="✎ Edit it" variant="primary" autoFocus onPress={() => set({ view: 'change', note: '' })} />,
                <Button key="delete" label="Delete" dimColor onPress={() => set({ view: 'delete', note: '' })} />,
              )}
          {nav(() => (letGo(), set({ view: 'list', note: '' })))}
        </Box>
      )
    }

    // ---- say what to change: a model redraws the team
    // ---- adding to the running crew: one more of a role it has, or say who (a new role), or change the roles by hand
    if (view === 'crew' && crewBase) {
      const base = crewBase
      const k = tasks.find(x => x.id === disk?.task?.id)
      const now = await $.clock.now()
      const live = all.filter(x => x.task?.id === k?.id && L.isLive(x, now)).sort((p, q) => Number(q.id === k?.creator) - Number(p.id === k?.creator) || p.name.localeCompare(q.name))
      const more = base.roles.filter(r => r.kind !== 'lead')
      const oneMore = (r: S.Role) => {
        working = S.withOneMore(base, r.id)
        changes = [`one more ${r.name}`]
        return set({ view: 'changed', note: '' })
      }
      return (
        <Box flexDirection="column">
          {heading(`Add to the crew of "${k ? L.taskLabel(k) : 'the task'}"`,
            `${live.length} at work now${more.length ? `, with the strategy "${base.name}"` : ': a single session so far'}. Everyone added opens in a tab or window of its own, with its model, and joins by itself.`)}
          {more.length ? picture(base, cols) : null}
          <Box key="now" flexDirection="column" marginTop={1}>
            <Text bold>At work now</Text>
            {live.map(x => (
              <Text key={`n-${x.id}`} wrap="truncate-end"><Text color={x.color}>{'● '}</Text>{x.id === k?.creator ? `★ ${x.name}` : x.name}<Text dimColor>{` · ${x.task?.role ?? ''} · ${x.model}`}</Text></Text>
            ))}
          </Box>
          <Box key="ask" marginTop={1}><Text bold>Who should join?</Text></Box>
          {note}
          {actions('do',
            ...more.map((r, i) => (
              <Button key={`more-${r.id}`} label={`+ One more ${r.name} (${S.modelText(r)})`} variant={i === 0 ? 'primary' : undefined} autoFocus={i === 0 ? true : undefined} onPress={() => oneMore(r)} />
            )),
            <Button key="describe" label="✎ Describe who to add (a new role, several people)…" variant={more.length ? undefined : 'primary'} autoFocus={more.length ? undefined : true}
              onPress={() => set({ view: 'change', note: '' })} />,
            <Button key="handedit" label="✎ Change the roles by hand" dimColor onPress={() => editInBoard($)} />,
          )}
          {nav()}
        </Box>
      )
    }

    if (view === 'change' && working) {
      const s = working
      return (
        <Box flexDirection="column">
          {growing
            ? heading('Who should join the crew?', 'Say it in your own words, and the crew is redrawn with them: "a UI expert on opus who reviews the frontend", "two more implementers", "a haiku tester".')
            : heading(`Edit "${s.name}"`, 'Say in your own words what to change, and the team is redrawn.', stepped)}
          {picture(s, cols)}
          {changes.length ? <Text dimColor wrap="wrap">{`Changed so far: ${changes.join('; ')}`}</Text> : null}
          <Box key="ask" flexDirection="column" marginTop={1}>
            <Input key="change" label={growing ? 'Add: ' : 'Change: '} placeholder={growing ? 'e.g. a UI expert on opus who reviews the frontend' : 'e.g. add a Fable advisor to the lead and two extra UI testers'} submitLabel={growing ? 'add them' : 'change it'} autoFocus
              onSubmit={v => changeInWords($, v)} />
          </Box>
          {note}
          {actions('do', <Button key="handedit" label="Change the roles by hand instead" dimColor onPress={() => editInBoard($)} />)}
          {nav(() => set({ view: changes.length ? 'changed' : growing ? 'crew' : chosen ? 'chosen' : 'create', note: '' }), false)}
        </Box>
      )
    }

    // ---- the running crew, changed: who joins, then open them as tabs or windows
    if (view === 'changed' && working && growing) {
      const s = working
      const adds = S.added(crewBase ?? s, s)
      const go = async (openAs: OpenAs) => {
        await set({ view: 'busy', note: `Opening the ${openAs} for the new crew members…` })
        const text = await growCrew($, s, openAs).catch(err => `Could not add them: ${String((err as Error)?.message ?? err)}`)
        letGo()
        crewBase = null
        await closeBoard($)
        await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }).catch(() => $.ui.toast(text, { timeoutMs: 10_000 }))
      }
      return (
        <Box flexDirection="column">
          {heading('The crew, with the change', changes.length ? `Asked: ${changes.join('; ')}` : undefined)}
          {picture(s, cols)}
          <Box key="joins" flexDirection="column" marginTop={1}>
            {adds.length ? <Text bold>Joining now</Text> : <Text color="warning" wrap="wrap">This change adds no one: fewer sessions close none (members leave with /crew-task → Leave). Change more, or go back.</Text>}
            {adds.map(a => (
              <Text key={`j-${a.role.id}`} wrap="wrap"><Text color="success">{`+ ${a.add} × ${a.role.name}`}</Text><Text dimColor>{` · ${S.modelText(a.role)}${a.role.duty ? ` · ${a.role.duty}` : ''}`}</Text></Text>
            ))}
          </Box>
          {adds.length ? <Text key="how" dimColor wrap="wrap">Tabs: each opens as a tab in the lead's window. Windows: a window each, tiled on the screen.</Text> : null}
          {note}
          {actions('do',
            adds.length > 0 && <Button key="growtabs" label="▶ Add them in tabs" variant="primary" autoFocus
              onPress={() => viaTabs($, 'add them', () => go('tabs'), () => go('windows'), () => set({ view: 'changed', note: '' }))} />,
            adds.length > 0 && <Button key="growwindows" label="▶ Add them in windows" variant="primary" onPress={() => go('windows')} />,
            <Button key="more" label="✎ Change more" autoFocus={adds.length ? undefined : true} onPress={() => set({ view: 'change', note: '' })} />,
          )}
          {nav(() => ((working = crewBase ? structuredClone(crewBase) : null), (changes = []), set({ view: 'crew', note: '' })), false)}
        </Box>
      )
    }

    // ---- the changed team: right, or change more
    if (view === 'changed' && working) {
      const s = working
      return (
        <Box flexDirection="column">
          {heading(chosen ? `Updated "${s.name}"` : `New strategy: ${s.name}`, changes.length ? `Changes: ${changes.join('; ')}` : s.description || undefined, stepped)}
          {picture(s, cols)}
          {duties(s)}
          <Box key="ask" marginTop={1}>
            <Text bold>Does this look right?</Text>
          </Box>
          {note}
          {actions('do',
            <Button key="ok" label="✓ Looks good" variant="primary" autoFocus onPress={() => set({ view: 'confirm', typing: null, note: '' })} />,
            <Button key="more" label="✎ Edit more" onPress={() => set({ view: 'change', note: '' })} />,
          )}
          {nav(() => {
            // Back drops the changes: the strategy as it was, or a new one started again
            working = chosen ? structuredClone(chosen) : null
            changes = []
            return set({ view: chosen ? 'chosen' : 'create', note: '' })
          }, false)}
        </Box>
      )
    }

    // ---- confirmed: save it over the old one, as a new one, or use it only this time
    if (view === 'confirm' && working) {
      const s = working
      const naming = b.typing === 'name'
      const suggested = chosen && s.name === chosen.name ? `${chosen.builtIn ? 'My ' : ''}${s.name}${chosen.builtIn ? '' : ' 2'}` : s.name
      const saveNew = async (name: string) => {
        if (!name.trim()) return set({ note: 'Give it a name first.' })
        return afterSave($, await saveStrategy($, { ...s, name: L.gist(name.trim(), 60) }), true)
      }
      return (
        <Box flexDirection="column">
          {heading(`${s.name}: ready`, picking ? 'Save it for next time, or use it only for this task.' : 'Save it over the one it came from, or as a new strategy.', stepped)}
          {picture(s, cols)}
          {naming ? <Input key="savename" label="Name of the new strategy: " value={suggested} submitLabel="save" autoFocus onSubmit={saveNew} /> : null}
          {note}
          {naming
            ? actions('do', <Button key="savenamed" label={picking ? 'Save it and go on' : 'Save it'} variant="primary" onPress={() => saveNew(typed || suggested)} />)
            : actions('do',
                chosen && <Button key="saveupdated" label="Save updated strategy" variant="primary" autoFocus onPress={async () => afterSave($, await saveStrategy($, s, chosen?.id), true)} />,
                <Button key="savenew" label="Save as new strategy" variant={chosen ? undefined : 'primary'} autoFocus={chosen ? undefined : true} onPress={() => ((typed = ''), set({ typing: 'name', note: '' }))} />,
                picking && <Button key="once" label="Use it only this time" onPress={() => toLaunch($, S.clean({ ...s, builtIn: false }))} />,
                <Button key="goback" label="← Go back" onPress={() => set({ view: 'changed', note: '' })} />,
              )}
          {nav(naming ? () => set({ typing: null, note: '' }) : undefined, false)}
        </Box>
      )
    }

    // ---- by hand: pick a role, then pick its model, effort, sessions and whom it advises
    if (view === 'edit' && editing) {
      const ed = editing
      const r = ed.roles.find(x => x.id === b.role) ?? (ed.roles[0] as S.Role)
      const redraw = () => set({})
      const chip = (key: string, label: string, isChosen: boolean, press: () => unknown) => (
        <Button key={key} label={label} variant={isChosen ? 'primary' : undefined} dimColor={!isChosen} onPress={press} />
      )
      const field = (key: string, name: string, ...children: RenderChildren[]) => (
        <Box key={key} flexDirection="row" marginTop={1}>
          <Box width={10} flexShrink={0}><Text dimColor>{name}</Text></Box>
          <Box flexDirection="column" flexGrow={1}>{children}</Box>
        </Box>
      )
      const kind = r.kind === 'lead' ? 'the lead: this session' : r.kind === 'advisor' ? 'an advisor the others consult' : 'a worker'
      const roles = (
        <Box key="roles" flexDirection="column" marginBottom={1}>
          <Text dimColor>Pick a role to change it:</Text>
          {ed.roles.map(x => (
            <Button key={`r-${x.id}`} plain label={`${x.id === r.id ? '▸' : ' '} ${S.roleLine(ed, x)}`} dimColor={x.id !== r.id}
              onPress={() => set({ role: x.id, typing: null })} />
          ))}
          <Button key="addworker" plain label="  + Add a worker" onPress={() => { const n = addRole(ed, 'worker'); return set({ role: n.id, typing: 'role' }) }} />
          <Button key="addadvisor" plain label="  + Add an advisor" onPress={() => { const n = addRole(ed, 'advisor'); return set({ role: n.id, typing: 'role' }) }} />
        </Box>
      )
      const form = (
        <Box key="form" flexDirection="column" flexGrow={1} borderStyle="round" borderColor="claude" paddingX={1}>
          <Text wrap="wrap"><Text bold>{r.name}</Text><Text dimColor> · {kind}</Text></Text>
          {b.typing === 'role' ? (
            <Input key={`rolename-${r.id}`} label="Name: " value={r.name} submitLabel="set" autoFocus
              onSubmit={v => ((r.name = L.gist(v.trim() || r.name, 32)), set({ typing: null }))} />
          ) : null}
          {field('f-model', 'Model', ...S.TIERS.map(t => chip(`model-${t}`, t === 'inherit' ? 'same as lead' : t, r.model === t, () => ((r.model = t), redraw()))))}
          {field('f-effort', 'Effort', ...S.EFFORTS.map(t => chip(`effort-${t || 'default'}`, t || 'default', r.effort === t, () => ((r.effort = t), redraw()))))}
          {r.kind !== 'lead' && field('f-count', 'Sessions',
            <Text bold>{r.count}</Text>,
            <Button key="more" label="+ One more" dimColor={r.count >= 6} onPress={() => ((r.count = Math.min(6, r.count + 1)), redraw())} />,
            <Button key="less" label="− One fewer" dimColor={r.count <= 1} onPress={() => ((r.count = Math.max(1, r.count - 1)), redraw())} />,
          )}
          {r.kind === 'advisor' && field('f-links', 'Advises', ...ed.roles.filter(x => x.id !== r.id).map(x =>
            chip(`link-${x.id}`, x.name, r.links.includes(x.id), () => {
              r.links = r.links.includes(x.id) ? r.links.filter(l => l !== x.id) : [...r.links, x.id]
              return redraw()
            })))}
          {b.typing === 'duty'
            ? field('f-duty', 'Does', <Input key={`duty-${r.id}`} value={r.duty} submitLabel="set" autoFocus onSubmit={v => ((r.duty = L.gist(v, 300)), set({ typing: null }))} />)
            : field('f-duty', 'Does', <Text wrap="wrap">{r.duty || 'nothing written yet'} </Text>, <Button key="duty" label="Change" dimColor onPress={() => set({ typing: 'duty' })} />)}
          <Box key="roleacts" flexDirection="column" marginTop={1}>
            <Button key="rename" label="Rename role" dimColor onPress={() => set({ typing: 'role' })} />
            {r.kind !== 'lead' && (
              <Button key="remove" label="Remove role" dimColor onPress={() => {
                ed.roles = ed.roles.filter(x => x !== r).map(x => ({ ...x, links: x.links.filter(l => l !== r.id) }))
                return set({ role: ed.roles[0]?.id ?? null, typing: null })
              }} />
            )}
          </Box>
        </Box>
      )
      const done = () => {
        working = { ...S.clean(ed), id: ed.id, builtIn: ed.builtIn }
        changes = [...changes, 'changed by hand']
        editing = null
        return set({ view: 'changed', typing: null, note: '' })
      }
      return (
        <Box flexDirection="column">
          {heading(`✎ ${ed.name} · ${sessions(ed)}`, 'Pick a role and change it; Done shows the team.', stepped)}
          {b.typing === 'name' ? (
            <Input key="stratname" label="Strategy name: " value={ed.name} submitLabel="set" autoFocus onSubmit={v => ((ed.name = L.gist(v.trim() || ed.name, 60)), set({ typing: null }))} />
          ) : null}
          <Box key="body" flexDirection="column">
            {roles}
            {form}
          </Box>
          {picture(ed, cols)}
          {note}
          {actions('do',
            <Button key="done" label="Done" variant="primary" onPress={done} />,
            <Button key="renamestrat" label="Rename strategy" dimColor onPress={() => set({ typing: 'name' })} />,
          )}
          {nav(() => ((editing = null), set({ view: 'change', typing: null })), false)}
        </Box>
      )
    }

    // ---- tabs chosen, but Terminal may not press ⌘T yet: what to allow, or windows instead
    if (view === 'tabs' && tabsGate) {
      const g = tabsGate
      const terminal = termInfo.term === 'Apple_Terminal'
      const cap = g.what.charAt(0).toUpperCase() + g.what.slice(1)
      return (
        <Box flexDirection="column">
          {heading(terminal ? 'Tabs need one permission first' : 'Tabs work in Terminal.app only', terminal
            ? 'Terminal opens a tab when it is sent ⌘T, and macOS lets it send keys only when Terminal is allowed under System Settings → Privacy & Security → Accessibility. Turn Terminal on in that list (+ adds it when it is not there), then come back here.'
            : `This session runs in ${termInfo.term || 'another terminal'}; crewser opens tabs in Terminal.app alone.`)}
          {note}
          {actions('do',
            terminal && <Button key="tabsettings" label="⚙ Open the Accessibility settings" variant="primary" autoFocus
              onPress={() => $.process.run(['open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], { timeoutMs: 5000 }).catch(() => undefined)} />,
            terminal && <Button key="tabsretry" label={`↻ I allowed it: ${g.what} with tabs`}
              onPress={async () => ((await tabsAllowed($)) ? ((tabsGate = null), g.go()) : set({ note: 'Terminal is not allowed yet: turn it on in the Accessibility list, then try again.' }))} />,
            <Button key="tabswindows" label={`▶ ${cap} with windows instead`} autoFocus={terminal ? undefined : true} onPress={() => ((tabsGate = null), g.windows())} />,
          )}
          {nav(() => ((tabsGate = null), g.back()))}
        </Box>
      )
    }

    // ---- stopping the crew this session is in: every session quits and its windows close
    if (view === 'stop') {
      const mine = disk?.task
      const k = mine ? tasks.find(x => x.id === mine.id) : undefined
      if (!mine) return (
        <Box flexDirection="column">
          {heading('Not in a crew task', 'Only a session in a crew can stop it. The overseer stops any crew from its Overview.')}
          {nav()}
        </Box>
      )
      const n = all.filter(s => s.task?.id === mine.id && !s.ended).length
      return (
        <Box flexDirection="column">
          {heading(`Stop "${mine.name}" now?`,
            `Every session of the crew (${n}) quits at once and its Terminal windows close, this one too. A step half done stops where it is; what is saved stays${k?.branch ? `, and its branch ${k.branch} waits for your decision under /crew-task` : ''}. /crew-task → Resume brings the crew back later.`)}
          {note}
          {actions('do',
            <Button key="stopyes" label="■ Yes, stop the crew and close its windows" onPress={async () => {
              const text = await stopCrew($, mine.id, disk?.name ?? 'a member')
              await closeBoard($)
              $.ui.toast(text, { timeoutMs: 8000 })
            }} />,
            <Button key="stopno" label="Keep it running" variant="primary" autoFocus onPress={() => (b.mode === 'pick' ? set({ view: 'menu', note: '' }) : closeBoard($))} />,
          )}
        </Box>
      )
    }

    // ---- the last step of a start: the crew in tabs or in windows
    if (view === 'launch' && launching) {
      const s = launching
      return (
        <Box flexDirection="column">
          {heading(`Start "${pendingStart?.name || 'the task'}" with ${s.name}`, `${sessions(s)}. Tabs: every member opens as a tab in this window. Windows: a window each, tiled on the screen.`, stepped)}
          {picture(s, cols)}
          {note}
          {actions('do',
            <Button key="launchtabs" label="▶ Start task with tabs" variant="primary" autoFocus
              onPress={() => viaTabs($, 'start the task', () => startFromBoard($, s, 'tabs'), () => startFromBoard($, s, 'windows'), () => set({ view: 'launch', note: '' }))} />,
            <Button key="launchwindows" label="▶ Start task with windows" variant="primary" onPress={() => startFromBoard($, s, 'windows')} />,
          )}
          {nav(() => ((launching = null), set({ view: 'list', note: '' })))}
        </Box>
      )
    }

    if (view === 'delete' && working) {
      const s = working
      return (
        <Box flexDirection="column">
          {heading(`Delete "${s.name}" for good?`)}
          {picture(s, cols)}
          {actions('do',
            <Button key="yes" label="Yes, delete it" onPress={async () => {
              await deleteStrategy($, s.id)
              letGo()
              boardList = await loadStrategies($)
              await set({ view: 'list', index: Math.max(0, b.index - 1), note: '' })
              $.ui.toast(`Deleted "${s.name}"`)
            }} />,
            <Button key="no" label="No, keep it" variant="primary" autoFocus onPress={() => set({ view: 'chosen' })} />,
          )}
          {nav(() => set({ view: 'chosen' }))}
        </Box>
      )
    }

    // ---- step 3: the strategies listed on the left, the one in focus drawn on the right; ↑ ↓ or a click
    const items = boardList
    const i = Math.max(0, Math.min(items.length - 1, b.index))
    const focusedOn = b.hover ?? null
    const side = cols >= 96
    const listW = side ? Math.min(40, Math.max(30, Math.floor(cols * 0.28))) : cols
    const room = side ? cols - listW - 2 - 4 : cols - 4
    const panel = (key: string, ...children: RenderChildren[]) => (
      <Box key={key} flexDirection="column" flexGrow={1} borderStyle="round" borderColor="claude" paddingX={1}>
        {children}
      </Box>
    )
    const s = items[i]
    const preview =
      focusedOn === 'none'
        ? panel('preview',
            <Text bold>No strategy: just this session</Text>,
            <Text dimColor wrap="wrap">Only this session works on the task, and no other windows open. You can still add members later with /crew-add.</Text>)
        : focusedOn === 'new'
          ? panel('preview',
              <Text bold>Create a new strategy</Text>,
              <Text dimColor wrap="wrap">Describe the team in one sentence ("lead on opus, two sonnet implementers and a haiku tester") and it is drawn for you, or start from one of these and say what to change.</Text>)
          : s
            ? panel('preview',
                <Text wrap="wrap"><Text bold>{s.name}</Text><Text dimColor>{` · ${sessions(s)}${s.builtIn ? ' · template' : ''}`}</Text></Text>,
                s.description ? <Text dimColor wrap="wrap">{s.description}</Text> : null,
                picture(s, room),
                duties(s))
            : panel('preview', <Text dimColor>No strategies yet: create one{picking ? ', or start without one' : ''}.</Text>)
    const row = (x: S.Strategy, k: number) => {
      const marked = k === i && !focusedOn
      return (
        <Button key={`pick-${x.id}`} plain autoFocus={k === i ? true : undefined} onPress={() => chooseInBoard($, x)}>
          {`${marked ? '▸' : ' '} ${L.gist(x.name, Math.max(8, listW - 16))}`}
          <Text dimColor>{` · ${sessions(x)}`}</Text>
        </Button>
      )
    }
    const own = items.filter(x => !x.builtIn)
    const list = (
      <Box key="list" flexDirection="column" width={side ? listW : undefined} flexShrink={0} marginRight={side ? 2 : 0} marginBottom={side ? 0 : 1}>
        <Text bold>{picking ? 'Pick a strategy to use or modify:' : 'Pick a strategy to see, change or delete:'}</Text>
        <Box key="own" flexDirection="column" marginTop={1}>
          <Text dimColor>Saved</Text>
          {own.map(x => row(x, items.indexOf(x)))}
          {own.length === 0 && <Text dimColor>  none yet</Text>}
        </Box>
        {items.length > own.length && (
          <Box key="templates" flexDirection="column" marginTop={1}>
            <Text dimColor>Templates</Text>
            {items.filter(x => x.builtIn).map(x => row(x, items.indexOf(x)))}
          </Box>
        )}
        <Box key="other" flexDirection="column" marginTop={1}>
          <Button key="new" plain autoFocus={items.length ? undefined : true} label={`${focusedOn === 'new' ? '▸' : ' '} + Create a new strategy`}
            onPress={() => (letGo(), set({ view: 'create', hover: null, note: '' }))} />
          {picking && (
            <Button key="none" plain label={`${focusedOn === 'none' ? '▸' : ' '} – No strategy: just this session`} onPress={() => startFromBoard($, null)} />
          )}
        </Box>
      </Box>
    )
    return (
      <Box flexDirection="column">
        {heading(
          picking ? 'Pick a strategy' : 'Strategies',
          picking
            ? `How the crew works on "${pendingStart?.name || 'the task'}": every session in a strategy gets its own Terminal window, role and model.` +
              (launchPlan().worktree ? ' Another crew is at work in this folder, so this one gets its own git worktree and branch, and a lead window of its own.'
                : !launchPlan().here ? ' It gets a lead window of its own.' : '')
            : `Saved in ${strategiesDir()}.`,
          stepped,
        )}
        <Box key="body" flexDirection={side ? 'row' : 'column'}>
          {list}
          {preview}
        </Box>
        {note}
        {nav(picking ? () => set({ view: 'goal' }) : undefined)}
      </Box>
    )
  })

  /** The teammate picked in the /crew pane: its Go and Ping open under it. */
  let crewPicked: string | null = null

  on('command.run', { command: 'crew' }, async $ => {
    await tick($)
    await $.ui.open({ id: PANE, title: 'Crew', focus: true, closeOnEscape: true })
    return { text: 'Crew pane opened.' }
  })

  // ---- drawing

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, peersA)
    const att = await read($, attentionA)
    const me = await read($, meA)
    const nameWidth = Math.min(30, Math.floor(e.props.bodyColumns * 0.3))
    return (
      <Box flexDirection="column">
        {att && (
          <Box>
            <Text color={att.fromColor} bold>
              👀 {att.fromName}: {att.reason}{' '}
            </Text>
            {!seesFocus(me) && <Button key="seen" label="Seen" hotkey="s" onPress={() => ack($)} />}
          </Box>
        )}
        {list.map((s, i) => {
          const line = (
            <Box key="line" flexDirection="row">
              <Text color={s.color}>{s.isMe ? '◉ ' : crewPicked === s.id ? '▸ ' : '● '}</Text>
              <Box width={nameWidth}>
                <Text color={s.color} bold={s.isMe} wrap="truncate-end">
                  {s.name}
                </Text>
              </Box>
              <Box width={9}>
                <Text color={s.status === 'working' ? 'warning' : 'subtle'}>{s.status}</Text>
              </Box>
              <Box flexGrow={1}>
                <Text dimColor wrap="truncate-end">
                  {s.project}
                  {s.task ? ` ⚑${s.task}` : ''} · {s.activity}
                </Text>
              </Box>
            </Box>
          )
          // a teammate is one line to pick; its actions open under it, one per line
          return (
            <Box key={`row-${s.id}`} flexDirection="column">
              {s.isMe ? line : (
                <Button key={`pick-${s.id}`} plain hotkey={i < 10 ? String(i) : undefined} onPress={() => ((crewPicked = crewPicked === s.id ? null : s.id), update($, peersA, x => [...x]))}>
                  {line}
                </Button>
              )}
              {crewPicked === s.id && !s.isMe && (
                <Box key="acts" flexDirection="column" paddingLeft={4}>
                  <Button key={`go-${s.id}`} label="Go to its window" autoFocus onPress={() => goTo($, s.id)} />
                  <Button key={`ping-${s.id}`} label="Ping it" onPress={() => pingFromPane($, s.id)} />
                </Box>
              )}
            </Box>
          )
        })}
        {list.length === 0 && <Text dimColor>Not in a crew task. /crew-task starts or joins one.</Text>}
        {list.length === 1 && <Text dimColor>No teammates yet: add some below, or other sessions join with /crew-task.</Text>}
        {list.length > 0 && (
          <Box key="grow" flexDirection="column" marginTop={1}>
            <Button key="addcrew" label="⊕ Add to the crew: more sessions or new roles…" onPress={() => openCrewBoard($)} />
            <Button key="stopcrew" label="■ Stop the whole crew and close its windows…" dimColor onPress={() => openBoard($, 'manage', { view: 'stop' })} />
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const att = await read($, attentionA)
    const above = opt.showBand && opt.barsPosition === 'above'
    if (!att && !above) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const pulse = await read($, pulseA)
    const me = await read($, meA)
    const row = above ? await barsRow($, e, e.props.bodyColumns) : null
    if (!att && !row) return next(e)
    return (
      <Box flexDirection="column">
        {att && (
          <Box key="att" flexDirection="row">
            <Text backgroundColor={pulse % 2 ? att.fromColor : undefined} color={pulse % 2 ? 'black' : att.fromColor} bold>
              {' 👀 EYES HERE '}
            </Text>
            <Text color={att.fromColor}>
              {' '}
              {att.fromName}: {att.reason}{' '}
            </Text>
            {!seesFocus(me) && <Button key="seen" label="Seen" hotkey="s" onPress={() => ack($)} />}
          </Box>
        )}
        {row}
      </Box>
    )
  })

  // the bars sit under the prompt, on the hint line's row, with the hint kept beneath them
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!opt.showBand || opt.barsPosition !== 'below') return next(e)
    const row = await barsRow($, e, e.viewport?.columns ?? 100)
    if (!row) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {row}
        {e.props.hint ? <Text dimColor wrap="truncate-end">{e.props.hint}</Text> : null}
      </Box>
    )
  })

  registerTown(on, o)
}

// ==== the town: the crew task as a pixel-art town

const TOWN_PANE = 'crew-town'
const STALE_MS = 25_000
const selectedA = atom({ plugin: 'crewser', key: 'selected' } as const, null)

type Member = CrewSession & { beat: number; ended: boolean; userAt?: number; idleSince?: number; town?: string; root?: string; project?: string }

let fps = 10
let height = 34
let boredMs = 120_000
let dir = ''
let demo = false
let seq = 0
let world = new World()
/** The town's zoom, kept across opens: the overview to start, the close-up the other step. */
let zoomAt = 0
let frame: Timer | null = null
let lastFrame = 0
let lastSync = 0
let syncing = false

function demoCrew(now: number): CrewSession[] {
  const phase = Math.floor(now / 12_000) % 4
  const task = { id: 'demo-task', name: 'checkout-revamp', role: 'Lead', lead: 'Mads' }
  const base = { project: 'shop', startedAt: 0, five: 34, week: 18, attention: false, agents: [], posts: [], features: [], detail: '', tool: '', userAt: now - 60_000, idleSince: now - 60_000 }
  const t0 = now - (now % 48_000)
  return [
    { ...base, id: 'd1', name: 'Mads', color: '#e5484d', status: phase === 1 ? 'working' : 'idle', tool: 'Edit', detail: 'editing cart.ts',
      lastPrompt: 'split the checkout into steps', task,
      features: [{ id: 'f1', name: 'Cart', status: phase === 3 ? 'building' : 'done', at: t0, kind: 'shop' }, { id: 'f2', name: 'Payments', status: phase > 1 ? 'done' : 'building', at: t0, kind: 'harbor' }],
      posts: [{ at: now - (now % 15_000), to: 'all', text: 'cart API is merged, payments next' }] },
    { ...base, id: 'd2', name: 'Reviewer #1', color: '#39c5cf', status: phase === 2 ? 'working' : 'idle', tool: 'Read', detail: 'reading payments.ts',
      lastPrompt: 'review the payment flow', task: { ...task, role: 'Reviewer' } },
    { ...base, id: 'd3', name: 'Implementer #1', color: '#3fb950', status: 'working', tool: phase % 2 ? 'Bash' : 'Edit', detail: phase % 2 ? 'running npm test' : 'editing receipt.tsx',
      lastPrompt: 'build the receipt page', task: { ...task, role: 'Implementer' },
      features: [{ id: 'f3', name: 'Receipts', status: 'building', at: t0 - 30_000, kind: 'townhouse' }],
      agents: [{ id: 'p1', kind: 'Explore', desc: 'find the PDF lib', at: 0 }, ...(phase > 1 ? [{ id: 'p2', kind: 'general-purpose', desc: 'write tests', at: 0 }] : [])] },
    { ...base, id: 'd4', name: 'Tester #1', color: '#ff8700', status: phase === 3 ? 'working' : 'idle', tool: 'Bash', detail: 'running playwright',
      lastPrompt: 'e2e tests for checkout', task: { ...task, role: 'Tester' }, attention: phase === 2,
      features: [{ id: 'f4', name: 'Order fields', status: phase === 0 ? 'building' : 'done', at: t0, kind: 'field', parent: 'Orders', crop: 'corn' }] },
    // a second crew at the same time, in its own worktree, at its own camp
    { ...base, id: 'd5', name: 'Lead · Search', color: '#4f7cff', status: phase === 0 ? 'working' : 'idle', tool: 'TodoWrite', detail: 'planning the search',
      lastPrompt: 'plan the product search', task: { id: 'demo-search', name: 'product-search', role: 'Lead', lead: 'Lead · Search' }, startedAt: 1,
      features: [{ id: 'f5', name: 'Search', status: phase < 2 ? 'building' : 'done', at: t0 - 20_000, kind: 'library' }] },
    { ...base, id: 'd6', name: 'Implementer #2', color: '#c061cb', status: phase === 1 ? 'idle' : 'working', tool: 'Edit', detail: 'editing search.ts',
      lastPrompt: 'index the products', task: { id: 'demo-search', name: 'product-search', role: 'Implementer', lead: 'Lead · Search' }, startedAt: 1 },
    // and the overseer above both leads, at the castle gate
    { ...base, id: 'd7', name: 'Overseer', color: '#e3b341', status: phase === 3 ? 'working' : 'idle', tool: 'mcp__crewser__crews', detail: 'looking over the crews',
      lastPrompt: 'search first, then the checkout', task: null, overseer: true },
  ]
}

/**
 * What earlier demo tasks left: a farm with its fields, a harbor and its dock, a smithy, a statue, houses; and every
 * ninety seconds a Coupons feature that goes up, stands a while, and is dropped, so it burns down.
 */
function demoTown(now: number): TownBuilding[] {
  const cycle = now % 90_000
  const start = now - cycle
  const coupons: TownBuilding =
    cycle < 25_000 ? { name: 'Coupons', level: 0, status: 'building', at: start - 120_000, color: '#ff8700', by: 'Tester #1', kind: 'house' }
    : cycle < 45_000 ? { name: 'Coupons', level: 1, status: 'done', at: start + 25_000, color: '#ff8700', by: 'Tester #1', kind: 'house' }
    : { name: 'Coupons', level: 1, status: 'removed', at: start + 45_000, color: '#ff8700', by: 'Mads', kind: 'house' }
  const b = (name: string, level: number, color: string, by: string, kind: string, extra: Partial<TownBuilding> = {}): TownBuilding =>
    ({ name, level, status: 'done', at: now - 6e6, color, by, kind, ...extra })
  return [
    b('Login', 3, '#9b7fe0', 'Mads', 'tower'),
    b('Search', 2, '#39c5cf', 'Reviewer #1', 'library'),
    b('Orders', 1, '#3fb950', 'Implementer #1', 'farm'),
    b('Order list', 1, '#3fb950', 'Implementer #1', 'field', { parent: 'Orders', crop: 'wheat' }),
    b('Order history', 2, '#3fb950', 'Implementer #1', 'field', { parent: 'Orders', crop: 'pumpkin' }),
    b('Stripe', 1, '#4f7cff', 'Mads', 'dock', { parent: 'Payments' }),
    b('Refactor core', 2, '#ff8700', 'Tester #1', 'blacksmith'),
    b('v1 launch', 1, '#e3b341', 'Mads', 'statue'),
    b('Email alerts', 1, '#ff5faf', 'Reviewer #1', 'lighthouse'),
    b('Wishlist', 1, '#3fb950', 'Implementer #1', 'house'),
    { name: 'Cart', level: 1, status: Math.floor(now / 12_000) % 4 === 3 ? 'building' : 'done', at: now - (now % 48_000), color: '#e5484d', by: 'Mads', kind: 'shop' },
    coupons,
  ]
}

async function members($: EngineInterface): Promise<Member[]> {
  if (demo) return demoCrew(await $.clock.now()) as Member[]
  const entries = await $.fs.list(dir).catch(() => [])
  const now = await $.clock.now()
  const rows = await Promise.all(
    entries
      .filter(f => f.kind === 'file' && f.name.endsWith('.json'))
      .map(async f => {
        try {
          return JSON.parse(await $.fs.read(`${dir}/${f.name}`)) as Member
        } catch {
          return null
        }
      }),
  )
  return rows.filter((s): s is Member => s !== null && !s.ended && (!!s.task || !!s.overseer) && now - s.beat < STALE_MS)
}

/** The crew as the Client draws it; bored once every member idles and the person has been away a while. */
async function snapshot($: EngineInterface): Promise<Snapshot> {
  const now = await $.clock.now()
  const me = demo ? 'd1' : await $.session.id().catch(() => undefined)
  const all = await members($)
  // the town is a project's: every crew at work in it (each in the main checkout or a worktree of it) and its overseer.
  // Mine when I am in a crew (its lead's project), else this session's project, so the buildings are there between tasks too
  const own = all.find(s => s.id === me)
  const leadOfMine = own?.task ? all.find(s => s.task?.id === own.task?.id && s.task?.role === 'Lead') : undefined
  const folder = demo ? '' : (leadOfMine?.town ?? own?.town ?? disk?.town ?? '')
  const crew = demo || !folder ? all : all.filter(s => s.town === folder)
  const lead = leadOfMine ?? crew.find(s => s.task?.role === 'Lead')
  const project = leadOfMine?.project ?? disk?.project ?? lead?.project
  const lastHuman = Math.max(0, ...crew.map(s => s.userAt ?? 0), ...crew.map(s => s.idleSince ?? 0))
  const bored = crew.length > 0 && crew.every(s => s.status === 'idle') && now - lastHuman > (demo ? 20_000 : boredMs)
  seq += 1
  const town = demo ? demoTown(now) : folder ? (await loadTown($, folder, project)).buildings : []
  townFolder = demo ? '' : folder
  // a building two people changed, merged since the last look: shown off with a little celebration
  const merged = [...mergedNow]
  mergedNow.clear()
  return { sessions: crew, now, me, bored, seq, town, merged, project: demo ? undefined : project }
}

/** The folder of the town the view shows (none for the demo). */
let townFolder = ''

async function sync($: EngineInterface) {
  if (syncing) return
  syncing = true
  try {
    world.sync(await snapshot($))
    // new buildings keep the spot the view found for them
    const spots = world.takePlacements()
    if (townFolder && spots.length) await keepPlacements($, townFolder, spots).catch(err => note($, 'town', err))
  } finally {
    syncing = false
  }
}

async function townPaint($: EngineInterface) {
  const { deny } = await $.ui.blit({ requestId: TOWN_PANE, key: 'map', cells: world.render(), columns: world.cols, rows: world.rows })
  if (deny) stop()
}

async function tickFrame($: EngineInterface) {
  const now = await $.clock.now()
  if (now - lastSync > 2000) {
    lastSync = now
    if (!(await $.ui.panes()).some(p => p.id === TOWN_PANE)) return stop()
    await sync($)
  }
  world.step(now, Math.min(500, now - (lastFrame || now)))
  lastFrame = now
  await townPaint($)
}

function stop() {
  frame?.cancel()
  frame = null
}

function start($: EngineInterface) {
  if (frame) return
  lastFrame = 0
  frame = $.clock.every(Math.round(1000 / fps), () => void tickFrame($))
}

/** Orders: hand a member work the person names, or ask it for an idea of its own. */
async function act($: EngineInterface, choice: string, id: string, name: string, typed = '') {
  if (demo) return $.ui.toast(`Demo crew: ${name} would get ${choice === 'idea' ? 'an idea of its own' : 'your task'} here.`)
  const crew = await members($)
  const target = crew.find(s => s.id === id)
  if (!target?.task) return $.ui.toast(`${name} is not in the task any more.`)
  let text = ''
  if (choice === 'work') {
    const answer = typed
    if (!answer.trim()) return
    text = `The user assigned you this through the crew town: ${answer.trim()}. Record it with mcp__crewser__feature (status start) if it is a distinct part of the task, tell the team with mcp__crewser__post, and start.`
  } else {
    text =
      `The user asks you, through the crew town, to come up with one useful next piece of work for the task "${target.task.name}" ` +
      `that fits your role (${target.task.role}). Pick it yourself, announce it in one line with mcp__crewser__post, record it with ` +
      `mcp__crewser__feature (status start), and start on it.`
  }
  const me = await $.session.id().catch(() => undefined)
  if (id === me) {
    void $.prompt.submit({ text }).catch(() => undefined)
    return $.ui.toast(`On it: ${name}`)
  }
  // the member's crew mod picks this up within a couple of seconds and starts a turn with it
  await $.fs.write(`${dir.replace(/\/sessions$/, '')}/orders/${id}.json`, JSON.stringify({ at: await $.clock.now(), text }))
  $.ui.toast(`Orders sent to ${name}`)
}

/** Opens the town in a window of its own: a local page served from this plugin, Chrome's app mode if it is there. */
async function openWindow($: EngineInterface, demoCrew: boolean, page = '') {
  // the project it was opened from: its town shows while no crew is at work
  const here = new URLSearchParams(demoCrew ? { demo: '1' } : { town: disk?.town ?? '', project: disk?.project ?? '' })
  const url = `http://127.0.0.1:47615/${page}?${here}`
  const server = `${$.plugin.root}/window/server.mjs`
  const up = 'curl -s -o /dev/null --max-time 1 http://127.0.0.1:47615/api/snap'
  const script =
    `${up} || (nohup node "${server}" >/dev/null 2>&1 &); ` +
    `for i in 1 2 3 4 5 6 7 8 9 10 11 12; do ${up} && break; sleep 0.25; done; ` +
    `if [ -d "/Applications/Google Chrome.app" ]; then open -na "Google Chrome" --args --app="${url}" --window-size=1360,860; else open "${url}"; fi`
  const r = await $.process.run(['sh', '-c', script], { timeoutMs: 15_000 }).catch(() => null)
  return r?.exitCode === 0
}

async function open($: EngineInterface) {
  // the window grows to show the whole map and its panel; focused, so the buttons take their keys instead of the prompt
  await fitWindow($, 132, height + 16)
  await $.ui.open({ id: TOWN_PANE, title: 'Crew Town', rows: height + 6, columns: 132, focus: true })
}

/** Moves the camera; the frame loop glides it there. */
async function pan($: EngineInterface, rows: number, cols = 0) {
  world.scroll(rows, cols)
  start($)
}

async function goHome($: EngineInterface) {
  world.home()
  start($)
}

/** Zooms the town in (+1) or out (-1) a step, around the middle of the view. */
async function zoom($: EngineInterface, by: number) {
  zoomAt = Math.max(0, Math.min(ZOOMS.length - 1, zoomAt + by))
  world.setZoom(ZOOMS[zoomAt] ?? 1)
  start($)
}

function newWorld(options: PluginOptions) {
  world = new World()
  world.minZoom = ZOOMS[0]
  world.zoom = ZOOMS[zoomAt] ?? 1
}


async function order($: EngineInterface, choice: 'work' | 'idea', typed = '') {
  const sel = await read($, selectedA)
  if (!sel) return
  await update($, selectedA, () => null)
  await act($, choice, sel.id, sel.name, typed)
}

/** The town's hooks, registered from the plugin's one entry. */
let townAutoOpen = false

/** The town's part of the session's start: where the crew files are, its command, its pane if wanted. */
async function startTown($: EngineInterface) {
  dir = `${(await $.env.get('HOME')) ?? '/tmp'}/.claude/crew/sessions`
  await $.command.register({ name: 'crew-town', description: 'Open the crew town: your task as a pixel-art town', argumentHint: '[window] [demo]', immediate: true })
  if (townAutoOpen) void open($)
}

function registerTown(on: On, options: PluginOptions) {
  fps = Math.max(1, Math.min(15, Number(options.fps ?? 10)))
  height = Math.max(14, Math.min(60, Number(options.height ?? 34)))
  boredMs = Math.max(30, Number(options.boredAfter ?? 120)) * 1000
  newWorld(options)

  townAutoOpen = options.autoOpen === true

  on('command.run', { command: 'crew-town' }, async ($, e) => {
    const args = e.args.trim().split(/\s+/)
    if (args.includes('window')) {
      const ok = await openWindow($, args.includes('demo'))
      return { text: ok ? 'The town opened in its own window (it keeps running until you close it and leave it for half an hour).' : 'Could not start the town window: it needs Node.js on this machine.' }
    }
    demo = args.includes('demo')
    newWorld(options)
    await sync($)
    await open($)
    return { text: `The town is open${demo ? ' with a demo crew (/crew-town for the real one)' : ''}. Move with the arrows on its borders, zoom bottom-left; give orders under the map.` }
  })

  // the wheel moves the camera over the town instead of the pane's own window; over the top bar, sideways
  on('ui.scroll', { requestId: TOWN_PANE }, async ($, e) => {
    const row = e.pointer?.row ?? -1
    const sideways = row === 0 || row >= world.rows - 2
    await (sideways ? pan($, 0, e.by * 6) : pan($, e.by * 3))
    return {}
  })

  on('ui.close', { id: TOWN_PANE }, async ($, e, next) => {
    stop()
    await update($, selectedA, () => null)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: TOWN_PANE }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>The town draws in the terminal.</Text>
    }
    const { Box, Button, Input, Raster, Text } = $.ui.resolve(e)
    const cols = Math.max(40, e.props.bodyColumns)
    const rows = e.props.placement === 'dock' ? Math.max(12, e.props.scroll.bodyRows - 4) : height
    // big framed buttons on the map's edges: an arrow on each side, the zoom in the bottom-left corner, the castle
    // top right. Each is one button, frame and all, so a click anywhere on it counts (in the fullscreen renderer)
    const field = (key: string, glyph: string, top: number, left: number, w: number, tall: number, go: () => unknown) => {
      const inner = w - 2
      const middle = Math.floor((tall - 2) / 2)
      const pad = Math.max(0, Math.floor((inner - [...glyph].length) / 2))
      const side = '│' + ' '.repeat(inner) + '│'
      const above = ['╭' + '─'.repeat(inner) + '╮', ...Array.from({ length: middle }, () => side)].join('\n')
      const below = [...Array.from({ length: tall - 3 - middle }, () => side), '╰' + '─'.repeat(inner) + '╯'].join('\n')
      return (
        <Box key={`nav-${key}`} position="absolute" top={top} left={left} width={w} height={tall}>
          <Button key={key} label={glyph} plain onPress={go}>
            <Text color="#c9bc9c" backgroundColor="#1d1b18">
              {above}
              {'\n│' + ' '.repeat(pad)}
              <Text color="#ffffff" backgroundColor="#1d1b18" bold>{glyph}</Text>
              {' '.repeat(Math.max(0, inner - pad - [...glyph].length)) + '│\n'}
              {below}
            </Text>
          </Button>
        </Box>
      )
    }
    // the same moves as ordinary buttons with keys, under the map: they work without a mouse or the fullscreen renderer
    const move = (key: string, glyph: string, hotkey: string, go: () => unknown) => (
      <Button key={key} label={glyph} hotkey={hotkey} dimColor onPress={go} />
    )
    world.hudReserve = 0
    world.resize(cols, rows)
    world.step(await $.clock.now(), 0)
    start($)
    const snap = await snapshot($)
    const crews = world.crewList()
    const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`
    // every member of every crew, by crew, then the overseer; their number keys run across them all
    const crew = [...crews.flatMap(c => snap.sessions.filter(s => s.task?.id === c.id)), ...snap.sessions.filter(s => s.overseer && !s.task)]
    const sel = await read($, selectedA)
    const clickable = e.viewport?.isFullscreen === true
    const sideTall = Math.max(3, Math.min(7, rows - 10))
    const sideTop = Math.max(4, Math.floor((rows - sideTall) / 2))
    const upW = Math.min(17, Math.max(9, cols - 40))
    return (
      <Box flexDirection="column">
        <Box key="stage">
          <Raster key="map" columns={world.cols} rows={world.rows} cells={world.render()} />
          {field('up', '▲', 1, Math.floor((cols - upW) / 2), upW, 3, () => pan($, -8))}
          {field('down', '▼', rows - 3, Math.floor((cols - upW) / 2), upW, 3, () => pan($, 8))}
          {field('left', '◀', sideTop, 0, 7, sideTall, () => pan($, 0, -24))}
          {field('right', '▶', sideTop, cols - 7, 7, sideTall, () => pan($, 0, 24))}
          {field('zoom-out', '−', rows - 3, 0, 7, 3, () => zoom($, -1))}
          {field('zoom-in', '+', rows - 3, 7, 7, 3, () => zoom($, 1))}
          {field('home', '⌂ Castle', 1, cols - 12, 12, 3, () => goHome($))}
        </Box>
        <Box key="panel" flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          {crews.length > 1 && (
            <Box key="crews" flexDirection="column">
              <Text color="claude" bold>{`⚑ ${crews.length} crews`}</Text>
              {crews.map(c => (
                <Button key={`crew-${c.id}`} plain label={`⚑ ${L.gist(c.name, 24)}`} onPress={() => (world.focusCrew(c.id), townPaint($))}>
                  <Text color={hex(c.color)}>{`⚑ ${L.gist(c.name, 24)}`}</Text>
                  <Text dimColor>{` (${c.lead})  `}</Text>
                </Button>
              ))}
            </Box>
          )}
          <Box key="crew" flexDirection="column">
            <Text color="claude" bold>
              {crews.length > 1 ? '● Members' : '⚑ Crew'}
            </Text>
            {crew.length === 0 && <Text dimColor>no crew yet: /crew-task starts one</Text>}
            {crew.slice(0, 9).map((s, i) => (
              <Box key={`chip-${s.id}`} flexDirection="row">
                <Text color={s.color}>● </Text>
                <Button
                  key={`m-${s.id}`}
                  label={s.name}
                  hotkey={String(i + 1)}
                  variant={sel?.id === s.id ? 'primary' : undefined}
                  dimColor={sel !== null && sel.id !== s.id}
                  onPress={() => update($, selectedA, cur => (cur?.id === s.id ? null : { id: s.id, name: s.name, typing: false }))}
                />
              </Box>
            ))}
          </Box>
          {sel?.typing ? (
            <Box key="assign" flexDirection="column">
              <Input
                key="task"
                label={`Work for ${sel.name}`}
                placeholder="e.g. write tests for the payment flow"
                submitLabel="send"
                autoFocus
                onSubmit={value => order($, 'work', value)}
              />
              <Button key="cancel" label="Cancel" role="dismiss" onPress={() => update($, selectedA, () => null)} />
            </Box>
          ) : sel ? (
            <Box key="menu" flexDirection="column">
              <Text>→ {sel.name}:</Text>
              <Button key="work" label="Give work…" hotkey="w" variant="primary" onPress={() => update($, selectedA, cur => (cur ? { ...cur, typing: true } : cur))} />
              <Button key="idea" label="Come up with an idea" hotkey="e" onPress={() => order($, 'idea')} />
              <Button key="cancel" label="Cancel" hotkey="c" role="dismiss" onPress={() => update($, selectedA, () => null)} />
            </Box>
          ) : (
            <Box key="hint" flexDirection="column">
              <Box key="nav" flexDirection="column">
                {move('kb-left', '◀ Left', 'h', () => pan($, 0, -24))}
                {move('kb-up', '▲ Up', 'k', () => pan($, -8))}
                {move('kb-down', '▼ Down', 'j', () => pan($, 8))}
                {move('kb-right', '▶ Right', 'l', () => pan($, 0, 24))}
                {move('kb-zoom-out', '− Zoom out', 'o', () => zoom($, -1))}
                {move('kb-zoom-in', '+ Zoom in', 'i', () => zoom($, 1))}
                {move('kb-home', '⌂ Back to the castle', 'g', () => goHome($))}
              </Box>
              <Text dimColor wrap="wrap">
                {clickable
                  ? 'click a member for orders · the wheel scrolls (over the top bar: sideways) '
                  : e.props.isFocused
                    ? 'h j k l move · o i zoom · g the castle · a number picks a member · Esc to the prompt '
                    : 'ctrl+x tab puts the keys here '}
              </Text>
              <Button key="window" label="⧉ Open as window" variant="primary" onPress={() => void openWindow($, demo)} />
              {!clickable && (
                <Button
                  key="clicks"
                  label="Make it clickable"
                  dimColor
                  onPress={() => void $.command.run({ command: 'tui', args: 'fullscreen' }).catch(() => $.ui.toast('Run /tui fullscreen to click on the map.'))}
                />
              )}
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}
