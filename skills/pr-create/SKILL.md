---
name: pr-create
description: "The standard way changes ship: quality pass scaled to the diff, worklog entry, commit, PR, then rollcall's ship script watches CI and - on 'ship it' - lands it and runs the project's release steps (e.g. TestFlight from merged main), waking a model only when something fails. Use for every PR beyond super-simple changes. Trigger when: user says 'create a pr', 'ship it', 'done with this', 'feature complete', 'finalize this', 'open a pr', or '/pr-create'. Also PROACTIVELY suggest after finishing an implementation: 'Want me to run /pr-create?'"
argument-hint: <summary of what changed and why>
---

# PR Create

Ships the current change set as a PR with rigor proportional to the diff: the same quality gates every time, sized to the change. Every "spawn" below follows "Delegation" in the global instructions (Agent tool, or the Codex backend when configured).

This is the **ship phase** (global CLAUDE.md "Build phase vs ship phase"). It starts on the user's word - offer it in one line when an implementation lands, rather than launching it yourself. Once triggered, run every step below to completion in one pass: no progress check-ins, no "shall I continue". Stop only for a real blocker (a gate that fails and cannot be fixed) or a destructive action.

**The model's part ends at "PR open".** The judgment is here: scope and tier, quick checks, the review and what to do with its findings, docs, the worklog entry, the commit, the PR. Everything after it - the PR's checks, the merge queue, landing, the deploys the merge starts, the release steps - is `rollcall ship start`'s (Step 5): scripts that wake a model only when something fails or a release step needs a skill. Half of all shipper spend used to come after the PR opened, in a waiting agent re-reading the ship on every wake-up.

**How far it goes depends on the words.** "Ship it", "finalize", "done with this", "feature complete", or any ask to merge: the ship chain, `rollcall ship start --land` (lands it, then deploys and release steps). When the manifest has `release.production`, that chain ends on staging: production is a separate step with its own word, and this skill never takes it. "Create a PR", "open a PR", or a bare `/pr-create`: `rollcall ship start` without `--land` (CI watched, the PR stays open). Say which one you are running in the tier line.

**CI owns determinism, the session owns judgment.** Stacks with any `ci` value in `.claude/test-manifest.json` are never re-run locally; locally you run the checks that take seconds, the tests for what changed, the review, the docs gate, any UI check the change warrants, and what CI doesn't cover. Detail and the reasons: [references/checks.md](references/checks.md).

**Where it runs.** The ship runs in a fresh context (Step 0): the build phase leaves a session carrying hundreds of thousands of tokens that every turn of the ship would otherwise re-read. The session that did the build writes the brief and relays the result; a shipper agent does Steps 1-6.

**Waiting.** Everything a ship waits on announces its own end: a spawned agent hands back its report, a background Bash command exits. Start it in the background (long commands with `run_in_background: true`), then end your turn with one line naming what you wait for - no tool call - but only while something you started is still pending. A turn that ends without the Step 6 report is a pause, not the end of the run. Never wait on a timer (a fixed `sleep`, or a loop that sleeps to a deadline without checking anything). Each wake-up re-reads the whole ship, so spend none on narration.

**Stages.** As each stage starts, run `rollcall task stage here "<stage>"` with these words: `checks` (Step 2), `docs` (Step 3). The ship script sets `CI`, `merge queue`, `deploys` and `release` itself. It is one line outside a task too, where it does nothing. Nothing else needs timing by hand: `rollcall usage report` times each part of a ship from its transcripts (commands, review, docs, tests, UI).

## Step 0: Hand the ship to a fresh context

Skip this step and start at Step 1 when you are already the shipper (your prompt says so) or when `/pr-create` is the first task this session did.

1. **Write the brief** - everything the shipper needs that only this conversation knows:
   - repo root, the task worktree's absolute path, branch and base branch
   - the scope: "PR only" or "ship chain" (merge + release), with the user's own words
   - in a task's worktree (`rollcall task show here` prints a task: a supervisor's worker), the owner's words it prints, copied verbatim under their own heading: they are the acceptance criteria, kept apart from your description of the change
   - what changed and why, per area (backend / web / iOS / docs), including decisions made during the build and their reasons - the reviewer and the docs pass judge against this intent
   - what the build phase already verified (which fast suites, which targeted UI check, what was seen) so it isn't redone, and what was deliberately left unchecked
   - known risks, open questions, anything the user flagged; related issues (`Closes #N`), migrations, contract changes
2. **Spawn the shipper**: the Agent tool with `subagent_type: "general-purpose"` and `model` set to the manifest's `ship.model` (`jq -r '.ship.model // "opus"' .claude/test-manifest.json`; `"opus"` when absent) (never `fork`, which would copy the very context this step sheds; the `[role: shipper]` tag lets `rollcall usage report` count the run as the shipper). Prompt: "[role: shipper] You are the shipper. Read `~/.claude/kesselrunner/skills/pr-create/SKILL.md` and run it from Step 1 through Step 6 to completion, in one pass, for the change below. Spawn the named agents per the global Delegation rules; invoke `/update-docs`, `/frontend-test` and the project's ship skill through the Skill tool, or read their SKILL.md and follow it if that tool isn't available. Work only in the worktree named below. Your final message is the Step 6 report, verbatim." - then the brief. When the model is not `opus`, add: "You run on <model> in a trial. When the reviewer reports that its fixes changed logic, spawn code-reviewer once more on that delta before you commit: reading the delta yourself does not count. Stop and end with `STEP UP: <step> - <what failed and what you tried>` in place of the Step 6 report when a step fails twice the same way, or when a fix that changes logic is needed and no reviewer made it."
3. **End the turn.** The shipper reports once the PR is open and the ship script has it. Relay its Step 6 block to the user unchanged, plus anything it needs the user to decide. If it stopped on a blocker, that is the report - don't continue the ship in this session. A pause can reach you as a "finished" notification with no Step 6 report: that is not the end. Give the user at most one status line and end the turn again.

A question the shipper can't answer from the brief comes back in its report, never as a guess; answer it and re-spawn with the brief amended. A `STEP UP` report: spawn the shipper again with `model: "opus"`, `[role: shipper] [step-up]` in place of the first tag, and the brief plus that report; it carries on from the worktree as it stands, and its Step 6 report says it took over and at which step.

**After the report.** In a task, end the turn: a `[rollcall] ship:` notice comes into this session only when something needs a model ([references/after-pr.md](references/after-pr.md) says what to do with each), and rollcall marks the task landed when the ship script finishes. In a session with no task, start `rollcall ship wait` in the worktree as a background Bash call (`run_in_background: true`, `timeout` 3600000; exit 124 means nothing yet: start it again) and end the turn; its line is either the end of the ship (`shipped`, `green`) to relay, or news to act on per that reference.

## Step 1: Scope the change

```bash
git status && git diff --stat && git log --oneline -5
```

Confirm you're on a feature branch in a task worktree (global CLAUDE.md "Worktrees"; if the work somehow sits in the main checkout, move it into a worktree first). Combine the diff with the user's summary to build the change context. Check that main is green and see who else is landing (`rollcall queue status`) as [references/checks.md](references/checks.md) says, then pick the tier:

| Tier | When | Gates |
|------|------|-------|
| **Simple** | <=~30 lines, no logic risk (config, copy, docs, one-liner fix) | Quick checks -> commit -> PR |
| **Standard** | Everything else, whatever its size | Quick checks + one code-reviewer pass + local-only stacks -> commit -> PR |
| **Deep** | Security-adjacent (auth, permissions, payments, deleting or exporting user data, secrets), a migration that rewrites existing rows, or the user asks for a deep review | Standard + a second, independent review of the risky part itself |

Size alone never makes a change Deep. State the chosen tier and scope in one line before proceeding, naming any queued PR that touches this branch's files; the user can override.

## Step 2: Local quality loop

The rules for each part, and why: [references/checks.md](references/checks.md).

0. **Pre-push suites start first**: each `ci.prePush` entry whose `when` matches a changed file, its `ship` command (else `command`) in the background, collected before Step 4's push.
1. **Quick checks, always**, run directly: compile / type-check, plus the tests for what changed. A `tier: "fast"` stack with no `ci` field runs in full; one CI runs does not.
2. **Review (Standard/Deep): one pass.** Commit locally first, then spawn **code-reviewer** in the same message as the docs agent (Step 3). A second review only on a logic-changing fix's delta; Deep adds one read-only reviewer of the risky part.
3. **Local-only stacks (Standard/Deep)**: `tier: "full"` stacks with no `ci` field that the diff touches, through **test-runner** in local tier. None left: skip it and say why.
4. **UI verification, a judgment call**: `/frontend-test` or `/ios-sim` when the change warrants eyes on it (a new screen, a visual change, a shared surface); skip with a reason when CI's e2e covers it.

Fix what fails and re-run only what failed. The quick checks are green on the final code before the push. Do not proceed with known failures - report them instead.

## Step 3: Docs, worklog, memory

Same for every tier; detail in [references/docs.md](references/docs.md).

- **Docs**: run `npx -y @eeshkulk/docsic gate --json`. Nothing required or unowned and nothing your own read finds: no docs agent ("none required (gate)"). Otherwise `/update-docs` in gate mode with the summary and the gate JSON, beside the review; loop the gate until it exits 0, keeping the waiver lines for the PR body. Refresh README.md when the gate says it is due.
- **Worklog**: one entry file, `docs/worklog/<YYYY-MM>/<YYYY-MM-DD>-<branch with / as ->.json`, one JSON line, `"pr": 0` until Step 4 has the number.
- **Memory**: `docsic_save` when project state moved or a durable decision or gotcha surfaced, then any post-ship step your personal instructions define. Do it now: it does not wait on the merge.

## Step 4: Commit, push, PR

Stage specific files (never .env, credentials, or large binaries). Commit with a clear message ending in the standard co-author line; when Step 2 already made the local commit, stage the reviewer's fixes, the docs and the worklog and fold them in (`git commit --amend -m "<message>"`), so one commit is pushed. End the message with a `[skip ci]` line, a paragraph of its own: this first push's commit is replaced seconds later (the worklog number below), and that line keeps every workflow from starting a run for it (cancelled runs still bill a minute per started job: 83 of 85 cancelled PR runs in ten days on one project).

**Check for a conflict with main before the push.** `git fetch origin && git merge-tree --write-tree --name-only HEAD origin/<default>`: exit 0 means it merges cleanly, so push it as it is (main having moved is not a reason to merge it). Exit 1 lists the conflicted files: a PR that conflicts starts no checks at all. Then `git merge origin/<default>`, resolve with this change on top, re-run the quick checks for the files the merge touched in common with this diff, and push.

```bash
git push -u origin HEAD
gh pr create --title "<short title, <70 chars>" --body "$(cat <<'EOF'
## Summary
<1-3 bullets: what and why>

## Quality pass
- Review: {clean | N issues fixed | N issues fixed, fix delta re-reviewed | skipped (simple tier)}
- Local tests: {quick checks result; local-only stacks result | all full stacks CI-owned}
- CI: pending (rollcall watches it)
- UI: {PASS/WARN via /frontend-test or /ios-sim | skipped: <why> | not applicable}
- Docs: {updated: <files> | none required (gate)}

{one `Docs-skip: <doc> - <reason>` line per waived doc, or nothing}

## Test plan
- [ ] {feature-specific verification steps}

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

If the work resolves a GitHub issue, put `Closes #N` in the summary section. Keep the `- CI:` line as written: the ship script fills it in.

**Then the worklog number.** Put the PR's real number into the worklog entry file (`gh pr view --json number -q .number`; edit `"pr": 0` to it), amend it into the same commit and push again:

```bash
git add docs/worklog
git commit --amend -m "$(git log -1 --format=%B | sed '/^\[skip ci\]$/d')"   # the final message: the marker line gone
git push --force-with-lease
```

This push's run is the PR's first and only. `gh run list --branch <branch> --limit 10 --json headSha,workflowName` should show one run per workflow for the amended head and nothing for the first commit; a run for the first commit means the marker was not the HEAD commit's own line - fix the message and push again. `--force-with-lease` is safe on the branch this ship just created; never force-push a branch with someone else's commits. When auto mode denies the force push, push the number as a second commit instead (the lander squashes).

**Then attest.** Right after this push - and after every later push to the PR - run the `attest` command of each `ci.prePush` entry that ran in Step 2. It tells CI that this commit's code passed here, and CI's gate waits only seconds for it, so nothing goes between the push and the attest. When it refuses (the manifest's `ci.notes` give the exit code: the code under test changed since the run), run the entry's `command` again, then attest. When it fails any other way (no access to post), say so in the report and carry on: CI falls back to its own runner.

## Step 5: Hand the rest to the ship script

```bash
rollcall ship start --land     # ship chain; PR only: rollcall ship start
```

Run it from the worktree. It refuses a PR that is not open and pushed, a draft, or uncommitted work, and says what to fix. It does not need green checks: from here rollcall watches them, re-runs a red check's failed jobs once, joins the merge queue once they are green with no open review thread, lands it, watches what the merge starts, and runs the manifest's release commands from merged main. The user's "ship it" is the approval: they are the only human on their repos, and the required checks are the review gate. This skill never runs `gh pr merge`.

When the owner said to land it with review threads open: `rollcall ship start --land --owner-ok "<their words>"`.

## Step 6: Report

One compact block: tier and scope used (PR only, or ship chain), minutes from start to the open PR, PR URL, review / local-test / UI / docs outcomes, worklog and memory status, and one line that rollcall's ship script has it from here ("CI watched; lands once green" or "CI watched; the PR stays open"). If any gate was skipped, say which and why. Name any known-red check on main (Step 1). With `release.production` in the manifest, end with one line: the merge reaches staging, production is unchanged, and the word that releases it. The task worktree needs no cleanup step: once the PR merges and its session ends, `rollcall gc` removes it.

When the ship script later sends news (a red check, a review thread, a conflict, a failed deploy or release step, a release step that is a skill), whoever gets it follows [references/after-pr.md](references/after-pr.md).
