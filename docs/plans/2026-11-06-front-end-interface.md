---
status: done
date: 2026-11-06
decided-with-owner: 2026-11-06 (Conductor comparison: the terminal Falcon and a native desktop and phone front end are both first-class over the same rollcall state; front ends show each worker's real CLI in a terminal, with panels around it)
covers: "Plan D of the Conductor parity set: one versioned interface over rollcall that any front end uses, the terminal Falcon included: a snapshot, a stream of changes, every action, and terminal attach"
---

# Front-end interface: one way in for every front end

Part of the [Conductor parity set](2026-11-06-conductor-parity.md).

Today the Falcon is the only front end: the supervisor session reads rollcall's files and CLI, the watcher types news into its pane, and worker questions open in its picker. A native desktop app and a phone app are planned as a separate project. They show each worker's real CLI in an embedded terminal (no chat re-rendering, so every hook and native feature keeps working) and draw panels around it from rollcall's state: tasks, questions, diffs, checks, ports, usage. They need one complete, stable way in, and the terminal Falcon should use the same one, so neither front end can do something the other cannot.

## The owner's decisions (2026-11-06)

- The terminal Falcon and the apps are both first-class. Any action one can take, the other can.
- Front ends show real terminals, not a re-rendered chat. Panels come from rollcall's state and git.
- kesselrunner stays the open backend; the apps live elsewhere and depend only on this interface.

## What changes

**A snapshot**
- One JSON document with a schema version covering supervisors, tasks (state, harness, words, worktree, branch, PR and checks, ports and run actions, preview links, open questions and comments, last report, what needs the owner), live sessions, the merge queue, blockers and the usage meter.
- Plans A, B and C each add their state here as they land.

**Changes as a stream**
- A front end follows changes as they happen (a task's state, a question asked or answered, news, a PR or check change, a worker's turn ending) without polling every file.

**Every action**
- Start a task (words, repo, harness, model), tell a task, answer a question (the answer reaches the worker exactly as a pick in the Falcon's picker does), interrupt, close, move between supervisors, archive and restore, spotlight, run actions, send review comments, and the decisions the queue parks for the owner.
- The terminal Falcon takes these actions through the same interface.

**Terminal attach**
- For any worker or supervisor, a front end gets what it needs to attach its own terminal view to the live session (the tmux server, session and window today; whatever plan B's Codex route needs), including for a parked worker that comes back.

**Several front ends at once**
- A question can be answered from the Falcon or an app; the first answer wins and the other surface closes it.
- News and notifications reach every open front end once, without the owner getting the same alert twice.

**A written contract**
- The schema and actions are documented, with contract tests a front end can rely on. A breaking change bumps the version.

## Invariants

- rollcall stays daemonless and dependency-free. Nothing in kesselrunner runs as an always-on server; a front end that needs one (to reach a phone, say) runs its own on top of this interface.
- The hook hot path does not slow down to feed the stream.
- Works on Linux, though the planned apps are macOS and iOS.

## Docs to update

`packages/rollcall/README.md` (a section for front-end authors), `docs/architecture.md`, `docs/commands.md`.

## Done when

- A scripted test client, with the terminal Falcon open beside it, starts a task, sees the worker's question, answers it, sends the worker a message, attaches to its terminal, and watches the PR land, while the Falcon shows the same task, the same answered question and the same news.
- The contract tests run in CI.

## Risks

- Two front ends acting at once (both answering, both interrupting). Make actions safe to repeat and settle races in rollcall, not in each front end.
- The stream falling behind or missing changes while a front end sleeps. A front end can always start again from a fresh snapshot.
