---
status: active
date: 2026-11-08
decided-with-owner: 2026-11-08 (cockpit task t28 "Chat view rethink": one host owns every agent; cockpit docs/plans/2026-11-08-agent-host.md)
covers: "rollcall's agent host: one long-lived process that runs every task worker as its child (Claude Code in stream mode, Codex on its app server), owns each agent's state, keeps one history per task across sessions, saves questions and permission prompts as requests, and pushes all of it to front ends over a socket"
---

# Agent host (rollcall side)

The plan this serves is cockpit's `docs/plans/2026-11-08-agent-host.md` (section "rollcall becomes the agent host").
This file records how rollcall builds it, so a fresh worker carries on from the same shapes. It builds on
`2026-11-08-chat-stream.md`: the facts about Claude Code's stream mode there still hold, and the host speaks that
protocol directly (no Agent SDK package: rollcall stays dependency-free). Codex stays on its app server.

## Slices

1. **This one.** The host, its agents (task workers only), their state, history and requests, the push socket, and
   the seam that keeps the rest of rollcall working. Behind `ROLLCALL_HOST=1`. Built: all of it, for Claude Code and Codex
   workers. Each harness has one copy of its protocol code, which the tmux workers run too.
2. Supervisors in the host, and the supervisor's tools (start, tell, wait, interrupt, read the chat) instead of typing
   into tmux. Built (see Supervisors and The supervisor's tools).
3. The terminal escape hatch: "open in terminal" runs the real CLI on the agent's session; the host shows it busy until
   the terminal closes. Built with slice 2 (see The terminal escape hatch).
4. The terminal Falcon's new form (an open owner question).
5. Removing the old paths (the chat/terminal switch, the pane view, `capture-pane`, key timing, `stream.live.json`,
   the per-chat follow processes) and the gate. cockpit moves onto the host.

## The process

- `rollcall host` runs the host in the foreground; `rollcall host status` and `rollcall host stop` talk to a running
  one. Clients never run it by hand: `host/client.mjs ensureHost()` connects, and when nothing answers it starts
  `rollcall host` detached (its own process group, stdio to the log), so it outlives cockpit, the Falcon and the
  terminal that started it.
- One host per store (`ROLLCALL_HOME`), so a test's throwaway home gets its own.
- Files, under `<store>/_host/`:
  - `host.lock`: `{ pid, at }`, made with `O_EXCL`. A second host finds it held by a live pid and exits 0. A lock left
    by a dead pid is taken over.
  - `host.json`: `{ pid, sock, at, version }`, written once it listens.
  - `host.log`: what it did, one line each; the detached process's stdout and stderr also go here.
- The socket is `rollcall-host-<8 hex of the store path's hash>.sock` in the system temp folder (a unix socket path is
  short on macOS), mode 0600.
- On start it rebuilds its state from disk: every task's `agent.json` (below). An agent recorded `running` or `idle`
  has no process now (the host that ran it is gone), so it becomes `parked`, with a `system` item saying the host
  restarted. One recorded `terminal` is handled as The terminal escape hatch says. Open requests stay open (see
  Requests). Nothing starts by itself.
- On SIGTERM it closes each agent's input (Claude Code finishes and exits, its transcript saved), parks them all, and
  exits. `host stop` does the same.

## Agents

An agent is one task's worker, named by its ref (`falcon:t3`). Its files live in the task's worker folder
(`store.workerDir(h, id)`), beside the launch files the harness adapter writes:

- `agent.json`: the host's record, swapped in whole on every change:
  `{ ref, home, task, harness, state, session, sessions, since, turnAt, parkedAt, model, mode, pid, host, terminal }`.
  `pid` is the child's, `host` the host's pid. `terminal` is `{ at, cwd, pid, start }` while the agent is open in a
  terminal (`pid` and `start` the `rollcall open` process's), else null. Anything in rollcall may read it; only the host writes it.
- `history.jsonl`: the task's one history (below).
- `claude.json` (Claude) or `codex.json` (Codex): the compatibility record (see The seam).

### The runtimes

- **Claude** (`claude/stream.mjs` `startClaude`, the one copy of the stream code: the tmux worker's chat view runs it
  too, adding only its pane, live file and switch): `claude -p --input-format stream-json --output-format stream-json
  --include-partial-messages --verbose --replay-user-messages --permission-prompt-tool stdio`, plus the launch's
  `--session-id` or `--resume`, `--add-dir`, `--settings`, mode, model and effort, from `claude-launch.json` (as
  `harness/claude.mjs writeLaunch` writes it). It runs under the owner's login shell
  (`$SHELL -lc '. <host-env.sh>; exec "$@"'`): `host-env.sh` holds the task's environment lines the tmux launch
  script started with (`ROLLCALL_TASK`, the worktree's ports, the wait for a setup still running). The stream's
  messages fold into items with conversation.mjs's own folder (`createFolder`), so the host's items are the ones a
  transcript read gives, same ids. Mapping: a replayed user message starts a turn (one that joins a running turn
  becomes the transcript's `queued_command`); each finished block's `assistant` message adds its block; a
  `tool_result` closes its tool; `result` ends the turn with its time, tokens and error; `compact_boundary` is a
  compaction. Messages under a subagent (`parent_tool_use_id`) fold into that subagent's own folder, their items
  carrying `parent`.
- **Codex** (`host/codex.mjs` on `codex/session.mjs` `startCodex`, the one copy of the Codex code: the tmux worker
  runs it too, adding only its two views, live file, record and control socket). `codex app-server` on a unix socket
  (`rollcall-codex-<host pid>-<hex>.sock` in the temp folder), under the login shell with `host-env.sh` as Claude
  is, one thread per session (`thread/start`, or `thread/resume` on the launch file's `thread`, which the session
  writes back once the thread runs, so a wake resumes it). Items mapped with `codex/items.mjs` (the session still
  writes the journal too). Item ids get the session's first 8 characters as a prefix (`3f2a9c1d:item-4`): Codex
  numbers live items per process, so two sessions would reuse them. A user message keeps its client id as its id
  (the owner's `uuid`, or `rollcall-d-<hex>` for rollcall's words, so the prompt-submit hook knows whose they are).
  startCodex carries what the tmux worker did itself: the hooks (`workerHook`: prompt-submit, stop, stop-failure,
  dialog, clear, ask, cap, session-start, session-end), the turn snapshots, the usage-limit wait, the context file and
  cap flag, the untrusted-hooks note and the thread on the task's session. Differences from Claude: a turn starts with
  `turn/started` (the host's `turn-start` event), the mode cannot change (`set` takes a model only), and words
  steered in as a turn ended and never taken leave the queue after 3 s, as in the tmux worker. `agent.json` keeps the
  app server's socket (`serverSock`): a restarted host stops a server the killed one left (pid and socket must match).

### State

One state per agent, owned by the host:

| `state` | Means | Send does (`send`) |
|---|---|---|
| `running` | a turn runs | `join`: the words go into the running turn |
| `idle` | the process is up, no turn | `start`: a turn starts |
| `parked` | no process; the session is saved | `wake`: resume the session, then deliver |
| `stopped` | stopped on purpose (`stop`, `task.stop`) | `wake` for the owner's words; rollcall's own deliveries are refused |
| `terminal` | open in a terminal (the escape hatch); the host holds no process | `hold`: the words wait until the terminal closes |

`requests` (the open ones) and `queued` (words sent while running, not taken yet) ride with it. An `idle` agent parks
after `ROLLCALL_HOST_PARK_MS` of quiet (default an hour, as Claude Code's own background agents), never with a
request open or words waiting. Parked means no process and nothing else: the history and requests stay, and a message
resumes the session and delivers.

## History

One history per task, across sessions: `history.jsonl`, append-only, one event per line:

```
{ "seq": 1, "at": 1762600000000, "ev": "session", "session": "<id>", "harness": "claude", "how": "new" | "resume" | "backfill" }
{ "seq": 2, "at": ..., "ev": "item", "session": "<id>", "item": { "id", "at", "kind", ... } }
{ "seq": 3, "at": ..., "ev": "request", "request": { "id", "at", "kind", "tool", ..., "session" } }
{ "seq": 4, "at": ..., "ev": "closed", "id": "<request id>", "how": "answered" | "cancelled" | "words", "by": "<client>", "answer": { ... } }
```

- Items use the conversation kinds (`user`, `assistant`, `thinking`, `tool`, `subagent`, `todos`, `compaction`,
  `turn`, `system`). A later `item` with the same `id` replaces the earlier one in place (a tool's result arrived).
  Streamed text is never logged: a text block is logged once, finished; its deltas go only to subscribers.
- A fresh start, a handoff (a new session) or a resume appends a `session` event and carries on in the same file.
- **Backfill.** Before the host first appends to a task's history, every earlier session of the task the file does not
  name yet is folded from its Claude transcript or Codex journal (conversation.mjs `readPage`, with subagent children
  and turn times) and written as `session` (`how: "backfill"`) plus its items. A read of a task with no history file
  writes the backfill the same way.
- **Pages.** The items in order of first appearance; a page is the last `limit` (200), or those before `before`.
  `cursor` is the page's oldest item id (stable: ids never change); children come right after their subagent and do
  not count toward the limit. The same page shape as `api conversation`.

## Requests

A question or permission prompt is a saved request: the `request` event, with the contract's prompt shape plus
`ref` and `session`. Its `id` is the host's (`rq-<12 hex>`), not Claude Code's request id (which the host keeps in
memory, mapped), so a request keeps its id across a restart.

- Answered from any client (`answer`, or the compat socket's `answer`); the first answer wins, closes it (`closed`,
  `how: "answered"`) and goes to the process. A second answer hears `already-answered` (the socket's `answer` op
  returns `{ ok: true, already: true }`, as the stream worker's did).
- Claude Code cancelling it closes it with `how: "cancelled"`.
- **Answered after its process is gone** (a crash, a host restart): the host wakes the agent on its session and
  delivers the answer as the owner's words, so the owner never meets a dead end. Allowed: "The owner approved <what>
  after this session restarted. Go ahead with it." Declined: "The owner declined <what>[: why]." A question: the
  question and the picked answer. It closes with `how: "words"`.
- The dialog flag (`delivery.mjs dialogFlag`) clears with the last open request, as in the stream worker.

## The socket protocol

Newline-delimited JSON both ways. A call is `{ "id": <any>, "op": "...", ... }`; its answer is
`{ "id", "ok": true, ... }` or `{ "id", "ok": false, "error": { "code", "message" } }`. Codes are the API's
(`bad-payload`, `not-found`, `refused`, `already-answered`, `failed`).

| `op` | Payload | Answer |
|---|---|---|
| `hello` | | `pid`, `version`, `interface` |
| `list` | | `agents`: each agent's state |
| `state` | `ref` | `agent` |
| `start` | `ref`, optional `prompt` (text), `restart` | `agent`; reads `claude-launch.json`. With `restart` (what `launch` sends) a launch file for another session replaces the running process, and one for the same session gives its first prompt as words |
| `say` | `ref`, `text`, optional `attachments` (paths), `from` (`owner`, `rollcall`), `uuid` | `how` (`sent`, `queued`, `resumed`), `uuid` |
| `interrupt` | `ref` | `interrupted` |
| `answer` | `request`, and by kind: `allow`, `why`, `always`, `mode`; `answers` | `answered`, `how` |
| `set` | `ref`, `model` and/or `mode` (`default`, `acceptEdits`, `plan`) | `set` |
| `park` | `ref` | `parked` |
| `stop` | `ref` | `stopped` |
| `history` | `ref`, optional `before`, `limit` | a page: `items`, `cursor`, `more`, `requests`, `agent` |
| `subscribe` | optional `refs` (all when absent) | `subscribed`; then events on the same connection |
| `open` | `ref` | `argv`: `rollcall open <ref>`, for a front end's own terminal |
| `terminal` | `ref` | `argv`, `cwd`, `unset`, `agent`; the escape hatch begins (held by its connection) |
| `terminal-done` | `ref` | `closed`, `added`, `agent` |
| `terminal-end` | `ref` | `closing`, `agent`: the terminal closes once its turn ends |
| `shutdown` | | `ok`, then the host exits |

Events on a subscribed connection: `{ "type": "event", "v": 1, "seq", "at", "ref", "ev", ... }` with `ev`:

- `state`: `agent` (the whole state, as `state` answers)
- `item`: `item` (new, or replacing the one with its id)
- `text`: `id`, `kind`, `append`, `parent` (streamed text on an item not logged yet)
- `request`: `request` (opened); `closed`: `id`, `how`, `by`
- `session`: `session`, `how`

## The seam (what keeps the rest of rollcall working)

Delivery, `task tell`, answers and away mode reach a worker through `claude/live.mjs record()` and its control socket.
The host keeps that seam for each hosted agent:

- It writes the compat record (`claude.json`, or `codex.json` with `ctl`) with `pid` = the host's pid,
  `sock` / `ctl` = a control socket per agent served by the host, `view: "chat"`, `session`, `busy` and the first open
  request as `prompt`; a Codex agent's adds `thread` and `turn`, so `harness/codex.mjs` sees a worker that takes words. It stays while the agent is parked (a `say` wakes it) and goes when the agent stops.
- The control socket takes the stream worker's ops (`say`, `interrupt`, `answer`, `set`, `state`); `switch` is
  `refused` (no terminal view until the escape hatch).
- `supervisor.mjs workerState` reads `agent.json` for a session the host runs (`hosted: true` on the session):
  `alive` while `running` or `idle`, `parked`, `stopped`; busy and idle still come from the hooks' status log.
- `launch` asks the host to `start` (with the harness); `stopWorker` asks it to `stop`; `park` asks it to `park` (the host also parks on
  its own timer, and `parkDue` leaves hosted agents to it).
- `api conversation <ref>` reads a hosted task's history (from the host when it runs, else from the file), and
  `--follow` subscribes, printing the same `page`, `item`, `text`, `prompt` lines as before.

## Supervisors

- A supervisor's own session is an agent like a task's worker: ref the bare home (`falcon`), files in the home's own
  worker folder (`workers/<home>/`: `claude-launch.json`, `agent.json`, `history.jsonl`, `claude.json`), Claude Code
  only. Its history is its own. Backfill reads its last session (the one its lock or `falcon.json` names) and the one a
  launch resumes, from their transcripts.
- `window.mjs supervisorHosted(h)`: the gate is on, or the host ran it before. Then `startWindow` writes the same launch
  file the stream worker reads and asks the host to `start` it (`restart`, so a handoff's new session replaces the
  running one), and `parkWindow` asks the host to `park`. `park.mjs supervisorDue` leaves it to the host's own timer.
- The watcher (`watch.mjs hostedNow`) reads where it stands from `agent.json`, not a window: `running` is busy (a
  picker when a request is open), `idle` and `parked` are idle, `terminal` is the terminal. News goes in through the
  host's `say` (`from: "rollcall"`), which wakes a parked supervisor on its session. A handover skips the key checks.
- The owner's words to a hosted supervisor write `app-line`, as the chat-view supervisor's composer did, so the prompt
  hook hears them as the owner's.
- **Relayed questions.** A supervisor's question whose every question names one task that asks now carries
  `relays: { ref, question }` (`claude/worker.mjs relaysOf`). It is that task's request, answered once:
  - On the supervisor's request (`answer` with `answers`), the host runs `question.answer` for the task in a child
    process (never in its own: delivery reaches agents through control sockets the host serves, and a synchronous call
    there would wait on itself). That delivers to the worker and marks the task answered; closing the Falcon's picker
    (`answer.mjs closeFalconPicker`) then answers the supervisor's request through its seam with "answered elsewhere".
    The answer reads `how: "relayed"`. A task that asks nothing now leaves the pick to the supervisor, as its picker did.
  - On the task (`question.answer` from a front end), `closeFalconPicker` finds the supervisor's chat-view record and
    closes its request the same way.
  - A second answer from either side hears `already-answered` (the task's lock, then the request's).

## The supervisor's tools

The supervisor drives a hosted worker through the host only. Existing commands, unchanged for tmux workers:
`start.mjs` (`supervisor.mjs launch`: the host's `start`), `task tell` (inbox plus the doorbell through the seam, or
`say` when the host is down), `start.mjs --interrupt` (`api-actions task.interrupt`: the host's `interrupt`), `--stop`
and `--resume` (no window check for a hosted task). New verbs (`src/task-agent.mjs`):

- `task chat <id> [--before <cursor>] [--limit <n>] [--json]`: a page of the worker's chat (the host's `history`; for a
  tmux worker, its transcript), one line per item.
- `task interrupt <id>`: its turn stops.
- `task wait <id> [--timeout <minutes>]`: subscribes and returns when its turn ends or it opens a request (hosted only:
  a tmux worker's news comes by itself).

No path that serves a hosted agent runs `capture-pane`, `send-keys` or key timing. The Claude harness's `type`,
`interrupt` and `takesTyping` go to the host even when its record is gone; the watcher's prompt, close and parking
checks skip `tmux.watched`, `viewed` and `lastUsed` for hosted workers; `supervise` does not probe tmux under the gate.
Still on tmux under the gate, and none of them reaches a hosted agent: the watcher's own tab bar (`setTabs`,
`windows`), `/attach` and `api attach` (no window: they say so), `falcon`'s check for a running tmux, and the
gate-off paths.

## The terminal escape hatch

`rollcall open <ref>` (`host/client.mjs openCommand`) runs the real CLI on the agent's own session in the caller's
terminal. Front ends that run their own terminal ask the socket's `open` for the argv, which is that same command.

- It calls `terminal` and holds the connection for as long as the CLI runs. The host refuses while a turn runs, ends
  its own process for the agent (two processes never share a session), and answers the argv: `claude --resume
  <session>` with the launch's `--add-dir`, `--settings`, mode, model and effort, under the login shell with
  `host-env.sh` when the task has one (a session that never ran gets `--session-id`, `-n` and its first prompt, as the
  stream worker's terminal view did); or `codex resume <thread>`. The agent is `terminal` (`send: "hold"`).
- Meanwhile: `say` holds the words (`how: "held"`, shown queued) and they go in when the terminal closes; `interrupt`
  and `start` are refused with the reason; `park` does nothing; the idle timer does not run. Held words also sit on
  `agent.json` (`held`, each with its uuid), so a restarted host shows and sends them; they leave it in the same write
  that hands them to the new process, so a later restart never sends them twice.
- On exit (`terminal-done`, or the connection closing): the host appends what the terminal added that the history
  lacks, in order, the agent is `parked`, and held words start it. A Claude session's items come from its transcript
  (`history.mjs catchUp`). `codex resume` writes no journal, so a Codex agent's come from the thread itself
  (`host/codex.mjs terminalTurns`): `thread/read` with its turns on a short-lived `codex app-server` (under the login
  shell with `host-env.sh`, as the agent runs), less every turn the history already has (its `turn-start` or
  `turn-end` item) and any that started before the terminal opened. The new turns' items get historyItems' ids
  (`<turn>:<item>`) with the session's prefix, so they never meet a live item's, and their lines also go in the
  session's journal. Only when that read fails does the history get a note instead (Codex still reads the turns on
  its next turn). `agent.json` drops `terminal` only after the items are in, so a host that dies in between reads
  them again on its restart and adds only what is missing.
- `rollcall open` sends its own pid with `terminal`, kept on `agent.json` with its start time. A host that restarts
  while an agent is `terminal` checks that process (`proc.mjs sameProcess`, so a reused pid does not count): while it
  runs, the agent stays `terminal` and the host polls it (`ROLLCALL_HOST_TERMINAL_POLL_MS`, default a second), and
  its end closes the terminal as above. When it is already gone, the host reads the terminal back just after it
  starts listening (the agent shows `terminal` and holds words until then) and leaves it `parked`. `rollcall open`
  itself, when the CLI exits and its connection died with the old host, sends `terminal-done` to the host running
  now. Closing twice adds nothing: the second close finds no terminal open.
- A front end done with the terminal (cockpit's setting back to Chat, or its pane gone) sends `terminal-end`. The host
  sets `terminal.closing` on the agent (its state says so) and sends SIGTERM to the `rollcall open` pid on record.
  That command ends the CLI with SIGTERM once no turn runs, then closes as above, so held words go in after the
  terminal's turn and nothing is cut off. Mid-turn means the task's status log (written by the launch settings'
  hooks, which the terminal's CLI runs too) shows a turn that started after the terminal opened and has not ended; an
  open dialog counts as no turn, since nobody sees the terminal to answer it. A Claude supervisor writes no such log:
  its home's `turn` record says instead (`{ session, idle, at }`, which the owner's rollcall hooks write at each
  prompt and Stop, watch.mjs markTurn), counted for the agent's own session from the terminal's opening. A Codex
  thread is asked itself: `thread/read` on a short-lived app server, every 2 s while it waits, and a turn
  `inProgress` that started after the terminal opened is a turn (one the host's process left unfinished never
  counts). Claude Code 2.1.319 shuts down cleanly on that SIGTERM and exits 143; `rollcall open` reports 0 for an
  end it asked for. A terminal with no pid on record (a front end that sent `terminal` itself) is `refused`.
- Reading a Claude terminal back never doubles a turn the host ran: stream mode ended it under its `result` line's
  id, which the transcript lacks (it ends the turn with `stop_hook_summary` or `turn_duration` under its own uuid), so
  the end of a turn whose start the history holds is the history's own (history.mjs catchUp).
- **Trust.** Stream mode skips Claude Code's trust question, so a hosted agent's worktree may never have been
  trusted, and the real CLI asks there, where Enter means "No, exit". Before it answers `terminal` for a task, the
  host marks the task's worktree trusted the way Claude Code records the owner's yes
  (`projects[<folder>].hasTrustDialogAccepted` in `$CLAUDE_CONFIG_DIR/.claude.json`, `harness/claude.mjs
  trustWorktree`), only for folders rollcall made: a worktree under the repo's `.claude/worktrees/`, or the folder
  of tasks with no repo. It re-reads the config and renames a new copy over it, changing that one key. The old tmux
  worker started such a task in the terminal for the owner to answer; a folder the owner opened (a main checkout, a
  supervisor's home) still asks.

## The terminal Falcon (pending the owner's answer)

What `falcon` opens once supervisors run in the host is an open owner question (slice 4). Until it is settled, under
the gate `falcon` opens the escape hatch on the supervisor's session: a new supervisor writes its launch and runs
`rollcall open <home>` (the real CLI starts `/supervisor <home>`); an existing one opens on its session (refused while
it is in a terminal elsewhere). This is a placeholder, not the Falcon's new form. With the gate off, falcon is unchanged.

## The gate

`ROLLCALL_HOST=1` (in settings `env`) starts new task workers, Claude and Codex, in the host (`harness/codex.mjs
writeLaunch` takes `hosted`, so a hosted Codex launch is always the chat view). Off by default, so the
owner's live crew keeps running as it does until the later slices land. A session started in the host records
`hosted: true` on the task's session, so a resume goes back to the host whatever the setting says then. A supervisor
the host ran once stays there too (its `agent.json`).

## Tests

`test/host.test.mjs`, against `test/fixtures/fake-claude.mjs` and `fake-codex.mjs`, each test with its own store:
start, say, queued words while running, a prompt answered from two clients with the first winning, interrupt, park on
idle and wake on a message, history across a session change, backfill, a restart keeping requests and history, and
the push subscription's lines; for Codex, words with their ids and streamed text, the seam, the hooks, an approval
answered from two clients, a refused mode, and park then wake on the same thread. Every test stops the host it
started (SIGTERM in `t.after`, which parks its agents and ends their processes).

The slow full run (25 minutes) was not this branch: `queue.test.mjs` alone took 235 s here and 238 s on
origin/main on the same machine at the same time, and no `rollcall host` or fake app server is left after the suite.
