# /pr-create reference: after the PR opens

Once the PR is open, `rollcall ship start` hands the rest to rollcall's scripts ([SKILL.md](../SKILL.md) Step 5): the lander watches the PR's checks, re-runs a red check's failed jobs once, joins the merge queue when the checks are green and no review thread is open (`--land`), lands it, and the after-merge runner watches what the merge started on GitHub (check runs, commit statuses, deployments) and then runs the manifest's `release.afterMerge` commands from merged main. No agent waits on any of it. `rollcall ship status` (in the worktree) shows where it is; `rollcall queue status` shows every ship in the repo.

A model hears only what needs one, as a `[rollcall] ship: <kind> - <text>` line: in a task, typed into its worker as a notice; in a session with no task, as the exit line of `rollcall ship wait` (run in the background). The text names what failed and the next step. Read this page when such a line comes, act on it, and start the ship again (`rollcall ship start --land`, or without `--land` for a PR-only ship): it watches the new head from there. Push nothing else while it is in line: a new head takes it back to having its checks watched.

## red: a check failed on the PR's own head

The line names the check, its link, and a file with the failing part of its log (it was already re-run once). Read that file, not the whole log. First ask whether it is this PR's: a test in code the diff does not touch, that is also red on the default branch's last run or on another open PR, is not. Then:

- Implementation bug: fix it.
- Test bug: `/update-tests` with the diagnosis.
- Flaky (a timing or infra error, a job that hit its timeout, passes on a re-read of the diff): it already had its one re-run; `gh run rerun <run-id> --failed` once more only when the log shows an infra failure, then `rollcall ship start --land`.
- Red on main too: stop and report it as the blocker with the failing test and the run (the fix is its own small PR, shipped first; this one then needs only `gh run rerun --failed` when the failing job reads the fixed code from main, or one merge of main).
- Setup, secret or infra: report it, don't guess.

A red check is never a reason to merge main in on its own: that re-runs every job to change nothing. Before pushing a fix, re-run the quick checks for it (and, when the fix touches files a `ci.prePush` entry's `when` matches, that entry's `command`, then attest right after the push) and reproduce the failing test locally when it's cheap to. Batch every fix into one push.

**Refused over billing** (jobs fail in seconds with no steps, and an annotation names billing or a spending limit): rollcall catches this itself, holds the PR's place and tells the owner once; no line comes. In a task you may see `rollcall task wait-for billing` in the record: nothing to do.

## review: open review threads

The checks are green, and the PR has open threads (people's and bot reviewers', the owner's from the phone too). `rollcall pr threads` lists them with their ids; a bot's repeat of a thread already answered or resolved is left out. Fix each one, or answer it: `rollcall pr reply <id> "<what changed, or why not>"`. Batch the fixes into one push (attest), then resolve each thread a pushed fix settled, and each bot thread your answer settled: `rollcall pr resolve <id>...` (or `reply --resolve`). A person's point you disagree with, or one that asks for more than this PR, stays open: answer it, and report it as the blocker; only the owner's word lands it as it is: `rollcall ship start --land --owner-ok "<their words>"`, which records their words on the task and covers exactly the threads open then. Claude Code's `/autofix-pr` is no stand-in: it hands the PR to a cloud session and resolves no thread.

## conflict, failed, left, parked: the merge queue sent it back

- `conflict`: the text names the files. `git fetch origin && git merge origin/<default>`, resolve with this change on top, re-run the quick checks for the files the merge touched in common with this diff, push once, attest (a refusal means the merge changed the code a `ci.prePush` suite covers, so that suite runs again first), then `rollcall ship start --land`.
- `failed`: a check failed on the tree the lander built for a train (a CI check counts as failed only after the lander re-ran it once); the text names it, links it, and says whether the lander merged `origin/<default>` into this branch first (then `git pull --ff-only` before anything else). Read the failure as for `red`, fix it, push, attest, then `rollcall ship start --land`. A pre-push suite that failed in the part this ship left to the train (the text says so) gets the entry's `command` before the push, so the fix is tested here and not first on the next train.
- `left`: the PR was closed, or carries a PR that left without landing; the text says which. A closed PR is a blocker: report it. Otherwise, once a carried PR has landed or joined again, `rollcall ship start --land`.
- `parked`: stop and report it, with the text, as the blocker: a third bounce, a fix that changed what its tests check (removed or skipped tests, edited workflows), a red check no entry's change explains, or a merge the lander could not do. That call is the owner's: never `rollcall queue leave` and start again to get past it.
- A line that the PR is stuck or moving again is news, not an end: nothing to do. A stuck line may name a command for the owner (`gh auth login`); pass it on, and push nothing.

If the ship stops after joining (a blocker, or the user calls it off), `rollcall queue leave "<why>"` takes the PR out.

## after-failed: the merge's deploys or a release command failed

The PR is on main. The text names what failed (a workflow on the merge commit, a deployment, or a release command and its log). Read the failure; a fix goes in a new PR from main, shipped the same way. A release command that failed for a reason outside the code (a sign-in, a store's outage) is reported, with the command to run again once it clears. Nothing after the failed step ran: the text lists what is left.

## release-step: a release step that is a skill

The deploys were green and the release commands before it ran; the text lists, in order, what is left from merged main: invoke each skill with its args (e.g. the project's iOS ship skill in `post-merge` mode, which uploads from merged main; external testers are the user's step) and run each command from the repo root on merged main. An entry that fails stops the rest; report it. Then save your report and set the task landed.

**Production is not a release step here.** When the manifest has `release.production`, the merge reached staging, and production moves only when the user says one of that entry's `words`, which runs its `skill` or `command` (the project's own production release). Never run it as part of "ship it", and never offer to in the middle of the ship: the report says it once. Steps that stay the user's (App Store submission, prod writes nobody named, compliance answers) are reported as their steps, never guessed at.

## shipped

The script finished: the PR landed, what the merge started was green, and the release commands ran. In a task, rollcall marks it landed and adds the script's line below the worker's report; nothing to do. In a session with no task, `ship wait` prints it: relay it to the user as the end of the ship (merge commit, deploys, release steps; with `release.production`, that production is unchanged and the word that releases it).

## Merges the script did not run

A merge someone ran by hand (`gh pr merge`) fires the post-merge `[deploy-watch]` hook, which starts the **deploy-watcher** agent; the ship script's own merges never do, since it watches them itself.
