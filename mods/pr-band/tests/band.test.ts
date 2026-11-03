import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { isLive, summarize } from '../hooks/github'
import type { Repository } from '../hooks/github'

const T0 = Date.parse('2026-10-05T10:00:00Z')
const AT = '2026-10-05T09:59:00Z'

const check = (name: string, status: string, conclusion: string | null = null, startedAt = AT) => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
  detailsUrl: `https://ci.test/${encodeURIComponent(name)}`,
  startedAt,
})
const status = (context: string, state: string) => ({ __typename: 'StatusContext', context, state, targetUrl: null, createdAt: AT })
const commit = (oid: string, nodes: unknown[]) => ({ oid, statusCheckRollup: { contexts: { nodes } } })
const deployment = (environment: string, state: string) => ({
  environment,
  state: 'ACTIVE',
  createdAt: AT,
  latestStatus: { state, environmentUrl: null, logUrl: null },
})

const pr = (over: Record<string, unknown> = {}) => ({
  number: 42,
  title: 'Add the mods marketplace',
  url: 'https://github.com/me/app/pull/42',
  state: 'OPEN',
  isDraft: false,
  mergeStateStatus: 'BLOCKED',
  baseRefName: 'main',
  mergedAt: null,
  commits: { nodes: [{ commit: commit('head000', []) }] },
  mergeCommit: null,
  ...over,
})
const merged = (nodes: unknown[], deployments: unknown[]) =>
  pr({ state: 'MERGED', mergeStateStatus: 'UNKNOWN', mergedAt: '2026-10-05T10:00:00Z', mergeCommit: { ...commit('a1b2c3d4e5', nodes), deployments: { nodes: deployments } } })

const repository = (over: Record<string, unknown> = {}) =>
  ({
    nameWithOwner: 'me/app',
    defaultBranchRef: { name: 'main', target: { statusCheckRollup: { state: 'SUCCESS' } } },
    manifest: null,
    ...over,
  }) as unknown as Repository
const onBranch = (...prs: unknown[]) => repository({ pullRequests: { nodes: prs } })
const byNumber = (one: unknown, over: Record<string, unknown> = {}) => repository({ pullRequest: one, ...over })

const STAGED = JSON.stringify({ release: { production: { words: ['prod', 'production'], skill: 'prod' } } })

const BAND = {
  plugin: 'pr-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

/** What GitHub answers: `branch` to the folder's branch, `number` to a PR asked for by number; null fails the call. */
type World = { branch: Repository | null; number: Repository | null }

/** Stands for `gh`, the engine's toasts and its own band, and says what was asked and said. */
function github(on: On, world: World) {
  const seen = { asked: [] as string[], toasts: [] as string[] }
  on('process.run', (_$, e) => {
    const answer = e.argv.includes('branch={branch}') ? world.branch : world.number
    seen.asked.push(e.argv.includes('branch={branch}') ? 'branch' : (e.argv.find(a => a.startsWith('number=')) ?? '?'))
    const stdout = answer === null ? '' : JSON.stringify({ data: { repository: answer } })
    return { value: { exitCode: answer === null ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: "the engine's own" })
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return seen
}

/** The whole line the band drew. */
const line = async (ui: { find: (query: { type: string }) => Promise<{ text: string } | undefined> }) =>
  (await ui.find({ type: 'Text' }))?.text

test('an open PR shows its checks and conflicts, on every drawing surface', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const head = commit('head000', [
    check('Backend', 'COMPLETED', 'SUCCESS'),
    check('Persona UI', 'COMPLETED', 'SKIPPED'),
    check('Web e2e', 'IN_PROGRESS'),
    check('iOS', 'QUEUED'),
    check('Docs gate', 'COMPLETED', 'FAILURE'),
    status('Vercel', 'PENDING'),
  ])
  github(on, { branch: onBranch(pr({ mergeStateStatus: 'DIRTY', commits: { nodes: [{ commit: head }] } })), number: null })
  await $.session.start(START)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await line(ui)).toBe(
      'PR #42 Add the mods marketplace · ✓ 2 · ● 2 running · ○ 1 queued · ✗ Docs gate · conflicts with main',
    )
    expect((await ui.find({ type: 'Link', text: 'PR #42' }))?.props.href).toBe('https://github.com/me/app/pull/42')
    expect((await ui.find({ type: 'Link', text: 'Docs gate' }))?.props.href).toBe('https://ci.test/Docs%20gate')
    await ui.unmount()
  }
})

test('checks going green are toasted once and the PR reads mergeable', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const running = pr({ commits: { nodes: [{ commit: commit('head000', [check('Backend', 'IN_PROGRESS')]) }] } })
  const green = pr({ mergeStateStatus: 'CLEAN', commits: { nodes: [{ commit: commit('head000', [check('Backend', 'COMPLETED', 'SUCCESS')]) }] } })
  const world: World = { branch: onBranch(running), number: null }
  const seen = github(on, world)
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await line(ui)).toBe('PR #42 Add the mods marketplace · ● 1 running')

  world.branch = onBranch(green)
  await clock.advance(20_000)
  expect(await line(ui)).toBe('PR #42 Add the mods marketplace · ✓ 1 · mergeable')
  expect(seen.toasts).toEqual(['PR #42: checks green'])

  // Settled, it is read every two minutes, not every tick.
  const asked = seen.asked.length
  await clock.advance(100_000)
  expect(seen.asked.length).toBe(asked)
  await clock.advance(20_000)
  expect(seen.asked.length).toBe(asked + 1)
  expect(seen.toasts.length).toBe(1)
  await ui.unmount()
})

test('a merged PR is followed by number once its branch is gone, through its deploys, then leaves', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const open = pr({ mergeStateStatus: 'CLEAN', commits: { nodes: [{ commit: commit('head000', [check('Backend', 'COMPLETED', 'SUCCESS')]) }] } })
  const world: World = { branch: onBranch(open), number: null }
  const seen = github(on, world)
  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  // Merged: the worktree is removed, so the folder's branch answers nothing.
  world.branch = null
  world.number = byNumber(merged([check('Backend', 'IN_PROGRESS')], [deployment('app / staging', 'IN_PROGRESS')]), { manifest: { text: STAGED } })
  await clock.advance(120_000)
  expect(await line(ui)).toBe(
    'PR #42 Add the mods marketplace · merged a1b2c3d → main · ● 1 running · app / staging ● · production unchanged ("prod" starts the release)',
  )

  world.number = byNumber(
    merged([check('Backend', 'COMPLETED', 'SUCCESS')], [deployment('app / staging', 'SUCCESS'), deployment('Preview', 'SUCCESS')]),
    { manifest: { text: STAGED } },
  )
  await clock.advance(20_000)
  expect(await line(ui)).toContain('✓ 1 · app / staging ✓ · Preview ✓ · production unchanged')
  expect(seen.toasts).toEqual(['PR #42 merged', 'PR #42: deployed (app / staging, Preview)'])

  await clock.advance(31 * 60_000)
  expect(await line(ui)).toBe("the engine's own")
  await ui.unmount()
})

test('a production deployment on the merge commit drops the production note', async () => {
  const snap = summarize(
    byNumber(merged([], [deployment('app / staging', 'SUCCESS'), deployment('Production', 'SUCCESS')]), { manifest: { text: STAGED } }),
    T0,
  )
  expect(snap?.productionWord).toBe(null)
  expect(summarize(byNumber(merged([], [deployment('Production', 'SUCCESS')])), T0)?.productionWord).toBe(null)
})

test('a check that ran twice counts once, by its latest run, and a red base is flagged', async () => {
  const head = commit('head000', [
    check('Docs gate', 'COMPLETED', 'FAILURE', '2026-10-05T09:50:00Z'),
    check('Docs gate', 'COMPLETED', 'SUCCESS', '2026-10-05T09:58:00Z'),
  ])
  const snap = summarize(
    repository({
      defaultBranchRef: { name: 'main', target: { statusCheckRollup: { state: 'FAILURE' } } },
      pullRequests: { nodes: [pr({ commits: { nodes: [{ commit: head }] } })] },
    }),
    T0,
  )
  expect(snap?.checks).toEqual({ ok: 1, running: 0, queued: 0, failed: [] })
  expect(snap?.isBaseRed).toBe(true)
})

test('a stacked PR is not held to the default branch: no red base, no production note', async () => {
  const red = { name: 'main', target: { statusCheckRollup: { state: 'FAILURE' } } }
  const open = summarize(repository({ defaultBranchRef: red, pullRequests: { nodes: [pr({ baseRefName: 'feat/base' })] } }), T0)
  expect(open?.isBaseRed).toBe(false)
  const done = summarize(byNumber({ ...merged([], []), baseRefName: 'feat/base' }, { manifest: { text: STAGED } }), T0)
  expect(done?.productionWord).toBe(null)
})

test('a merge whose deployment never reports is given up on after hours, not kept forever', () => {
  const stuck = summarize(byNumber(merged([], [deployment('app / staging', 'QUEUED')])), T0)
  expect(isLive(stuck, T0 + 60 * 60_000)).toBe(true)
  expect(isLive(stuck, T0 + 4 * 60 * 60_000)).toBe(false)
})

test('a PR opened by a command in this session is followed from a folder that has none', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const world: World = { branch: onBranch(), number: byNumber(pr({ commits: { nodes: [{ commit: commit('head000', [check('Backend', 'QUEUED')]) }] } })) }
  const seen = github(on, world)
  const answer = { result: { stdout: 'https://github.com/me/app/pull/42\n', stderr: '' }, text: 'https://github.com/me/app/pull/42' }
  on('tool.call', () => answer as never)
  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await line(ui)).toBe("the engine's own")

  // The band watches the call and hands its result back as it came.
  const ran = await $.tool.call({ tool: 'Bash', command: 'git -C /wt push -u origin HEAD && gh pr create --title "Add mods"' })
  expect(ran.text).toBe(answer.text)
  await clock.advance(2_000)
  expect(seen.asked).toContain('number=42')
  expect(await line(ui)).toBe('PR #42 Add the mods marketplace · ○ 1 queued')

  // A command that moves no PR asks GitHub nothing.
  const asked = seen.asked.length
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  await clock.advance(2_000)
  expect(seen.asked.length).toBe(asked)

  // A push from a folder whose path has a space is still a push.
  await $.tool.call({ tool: 'Bash', command: 'git -C "/Users/me/My Projects/app" push' })
  await clock.advance(2_000)
  expect(seen.asked.length > asked).toBe(true)
  await ui.unmount()
})

test('GitHub out of reach leaves the last reading standing', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const world: World = { branch: onBranch(pr({ commits: { nodes: [{ commit: commit('head000', [check('Backend', 'IN_PROGRESS')]) }] } })), number: null }
  github(on, world)
  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  world.branch = null
  await clock.advance(60_000)
  expect(await line(ui)).toBe('PR #42 Add the mods marketplace · ● 1 running')
  await ui.unmount()
})

test('a headless run asks GitHub nothing', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = github(on, { branch: onBranch(pr()), number: null })
  on('tool.call', () => ({ result: { stdout: '', stderr: '' } }) as never)
  await $.session.start({ ...START, surface: null, isInteractive: false })
  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 42 --merge' })
  await clock.advance(60_000)
  expect(seen.asked).toEqual([])
})
