# rollcall's front-end interface

One versioned way in for every front end: the cockpit Mac and iOS apps (written in Swift, which run the `rollcall` CLI), scripts, and the terminal Falcon's own actions. It covers what a front end draws (a snapshot), its changes (a stream), every action the Falcon can take, and what a front end runs to show a session's real terminal. A front end shows each worker's real CLI in a terminal and draws its panels from this state; it never re-renders the chat.

The code: `src/api.mjs` (refs, the snapshot, attach), `src/api-stream.mjs` (the stream), `src/api-actions.mjs` (the actions), `src/api-reads.mjs` (the review and ship reads), `src/api-cli.mjs` (the `rollcall api` verbs), `src/answer.mjs` (answers from any surface), `src/away.mjs` (away mode and what it holds) and `src/clients.mjs` (open front ends and the notices log).

```
rollcall api version
rollcall api snapshot [--home <h>]
rollcall api stream [--home <h>] [--client <name>] [--notifies]
rollcall api do <action> [<json> | -]
rollcall api attach <home>[:<task>] [--client <name>] [--resume]
```

## Rules

- **No daemon.** rollcall runs no server. A stream is a process the front end starts and stops. A front end that needs a server (to reach a phone, say) runs its own on top of these commands.
- **JSON out.** Every verb prints JSON on stdout. `snapshot` prints one line; each stream line is one JSON object; `version`, `do` and `attach` print indented JSON.
- **One error shape.** A refusal prints `{ "ok": false, "error": { "code": "...", "message": "..." } }` and exits 1. A usage error (an unknown verb, a missing argument, a payload that is not JSON) exits 2 with the same shape.
- **Times** are Unix milliseconds. **Paths** are absolute.
- **The version.** `interface` is a whole number (now `1`), in `api version`, in the snapshot and as `v` on every stream line. A front end checks it at start and refuses a number it does not know.
- **What bumps it:** a field removed, renamed or given another type; an action removed or its meaning changed; an event's payload changed so an old reader misreads it.
- **What does not:** added fields, added actions, added event types and added error codes. A front end ignores keys and event types it does not know, and treats an error code it does not know as `failed`.
- **The hooks pay nothing.** No hook writes anything for the interface; the stream reads the files rollcall keeps anyway.

## Refs

- A supervisor is its name: `falcon`. Names start with a lowercase letter, then lowercase letters, digits and hyphens, 24 characters at most.
- A task is `<home>:<task>`, by id (`falcon:t3`) or by its character's name (`falcon:luke`; from t19 the names repeat with a number, `yoda-2`).
- The snapshot always gives the id form (`ref: "falcon:t3"`) and the name apart (`name: "luke"`).
- A task moved to another supervisor gets a new id there; the old ref stays as a `closed` task whose result names the new one (`task.move`).

## `rollcall api version`

```json
{ "ok": true, "interface": 1, "rollcall": "0.1.0", "verbs": ["version", "snapshot", "stream", "do", "attach"],
  "actions": { "task.start": "rollcall task new + start.mjs", "...": "..." },
  "coming": {} }
```

`actions` maps each action to the Falcon command it matches. `coming` lists actions the plans in flight add; asking for one now returns `not-available`.

## `rollcall api snapshot [--home <h>]`

Everything a front end draws, as one JSON document. `--home` keeps supervisors, tasks and decisions to one supervisor; sessions, queues, blockers and clients stay machine-wide. An unknown home gives empty lists, not an error. PR checks in a snapshot are what the last stream read (see the stream); a snapshot alone calls no network.

| Field | Type | Meaning |
|---|---|---|
| `interface` | number | The interface version |
| `rollcall` | string \| null | rollcall's package version |
| `at` | ms | When it was built |
| `tmux` | `{ socket, available }` | rollcall's tmux server (`tmux -L <socket>`) and whether tmux is installed |
| `supervisors` | array | One per supervisor home (below) |
| `tasks` | array | Every open task, and those finished in the last hour, of every home (below) |
| `sessions` | array | Live agent sessions in every repo rollcall knows, supervisors and workers among them |
| `queues` | array | Each repo's merge queue that holds anything |
| `blockers` | array | What stops work on this machine or account: `{ kind, since, ... }` per cause (`usage`, `billing`, `disk`, `power`, `memory`), with the cause's own fields (`until`, `gb`, `pct`...) |
| `blockerLines` | string[] | The same, one plain line each, as the owner reads them |
| `decisions` | array | What waits on the owner beyond any one task: `{ n, text, where, home, from, at }`, `from` a task ref or null |
| `usage` | object | The usage meter, as `rollcall usage --json` prints it: `{ claude: { fiveHour, weekly, at } \| null, codex: { primary, secondary, plan, at } \| null }`, each window `{ pct, resetsAt }` (ms). A plan with no fresh reading is null |
| `usageOffer` | object \| null | One plan near its limit while the other has room: `{ from, to, pct, resetsAt, window, room, tasks, text }`. `from` and `to` are harnesses (`claude`, `codex`); `pct`, `resetsAt` and `window` (`five-hour`, `weekly`...) are the full plan's fullest window; `room` is the other plan's percent; `tasks` are refs of the open tasks waiting on the full plan (held by its limit, not started, or parked or stopped while worked); `text` is the offer in one line. The same rule and numbers as the watcher's news. On the owner's yes, send `task.move` with `harness: to` for each task. Null when there is nothing to offer |
| `clients` | array | Front ends following rollcall now: `{ client, pid, notifies, at }` |
| `away` | object | Away mode, machine-wide (below): `{ on, since, by, last }` |
| `held` | array | Permission requests away mode held, machine-wide, oldest first: each one still held, and those answered in the last hour (below) |

### A supervisor

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Its name, `falcon` |
| `running` | bool | A live session holds the name |
| `session` | string \| null | That session's id |
| `mode` | string \| null | Its permission mode; its workers start in the same one |
| `parked` | bool | It was stopped while quiet; Enter in its tab, `falcon continue` or its tasks' news bring it back |
| `terminal` | `{ window, alive }` | Its window exists on rollcall's tmux server, and runs something other than a shell |
| `turn` | `{ idle, at }` \| null | Whether its turn has ended, for the session holding the name |
| `context` | number \| null | Its context use, percent |
| `replyTo` | string \| null | The task (a ref) the owner's plain lines go to after `@luke` alone |
| `feed` | array | The last 20 lines rollcall told the owner with no model turn: `{ at, task, text, report }`, `task` a ref or null, `report` a path or null |
| `reminders` | array | `rollcall remind` lines not yet due: `{ at, text }` |
| `openTasks` | number | Its open tasks |

### A task

| Field | Type | Meaning |
|---|---|---|
| `ref`, `id`, `home`, `name` | string | `falcon:t3`, `t3`, `falcon`, `luke` |
| `title` | string | Its title |
| `label` | string | What its tab and chip say: `luke · <title>` |
| `color` | string | Its color in the Falcon, `#rrggbb` |
| `kind` | string | `build` or `discuss` |
| `state` | string | `working`, `needs-you`, `pr-open`, `queued` (open), `landed`, `closed` (finished) |
| `stateAt` | ms \| null | When it took that state |
| `open` | bool | Its state is an open one |
| `status` | string | What its tab says: `needs you`, `PR open`, `parked`, `CI 12m (usual 8m)`, `landed · closes in 7m` |
| `needsOwner` | `{ kind, since }` \| null | What waits on the owner: `prompt` (a dialog open in its worker, or a launch stuck at a prompt), `needs-you` (a question), `stopped` (its worker is gone while the task is worked) |
| `harness` | string | The agent CLI its workers run on: `claude` or `codex` |
| `model`, `effort` | string \| null | What its workers run on, when the task sets it |
| `repo` | `{ key, name, main }` | The repo's key, name and main checkout path (`key: null` for a job on no repo) |
| `worktree`, `branch` | string | Where it works, on which branch |
| `base` | string \| null | What its branch started from |
| `after` | string[] | Task ids it waits on |
| `until` | string \| null | `landed`: it waits until those tasks land, not just open a PR |
| `hold`, `ship`, `browser` | bool | Held until the owner says; the owner already said to ship; its worker gets the browser servers |
| `words` | array | The owner's words, verbatim: `{ at, text, via, client, closed }`. `via`: `supervisor` (an `@` line, a pick, a relay), `worker` (typed in the worker's own window) or `app` (a front end, named by `client`). `closed`: the question they closed, or null |
| `notes` | array | The last 20 notes: `{ at, by, text }` |
| `notesCount` | number | All its notes |
| `question` | object \| null | The open question (below) |
| `answered` | object \| null | The last answer to a question: `{ at, by, qid, questions, answer }`. `by` is the front end's name, or `the terminal Falcon`; `qid` is null for an answer from the Falcon's picker |
| `report` | `{ at, by, text }` \| null | Its last report |
| `handoff` | `{ at, context }` \| null | Its last handoff to a fresh worker |
| `pr` | object \| null | Its PR (below) |
| `comments` | array | The owner's line comments on its diff, oldest first: `{ n, state, file, line, end, text, by, at, sentAt, reply, resolved }`. `state`: `pending` (not sent yet), `sent`, `answered` (the worker replied and left it open for the owner) or `resolved`. `file`, `line` and `end` are where it was written; `rollcall task comments <task> --json` says where each sits now. `reply` and `resolved` are `{ at, by, text }` (`resolved` also has `how`: `fixed` or `answered`) |
| `turns` | `{ count, last }` \| null | Its worktree's turn snapshots: how many, and the last turn's number; `turn.diff` takes any `n` from 0 to `last`. Null before the first. A stream sees a new turn at its next beat (`ROLLCALL_API_BEAT_MS`), since snapshots are written outside the files it watches |
| `tokens` | `{ context, size, total }` \| null | Its worker's context tokens now, the window's size, and on Codex the thread's total so far (each a number or null); null before its worker reported any |
| `stage` | `{ name, at }` \| null | The ship step running now |
| `wait` | object \| null | A wait it moved out of its worker (`task wait-for`): `{ on, check, why, every, at, label }`, `label` as its tab shows it |
| `worker` | object \| null | Its current worker (below); null before one starts, or once its session ended |
| `terminal` | `{ window, alive }` | Its tmux window exists, and runs something other than a shell |
| `files` | string | The folder of what its worker leaves for the owner (screenshots, a page) |
| `createdAt`, `updatedAt` | ms \| null | |

**The question.** `{ id, at, text, picker, questions }`. `id` is what `question.answer` names, so an answer meant for an older question never lands on a newer one. `text` is the question as one line. `picker` is true when the worker asked with options. `questions` lists them as the worker asked: `{ question, header, multiSelect, options: [{ label, description }] }`; a question without options is one entry with no options.

**The PR.** `{ url, number, queueLine, merged, state, checks, checkedAt }`. `queueLine` is the merge queue's line for it. `merged` is `{ key, at, pr, why }` once rollcall saw it land, else null. `state` (GitHub's `OPEN`, `MERGED`, `CLOSED`), `checks` and `checkedAt` are what a stream last read, null until one did. `checks` is `{ state, passed, pending, failed, merge }`: `state` is `passing`, `pending`, `failing` or `none`; `passed` and `pending` are check names; `failed` is `{ name, link }`; `merge` is GitHub's merge state (`CLEAN`, `BEHIND`, `DIRTY`...).

**The worker.**

| Field | Type | Meaning |
|---|---|---|
| `session` | string | Its Claude Code session id |
| `alive`, `busy` | bool | It runs; it is in a turn |
| `parked` | bool | Stopped while idle to free memory; its window shows a line where Enter resumes it |
| `stopped` | bool | Stopped on purpose (`task.stop`); nothing resumes it unasked |
| `legacy` | bool | A v2 background session outside tmux |
| `dialog` | `{ since, asks, text }` \| null | A dialog open in its window (a permission prompt, a tool's question): `asks` as rollcall read it, `text` as one line |
| `context` | `{ pct, tokens, size }` \| null | Its context use: percent, tokens used, the window's size |
| `since` | ms | When its last turn began or ended |
| `upAt` | ms \| null | When its Claude Code last started |
| `started` | bool \| null | Its session has started (false while it waits at the trust prompt) |
| `lastWords`, `background` | \| null | Once idle: its last words, and the background work it left running |
| `mode`, `model`, `effort` | string \| null | What it was launched with |

**A session.** `{ id, repo: { key, name }, branch, checkout, mainCheckout, harness, state, since, intent, claim }`. `state` is `working`, `idle` or `stale`. `intent` is its claim or first prompt.

**A queue.** `{ repo: { key, name }, entries, train, lander, outcomes }`. Each entry is `{ pr, branch, task, session, state, why, readyAt, files, stuck }`, oldest first. `train` is `{ n, prs, stage, pr, suite, startedAt }` or null. `lander` is `{ pid, since }` or null. `outcomes` holds the last 10 results as the lander wrote them.

### Away mode

The owner turns it on when they step away (`away.set`, `rollcall away on`). While it is on, nothing a task worker does waits on them: a permission prompt is held instead of shown, and a question waits on its task. Only task workers are held; the owner's own sessions and supervisors never are. `away` and `held` are machine-wide: `--home` does not filter them.

**`away`.** `{ on, since, by, last }`. `on`: away mode is on now. `since`: when it was turned on (null while off). `by`: the client that turned it on (`cockpit`, `cockpit-phone`, `the terminal`), null while off. `last`: the most recent finished spell, kept until the next one starts, else null: `{ since, until, done }`, where `done` lists the tasks that reached `landed` or `closed` between `since` and `until`, oldest first: `{ ref, title, state, at, pr }` (`pr` the PR's URL or null). A front end shows what got done from it even after those tasks left the snapshot's one-hour window.

**A held item.** `{ id, ref, home, at, harness, tool, input, summary, reason, state, answer }`.
- `id`: stable (`h-<ms>-<hex>`), what `held.answer` names. `ref`: the task; `home`: its supervisor. `at`: when it was held.
- `harness`: `claude` or `codex`. `tool`: the tool as the harness named it (`Bash`, `Edit`, `WebFetch`, `mcp__x__y`; Codex's command and file approvals read as `Bash` and `Edit`, its permission requests as `permissions`).
- `input`: the tool's input as the agent sent it, long strings cut at 2,000 characters; one still over 8 KB keeps `{ gist, description, trimmed: true }`.
- `summary`: one plain line a person reads: the command, `Edit src/a.ts` (relative to the task's worktree), or the tool and what it names. `reason`: the agent's stated reason (Bash's `description`, Codex's reason), else null.
- `state`: `held` (waiting on the owner), `approved` or `denied`. `answer`: null while held, else `{ at, by, allow, why, all }`; `all` is true when `held.allowAll` approved it.

The same request asked again while it is still held is the same item. Questions are not copied here: a question asked while away lives on its task (`question`, `needsOwner.kind: "needs-you"`) as any question does. A front end builds "While you were away" from `held` items still `held`, plus open tasks whose `needsOwner` is set, grouped by task, oldest first, and `away.last.done` for what got done.

**What the worker hears.** A held permission prompt is refused with a note: held for the owner, do not try another way round it, carry on with the work that does not need it, and mention it in the final report. A question while away goes to the task even when a terminal shows the worker, and the worker hears to carry on with what does not depend on the answer, then end its turn. An answer reaches the worker as its next prompt, through the queue `task.tell` uses, which wakes an idle worker and resumes a stopped one: "The owner approved your held request: `<summary>`. Run it now." or "The owner denied your held request: `<summary>`. Their words: `<why>`". An approval also leaves a one-time grant for that task, tool and input (the input without the agent's `description`; for a command, the command alone): the worker's next matching request goes through without a prompt, whether away mode is still on or not. A grant is used once and lasts a day. A held item whose task finished is answered on the record only.

**Notices while away.** Each held prompt and each question raises one `notice` (see the stream) and no reminders: the 10-minute reminders stop while away. Turning away mode off writes `last` and stops holding; items already held stay held until answered.

### The worktree runtime (plan A)

Each task view also has:

- `from`: where the task came from, or null: `{ kind: "issue", number, url }`, `{ kind: "pr", number, url }` or `{ kind: "branch", name }`.
- `runtime`: null for a task with no worktree of its own, else `{ ports, setup, actions, previews, spotlit, archived }`. `ports` is `{ base, last }` or null. `setup` is the worktree's last setup, `{ state: "running" | "done" | "failed", cmd, copied, exit, at, endedAt, log, last }`, or null when none ran. `actions` lists its run actions, `{ name, url, port, running, log, since }`. `previews` holds the URLs of those running. `spotlit` is `{ since, mirroredAt }` while the main checkout runs this task's files, else null. `archived` is `{ at, ref, head, branch, files, kb }` while the task is archived (its worktree gone), else null.

Reading these takes no lock and starts no process, so a front end can poll them.

### Coming

No plan in flight adds state now. A later one adds its fields here, as added fields (no version bump). The review and ship reads (cockpit's plan 2) added `tokens` to a task and `usageOffer` to the snapshot; away mode added `away` and `held`, their stream events, three actions, `delivered` and `how` on `decision.answer`, and the notices' `kind`, `ref` and `held`, all within interface 1.

## `rollcall api stream [--home <h>] [--client <name>] [--notifies]`

The snapshot, then one JSON line per change, until the front end stops it. Every line has the same envelope:

```json
{ "v": 1, "seq": 7, "at": 1762425600000, "type": "task.state", "ref": "falcon:t3", "from": "working", "to": "needs-you" }
```

`v` is the interface version. `seq` counts lines from 1 in this stream. `at` is when the line was written, except on `news` and `notice`, where it is when that happened. The first line is always `{ "type": "snapshot", "snapshot": { ... } }`.

How it works: it wakes on a file change in the supervisors' homes, the machine's records or a merge queue (`fs.watch`), at most once a second, and on a beat every 5 s (`ROLLCALL_API_BEAT_MS`) for what no file announces (a worker's process ending, a tmux window), builds the snapshot again and prints what differs. One task change comes as `task.changed` with the whole task, followed by the events a front end acts on.

| Type | Payload | When |
|---|---|---|
| `snapshot` | `snapshot` | First line |
| `task.added` | `task` | A task appeared (followed by `question.asked` if it has one open) |
| `task.changed` | `ref`, `fields` (names), `task` | Any field of a task changed; `task` is the whole new view |
| `task.state` | `ref`, `from`, `to` | Its state changed |
| `question.asked` | `ref`, `question` | A question opened (the snapshot's question object) |
| `question.closed` | `ref`, `question` (its id), `answered` | A question closed; `answered` is the task's answer record when an answer closed it, else null |
| `worker.turn-ended` | `ref`, `lastWords`, `background` | A live worker went from busy to idle |
| `worker.dialog` | `ref`, `dialog` | A dialog opened in a worker's window |
| `pr.changed` | `ref`, `pr` | Its PR, its state or its checks changed |
| `words` | `ref`, `words` | The owner's new words on a task, from any surface |
| `report` | `ref`, `report` | A new report |
| `task.removed` | `ref` | It left the snapshot (finished over an hour ago, or its record went) |
| `supervisor.changed` | `supervisor` | Any field of a supervisor changed, or it appeared |
| `supervisor.removed` | `name` | Its home went |
| `news` | `home`, `task`, `text`, `report` | A new line in a supervisor's feed |
| `sessions.changed` | `sessions` | The whole new list |
| `queues.changed` | `queues` | The whole new list |
| `blockers.changed` | `blockers` | The whole new list |
| `blockerLines.changed` | `blockerLines` | The same, as plain lines |
| `tmux.changed` | `tmux` | tmux came or went |
| `decisions.changed` | `decisions` | The whole new list |
| `usageOffer.changed` | `usageOffer` | The whole new value (null once there is nothing to offer) |
| `usage.changed` | `usage` | A plan's reading moved (the stream reads it on its beat) |
| `clients.changed` | `clients` | A front end opened or closed a stream |
| `away.changed` | `away` | Away mode's whole new value |
| `held.changed` | `held` | The whole new held list |
| `notice` | `title`, `text`, `sound`, and for one item `kind`, `ref`, `held` | A notification for the owner |
| `heartbeat` | | Nothing else was written for 15 s (`ROLLCALL_API_HEARTBEAT_MS`) |
| `error` | `message` | Building a snapshot failed; the stream goes on |

**`news` and `notice`.** `news` is a line under the Falcon's prompt (the supervisor's `feed`): show it in a feed. `notice` is a notification for the owner (what rollcall shows with macOS's `osascript` otherwise): a front end that alerts the owner alerts on `notice` only. Every `news` line also comes as a `notice`; some notices (a blocker) have no `news` line. A stream sends only notices from after it started.

**Notices about one item.** While away, each held permission prompt and each question raises exactly one notice, with `kind` (`held` or `question`), `ref` (the task) and, for a held prompt, `held` (its id), so a front end that pushes to a phone can offer Approve and Deny on it. Other notices carry none of the three.

**PR checks.** While a stream runs, it reads each `pr-open` or `queued` task's PR with `gh` about every 60 s (`ROLLCALL_API_PR_MS`) and keeps the result beside the task (`api-pr-<id>.json`), which the next snapshot shows as `pr.state` and `pr.checks`. Nothing else reads checks for the interface.

**Flags.** `--client <name>` registers the front end (`_machine/clients/<pid>.json`, up to 40 characters) for as long as the stream runs, so the snapshot's `clients` and other front ends see it. `--notifies` (alone it registers as `frontend`) says this front end shows the owner's notifications: while it runs, rollcall shows none itself, and the notice reaches the owner through this stream.

**Ending.** The stream ends on SIGTERM, SIGINT or SIGHUP, or once its stdout is closed (at the next line or heartbeat, within 15 s). It does not read stdin.

**Resuming.** There is no cursor. A front end that slept, lost its stream or saw an `error` starts a new stream and takes its first snapshot as the whole truth. Lines carry the whole new value for every list and task, so a missed line costs nothing once the next snapshot lands.

## `rollcall api do <action> [<json> | -]`

Runs one action as the owner. The payload is a JSON object, as an argument or on stdin (`-`, or no argument at all: then stdin is read, so a front end always passes one of the two).

```json
{ "ok": true, "result": { ... } }
{ "ok": false, "error": { "code": "stale-question", "message": "...", "current": "falcon:t3:1762425600000" } }
```

Exit 0 on `ok: true`, 1 on a refusal, 2 when the payload is not JSON or the action is missing.

**Fields every payload may carry.**
- `requestId` (string, up to 100 characters): a repeat of a request id seen in the last day returns the first response again, with `repeated: true`, and runs nothing. A front end that is not sure a call ran (a timeout, a crash) sends it again with the same id. Only a success is kept: a retry after an error (a `busy`) runs again. A repeat must name the same action.
- `client` (string, up to 40 characters): the front end's name. It goes on the record (the owner's words, an answer) and in what the supervisor hears. Default `frontend`.

**Error codes.**

| Code | Means |
|---|---|
| `bad-payload` | A field is missing, of the wrong type or over its limit; the message names it |
| `not-found` | No such supervisor or task (or, for `turn.diff`, no such turn; for `held.answer`, no such held item) |
| `refused` | The command it runs refused, with that command's words (a `task.tell` to a finished task that never had a worker, say), or an agent session called `do` |
| `unavailable` | Something it needs is not installed: tmux, or kesselrunner's launcher (`ROLLCALL_START_FILE`) |
| `failed` | The launcher failed starting, stopping or resuming a worker, or something went wrong inside rollcall; the message says what |
| `not-available` | An action from `coming`: it lands with its plan |
| `unknown-action` | No such action; the message lists them |
| `already-answered` | The question this answer names was answered first elsewhere; `answered` has that answer. For `held.answer`: the item was given the other answer first; `answer` has it |
| `stale-question` | The task asks something newer now; `current` is its question id |
| `no-question` | The task has no open question |
| `busy` | The task store (or the away, held or decisions record) stayed locked; try again |

Most results carry `view`: the task's view after the action, as in the snapshot.

| Action | Payload | Result | The Falcon's way |
|---|---|---|---|
| `task.start` | `home`, `title` (up to 200), `words`, `repo` (a path) or `noRepo: true`; optional `type`, `kind`, `model`, `effort`, `base`, `slug`, `after` (ids), `notes` (strings), `until`, `ship`, `browser`, `hold`, `harness` (`claude` or `codex`), and one of `issue`, `pr` (a number or URL: then `title` and `words` are optional) or `branch` (then `words` is optional) | `task` (its ref), `started`, `trustPrompt`, `message`, `view` | `rollcall task new` + `start.mjs` |
| `task.tell` | `task`, `text` | `delivered`, `how` (`typed`, `held`, `resumed`), `why`, `view` | `@luke <text>` |
| `question.answer` | `task`, `question` (its id), `answers` (question text to answer) or `answer` (a single question) | `delivered`, `how`, `why`, `pickerClosed`, `view` | a pick in the Falcon's picker |
| `task.interrupt` | `task` | `interrupted`, `why` | `start.mjs <task> --interrupt` (Esc in its window) |
| `task.stop` | `task` | `stopped`, `why`, `view` | `start.mjs <task> --stop` |
| `task.resume` | `task`, optional `why` (up to 300) | `resumed`, `trustPrompt`, `message`, `view` | `start.mjs <task> --resume "<why>"` |
| `task.close` | `task`, optional `why` (up to 300) | `closed`, `already`, `view` | `rollcall task close <task> "<why>"` |
| `task.move` | `task`, and `to` (a supervisor) or `harness` (`claude` or `codex`) | `moved`, `already`, `task` (the new ref, for `to`), `harness` and `view` (for `harness`) | `rollcall task move <task> --to <supervisor>` or `--harness <h>` |
| `decision.answer` | `n` (a number, or `d3`), optional `answer` (up to 2,000) | `answered`, `already`, `delivered`, `how` | `rollcall task decisions done <n> "<answer>"` |
| `away.set` | `on` (bool) | `away` (the new value), `already` | `rollcall away on\|off` |
| `held.answer` | `id`, `allow` (bool), optional `why` (up to 2,000) | `answered`, `already`, `delivered`, `how`, `view` (the task's view, or null) | `rollcall away allow\|deny <id> ["<why>"]` |
| `held.allowAll` | optional `home` (only that supervisor's) | `approved` (ids), `count` | `rollcall away allow-all` |
| `blocker.clear` | `kind` (`usage`, `billing`, `disk`, `power`, `memory`) | `cleared` | `rollcall blockers clear <kind>` |
| `review.comments` | `task` | `comments` (below) | `rollcall task comments <task> --json` |
| `review.comment` | `task`, `file` (relative to its worktree, or absolute inside it), `line`, optional `end`, `text`, optional `send` (bool) | `comment` (its number), `sent`, `message`, `view` | `rollcall task comment <task> <file>:<line>[-<end>] "<text>"` |
| `review.send` | `task` | `message`, `view` | `rollcall task comments <task> send` |
| `turn.diff` | `task`, `n` | `from`, `to`, `files` (below), `patch`, `truncated` | `rollcall turns diff <n> <task> --json` |
| `turns.list` | `task` | `turns`: `{ n, at, session, kind, files, restored }`, oldest first | `rollcall turns <task> --json` |
| `turn.restore` | `task`, `n` | `restored`, `undo`, `files`, `message`, `view` | `rollcall turns restore <n> <task>` |
| `task.diff` | `task`, optional `against` (`base`, `committed`, `uncommitted`) | `against`, `from`, `to`, `base`, `files`, `patch`, `truncated` | `git diff` in its worktree |
| `pr.timeline` | `task` | `pr`, `checks`, `deployments`, `threads`, `events`, `queue`, `main`, `at` (below) | `gh` |
| `check.log` | `task`, and `id` or `name` | `name`, `id`, `url`, `log`, `truncated` | `gh run view --job <id> --log-failed` |
| `repo.items` | `repo` (a path in a repo) | `repo`, `issues`, `prs`, `branches` | `gh issue list`, `gh pr list` |
| `task.archive` | `task`, optional `confirm: true` | without `confirm`: `archived: false`, `plan` (what goes: `worktree`, `kb`, `uncommitted`, `unpushed`, `actions`, `ports`, `spotlit`, `teardown`, and `lines` to show the owner), `confirmWith`; with it: `archived`, `already`, `message`, `view` | `rollcall task archive <task>`, then `--yes` |
| `task.restore` | `task` | `restored`, `already`, `message` (says when its branch moved on origin), `view` | `rollcall task restore <task>` |
| `task.spotlight` | `task`, `on` (true or false), optional `force: true` with `on: false` | `spotlit`, `message`, `view` | `rollcall task spotlight <task> [--off [--force]]` |
| `task.run` | `task`, `verb` (`list`, `start`, `stop`, `restart`, `log`), `name` (a run action, or `all`) for all but `list`; for `log`, optional `offset` | `view` (its `runtime.actions` and `previews`); for `log`: `name`, `log`, `offset`, `size`, `truncated`, `more` | `rollcall task run <task> <verb> <name>` |

Notes on each:

- `task.start` makes the task and its worktree, then starts its worker in the supervisor's permission mode; the call can take a minute or two. A task with `after` or `hold` is made but not started (`started: false`): rollcall starts it when it is free. `trustPrompt: true`: the worker waits on Claude Code's trust prompt for its repo, which the owner answers in its terminal (`attach`).
- `task.tell` goes as the owner's own words, typed into the worker as its next prompt, the way an `@luke` line does. `held`: they wait on the worker's queue (a dialog is open, it is still starting, someone types in its window) and go in on their own; `why` says which. A task with no worker yet gets one, with the words in its brief (`delivered: false`, `why` says so). The supervisor hears of the words at its next turn.
- `question.answer`: `answers` maps each open question's `question` text to its answer: an option's label, several labels joined with `", "` for a multi-select, or the owner's own words. The answer reaches the worker exactly as a pick in the Falcon's picker does; the worker cannot tell which surface answered. `pickerClosed`: the Falcon had a picker open on this question, and rollcall closed it.
- `task.interrupt` stops the worker's turn; it keeps running. `interrupted: false` with a `why` when no worker runs.
- `task.stop` ends the worker; the task stays open and nothing resumes it unasked.
- `task.close`, `task.move` and `decision.answer` answer `already: true` when it was done before, so a repeat from a second front end is harmless.
- `decision.answer`, like `rollcall task decisions done`, puts the answer on the deciding task's record and, when that task is open and has had a worker, delivers it to the worker as its next prompt, which wakes it: `delivered` and `how` as for `task.tell` (`typed`, `held`, `resumed`). A decision from no task, from a finished task, or from one whose worker never started gets `delivered: false, how: null`.
- `away.set` with the value it has already answers `already: true` and changes nothing. Turning it off writes `away.last`.
- `held.answer`: the first answer wins. The same answer again answers `already: true` and delivers nothing; the other answer, after one was given, is refused `already-answered` with the existing `answer`. An approval leaves a grant for the worker's next matching request (see Away mode). `delivered` and `how` are as for `task.tell`; a held item whose task finished is answered on the record only (`delivered: false`). It works whether away mode is on or off.
- `held.allowAll` approves every item still `held` (of one supervisor, with `home`): a grant each, and one message per task listing what was approved. It never answers a question.
- `review.comment` leaves a comment pending, as the owner's; `review.send` (or `send: true`) sends every pending one to the worker as one message, which it answers or resolves one by one (`comments` in the view shows how far). `review.send` with nothing pending refuses. With `send: true` the comment is saved even when the send fails: the result is then `sent: false` with the reason in `message`, so a retry does not add it twice.
- `turn.diff`: what turn `n` changed against the turn before it; turn 0 is the baseline and changed nothing. `files` is always whole; `patch` stops at 1 MB (`truncated: true`), and `rollcall turns diff` prints all of it.
- **A diff's files** (`turn.diff`, `task.diff`): `{ status, path, oldPath, added, removed }`. `status` is git's letter (`A`, `M`, `D`, `R`, `C`, `T`); renames are found (`git diff -M`), and `oldPath` is there for a rename or copy only. `added` and `removed` count lines, null for a binary file. The `patch` finds renames too.
- `task.diff`: `base` (the default) runs from where its branch left the default branch (the merge base with `origin/<default>`, else the local default branch, else the task's `base`) to its worktree's files now: committed, uncommitted and untracked, ignored files left out. `committed` runs from there to HEAD; `uncommitted` from HEAD to its files now. `from` and `to` are SHAs, or `"worktree"`; `base` names the default branch. Reading the files now writes nothing the worker sees (the snapshot repo's own index, as a turn does). A task with no worktree (archived, no repo) is `refused`.
- `turns.list`: `kind` is `baseline` (turn 0), `turn`, `before-restore` (the state a restore replaced) or `restored`; for those two, `restored` is the turn restored to, else null. `files` is `{ status, path }`.
- `turn.restore` puts the worktree's files back to turn `n` (HEAD, branch and index stay). It is `refused` while the task's worker is mid-turn, and `not-found` for no such turn. `undo` is the turn that holds the state it replaced: `turn.restore` with `n: undo` puts it back. When nothing changed since the last turn, `undo` is that turn.
- `review.comments`: the task's comments as in the snapshot, each with `now: { file, line, end, moved }` (where its lines sit now; `moved` when they moved) or `now: null` once they are gone, with `stale` saying why (else null), `delivered` (a sent comment reached its worker), `hunk` and `sentAt`.
- `pr.timeline` reads GitHub now (one GraphQL call, and one for the threads). A task with no PR is `not-found` ("no PR"); no `gh`, or `gh` logged out, is `unavailable`.
  - `pr`: `{ url, number, title, state, draft, mergeState, headSha, baseBranch, createdAt, mergedAt }`.
  - `checks`: every check run and commit status on the head commit: `{ name, workflow, state, conclusion, startedAt, completedAt, link, id }`. `state` is `queued`, `in_progress` or `completed`; `conclusion` is GitHub's in lowercase (`success`, `failure`, `cancelled`, `skipped`, `neutral`, `timed_out`, `action_required`) or null. `id` is the GitHub Actions job id (its check run id), null for a commit status or a check from another app.
  - `deployments`: the head commit's, newest status each: `{ environment, state, url, logUrl, at }`.
  - `threads`: every review thread, resolved ones included: `{ id, file, line, author, bot, body, resolved, outdated, url, at, replies, comments }`; `comments` is the whole thread, `{ author, bot, body, url, at }`.
  - `events`: one time-sorted list for a timeline, `{ at, kind, text, url }`, `kind` one of `opened`, `check` (a check finished), `deploy`, `review`, `thread`, `queue` (the lander's news for this PR), `merged`, `closed`.
  - `queue`: `{ position, length, state, line }` while it is in its repo's merge queue (`position` from 1), else null.
  - `main`: the default branch's head on GitHub, `{ branch, sha, state, failed }`, `state` `passing`, `pending`, `failing` or `none`; `failed` is `{ name, link }`. Main is red when `state` is `failing`.
- `check.log`: the log of one check on the PR's head, by `id` from `pr.timeline` or by `name` (the latest of that name): its failed steps, else the whole job's log, the last 512 KB (`truncated: true` when cut). A check that is not an Actions job is `refused`, with its link in the message.
- `repo.items`: open issues and PRs, up to 100 each, newest updated first (`issues`: `{ number, title, url, author, labels, updatedAt }`; `prs`: `{ number, title, url, branch, author, draft, updatedAt }`), and origin's branches, up to 100, newest commit first, the default branch left out (`{ name, at }`; it fetches origin first, and a failed fetch keeps what this machine had). For the new-task picker: `task.start` takes `issue`, `pr` or `branch`.
- `task.run` with `verb: "log"`: a run action's log from `offset` (default: its last 64 KB) to its end, at most 256 KB a call; `offset` in the result is where the next call starts for only what is new, and `more` says over 256 KB were left. `truncated`: it started past what was asked (the default tail, or an `offset` past the end of a log that started again, which reads from its start).
- The reads (`task.diff`, `turns.list`, `review.comments`, `pr.timeline`, `check.log`, `repo.items`, `turn.diff`) change nothing, so a `requestId` keeps no copy of them.

- `task.archive` removes nothing until the owner has seen the plan: the first call returns it, and the front end shows `plan.lines` and sends `confirmWith` on the owner's yes. Archive, restore and spotlight are refused from an agent session, as `api do` is. So are `away.set`, `held.answer` and `held.allowAll`.

## `rollcall api attach <home>[:<task>] [--client <name>] [--resume]`

What a front end runs to show a session's real terminal: a tmux client on rollcall's tmux server.

```json
{ "ok": true, "ref": "falcon:t3", "harness": "claude", "socket": "rollcall", "session": "sv-falcon", "window": "t3",
  "pane": "%12", "alive": true, "parked": false, "resumed": false, "view": "sv-falcon-t3-view-cockpit",
  "argv": ["tmux", "-L", "rollcall", "new-session", "-A", "-t", "=sv-falcon", "-s", "sv-falcon-t3-view-cockpit",
           ";", "set-option", "destroy-unattached", "on", ";", "select-window", "-t", "=sv-falcon-t3-view-cockpit:=t3"] }
```

- **Run `argv` as it is**, in the front end's terminal (a pty), with no shell: the `";"` items separate tmux commands.
- **A view session per client.** The terminal joins a grouped session of its own (`view`, named for the window and the `--client` name), so it can show another window than the Falcon's terminal does. `destroy-unattached` is set on that view session alone: it goes when the terminal detaches or closes. No setting of the Falcon's own session changes.
- **A parked worker** still has its window: it shows the parked line, where Enter resumes the same conversation. `parked: true` says so.
- **`--resume`** brings back a worker whose window is gone first (as `task.resume` does, noting the front end), then answers as above with `resumed: true`. Without it, a task with no window gets `no-window`.
- **The supervisor**: a bare `<home>` attaches to the supervisor's own window, when it runs under `falcon`. One started in a plain terminal tab has no window there (`no-window`).
- `alive`: the window runs something other than a shell. `harness` says what runs there (`claude` or `codex`).
- Errors: `bad-payload` (a malformed ref; exit 2 when the ref is missing), `not-found`, `unavailable` (no tmux), `failed` (the resume failed), `no-window`.

## Several front ends at once

- **The first answer wins.** `question.answer` settles under the task's lock. Of two surfaces answering at once, one wins; the other hears `already-answered`. An app answering after a pick in the Falcon's picker hears `already-answered` too; a front end that holds an id from an older question may hear `no-question`, and reads `answered` from the next snapshot. A pick in the Falcon's picker for a question a front end answered first goes nowhere, and the supervisor hears that it was answered already and from where.
- **The Falcon's picker closes.** When a front end answers every question an open picker in the Falcon holds, rollcall closes it (Esc in the supervisor's window) and tells the supervisor, so it does not ask again. A picker that still holds an unanswered question stays.
- **The owner's words from a front end** go on the task's record with `via: "app"` and the client's name, and the supervisor hears of them at its next turn, as it does for words typed in a worker's window.
- **Notifications once.** At most one front end per machine should pass `--notifies`. While one does, rollcall shows no macOS notification of its own, and that front end alerts on `notice` lines. Every other stream still gets the `notice` lines; those front ends show them without alerting.
- **Actions are safe to repeat.** Use `requestId` for retries; `already: true` covers the same action from two front ends.

## Who may call `do`

`do` acts as the owner: its words reach a worker as the owner's own, which auto mode trusts. Only the owner's apps and scripts call it, never an agent session. `api-cli.mjs` refuses it (`refused`) inside a worker (its `ROLLCALL_TASK` environment) or any agent session rollcall knows, and rollcall's Bash hook denies an agent's command that names `rollcall` and `api do`. An agent uses the `rollcall task` commands, which run the same code under its own name. `snapshot`, `stream` and `attach` carry no such check.

## Contract tests

- `test/api.test.mjs` (this package): the contract a front end relies on: the version, the snapshot, the stream and its notices, the actions and their refusals, repeats, the first answer winning, who may call `do`, and attach. It runs with `npm test` here.
- `test/away.test.mjs` (this package): away mode: a held permission request and its note, one notice per held item and question, no reminders, the switch and `last`, `held.answer` and its grant, `held.allowAll`, a decision's answer reaching its worker, and the stream's `away.changed` and `held.changed`. `test/harness.test.mjs` holds a Codex approval while away.
- `test/supervisor.test.mjs` (kesselrunner's root): a scripted front-end client beside the terminal Falcon on a real tmux server, end to end: it starts a task, sees its question, answers it, tells the worker, attaches to its terminal and watches its PR land, while the Falcon shows the same task, answer and news.

Both run in CI on every PR that touches rollcall (`.github/workflows/check.yml`: the `rollcall` and `Supervisor` jobs).
