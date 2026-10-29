import { expect, mock, test } from 'claude-code/testing'

import { bar, fmtLeft, gist, isLive, mix, PALETTE, slug, traffic } from '../hooks/lib'
import { ago, codeOf, stopScript, crewOf, crewsIn, doing, featuresOf, feed, isBlocked, namesSession, newCode, overlaps, overview, parseIdeas, saysBlocked, statusOf, summaryPrompt, taskLabel, titleOf } from '../hooks/lib'
import type { HistoryEvent } from '../hooks/lib'
import type { DiskSession, DiskTask } from '../hooks/lib'
import { added, brief, changePrompt, clean, diagram, fromReply, leadAlone, TEMPLATES, withOneMore } from '../hooks/strategy'

test('bars fill to the percentage in every style', async () => {
  for (const style of ['blocks', 'shades', 'line', 'dots', 'squares', 'ascii'] as const) {
    const half = bar(50, 10, style)
    expect([...half.fill].length + [...half.rest].length).toBe(10)
    expect([...bar(0, 10, style).fill].length).toBe(0)
    expect([...bar(100, 10, style).rest].length).toBe(0)
  }
  expect(bar(55, 10, 'blocks').fill).toBe('█████▌')
})

test('traffic colors and helpers', async () => {
  expect(traffic(10)).toBe('success')
  expect(traffic(70)).toBe('warning')
  expect(traffic(95)).toBe('error')
  expect(gist('  hello   world  ', 20)).toBe('hello world')
  expect(gist('abcdefghij', 5)).toBe('abcd…')
  expect(slug('My Big Task!')).toBe('my-big-task')
  expect(mix([0, 0, 0], [255, 255, 255], 0.5)).toEqual([128, 128, 128])
  expect(fmtLeft(new Date(90 * 60_000).toISOString(), 0)).toBe('1h30')
  expect(new Set(PALETTE.map(([n]) => n)).size).toBe(PALETTE.length)
})

test('a session is live while its heartbeat is fresh and it has not ended', async () => {
  const s = { beat: 1000, ended: false } as DiskSession
  expect(isLive(s, 5000)).toBe(true)
  expect(isLive(s, 60_000)).toBe(false)
  expect(isLive({ ...s, ended: true }, 2000)).toBe(false)
})

test('strategies: templates draw, briefs name advisors, a model reply parses', async () => {
  expect(TEMPLATES.length).toBeGreaterThan(2)
  for (const t of TEMPLATES) {
    const lines = diagram(t, 96)
    expect(lines.length).toBeGreaterThan(4)
    expect(lines.join('\n')).toContain(t.roles[0]?.name ?? 'Lead')
  }
  const team = TEMPLATES.find(t => t.id === 'feature-team')!
  expect(brief(team, 'impl')).toContain('Ask Implementation advisor')
  expect(brief(team, 'impl-adv')).toContain('You advise: Implementer')
  const s = fromReply('Here: {"name":"Mine","roles":[{"name":"Overview","kind":"lead","model":"sonnet"},{"name":"Implementer","kind":"worker","model":"opus","count":2},{"name":"Impl advisor","kind":"advisor","model":"haiku","links":["Implementer"]}]}')!
  expect(s.roles.map(r => r.kind)).toEqual(['lead', 'worker', 'advisor'])
  expect(s.roles[2]?.links).toEqual(['implementer'])
  expect(clean({ roles: [{ name: 'A', kind: 'worker' }] }).roles[0]?.kind).toBe('lead')
})

test('diagrams fit any width: a tree, a column of boxes, or a list', async () => {
  const big = clean({ name: 'Big', roles: [
    { name: 'Lead', kind: 'lead', model: 'opus', effort: 'high' },
    { name: 'Implementer', kind: 'worker', model: 'sonnet', count: 3 },
    { name: 'Tester', kind: 'worker', model: 'haiku' },
    { name: 'Documenter', kind: 'worker', model: 'haiku' },
    { name: 'Security advisor', kind: 'advisor', model: 'opus', links: ['implementer'] },
    { name: 'Architect', kind: 'advisor', model: 'opus', links: ['lead'] },
  ] })
  for (const s of [...TEMPLATES, big]) {
    for (const width of [160, 100, 72, 50, 36, 24, 16, 10]) {
      const lines = diagram(s, width)
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect([...line].length).toBeLessThanOrEqual(width)
    }
  }
  // wide: side by side, so the workers share rows; narrow: a column of whole boxes
  expect(diagram(big, 160).some(l => l.includes('Tester') && l.includes('Documenter'))).toBe(true)
  expect(diagram(big, 40).some(l => l.includes('Tester') && l.includes('Documenter'))).toBe(false)
  expect(diagram(big, 40).join('\n')).toContain('Security advisor')
})

/** A model that answers every change with the Duo plus a Fable advisor to the lead and two UI testers. */
const changed = JSON.stringify({ name: 'Duo', description: 'A lead, an implementer, two UI testers and a Fable advisor.', roles: [
  { name: 'Lead', kind: 'lead', model: 'opus', effort: 'high', duty: 'Plans and reviews.' },
  { name: 'Implementer', kind: 'worker', model: 'sonnet', duty: 'Builds.' },
  { name: 'UI tester', kind: 'worker', model: 'haiku', count: 2, duty: 'Tests the UI.' },
  { name: 'Fable advisor', kind: 'advisor', model: 'fable', duty: 'Advises the lead.', links: ['Lead'] },
] })

test('the strategy board lists the strategies beside a drawing; one is changed in words, then saved', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.focus', () => ({ value: {} }) as never)
  const writes: { path: string; text: string }[] = []
  on('fs.write', (_$, e) => (writes.push(e as never), { value: undefined }) as never)
  const asked: string[] = []
  on('model.complete', (_$, e) => ((asked.push((e as { prompt: string }).prompt)), { value: { isAnswered: true, text: changed, usage: {} } }) as never)
  await $.command.run({ command: 'crew-strategy-manage' } as never)
  for (const columns of [150, 60]) {
    const props = { title: 'Strategies', isFocused: true, bodyColumns: columns, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 50 } }
    const ui = await $.ui.mount({ plugin: 'crewser', surface: 'terminal', component: 'Pane', requestId: 'strategies', props: props as never })
    // every strategy a row of its own; the one in focus drawn in the preview beside them
    expect(await ui.find({ key: 'pick-duo' })).toBeDefined()
    expect(await ui.find({ key: 'pick-swarm' })).toBeDefined()
    expect(await ui.find({ key: 'new' })).toBeDefined()
    expect(await ui.find({ key: 'none' })).toBeUndefined()
    const preview = async () => (await ui.find({ key: 'preview' }))?.text ?? ''
    await $.ui.focus({ component: 'Pane', requestId: 'strategies', element: 'pick-swarm', plugin: 'crewser', origin: { kind: 'person' } })
    expect(await preview()).toContain('Architect')
    await $.ui.focus({ component: 'Pane', requestId: 'strategies', element: 'new', plugin: 'crewser', origin: { kind: 'person' } })
    expect(await preview()).toContain('Create a new strategy')
    // picked: its drawing, then edit it in words
    await ui.press({ key: 'pick-duo' })
    expect(await ui.find({ key: 'delete' })).toBeDefined()
    await ui.press({ key: 'edit' })
    await ui.input({ key: 'change', text: 'add a Fable advisor to the lead and two extra UI testers' })
    expect(asked.at(-1)).toContain('add a Fable advisor')
    expect((await ui.drawn()) && (await ui.find({ key: 'ok' }))).toBeDefined()
    const shown = JSON.stringify(await ui.drawn())
    expect(shown).toContain('Fable advisor')
    expect(shown).toContain('2× UI tester')
    // confirmed: save over the old one or as a new one (no task is starting, so no "only this time")
    await ui.press({ key: 'ok' })
    expect(await ui.find({ key: 'saveupdated' })).toBeDefined()
    expect(await ui.find({ key: 'once' })).toBeUndefined()
    await ui.press({ key: 'goback' })
    expect(await ui.find({ key: 'more' })).toBeDefined()
    await ui.press({ key: 'ok' })
    await ui.press({ key: 'savenew' })
    await ui.input({ key: 'savename', text: 'Duo plus' })
    const saved = writes.at(-1)
    expect(saved?.path).toContain('/.crewser/strategies/duo-plus.json')
    expect(JSON.parse(saved?.text ?? '{}').roles.some((r: { model: string }) => r.model === 'fable')).toBe(true)
    // back on the list; then by hand, and Back to the words
    expect(await ui.find({ key: 'pick-duo' })).toBeDefined()
    await ui.press({ key: 'pick-duo' })
    await ui.press({ key: 'edit' })
    await ui.press({ key: 'handedit' })
    expect(await ui.find({ key: 'addworker' })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'change' })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'delete' })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'pick-duo' })).toBeDefined()
    await ui.unmount()
  }
})

test('/crew-task is steps in the board, each with Back and Cancel', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  let closed = 0
  on('ui.close', (_$, e, next) => ((closed++), next(e)))
  // /crew-strategy-use with no task waiting: the same steps as /crew-task → Start
  await $.command.run({ command: 'crew-strategy-use', args: '' } as never)
  const props = { title: 'Crew task', isFocused: true, bodyColumns: 150, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 50 } }
  const ui = await $.ui.mount({ plugin: 'crewser', surface: 'terminal', component: 'Pane', requestId: 'strategies', props: props as never })
  // what to work on: ideas (the plain kinds when no model answers), or a name typed in
  expect(await ui.find({ key: 'idea-0' })).toBeDefined()
  expect(await ui.find({ key: 'cancel' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Step 1 of 3' })).toBeDefined()
  await ui.press({ key: 'typename' })
  await ui.input({ key: 'taskname', text: 'Checkout tests' })
  expect(await ui.find({ key: 'taskgoal' })).toBeDefined()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'idea-0' })
  await ui.press({ key: 'later' })
  // the strategy step: its step on a line of its own, the saved ones listed, a new one, or none
  expect(await ui.find({ type: 'Text', text: 'Step 3 of 3' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Pick a strategy' })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).toContain('Pick a strategy to use or modify:')
  expect(JSON.stringify(await ui.drawn())).not.toContain('(h, l)')
  expect(await ui.find({ key: 'pick-duo' })).toBeDefined()
  expect(await ui.find({ key: 'new' })).toBeDefined()
  expect(await ui.find({ key: 'none' })).toBeDefined()
  // picked: asked whether to edit it first, with "only this time" among the saves; windows or tabs is a setting, not asked here
  await ui.press({ key: 'pick-duo' })
  expect(await ui.find({ key: 'use' })).toBeDefined()
  expect(await ui.find({ key: 'as-tabs' })).toBeUndefined()
  // a crew of several starts in tabs or in windows, one choice per line
  expect((await ui.find({ key: 'use' }))?.props).toMatchObject({ label: '▶ Start task with tabs' })
  expect((await ui.find({ key: 'usewindows' }))?.props).toMatchObject({ label: '▶ Start task with windows' })
  await ui.press({ key: 'edit' })
  await ui.press({ key: 'handedit' })
  await ui.press({ key: 'addworker' })
  await ui.press({ key: 'done' })
  await ui.press({ key: 'ok' })
  expect(await ui.find({ key: 'once' })).toBeDefined()
  expect(await ui.find({ key: 'saveupdated' })).toBeDefined()
  // Back, step by step: the changed team, then (dropping the changes) the strategy, then the list
  await ui.press({ key: 'goback' })
  expect(await ui.find({ key: 'more' })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'use' })).toBeDefined()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'new' })
  expect(await ui.find({ key: 'describe' })).toBeDefined()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'taskgoal' })).toBeDefined()
  await ui.press({ key: 'cancel' })
  expect(closed).toBeGreaterThan(0)
  await ui.unmount()
})

test('a strategy changed or used once goes on to the last step: start with tabs, or with windows', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  await $.command.run({ command: 'crew-strategy-use', args: '' } as never)
  const props = { title: 'Crew task', isFocused: true, bodyColumns: 150, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 50 } }
  const ui = await $.ui.mount({ plugin: 'crewser', surface: 'terminal', component: 'Pane', requestId: 'strategies', props: props as never })
  await ui.press({ key: 'idea-0' })
  await ui.press({ key: 'later' })
  await ui.press({ key: 'pick-duo' })
  await ui.press({ key: 'edit' })
  await ui.press({ key: 'handedit' })
  await ui.press({ key: 'done' })
  await ui.press({ key: 'ok' })
  await ui.press({ key: 'once' })
  expect(JSON.stringify(await ui.drawn())).toContain('Start task with tabs')
  expect(await ui.find({ key: 'launchtabs' })).toBeDefined()
  expect(await ui.find({ key: 'launchwindows' })).toBeDefined()
  expect(await ui.find({ key: 'back' })).toBeDefined()
  expect(await ui.find({ key: 'cancel' })).toBeDefined()
  await ui.unmount()
})

test("a task's history gives its status, its features and the summary prompt", () => {
  const ev = (at: number, kind: HistoryEvent['kind'], text: string, feature?: HistoryEvent['feature']): HistoryEvent => ({ at, by: 'Lead', kind, text, ...(feature ? { feature } : {}) })
  const h = [
    ev(1, 'start', 'Started'),
    ev(2, 'feature', 'Started Login', { name: 'Login', status: 'building' }),
    ev(3, 'report', 'To the overseer: halfway'),
    ev(4, 'feature', 'Finished Login', { name: 'Login', status: 'done' }),
    ev(5, 'feature', 'Started Cart', { name: 'Cart', status: 'building' }),
    ev(6, 'status', 'Login done; blocked on the payment keys for the cart'),
  ]
  expect(statusOf(h)?.text).toBe('Login done; blocked on the payment keys for the cart')
  expect(statusOf(h.slice(0, 4))?.kind).toBe('report')
  expect(featuresOf(h).map(f => `${f.name}:${f.status}`)).toEqual(['Login:done', 'Cart:building'])
  expect(saysBlocked(statusOf(h)?.text ?? '')).toBe(true)
  const prompt = summaryPrompt({ v: 1, id: 't', name: 'Shop', goal: 'sell things', creator: '', creatorName: '', createdAt: 0, ended: true }, h)
  expect(prompt).toContain('"Shop" with the goal: sell things')
  expect(prompt).toContain('Login (done), Cart (in progress)')
  expect(prompt).toContain('blocked on the payment keys')
})

test('a change in words keeps the team and turns names into links', () => {
  const duo = TEMPLATES.find(t => t.id === 'duo')!
  expect(changePrompt(duo, 'add a tester')).toContain('"name":"Implementer"')
  const s = fromReply(changed)!
  expect(s.roles.find(r => r.name === 'Fable advisor')).toMatchObject({ kind: 'advisor', model: 'fable', links: ['lead'] })
  expect(s.roles.find(r => r.name === 'UI tester')?.count).toBe(2)
})

test('ideas for a task come from a model reply; a task remembers its crew for a resume', () => {
  expect(parseIdeas('Sure!\n[{"name": "Checkout tests", "goal": "Cover the checkout flow"}, {"name": "x"}, {"goal": "no name"}]')).toEqual([
    { name: 'Checkout tests', goal: 'Cover the checkout flow' },
  ])
  expect(parseIdeas('no json here')).toEqual([])
  const task: DiskTask = { v: 1, id: 't1', name: 'Shop', goal: '', creator: 'lead', creatorName: 'Mads', createdAt: 0, ended: true }
  const rec = (id: string, name: string, beat: number, taskId = 't1') =>
    ({ id, name, cwd: '/p', color: '#e5484d', beat, task: { id: taskId, name: 'Shop', role: 'Tester', lead: 'Mads' } }) as unknown as DiskSession
  // no roster kept: the sessions last seen in it, one per name (the newest), never the lead
  const crew = crewOf(task, [rec('a', 'Tester', 1), rec('b', 'Tester', 5), rec('lead', 'Lead', 9), rec('c', 'Other', 3, 't2')])
  expect(crew.map(m => m.id)).toEqual(['b'])
  // a kept roster wins
  const kept = crewOf({ ...task, members: [{ id: 'z', name: 'Implementer', role: 'Implementer', cwd: '/p', color: '#4f7cff', lastSeen: 2 }] }, [rec('b', 'Tester', 5)])
  expect(kept.map(m => m.id)).toEqual(['z'])
  expect(ago(3 * 3600_000)).toBe('3 hours ago')
  expect(ago(3 * 86400_000)).toBe('3 days ago')
})

test('the overseer sees every crew of its project: members, features, cost, files two crews change, branches waiting', () => {
  const now = 100_000
  const task = (id: string, name: string, extra: Partial<DiskTask> = {}): DiskTask =>
    ({ v: 1, id, name, goal: `${name} goal`, creator: `${id}-lead`, creatorName: 'Lead', createdAt: 1, ended: false, town: '/p/.crewser/town', root: '/p', ...extra })
  const member = (id: string, taskId: string, name: string, extra: Partial<DiskSession> = {}) => ({
    id, name, color: '#e5484d', status: 'working', detail: 'editing board.ts', activity: '', lastPrompt: '', beat: now, ended: false,
    task: { id: taskId, name: taskId, role: id.endsWith('lead') ? 'Lead' : 'Implementer', lead: 'Lead' }, posts: [], features: [], cost: 1.5, ...extra,
  }) as unknown as DiskSession
  const tasks = [
    task('a', 'Scoring'),
    task('b', 'Sound', { worktree: '/p-sound', branch: 'crew/sound', paused: true }),
    task('x', 'Elsewhere', { town: '/q/.crewser/town' }),
  ]
  const sessions = [
    member('a-lead', 'a', 'Lead · Scoring', { features: [{ id: 'f', name: 'Score', status: 'building', at: 1 }] }),
    member('a1', 'a', 'Implementer #1', { files: ['src/board.ts', 'src/score.ts'] }),
    member('b-lead', 'b', 'Lead · Sound'),
    member('b1', 'b', 'Implementer #2', { files: ['src/board.ts'] }),
    member('x-lead', 'x', 'Other lead'),
    member('gone', 'a', 'Gone', { beat: 0 }),
  ]
  const crews = crewsIn('/p/.crewser/town', tasks, sessions, now)
  // this project's crews only, the paused one last; live members only
  expect(crews.map(c => c.task.name)).toEqual(['Scoring', 'Sound'])
  expect(crews[0]?.members.map(s => s.name)).toEqual(['Lead · Scoring', 'Implementer #1'])
  expect(crews[0]?.cost).toBe(3)
  expect(overlaps(crews)).toEqual([{ file: 'src/board.ts', crews: ['Scoring', 'Sound'] }])
  const text = overview(crews, 40, [task('c', 'Docs', { ended: true, branch: 'crew/docs' })], now)
  expect(text).toContain(`## Scoring #${codeOf(tasks[0]!)} (lead Lead · Scoring)`)
  expect(text).toContain('2/2 working')
  expect(text).toContain('PAUSED')
  expect(text).toContain('branch crew/sound')
  expect(text).toContain('Features: Score (in progress)')
  expect(text).toContain('src/board.ts: Scoring, Sound')
  expect(text).toContain('Docs (crew/docs)')
  expect(text).toContain('60% of the 5-hour limit left')
  expect(overview([], null)).toContain('No crews are at work')
})

test('sessions are titled with their task and its short code, and named across crews by it', () => {
  const codes = new Set(Array.from({ length: 200 }, () => newCode()))
  for (const c of codes) expect(c).toMatch(/^[1-9]\d{3}$/)
  expect(newCode(['1234'])).not.toBe('1234')
  const k = { id: 'checkout-flow-x7y8z9q2', name: 'Checkout flow', code: '4821' }
  expect(codeOf(k)).toBe('4821')
  // tasks from before codes, or with a code of letters: four digits worked out from the id, the same every time
  expect(codeOf({ id: 'checkout-flow-x7y8z9q2' })).toMatch(/^\d{4}$/)
  expect(codeOf({ id: 'checkout-flow-x7y8z9q2', code: 'abcd' })).toBe(codeOf({ id: 'checkout-flow-x7y8z9q2' }))
  expect(taskLabel(k)).toBe('Checkout flow #4821')
  expect(titleOf('Implementer #1', k)).toBe('Checkout flow #4821 · Implementer #1')
  expect(titleOf('Overseer', null)).toBe('Overseer')
  const title = titleOf('Implementer #1', k)
  expect(namesSession('implementer #1', 'Implementer #1', title)).toBe('exact')
  expect(namesSession(title, 'Implementer #1', title)).toBe('exact')
  expect(namesSession('Implementer #1 #4821', 'Implementer #1', title)).toBe('part')
  expect(namesSession('checkout implementer', 'Implementer #1', title)).toBe('part')
  expect(namesSession('Implementer #1 #9999', 'Implementer #1', title)).toBeNull()
})

test('the overseer sees how long each member has been at it, and its conversation with the leads', () => {
  const now = 1_000_000
  const k: DiskTask = { v: 1, id: 'a', code: '4821', name: 'Checkout', goal: '', creator: 'lead', creatorName: 'Lead', createdAt: 1, ended: false, town: '/t' }
  const s = (id: string, extra: Partial<DiskSession>) => ({
    id, name: id === 'lead' ? 'Lead' : 'Tester', color: '#3fb950', status: 'idle', detail: '', activity: '', lastPrompt: '', beat: now, ended: false, model: 'opus', ctx: 40,
    task: { id: 'a', name: 'Checkout', role: id === 'lead' ? 'Lead' : 'Tester', lead: 'Lead', code: '4821' }, posts: [], features: [], agents: [], cost: 0, ...extra,
  }) as unknown as DiskSession
  const lead = s('lead', { status: 'working', busySince: now - 180_000, detail: 'editing cart.ts', posts: [{ at: now - 60_000, to: 'overseer', text: 'blocked on the payment API keys' }] })
  const tester = s('t1', { idleSince: now - 600_000, lastPrompt: 'run the e2e tests' })
  expect(doing(lead, now)).toBe('working 3m · editing cart.ts')
  expect(doing(tester, now)).toBe('idle 10m · last: run the e2e tests')
  const overseer = { id: 'o', color: '#e5484d', posts: [{ at: now - 120_000, to: 'leads', text: 'post me a status' }, { at: now - 30_000, to: 'crew:a', text: 'skip the keys for now' }] } as unknown as DiskSession
  const crews = crewsIn('/t', [k], [lead, tester], now)
  const talk = feed(overseer, crews)
  expect(talk.map(f => `${f.up ? f.from : 'you'} → ${f.up ? 'you' : f.to}: ${f.text}`)).toEqual([
    'you → every lead: post me a status',
    'Checkout #4821 · Lead → you: blocked on the payment API keys',
    'you → Checkout #4821: skip the keys for now',
  ])
  expect(isBlocked(crews[0]!, overseer)).toBe(true)
  const text = overview(crews, null, [], now, overseer)
  expect(text).toContain('BLOCKED')
  expect(text).toContain('Last status to you (just now, Checkout #4821 · Lead): blocked on the payment API keys')
  expect(text).toContain('- Tester · Tester · opus · idle 10m · last: run the e2e tests · ctx 40%')
  expect(text).toContain('you → every lead: post me a status')
})

test('/crew-overseer opens the Overview: with no crews, a crew to start and nobody to write to yet', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  mock.clock(on)
  await $.command.run({ command: 'crew-overseer', args: '' } as never)
  const props = { title: 'Overview', isFocused: true, bodyColumns: 120, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 40 } }
  const ui = await $.ui.mount({ plugin: 'crewser', surface: 'terminal', component: 'Pane', requestId: 'crew-overview', props: props as never })
  expect(await ui.find({ key: 'newcrew' })).toBeDefined()
  expect(await ui.find({ key: 'writeall' })).toBeUndefined()
  expect(JSON.stringify(await ui.drawn())).toContain('No crews at work')
  await ui.unmount()
})

test('the Overview shows running crews as cards, apart from finished work waiting for a decision', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  mock.clock(on)
  // the overseer's own record says which town (project) it oversees: the crews are seeded into it
  let town = ''
  const files = new Map<string, string>()
  on('fs.write', (_$, e) => {
    const w = e as unknown as { path: string; text: string }
    if (w.path.includes('/sessions/')) town = (JSON.parse(w.text) as DiskSession).town ?? town
    return { value: undefined } as never
  })
  on('fs.list', (_$, e) => {
    const dir = (e as unknown as { path: string }).path
    return { value: [...files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => ({ name: p.slice(dir.length + 1), kind: 'file' })) } as never
  })
  on('fs.read', (_$, e) => {
    const path = (e as unknown as { path: string }).path
    return (files.has(path) ? { value: files.get(path) } : { deny: 'missing' }) as never
  })
  mock.env(on, { HOME: '/home/me' })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: '/p' }) as never)
  for (const [ev, value] of [['session.id', 'me'], ['session.cwd', '/p'], ['session.model', 'opus']] as const) on(ev as never, () => ({ value }) as never)
  on('session.usage', () => ({ value: { context: {}, rateLimits: [] } }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  await $.session.start({ source: 'startup', cwd: '/p' } as never)
  await $.command.run({ command: 'crew-overseer', args: '' } as never)
  const now = 0
  const root = '/home/me/.claude/crew'
  const k = (id: string, extra: Partial<DiskTask> = {}): DiskTask => ({ v: 1, id, code: id === 'a' ? '1111' : id === 'b' ? '2222' : '3333', name: `Task ${id}`, goal: `goal ${id}`, creator: `${id}-lead`, creatorName: 'Lead', createdAt: 1, ended: false, town, root: '/p', ...extra })
  const s = (id: string, taskId: string, extra: Partial<DiskSession> = {}) => ({
    v: 1, id, name: id.endsWith('lead') ? 'Lead' : 'Tester', color: '#3fb950', status: 'working', detail: 'editing a.ts', activity: '', lastPrompt: '', beat: now, ended: false, model: 'opus', ctx: 20,
    town, task: { id: taskId, name: `Task ${taskId}`, role: id.endsWith('lead') ? 'Lead' : 'Tester', lead: 'Lead' }, posts: [], features: [], agents: [], pings: [], cost: 0.5, ...extra,
  })
  for (const t of [k('a'), k('b', { paused: true }), k('c', { ended: true, branch: 'crew/c', outcome: undefined })]) files.set(`${root}/tasks/${t.id}.json`, JSON.stringify(t))
  for (const r of [s('a-lead', 'a'), s('a1', 'a'), s('b-lead', 'b')]) files.set(`${root}/sessions/${r.id}.json`, JSON.stringify(r))
  files.set(`${root}/history/a/a-lead.json`, JSON.stringify([
    { at: -60_000, by: 'Lead', kind: 'start', text: 'Started with the strategy "Duo"' },
    { at: -30_000, by: 'Lead', kind: 'feature', text: 'Started Login (house)', feature: { name: 'Login', status: 'building' } },
    { at: -10_000, by: 'Lead', kind: 'status', text: 'Login half done, cart next' },
  ]))
  await $.command.run({ command: 'crew-overseer', args: '' } as never)
  const props = { title: 'Overview', isFocused: true, bodyColumns: 120, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 60 } }
  const ui = await $.ui.mount({ plugin: 'crewser', surface: 'terminal', component: 'Pane', requestId: 'crew-overview', props: props as never })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('RUNNING CREWS (2)')
  expect(drawn).toContain('⚑ Task a #1111')
  expect(drawn).toContain('PAUSED')
  // finished work is a box of its own, with its three choices one per line
  expect(drawn).toContain('FINISHED · WAITING FOR YOUR DECISION (1)')
  expect(await ui.find({ key: 'merge-c' })).toBeDefined()
  expect(await ui.find({ key: 'pr-c' })).toBeDefined()
  expect(await ui.find({ key: 'writeall' })).toBeDefined()
  expect(await ui.find({ key: 'brief-a' })).toBeDefined()
  expect(drawn).toContain('Login half done, cart next')
  // a crew's history: where it stands, its features, every change newest first; back to the overview
  await ui.press({ key: 'history-a' })
  const hist = JSON.stringify(await ui.drawn())
  expect(hist).toContain('☰ History · ⚑ Task a #1111')
  expect(hist).toContain('TIMELINE · NEWEST FIRST')
  expect(hist.indexOf('Login half done')).toBeLessThan(hist.indexOf('Started with the strategy'))
  await ui.press({ key: 'back-top' })
  expect(JSON.stringify(await ui.drawn())).toContain('RUNNING CREWS (2)')
  // ■ Stop on a card asks on the card before it closes anything
  await ui.press({ key: 'stop-a' })
  expect(await ui.find({ key: 'stopyes-a' })).toBeDefined()
  await ui.press({ key: 'stopno-a' })
  expect(await ui.find({ key: 'stopyes-a' })).toBeUndefined()
  await ui.unmount()
})

test('resuming a task shows what it is about, where it stands and what changed, then tabs, windows or just me', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  mock.clock(on, { now: 10 * 86_400_000 })
  mock.env(on, { HOME: '/home/me' })
  const files = new Map<string, string>()
  on('fs.write', (_$, e) => {
    const w = e as unknown as { path: string; text: string }
    files.set(w.path, w.text)
    return { value: undefined } as never
  })
  on('fs.list', (_$, e) => {
    const dir = (e as unknown as { path: string }).path
    return { value: [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')).map(p => ({ name: p.slice(dir.length + 1), kind: 'file' })) } as never
  })
  on('fs.read', (_$, e) => {
    const path = (e as unknown as { path: string }).path
    return (files.has(path) ? { value: files.get(path) } : { deny: 'missing' }) as never
  })
  on('fs.exists', () => ({ value: false }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: '/p' }) as never)
  for (const [ev, value] of [['session.id', 'me'], ['session.cwd', '/p'], ['session.model', 'opus']] as const) on(ev as never, () => ({ value }) as never)
  on('session.usage', () => ({ value: { context: {}, rateLimits: [] } }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  let asked = ''
  on('model.complete', (_$, e) => ((asked = (e as unknown as { prompt: string }).prompt), { value: { isAnswered: true, text: 'A shop: login is done, the cart waits for payment keys.' } }) as never)
  const root = '/home/me/.claude/crew'
  const day = 86_400_000
  const past: DiskTask = {
    v: 1, id: 'shop-1', code: '5150', name: 'Shop', goal: 'sell things', creator: 'old', creatorName: 'Lead', createdAt: 8 * day, ended: true, endedAt: 9 * day, project: 'p',
    members: [{ id: 'm1', name: 'Tester', role: 'Tester', cwd: '/p', color: '#3fb950', lastSeen: 9 * day }],
  }
  files.set(`${root}/tasks/shop-1.json`, JSON.stringify(past))
  files.set(`${root}/history/shop-1/old.json`, JSON.stringify([
    { at: 8 * day, by: 'Lead', kind: 'start', text: 'Started' },
    { at: 8 * day + 1000, by: 'Lead', kind: 'feature', text: 'Finished Login', feature: { name: 'Login', status: 'done' } },
    { at: 9 * day - 1000, by: 'Lead', kind: 'status', text: 'Login done; cart blocked on payment keys' },
  ]))
  await $.session.start({ source: 'startup', cwd: '/p' } as never)
  await $.command.run({ command: 'crew-task', args: '' } as never)
  const props = { title: 'Crew task', isFocused: true, bodyColumns: 150, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 60 } }
  const ui = await $.ui.mount({ plugin: 'crewser', surface: 'terminal', component: 'Pane', requestId: 'strategies', props: props as never })
  await ui.press({ key: 'resume' })
  // the list: each task with its status
  expect(JSON.stringify(await ui.drawn())).toContain('Login done; cart blocked on payment keys')
  await ui.press({ key: 'rs-shop-1' })
  const one = JSON.stringify(await ui.drawn())
  expect(asked).toContain('Login done; cart blocked on payment keys')
  expect(one).toContain('A shop: login is done, the cart waits for payment keys.')
  expect(one).toContain('Login ✓')
  expect((await ui.find({ key: 'resumetabs' }))?.props).toMatchObject({ label: '▶ Resume the task with the crew in tabs' })
  expect((await ui.find({ key: 'resumewindows' }))?.props).toMatchObject({ label: '▶ Resume the task with the crew in windows' })
  expect(await ui.find({ key: 'resumealone' })).toBeDefined()
  // the summary is kept with the task, so the next look needs no model
  expect(JSON.parse(files.get(`${root}/tasks/shop-1.json`) ?? '{}').summary?.text).toContain('A shop')
  await ui.unmount()
})

test('a running crew grows: a role new to it, or more of one it has; fewer close no one', () => {
  const duo = TEMPLATES.find(t => t.id === 'duo')!
  const worker = duo.roles.find(r => r.kind !== 'lead')!
  expect(added(duo, withOneMore(duo, worker.id))).toEqual([{ role: { ...worker, count: worker.count + 1 }, add: 1 }])
  const ui = clean({ ...duo, roles: [...duo.roles, { name: 'UI expert', kind: 'worker', model: 'opus', count: 1 }] })
  expect(added(duo, ui).map(a => `${a.role.name}:${a.add}`)).toEqual(['UI expert:1'])
  expect(added(ui, duo)).toEqual([])
  // a task started alone: its lead, and then whoever is added
  const alone = leadAlone('Shop')
  expect(alone.roles.map(r => r.kind)).toEqual(['lead'])
  expect(added(alone, ui).length).toBe(ui.roles.length - 1)
})

test('/crew-add from a single session: say who joins, then add them in tabs or windows; the task keeps them', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/me', TERM_PROGRAM: 'Apple_Terminal' })
  let allowed = false
  const files = new Map<string, string>()
  on('fs.write', (_$, e) => {
    const w = e as unknown as { path: string; text: string }
    files.set(w.path, w.text)
    return { value: undefined } as never
  })
  on('fs.list', (_$, e) => {
    const dir = (e as unknown as { path: string }).path
    return { value: [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')).map(p => ({ name: p.slice(dir.length + 1), kind: 'file' })) } as never
  })
  on('fs.read', (_$, e) => {
    const path = (e as unknown as { path: string }).path
    return (files.has(path) ? { value: files.get(path) } : { deny: 'missing' }) as never
  })
  on('fs.exists', () => ({ value: false }) as never)
  const scripts: string[] = []
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv?: string[]; command?: string[] }).argv ?? (e as unknown as { command?: string[] }).command ?? []
    if (argv[0] === 'osascript') scripts.push(argv.join(' '))
    const ui = argv.join(' ').includes('UI elements enabled')
    return { value: { exitCode: 0, stdout: ui ? String(allowed) : '', stderr: '' } } as never
  })
  for (const ev of ['command.register', 'tool.register', 'ui.invalidate', 'ui.toast', 'ui.close', 'session.send']) on(ev as never, () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: '/p' }) as never)
  for (const [ev, value] of [['session.id', 'me'], ['session.cwd', '/p'], ['session.model', 'opus']] as const) on(ev as never, () => ({ value }) as never)
  on('session.usage', () => ({ value: { context: {}, rateLimits: [] } }) as never)
  mock.session(on)
  on('agent.list', () => ({ value: [] }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: JSON.stringify({ name: 'Shop', roles: [{ name: 'Lead', kind: 'lead' }, { name: 'UI expert', kind: 'worker', model: 'opus', count: 1, duty: 'Reviews the frontend.' }] }) } }) as never)
  const root = '/home/me/.claude/crew'
  // this session leads "Shop", alone
  const task: DiskTask = { v: 1, id: 'shop-1', code: '5150', name: 'Shop', goal: '', creator: 'me', creatorName: 'Lead', createdAt: 1, ended: false, project: 'p', root: '/p' }
  files.set(`${root}/tasks/shop-1.json`, JSON.stringify(task))
  files.set(`${root}/sessions/me.json`, JSON.stringify({ v: 1, id: 'me', name: 'Lead', codename: 'Lead', colorName: 'Blue', color: '#4f7cff', beat: 1_000_000, ended: false, task: { id: 'shop-1', name: 'Shop', role: 'Lead', lead: 'Lead' }, posts: [], pings: [], features: [], agents: [] }))
  await $.session.start({ source: 'startup', cwd: '/p' } as never)
  await $.command.run({ command: 'crew-add', args: '' } as never)
  const props = { title: 'Crew', isFocused: true, bodyColumns: 150, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 60 } }
  const ui = await $.ui.mount({ plugin: 'crewser', surface: 'terminal', component: 'Pane', requestId: 'strategies', props: props as never })
  expect(JSON.stringify(await ui.drawn())).toContain('a single session so far')
  await ui.press({ key: 'describe' })
  await ui.input({ key: 'change', text: 'a UI expert on opus who reviews the frontend' })
  const changed = JSON.stringify(await ui.drawn())
  expect(changed).toContain('+ 1 × UI expert')
  expect(await ui.find({ key: 'growwindows' })).toBeDefined()
  // tabs need Terminal allowed under Accessibility: the board says so before anything opens
  await ui.press({ key: 'growtabs' })
  expect(JSON.stringify(await ui.drawn())).toContain('Tabs need one permission first')
  expect(await ui.find({ key: 'tabsettings' })).toBeDefined()
  expect(await ui.find({ key: 'tabswindows' })).toBeDefined()
  await ui.press({ key: 'tabsretry' })
  expect(JSON.stringify(await ui.drawn())).toContain('Terminal is not allowed yet')
  allowed = true
  await ui.press({ key: 'tabsretry' })
  const kept = JSON.parse(files.get(`${root}/tasks/shop-1.json`) ?? '{}') as DiskTask
  expect(kept.strategy?.roles.map(r => r.name)).toEqual(['Lead', 'UI expert'])
  expect(kept.openAs).toBe('tabs')
  expect(scripts.some(x => x.includes('Shop #5150 · UI expert'))).toBe(true)
  expect(files.get(`${root}/history/shop-1/me.json`)).toContain('Added 1 UI expert (opus), in tabs')
  await ui.unmount()
})

test('stopping a crew: a script of its own stops every session on its ttys, then closes the windows', () => {
  const sh = stopScript(['/dev/ttys004', '/dev/ttys009'], ['311'])
  expect(sh).toContain('for t in ttys004 ttys009')
  expect(sh.indexOf('kill -HUP')).toBeLessThan(sh.indexOf('kill -KILL'))
  expect(sh).toContain('close (every window whose id is 311)')
})

test('/crew-task → Stop the whole crew asks first, then ends the task and closes every session of it', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/me' })
  const files = new Map<string, string>()
  on('fs.write', (_$, e) => {
    const w = e as unknown as { path: string; text: string }
    files.set(w.path, w.text)
    return { value: undefined } as never
  })
  on('fs.list', (_$, e) => {
    const dir = (e as unknown as { path: string }).path
    return { value: [...files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')).map(p => ({ name: p.slice(dir.length + 1), kind: 'file' })) } as never
  })
  on('fs.read', (_$, e) => {
    const path = (e as unknown as { path: string }).path
    return (files.has(path) ? { value: files.get(path) } : { deny: 'missing' }) as never
  })
  on('fs.exists', () => ({ value: false }) as never)
  const runs: string[][] = []
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv?: string[] }).argv ?? []
    runs.push(argv)
    // Terminal's windows: one holds only the member, the other the member's tab and someone else's
    const listing = argv.join(' ').includes('set acc to') ? '311 /dev/ttys009\n312 /dev/ttys009 /dev/ttys020\n' : ''
    return { value: { exitCode: 0, stdout: listing, stderr: '' } } as never
  })
  for (const ev of ['command.register', 'tool.register', 'ui.invalidate', 'ui.toast', 'ui.close', 'session.send']) on(ev as never, () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: '/p' }) as never)
  for (const [ev, value] of [['session.id', 'me'], ['session.cwd', '/p'], ['session.model', 'opus']] as const) on(ev as never, () => ({ value }) as never)
  on('session.usage', () => ({ value: { context: {}, rateLimits: [] } }) as never)
  mock.session(on)
  on('agent.list', () => ({ value: [] }) as never)
  const root = '/home/me/.claude/crew'
  const task: DiskTask = { v: 1, id: 'shop-1', code: '5150', name: 'Shop', goal: '', creator: 'me', creatorName: 'Lead', createdAt: 1, ended: false, project: 'p', root: '/p' }
  files.set(`${root}/tasks/shop-1.json`, JSON.stringify(task))
  const member = (id: string, name: string, tty?: string) => ({ v: 1, id, name, codename: name, colorName: 'Blue', color: '#4f7cff', beat: 1_000_000, ended: false, tty, task: { id: 'shop-1', name: 'Shop', role: name, lead: 'Lead' }, posts: [], pings: [], features: [], agents: [] })
  files.set(`${root}/sessions/me.json`, JSON.stringify(member('me', 'Lead')))
  files.set(`${root}/sessions/m1.json`, JSON.stringify(member('m1', 'Tester', '/dev/ttys009')))
  await $.session.start({ source: 'startup', cwd: '/p' } as never)
  await $.command.run({ command: 'crew-task', args: '' } as never)
  const props = { title: 'Crew task', isFocused: true, bodyColumns: 150, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 60 } }
  const ui = await $.ui.mount({ plugin: 'crewser', surface: 'terminal', component: 'Pane', requestId: 'strategies', props: props as never })
  await ui.press({ key: 'stopcrew' })
  expect(JSON.stringify(await ui.drawn())).toContain('Stop \\"Shop\\" now?')
  // keeping it running goes back to the menu, nothing stopped
  await ui.press({ key: 'stopno' })
  expect(await ui.find({ key: 'stopcrew' })).toBeDefined()
  expect((JSON.parse(files.get(`${root}/tasks/shop-1.json`) ?? '{}') as DiskTask).ended).toBe(false)
  await ui.press({ key: 'stopcrew' })
  await ui.press({ key: 'stopyes' })
  expect((JSON.parse(files.get(`${root}/tasks/shop-1.json`) ?? '{}') as DiskTask).ended).toBe(true)
  expect((JSON.parse(files.get(`${root}/sessions/m1.json`) ?? '{}') as DiskSession).ended).toBe(true)
  expect(files.get(`${root}/history/shop-1/me.json`)).toContain('Stopped by Lead')
  // a detached shell stops the member's tty and closes the window that holds only the crew, not the shared one
  const killer = runs.find(a => a.join(' ').includes('POSIX::setsid'))
  expect(killer?.join(' ')).toContain('for t in ttys009')
  expect(killer?.join(' ')).toContain('whose id is 311')
  expect(killer?.join(' ')).not.toContain('whose id is 312')
  await ui.unmount()
})
