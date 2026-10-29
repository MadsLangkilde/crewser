// The town as its own window: a tiny local server for the canvas page. It reads the same
// crew files the plugins write and delivers orders through them; it never touches a session.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import os from 'node:os'
import path from 'node:path'

process.removeAllListeners('warning')
const PORT = Number(process.env.CREW_TOWN_PORT || 47615)
const here = path.dirname(new URL(import.meta.url).pathname)
const root = path.join(os.homedir(), '.claude', 'crew')
const STALE_MS = 25_000
const BORED_MS = Number(process.env.CREW_TOWN_BORED_MS || 120_000)
let lastHit = Date.now()

// quits by itself once nobody has looked for half an hour
setInterval(() => Date.now() - lastHit > 30 * 60_000 && process.exit(0), 60_000).unref()


async function readDir(dir) {
  const names = await fs.readdir(dir).catch(() => [])
  const rows = await Promise.all(
    names.filter(n => n.endsWith('.json')).map(n => fs.readFile(path.join(dir, n), 'utf8').then(JSON.parse).catch(() => null)),
  )
  return rows.filter(Boolean)
}

// the town's books: one file per building in the project (hooks/town/ledger.ts, loaded as it is)
let ledger = null
async function readTown(folder, now) {
  ledger ??= await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(await fs.readFile(path.join(here, '..', 'hooks', 'town', 'ledger.ts'), 'utf8'))))
  const names = await fs.readdir(folder).catch(() => [])
  const rows = await Promise.all(names.filter(n => n.endsWith('.json')).map(n => fs.readFile(path.join(folder, n), 'utf8').then(t => ledger.read(t).ledger).catch(() => null)))
  return rows
    .filter(l => l && (l.status !== 'removed' || now - l.at < 10 * 60_000))
    .sort((a, b) => a.since - b.since)
    .map(ledger.built)
}

function demoCrew(now) {
  const phase = Math.floor(now / 12_000) % 4
  const task = { id: 'demo-task', name: 'checkout-revamp', role: 'Lead', lead: 'Mads' }
  const base = { project: 'tetris', startedAt: 0, five: 34, week: 18, attention: false, agents: [], posts: [], features: [], detail: '', tool: '', userAt: now - 60_000, idleSince: now - 60_000, beat: now, ended: false }
  const t0 = now - (now % 48_000)
  return [
    { ...base, id: 'd1', name: 'Mads', color: '#e5484d', status: phase === 1 ? 'working' : 'idle', tool: 'Edit', detail: 'editing board.ts', lastPrompt: 'make the pieces fall faster', task,
      features: [{ id: 'f1', name: 'Board', status: 'done', at: t0 - 90_000 }, { id: 'f2', name: 'Scoring', status: phase > 1 ? 'done' : 'building', at: t0 }],
      posts: [{ at: now - (now % 15_000), to: 'all', text: 'board is merged, scoring next' }] },
    { ...base, id: 'd2', name: 'Reviewer #1', color: '#39c5cf', status: phase === 2 ? 'working' : 'idle', tool: 'Read', detail: 'reading score.ts', lastPrompt: 'review the scoring', task: { ...task, role: 'Reviewer' } },
    { ...base, id: 'd3', name: 'Implementer #1', color: '#3fb950', status: 'working', tool: phase % 2 ? 'Bash' : 'Edit', detail: phase % 2 ? 'running npm test' : 'editing pieces.ts',
      lastPrompt: 'add the T-spin', task: { ...task, role: 'Implementer' }, features: [{ id: 'f3', name: 'T-spin', status: 'building', at: t0 - 30_000 }],
      agents: [{ id: 'p1', kind: 'Explore', desc: 'find the rotation code', at: 0 }, ...(phase > 1 ? [{ id: 'p2', kind: 'general-purpose', desc: 'write tests', at: 0 }] : [])] },
    { ...base, id: 'd4', name: 'Tester #1', color: '#ff8700', status: phase === 3 ? 'working' : 'idle', tool: 'Bash', detail: 'running playwright', lastPrompt: 'e2e tests', task: { ...task, role: 'Tester' }, attention: phase === 2 },
  ]
}

async function snapshot(taskId, demo = false, home = { town: '', project: '' }) {
  const now = Date.now()
  const live = demo ? demoCrew(now) : (await readDir(path.join(root, 'sessions'))).filter(s => !s.ended && (s.task || s.overseer) && now - s.beat < STALE_MS)
  const sessions = live.filter(s => s.task)
  const byTask = new Map()
  for (const s of sessions) byTask.set(s.task.id, [...(byTask.get(s.task.id) ?? []), s])
  const tasks = [...byTask.entries()]
    .map(([id, crew]) => {
      const lead = crew.find(s => s.task.role === 'Lead') ?? crew[0]
      return { id, name: crew[0].task.name, lead: lead.name, project: lead.project, members: crew.length, startedAt: Math.min(...crew.map(s => s.startedAt)) }
    })
    .sort((a, b) => b.startedAt - a.startedAt)
  // the town is the chosen task's project's (or the one the window was opened from): every crew in it, and its overseer
  const picked = tasks.find(t => t.id === taskId) ?? (home.town ? tasks.find(t => byTask.get(t.id).some(s => s.town === home.town)) : undefined) ?? tasks[0]
  const pickedLead = picked ? (byTask.get(picked.id).find(s => s.task.role === 'Lead') ?? byTask.get(picked.id)[0]) : undefined
  const here = pickedLead?.town ?? home.town
  const crew = here ? live.filter(s => s.town === here || (picked && s.task?.id === picked.id)) : picked ? byTask.get(picked.id) : []
  const chosen = picked
  const lastHuman = Math.max(0, ...crew.map(s => s.userAt ?? 0), ...crew.map(s => s.idleSince ?? 0))
  const bored = crew.length > 0 && crew.every(s => s.status === 'idle') && now - lastHuman > BORED_MS
  const lead = pickedLead
  // no crew at work: the town of the project the window was opened from
  const folder = here || (lead?.root ? path.join(lead.root, '.crewser', 'town') : '')
  const town = demo
    ? [{ name: 'Login', level: 3, status: 'done', at: now - 9e6, color: '#9b7fe0', by: 'Mads' }, { name: 'Search', level: 2, status: 'done', at: now - 6e6, color: '#39c5cf', by: 'Reviewer #1' }]
    : folder
      ? await readTown(folder, now)
      : []
  return { sessions: crew, tasks, task: chosen?.id ?? null, now, me: crew[0]?.id, bored, town, project: lead?.project ?? (home.project || undefined) }
}

function orderText(kind, member, typed) {
  if (kind === 'work') {
    return `The user assigned you this through the crew town: ${typed}. Record it with mcp__crewser__feature (status start) if it is a distinct part of the task, tell the team with mcp__crewser__post, and start.`
  }
  return (
    `The user asks you, through the crew town, to come up with one useful next piece of work for the task "${member.task.name}" ` +
    `that fits your role (${member.task.role}). Pick it yourself, announce it in one line with mcp__crewser__post, record it with ` +
    'mcp__crewser__feature (status start), and start on it.'
  )
}

/** Brings a session's Terminal.app window to the front by its tty. */
function raise(tty) {
  const script = `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${tty.replace(/"/g, '')}" then
        set index of w to 1
        set selected of t to true
        activate
        return "ok"
      end if
    end repeat
  end repeat
end tell`
  return new Promise(resolve => execFile('osascript', ['-e', script], { timeout: 5000 }, err => resolve(!err)))
}

// the town's modules, from hooks/town, as the browser loads them: types stripped, './x' imports as './x.js'
const modules = new Map()
const TOWN = ['world', 'kit', 'people', 'buildings', 'places', 'scenery', 'kinds', 'works']
async function townModule(name) {
  const file = path.join(here, '..', 'hooks', 'town', `${name}.ts`)
  const { mtimeMs } = await fs.stat(file)
  const had = modules.get(name)
  if (had?.mtime === mtimeMs) return had.code
  const code = stripTypeScriptTypes(await fs.readFile(file, 'utf8')).replace(/(from\s+['"])\.\/([a-z]+)(['"])/g, '$1./$2.js$3')
  modules.set(name, { mtime: mtimeMs, code })
  return code
}

const send = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

const body = req =>
  new Promise(resolve => {
    let data = ''
    req.on('data', c => (data += c).length > 20_000 && req.destroy())
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'))
      } catch {
        resolve({})
      }
    })
  })

http
  .createServer(async (req, res) => {
    lastHit = Date.now()
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', await fs.readFile(path.join(here, 'index.html')))
      const mod = /^\/([a-z]+)\.js$/.exec(url.pathname)?.[1]
      if (req.method === 'GET' && mod && TOWN.includes(mod)) return send(res, 200, 'text/javascript', await townModule(mod))
      if (req.method === 'GET' && url.pathname === '/api/snap') return send(res, 200, 'application/json', JSON.stringify(await snapshot(url.searchParams.get('task'), url.searchParams.get('demo') === '1', { town: url.searchParams.get('town') ?? '', project: url.searchParams.get('project') ?? '' })))
      if (req.method === 'POST' && url.pathname === '/api/order') {
        const { id, kind, text } = await body(req)
        if (String(id).startsWith('d') && String(id).length === 2) return send(res, 200, 'application/json', JSON.stringify({ ok: false, error: 'That is the demo crew: start a /crew-task to give real orders.' }))
        const all = (await readDir(path.join(root, 'sessions'))).filter(s => !s.ended && s.task)
        const member = all.find(s => s.id === id)
        if (!member) return send(res, 404, 'application/json', JSON.stringify({ ok: false, error: 'That member is no longer in a task.' }))
        if (kind === 'focus') return send(res, 200, 'application/json', JSON.stringify({ ok: member.tty ? await raise(member.tty) : false }))
        if (kind === 'work' && !String(text ?? '').trim()) return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'Say what to work on.' }))
        await fs.mkdir(path.join(root, 'orders'), { recursive: true })
        await fs.writeFile(path.join(root, 'orders', `${id}.json`), JSON.stringify({ at: Date.now(), text: orderText(kind, member, String(text ?? '').trim()) }))
        return send(res, 200, 'application/json', JSON.stringify({ ok: true }))
      }
      send(res, 404, 'text/plain', 'not found')
    } catch (err) {
      send(res, 500, 'text/plain', String(err))
    }
  })
  .listen(PORT, '127.0.0.1')
