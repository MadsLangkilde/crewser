import { expect, mock, test } from 'claude-code/testing'

import { C, Pen } from '../hooks/town/kit'
import * as Ledger from '../hooks/town/ledger'
import { mine, MINE } from '../hooks/town/places'
import { World } from '../hooks/town/world'
import type { CrewSession } from '../hooks/town/world'

const task = { id: 't', name: 'demo', role: 'Lead', lead: 'Mads' }
const session = (id: string, extra: Partial<CrewSession> = {}): CrewSession => ({
  id, name: id, color: '#e5484d', project: 'app', status: 'idle', tool: '', lastPrompt: '', startedAt: 0,
  task, agents: [], posts: [], features: [], attention: false, five: 30, week: 10, ...extra,
})

const crew = () => [
  session('Mads', { features: [{ id: 'f', name: 'Login', status: 'building', at: 0 }] }),
  session('Tester #1', { task: { ...task, role: 'Tester' }, status: 'working', tool: 'Bash', detail: 'running npm test',
    agents: [{ id: 'a1', kind: 'Explore', desc: 'scout', at: 0 }] }),
]

test('the world draws every cell of its grid', async () => {
  const w = new World()
  w.resize(100, 30)
  w.sync({ sessions: crew(), now: 100 })
  for (let t = 100; t < 5000; t += 200) w.step(t, 200)
  expect(w.render().length).toBe(Math.ceil((100 * 30 * 12) / 3) * 4)
})

test('the town is taller than the view and scrolls within it', async () => {
  const w = new World()
  w.resize(100, 20)
  w.sync({ sessions: crew(), now: 100 })
  const { rows, view } = w.scrollInfo
  expect(rows).toBeGreaterThan(view)
  w.scroll(-10_000)
  expect(w.scrollInfo.top).toBe(0)
  expect(w.scroll(-5)).toBe(false)
  expect(w.scroll(8)).toBe(true)
  expect(w.scrollInfo.top).toBe(8)
  w.scroll(10_000)
  expect(w.scrollInfo.top).toBe(rows - view)
  const { width, cols } = w.scrollInfo
  expect(width).toBeGreaterThan(cols)
  w.scroll(0, -10_000)
  expect(w.scrollInfo.left).toBe(0)
  w.scroll(0, 10_000)
  expect(w.scrollInfo.left).toBe(width - cols)
  expect(w.render().length).toBe(Math.ceil((100 * 20 * 12) / 3) * 4)
})

test('the view zooms out over more of the town and back in', async () => {
  const w = new World()
  w.resize(100, 20)
  w.sync({ sessions: crew(), now: 100 })
  const near = w.scrollInfo
  w.setZoom(0.5)
  const far = w.scrollInfo
  expect(far.view).toBeGreaterThan(near.view)
  expect(far.cols).toBeGreaterThan(near.cols)
  expect(w.render().length).toBe(Math.ceil((100 * 20 * 12) / 3) * 4)
  w.setZoom(1)
  expect(w.scrollInfo.cols).toBe(near.cols)
  expect(w.render().length).toBe(Math.ceil((100 * 20 * 12) / 3) * 4)
})

test('a dropped feature burns down, then its plot is free', async () => {
  const w = new World()
  w.minZoom = 0.5
  w.resize(120, 44)
  w.setZoom(0.5)
  const town = (status: 'done' | 'removed', at: number) => [
    { name: 'Login', level: 1, status: 'done' as const, at: 0, color: '#9b7fe0', by: 'Mads' },
    { name: 'Wishlist', level: 1, status, at, color: '#3fb950', by: 'Mads' },
  ]
  w.sync({ sessions: crew(), now: 1000, town: town('done', 0) })
  expect(screenText(w.render())).toContain('Wishlist')
  // the removal: flames now, ruins later, gone after the fire
  w.sync({ sessions: crew(), now: 2000, town: town('removed', 2000) })
  for (let t = 2000; t < 8000; t += 250) w.step(t, 250)
  const burning = w.render()
  expect(burning.length).toBe(Math.ceil((120 * 44 * 12) / 3) * 4)
  expect(screenText(burning)).toContain('on fire')
  for (let t = 8000; t < 40_000; t += 250) w.step(t, 250)
  w.sync({ sessions: crew(), now: 40_000, town: town('removed', 2000) })
  expect(screenText(w.render())).not.toContain('Wishlist')
  // long gone when the town opens: not drawn at all
  const fresh = new World()
  fresh.minZoom = 0.5
  fresh.resize(120, 44)
  fresh.setZoom(0.5)
  fresh.sync({ sessions: crew(), now: 600_000, town: town('removed', 2000) })
  expect(screenText(fresh.render())).not.toContain('Wishlist')
})

/** The characters a frame of cells shows, row after row. */
function screenText(b64: string) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const cells = new Uint32Array(bytes.buffer)
  return Array.from({ length: cells.length / 3 }, (_, i) => String.fromCodePoint(cells[i * 3] ?? 32)).join('')
}

test('the town places every feature as its kind, keeps where it stood, and has room for many', async () => {
  const w = new World()
  w.minZoom = 0.5
  w.resize(100, 30)
  const town = [
    { name: 'Login', level: 2, status: 'done' as const, at: 0, color: '#9b7fe0', by: 'Mads', kind: 'tower' },
    { name: 'Orders', level: 1, status: 'done' as const, at: 0, color: '#3fb950', by: 'Mads', kind: 'farm' },
    { name: 'Order list', level: 1, status: 'done' as const, at: 0, color: '#3fb950', by: 'Mads', kind: 'field', parent: 'Orders', crop: 'wheat' },
    { name: 'Stripe', level: 1, status: 'done' as const, at: 0, color: '#4f7cff', by: 'Mads', kind: 'dock' },
  ]
  w.sync({ sessions: crew().map(s => ({ ...s, features: s.name === 'Mads' ? [{ id: 'x', name: 'login', status: 'building' as const, at: 50 }] : [] })), now: 100, town })
  expect(w.render().length).toBe(Math.ceil((100 * 30 * 12) / 3) * 4)
  // every one got a spot, kept in the town's file from then on
  const spots = w.takePlacements()
  expect(spots.map(p => p.name).sort()).toEqual(['Login', 'Order list', 'Orders', 'Stripe'])
  const kept = town.map(b => ({ ...b, ...spots.find(p => p.name === b.name) }))
  const again = new World()
  again.minZoom = 0.5
  again.resize(160, 40)
  again.sync({ sessions: crew(), now: 100, town: kept })
  expect(again.takePlacements()).toEqual([])
  // forty more all find room
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `Feature ${i}`, level: 1, status: 'done' as const, at: i, color: '#e5484d', by: 'Mads' }))
  w.sync({ sessions: crew(), now: 200, town: [...kept, ...many] })
  expect(w.takePlacements().length).toBe(40)
  expect(w.render().length).toBe(Math.ceil((100 * 30 * 12) / 3) * 4)
})

test('a building two people changed merges: every level kept, the newest status, nothing broken', () => {
  const base = Ledger.record(null, 'Login', 'done', 100, { by: 'Mads', color: '#e5484d' }, { kind: 'house' })!
  const placed = { ...base, dx: 40, dy: 200 }
  // each finishes it again on their own machine
  const mine = Ledger.record(Ledger.record(placed, 'Login', 'building', 200, { by: 'Mads', color: '#e5484d' }), 'Login', 'done', 300, { by: 'Mads', color: '#e5484d' })!
  const theirs = Ledger.record(Ledger.record(placed, 'Login', 'building', 250, { by: 'Ana', color: '#4f7cff' }), 'Login', 'done', 400, { by: 'Ana', color: '#4f7cff' })!
  expect(mine.levels.length).toBe(2)
  // git leaves both sides in the file; reading it merges them
  const a = Ledger.write(mine).split('\n')
  const b = Ledger.write(theirs).split('\n')
  const conflicted = ['<<<<<<< HEAD', ...a, '=======', ...b, '>>>>>>> theirs'].join('\n')
  const { ledger, merged } = Ledger.read(conflicted)
  expect(merged).toBe(true)
  expect(ledger?.levels.length).toBe(3)
  expect(ledger).toMatchObject({ status: 'done', by: 'Ana', kind: 'house', dx: 40, dy: 200, since: 100 })
  expect(Ledger.built(ledger!).level).toBe(3)
  // a conflict in part of the file only, as git writes it
  const hunk = Ledger.write(mine).replace(/ {2}"by": "Mads",\n/, '<<<<<<< HEAD\n  "by": "Mads",\n=======\n  "by": "Ana",\n>>>>>>> theirs\n')
  expect(Ledger.read(hunk).ledger?.levels).toEqual(mine.levels)
  // burnt down after the other finished it: it stays burnt
  const burnt = Ledger.record(mine, 'Login', 'removed', 500, { by: 'Mads', color: '#e5484d' })!
  expect(Ledger.merge(burnt, theirs).status).toBe('removed')
  // rebuilt after it burnt: the levels from before do not count
  const again = Ledger.record(burnt, 'Login', 'done', 600, { by: 'Mads', color: '#e5484d' })!
  expect(again.levels.length).toBe(1)
  expect(again.dx).toBeUndefined()
  expect(Ledger.built(Ledger.merge(again, theirs)).level).toBe(1)
  // a town file from before comes along with its levels
  expect(Ledger.shape({ name: 'Old', level: 2, status: 'done', at: 5, color: '#fff', by: 'x' })?.levels.length).toBe(2)
  expect(Ledger.fileFor('Log in', new Map([['log-in.json', 'Log-in']]))).toBe('log-in-2.json')
})

test('two buildings merged onto the same spot: the older keeps it, the newer moves to free land nearby', () => {
  const w = new World()
  w.minZoom = 0.5
  w.resize(100, 30)
  const one = { name: 'Search', level: 1, status: 'done' as const, at: 0, color: '#9b7fe0', by: 'Mads', kind: 'house', since: 1 }
  w.sync({ sessions: crew(), now: 100, town: [one] })
  const [spot] = w.takePlacements()
  expect(spot).toBeDefined()
  const two = { ...one, name: 'Cart', by: 'Ana', since: 2, dx: spot!.dx, dy: spot!.dy }
  const fresh = new World()
  fresh.minZoom = 0.5
  fresh.resize(100, 30)
  fresh.sync({ sessions: crew(), now: 100, town: [{ ...one, dx: spot!.dx, dy: spot!.dy }, two] })
  const moved = fresh.takePlacements()
  const cart = moved.find(p => p.name === 'Cart')
  expect(moved.some(p => p.name === 'Search')).toBe(false)
  expect(cart).toBeDefined()
  expect(Math.hypot(cart!.dx - spot!.dx, cart!.dy - spot!.dy)).toBeLessThan(120)
})

test('with no crew at work (between tasks), the project\'s buildings still stand', () => {
  const w = new World()
  w.minZoom = 0.5
  w.resize(100, 30)
  const town = [
    { name: 'Time and PPS', level: 1, status: 'done' as const, at: 0, color: '#ff8700', by: 'Implementer #1', kind: 'house', since: 1 },
    { name: 'Score time column', level: 1, status: 'done' as const, at: 0, color: '#ff8700', by: 'Implementer #1', kind: 'house', since: 2 },
  ]
  w.sync({ sessions: [], now: 100, town, project: 'tetris' })
  expect(w.takePlacements().map(p => p.name).sort()).toEqual(['Score time column', 'Time and PPS'])
  expect(w.render().length).toBe(Math.ceil((100 * 30 * 12) / 3) * 4)
})

test('several crews at once: each gathers at a camp of its own, the overseer at the castle gate', () => {
  const w = new World()
  w.minZoom = 0.5
  w.resize(100, 30)
  const t = (id: string, role = 'Lead') => ({ id, name: `task ${id}`, role, lead: 'L' })
  const sessions = [
    session('a-lead', { task: t('a') }), session('a1', { task: t('a', 'Implementer') }),
    session('b-lead', { task: t('b'), startedAt: 5 }), session('b1', { task: t('b', 'Tester'), startedAt: 5 }),
    session('boss', { task: null, overseer: true }),
  ]
  w.sync({ sessions, now: 100, project: 'app' })
  const crews = w.crewList()
  expect(crews.map(c => c.id)).toEqual(['a', 'b'])
  expect(crews.every(c => c.camp)).toBe(true)
  for (let k = 100; k < 30_000; k += 200) w.step(k, 200)
  expect(w.render().length).toBe(Math.ceil((100 * 30 * 12) / 3) * 4)
  // one crew alone gathers round the spring, as before: no camps
  const one = new World()
  one.minZoom = 0.5
  one.resize(100, 30)
  one.sync({ sessions: sessions.filter(s => s.task?.id !== 'b'), now: 100 })
  expect(one.crewList().map(c => c.camp)).toEqual([false])
  // the camera goes to a crew
  w.focusCrew('b')
  expect(w.gliding).toBe(true)
})

test('a crew dresses in its lead\'s color; the lead wears the captain\'s hat, the overseer is the king', () => {
  const w = new World()
  w.minZoom = 0.5
  w.resize(100, 30)
  const t = (id: string, role = 'Lead') => ({ id, name: `task ${id}`, role, lead: 'L' })
  w.sync({
    sessions: [
      session('a-lead', { task: t('a'), color: '#4f7cff' }), session('a1', { task: t('a', 'Implementer'), color: '#3fb950' }),
      session('b-lead', { task: t('b'), color: '#ff8700', startedAt: 5 }), session('b1', { task: t('b', 'Security advisor'), color: '#c061cb', startedAt: 5 }),
      session('boss', { task: null, overseer: true, color: '#e5484d' }),
    ],
    now: 100, project: 'app',
  })
  const by = new Map(w.heroList().map(h => [h.id, h]))
  expect(by.get('a1')?.coat).toBe(0x4f7cff)
  expect(by.get('a-lead')?.coat).toBe(0x4f7cff)
  expect(by.get('b1')?.coat).toBe(0xff8700)
  expect([by.get('a-lead')?.role, by.get('a1')?.role, by.get('b1')?.role, by.get('boss')?.role]).toEqual(['lead', 'worker', 'sage', 'king'])
  for (let k = 100; k < 3000; k += 200) w.step(k, 200)
  expect(w.render().length).toBe(Math.ceil((100 * 30 * 12) / 3) * 4)
})

test('opened, the town shows everyone already at what it is doing, not walking there', () => {
  const w = new World()
  w.resize(100, 30)
  w.sync({ sessions: crew().map(s => (s.id === 'Mads' ? { ...s, status: 'working' as const, tool: 'Edit', detail: 'editing login.ts' } : s)), now: 100 })
  w.step(100, 0)
  const people = w.heroList()
  expect(people.length).toBe(2)
  expect(people.every(p => !p.moving)).toBe(true)
  expect(people.find(p => p.id === 'Mads')?.doing).toBe('build')
  // someone who turns up later walks in as before
  w.sync({ sessions: [...crew(), session('Late', { status: 'working', tool: 'Read', detail: 'reading x.ts' })], now: 200 })
  w.step(200, 0)
  expect(w.heroList().find(p => p.id === 'Late')?.moving).toBe(true)
})

test('a bored crew still draws', async () => {
  const w = new World()
  w.resize(80, 24)
  w.sync({ sessions: crew().map(s => ({ ...s, status: 'idle' as const })), now: 0, bored: true })
  for (let t = 0; t < 8000; t += 250) w.step(t, 250)
  expect(w.render().length).toBe(Math.ceil((80 * 24 * 12) / 3) * 4)
})

test('the town pane draws the map, buttons on its edges, and an order menu under it', async ($, on) => {
  mock.clock(on)
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.blit', () => ({ value: {} }) as never)
  await $.command.run({ command: 'crew-town', args: 'demo' } as never)
  const props = { title: 'Crew Town', isFocused: true, bodyColumns: 100, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 40 } }
  const ui = await $.ui.mount({ plugin: 'crewser', surface: 'terminal', component: 'Pane', requestId: 'crew-town', props: props as never })
  expect(await ui.find({ key: 'map' })).toBeDefined()
  expect(await ui.find({ key: 'work' })).toBeUndefined()
  await ui.press({ key: 'm-d2' })
  expect(await ui.find({ key: 'work' })).toBeDefined()
  await ui.press({ key: 'work' })
  expect(await ui.find({ key: 'task' })).toBeDefined()
  await ui.input({ key: 'task', text: 'write the tests' })
  expect(await ui.find({ key: 'task' })).toBeUndefined()
  await ui.press({ key: 'm-d3' })
  await ui.press({ key: 'cancel' })
  expect(await ui.find({ key: 'work' })).toBeUndefined()
  await ui.press({ key: 'down' })
  await ui.press({ key: 'right' })
  await ui.press({ key: 'home' })
  await ui.press({ key: 'zoom-out' })
  await ui.press({ key: 'zoom-in' })
  expect(await ui.find({ key: 'close' })).toBeUndefined()
  expect(await ui.find({ key: 'home' })).toBeDefined()
  const up = await ui.find({ key: 'up' })
  expect(up?.text.split('\n').length).toBe(3)
  await ui.unmount()
})

test('the tokens mine is its own building: its pile of tokens shows what is left of the five-hour limit', async () => {
  const gold = (left: number | null, s: 1 | 0.5) => {
    const pen = new Pen(MINE.w, MINE.h, C.grass)
    mine(pen, s, 0, 0, { anim: 0, left, lit: false })
    return [...pen.px].filter(c => c === C.gold || c === C.goldDark).length
  }
  for (const s of [1, 0.5] as const) {
    expect(gold(95, s)).toBeGreaterThan(gold(50, s))
    expect(gold(50, s)).toBeGreaterThan(gold(5, s))
    expect(gold(5, s)).toBeGreaterThan(gold(0, s))
  }
})
