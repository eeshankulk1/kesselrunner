// pr-band: the pull request this session is shipping, above the prompt.
//
// Every fact is GitHub's, read through `gh api graphql`, so the band follows a
// PR however it was made: by a ship skill's subagent, by hand, from a phone.
// It finds the PR two ways: the branch of the session's folder, and the URL a
// `gh pr create` run in this session (a subagent's included) printed. It keeps
// following that PR past the merge, branch and worktree gone, until what the
// merge started has settled.
//
// It only draws and toasts. It never appends to the conversation, submits a
// prompt or answers a tool call, so whatever watches CI for the model (a ship
// skill's `gh pr checks --watch`, a deploy watcher) stays the model's one source.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PrItem, PrSnapshot } from '../types'
import { BY_BRANCH, BY_NUMBER, isLive, parse, summarize, transition } from './github'
import type { Repository } from './github'

const TICK_MS = 20_000
const SETTLED_MS = 120_000
const NO_PR_MS = 300_000
// GitHub needs a moment after a push or a merge before it answers with it.
const POKE_MS = 2_000
const GH_TIMEOUT_MS = 15_000
const TITLE_MAX = 32
const NAME_MAX = 28
const FAILED_MAX = 2

const MOVES_A_PR = /\b(git\b[^|;&\n]*\bpush|gh\s+pr\s+(create|merge|ready|close|reopen))\b/
const OPENS_A_PR = /\bgh\s+pr\s+create\b/
const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/

const snapshot = atom({ plugin: 'pr-band', key: 'snapshot' } as const, null)

// Set once an interactive session starts: a headless run polls nothing.
let isOn = false
let isPolling = false
// A poke that arrived mid-poll: that reading may predate the push, so read again.
let isPokedAgain = false
let lastAt = 0
// A PR this session just opened, until a poll has read it.
let wanted: { repo: string; number: number } | null = null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (e.isInteractive) {
      isOn = true
      $.clock.after(0, () => poll($, 0))
      $.clock.every(TICK_MS, () => poll($, 'cadence'))
    }
    return result
  })

  // A turn may have changed branch, pushed or merged without a command below.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (isOn && !e.agentId) {
      $.clock.after(0, () => poll($, TICK_MS))
    }
    return result
  })

  // Watches, never answers: the call's own result goes back untouched.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (isOn && MOVES_A_PR.test(e.command)) {
      const made = OPENS_A_PR.test(e.command) ? PR_URL.exec(`${ran.text ?? ''} ${JSON.stringify(ran.result ?? '')}`) : null
      if (made?.[1] !== undefined && made[2] !== undefined) {
        wanted = { repo: made[1], number: Number(made[2]) }
      }
      $.clock.after(POKE_MS, () => poll($, 0))
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || snap === null) {
      return next(e)
    }
    const { Box, Link, Text } = $.ui.resolve(e)
    const { checks } = snap
    const failed = checks.failed.slice(0, FAILED_MAX)
    const word = verdict(snap)

    return (
      <Box paddingX={1}>
        <Text wrap="truncate-end">
          <Link href={snap.url} label={`PR #${snap.number}`} />
          {e.props.bodyColumns >= 100 ? <Text dimColor>{` ${clip(snap.title, TITLE_MAX)}`}</Text> : null}
          {snap.phase === 'draft' ? <Text dimColor>{' · draft'}</Text> : null}
          {snap.phase === 'merged' ? (
            <Text color="magenta">{` · merged${snap.sha === null ? '' : ` ${snap.sha}`} → ${snap.base}`}</Text>
          ) : null}
          {checks.ok > 0 ? <Text color="green">{` · ✓ ${checks.ok}`}</Text> : null}
          {checks.running > 0 ? <Text color="yellow">{` · ● ${checks.running} running`}</Text> : null}
          {checks.queued > 0 ? <Text dimColor>{` · ○ ${checks.queued} queued`}</Text> : null}
          {failed.map(item => (
            <Text key={item.name} color="red">
              {' · ✗ '}
              {item.url === null ? clip(item.name, NAME_MAX) : <Link href={item.url} label={clip(item.name, NAME_MAX)} />}
            </Text>
          ))}
          {checks.failed.length > failed.length ? (
            <Text color="red">{` +${checks.failed.length - failed.length} more`}</Text>
          ) : null}
          {snap.deploys.map(item => (
            <Text key={item.name} color={COLOR[item.state]}>{` · ${clip(item.name, NAME_MAX)} ${GLYPH[item.state]}`}</Text>
          ))}
          {word === null ? null : (
            <Text color={word.color} dimColor={word.color === undefined}>{` · ${word.text}`}</Text>
          )}
          {snap.isBaseRed ? <Text color="red">{` · ${snap.base} is red`}</Text> : null}
          {snap.productionWord === null ? null : (
            <Text dimColor>{` · production unchanged ("${snap.productionWord}" starts the release)`}</Text>
          )}
        </Text>
      </Box>
    )
  })
}

const GLYPH: Record<PrItem['state'], string> = { ok: '✓', failed: '✗', running: '●', queued: '○' }
const COLOR = { ok: 'green', failed: 'red', running: 'yellow', queued: undefined } as const

/** GitHub's own verdict on merging an open PR, once it has something to say. */
function verdict(snap: PrSnapshot): { text: string; color?: 'green' | 'red' | 'yellow' } | null {
  if (snap.phase === 'merged') {
    return null
  }
  if (snap.merge === 'conflicts') {
    return { text: `conflicts with ${snap.base}`, color: 'red' }
  }
  if (snap.merge === 'behind') {
    return { text: `behind ${snap.base}` }
  }
  const { ok, running, queued, failed } = snap.checks
  if (ok + running + queued + failed.length === 0) {
    return { text: 'no checks' }
  }
  if (!snap.isSettled || failed.length > 0 || snap.phase === 'draft') {
    return null
  }
  if (snap.merge === 'clean') {
    return { text: 'mergeable', color: 'green' }
  }
  return snap.merge === 'blocked' ? { text: 'blocked', color: 'yellow' } : null
}

/** How long a reading stays good: nothing to follow, a settled PR, one in motion. */
function cadence(snap: PrSnapshot | null): number {
  return snap === null ? NO_PR_MS : snap.isSettled ? SETTLED_MS : TICK_MS
}

/** Reads GitHub again unless the last reading is younger than `gap`. */
async function poll($: EngineInterface, gap: number | 'cadence'): Promise<void> {
  if (isPolling) {
    isPokedAgain = isPokedAgain || gap === 0
    return
  }
  isPolling = true
  try {
    const now = await $.clock.now()
    const before = await read($, snapshot)
    if (now - lastAt < (gap === 'cadence' ? cadence(before) : gap)) {
      return
    }
    lastAt = now
    const after = await find($, before, now)
    if (JSON.stringify(after) === JSON.stringify(before)) {
      return
    }
    await update($, snapshot, () => after)
    const news = transition(before, after)
    if (news !== null) {
      $.ui.toast(news)
    }
  } catch {
    // a reading that failed leaves the last one standing
  } finally {
    isPolling = false
    if (isPokedAgain) {
      isPokedAgain = false
      $.clock.after(POKE_MS, () => poll($, 0))
    }
  }
}

/**
 * The PR to show: one just opened here, else the folder's branch's open one,
 * else the one already followed while it is live, else the branch's merged one.
 */
async function find($: EngineInterface, before: PrSnapshot | null, now: number): Promise<PrSnapshot | null> {
  if (wanted !== null) {
    const made = await byNumber($, wanted.repo, wanted.number)
    if (made !== null) {
      wanted = null
      const snap = summarize(made, now)
      if (isLive(snap, now)) {
        return snap
      }
    }
  }
  const mine = summarize(await byBranch($), now)
  if (mine !== null && mine.phase !== 'merged') {
    return mine
  }
  if (before !== null && !(mine !== null && mine.repo === before.repo && mine.number === before.number)) {
    const kept = await byNumber($, before.repo, before.number)
    if (kept === null) {
      return before // GitHub did not answer: keep following
    }
    const snap = summarize(kept, now)
    if (isLive(snap, now)) {
      return snap
    }
  }
  return isLive(mine, now) ? mine : null
}

/** The PRs of the session folder's branch; null outside a repo, off a branch, or with GitHub out of reach. */
async function byBranch($: EngineInterface): Promise<Repository | null> {
  return gh($, ['-F', 'owner={owner}', '-F', 'name={repo}', '-F', 'branch={branch}', '-f', `query=${BY_BRANCH}`])
}

async function byNumber($: EngineInterface, repo: string, number: number): Promise<Repository | null> {
  const [owner = '', name = ''] = repo.split('/')
  return gh($, ['-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`, '-f', `query=${BY_NUMBER}`])
}

async function gh($: EngineInterface, fields: string[]): Promise<Repository | null> {
  try {
    const run = await $.process.run(['gh', 'api', 'graphql', ...fields], { timeoutMs: GH_TIMEOUT_MS })
    return run.exitCode === 0 ? parse(run.stdout) : null
  } catch {
    return null
  }
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
