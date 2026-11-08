---
status: done
absorbed-into: packages/rollcall/API.md, packages/rollcall/README.md, docs/architecture.md
date: 2026-11-08
decided-with-owner: 2026-11-08 (cockpit task t21 "Chat view": stream mode over reading the CLI's log, the real CLI on a switch, the Falcon in stream mode in this build, one question in one place)
covers: "The rollcall side of the chat view: a stream-mode Claude worker and Falcon, Codex workers in the chat, the conversation read for front ends, answering live moments from a front end, and the switch to and from the real CLI"
---

# Chat stream (rollcall side)

The interface contract is cockpit's `chat-contract.md` (supervisor executor's files, t22), written into
`packages/rollcall/API.md` as this lands. The plan it serves is cockpit `docs/plans/2026-11-08-chat-view.md`.
This file records how rollcall builds it, so a fresh worker carries on from the same shapes.

## Facts about Claude Code's stream mode (2.1.319, checked 2026-11-08)

- `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose
  --replay-user-messages --permission-prompt-tool stdio` runs the owner's full setup: hooks fire as in the CLI
  (SessionStart, UserPromptSubmit, PermissionRequest, Stop...), skills, CLAUDE.md and MCP load.
- A permission prompt first runs the PermissionRequest hook (away mode answers there); with no decision it comes
  over stdout as `{type:"control_request", request_id, request:{subtype:"can_use_tool", tool_name, input,
  description, permission_suggestions, blocked_path, tool_use_id}}`, answered on stdin with
  `{type:"control_response", response:{subtype:"success", request_id, response:{behavior:"allow", updatedInput}
  | {behavior:"deny", message}}}`. Without `--permission-prompt-tool stdio` it is denied at once.
- A user message written while a turn runs is taken into that turn ("absorbed mid-turn"): `--replay-user-messages`
  echoes it (`isReplay: true`) when taken, and the transcript records it as a `queued_command` attachment
  (`source_uuid`), not a `user` entry.
- Assistant output comes per content block: `stream_event` deltas carry `api_message_id` and the block `index`;
  each finished block is an `assistant` message with that one block, written to the transcript with the same
  `message.id`. The transcript's `user` and `assistant` entries carry the same `uuid` the stream does.
- A turn ends with a `result` line (`duration_ms`, `usage`, `is_error`); the transcript marks it with a `system`
  `stop_hook_summary` entry.
- Transcripts carry very large `api-request*` and `prompt_snapshot` lines (the whole request); a reader skips any
  line it does not use by its first bytes, before parsing.

## The worker process

`rollcall claude-worker <home> [<task>]` (`src/claude/worker.mjs`), one process in the window (a task's, or
with no task the supervisor's own). It reads its launch file, then loops on the view:

- `chat`: runs Claude Code in stream mode as above, with the launch's `--settings`, `--session-id` (new) or
  `--resume`, mode, model, effort and `--add-dir`. The pane shows a plain text view of the chat (the owner's
  words, reply text as it streams, one line per tool call, prompts) and a last line "Enter opens the real CLI".
  Enter (or `task.switch`) switches at the next quiet point: no turn running, no prompt open.
- `terminal`: runs the real CLI (`claude --resume <session>` with the same settings) in the foreground with the
  pane's terminal. A switch back to chat stops it at its next quiet point (its Stop hook seen, no dialog open),
  by SIGTERM; its transcript is saved as it goes. The CLI quitting on its own ends the worker, as today.

Files in the worker's folder (`store.workerDir(h, id)`; the supervisor uses `workerDir(h, h)`):

- `claude-launch.json`: what it starts with (written by `harness/claude.mjs` and `window.mjs`).
- `claude.json`: its record, swapped in whole: `{ pid, child, sock, session, view, switching, busy, turnAt,
  prompt, at }`. The snapshot reads `view`, `switching` and `prompt` from here.
- `stream.live.json`: what streams now, rewritten at most every 80 ms while text arrives:
  `{ session, at, items: [{ id, kind, text, parent }], queued: [{ uuid, text, at, from }] }`. The api stream's
  file watch ignores `*.live.json`.
- `turns.jsonl`: one line per finished turn from the `result` line: `{ at, ms, tokens: { input, output,
  context }, error, session }`.

Words in: a unix socket (`sock`, in the system temp folder) takes one JSON line and answers one:
`say { text, uuid, from, attachments }`, `interrupt`, `answer { prompt, ... }`, `set { model, mode }`,
`switch { to }`. `rollcall _claude-send <sock> <json>` is the one-shot client the synchronous callers run (as
`_codex-send` is for Codex). The socket taking a `say` is the delivery's receipt.

Prompts: `can_use_tool` becomes the record's `prompt` (`kind` `permission`, `plan` for ExitPlanMode, `question`
for AskUserQuestion) until answered. The dialog flag the PermissionRequest hook raises stays the task's
"waits on the owner" signal, so the supervisor's news, the tabs and delivery behave as for a dialog in the CLI.
A task worker's AskUserQuestion never becomes a prompt: its `ask` hook sends it to the task's question whatever
window shows it, while the worker runs in chat.

## The conversation read

`src/conversation.mjs` folds a Claude transcript into the contract's items (one parser for both views and for
every resume), then lays the live file over it: `streaming` items for text not yet in the transcript, the
`queued` messages, and `turns.jsonl` for a turn end's time and tokens. `api conversation <ref> --follow` watches
the transcript, the record and the live file, and prints the contract's `item`, `text`, `prompt`, `view` and
`reset` lines. Codex workers: the same items from the Codex worker's own journal (see Codex workers below).

## One question, one place

- A task worker's question is its task's question, in chat and in terminal alike, unless the worker runs in the
  terminal view and the owner watches that window (as today).
- The Falcon in chat: its AskUserQuestion is its `prompt` with `relays` when each question names a task with an
  open question (`taskOfQuestion`); answering the task's question elsewhere answers the Falcon's prompt as
  denied with a note (what `closeFalconPicker` does with Esc in the terminal), and answering the prompt goes
  through the Falcon's own PostToolUse routing (`picks()`) as a pick does today.

## Codex workers (task t24)

- The worker keeps its app server and thread through a switch: the chat view shows the plain text view in the pane,
  the terminal view runs Codex's own UI attached to the same server (`codex --remote`). Only the UI starts and stops.
- It hears every item of its thread in both views and writes the chat's items to `codex-<session>.jsonl` in its folder
  (`src/codex/items.mjs` maps them); text streams to `stream.live.json` from `item/agentMessage/delta` and
  `item/reasoning/summaryTextDelta`. Live item ids differ from the ids `thread/read` gives the same items later
  (`item-N`, checked on 0.146), so the journal is the record; a resume with no journal writes it once from
  `thread/resume`'s turns, ids prefixed with the turn's.
- A message rollcall sends keeps its `clientUserMessageId` as its item id, so the chat's waiting copy and the taken one
  are the same item.
- Its record (`codex.json`) gains `ctl` (a control socket taking the Claude worker's requests), `view`, `switching` and
  `prompt`; `claude/live.mjs record()` finds either worker. A Codex worker from before this has no `ctl` and reads as
  the plain CLI (stop and resume it).
- Approvals with no decision become a `permission` prompt; `always` answers `acceptForSession` (permissions: scope
  `session`). `worker.set` takes a Codex model, sent on the next turn rollcall starts (Codex keeps a turn's model for
  the turns after); the mode stays the launch's.

