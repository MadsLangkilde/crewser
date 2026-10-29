// The town's books: one small JSON file per building, kept with the project (`.crewser/town/`) so it is
// committed, shared and merged like code. Two people who change the same building get a git conflict in
// that one file; reading it takes both sides and merges them (every finished level kept, the newest
// status), so a merged town never loses work and never breaks. Pure: no `$`, no imports (the window's
// server loads this file as it is).

export type Ledger = {
  v: 2
  name: string
  kind?: string
  parent?: string
  crop?: string
  status: 'building' | 'done' | 'removed'
  /** When it was first started: the oldest keeps its spot when two claim the same ground. */
  since: number
  /** When its status last changed, and by whom, in whose color. */
  at: number
  by: string
  color: string
  /** Where it stands, from the castle's middle and the map's top. */
  dx?: number
  dy?: number
  /** One id per time it was finished (`<when>-<random>`): its level is how many, and a merge keeps everyone's. */
  levels: string[]
  /** When it last burnt down: levels from before do not count again if it is rebuilt. */
  cleared?: number
}

/** A building as the town view draws it. */
export type Built = {
  name: string; level: number; status: 'building' | 'done' | 'removed'; at: number; color: string; by: string
  kind?: string; parent?: string; crop?: string; dx?: number; dy?: number; since?: number
}

const CONFLICT = /^(<{7}|\|{7}|={7}|>{7})(\s|$)/

/** Both sides of a file git left conflict markers in: [ours, theirs]; null when it has none. */
export function sides(text: string): [string, string] | null {
  if (!text.split('\n').some(l => CONFLICT.test(l))) return null
  const ours: string[] = []
  const theirs: string[] = []
  let at: 'both' | 'ours' | 'base' | 'theirs' = 'both'
  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<<')) at = 'ours'
    else if (line.startsWith('|||||||') && at === 'ours') at = 'base'
    else if (line.startsWith('=======') && (at === 'ours' || at === 'base')) at = 'theirs'
    else if (line.startsWith('>>>>>>>') && at === 'theirs') at = 'both'
    else {
      if (at === 'both' || at === 'ours') ours.push(line)
      if (at === 'both' || at === 'theirs') theirs.push(line)
    }
  }
  return [ours.join('\n'), theirs.join('\n')]
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const txt = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

/** Holds whatever is in a file to the ledger's shape; a town file from before (`level`, no `levels`) comes along. */
export function shape(raw: unknown): Ledger | null {
  const r = (raw ?? {}) as Record<string, unknown>
  const name = txt(r.name)?.trim()
  if (!name) return null
  const at = num(r.at) ?? 0
  const levels = Array.isArray(r.levels)
    ? [...new Set(r.levels.filter((l): l is string => typeof l === 'string'))]
    : Array.from({ length: Math.max(0, Math.round(num(r.level) ?? 0)) }, (_, i) => `${at}-old${i + 1}`)
  const status = r.status === 'building' || r.status === 'removed' ? r.status : 'done'
  const out: Ledger = {
    v: 2, name, status, since: num(r.since) ?? at, at, by: txt(r.by) ?? '', color: txt(r.color) ?? '#8a8a8a', levels,
  }
  for (const k of ['kind', 'parent', 'crop'] as const) if (txt(r[k])) out[k] = txt(r[k])
  if (num(r.dx) !== undefined && num(r.dy) !== undefined) (out.dx = num(r.dx)), (out.dy = num(r.dy))
  if (num(r.cleared)) out.cleared = num(r.cleared)
  return out
}

const levelAt = (id: string) => Number(id.split('-')[0]) || 0

/**
 * Two versions of one building made into one: its newest status, every level either side finished (none from
 * before it last burnt down), what it is and where it stands from the side that built it first.
 */
export function merge(a: Ledger, b: Ledger): Ledger {
  const newest = b.at > a.at ? b : a
  const first = b.since < a.since ? b : a
  const other = first === a ? b : a
  const cleared = Math.max(a.cleared ?? 0, b.cleared ?? 0) || undefined
  const levels = [...new Set([...a.levels, ...b.levels])].filter(l => !cleared || newest.status === 'removed' || levelAt(l) > cleared)
  const out: Ledger = {
    ...other, ...first, status: newest.status, at: newest.at, by: newest.by, color: newest.color,
    since: Math.min(a.since, b.since), levels,
  }
  if (cleared) out.cleared = cleared
  else delete out.cleared
  if (first.dx === undefined && other.dx !== undefined) (out.dx = other.dx), (out.dy = other.dy)
  return out
}

/** A building's file read: merged when git left both sides in it (`merged`, so the caller writes it back clean). */
export function read(text: string): { ledger: Ledger | null; merged: boolean } {
  const both = sides(text)
  const parse = (t: string) => {
    try {
      return shape(JSON.parse(t))
    } catch {
      return null
    }
  }
  if (!both) return { ledger: parse(text), merged: false }
  const [ours, theirs] = both.map(parse)
  if (ours && theirs) return { ledger: merge(ours, theirs), merged: true }
  return { ledger: ours ?? theirs ?? null, merged: true }
}

/** One element per line, so two people's new levels land on lines of their own. */
export const write = (l: Ledger) => JSON.stringify(l, null, 2) + '\n'

/** A ledger as the town draws it. */
export const built = (l: Ledger): Built => {
  const { levels, cleared: _c, v: _v, ...rest } = l
  return { ...rest, level: levels.length }
}

/** A building's file name: its name made safe, a number on it when another building has that file. */
export function fileFor(name: string, taken: ReadonlyMap<string, string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'building'
  for (let n = 1; ; n++) {
    const file = `${n > 1 ? `${base}-${n}` : base}.json`
    const owner = taken.get(file)
    if (!owner || owner.toLowerCase() === name.toLowerCase()) return file
  }
}

/** A new level's id: when it was finished, and a few random letters so two finished at once are two. */
export const levelId = (t: number) => `${Math.round(t)}-${Math.random().toString(36).slice(2, 7)}`

/** What happens to a building when a feature is started, finished or dropped; `was` is its ledger or null. */
export function record(
  was: Ledger | null,
  name: string,
  status: 'building' | 'done' | 'removed',
  t: number,
  who: { by: string; color: string },
  what: { kind?: string; parent?: string; crop?: string } = {},
): Ledger | null {
  const alive = was && was.status !== 'removed' ? was : null
  if (status === 'removed') return alive ? { ...alive, status, at: t, by: who.by, cleared: t } : null
  // a building that burnt down starts over: no levels, a new spot
  const base: Ledger = alive ?? {
    v: 2, name, status, since: t, at: t, by: who.by, color: who.color, levels: [],
    ...(was?.cleared ? { cleared: was.cleared } : {}),
  }
  const next: Ledger = { ...base, status, at: t, by: who.by, color: who.color }
  if (!base.kind) for (const k of ['kind', 'parent', 'crop'] as const) if (what[k]) next[k] = what[k]
  if (status === 'done' && (!alive || alive.status === 'building' || alive.levels.length === 0)) next.levels = [...base.levels, levelId(t)]
  return next
}
