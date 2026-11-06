---
status: active
date: 2026-11-06
decided-with-owner: 2026-11-06 (Conductor comparison: close the gaps where Conductor's workspaces did more than kesselrunner's task worktrees; terminal and GUI both first-class)
covers: "Plan A of the Conductor parity set: worktrees ready before the worker starts, a port block per task, run actions and preview links, spotlight, archive and restore, tasks from an issue, PR or branch"
---

# Worktree runtime: a task's worktree runs on its own

Part of the [Conductor parity set](2026-11-06-conductor-parity.md). Row numbers (1.18 and so on) point into the [inventory](2026-11-06-conductor-inventory.md).

Conductor treated a workspace as a running thing: files copied in, a setup script run before the agent's first message, ten ports of its own, named run actions with preview links, archive and restore. kesselrunner's task worktree is a bare `git worktree add` today, and the worker is told to finish setting it up. Two parallel UI tasks share the manifest's one dev-server port, and frontend-tester reuses whatever answers on it, so a browser check can pass against another task's code. That last one is a correctness bug, not a convenience.

## The owner's decisions (2026-11-06)

- Match Conductor's workspace runtime, learning from how it did each piece (inventory area 1).
- The terminal Falcon and the coming GUI are both first-class. Everything here works from the CLI and the supervisor, and every state it adds goes into [plan D's interface](2026-11-06-front-end-interface.md), so any front end can draw it.
- No machine throttles: two tasks never wait on each other for a port or a dev server. Isolation, not locks (this is why Conductor's `nonconcurrent` run mode is left out).

## What changes

**A worktree is ready before the worker's first turn** (1.14, 1.20, 1.22)
- Task creation copies the gitignored files the repo names in `.worktreeinclude` (Claude Code's own format, which Conductor also adopted) from the main checkout, then runs the manifest's `worktree.setup`, with its output in a log the worker and the owner can read.
- A failed setup is loud: the task shows it, the supervisor hears it once, and one command reruns it. The worker's brief says what already ran, so it never repeats it.
- Setup, teardown, run actions and the worker all get the task's identity in the environment: task id and name, worktree path, main checkout path, default branch, and the port base.

**A port block per task** (1.18, 1.25)
- Each task holds a block of consecutive ports for its life, recorded in rollcall's store, checked free when given out, and released when the task's worktree goes (gc, archive).
- The manifest can refer to the task's ports wherever it names one (`devServer`, the backend's start command, `baseUrl`), so a project opts in by editing its manifest. A project that doesn't keeps its fixed port and behaves as today.
- frontend-tester and test-runner use the task's own server and confirm it is serving that task's worktree before they trust a result.

**Run actions and preview links** (1.16, 1.25)
- The manifest names a project's run actions (dev server, backend, workers, storybook). A task can start, stop and list them, with output to a log per action and the whole process group stopped on archive or gc.
- Each running action that serves HTTP has a preview link built from the task's ports, shown in `task show` and plan D's interface.
- Run actions outlive a parked worker: parking frees the model session, not the app under test.

**Spotlight** (1.24)
- For stacks that can only run from one place (an iOS app with a fixed bundle, an OAuth callback registered on one URL, one heavy Docker stack), one task per repo at a time can be spotlit: its tracked changes are mirrored into the main checkout, and turning spotlight off puts the main checkout back exactly as it was.
- It is an owner or supervisor action, never an agent edit, so the main-checkout rule still holds for agents. It refuses while the main checkout has uncommitted work of its own.

**Archive and restore for unmerged work** (1.26, 1.28)
- Archiving a task stops its run actions, saves every uncommitted change (untracked files included, gitignored ones not) to a ref that is never pushed, frees the worktree folder and the port block, and keeps the task record and the worker's conversation.
- Restore brings the worktree back at its old path with that work in place and resumes the worker where it was.
- Before anything is removed, the owner sees what goes and how much disk it frees (the owner's standing rule for deletions). gc's handling of merged work stays as it is.

**Tasks from an issue, a PR or a branch** (1.5, 1.6, 1.7)
- A task can start from a GitHub issue (its title and body become the task's words, quoted as the issue's, and the PR closes it), from an open PR (the worker continues that PR's branch), or from an existing branch (checked out as is, nothing stacked on it).
- The supervisor recognizes an issue or PR reference in the owner's words and uses these.

## Invariants

- Agents still never edit a main checkout; spotlight is the only path that writes there, and only as an owner or supervisor action.
- rollcall stays daemonless. Long-running actions are ordinary process groups whose state rollcall reads when asked.
- Everything new is in rollcall's store and in `--json` output, and works on Linux.
- A project with no manifest changes behaves exactly as today.

## Docs to update

`docs/commands.md`, `docs/test-manifest.md` (the new manifest fields), `docs/architecture.md` ("How a worker starts"), `packages/rollcall/README.md`, the supervisor skill's brief, and the frontend-tester and test-runner agent files.

## Done when

- Two tasks on the same web app run their dev servers at once, and each task's browser check reaches its own server (shown by the tester's own check, not by luck).
- A new task's worker finds env files copied and setup finished before its first turn, and a broken setup shows up on the task within a minute with a one-command rerun.
- A spotlit task runs from the main checkout, and turning spotlight off leaves the main checkout byte-identical to before.
- An archived task frees its folder and ports, and restore brings back its uncommitted work and its conversation.
- A task started from an issue number ends in a PR that closes that issue.

## Risks

- Hardcoded ports outside the manifest (OAuth redirect URIs, CORS allowlists, mobile app configs). Spotlight is the escape hatch; the manifest docs should say how to spot them.
- Setup scripts that prompt for input or run long. Run them with no stdin and a visible log so a hang is obvious.
- Restoring a worktree whose branch moved on origin while archived. Restore must say so rather than silently rebase.
