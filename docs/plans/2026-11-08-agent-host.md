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
   the seam that keeps the rest of rollcall working. Behind `ROLLCALL_HOST=1`.
2. Supervisors in the host, and the supervisor's tools (start, tell, wait, interrupt, read the chat) instead of typing
   into tmux.
3. The terminal escape hatch: "open in terminal" runs the real CLI on the agent's session; the host shows it busy until
   the terminal closes.
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
  restarted. Open requests stay open (see Requests). Nothing starts by itself.
- On SIGTERM it closes each agent's input (Claude Code finishes and exits, its transcript saved), parks them all, and
  exits. `host stop` does the same.

## Agents

An agent is one task's worker, named by its ref (`falcon:t3`). Its files live in the task's worker folder
(`store.workerDir(h, id)`), beside the launch files the harness adapter writes:

- `agent.json`: the host's record, swapped in whole on every change:
  `{ ref, home, task, harness, state, session, sessions, since, turnAt, parkedAt, model, mode, pid, host }`.
  `pid` is the child's, `host` the host's pid. Anything in rollcall may read it; only the host writes it.
- `history.jsonl`: the task's one history (below).
- `claude.json` (Claude) or `codex.json` (Codex): the compatibility record (see The seam).

### The runtimes

- **Claude** (`host/claude.mjs`): `claude -p --input-format stream-json --output-format stream-json
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
- **Codex** (`host/codex.mjs`): `codex app-server` on a unix socket, one thread per session (`thread/start`, or
  `thread/resume` on the recorded thread), items mapped with `codex/items.mjs` as the Codex worker's journal does.
  Item ids get the session's first 8 characters as a prefix (`3f2a9c1d:item-4`): Codex numbers live items per
  process, so two sessions would reuse them.

### State

One state per agent, owned by the host:

| `state` | Means | Send does (`send`) |
|---|---|---|
| `running` | a turn runs | `join`: the words go into the running turn |
| `idle` | the process is up, no turn | `start`: a turn starts |
| `parked` | no process; the session is saved | `wake`: resume the session, then deliver |
| `stopped` | stopped on purpose (`stop`, `task.stop`) | `wake` for the owner's words; rollcall's own deliveries are refused |

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
| `start` | `ref`, optional `prompt` (text), `resume` | `agent`; reads `claude-launch.json` / `codex-launch.json` |
| `say` | `ref`, `text`, optional `attachments` (paths), `from` (`owner`, `rollcall`), `uuid` | `how` (`sent`, `queued`, `resumed`), `uuid` |
| `interrupt` | `ref` | `interrupted` |
| `answer` | `request`, and by kind: `allow`, `why`, `always`, `mode`; `answers` | `answered`, `how` |
| `set` | `ref`, `model` and/or `mode` (`default`, `acceptEdits`, `plan`) | `set` |
| `park` | `ref` | `parked` |
| `stop` | `ref` | `stopped` |
| `history` | `ref`, optional `before`, `limit` | a page: `items`, `cursor`, `more`, `requests`, `agent` |
| `subscribe` | optional `refs` (all when absent) | `subscribed`; then events on the same connection |
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
  request as `prompt`. It stays while the agent is parked (a `say` wakes it) and goes when the agent stops.
- The control socket takes the stream worker's ops (`say`, `interrupt`, `answer`, `set`, `state`); `switch` is
  `refused` (no terminal view until the escape hatch).
- `supervisor.mjs workerState` reads `agent.json` for a session the host runs (`hosted: true` on the session):
  `alive` while `running` or `idle`, `parked`, `stopped`; busy and idle still come from the hooks' status log.
- `launch` asks the host to `start`; `stopWorker` asks it to `stop`; `park` asks it to `park` (the host also parks on
  its own timer, and `parkDue` leaves hosted agents to it).
- `api conversation <ref>` reads a hosted task's history (from the host when it runs, else from the file), and
  `--follow` subscribes, printing the same `page`, `item`, `text`, `prompt` lines as before.

## The gate

`ROLLCALL_HOST=1` (in settings `env`) starts new task workers, Claude and Codex, in the host. Off by default, so the
owner's live crew keeps running as it does until the later slices land. A session started in the host records
`hosted: true` on the task's session, so a resume goes back to the host whatever the setting says then. Supervisors
stay in tmux in this slice.

## Tests

`test/host.test.mjs`, against `test/fixtures/fake-claude.mjs` and `fake-codex.mjs`, each test with its own store:
start, say, queued words while running, a prompt answered from two clients with the first winning, interrupt, park on
idle and wake on a message, history across a session change, backfill, a restart keeping requests and history, and
the push subscription's lines.
