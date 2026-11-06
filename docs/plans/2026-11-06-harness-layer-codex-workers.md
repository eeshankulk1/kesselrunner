---
status: active
date: 2026-11-06
decided-with-owner: 2026-11-06 (Conductor comparison: workers on Claude Code and Codex with the same power; Gemini left out; the supervisor stays on Claude Code for now but movable; follow Conductor's lead on using subscriptions)
covers: "Plan B of the Conductor parity set: a harness adapter layer in rollcall, Codex as a full Falcon worker, a harness chosen per task, a usage meter across accounts"
---

# Harness layer and Codex workers

Part of the [Conductor parity set](2026-11-06-conductor-parity.md). The facts this plan rests on are in the [harness portability audit](2026-11-06-harness-portability-audit.md); row numbers (2.2 and so on) point into the [inventory](2026-11-06-conductor-inventory.md).

Conductor let each chat run on Claude Code or Codex (and Cursor, OpenCode), each signed in with the user's own plan. kesselrunner already projects its whole setup into Codex and runs its helper agents there, but a Falcon worker is always Claude Code: the supervisor's machinery reads Claude's hooks, status line, transcripts and prompt box. This plan puts that machinery behind a harness layer and makes Codex a full worker.

## The owner's decisions (2026-11-06)

- **Workers run on Claude Code or Codex, with the same power.** Every supervisor feature a Claude worker has, a Codex worker has, or this plan names what it lacks and why.
- **Gemini is left out for now.** Gemini CLI stopped serving Google AI Pro/Ultra and free individual accounts on 2026-06-18, and Google's terms name third-party use of its login as grounds for suspension. Antigravity CLI, its successor, can be audited later through the same layer.
- **The Falcon stays on Claude Code for now.** A Codex supervisor runs today only with gaps (no custom status line, no mods, a question tool still marked under development). The layer keeps the supervisor's harness-specific parts in the same place, so moving it later is a new adapter, not a redesign. The GUI plans remove the status line and mods gaps.
- **Subscriptions: follow Conductor's lead.** Using the owner's own Claude and ChatGPT logins the way Conductor did is fine; this is not a sold product today. Conductor ran Codex through a Codex SDK and partnered with OpenAI on Sign in with ChatGPT (changelog 0.89.0).
- **When one plan runs out**, the Falcon offers to move waiting or new tasks to the other harness. It never switches on its own.

## What changes

**A harness layer in rollcall**
- One module per harness behind a common shape, covering how a session starts and resumes, how its hook events read and are answered, how its transcript is read, how its input box and interrupt work, and how text reaches it. The audit's Part 3 sketches the seam; the implementing session owns the final shape.
- The Claude adapter is today's behavior moved behind the layer, with no change in what anyone sees. The existing supervisor tests pass unchanged.
- Each task and session records its harness.

**Codex as a full worker** (2.2, 2.6)
- A Codex worker starts in its task worktree and tmux tab with the task's model, effort and permission mode, and the owner can watch and type into its real terminal UI like any worker.
- Control goes through a protocol where one exists, not through reading the screen. The audit points at Codex's app server, with `codex --remote` showing the terminal UI; the implementing session confirms the current state of that API (parts are marked experimental) and picks the route.
- Every worker feature works for it: the first prompt and contract, `@tN` delivery with receipts, interrupt, questions reaching the Falcon's picker and picks going back, permission dialogs flagged, reports, screenshots, context handoff at the same bars, parking and resume, crash recovery, the rollcall guards and the owner's PreToolUse guards on its edits and shell commands.
- Where Codex has no equivalent yet (its question tool outside plan mode), the worker falls back to a loud needs-you state, and the gap is listed.

**A harness per task**
- The owner can name the harness in their words ("on codex"), a task can be moved to the other harness (the new worker gets the handoff a fresh worker gets today), and a default lives in settings.
- Model and effort names map per harness, so a task's model choice means something on both.

**A usage meter across accounts** (2.16, 2.17)
- rollcall knows each plan's remaining room before a turn fails: Claude's five-hour and weekly limits with reset times, Codex's rate limits, and tokens per task.
- Shown in `task list`, the status line chips, and [plan D's interface](2026-11-06-front-end-interface.md). The usage-limit blocker uses it to warn before the limit, not only after.

**Docs**
- `docs/codex-parity.md` is rewritten to today's truth: Codex hooks exist and are projected, `apply_patch` is matched, and what Codex workers and a Codex supervisor still lack.
- `docs/architecture.md`, `docs/commands.md`, `packages/rollcall/README.md`, the supervisor skill (harness-neutral wording such as "the question tool" and "the trust prompt").

## Invariants

- The Claude path loses nothing: same features, same tests, no new latency in the hook hot path.
- rollcall stays daemonless and dependency-free; a harness's long-running server process (such as Codex's app server) belongs to that worker, started and stopped with it.
- No harness gets the owner's credentials from kesselrunner: each signs in through its own CLI.

## Owner steps

- Codex CLI signed in with the ChatGPT plan.
- Trust the projected hooks once in Codex's `/hooks` (Codex pins hooks by hash).

## Done when

- A task started "on codex" goes from the owner's words to a merged PR through the merge queue, with its questions answered in the Falcon's picker, an `@tN` message delivered mid-task, a park and resume, and a handoff at the context bar.
- The owner's guards and rollcall's main-checkout and shared-checkout denials fire on the Codex worker's edits and shell commands.
- The usage meter shows both plans, and when Claude's limit is near, the Falcon offers to move a waiting task to Codex.
- `docs/codex-parity.md` matches what a Codex worker can and cannot do, with a reason for each gap.

## Risks

- Codex's app server and question tool change under it (both partly experimental). Keep the Codex adapter's assumptions in one place with a test that fails loudly when they break.
- Hook trust by hash: a hook command that changes on every sync would ask for trust every time. Keep the projected command stable.
- Transcript formats are private to each CLI and change without notice. Read only what the adapter needs, and fail soft.
