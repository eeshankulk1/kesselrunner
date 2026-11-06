---
status: active
date: 2026-11-06
covers: "Reference for plan B: every Claude Code dependency of the supervisor and its workers, and what Codex CLI and Gemini CLI offer in its place (checked 2026-11-06)"
---

# Harness portability audit

Read-only audit made for the [Conductor parity set](2026-11-06-conductor-parity.md), feeding [plan B](2026-11-06-harness-layer-codex-workers.md). External facts were checked against official docs and source on 2026-11-06 and are marked VERIFIED (read in docs or source) or INFERRED. Re-check anything marked experimental before building on it.

## Summary

- tmux carries keystrokes and nothing more. Nearly every signal the supervisor uses comes from Claude Code: its hooks, its status line, its transcript files and the layout of its prompt box. So supervisor mode is not agent-agnostic today.
- `docs/codex-parity.md` is out of date: Codex now has 14 hook events, stable and on by default, and `apply_patch` fires as `Edit`/`Write`. Codex workers are reachable through an adapter.
- A Codex supervisor with every feature is not reachable today: Codex has no custom status line, no mods, and its question tool is limited to plan mode by default.
- Gemini CLI matches the most on paper, but stopped serving Google AI Pro/Ultra and free individual accounts on 2026-06-18.

## Part 1 - Claude Code dependencies

Paths are under `packages/rollcall/src/` unless noted.

| # | Dependency | Where | How central |
|---|---|---|---|
| 1 | `claude --session-id <uuid>` / `--resume <id>`, `--settings <file>`, `--permission-mode`, `--model`, `--effort`, `-n`, `--add-dir`, first prompt as an argument; the supervisor starts with `/supervisor <h>` as its first prompt | `supervisor.mjs` `writeLaunch`/`launch`; `window.mjs` `writeWindow` | Core |
| 2 | Per-worker launch settings hooking 10 events: SessionStart, UserPromptSubmit, Stop, StopFailure, SessionEnd, PermissionRequest, Notification(`elicitation_dialog`), PreToolUse(`AskUserQuestion`), PostToolUse/PostToolUseFailure. Payload fields read: `session_id, source, prompt, transcript_path, agent_id, stop_hook_active, background_tasks, last_assistant_message, error, reason, notification_type, message, tool_name, tool_input, hook_event_name` | `supervisor.mjs` `launchSettings`, `workerHook` | Core |
| 3 | Hook output: `hookSpecificOutput.additionalContext`, `permissionDecision:"deny"`, Stop `decision:"block"`, UserPromptSubmit `continue:false` + `stopReason` | `hooks.mjs` `runHook`; `workerHook` | Core |
| 4 | Supervisor hook chain: `@tN` routing (UserPromptSubmit block), picks (PostToolUse `AskUserQuestion` `tool_response.answers` keyed by question text), deny on supervisor edits (tool names `Edit/Write/MultiEdit/NotebookEdit`), `permission_mode` capture, news receipts | `hooks.mjs` `promptSubmit`/`route`/`picks`/`preToolUse`; `watch.mjs` `turnStarted`/`turnEnded`; `settings.core.json` | Core |
| 5 | AskUserQuestion relay: the worker's call is denied and recorded; the supervisor reopens it in its own picker, with headers like "luke Ship" (12 characters at most) to tag the task | `workerHook` "ask"; `taggedQuestions`/`taskOfQuestion`; `watch.mjs` wake text | Core |
| 6 | Keystrokes: bracketed paste + Enter, Esc to interrupt. `draftIn` reads Claude's prompt-box layout (a `─` rule, then `❯`, dim hint colors). Assumes Enter on the trust prompt means "No, exit" | `tmux.mjs` `type`/`interrupt`/`draftIn`; `delivery.mjs` `flush`/`canTake`; `watch.mjs` `deliver`/`clearToType` | High |
| 7 | Claude transcripts (`~/.claude/projects/<cwd-dashed>/<id>.jsonl`): `tool_use`/`tool_result` pairing, the `subagents/` folder, `origin.kind`, `isMeta`, `queued_command`, `continued-in`, image blocks | `asked.mjs`, `park.mjs` `lastEntry`, `window.mjs` `transcriptPath`/`cwdOf`, `session.mjs` `successorOf`, `pictures.mjs`, `task.mjs` `relay` | High |
| 8 | Status line command: reads `context_window.used_percentage/context_window_size/total_input_tokens`; draws chips and sets tabs. The only source of context % | `settings.core.json`; `watch.mjs` `statusline`; `supervisor.mjs` `statusLine` | High |
| 9 | Context handoff: worker at 35%/70% (`HANDOFF`, `markCap`, `capDue`); fresh supervisor at 35% or 20% (`handOver`, `supervisorMark`, `freshPct`). Rests on #8 | `supervisor.mjs`, `watch.mjs`, `window.mjs` | High |
| 10 | Parking: `parkDue` needs Stop's `background_tasks` array; park and unpark re-run `claude --resume`; supervisor idleness read from the transcript | `supervisor.mjs` `parkDue`/`park`; `park.mjs`; `window.mjs` `comeBack`/`parkWindow` | Medium-high |
| 11 | Trust: `~/.claude.json` `projects[*].hasTrustDialogAccepted`; exit 4 | `supervisor.mjs` `trusted`; `scripts/supervisor/start.mjs` `settled` | Medium |
| 12 | Mode, model and effort values (`acceptEdits/auto/bypassPermissions/dontAsk`; `low..max`); `effortLevel` read from settings | `supervisor.mjs` `MODES`/`modelOk`; `start.mjs` `workerModel` | Medium |
| 13 | Supervisor-only settings (`awaySummaryEnabled`, `promptSuggestionEnabled`, browser plugins off) | `window.mjs` `SUPERVISOR_SETTINGS` | Low |
| 14 | Mods: rollcall-band (`ui.render` on AskUserQuestion, `/attach` via `command.register`, `session.attach`); pr-band; clickable | `mods/*/hooks/register.tsx` | Low-medium (owner UX, nothing load-bearing) |
| 15 | Environment and checks: `CLAUDECODE` unsets, `needs.mjs` requires `claude`, legacy `claude stop` | `tmux.mjs` `INHERITED`, `needs.mjs`, `launch` | Low |

Already harness-neutral: the task store, the watcher loop, the delivery queue logic (it still needs a prompt hook for receipts), tmux windows and tabs, notifications, gc, the merge queue and the brief.

## Part 2 - what Codex CLI and Gemini CLI offer

| Item | Codex CLI | Gemini CLI |
|---|---|---|
| Hooks | 14 events: SessionStart, SessionEnd, SubagentStart/Stop, UserPromptSubmit, Pre/PostModelRequest, PreToolUse, PermissionRequest, PostToolUse, Pre/PostCompact, Stop, Interrupt. Same fields (`session_id, transcript_path, cwd, permission_mode, prompt, tool_*, stop_hook_active, last_assistant_message`). Same deny/`additionalContext`/Stop-block/`continue` contract. `apply_patch` fires as `Edit`/`Write`. No StopFailure, no Notification, no `background_tasks`, no `agent_id` on tool events. VERIFIED [1] | 11 events: SessionStart/End, BeforeAgent, AfterAgent, BeforeTool/AfterTool, Notification(`ToolPermission`), Before/AfterModel, BeforeToolSelection, PreCompress. Base fields `session_id, transcript_path, cwd, timestamp`. `decision` deny, `additionalContext`, `continue`; an AfterAgent deny makes it continue. No `permission_mode`, no `agent_id`. VERIFIED [7][9] |
| Hook trust | Pinned by hash, approved in `/hooks`; `--dangerously-bypass-hook-trust` for one launch. VERIFIED [1] | Changed project hooks raise a warning. VERIFIED [7] |
| Fixed id / resume | No id flag. `codex resume <id>`; the id comes from SessionStart. VERIFIED [2] | `--session-id <uuid>`, `--resume <id\|index\|latest>`. VERIFIED [8] |
| Settings at launch | `-c key=value`, `--profile`; inline `[hooks]` in config. VERIFIED [1][2]. That `-c` can carry hooks: INFERRED | `GEMINI_CLI_SYSTEM_SETTINGS_PATH` env var. VERIFIED [8] |
| Permission modes | `-a on-request\|never`, `-s`, `--approve-for-me`, `--yolo`. VERIFIED [2] | `--approval-mode default\|auto_edit\|yolo\|plan`, `--skip-trust`. VERIFIED [8] |
| Model and effort | `-m`, `-c model_reasoning_effort=`. VERIFIED [2]; `scripts/delegate/run.mjs` already uses it | `-m`; no effort flag. VERIFIED [8] |
| Question tool | `request_user_input` (id, header, question, options, `isOther`). Default mode needs the `default_mode_request_user_input` flag, marked under development and off. VERIFIED [4][5]. Hookable as a local tool: INFERRED | `ask_user` (2-4 options, header), always registered. VERIFIED [10] |
| Status line | Built-in items only; a custom command is still an open request (#17827, 2026-10-27). VERIFIED [6] | Footer items only. VERIFIED [11] |
| Context usage | `PostModelRequest.token_usage` [1]; app-server `thread/tokenUsage/updated` with `modelContextWindow` [4]. VERIFIED | AfterModel `llm_response`. INFERRED |
| Transcript | `transcript_path` given (VERIFIED); a different JSONL format under `~/.codex/sessions` (INFERRED) | `transcript_path` given (VERIFIED); a different format (INFERRED) |
| Skills, subagents, plugins, MCP, plan mode | All present; plugins can bundle hooks. VERIFIED [1][5] | All present (skills, `agents`, extensions, MCP, `plan`). VERIFIED [8][11] |
| Control protocol | `codex app-server` (JSON-RPC: `thread/start` takes `config`/`developerInstructions`/`cwd`; `turn/start`, `turn/steer`, `turn/interrupt`; approval and `requestUserInput` server requests). `codex --remote` attaches the terminal UI to it. VERIFIED [2][3][4]. Several terminal UIs sharing one server: INFERRED [12] | `--acp` (stdio, one client, no visible terminal UI). VERIFIED [8]; the limits: INFERRED |

Gemini availability: Gemini CLI stopped serving Google AI Pro/Ultra and free individual use on 2026-06-18; only paid API keys and enterprise licenses keep access. VERIFIED [13]. Google's Gemini CLI terms also name third-party use of its login as grounds for suspension [15]. Its successor, Antigravity CLI, is said to keep hooks, skills and subagents; ACP for it exists only as community adapters. INFERRED [14].

## Part 3 - assessment

**Codex workers (terminal UI + hooks)**
- Port through an adapter: the launch line; resume by id (learned from SessionStart); turn events; the dialog flag (PermissionRequest); the deny/context/block outputs; the 70% cap (Stop block); the supervisor's no-edit deny; context % from `PostModelRequest`.
- Need a different mechanism: worker hooks (one global hook entry that reads `ROLLCALL_TASK`, so a single hash is trusted once, since per-launch `--settings` has no Codex equal); trust (read from `config.toml`); transcript readers; the draft check and keys for Codex's input box; parking (Codex sends no `background_tasks`, so today's rule never parks a Codex worker); StopFailure (rebuild from `PostModelRequest` errors); questions (a needs-you state until `request_user_input` works in default mode).
- Cannot be matched: the status line command, the mods, and telling a subagent's tool calls apart.
- The cleanest route: the app-server backend. `turn/start` and `turn/steer` replace typed keys, receipts and screen reading; server requests replace the dialog flags and the question relay; `tokenUsage` replaces the status line. The owner still watches and types through `codex --remote` in the tmux window. This rewrites delivery and parking for that backend, and parts of the API are marked experimental.

**Codex as supervisor**: it runs, with gaps. The picker relay needs the under-development flag, the chips and the band's task line are lost (tabs survive through `drawTabs`), and news is still typed in, with a Codex-specific draft check. A GUI front end removes the status line and mods gaps; the question tool is OpenAI's to finish.

**Gemini CLI**: technically the closest match (fixed session id at launch, settings by env var, `ask_user` in default mode, approval modes that map onto Claude's). The blocker is account access, so a future target is Antigravity CLI, which needs its own audit.

**Seam**: `packages/rollcall/src/harness/{claude,codex}.mjs`, with the harness recorded on each task and session, in five parts:
1. process: the launch and resume command line, the mode, model and effort mapping (`writeLaunch`, `writeWindow`, `trusted`);
2. events: each harness's hook payload turned into one shape before `workerHook`/`runHook`, and each harness's output format written back;
3. transcript: `lastEntry`, `pending`, `promptAuthor`, `successorOf`, pictures;
4. screen: `draftIn` and the interrupt key;
5. transport: `tmux.type` today, app-server later, behind `delivery.flush` and `watch.deliver`.

The supervisor side (picker tool name, answer shape, status line) belongs in the same module, and the skill text needs neutral wording ("the question tool", "the trust prompt").

## Sources

1. https://learn.chatgpt.com/docs/hooks (https://developers.openai.com/codex/hooks redirects there)
2. https://learn.chatgpt.com/docs/cli/reference
3. https://learn.chatgpt.com/docs/app-server
4. https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/src/protocol/v2 (`item.rs`, `thread.rs`)
5. https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs
6. https://github.com/openai/codex/issues/17827
7. https://geminicli.com/docs/hooks/
8. https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts and `settings.ts`
9. https://geminicli.com/docs/hooks/reference/ and `packages/core/src/hooks/types.ts`
10. `packages/core/src/tools/ask-user.ts` and `packages/core/src/config/config.ts` in the gemini-cli repo
11. `packages/cli/src/config/settingsSchema.ts` in the gemini-cli repo
12. https://git.autonomic.zone/recipe-maintainers/agent-orchestrator/commit/f0c5c4b3cc073e397738ce431d516522d3991735.diff (third party)
13. https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ (2026-05-19)
14. https://www.antigravity.google/docs/cli/commands/resume
15. https://www.geminicli.com/docs/resources/tos-privacy
