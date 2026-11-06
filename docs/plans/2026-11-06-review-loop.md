---
status: done
absorbed-into: docs/commands.md, docs/architecture.md, packages/rollcall/README.md
date: 2026-11-06
decided-with-owner: 2026-11-06 (Conductor comparison: match Conductor's review loop; terminal and GUI both first-class, so the mechanics land here and the GUI draws them)
covers: "Plan C of the Conductor parity set: line comments delivered to a running worker, PR review threads in the ship loop, per-turn snapshots and diffs that include shell changes"
---

# Review loop: precise feedback to a running worker

Part of the [Conductor parity set](2026-11-06-conductor-parity.md). Row numbers (3.2 and so on) point into the [inventory](2026-11-06-conductor-inventory.md).

In Conductor the owner read a workspace's diff, left comments on lines, and sent them all to the agent at once, before any PR existed. Review comments left on GitHub showed up beside the diff and could go to the agent too, and every turn left a private git ref, so a turn could be undone exactly. kesselrunner's only channel into a running worker is prose (`@t3 ...`), `/pr-create` watches checks but never review threads, and Claude Code's native `/rewind` misses files changed by shell commands, which auto-mode workers change a lot (codegen, formatters, migrations).

This plan builds the mechanics, usable from the terminal and exposed through [plan D's interface](2026-11-06-front-end-interface.md). The native app's diff viewer, a separate project, draws them later.

## The owner's decisions (2026-11-06)

- Match Conductor's review loop (inventory area 3), learning from how it did each piece.
- Terminal and GUI are both first-class: everything here works from the CLI and the supervisor, and goes into plan D's interface.

## What changes

**Line comments to a running worker** (3.1, 3.2)
- A task holds review comments: a file, a line or range, the text, and the diff hunk they were written against. The owner adds them from the terminal by file and line, through the supervisor in plain words, or later from the GUI.
- Comments go to the worker as one batch when the owner sends them (as Conductor's "send comments" did), each with enough context to act on without rereading the whole diff, and they arrive through the normal delivery path with receipts.
- The worker answers or resolves each one, and the task record shows what is open. A comment whose lines moved since it was written still finds its place, or says it went stale.
- Works for Claude and Codex workers alike: it rides delivery, not a harness feature.

**PR review threads in the ship loop** (3.3, 4.4)
- While a PR is open, the shipping worker reads its unresolved review threads (people and bot reviewers) along with its checks, fixes or answers each, and resolves the ones it fixed.
- A PR with unresolved threads does not join the merge queue without the owner's word, and a thread opened after it joined pulls it back to its worker.
- Where Claude Code's own `/autofix-pr` or GitHub's suggested changes already do part of this, use them rather than rebuild them.

**Per-turn snapshots and diffs** (3.8, 3.9)
- After each worker turn, rollcall records the worktree's full state (tracked and untracked files, gitignored ones left out) as a local ref, without touching the branch, the index or the stash.
- A task can show the diff of any one turn, the list of files each turn changed, and the change since any earlier turn.
- The owner or the worker can put the worktree back to a turn's state. Undo over confirm: the state being replaced is itself snapshotted first.
- Snapshots are pruned with the task's worktree.

## Invariants

- Snapshot refs never leave the machine. Some rollcall refs are pushed to origin today (`rollcall results`), so snapshots live in a namespace nothing pushes, and a test proves a push leaves them behind.
- A snapshot never changes what git shows the worker: same branch, same index, same stash list.
- The hook hot path stays fast: a snapshot is taken off the hook's critical path or is cheap enough not to slow a turn's end.
- If plan B's harness layer has landed, snapshots and comment delivery use it; if not, they are built so the Codex adapter only has to add its turn event.

## Docs to update

`docs/commands.md`, `packages/rollcall/README.md`, the `/pr-create` skill, the supervisor skill's worker contract (answering and resolving comments), and `docs/architecture.md`.

## Done when

- The owner leaves three comments on two files of a running task from the terminal; the worker receives them as one batch, fixes two and answers one, and the task shows all three resolved.
- A review comment left on GitHub from the phone reaches the shipping worker, gets fixed, and the thread resolves before the PR lands.
- A turn that ran a code generator shows those generated files in its per-turn diff, and putting the worktree back to the turn before removes them.
- `git push --mirror` to a scratch remote carries no snapshot refs.

## Risks

- Large worktrees (node_modules is gitignored, but generated assets may not be) make snapshots heavy. Measure on the biggest owner repo before settling the approach.
- Bot reviewers that comment on every push can loop a worker. Treat a bot's repeat of an already-answered thread as answered.
- Restoring a turn while the worker is mid-turn. Restore waits for the worker to be idle, or stops it first and says so.
