// Strategies: how a crew task is set up. Which roles, how many sessions each, what each does,
// which model each runs on, and who advises whom. Pure: no `$`.

export type Tier = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'inherit'
export type Effort = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Role = {
  id: string
  name: string
  /** lead: the one who started the task; worker: does the work; advisor: is consulted by others. */
  kind: 'lead' | 'worker' | 'advisor'
  model: Tier
  effort: Effort
  /** How many sessions take this role (the lead is always one). */
  count: number
  duty: string
  /** The ids of the roles this one advises (advisors) or reports to (workers; the lead when empty). */
  links: string[]
}

export type Strategy = {
  v: 2
  id: string
  name: string
  description: string
  roles: Role[]
  builtIn?: boolean
  updatedAt: number
}

export const TIERS: Tier[] = ['fable', 'opus', 'sonnet', 'haiku', 'inherit']
export const EFFORTS: Effort[] = ['', 'low', 'medium', 'high', 'xhigh', 'max']

const R = (id: string, name: string, kind: Role['kind'], model: Tier, effort: Effort, count: number, duty: string, links: string[] = []): Role =>
  ({ id, name, kind, model, effort, count, duty, links })

export const TEMPLATES: Strategy[] = [
  {
    v: 2, id: 'duo', name: 'Duo', builtIn: true, updatedAt: 0,
    description: 'A lead who plans and reviews, one implementer who builds.',
    roles: [
      R('lead', 'Lead', 'lead', 'opus', 'high', 1, 'Plans the work, reviews every change, decides when it is done.'),
      R('impl', 'Implementer', 'worker', 'sonnet', 'high', 1, 'Builds what the lead plans, runs the tests, reports back.'),
    ],
  },
  {
    v: 2, id: 'feature-team', name: 'Feature team', builtIn: true, updatedAt: 0,
    description: 'Two implementers with their own implementation advisor, and a tester.',
    roles: [
      R('lead', 'Lead', 'lead', 'sonnet', 'high', 1, 'Splits the task into features, hands them out, merges the results.'),
      R('impl', 'Implementer', 'worker', 'sonnet', 'high', 2, 'Builds one feature at a time; asks the implementation advisor before big design choices.'),
      R('test', 'Tester', 'worker', 'haiku', 'medium', 1, 'Writes and runs tests for each finished feature, reports failures.'),
      R('impl-adv', 'Implementation advisor', 'advisor', 'opus', 'high', 1, 'Reviews designs and tricky code for the implementers; answers, does not edit.', ['impl']),
    ],
  },
  {
    v: 2, id: 'safe-hands', name: 'Safe hands', builtIn: true, updatedAt: 0,
    description: 'Quality first: an implementer watched by a security advisor and a code reviewer.',
    roles: [
      R('lead', 'Lead', 'lead', 'opus', 'high', 1, 'Owns the plan and the final call; nothing ships without both advisors.'),
      R('impl', 'Implementer', 'worker', 'sonnet', 'high', 1, 'Makes small, careful changes and asks both advisors before calling them done.'),
      R('sec', 'Security advisor', 'advisor', 'opus', 'high', 1, 'Checks every change for auth, data and injection problems.', ['impl']),
      R('review', 'Code reviewer', 'advisor', 'sonnet', 'high', 1, 'Reviews diffs for correctness, tests and readability.', ['impl']),
    ],
  },
  {
    v: 2, id: 'swarm', name: 'Swarm', builtIn: true, updatedAt: 0,
    description: 'Many implementers in parallel, an architect advising the lead, a tester on the merges.',
    roles: [
      R('lead', 'Lead', 'lead', 'opus', 'high', 1, 'Splits the task into independent pieces, one per implementer; keeps the big picture.'),
      R('impl', 'Implementer', 'worker', 'sonnet', 'medium', 3, 'Owns one piece end to end, keeps diffs small, merges often.'),
      R('test', 'Tester', 'worker', 'haiku', 'medium', 1, 'Runs the suite after every merge and reports what broke.'),
      R('arch', 'Architect', 'advisor', 'opus', 'max', 1, 'Advises the lead on structure and boundaries before pieces are handed out.', ['lead']),
    ],
  },
]

export const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'strategy'
const str = (v: unknown, n: number) => String(v ?? '').slice(0, n)
const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d)

/** Holds a strategy (from disk, the person or a model) to its shape: one lead, known models, known links. */
export function clean(raw: unknown): Strategy {
  const s = (raw ?? {}) as Partial<Strategy>
  const rolesIn = Array.isArray(s.roles) ? s.roles.slice(0, 12) : []
  const ids = new Set<string>()
  let roles: Role[] = rolesIn.map((r, i) => {
    const name = str(r?.name, 32).trim() || `Role ${i + 1}`
    let id = slug(str(r?.id, 40) || name)
    while (ids.has(id)) id += '-2'
    ids.add(id)
    const kind = pick(r?.kind, ['lead', 'worker', 'advisor'] as const, 'worker')
    return {
      id, name, kind, model: pick(r?.model, TIERS, 'inherit'), effort: pick(r?.effort, EFFORTS, ''),
      count: kind === 'lead' ? 1 : Math.max(1, Math.min(6, Math.round(Number(r?.count) || 1))),
      duty: str(r?.duty, 300), links: Array.isArray(r?.links) ? r.links.map(l => slug(String(l))) : [],
    }
  })
  // exactly one lead, first
  const leads = roles.filter(r => r.kind === 'lead')
  if (leads.length === 0) roles = [R('lead', 'Lead', 'lead', 'inherit', '', 1, 'Coordinates the crew and owns the result.'), ...roles]
  else roles = [leads[0] as Role, ...roles.filter(r => r !== leads[0]).map(r => (r.kind === 'lead' ? { ...r, kind: 'worker' as const } : r))]
  const known = new Set(roles.map(r => r.id))
  roles = roles.map(r => ({ ...r, links: r.kind === 'lead' ? [] : [...new Set(r.links.filter(l => known.has(l) && l !== r.id))] }))
  return {
    v: 2, id: slug(str(s.id, 40) || str(s.name, 60) || 'strategy'), name: str(s.name, 60).trim() || 'Untitled',
    description: str(s.description, 300), roles, builtIn: !!s.builtIn, updatedAt: Date.now(),
  }
}

export const sessionsIn = (s: Strategy) => s.roles.reduce((n, r) => n + (r.kind === 'lead' ? 0 : r.count), 0)

/** The strategy of a task started as a single session: its lead alone. */
export const leadAlone = (name: string): Strategy =>
  clean({ id: slug(name), name, description: 'Started as a single session.', roles: [{ kind: 'lead', name: 'Lead', duty: 'Coordinates the crew and owns the result.' }] })

/** The same crew with one more session of a role. */
export const withOneMore = (s: Strategy, roleId: string): Strategy => ({ ...s, roles: s.roles.map(r => (r.id === roleId ? { ...r, count: Math.min(6, r.count + 1) } : r)) })

/**
 * The sessions a change to a running crew's strategy opens: a role new to it, or more of one it has (by id, else by
 * name). Fewer sessions of a role close none: members leave on their own.
 */
export function added(base: Strategy, next: Strategy): { role: Role; add: number }[] {
  const was = (r: Role) => base.roles.find(b => b.id === r.id) ?? base.roles.find(b => b.name.toLowerCase() === r.name.toLowerCase())
  return next.roles.filter(r => r.kind !== 'lead').map(r => ({ role: r, add: r.count - (was(r)?.count ?? 0) })).filter(x => x.add > 0)
}

export const modelText = (r: Role) => `${r.model === 'inherit' ? 'same model' : r.model}${r.effort ? ` · ${r.effort}` : ''}`

// ---- the diagram: boxes for roles, lines for who reports to whom and who advises whom.
// Every line it returns fits `width` columns: the crew side by side when it fits, the boxes stacked
// in one column when it does not, and a plain list on the narrowest panes.

const glyphs = (t: string) => [...t]
const cut = (t: string, n: number) => (n <= 0 ? '' : glyphs(t).length > n ? glyphs(t).slice(0, Math.max(0, n - 1)).join('') + '…' : t)

const titleOf = (r: Role) => `${r.kind === 'lead' ? '★ ' : r.kind === 'advisor' ? '◆ ' : ''}${r.count > 1 ? `${r.count}× ` : ''}${r.name}`

/** Whom an advisor advises, by name. */
export function advisesOf(s: Strategy, r: Role) {
  const names = r.links.map(l => s.roles.find(x => x.id === l)?.name).filter((n): n is string => !!n)
  return names.length ? names.join(', ') : (s.roles[0]?.name ?? 'the lead')
}

const linesOf = (s: Strategy, r: Role) => [titleOf(r), modelText(r), ...(r.kind === 'advisor' ? [`advises ${advisesOf(s, r)}`] : [])]

const U = 1, D = 2, LF = 4, RT = 8
const SOLID: Record<number, string> = {
  [U]: '│', [D]: '│', [U | D]: '│', [LF]: '─', [RT]: '─', [LF | RT]: '─',
  [D | RT]: '┌', [D | LF]: '┐', [U | RT]: '└', [U | LF]: '┘',
  [U | D | RT]: '├', [U | D | LF]: '┤', [D | LF | RT]: '┬', [U | LF | RT]: '┴', [U | D | LF | RT]: '┼',
}
const DASHED: Record<number, string> = {
  ...SOLID, [U]: '┆', [D]: '┆', [U | D]: '┆', [LF]: '┄', [RT]: '┄', [LF | RT]: '┄',
  [D | RT]: '╭', [D | LF]: '╮', [U | RT]: '╰', [U | LF]: '╯',
}

/** A grid of characters with lines kept as directions per cell, so joins and crossings get the right glyph. */
class Sketch {
  private grid: string[][] = []
  private lines = [new Map<string, number>(), new Map<string, number>()]

  put(x: number, y: number, ch: string) {
    while (this.grid.length <= y) this.grid.push([])
    const row = this.grid[y] as string[]
    while (row.length <= x) row.push(' ')
    row[x] = ch
  }

  text(x: number, y: number, t: string) {
    glyphs(t).forEach((c, i) => this.put(x + i, y, c))
  }

  /** A box `w` wide around the lines; returns its height. */
  box(x: number, y: number, w: number, lines: string[]) {
    this.text(x, y, '┌' + '─'.repeat(w - 2) + '┐')
    lines.forEach((t, i) => this.text(x, y + 1 + i, '│ ' + cut(t, w - 4).padEnd(w - 4) + ' │'))
    this.text(x, y + 1 + lines.length, '└' + '─'.repeat(w - 2) + '┘')
    return lines.length + 2
  }

  mark(dashed: boolean, x: number, y: number, f: number) {
    const m = this.lines[dashed ? 1 : 0] as Map<string, number>
    m.set(`${x},${y}`, (m.get(`${x},${y}`) ?? 0) | f)
  }

  /** A line down from (x, y0) to (x, y1), open at both ends. */
  down(dashed: boolean, x: number, y0: number, y1: number) {
    for (let y = y0; y <= y1; y++) this.mark(dashed, x, y, U | D)
  }

  /** A bus along row y between the outermost of xs, each x joined from above (ups) or below (downs). */
  bus(dashed: boolean, y: number, ups: number[], downs: number[]) {
    const xs = [...ups, ...downs]
    const lo = Math.min(...xs)
    const hi = Math.max(...xs)
    for (let x = lo; x <= hi; x++) this.mark(dashed, x, y, (x > lo ? LF : 0) | (x < hi ? RT : 0))
    for (const x of ups) this.mark(dashed, x, y, U)
    for (const x of downs) this.mark(dashed, x, y, D)
  }

  done(): string[] {
    this.lines.forEach((m, k) => {
      for (const [key, f] of m) {
        const [x, y] = key.split(',').map(Number) as [number, number]
        if ((this.grid[y]?.[x] ?? ' ') === ' ') this.put(x, y, (k ? DASHED : SOLID)[f] ?? '┼')
      }
    })
    return this.grid.map(r => r.join('').replace(/\s+$/, ''))
  }
}

const boxWidth = (s: Strategy) => Math.max(...s.roles.map(r => Math.max(...linesOf(s, r).map(t => glyphs(t).length)))) + 4

/** The lead on top, its workers side by side under it, each worker's advisors under that worker. */
function tree(s: Strategy, width: number, narrowest: number): string[] | null {
  const [lead, ...rest] = s.roles
  if (!lead) return []
  const workers = rest.filter(r => r.kind === 'worker')
  const advisors = rest.filter(r => r.kind === 'advisor')
  const firstWorker = (a: Role) => workers.findIndex(w => a.links.includes(w.id))
  const byLead = advisors.filter(a => firstWorker(a) < 0)
  const groups = workers.map((_, i) => advisors.filter(a => firstWorker(a) === i))
  const gap = 2
  const side = 5
  for (let bw = Math.min(30, Math.max(16, boxWidth(s))); bw >= narrowest; bw--) {
    const mid = (x: number) => x + Math.floor(bw / 2)
    const wx = workers.map((_, i) => i * (bw + gap))
    const wRow = workers.length ? (wx[wx.length - 1] ?? 0) + bw : bw
    const leadRow = bw + byLead.length * (bw + side)
    const lx = Math.max(0, Math.min(Math.floor((wRow - bw) / 2), Math.max(wRow, width) - leadRow))
    const lax = byLead.map((_, k) => lx + bw + side + k * (bw + side))
    // advisors under the first worker they advise, pushed right when a neighbour's are in the way
    let end = -gap - 1
    let lastHi = -Infinity
    let joined = true
    const ax = groups.map((g, i) => {
      if (!g.length) return []
      const w = g.length * bw + (g.length - 1) * gap
      const x0 = Math.max(mid(wx[i] ?? 0) - Math.floor(w / 2), end + gap + 1, 0)
      const xs = g.map((_, k) => x0 + k * (bw + gap))
      end = (xs[xs.length - 1] ?? 0) + bw - 1
      const spots = [mid(wx[i] ?? 0), ...xs.map(mid)]
      if (Math.min(...spots) <= lastHi + 1) joined = false
      lastHi = Math.max(...spots)
      return xs
    })
    const all = [lx, ...lax, ...wx, ...ax.flat()]
    if (Math.max(...all) + bw > width) continue

    const sk = new Sketch()
    const leadH = sk.box(lx, 0, bw, linesOf(s, lead))
    let rowH = leadH
    byLead.forEach((a, k) => {
      rowH = Math.max(rowH, sk.box(lax[k] ?? 0, 0, bw, linesOf(s, a)))
      const from = k === 0 ? lx + bw : (lax[k - 1] ?? 0) + bw
      sk.text(from, 1, (k === 0 ? '◀' : '┄') + '┄'.repeat(Math.max(0, (lax[k] ?? 0) - from - 1)))
    })
    if (!workers.length) return sk.done()
    const busY = rowH
    const wy = busY + 2
    sk.put(mid(lx), leadH - 1, '┬')
    sk.down(false, mid(lx), leadH, busY - 1)
    sk.bus(false, busY, [mid(lx)], wx.map(mid))
    for (const x of wx) sk.put(mid(x), busY + 1, '▼')
    const wH = Math.max(...workers.map((w, i) => sk.box(wx[i] ?? 0, wy, bw, linesOf(s, w))))
    const ay = wy + wH + 1
    groups.forEach((g, i) => {
      const xs = ax[i] ?? []
      g.forEach((a, k) => sk.box(xs[k] ?? 0, ay, bw, linesOf(s, a)))
      if (!g.length || !joined) return
      const from = mid(wx[i] ?? 0)
      sk.put(from, wy + wH - 1, '┬')
      sk.bus(true, ay - 1, [from], xs.map(mid))
      for (const x of xs) sk.put(mid(x), ay, '┴')
    })
    return sk.done()
  }
  return null
}

/** Every box in one column: the lead first, its workers hung off a line on the left, then the advisors. */
function column(s: Strategy, width: number): string[] | null {
  const [lead, ...rest] = s.roles
  if (!lead) return []
  const bw = Math.min(30, boxWidth(s), width - 4)
  if (bw < 12) return null
  const workers = rest.filter(r => r.kind === 'worker')
  const advisors = rest.filter(r => r.kind === 'advisor')
  const sk = new Sketch()
  let y = sk.box(0, 0, bw, linesOf(s, lead))
  if (workers.length) sk.put(2, y - 1, '┬')
  workers.forEach((w, i) => {
    const last = i === workers.length - 1
    sk.down(false, 2, y, y)
    const h = sk.box(4, y, bw, linesOf(s, w))
    sk.text(2, y + 1, (last ? '└' : '├') + '▶')
    if (!last) sk.down(false, 2, y + 2, y + h - 1)
    y += h
  })
  if (advisors.length) {
    sk.text(2, y, 'advisors')
    y += 1
    for (const a of advisors) y += sk.box(2, y, bw, linesOf(s, a))
  }
  return sk.done()
}

/** One line per role, for the narrowest panes. */
function list(s: Strategy): string[] {
  const [lead, ...rest] = s.roles
  if (!lead) return []
  const workers = rest.filter(r => r.kind === 'worker')
  return [
    `${titleOf(lead)} · ${modelText(lead)}`,
    ...workers.map((w, i) => `${i === workers.length - 1 ? '└' : '├'} ${titleOf(w)} · ${modelText(w)}`),
    ...rest.filter(r => r.kind === 'advisor').map(a => `${titleOf(a)} → ${advisesOf(s, a)} · ${modelText(a)}`),
  ]
}

/** Draws a strategy as boxes and lines, never wider than `width` columns. */
export function diagram(s: Strategy, width = 100): string[] {
  const w = Math.max(8, Math.floor(width))
  // a tree that cuts a word or two off, else whole words stacked in a column, else a tree cut to fit
  const roomy = Math.max(14, Math.min(30, boxWidth(s)) - 4)
  return (tree(s, w, roomy) ?? column(s, w) ?? tree(s, w, 12) ?? list(s)).map(l => cut(l, w))
}

/** One role on one line: its name, how many, its model, and whom it advises. */
export const roleLine = (s: Strategy, r: Role) =>
  `${titleOf(r)} · ${modelText(r)}${r.kind === 'advisor' ? ` → ${advisesOf(s, r)}` : ''}`

/** A strategy with only a lead, to build up from nothing. */
export const BLANK: Strategy = {
  v: 2, id: 'blank', name: 'Just a lead', description: 'Only the lead to start with: add the roles you want.', updatedAt: 0,
  roles: [R('lead', 'Lead', 'lead', 'inherit', '', 1, 'Coordinates the crew and owns the result.')],
}

/** One line per role, for places with no room for the diagram. */
export function summary(s: Strategy): string {
  return s.roles.map(r => `${r.kind === 'lead' ? '★ ' : ''}${r.count > 1 ? `${r.count}× ` : ''}${r.name} (${modelText(r)})`).join(' · ')
}

/** What one member reads about the team: its own duty, who it reports to, who advises it, whom it advises. */
export function brief(s: Strategy, roleId: string, extra?: Role): string {
  const roles = extra ? [...s.roles, extra] : s.roles
  const me = roles.find(r => r.id === roleId)
  if (!me) return `Strategy "${s.name}": ${summary(s)}`
  const name = (id: string) => roles.find(r => r.id === id)?.name ?? id
  const advisedBy = roles.filter(r => r.kind === 'advisor' && r.links.includes(me.id)).map(r => r.name)
  const lines = [
    `Strategy "${s.name}": ${s.description}`,
    `Team: ${summary({ ...s, roles })}.`,
    `Your role: ${me.name}. ${me.duty}`,
  ]
  if (me.kind === 'lead') {
    lines.push('You started this task: hand work to the roles below with mcp__crewser__post, follow up, and decide when it is done.')
    for (const r of roles.filter(x => x.kind !== 'lead')) lines.push(`- ${r.count > 1 ? `${r.count}× ` : ''}${r.name}: ${r.duty}`)
  } else if (me.kind === 'advisor') {
    lines.push(`You advise: ${me.links.length ? me.links.map(name).join(', ') : 'the lead'}. Answer their questions and review what they send you; do not edit files unless asked.`)
  } else {
    lines.push(`You report to: ${me.links.filter(l => roles.find(r => r.id === l)?.kind !== 'advisor').map(name).join(', ') || 'the lead'}.`)
  }
  if (advisedBy.length) lines.push(`Ask ${advisedBy.join(' and ')} (with mcp__crewser__post, by name) before big decisions and before calling your work done.`)
  return lines.join('\n')
}

/** The prompt that turns a person's one-line description into a strategy. */
export function parsePrompt(description: string) {
  return (
    'Turn this description of a Claude Code team into JSON. Reply with the JSON only.\n' +
    'Shape: {"name": short name, "description": one sentence, "roles": [{"name", "kind": "lead"|"worker"|"advisor", ' +
    '"model": "fable"|"opus"|"sonnet"|"haiku"|"inherit", "effort": ""|"low"|"medium"|"high"|"xhigh"|"max", "count": number, "duty": one sentence, ' +
    '"links": [names of the roles an advisor advises, or a worker reports to]}]}.\n' +
    'Exactly one lead. Advisors are separate sessions others consult. Use "inherit" when no model is named.\n\n' +
    `Description: ${description}`
  )
}

/** The prompt that changes a strategy as the person asks in words ("add a Fable advisor to the lead and two UI testers"). */
export function changePrompt(s: Strategy, request: string) {
  const name = (id: string) => s.roles.find(r => r.id === id)?.name ?? id
  const shown = {
    name: s.name, description: s.description,
    roles: s.roles.map(r => ({ name: r.name, kind: r.kind, model: r.model, effort: r.effort, count: r.count, duty: r.duty, links: r.links.map(name) })),
  }
  return (
    'Here is a Claude Code team (a crew strategy) as JSON. Change it as asked and reply with the whole updated JSON only, in the same shape.\n' +
    'Keep everything the request does not mention. Exactly one lead. kind: "lead"|"worker"|"advisor" (advisors are separate sessions others consult). ' +
    'model: "fable"|"opus"|"sonnet"|"haiku"|"inherit" (inherit: the same model as the lead). effort: ""|"low"|"medium"|"high"|"xhigh"|"max". ' +
    'count: how many sessions take the role, 1 to 6 (two extra of a role that exists: raise its count). ' +
    'links: the names of the roles an advisor advises, or a worker reports to. Give every new role a one-sentence duty. ' +
    'Update the description to match; keep the name unless asked to rename it.\n\n' +
    `Team: ${JSON.stringify(shown)}\n\nChange: ${request}`
  )
}

/** Pulls the JSON object out of a model's reply, links given by name turned into ids. */
export function fromReply(reply: string): Strategy | null {
  const at = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (at < 0 || end <= at) return null
  try {
    const raw = JSON.parse(reply.slice(at, end + 1)) as { roles?: { name?: string; links?: string[] }[] }
    const byName = new Map((raw.roles ?? []).map(r => [String(r.name ?? '').toLowerCase(), slug(String(r.name ?? ''))]))
    for (const r of raw.roles ?? []) r.links = (r.links ?? []).map(l => byName.get(String(l).toLowerCase()) ?? slug(String(l)))
    return clean(raw)
  } catch {
    return null
  }
}
