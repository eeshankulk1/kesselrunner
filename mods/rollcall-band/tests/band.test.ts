import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ME = '77a848c6-10df-42b6-a53d-d43b31befb6d'
const REPO = '/Users/me/kesselrunner'

const session = (over: Record<string, unknown>) => ({
  id: ME,
  you: false,
  checkout: REPO,
  main: REPO,
  branch: 'main',
  live: true,
  intent: 'first prompt',
  claim: null,
  waits: [],
  ...over,
})

const BAND = {
  plugin: 'rollcall-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const START = { cwd: REPO, surface: 'terminal', isInteractive: true } as const
const TURN = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

/** Answers `rollcall status --json` with the sessions given, counting the runs. */
function rollcall(on: On, sessions: () => unknown[]) {
  const runs = { count: 0 }
  on('process.run', () => {
    runs.count += 1
    const stdout = JSON.stringify({ repos: [{ name: 'kesselrunner', sessions: sessions() }] })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  return runs
}

/** The whole line the band drew. */
const line = async (ui: { find: (query: { type: string }) => Promise<{ text: string } | undefined> }) =>
  (await ui.find({ type: 'Text' }))?.text

test('alone in the main checkout, the band says so on every drawing surface', async ($, on) => {
  mock.clock(on)
  rollcall(on, () => [session({ you: true })])
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await line(ui)).toBe('kesselrunner · main · main checkout · no other sessions')
    await ui.unmount()
  }
})

test('a worktree, a claim, live peers and a waiting one are all named', async ($, on) => {
  mock.clock(on)
  rollcall(on, () => [
    session({ you: true, checkout: `${REPO}/.claude/worktrees/mods`, branch: 'feat/mods', claim: { intent: 'add mods' } }),
    session({ id: '19e45b28-aaaa', branch: 'feat/api-guard', claim: { intent: 'api guard' } }),
    session({ id: '6289c53e-bbbb', branch: 'fix/x', waits: [ME] }),
    session({ id: 'deadbeef-cccc', live: false }),
  ])
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await line(ui)).toBe(
    'kesselrunner · feat/mods · worktree mods · claim: add mods · 2 other sessions:' +
      ' 19e45b28 feat/api-guard "api guard" 6289c53e fix/x waiting on you · 1 idle',
  )
  await ui.unmount()
})

test('the timer picks up a session that arrives later', async ($, on) => {
  const clock = mock.clock(on)
  const sessions = [session({ you: true })]
  const runs = rollcall(on, () => sessions)
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await line(ui)).toContain('no other sessions')

  sessions.push(session({ id: '19e45b28-aaaa', branch: 'feat/api-guard' }))
  await clock.advance(15_000)
  expect(runs.count).toBe(2)
  expect(await line(ui)).toContain('1 other session: 19e45b28 feat/api-guard "first prompt"')
  await ui.unmount()
})

test('with no session of its own, or rollcall failing, the band is left to the engine', async ($, on) => {
  mock.clock(on)
  on('process.run', () => ({
    value: { exitCode: 127, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: "the engine's own" })
  })
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await line(ui)).toBe("the engine's own")
  await ui.unmount()
})

test("the end of a main-loop turn reads rollcall again, a subagent's does not", async ($, on) => {
  mock.clock(on)
  const runs = rollcall(on, () => [session({ you: true })])
  on('turn.complete', () => ({ text: '' }))
  await $.session.start(START)
  expect(runs.count).toBe(1)

  await $.turn.complete(TURN)
  expect(runs.count).toBe(2)
  await $.turn.complete({ ...TURN, agentId: 'a1' })
  expect(runs.count).toBe(2)
})

test('a headless run reads nothing, at its start or at the end of a turn', async ($, on) => {
  const clock = mock.clock(on)
  const runs = rollcall(on, () => [session({ you: true })])
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ ...START, surface: null, isInteractive: false })
  await $.turn.complete(TURN)
  await clock.advance(60_000)
  expect(runs.count).toBe(0)
})

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test("a worker's band names its task", async ($, on) => {
  mock.clock(on)
  on('process.run', () =>
    ok(JSON.stringify({ me: { id: ME, supervisor: false, home: null, task: 't3' }, repos: [{ name: 'kesselrunner', sessions: [session({ you: true, checkout: `${REPO}/.claude/worktrees/x`, branch: 'feat/x' })] }], tasks: [] })),
  )
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await line(ui)).toBe('kesselrunner · feat/x · worktree x · task t3 · no other sessions')
  await ui.unmount()
})

test("a supervisor's band draws nothing: its chips are in the status line", async ($, on) => {
  mock.clock(on)
  on('process.run', () => ok(JSON.stringify({ me: { id: ME, supervisor: false, home: 'alpha', task: null }, repos: [{ name: 'kesselrunner', sessions: [session({ you: true })] }], tasks: [] })))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: "the engine's own" })
  })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await line(ui)).toBe("the engine's own")
  await ui.unmount()
})

test('/attach t1 asks rollcall to open the tab and says what it said', async ($, on) => {
  mock.clock(on)
  const calls: string[][] = []
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    if (e.argv[1] === 'attach') return ok('Opened T1 · chat header in a new tab.\n')
    return ok(JSON.stringify({ me: { id: ME, home: 'alpha', task: null }, repos: [] }))
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  await $.session.start(START)
  const r = await $.command.run({ command: 'attach', args: ' t1 ', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(r.text).toBe('Opened T1 · chat header in a new tab.')
  expect(calls.some(c => c.join(' ') === 'rollcall attach t1')).toBe(true)
})

test('the band reports its protocol to rollcall, and turns on when a client attaches to a session that started headless', async ($, on) => {
  mock.clock(on)
  const calls: string[][] = []
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    return ok(JSON.stringify({ me: null, repos: [] }))
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  await $.session.start({ ...START, surface: null, isInteractive: false })
  expect(calls).toHaveLength(0)
  await $.session.attach({ surface: 'terminal', clientId: 'terminal:default' })
  expect(calls.find(c => c[1] === 'status')?.slice(0, 5)).toEqual(['rollcall', 'status', '--json', '--band', '4'])
})

test('a band older than rollcall expects says so above the prompt', async ($, on) => {
  mock.clock(on)
  on('process.run', () => ok(JSON.stringify({ me: { id: ME, supervisor: false, task: null }, bandProtocol: 5, repos: [{ name: 'kesselrunner', sessions: [session({ you: true })] }], tasks: [] })))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start(START)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await line(ui)).toBe('rollcall-band is older than rollcall: /reload-plugins · kesselrunner · main · main checkout · no other sessions')
  await ui.unmount()
})

const picker = (question: string, header = 'Style') =>
  ({
    plugin: 'rollcall-band',
    component: 'AskUserQuestion',
    props: { tool: 'AskUserQuestion', questions: [{ question, header, multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] },
  }) as const

/** A session whose rollcall says it is supervisor `home` (or none); a picker's drawing answers the colored Texts above the engine's dialog. */
async function pickers($: Parameters<Parameters<typeof test>[1]>[0], on: On, home: string | null) {
  mock.clock(on)
  on('process.run', () => ok(JSON.stringify({ me: { id: ME, home, task: null }, repos: [], tasks: [{ id: 't3', title: 'chat header' }] })))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  // The engine's own dialog, which a picker's tree must hold once.
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as const)
  await $.session.start(START)
  return async (question: string, header?: string) => {
    const ui = await $.ui.mount({ ...picker(question, header), surface: 'terminal' })
    const texts = await ui.findAll({ type: 'Text' })
    await ui.unmount()
    return texts.filter(t => typeof t.props.color === 'string' && t.props.color.startsWith('#')).map(t => [t.text, t.props.color])
  }
}

test("above a supervisor's picker, the task the question is for is drawn in the task's color", async ($, on) => {
  const drawn = await pickers($, on, 'falcon')
  expect(await drawn('Which style?', 'luke Style')).toEqual([['luke · chat header', '#BF5AF2']])
  expect(await drawn('Which style?', 'leia Style')).toEqual([['leia', '#30D158']])
  expect(await drawn('Which style?', 'Style')).toEqual([])
  expect(await drawn('Which style?', 'bob Style')).toEqual([])
  expect(await drawn('luke · chat header: Which style?')).toEqual([['luke · chat header', '#BF5AF2']])
  expect(await drawn('🔵 yoda-2 · old tag: Which?')).toEqual([['yoda-2 · old tag', '#0A84FF']])
  expect(await drawn('Which style?')).toEqual([])
  expect(await drawn('bob · x: y?')).toEqual([])
})

test("another session's picker is the engine's alone", async ($, on) => {
  const drawn = await pickers($, on, null)
  expect(await drawn('Which style?', 'luke Style')).toEqual([])
  expect(await drawn('luke · chat header: Which style?')).toEqual([])
})
