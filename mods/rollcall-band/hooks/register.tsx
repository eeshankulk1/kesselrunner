// rollcall-band: who else is in this repo, above the prompt.
//
// The band turns on in any session a person can reach: the REPL in a terminal,
// or a background session, whose REPL runs whether or not someone is attached;
// a -p run turns it on only if a client attaches. session.start, a 15 s timer
// and each main-loop turn.complete run `rollcall status --json` (passing this
// session's context use and the band's protocol) and keep a summary of it in
// $.state. ui.render (AbovePrompt) draws the summary as one line; with nothing
// to show it draws nothing.
//
// A supervisor's band draws nothing: its task chips are in Claude Code's status
// line (`rollcall statusline`), and its routing (@t3, picks, the watcher) is in
// rollcall's hooks, so none of it waits on a band that loaded before a sync.
// What stays here is /attach luke, which asks rollcall to show that task's
// worker, and, above a supervisor's picker, the task each question is for
// ("luke · chat header", found by the name that starts the question's header),
// drawn in the task's color, the color of its chip and its tab.
//
// Anywhere: when rollcall expects a newer band than this one (it loaded before
// a sync pulled a new one), the band says so above the prompt: /reload-plugins.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Peer, RepoLine, Snapshot } from '../types'

const REFRESH_MS = 15_000
const PEERS_MAX = 3
const DOING_MAX = 36
// What this band can do, reported to rollcall on every refresh; rollcall's BAND_PROTOCOL in
// packages/rollcall/src/cli.mjs says what it expects, and a band that reports less says so above the prompt.
// 4: no supervisor work here.
const BAND_PROTOCOL = 4
// Each task's color and name by its number, as TASK_COLORS and CHARACTERS in packages/rollcall/src/supervisor.mjs give them.
const COLORS = ['#0A84FF', '#30D158', '#BF5AF2', '#FF9F0A', '#FFD60A', '#FF453A']
const CHARACTERS = ['yoda', 'leia', 'luke', 'han', 'rey', 'finn', 'poe', 'lando', 'chewie', 'ahsoka', 'padme', 'anakin', 'grogu', 'mace', 'hera', 'ezra', 'jyn', 'wedge']

const snapshot = atom({ plugin: 'rollcall-band', key: 'snapshot' } as const, null)

// What `rollcall status --json` prints, the fields read here.
type RollcallSession = {
  id: string
  you: boolean
  checkout: string
  main: string
  branch: string
  live: boolean
  intent: string | null
  claim: { intent: string } | null
  waits: string[]
}
type RollcallStatus = {
  me?: { id: string; home?: string | null; task: string | null } | null
  /** The band protocol this rollcall expects; more than BAND_PROTOCOL means this band is older. */
  bandProtocol?: number
  repos?: { name: string; sessions: RollcallSession[] }[]
  /** A supervisor's tasks. */
  tasks?: { id: string; title: string }[]
}

// The last summary written, so an unchanged poll redraws nothing.
let written = ''
// Set once an interactive session starts: a headless run reads nothing.
let isOn = false

export const register: Register = on => {
  // A background session's REPL is interactive whether or not anyone is attached; a client attaching to a
  // session that started without one turns the band on then.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (e.isInteractive || e.surface !== null) {
      await turnOn($)
    }
    return result
  })

  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    if (!isOn) {
      await turnOn($)
    }
    return result
  })

  // A turn may have moved the session into a worktree or claimed something.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (isOn && !e.agentId) {
      await refresh($)
    }
    return result
  })

  // rollcall opens the tab (or says what to run): the band only passes the words on.
  on('command.run', { command: 'attach' }, async ($, e) => {
    const out = await $.process.run(['rollcall', 'attach', ...e.args.trim().split(/\s+/).filter(Boolean)], { timeoutMs: 15_000 }).catch(() => null)
    if (out === null) {
      return { text: 'rollcall could not run: `rollcall attach <task>` in a shell says why.' }
    }
    return { text: (out.exitCode === 0 ? out.stdout : out.stderr || out.stdout).trim() || 'Usage: /attach <task>, e.g. /attach luke' }
  })

  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    const tasks = snap?.supervisor === true ? taskLines(e.props.questions, snap.titles) : []
    if (tasks.length === 0) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const dialog = await next(e)
    return (
      <Box flexDirection="column">
        {tasks.map(t => (
          <Text key={t.tag} bold color={t.color}>
            {t.tag}
          </Text>
        ))}
        {dialog}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || snap === null) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const stale = snap.stale ? <Text color="yellow">rollcall-band is older than rollcall: /reload-plugins{snap.line === null ? '' : ' · '}</Text> : null
    const line = snap.line
    if (line === null) {
      return stale === null ? next(e) : (
        <Box paddingX={1}>
          <Text wrap="truncate-end">{stale}</Text>
        </Box>
      )
    }
    const shown = line.peers.slice(0, PEERS_MAX)
    const hidden = line.peers.length - shown.length
    return (
      <Box paddingX={1}>
        <Text wrap="truncate-end">
          {stale}
          <Text dimColor>
            {line.repo} · {line.branch} · {line.worktree === null ? 'main checkout' : `worktree ${line.worktree}`}
            {line.task === null ? '' : ` · task ${line.task}`}
            {line.claim === null ? '' : ` · claim: ${clip(line.claim)}`}
          </Text>
          {shown.length === 0 ? (
            <Text dimColor>
              {' '}
              · no other sessions
            </Text>
          ) : (
            <Text color="yellow">
              {' '}
              · {line.peers.length} other {line.peers.length === 1 ? 'session' : 'sessions'}:
            </Text>
          )}
          {shown.map(peer => (
            <Text key={peer.id} color={peer.isWaitingOnYou ? 'magenta' : 'yellow'} bold={peer.isWaitingOnYou}>
              {' '}
              {peer.id} {peer.branch}
              {peer.isWaitingOnYou ? ' waiting on you' : ` "${clip(peer.doing)}"`}
            </Text>
          ))}
          {hidden > 0 ? <Text dimColor>{` +${hidden} more`}</Text> : null}
          {line.idle > 0 ? <Text dimColor>{` · ${line.idle} idle`}</Text> : null}
        </Text>
      </Box>
    )
  })
}

async function turnOn($: EngineInterface): Promise<void> {
  isOn = true
  try {
    await $.command.register({ name: 'attach', description: "Show a task's worker (its tab inside falcon)", argumentHint: '<task, e.g. luke or t3>', immediate: true })
  } catch {
    // the band still draws without its command
  }
  await refresh($)
  $.clock.every(REFRESH_MS, () => refresh($))
}

/** A command's stdout when it exits 0, else null (missing, failed, timed out). */
async function run($: EngineInterface, argv: string[]): Promise<string | null> {
  try {
    const result = await $.process.run(argv, { timeoutMs: 5000 })
    return result.exitCode === 0 ? result.stdout : null
  } catch {
    return null
  }
}

async function refresh($: EngineInterface): Promise<void> {
  let next: Snapshot | null = null
  let percent: number | undefined
  try {
    percent = (await $.session.usage()).context.percent
  } catch {
    // no reading yet: the heartbeat waits for the next refresh
  }
  const context = percent === undefined ? [] : ['--context', String(Math.round(percent))]
  const out = await run($, ['rollcall', 'status', '--json', '--band', String(BAND_PROTOCOL), ...context])
  try {
    if (out !== null) {
      next = summarize(JSON.parse(out) as RollcallStatus)
    }
  } catch {
    // rollcall printed no JSON: the band hides
  }
  const text = JSON.stringify(next)
  if (text === written) {
    return
  }
  written = text
  await update($, snapshot, () => next)
}

/** The summary to draw, or null when there is nothing: no rollcall session for this process, or a supervisor's. */
export function summarize(status: RollcallStatus): Snapshot | null {
  const me = status.me ?? null
  const stale = (status.bandProtocol ?? 0) > BAND_PROTOCOL
  // A supervisor's chips are in the status line; only a stale band has something to say there.
  const supervisor = !!me?.home
  const line = supervisor ? null : repoLine(status)
  if (line === null && !stale && !supervisor) {
    return null
  }
  const titles = Object.fromEntries((status.tasks ?? []).map(t => [t.id, t.title]))
  return { line: line === null ? null : { ...line, task: me?.task ?? null }, ...(stale ? { stale: true } : {}), ...(supervisor ? { supervisor: true, titles } : {}) }
}

/**
 * The tasks a picker's questions are for, each with its color: rollcall starts a question's header with the
 * task's name ("luke Ship"), and the line drawn is the task's label ("luke · chat header", its title from
 * rollcall's task list). A question tagged in its text ("luke · chat header: ...", a colored dot before it), as
 * rollcall did until 2026-10-18, still counts.
 */
export function taskLines(questions: unknown[], titles: Record<string, string> = {}): { tag: string; color: string }[] {
  const lines: { tag: string; color: string }[] = []
  for (const q of questions) {
    const { question, header } = (q ?? {}) as { question?: unknown; header?: unknown }
    const t = taskOf(header, HEADER) ?? taskOf(question, TAGGED)
    if (t === null) {
      continue
    }
    const title = titles[`t${t.n}`] ?? t.title
    const tag = title === null ? t.name : `${t.name} · ${title}`
    if (!lines.some(l => l.tag === tag)) {
      lines.push({ tag, color: COLORS[(t.n - 1) % COLORS.length] })
    }
  }
  return lines.slice(0, 3)
}

const HEADER = /^([a-z]+)(?:-(\d+))?(?: |$)/
const TAGGED = /^(?:(?:🔵|🟢|🟣|🟠|🟡|🔴) )?([a-z]+)(?:-(\d+))?( · [^\n]+?): /u

/** The task a header or a tagged question names: its name ("yoda-2"), number, and the title a tag carries. */
function taskOf(text: unknown, re: RegExp): { name: string; n: number; title: string | null } | null {
  const m = typeof text === 'string' ? re.exec(text) : null
  const i = m ? CHARACTERS.indexOf(m[1]) : -1
  if (m === null || i < 0 || (m[2] !== undefined && Number(m[2]) < 2)) {
    return null
  }
  return { name: `${m[1]}${m[2] === undefined ? '' : `-${m[2]}`}`, n: (Number(m[2] ?? 1) - 1) * CHARACTERS.length + i + 1, title: m[3]?.slice(3) ?? null }
}

function repoLine(status: RollcallStatus): RepoLine | null {
  for (const repo of status.repos ?? []) {
    const me = repo.sessions.find(s => s.you)
    if (me === undefined) {
      continue
    }
    const others = repo.sessions.filter(s => !s.you)
    const peers: Peer[] = others
      .filter(s => s.live)
      .map(s => ({
        id: s.id.slice(0, 8),
        branch: s.branch,
        doing: s.claim?.intent ?? s.intent ?? '',
        isWaitingOnYou: s.waits.includes(me.id),
      }))
    return {
      repo: repo.name,
      branch: me.branch,
      worktree: me.checkout === me.main ? null : (me.checkout.split('/').pop() ?? me.checkout),
      claim: me.claim?.intent ?? null,
      task: null,
      peers,
      idle: others.length - peers.length,
    }
  }
  return null
}

function clip(text: string, max = DOING_MAX): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}
