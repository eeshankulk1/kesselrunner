# rollcall's front-end interface

One versioned way in for every front end: the cockpit Mac and iOS apps (written in Swift, which run the `rollcall` CLI), scripts, and the terminal Falcon's own actions. It covers what a front end draws (a snapshot), its changes (a stream), every action the Falcon can take, a worker's conversation as plain items (for a native chat), and what a front end runs to show a session's real terminal.

The code: `src/api.mjs` (refs, the snapshot, attach), `src/api-stream.mjs` (the stream), `src/api-actions.mjs` (the actions), `src/api-reads.mjs` (the review and ship reads), `src/conversation.mjs` (transcripts folded into items), `src/api-cli.mjs` (the `rollcall api` verbs), `src/answer.mjs` (answers from any surface), `src/away.mjs` (away mode and what it holds), `src/clients.mjs` (open front ends and the notices log) `src/host/` (the agent host, cockpit's crews' runtime) and `src/claude/` (Claude Code's stream mode, as the host runs it).

```
rollcall api version
rollcall api snapshot [--home <h>]
rollcall api stream [--home <h>] [--client <name>] [--notifies]
rollcall api do <action> [<json> | -]
rollcall api attach <home>[:<task>] [--client <name>] [--resume]
rollcall api conversation <ref> [--before <cursor>] [--limit <n>] [--follow]
```

## Rules

- **No daemon in the terminal flow; cockpit's crews run in the host.** A crew started in the terminal (`falcon`, `/supervisor`) runs no daemon: its agents are tmux windows, and everything here is a command (a stream is a process the front end starts and stops). A crew cockpit starts (`supervisor.new`) runs in the agent host, the one long-lived process rollcall runs (see The agent host), which owns those agents and serves their state and chats over a socket. The two are kept apart: a front end shows a hosted crew as chats and a terminal crew as terminals (`attach`); `supervisor.runtime` says which.
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
{ "ok": true, "interface": 1, "rollcall": "0.1.0", "verbs": ["version", "snapshot", "stream", "do", "attach", "conversation"],
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
| `supervisors` | array | One per supervisor home (below), chats included |
| `chatOptions` | object | What a new chat offers (below, A chat) |
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
| `runtime` | `"host"` \| `"terminal"` | Where the crew runs: `host` (made by a front end with `chat.new` or `supervisor.new`: it and its tasks are agents in the agent host, each with a chat) or `terminal` (falcon or `/supervisor`: tmux windows and the real CLIs; show them as terminals) |
| `chat` | object \| null | Set for every hosted home, null for a terminal crew: the chat as the sidebar draws it (below) |

### A chat

A chat (`chat.new`) is a hosted home of kind `chat` (`runtime.json` `{ runtime: "host", kind: "chat" }`): an ordinary Claude Code session in the agent host that does the work itself, in a worktree and branch of its own, and starts tasks (each with its own worker and worktree, as a hosted crew's) when work splits into parts that can run side by side. Its home name (`chat-` and 6 lowercase base36) is an internal id, never shown. Its session runs with `src/host/chat-contract.md` appended to Claude Code's system prompt, and holds its home as a supervisor does (task news reaches it; its edits are not denied). Its task news is worded for the owner, who sees it in the chat as a `from: "rollcall"` user item: `[rollcall] News from your tasks:`, then one plain line per task, by title and name (`"Fix the login page" (luke) asks: Ship it now? (Yes / No)`), with no JSON and no orders for a supervisor (`watch.mjs` `chatNewsLine`). A hosted crew made before chats shows here too, titled by its name, and takes `chat.rename`, `chat.archive` and `chat.unarchive` as a chat does: the first rename or archive writes it a `chat.json` from what the snapshot showed, and from then on the owner's words to it unarchive it and mark it used.

`chat`: `{ title, titleBy, folder, folderName, repo, worktree, branch, harness, model, mode, createdAt, lastUsedAt, archivedAt, archivedBy, note, busy }`

| Field | Type | Meaning |
|---|---|---|
| `title` | string | Its title |
| `titleBy` | string | `draft` (the first line of the owner's first words, up to about 60 characters cut at a word), `auto` (the title model's), `owner` (renamed, or named in `chat.new`; always wins), `name` (a hosted crew from before chats: its home name, until renamed) |
| `folder`, `folderName` | string | The absolute folder the owner picked (an old crew: where it was started), and its last part. Group the sidebar by `folder` |
| `repo` | `{ key, name, main }` \| null | Its repo; null when the folder is not a git repo |
| `worktree`, `branch` | string \| null | Its own worktree (`<repo>/.claude/worktrees/<home>`) and branch; null when it runs in the folder itself, or for an old crew |
| `harness`, `model`, `mode` | string | What it runs with now (`claude` or `codex`; a mode as `worker.set` takes, from that harness's `chatOptions.modes`) |
| `createdAt`, `lastUsedAt` | ms | Made; last used (the owner's last words, or the last turn's end) |
| `archivedAt`, `archivedBy` | ms \| null, `auto` \| `owner` \| null | Archived, and by whom |
| `note` | string \| null | A plain line when something fell back: "Working in the folder itself: <git's reason>", or a worktree remade on unarchive |
| `busy` | `working` \| `waiting` \| null | What its own session is doing that archiving would cut short: `waiting` (a question or permission prompt is open), `working` (a turn runs, or the chat is open in a terminal), from its `agent.json`. `chat.archive` refuses either |

Its branch starts as `chat/<home>`; when a title lands (the model's or the owner's) it is renamed `chat/<title slug>` (`-2`, `-3`... when taken) while it has no upstream and origin has no branch of that name. The worktree folder keeps its first name. A long chat relies on its harness's own auto-compact; its history stays one list across sessions.

A Codex chat runs Codex's app server as a task's hosted Codex worker does, with the chat contract as Codex's developer instructions and `ROLLCALL_SESSION` set to its session in its shell, so its own `rollcall task` commands find its home. Codex runs no rollcall hooks, so the host does their part: a turn's start carries the task news the watcher holds, its end marks the news handled. Its tasks' workers start in `auto` when the chat is in Auto, else `default`. Codex hooks the owner has not trusted yet do not run in it, and the chat says so in a `system` item.

`chatOptions`:

```json
{ "models": [ { "id": "fable", "label": "Fable", "harness": "claude" }, { "id": "opus", "label": "Opus", "harness": "claude" },
              { "id": "sonnet", "label": "Sonnet", "harness": "claude" }, { "id": "haiku", "label": "Haiku", "harness": "claude" }, { "id": "gpt-5.6-terra", "label": "GPT-5.6 Terra", "harness": "codex" } ],
  "defaultModel": "opus",
  "modes": { "claude": [ { "id": "default", "label": "Ask" }, { "id": "acceptEdits", "label": "Accept edits" },
                         { "id": "plan", "label": "Plan" }, { "id": "auto", "label": "Auto" } ],
             "codex": [ { "id": "default", "label": "Ask" }, { "id": "auto", "label": "Auto" }, { "id": "read-only", "label": "Read only" } ] },
  "defaultMode": { "claude": "auto", "codex": "auto" },
  "modeFixed": { "claude": false, "codex": false },
  "archiveAfterDays": 7 }
```

A Codex model makes a Codex chat. `models` lists Codex's only where its CLI is installed: the ones its own picker shows, its default first, as its app server's `model/list` gave them (the host reads them at start and every few hours into `_machine/codex-models.json`; before the first read, a fallback; `ROLLCALL_CODEX_MODELS=0` turns the read off). Codex's modes are its own presets under the names of the Claude modes they match: `default` (Ask: it works in its worktree's sandbox and asks before leaving it), `auto` (Codex's auto review decides each request, as Claude Code's classifier does in auto mode), `read-only`. Codex's Full Access matches no mode in the chip and is not offered. A Codex chat's mode changes mid-chat, from its next turn. `modeFixed` stays for a front end that greys the chip; this rollcall sends `false` for both. `archiveAfterDays` is `ROLLCALL_CHAT_ARCHIVE_DAYS` (default 7). An older rollcall sends no `chatOptions` and no `chat`.

**Its history** gains one item kind: a task it starts (`rollcall task new` under its home) appends `{ kind: "task", id: "task:<home>:<tid>", at, ref: "<home>:<tid>", title }` and sends it as an `item` event. Draw it as a card from the live snapshot task with that ref; a front end that does not know the kind draws nothing.

**Archive.** By hand (`chat.archive`, refused while it has open tasks, a turn runs or a request is open) or by the host, which looks every 10 minutes (`ROLLCALL_CHAT_ARCHIVE_POLL_MS`): a chat with no open tasks, no running turn, no open request and `lastUsedAt` older than the delay is archived (`archivedBy: "auto"`). Archiving ends its process (its session is saved). The owner's words to an archived chat (`task.tell` with the bare home) unarchive it and wake it; rollcall's own words to it are refused. `rollcall gc` never removes a chat's worktree while the chat is not archived (a fresh one has no commits and would read as merged and unused); an archived chat's worktree goes once its work landed and it is clean, as a task's. Unarchiving a chat whose worktree is gone makes a new one from origin's default branch, on a new branch, and says so in `note`. A chat home is never pruned with idle supervisors.

### Moving a chat

A chat (or a hosted crew) moves whole between this machine and another, mid-work: cockpit's "Move to Cloud" and "Move to This Mac" (`src/move.mjs`; cockpit's `docs/plans/2026-11-12-move-chat-to-cloud.md`). Each step is an action above and a CLI, `rollcall chat move <verb> --json '<payload>'`, which prints the same JSON. The source runs `check`, `pack`, then `finish` (or `undo` after a failed move); the target runs `unpack`, then `resume` (or `discard`).

- **Pack** pauses the home's agents through the host (interrupt a running one, then park), records which were running and which were idle (process up, no turn: Claude Code may have moved a long command of theirs to the background, and the park stops it), and writes `<store>/_moves/<home>-<id>.tar.gz`: `move.json` (format, home, the source's paths, each agent's harness, session, thread and state at pack time, which were running and which idle), the home folder minus live-process files (locks, sockets, `watch.json`, the host's `claude.json` / `codex.json`), and per worktree a git bundle of the branch's commits origin lacks, the tracked changes (`git diff --binary HEAD`), the untracked files, and the gitignored files `.worktreeinclude` names. Other ignored files stay (`check`'s `staying`). Each agent's Claude transcripts (with subagent folders) and Codex rollouts go too. Packing only reads the source: nothing is stashed, reset, deleted or pushed. Its record is the home's `move-out.json`.
- **Unpack** finds a checkout of the same origin (a repo this store's tasks or chats name, else `$HOME/<repo>`, else clones it there, `gh repo clone` for GitHub), fetches, applies the bundle, adds the worktree at the branch (`.claude/worktrees/<name>`), applies the diff (what does not apply goes hunk by hunk, and the rest is named in `notes`), writes the files, gives each worktree it adds or reuses its own block of ports when the manifest uses `{port}` (as `task new` does: the source's numbers may be taken here), and starts `worktree.setup` as a new task's worktree does. The home lands with every source path (store, home, worktrees, main checkouts, Claude and Codex folders) rewritten to this machine's, in its files, launch files and session files; a Claude transcript is filed under the folder its new cwd names. Each worktree's old block travels in the archive (`move.json`), and its numbers become the new block's in every worker's launch files (`host-env.sh`, `launch.sh`, the `*-launch.json`), whose `ROLLCALL_PORT` / `ROLLCALL_PORT_COUNT` lines name the new block. Agents land `parked`; a launch binary this machine lacks becomes its own. The running host reads the agents again (its `adopt` op). Its record, `moved-in.json`, lists what it made, for `discard`.
- **Clash**: the branch here has commits the moved one lacks, or a worktree of it here holds work of its own. A home here marked moved away (a chat coming back) is replaced (the old one is kept under `_moves/in-<id>/old-home` until `discard` or two days), and its old worktree reused when it is exactly as it was when the chat left (its tip, changes and untracked files hashed at pack time), else `clash`.
- **Finish** writes the home's `moved.json` (`movedTo`, `movedAt`) and `movedTo` / `movedAt` on `chat.json`: the home leaves the snapshot and chat search, the host holds words to it (below), and its worktrees stay on disk, their blocks of ports given back (`undo` keeps them). **Resume** adds a `system` item "Moved to <here> from <from>" to the home's history and tells each agent that was running: "This chat moved from <from> to <here>. Your files are now at <path>. Carry on where you left off." Each that was idle hears: "This chat moved from <from> to <here>. Your files are now at <path>. Commands you left running in the background were stopped by the move: start again any you still need; otherwise there is nothing to do." Agents parked or stopped at pack time stay parked. **Undo** clears the marks, deletes the archive and tells the agents that were running to carry on where they were, and those that were idle: "... Commands you left running in the background were stopped; start again any you still need." **Discard** removes only what the unpack made (the home, the worktrees and branches it added, the blocks of ports it took, a clone it made, the session files it wrote, putting back any it replaced) and never a checkout it did not make.
- **Words while moving.** From `pack` on (the home's `move-out.json`) and after `finish` (`moved.json`), the host's `say` to any agent of the home never wakes it: the words wait in the home's `move-held.json` (`{ ref, uuid, text, at, from, attachments }`, in order) and `say` answers `how: "held"` with a `why`. Words held before the archive is written travel in it; `resume` delivers them after the moved line, in order, each with its own sender and uuid (attachments not on this machine are dropped), and answers `held: { delivered, failed }`. `undo` clears the marks and delivers every held word at the source. `finish` keeps holding and answers `held`: the words held after the archive was written, which did not travel, for the front end to forward.
- Archives and unpack leftovers older than two days go at the next pack. `ROLLCALL_MOVE_SETUP=0` skips `worktree.setup` (tests).

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
| `mode`, `model`, `effort` | string \| null | What it was launched with; a hosted Claude worker launched without a model or mode shows what Claude Code says it runs |

**A hosted agent's request.** `{ id, at, kind, tool, input, summary, reason, questions, plan, relays, suggestions }`, open until answered: the host's `request` events and `history` page, and `api conversation`'s `prompt`. A tmux worker has none: its `dialog` says what is open in its window.
- `id`: what `prompt.answer` names. `kind`: `permission` (a tool needs approval), `plan` (ExitPlanMode: approve the plan) or `question` (the session's own AskUserQuestion).
- `tool`, `input`, `summary`, `reason`: as a held item's (below), for any kind. `suggestions`: Claude Code's permission suggestions; `always: true` applies those that last for the session.
- `questions`: for `question`, `{ question, header, multiSelect, options: [{ label, description }] }`. `plan`: for `plan`, the plan's markdown.
- `relays`: on the Falcon's own question, when it relays a task's open question: `{ ref, question }` (the task and its question id). A front end shows that task's card for it and never a second one. Answering the task's question (`question.answer`) closes this prompt (declined, with a note to the Falcon that the answer went through); answering this prompt answers the task's question, as a pick in the Falcon's picker does.
- A task worker's own question never opens a request: it is the task's `question`.
- Away mode holds a hosted agent's permission request exactly as a tmux worker's dialog: it becomes a held item, never a request.

**A session.** `{ id, repo: { key, name }, branch, checkout, mainCheckout, harness, state, since, intent, claim }`. `state` is `working`, `idle` or `stale`. `intent` is its claim or first prompt.

**A queue.** `{ repo: { key, name }, entries, train, lander, outcomes }`. Each entry is `{ pr, branch, task, session, state, why, readyAt, files, stuck }`, oldest first. `train` is `{ n, prs, stage, pr, suite, startedAt }` or null. `lander` is `{ pid, since }` or null. `outcomes` holds the last 10 results as the lander wrote them.

### Away mode

The owner turns it on when they step away (`away.set`, `rollcall away on`). While it is on, nothing a task worker does waits on them: a permission prompt is held instead of shown, and a question waits on its task. Only task workers are held; the owner's own sessions and supervisors never are. `away` and `held` are machine-wide: `--home` does not filter them.

**`away`.** `{ on, since, by, last }`. `on`: away mode is on now. `since`: when it was turned on (null while off). `by`: the client that turned it on (`cockpit`, `cockpit-phone`, `the terminal`), null while off. `last`: the most recent finished spell, kept until the next one starts, else null: `{ since, until, done }`, where `done` lists the tasks that reached `landed` or `closed` between `since` and `until`, oldest first: `{ ref, title, state, at, pr }` (`pr` the PR's URL or null). A front end shows what got done from it even after those tasks left the snapshot's one-hour window.

**A held item.** `{ id, ref, home, at, harness, tool, input, summary, reason, state, answer, truncated }`.
- `id`: stable (`h-<ms>-<hex>`), what `held.answer` names. `ref`: the task; `home`: its supervisor. `at`: when it was held.
- `harness`: `claude` or `codex`. `tool`: the tool as the harness named it (`Bash`, `Edit`, `WebFetch`, `mcp__x__y`; Codex's command and file approvals read as `Bash` and `Edit`, its permission requests as `permissions`).
- `input`: the tool's input as the agent sent it, long strings cut at 2,000 characters; one still over 8 KB keeps `{ gist, description, trimmed: true }`. Codex's command approvals add `cwd` (and `argv`, `network` when Codex sends them), its file approvals `files` and a `changes` hash, its permission requests the `permissions` asked for.
- `truncated`: true when `input` had to be cut, so the owner cannot see all of what would run. Approving it grants nothing ahead (below); a front end says so before the owner approves.
- `summary`: one plain line a person reads: the command, `Edit src/a.ts` (relative to the task's worktree), or the tool and what it names. `reason`: the agent's stated reason (Bash's `description`, Codex's reason), else null.
- `state`: `held` (waiting on the owner), `approved` or `denied`. `answer`: null while held, else `{ at, by, allow, why, all }`; `all` is true when `held.allowAll` approved it.

The same request asked again while it is still held is the same item. Questions are not copied here: a question asked while away lives on its task (`question`, `needsOwner.kind: "needs-you"`) as any question does. A front end builds "While you were away" from `held` items still `held`, plus open tasks whose `needsOwner` is set, grouped by task, oldest first, and `away.last.done` for what got done.

**What the worker hears.** A held permission prompt is refused with a note: held for the owner, do not try another way round it, carry on with the work that does not need it, and mention it in the final report. A question while away goes to the task even when a terminal shows the worker, and the worker hears to carry on with what does not depend on the answer, then end its turn. An answer reaches the worker as its next prompt, through the queue `task.tell` uses, which wakes an idle worker and resumes a stopped one: "The owner approved your held request: `<summary>`. Run it now." or "The owner denied your held request: `<summary>`. Their words: `<why>`". An approval also leaves a one-time grant for that task, tool and input (every field of the input but the agent's `description`, so a command's sandbox or background flag counts): the worker's next matching request goes through without a prompt. A grant is used once and lasts a day, or until away mode is turned off, whichever comes first. A `truncated` item, and one whose input names nothing to match (a Codex file change that lists no files), gets no grant: the approval reaches the worker as words, adding that the request asks again (shown to the owner, or held again while they are away). A held item whose task finished is answered on the record only.

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
| `task.tell` | `task` (or a bare home: a hosted supervisor itself), `text`, optional `attachments` (absolute paths, ten at most; hosted crews only) | `delivered`, `how` (`typed`, `sent`, `queued`, `held`, `resumed`), `why`, `view` | `@luke <text>` |
| `question.answer` | `task`, `question` (its id), `answers` (question text to answer) or `answer` (a single question) | `delivered`, `how`, `why`, `pickerClosed`, `view` | a pick in the Falcon's picker |
| `task.interrupt` | `task` (or a bare home: a hosted supervisor) | `interrupted`, `why` | `start.mjs <task> --interrupt` (Esc in its window; the host's interrupt for a hosted agent) |
| `prompt.answer` | `task` (or a bare home), of a hosted crew; `prompt` (the request's id), and by kind: `permission`: `allow`, optional `why`, optional `always`; `plan`: `allow`, optional `why`, optional `mode` (`acceptEdits`, `default`); `question`: `answers` (question text to answer) | `answered`, `already`, `view` | the host's `answer` |
| `worker.set` | `task` (or a bare home: a hosted supervisor or a chat), of a hosted crew; `model` and/or `mode` (`default`, `acceptEdits`, `plan`, `auto`: the modes Shift-Tab cycles, and Claude Code's auto mode; a task's mode lasts for the session, a model carries into a resume; a chat keeps its mode too, across park, archive and wake, and takes either while parked, for its next start). A Codex task takes a Codex `model` only, from its next turn (a `mode` is `bad-payload`: it keeps the mode it started with). A Codex chat takes a Codex `model` and a Codex `mode` (`default`, `auto`, `read-only`), both from its next turn | `set`, `view` | the host's `set` |
| `chat.new` | `cwd` (an absolute folder), `text` (the first message), optional `attachments` (absolute paths, ten at most), `model` (a Claude alias or id, or a Codex model, which makes a Codex chat; default `opus`; a Codex model is `not-available` when Codex is not installed or not signed in), `mode` (one of that harness's `chatOptions.modes`; default `default`), `title` (1-200: the owner names it, and no model title follows) | `home`, `ref` (= home), `chat` (as in the snapshot), `session` | a new chat in cockpit |
| `chat.rename` | `home`, `title` (1-200) | `chat` | |
| `chat.archive` | `home` | `chat`; `refused` with open tasks ("it has N open tasks"), a request open ("it is waiting on you") or a turn running ("it is working") | |
| `chat.unarchive` | `home` | `chat` | |
| `chat.search` | `query` (1-200), optional `limit` (1-200, default 30) | `results`: `[{ home, title, folder, folderName, archivedAt, lastUsedAt, match: { in: "title" \| "text", snippet, itemId } }]`, best first | |
| `chat.move.check` | `home` (a chat or a hosted crew) | `home`, `agents` (`ref`, `state`, `harness`), `worktrees` (`ref`, `refs`, `path`, `main`, `repo`, `origin`, `branch`, `tip`, `changed`, `added`, `unpushed`, `secrets`, `staying`), `secrets` and `staying` (relative paths), `ios`, `problems` (`code`, `message`, `ref`) | `rollcall chat move check` (see Moving a chat) |
| `chat.move.pack` | `home` | `path`, `bytes`, `sha256`, `running` and `idle` (refs, as at pack time); refused with the first problem's code (`busy-terminal`, `no-origin`, ...) and `problems`, or `busy` when an agent did not pause | `rollcall chat move pack` |
| `chat.move.unpack` | `path` (the archive here), optional `from` (the source's name, "MacBook Pro"), `sha256` | `home`, `refs`, `notes` (`[{ path, why }]`: what did not apply); refused `exists`, `clash` (with `repo`, `branch`), `failed` | `rollcall chat move unpack` |
| `chat.move.finish` | `home`, optional `to` (the target's name) | `home`, `movedTo`, `movedAt`, `held` (words held after the archive was written; `already` on a repeat) | `rollcall chat move finish` |
| `chat.move.resume` | `home`, optional `here` (this machine's name; default `ROLLCALL_PLACE_NAME`, else the host name) | `home`, `woke` (refs), `failed` (`[{ ref, why }]`), `held` (`{ delivered, failed }`) | `rollcall chat move resume` |
| `chat.move.undo` | `home` | `home`, `woke`, `failed`, `held`, `archiveDeleted` | `rollcall chat move undo` |
| `chat.move.discard` | `home` | `home`, `removed`: `{ worktrees, branches, clones, sessions, home }` | `rollcall chat move discard` |
| `supervisor.new` | `cwd` (absolute), optional `name` (a free supervisor name; else the next free ship name) | `home`, `session`, `runtime` (`"host"`) | `rollcall host new --cwd <dir> [--name <h>]` |
| `supervisor.end` | `home` (a hosted supervisor) | `stopped` (refs) | `rollcall host end <h>` |
| `task.stop` | `task` | `stopped`, `why`, `view` | `start.mjs <task> --stop` |
| `task.resume` | `task`, optional `why` (up to 300) | `resumed`, `trustPrompt`, `message`, `view` | `start.mjs <task> --resume "<why>"` |
| `task.close` | `task`, optional `why` (up to 300) | `closed`, `already`, `view` | `rollcall task close <task> "<why>"` |
| `task.move` | `task`, and `to` (a supervisor) or `harness` (`claude` or `codex`) | `moved`, `already`, `task` (the new ref, for `to`), `harness` and `view` (for `harness`) | `rollcall task move <task> --to <supervisor>` or `--harness <h>` |
| `decision.answer` | `n` (a number, or `d3`), optional `answer` (up to 2,000) | `answered`, `already`, `delivered`, `how` | `rollcall task decisions done <n> "<answer>"` |
| `away.set` | `on` (bool) | `away` (the new value), `already` | `rollcall away on\|off` |
| `held.answer` | `id`, `allow` (bool), optional `why` (up to 2,000) | `answered`, `already`, `delivered`, `how`, `view` (the task's view, or null) | `rollcall away allow\|deny <id> ["<why>"]` |
| `held.allowAll` | optional `home` (only that supervisor's) | `approved` (ids), `count` | `rollcall away allow-all` |
| `blocker.clear` | `kind` (`usage`, `usage-codex`, `billing`, `disk`, `power`, `memory`, `spotlight`) | `cleared` | `rollcall blockers clear <kind>` |
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
- `task.tell` to a hosted agent goes in through the host: `sent` (a turn starts), `queued` (it goes into the running turn, as words typed mid-turn do), `resumed` (a parked agent woke on its session) or `held` (it is open in a terminal). Attachments ride as a last line naming them (`[Attached: /a.png, /b.txt]`), and images also go in as images; a terminal crew's task refuses them. With a bare home the words are the owner's line to a hosted supervisor, as if typed into its prompt; a terminal supervisor is `refused` (the owner types in its terminal).
- `task.interrupt` stops the worker's turn; it keeps running.
- `prompt.answer`: the first answer wins; the same prompt again answers `already: true`, an unknown id is `not-found`. `always: true` allows that kind of call for the rest of the session: it applies only the suggestions whose `destination` is `session`, never a rule written to a settings file. Only `allow: true` allows; anything else declines, a question's `answers` included. A `plan` approved with `mode` also sets the session's permission mode. A Codex worker's prompts are `permission` (a command, a file change, wider permissions, an MCP server's request) and, rarely, `question` (one that could not go to the task); `always` there is Codex's approval for the rest of the session. On a worker in the terminal view, `prompt.answer` and `worker.set` are `refused` with a message that says to switch.
- `task.stop` ends the worker; the task stays open and nothing resumes it unasked.
- `chat.new` answers as soon as the worktree exists and the agent is started; it never waits on the first turn. It fetches origin's default branch for at most 3 s and makes the worktree from it (a failed fetch uses the local ref); git refusing altogether (not a repo, a broken repo) runs the chat in the folder itself with `note` set. The first message is the owner's text exactly (attachments as `task.tell` takes them), in the picked model and mode; the worktree's setup (the test manifest's `worktree.setup`) runs in the background, as a task's. A start the host refuses leaves nothing behind (no home, worktree or branch; the error names no `home`): the words stay with the front end, to send again. Its record is `chat.json` in its home. The title starts as the draft; the host then asks a one-shot model (`claude -p --model haiku`, no tools, no settings, no session saved; `ROLLCALL_CHAT_TITLE_CMD` stands in for it) for a 2-6 word title in the background, unless the owner named or renamed it first.
- `chat.search` reads every chat's title and history (the owner's words and the replies, not tool output), archived ones included. Each word of `query` must appear, case-insensitive. Title matches come before text matches, then the newest; `snippet` is about 120 characters around the first hit, `itemId` the history item it is in (null for a title match). Read-only: a `requestId` keeps no copy.
- `supervisor.new` and `supervisor.end` stay for scripts, but cockpit makes chats now. `supervisor.new` makes a hosted crew: the home is recorded as hosted (`runtime.json`), its first session starts in the host on `/supervisor <h>`, and every task it starts runs in the host. A taken `name` is `refused`. `supervisor.end` stops its open tasks' agents, then its own (sessions saved: the owner's words to it, or `task.resume`, bring them back); a terminal crew is `not-found`. A terminal crew is never made or ended here: `falcon` and `/supervisor` own it.
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

## `rollcall api conversation <ref> [--before <cursor>] [--limit <n>] [--follow]`

A hosted agent's conversation as plain items, for a native chat: a hosted crew's task ref (`hoth:t3`), or its bare home (`hoth`) for the supervisor's own. It reads the host's one history of the agent (every session, the escape hatch's turns too), starting the host when it does not run. A terminal crew's ref is `not-found`: show it as a terminal (`attach`).

Without `--follow` it prints one line, a page: `{ "ok": true, "ref", "session", "harness", "items": [...], "cursor", "more", "prompt", "agent" }`: the last `--limit` items (200 by default), or with `--before <cursor>` the page before it. `cursor` is the id of the page's oldest item (null when `more` is false); an unknown cursor is `not-found`. `prompt` is the agent's first open request; `agent` its state in the host. Items under a subagent come right after it and do not count toward the limit.

With `--follow` it prints the page (`type: "page"`), then one line per change until stopped, in `api stream`'s envelope (`v`, `seq`, `at`, `type`):

| Type | Payload | Meaning |
|---|---|---|
| `page` | the page's fields | First line, and after a `reset` |
| `item` | `item` | A new item, or one replacing the item with the same `id` (a tool's result arrived, streamed text finished) |
| `text` | `id`, `append` | Streamed text added to item `id` (an `assistant` or `thinking` item with `streaming: true`) |
| `prompt` | `prompt` (or null) | The open request changed or closed |
| `reset` | | Start over: drop the items and take the next `page` line (the host went away and the follow attached again) |
| `heartbeat` | | Nothing for 15 s (`ROLLCALL_API_HEARTBEAT_MS`) |
| `error` | `message` | Reading failed; the follow goes on |

It ends as `api stream` does. Several follows at once are fine: each is one subscription on the host's socket. A front end may talk to the socket itself instead (The agent host).

**Items.** Every item is `{ id, at, kind, ... }`, `id` stable across pages and follows, in the conversation's order.

| `kind` | Fields |
|---|---|
| `user` | `text`, `images` (paths), `from` (`owner` or `rollcall`), `queued` (sent while a turn runs or the agent is open in a terminal, and not taken yet: the words wait. Words that start a turn are never `queued`) |
| `assistant` | `text` (markdown), `streaming` |
| `thinking` | `text`, `streaming` |
| `tool` | `tool`, `summary` (one line), `input` (long strings cut at 2,000 characters), `state` (`running`, `done`, `error`, `denied`), `result` `{ text, truncated, size }` (text cut at 100,000 characters) or null while running, `patch` (a unified diff, for edits), `parent` (the `subagent` item it ran under) |
| `subagent` | `agent`, `description`, `state` (`running`, `done`, `error`), `result`, `children` |
| `todos` | `todos`: `[{ content, status, activeForm }]` (the latest list) |
| `compaction` | `trigger` (`auto`, `manual`), `tokens` |
| `turn` | `phase` (`start`, `end`), and at the end `ms`, `tokens` `{ input, output, context }`, `error` (one line, when the turn failed) |
| `system` | `text`: a note (a command's output, a background agent's notice) |

## The agent host

Cockpit's crews run in the agent host: a supervisor made with `supervisor.new` (or `rollcall host new`), and every task it starts, Claude and Codex alike. A crew started in the terminal (`falcon`, `/supervisor`) never does: its supervisor and workers are tmux windows running the real CLIs, and nothing keeps the two kinds in step. The host is `rollcall host`, one long-lived process per store (`ROLLCALL_HOME`), with its lock, `host.json` and log in `<store>/_host/` and its socket at `rollcall-host-<8 hex of the store path's sha256>.sock` in the system temp folder. A client that needs it starts it (`host/client.mjs ensureHost`), detached, so it outlives the client. The host records the rollcall code it runs (`host.json` `code`, a hash of `src/`); a client that finds other code on disk (an update landed while the host ran) stops that host and starts a fresh one, unless an agent is in a turn, which a restart would cut. Then the old host serves until a call needs an op it lacks (it answers `no op ...`), which replaces it at once. Either way its agents park, and a message brings each back. The design: `docs/plans/2026-11-08-agent-host.md`.

**The commands above for a hosted crew.** Its supervisor's snapshot says `runtime: "host"`; a task's `worker` reads as for a tmux worker (alive, busy, parked, stopped), its open request comes from the host (`history`, `subscribe`, `api conversation`). `task.tell`, `prompt.answer`, `task.interrupt`, `worker.set`, `task.stop` and `task.resume` reach it through the host; `attach` has no window to show (the escape hatch below is its terminal). `api conversation <ref>` reads the task's one history from the host, across every session; `--follow` prints the same `page`, `item`, `text`, `prompt` and `heartbeat` lines, needs no `reset` for a new session, and prints `reset` then `page` only after the host restarted.

**The socket.** Newline-delimited JSON. A call is `{ "id", "op", ... }`; its answer `{ "id", "ok": true, ... }` or `{ "id", "ok": false, "error": { "code", "message" } }`.

| `op` | Payload | Answer |
|---|---|---|
| `hello` | | `pid`, `version`, `code` (the hash of the code it runs), `interface` |
| `list` | | `agents` |
| `state` | `ref` | `agent` |
| `start` | `ref`, optional `prompt`, `restart`, `harness` (`claude`, `codex`; else the newer launch file) | `agent`, `already` |
| `say` | `ref`, `text`, optional `attachments` (paths, ten at most), `from` (`owner`, `rollcall`), `uuid`, `now` | `how` (`sent`, `queued`, `resumed`), `uuid` (the item's id); with `now`, `declined` (request ids) or `interrupted` |
| `interrupt` | `ref` | `interrupted` |
| `answer` | `request`, optional `ref`, `by`, and by kind: `allow`, `why`, `always`, `mode`; `answers` | `answered`, `how` (`answered`, or `words` for a request whose process is gone) |
| `set` | `ref`, `model` and/or `mode` (`default`, `acceptEdits`, `plan`, `auto`); a chat's mode also goes in its launch, so a resume keeps it, and a chat with no process takes it for its next start | `set` |
| `park`, `stop` | `ref` | `parked`, `stopped` |
| `history` | `ref`, optional `before`, `limit` (200) | `items`, `cursor`, `more`, `session`, `harness`, `agent`, `requests` |
| `subscribe` | optional `refs` (every agent when absent) | `subscribed`, `agents`; then events on the same connection |
| `open` | `ref` | `argv`: the command that opens the agent in a terminal (`rollcall open <ref>`), for a front end's own terminal, as `attach` gives tmux's |
| `terminal` | `ref`, optional `pid` (the caller's process, which waits on the CLI) | `argv` (the real CLI on the agent's session), `cwd`, `unset` (variables to drop), `agent`. `rollcall open` sends it with its pid and holds the connection while the CLI runs |
| `terminal-done` | `ref` | `closed`, `added` (items the terminal's session added to the history), `agent` |
| `terminal-end` | `ref` | `closing` (false: no terminal open), `agent`. A front end done with the terminal: `rollcall open` ends the CLI once no turn runs, then closes it as `terminal-done` does; `refused` when no pid is on record |
| `adopt` | `refs` | `adopted`, `skipped`: each agent of `refs` read again from disk (a chat a move unpacked, replaced or removed; one with a process is skipped). A home that appears while the host runs is also found on its first `state` or `say` |
| `system` | `ref`, `text` | `ok`: a `system` item in the agent's history (a move's "Moved to Cloud from MacBook Pro") |
| `shutdown` | | the host parks every agent and exits |

**An agent.** `{ ref, home, task, supervisor, harness, state, send, session, since, turnAt, parkedAt, model, mode, pid, requests, queued, terminal }`. `ref` is `home:task` for a task's worker, or the bare home for its supervisor (`supervisor: true`, `task: null`). `state` is `running` (a turn runs), `idle` (its process is up, no turn), `parked` (no process: the history and requests stay), `stopped`, or `terminal` (open in a terminal, below). `send` says what a message does now: `join` (goes into the running turn), `start` (starts a turn), `wake` (resumes the session, then delivers) or `hold` (waits until the terminal closes). An idle agent parks after `ROLLCALL_HOST_PARK_MS` (an hour), never with a request open or words waiting. The host's record of it is `agent.json` in the task's worker folder; the history is `history.jsonl` beside it.

**Events.** `{ "type": "event", "v": 1, "seq", "at", "ref", "ev", ... }`: `state` (`agent`), `item` (`item`: new, or replacing the one with its `id`; words sent come first as a user item with the id `say` returned, `queued: true` when they wait behind a running turn or a terminal), `text` (`id`, `kind`, `append`, `parent`: streamed text on an item not finished yet), `request` (`request`), `closed` (`id`, `how`: `answered`, `cancelled` or `words`; `by`), `session` (`session`, `how`: `new` or `resume`).

**Requests.** A question or permission prompt is a request: the prompt shape above plus `ref` and `session`, with an id of the host's own (`rq-...`) that survives a restart. The first answer wins; any later one hears `already-answered`. Claude Code cancelling it closes it (`cancelled`). An answer to a request whose process is gone (a crash, a host restart) wakes the agent on its session and delivers the answer as the owner's words (`how: "words"`), so the owner never meets a dead end.

**Codex agents.** A hosted Codex agent runs its own `codex app-server` on a unix socket, one thread per session, with the same hooks, snapshots, usage-limit wait and context cap a tmux Codex worker has (`src/codex/session.mjs`; the tmux worker keeps its own loop and shares its protocol pieces), and a journal of its items. Its item ids carry the session's first 8 characters (`3f2a9c1d:item-4`); a user message keeps the id it was sent with. Approvals and questions are requests like Claude's. `worker.set` takes a model only (a task's Codex agent keeps the permission mode it started with; a Codex chat's mode changes from its next turn). Words steered in as a turn ended and never taken leave the queue after 3 s. Its seam is `codex.json`, with `ctl` and `thread`.

**Chats.** A chat's own session runs in the host like a hosted supervisor's (ref the bare home, `supervisor: true`, its history in the home's own worker folder), but starts on the owner's words in its own worktree, with the chat contract appended (`--append-system-prompt`, read from the launch's `appendPrompt` file at each start, the escape hatch's included). The host binds it to its home at each start (the home's `lock.json`, and `chat: { home }` on the session's record, not `supervisor`), so its hooks mark its turns and bring its tasks' news, which reads "news from the tasks this chat started", and its edits are allowed. The host's `chat-start`, `chat-task` and `chat-archive` ops serve `chat.new`, task cards and archiving. Falcon and `/supervisor` leave chats out (`rollcall supervise <chat home>` is refused).

**Supervisors.** A hosted supervisor's own session runs in the host, with no tmux window: `supervisor.new` starts it on `/supervisor <h>`, the watcher brings it back through the host (a handoff too), the host parks it on its own timer, and the watcher's news goes in through `say` (a parked supervisor wakes on its session). Its history is its own (`history.jsonl` in the home's own worker folder). Falcon refuses it (`falcon resume` names it as cockpit's) and leaves it out of its list. `supervisor.end` stops it and its workers. A question it asks that names a task's open question carries `relays: { ref, question }`: it is that task's request, so a front end shows the task's card, and it is answered once. Answered on the supervisor's request (`answer` with `answers`), the host passes it to the task as `question.answer` does, and Claude Code hears it was answered elsewhere (`how: "relayed"`). Answered on the task (`question.answer`), rollcall closes the supervisor's request through its seam, matched by the relayed question's id (the supervisor may word its question its own way). A second answer from either side hears `already-answered`, and closes the supervisor's request if it is still open. A front end shows the supervisor's own card for a relayed request once the task no longer asks that question.

**Words during a turn.** Words sent while a turn runs queue behind it (`how: "queued"`), as in Claude Code, also while the agent waits on a question, a permission or a plan. The owner's `now: true` ("send now") goes in at once: it declines every open request (`declined`, closed `by: "the owner's message"`, and Claude Code hears the owner wrote instead), or with none open interrupts the turn and waits for its end (`interrupted: true`), so the words start the next turn. rollcall's own words never decline a request.

**Environment.** The host and every agent it runs drop the settings one session or task carries (`host/client.mjs` `SESSION_ENV`: a task's `ROLLCALL_*` settings, Claude Code's session markers, tmux), whoever started the host. A host that runs older code than the code on disk is replaced at the next call unless an agent is in a turn; a turn that has waited on the owner over ten minutes (`ROLLCALL_HOST_STALE_WAIT_MS`) does not hold it, since its request survives the restart.

**The terminal escape hatch.** `rollcall open <ref>` runs the real CLI on the agent's own session in the caller's terminal: `claude --resume <session>` with the launch's settings, mode, model and effort (a session that never ran starts with `--session-id`, its name and its first prompt), or `codex resume <thread>`. The host ends its own process for the agent first and holds none while the CLI runs; the agent shows `terminal`. Meanwhile `say` answers `how: "held"` (the words wait, survive a host restart, and go in once when the terminal closes), `interrupt` and `start` are `refused`, `park` does nothing and the idle timer never runs. When the CLI exits (or the connection that opened it closes), the host appends what the terminal added that the history lacks, in order: a Claude session's items from its transcript, a Codex thread's new turns read from the thread itself (ids `<session prefix>:<turn>:<item>`). The agent is then `parked`, and held words wake it. A host restarted while the terminal runs keeps the agent `terminal` and watches the process that sent `terminal` (its `pid`); its end closes the terminal the same way, and so does `rollcall open` calling `terminal-done` on the new host. A terminal that closed while no host ran is read back when the host starts, and the agent is `parked`. Reading a terminal twice adds nothing, and neither does reading a turn the host ran itself (its transcript ends it under another id). A front end that runs its own terminal asks `open` for the argv. `terminal` on an agent is `{ at, closing }` while one is open (else null). `terminal-end` sets `closing` and sends SIGTERM to the `rollcall open` that runs it, which waits for a turn that started in the terminal to end, then ends the CLI with SIGTERM (Claude Code then ends cleanly with code 143, which `rollcall open` reports as 0); held words go in after the terminal's turn. A task's Claude worker is in a turn by its task's status log (an open dialog counts as no turn: nobody sees it), a Claude supervisor by its home's `turn` record (the owner's rollcall hooks write it at each prompt and Stop), a Codex agent by its thread (`thread/read` on a short-lived app server every 2 s: a turn `inProgress` that started in the terminal). Stream mode never asks Claude Code's trust question, so before the CLI opens on a task, the host marks the task's worktree trusted as Claude Code records the owner's yes (`hasTrustDialogAccepted` in `$CLAUDE_CONFIG_DIR/.claude.json`), only for folders rollcall made (under the repo's `.claude/worktrees/`, or the no-repo jobs folder); any other folder still asks.

**Restart.** The host rebuilds itself from the `agent.json` files. An agent whose process went with the old host is `parked`, with a `system` item saying so; its open requests stay open. Nothing starts by itself.

## Several front ends at once

- **The first answer wins.** `question.answer` settles under the task's lock. Of two surfaces answering at once, one wins; the other hears `already-answered`. An app answering after a pick in the Falcon's picker hears `already-answered` too; a front end that holds an id from an older question may hear `no-question`, and reads `answered` from the next snapshot. A pick in the Falcon's picker for a question a front end answered first goes nowhere, and the supervisor hears that it was answered already and from where.
- **The Falcon's picker closes.** When a front end answers every question an open picker in the Falcon holds, rollcall closes it (Esc in the supervisor's window) and tells the supervisor, so it does not ask again. A picker that still holds an unanswered question stays.
- **The owner's words from a front end** go on the task's record with `via: "app"` and the client's name, and the supervisor hears of them at its next turn, as it does for words typed in a worker's window.
- **Notifications once.** At most one front end per machine should pass `--notifies`. While one does, rollcall shows no macOS notification of its own, and that front end alerts on `notice` lines. Every other stream still gets the `notice` lines; those front ends show them without alerting.
- **Actions are safe to repeat.** Use `requestId` for retries; `already: true` covers the same action from two front ends.

## Who may call `do`

`do` acts as the owner: its words reach a worker as the owner's own, which auto mode trusts. Only the owner's apps and scripts call it, never an agent session. `api-cli.mjs` refuses it (`refused`) inside a worker (its `ROLLCALL_TASK` environment) or any agent session rollcall knows, and rollcall's Bash hook denies an agent's command that names `rollcall` and `api do`. An agent uses the `rollcall task` commands, which run the same code under its own name. `snapshot`, `stream` and `attach` carry no such check.

## Contract tests

- `test/host.test.mjs` (this package): the agent host against a stand-in Claude Code and Codex: start, words sent and queued, a request answered from two clients with the first winning, interrupt, park on idle and wake on a message, one history across a session change with earlier sessions backfilled, a restart keeping requests and history, the push lines, one host per store, a task worker started through `ROLLCALL_HOST=1` driven by the old seam, and a Codex agent's words, approvals (first answer wins), seam, hooks, park and resume of its thread. `test/host-supervisor.test.mjs`: a hosted supervisor's relayed question answered once from either side, the supervisor's tools (start, tell, wait, interrupt, chat) reaching a hosted worker with no tmux call, a supervisor started and parked through the host under the gate, and the escape hatch (terminal state, words held, a Claude terminal's and a Codex terminal's turns in the history, once, and a host restarted while a terminal runs or after it closed losing and doubling none, held words included; `terminal-end` waiting for a task's, a supervisor's and a Codex terminal's turn, and adding no second end to a turn the host ran). `test/host-stale.test.mjs`: a host started from other code replaced by the next call, kept while an agent is in a turn until a call needs an op it lacks, and a chat whose start the host refuses leaving no home, worktree or branch.
- `test/host-chat.test.mjs` (this package): chats against the stand-in Claude Code and title model: `chat.new` making the worktree and branch from origin's default branch, the owner's words first, the contract appended and the home bound; the folder fallback's note; the draft, auto and owner titles (the owner wins); the branch renamed only while unpushed; a task card in the history; archive refused with open tasks, by hand, by itself after the delay, and woken by the owner's words; search; `chat` and `chatOptions` in the snapshot; gc keeping an open chat's fresh worktree; `worker.set` with `auto`; a Codex chat against the stand-in Codex (Codex's model list, its developer instructions, Auto as auto review, a mode changed mid-chat on the next turn, its turns marked, its session in its shell, the untrusted-hooks note).
- `test/host-supervisor.test.mjs` (this package): hosted supervisors (`rollcall host new`, `host end`, `runtime` in the snapshot, falcon refusing one), relayed questions, the supervisor's tools on a hosted worker with no tmux call, the escape hatch, and a terminal supervisor's task and window going to tmux with no host started.
- `test/move.test.mjs` (this package): a chat moved between two stores and two HOMEs over a bare origin: `check`'s counts and problems; pack then unpack bringing the edited, new and `.worktreeinclude` files and an unpushed commit exactly, the paths and the transcript's folder rewritten, the source byte for byte as it was; resume and undo waking the agents that were running, and an idle one told its background commands stopped, while a parked one stays parked; a clash leaving nothing; discard removing only what unpack made; a chat coming back replacing its moved-away home and reusing its old worktree; words said while moving held, carried and delivered after the moved line (or at the source on undo); and the host adopting a home that appears while it runs and holding words to one moving or moved away.
- `test/conversation.test.mjs` (this package): transcripts folded into items, pages and cursors (the host's reader for its stream and its backfill).
- `test/codex-items.test.mjs` (this package): Codex items mapped onto the chat's, history items and the journal folder, and the approval and image shapes a hosted Codex agent sends.
- `test/claude-contract.test.mjs` (this package): the installed Claude Code still takes the stream-mode flags the host starts it with; with `ROLLCALL_CLAUDE_CONTRACT=live` it also runs one short Haiku turn and checks the message shapes the host and the conversation read.
- `test/api.test.mjs` (this package): the contract a front end relies on: the version, the snapshot, the stream and its notices, the actions and their refusals, repeats, the first answer winning, who may call `do`, and attach. It runs with `npm test` here.
- `test/away.test.mjs` (this package): away mode: a held permission request and its note, one notice per held item and question, no reminders, the switch and `last`, `held.answer` and its grant, `held.allowAll`, a decision's answer reaching its worker, and the stream's `away.changed` and `held.changed`. `test/harness.test.mjs` holds a Codex approval while away.
- `test/supervisor.test.mjs` (kesselrunner's root): a scripted front-end client beside the terminal Falcon on a real tmux server, end to end: it starts a task, sees its question, answers it, tells the worker, attaches to its terminal and watches its PR land, while the Falcon shows the same task, answer and news.

Both run in CI on every PR that touches rollcall (`.github/workflows/check.yml`: the `rollcall` and `Supervisor` jobs).
