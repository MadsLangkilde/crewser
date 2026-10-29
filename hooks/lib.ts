import type { Role, Strategy } from './strategy'

// ---- what every session writes to ~/.claude/crew (the town reads the same files)

export type DiskPing = { id: string; to: string; reason: string; at: number }
export type DiskPost = { at: number; to: string; text: string; relay?: boolean }
export type DiskAgent = { id: string; kind: string; desc: string; at: number }
/** A part of the task the session is on; `kind` is what the town shows it as, `parent` the feature it belongs to, `crop` what a field grows. */
export type DiskFeature = { id: string; name: string; status: 'building' | 'done'; at: number; kind?: string; parent?: string; crop?: string }

export type DiskSession = {
  v: 1
  id: string
  name: string
  codename: string
  colorName: string
  color: string
  tty: string | null
  term: string
  cwd: string
  project: string
  /** The project's folder (the main checkout, also from a worktree), the git folder the session works in, and the folder its town is kept in. */
  root?: string
  top?: string
  town?: string
  /** The project's overseer: above the leads of every crew in the project, in no task itself. */
  overseer?: boolean
  /** The files it edited lately, relative to the folder it works in: two crews on one file means a merge to plan. */
  files?: string[]
  model: string
  startedAt: number
  beat: number
  status: 'idle' | 'working'
  activity: string
  lastPrompt: string
  tool: string
  detail: string
  ctx: number | null
  five: number | null
  week: number | null
  cost: number | null
  /** roleId: the strategy role it plays; extra: a role added mid-task that the strategy does not hold. */
  task: { id: string; name: string; role: string; lead: string; roleId?: string; extra?: Role; code?: string } | null
  agents: DiskAgent[]
  features: DiskFeature[]
  pings: DiskPing[]
  posts: DiskPost[]
  ackedAt: number
  relaySeenAt: number
  userAt?: number
  idleSince?: number
  /** When its current turn began, while it works. */
  busySince?: number
  /** Whom it last spoke to (a teammate's name, 'all', 'advisor') and when. */
  talkTo?: string
  talkAt?: number
  attention: boolean
  ended: boolean
}

export type DiskTask = {
  strategy?: Strategy | null
  v: 1
  id: string
  name: string
  /** A short id of four digits (`4821`) that tells tasks apart in session titles, also two with the same name. */
  code?: string
  goal: string
  creator: string
  creatorName: string
  createdAt: number
  ended: boolean
  /** The lead's project: the town whose buildings this task's features add to, and the folder that town is kept in. */
  project?: string
  town?: string
  /** The main checkout, and the crew's own worktree and branch when it has one (another crew was at work there). */
  root?: string
  worktree?: string
  branch?: string
  /** Made by the board or the overseer for a lead window still opening: it takes the task when it starts. */
  pendingLead?: boolean
  /** Set by the overseer: a paused crew takes no new work; a lower priority number goes first. */
  paused?: boolean
  priority?: number
  /** What became of the crew's branch when the task ended. */
  outcome?: 'merged' | 'pr' | 'kept'
  /** How its crew's sessions open: windows of their own, tiled, or tabs in the lead's window. */
  openAs?: 'windows' | 'tabs'
  outcomeNote?: string
  /** Everyone who has worked on it besides the lead, kept by the lead: who to bring back when it is resumed. */
  members?: TaskMember[]
  endedAt?: number
  resumedAt?: number
  /** Members whose windows were still open when it was resumed: they rejoin by themselves. */
  invite?: string[]
  /** A model's few sentences on what the task is about, what was done and what is left, as of its history's event at `at`. */
  summary?: { text: string; at: number }
}

// ---- a task's history: what happened in it, kept so it can be picked up later and followed by the overseer

export type HistoryKind = 'start' | 'resume' | 'end' | 'join' | 'leave' | 'crew' | 'feature' | 'status' | 'report' | 'brief' | 'pause' | 'goal' | 'branch'
export type HistoryEvent = { at: number; by: string; kind: HistoryKind; text: string; feature?: { name: string; status: 'building' | 'done' | 'removed' } }

/** Its latest status: the last one recorded, else the last report to the overseer. */
export function statusOf(history: readonly HistoryEvent[]): HistoryEvent | undefined {
  const back = [...history].reverse()
  return back.find(e => e.kind === 'status') ?? back.find(e => e.kind === 'report')
}

/** Its features as its history tells them, the latest word on each: done, being built, or dropped. */
export function featuresOf(history: readonly HistoryEvent[]) {
  const by = new Map<string, { name: string; status: 'building' | 'done' | 'removed'; at: number }>()
  for (const e of history) if (e.feature) by.set(e.feature.name.toLowerCase(), { ...e.feature, at: e.at })
  return [...by.values()].sort((a, b) => a.at - b.at)
}

/** Whether a status says the crew is stuck. */
export const saysBlocked = (text: string) => /\b(blocked|stuck|waiting (on|for)|need(s)? (your|a) decision)\b/i.test(text)

/** An icon per kind of event, for the history's lines. */
export const HISTORY_ICON: Record<HistoryKind, string> = {
  start: '▶', resume: '↻', end: '■', join: '+', leave: '−', crew: '⊕', feature: '⌂', status: '↑', report: '✉', brief: '✉', pause: '⏸', goal: '◎', branch: '⎇',
}

/** The prompt that asks a small model for the few sentences a person resuming the task reads first. */
export function summaryPrompt(task: DiskTask, history: readonly HistoryEvent[]) {
  const feats = featuresOf(history)
  const lines = history.slice(-70).map(e => `${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} ${e.by} (${e.kind}): ${e.text}`)
  return [
    `A crew of Claude Code sessions worked on the task "${task.name}"${task.goal ? ` with the goal: ${task.goal}` : ''}${task.strategy ? `, with the strategy "${task.strategy.name}"` : ''}.`,
    feats.length ? `Features: ${feats.map(f => `${f.name} (${f.status === 'done' ? 'done' : f.status === 'removed' ? 'dropped' : 'in progress'})`).join(', ')}.` : '',
    'Its history, oldest first:',
    ...lines,
    '',
    'Write 2 or 3 short plain sentences for the person who will resume it and has forgotten it: what the task is about, what has been done, and what is left or where it stopped. No heading, no list, no preamble.',
  ].filter(Boolean).join('\n')
}

/** A crew member as the task remembers it: its session (to resume its conversation), name, role, folder and color. */
export type TaskMember = { id: string; name: string; role: string; roleId?: string; extra?: Role; cwd: string; color: string; lastSeen: number }

/**
 * Who worked on a task besides its lead: the roster the lead kept, else the sessions whose last record was in it.
 * One per name (a /clear gives a window a new session: the newest one counts).
 */
export function crewOf(task: DiskTask, sessions: readonly DiskSession[]): TaskMember[] {
  const kept: TaskMember[] = task.members?.length
    ? task.members
    : sessions
        .filter(s => s.task?.id === task.id && s.id !== task.creator)
        .map(s => ({ id: s.id, name: s.name, role: s.task?.role ?? 'Member', roleId: s.task?.roleId, extra: s.task?.extra, cwd: s.cwd, color: s.color, lastSeen: s.beat }))
  const byName = new Map<string, TaskMember>()
  for (const m of kept) {
    const was = byName.get(m.name)
    if (!was || m.lastSeen > was.lastSeen) byName.set(m.name, m)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** When a task was last worked on. */
export const lastWorked = (task: DiskTask) => Math.max(task.endedAt ?? 0, task.resumedAt ?? 0, task.createdAt, ...(task.members ?? []).map(m => m.lastSeen))

/** "3 hours ago", "2 days ago". */
export function ago(ms: number) {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 2) return 'just now'
  if (m < 60) return `${m} minutes ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h} hour${h > 1 ? 's' : ''} ago`
  const d = Math.round(h / 24)
  return `${d} day${d > 1 ? 's' : ''} ago`
}

/** Task ideas from a model's reply: a JSON list of { name, goal }, cleaned, at most four. */
export function parseIdeas(text: string): { name: string; goal: string }[] {
  const from = text.indexOf('[')
  const to = text.lastIndexOf(']')
  if (from < 0 || to <= from) return []
  try {
    const rows = JSON.parse(text.slice(from, to + 1)) as unknown
    if (!Array.isArray(rows)) return []
    return rows
      .map(r => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}))
      .map(r => ({ name: gist(String(r.name ?? '').replace(/["`]/g, ''), 40), goal: gist(String(r.goal ?? ''), 160) }))
      .filter(r => r.name.length > 1)
      .slice(0, 4)
  } catch {
    return []
  }
}

// ---- telling sessions of several tasks apart

/** A new short task id, four digits (1000-9999), none of `taken`. */
export function newCode(taken: Iterable<string> = []): string {
  const used = new Set(taken)
  for (;;) {
    const code = String(1000 + Math.floor(Math.random() * 9000))
    if (!used.has(code)) return code
  }
}

/** A task's short id, four digits: its own, or (tasks from before, or with a code of letters) one worked out from its id. */
export function codeOf(task: { id: string; code?: string }) {
  if (task.code && /^\d{4}$/.test(task.code)) return task.code
  let h = 0
  for (const ch of task.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return String(1000 + (h % 9000))
}

/** `Checkout flow #4821`: the task by name and short id. */
export const taskLabel = (task: { id: string; name: string; code?: string }) => `${gist(task.name, 28)} #${codeOf(task)}`

/** A session's full title, for its window or tab and Claude's session list: `Checkout flow #4821 · Implementer #1`. */
export const titleOf = (name: string, task: { id: string; name: string; code?: string } | null | undefined) =>
  task ? `${taskLabel(task)} · ${name}` : name

/**
 * Whether a query names a session: its name, its full title, or every word of the query found in the title
 * ("implementer #1 4821", "checkout implementer"), so the same role in two crews is told apart by its task.
 */
export function namesSession(query: string, name: string, title: string): 'exact' | 'part' | null {
  const q = query.toLowerCase().trim()
  if (!q) return null
  if (q === name.toLowerCase() || q === title.toLowerCase()) return 'exact'
  const words = title.toLowerCase()
  return q.split(/[\s·,]+/).filter(Boolean).every(w => words.includes(w)) ? 'part' : null
}

export const STALE_MS = 25_000

/** [name, hex, the /color name]: the eight colors /color knows, drawn as Claude Code draws them. */
export const PALETTE: ReadonlyArray<readonly [string, string, string]> = [
  ['Red', '#e5484d', 'red'],
  ['Blue', '#4f7cff', 'blue'],
  ['Green', '#3fb950', 'green'],
  ['Yellow', '#e3b341', 'yellow'],
  ['Purple', '#c061cb', 'purple'],
  ['Orange', '#ff8700', 'orange'],
  ['Pink', '#ff5faf', 'pink'],
  ['Cyan', '#39c5cf', 'cyan'],
]

export const ccOf = (colorName: string) => PALETTE.find(([n]) => n === colorName)?.[2] ?? 'default'

export const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)] as T

export const isLive = (s: DiskSession, now: number) => !s.ended && now - s.beat < STALE_MS

export const gist = (text: string, n: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

export const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

export const slug = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task'

export const uid = () => Math.random().toString(36).slice(2, 10)

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Blend two 0-255 rgb triples; t = share of `b`. */
export const mix = (a: readonly number[], b: readonly number[], t: number) =>
  a.map((v, i) => Math.round(v + ((b[i] ?? 0) - v) * t))

export function fmtLeft(iso: string | undefined, now: number) {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!(ms > 0)) return ''
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}`
  return `${Math.round(h / 24)}d`
}

// ---- bars

export type BarStyle = 'blocks' | 'shades' | 'line' | 'dots' | 'squares' | 'ascii'

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** The filled and empty halves of a bar, drawn in two colors by the caller. */
export function bar(pct: number, width: number, style: BarStyle): { fill: string; rest: string } {
  const w = Math.max(4, Math.min(40, Math.round(width)))
  const p = Math.max(0, Math.min(100, pct)) / 100
  if (style === 'blocks') {
    const exact = p * w
    const full = Math.floor(exact)
    const part = EIGHTHS[Math.round((exact - full) * 8)] ?? ''
    const fill = '█'.repeat(full) + (full < w ? part : '')
    return { fill, rest: '░'.repeat(Math.max(0, w - full - (part && full < w ? 1 : 0))) }
  }
  const n = Math.round(p * w)
  const glyphs: Record<Exclude<BarStyle, 'blocks'>, readonly [string, string]> = {
    shades: ['▓', '░'],
    line: ['━', '─'],
    dots: ['●', '○'],
    squares: ['■', '□'],
    ascii: ['#', '-'],
  }
  const [on, off] = glyphs[style] ?? glyphs.shades
  return { fill: on.repeat(n), rest: off.repeat(w - n) }
}

export const traffic = (pct: number) => (pct >= 85 ? 'error' : pct >= 60 ? 'warning' : 'success')

// ---- terminal scripts (run by the hooks module through $.process.run)

export const TTY_SCRIPT =
  'p=$$; for i in 1 2 3 4 5 6; do t=$(ps -o tty= -p $p 2>/dev/null | tr -d " "); ' +
  'if [ -n "$t" ] && [ "$t" != "??" ]; then echo "/dev/$t"; exit 0; fi; ' +
  'p=$(ps -o ppid= -p $p 2>/dev/null | tr -d " "); [ -z "$p" ] && break; done'

export const inTab = (tty: string, body: string) => `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${tty}" then
        ${body}
      end if
    end repeat
  end repeat
end tell`

export const iTermTab = (hex: string) => {
  const [r, g, b] = hexToRgb(hex)
  return `\\033]6;1;bg;red;brightness;${r}\\a\\033]6;1;bg;green;brightness;${g}\\a\\033]6;1;bg;blue;brightness;${b}\\a`
}
export const ITERM_RESET = '\\033]6;1;bg;*;default\\a'
export const ITERM_ATTENTION = '\\033]1337;RequestAttention=yes\\a\\a'
export const BELL = '\\a'

export const asText = (s: string) => s.replace(/["\\]/g, '')

export type Dirs = { root: string; sessions: string; tasks: string; home: string }

/** A few words on what a tool call does, for teammates' views and the town's speech bubbles. */
export function describeCall(tool: string, input: Record<string, unknown>) {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const file = str('file_path') || str('notebook_path')
  const short = file ? basename(file) : ''
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return `editing ${short}`
  if (tool === 'Read') return `reading ${short}`
  if (tool === 'Bash') return `running ${gist(str('command').split(/\s+/).slice(0, 2).join(' '), 24)}`
  if (tool === 'Grep' || tool === 'Glob') return `searching ${gist(str('pattern'), 20)}`
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'reading the web'
  if (tool === 'Agent' || tool === 'Task') return `delegating: ${gist(str('description'), 24)}`
  if (tool === 'TodoWrite') return 'planning'
  return tool.startsWith('mcp__') ? `using ${tool.split('__')[1] ?? 'a tool'}` : tool.toLowerCase()
}

// ---- the overseer's view: every crew in a project

/** Where a task's crew works: its worktree, else the main checkout. */
export const taskDir = (k: DiskTask) => k.worktree ?? k.root ?? ''

export type CrewView = {
  task: DiskTask
  lead: DiskSession | undefined
  members: DiskSession[]
  cost: number
  features: DiskFeature[]
}

/** The crews at work in a project (by its town folder), the paused and low-priority ones last. */
export function crewsIn(town: string, tasks: readonly DiskTask[], sessions: readonly DiskSession[], now: number): CrewView[] {
  return tasks
    .filter(k => !k.ended && k.town === town)
    .map(k => {
      const members = sessions.filter(s => s.task?.id === k.id && isLive(s, now))
      return {
        task: k,
        lead: members.find(s => s.id === k.creator),
        members,
        cost: members.reduce((n, s) => n + (s.cost ?? 0), 0),
        features: members.flatMap(s => s.features),
      }
    })
    .sort((a, b) => Number(!!a.task.paused) - Number(!!b.task.paused) || (a.task.priority ?? 9) - (b.task.priority ?? 9) || a.task.createdAt - b.task.createdAt)
}

/** Files edited lately by more than one crew: the merges to plan for. */
export function overlaps(crews: readonly CrewView[]): { file: string; crews: string[] }[] {
  const by = new Map<string, Set<string>>()
  for (const c of crews) for (const s of c.members) for (const f of s.files ?? []) by.set(f, (by.get(f) ?? new Set()).add(c.task.name))
  return [...by.entries()].filter(([, n]) => n.size > 1).map(([file, n]) => ({ file, crews: [...n] })).sort((a, b) => a.file.localeCompare(b.file))
}

/** "45s", "3m", "1h20": how long, short. */
export function dur(ms: number) {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.round(sec / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

/** What a member is doing now, and for how long: "working 3m · editing cart.ts", "idle 12m · last: fix the tests". */
export function doing(s: DiskSession, now: number) {
  if (s.status === 'working') {
    const what = s.detail || s.activity
    const helpers = s.agents?.length ?? 0
    return `working${s.busySince ? ` ${dur(now - s.busySince)}` : ''}${what ? ` · ${what}` : ''}${helpers ? ` · ${helpers} helper${helpers > 1 ? 's' : ''}` : ''}`
  }
  const what = s.lastPrompt || s.activity
  return `idle${s.idleSince ? ` ${dur(now - s.idleSince)}` : ''}${what ? ` · last: ${what}` : ''}`
}

/** A message between the overseer and the crews: briefs going down, statuses and answers coming up. */
export type FeedItem = { at: number; from: string; to: string; color: string; text: string; up: boolean; crew?: string }

/** The overseer's conversation with the crews, oldest first: what it sent (its posts) and what members posted to it. */
export function feed(overseer: DiskSession | null | undefined, crews: readonly CrewView[], n = 10): FeedItem[] {
  const items: FeedItem[] = []
  for (const c of crews) {
    for (const s of c.members) {
      for (const p of s.posts) {
        if (p.to === 'overseer' || (overseer && p.to === overseer.id)) items.push({ at: p.at, from: titleOf(s.name, c.task), to: 'overseer', color: s.color, text: p.text, up: true, crew: c.task.id })
      }
    }
  }
  for (const p of overseer?.posts ?? []) {
    const k = p.to.startsWith('crew:') ? crews.find(c => c.task.id === p.to.slice(5))?.task : undefined
    const to = p.to === 'leads' ? 'every lead' : k ? taskLabel(k) : p.to.startsWith('crew:') ? 'a crew that ended' : p.to
    items.push({ at: p.at, from: 'overseer', to, color: overseer?.color ?? '', text: p.text, up: false, crew: k?.id })
  }
  return items.sort((a, b) => a.at - b.at).slice(-n)
}

/** The latest a crew told the overseer: its status line. */
export const lastStatus = (c: CrewView, overseer?: DiskSession | null) =>
  feed(overseer, [c], 50).filter(f => f.up).pop()

/** Whether a crew says it is stuck: its latest status to the overseer reads blocked or waiting on something. */
export const isBlocked = (c: CrewView, overseer?: DiskSession | null) => saysBlocked(lastStatus(c, overseer)?.text ?? '')

/** The overview the overseer reads: every crew, its members, features, cost; the tokens left; files two crews touch; the conversation. */
export function overview(crews: readonly CrewView[], fiveUsed: number | null, waiting: readonly DiskTask[] = [], now = Date.now(), overseer: DiskSession | null = null): string {
  if (!crews.length && !waiting.length) return 'No crews are at work in this project. Start one with mcp__crewser__start_crew.'
  const lines: string[] = []
  for (const c of crews) {
    const k = c.task
    const done = c.features.filter(f => f.status === 'done').length
    const working = c.members.filter(s => s.status === 'working').length
    const flags = [
      k.paused ? 'PAUSED' : '', isBlocked(c, overseer) ? 'BLOCKED' : '', k.priority !== undefined ? `priority ${k.priority}` : '',
      k.branch ? `branch ${k.branch}` : 'main checkout', `${working}/${c.members.length} working`,
      c.features.length ? `${done}/${c.features.length} features done` : '', `$${c.cost.toFixed(2)}`,
    ].filter(Boolean).join(' · ')
    lines.push(`## ${taskLabel(k)} (lead ${c.lead?.name ?? k.creatorName}) · ${flags}`)
    if (k.goal) lines.push(`Goal: ${k.goal}`)
    const status = lastStatus(c, overseer)
    if (status) lines.push(`Last status to you (${ago(now - status.at)}, ${status.from}): ${gist(status.text, 160)}`)
    for (const s of c.members) lines.push(`- ${s.name} · ${s.task?.role ?? ''} · ${s.model} · ${gist(doing(s, now), 90)}${s.ctx !== null ? ` · ctx ${Math.round(s.ctx)}%` : ''}`)
    if (c.features.length) lines.push(`Features: ${c.features.map(f => `${f.name} (${f.status === 'done' ? 'done' : 'in progress'})`).join(', ')}`)
    const said = c.members.flatMap(s => s.posts.filter(p => p.to !== 'overseer').map(p => ({ s, p }))).sort((a, b) => a.p.at - b.p.at).slice(-3)
    if (said.length) lines.push(`Within the crew lately: ${said.map(({ s, p }) => `${s.name}: ${gist(p.text, 80)}`).join(' | ')}`)
  }
  const talk = feed(overseer, crews, 8)
  if (talk.length) lines.push('', 'Your conversation with the crews (oldest first):', ...talk.map(f => `- ${ago(now - f.at)} ${f.up ? `${f.from} → you` : `you → ${f.to}`}: ${gist(f.text, 160)}`))
  const both = overlaps(crews)
  if (both.length) lines.push('', 'Files more than one crew is changing (plan the merge order):', ...both.map(o => `- ${o.file}: ${o.crews.join(', ')}`))
  if (waiting.length) lines.push('', 'Ended, with a branch waiting for the user to merge, open a PR or keep:', ...waiting.map(k => `- ${k.name} (${k.branch})`))
  lines.push('', fiveUsed === null ? 'Tokens: unknown.' : `Tokens: ${Math.max(0, Math.round(100 - fiveUsed))}% of the 5-hour limit left, shared by every crew.`)
  lines.push('Members are named within their crew; to name one across crews add its crew\'s code, e.g. "Implementer #1 #' + (crews[0] ? codeOf(crews[0].task) : '4821') + '".')
  return lines.join('\n')
}

/** The shell that stops a crew's sessions and closes their windows: its own session, apart from every tty it kills. */
export function stopScript(ttys: string[], windows: string[]) {
  const names = ttys.map(t => t.replace(/^\/dev\//, '')).join(' ')
  const each = (sig: string) => `for t in ${names}; do for p in $(ps -t "$t" -o pid=); do kill -${sig} "$p" 2>/dev/null; done; done`
  return [
    'sleep 1',
    each('HUP'),
    'sleep 2',
    each('TERM'),
    'sleep 2',
    each('KILL'),
    'sleep 1',
    ...windows.map(id => `osascript -e 'tell application "Terminal" to close (every window whose id is ${id})'`),
  ].join('\n')
}
