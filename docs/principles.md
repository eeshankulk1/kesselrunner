# Principles

Why kesselrunner works the way it does. The instructions in `CLAUDE.md` hold the full rules; this page gives the reasons.

## One session per task, each in its own worktree

Two agents in one checkout step on each other's files, branches and stashes. So every change happens in a task worktree made from the default branch, and the main checkout stays clean for reading and pulling. rollcall enforces it: an edit in a main checkout, or in a checkout another live session owns, is denied with the `git worktree add` command to run instead. Merged worktrees are cleaned up on their own.

## You talk to one session

Watching five terminals is the work this removes. The supervisor, the Falcon, is the only session you type into: it starts a worker per task, puts their questions in one picker, and tells you plain facts (PR open, landed) without a model turn. It never edits code, so its context stays small and it can run all day.

## Build phase, then ship phase

Most asks come in a series: more features land on a branch before anything ships. So the build phase verifies in proportion: compile, unit tests, type-check, and one targeted look at a changed screen when tests cannot show it works. The full test matrix, the review, docs and the PR wait for the word "ship it". Then the whole pipeline runs to the end in one pass, with no check-ins unless a gate fails and cannot be fixed.

## CI owns determinism, the session owns judgment

A suite that gives the same answer every run belongs in CI, not in a session's context. Stacks marked `ci` in the test manifest never run locally; the session does what a script cannot: review, docs, visual checks, and reading failed CI logs. No model runs on a CI runner.

## The merge queue lands green PRs

Sessions do not race each other to main or merge main in ahead of time. A PR joins the queue once it is open, pushed and green. The lander, a script and never an agent, lands ready PRs in the order they became ready. A PR green on its own head that merges cleanly lands as it is; the rest go several at a time in trains, each tested as the tree that lands. Each session hears only its own news: landed, a conflict, a failed check.

## Memory is automatic

A new session should know where a project stands without being told. docsic loads each project's state and open notes at session start, and a background step rewrites the state when work finishes. Durable facts (a gotcha, a decision) get saved as notes and stay in front of sessions until they reach their permanent home in the docs.

## Docs ride every PR

A doc that falls behind the code misleads the next agent. Each doc names the files it owns, a gate maps a PR's changed files to the docs it must touch, and CI enforces it. A doc can be skipped only with a stated reason.

## Quality over saving tokens

Cheaper runs that make worse code are no saving. A change to the harness that trims context, effort or a handoff needs evidence that the output stays as good. Long-running workers hand off to a fresh session before their context fills, rather than keep going at lower quality.
