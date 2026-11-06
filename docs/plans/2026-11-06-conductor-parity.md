---
status: active
date: 2026-11-06
decided-with-owner: 2026-11-06 (a full comparison of Conductor and kesselrunner; decisions below)
covers: "Index of the Conductor parity plans: why, the owner's decisions, what was learned from Conductor, the plans and their order, what was left out"
---

# Conductor parity: what kesselrunner takes from Conductor

[Conductor](https://www.conductor.build) was a Mac app for running several coding agents at once, each in its own worktree, with a polished GUI over Claude Code and Codex. On 2026-11-04 it announced it is joining Meta: new sign-ups and downloads stopped, its cloud shuts down on 2026-11-20, and the local app winds down in early 2027. It is still the best-documented product in this space, so this set of plans closes the gaps where it did more than kesselrunner, learning from how it did each piece.

References: the [capability inventory](2026-11-06-conductor-inventory.md) (175 Conductor capabilities mapped against kesselrunner and Claude Code) and the [harness portability audit](2026-11-06-harness-portability-audit.md).

## The owner's decisions (2026-11-06)

- **Match Conductor's capabilities** where they help someone running several agents at once.
- **Workers run on Claude Code or Codex, with the same power.** Gemini is left out: Gemini CLI stopped serving Google AI Pro/Ultra and free individual accounts on 2026-06-18, and Google's terms name third-party use of its login as grounds for suspension.
- **The Falcon stays on Claude Code for now**, built so it can move to another harness later without a redesign.
- **Subscriptions: follow Conductor's lead.** Signing in with the owner's own Claude and ChatGPT plans the way Conductor did is fine.
- **The terminal Falcon and a native GUI are both first-class.** The GUI is a separate project: a native macOS app (SwiftUI/AppKit with Ghostty's terminal engine) and a native iOS app for phone control. It shows each worker's real CLI in an embedded terminal, with panels around it. kesselrunner stays the open backend those apps use.
- **Off the Mac: phone control only.** Cloud workers and scheduled or webhook-triggered runs are left out.

## What Conductor taught

- **Worktrees that run on their own were the core of its value.** Users credited it with removing most of the friction of worktrees: files copied in, setup run before the first message, ten ports per workspace, run buttons, archive and restore. Plan A.
- **Driving agents through an SDK cost it repeatedly.** Its chats ran Claude Code through the Agent SDK with a pinned, bundled binary. Over the year that route broke `.mcp.json` loading, async subagents and interactive questions at different times, needed recurring memory-leak fixes, and drew complaints about lagging behind CLI fixes. kesselrunner's front ends show the real CLI instead (plan D).
- **Its terminal was rewritten three times** (WebGL, a rewrite, xterm's DOM renderer to stop a crash, then a Ghostty-based renderer), and its web view needed keyboard fixes (dead keys, shortcuts firing in the terminal, zoom). For a GUI whose center is the terminal, that weighed toward a native app with Ghostty's engine.
- **Review was precise.** Line comments on a workspace's diff went to the agent as a batch before any PR existed, GitHub review comments came back beside the diff, and a private ref per turn made any turn undoable. Plan C.
- **Orchestration lived only in its cloud**, and closes with it. kesselrunner's supervisor, rollcall awareness and merge queue already go further, locally (inventory list (a)).
- **It dropped things too**: todos blocking merges (removed in 0.73.1), per-turn cost display (0.39.0), CLI orchestration of local workspaces (0.90.0). None of these are planned here.

## The plans

One session each. A, B, C and D can run side by side; each adds its state to D's interface as it lands, whichever lands first.

| Plan | Covers |
|---|---|
| A. [Worktree runtime](2026-11-06-worktree-runtime.md) | Worktrees ready before the worker starts, a port block per task, run actions and preview links, spotlight, archive and restore, tasks from an issue, PR or branch |
| B. [Harness layer and Codex workers](2026-11-06-harness-layer-codex-workers.md) | A harness adapter layer in rollcall, Codex as a full Falcon worker, a harness per task, a usage meter across accounts, `codex-parity.md` brought up to date |
| C. [Review loop](2026-11-06-review-loop.md) | Line comments delivered to a running worker, PR review threads in the ship loop, per-turn snapshots and diffs that include shell changes |
| D. [Front-end interface](2026-11-06-front-end-interface.md) | One versioned interface over rollcall for every front end, the terminal Falcon included: snapshot, stream of changes, every action, terminal attach |

The native Mac and iOS apps have their own plans in their own project and start once D lands.

## Left out on purpose

- Linear integration (the owner's queue is GitHub Issues), Cursor and OpenCode harnesses, Gemini CLI (see above; Antigravity CLI can be audited later through plan B's layer).
- Cloud workers, scheduled and webhook-triggered runs, multiplayer, Conductor's hosted API and MCP server.
- Monorepo sparse checkouts, draft PRs, choosing a PR's target branch, merge-blocking todos.
- A run mode that stops other tasks' dev servers (`nonconcurrent`): per-task ports remove the need, and the owner's rule is no machine throttles.
