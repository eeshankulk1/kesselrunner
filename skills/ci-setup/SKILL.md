---
name: ci-setup
description: "Move a project's deterministic test suites out of the ship skills and into GitHub Actions, on a budget: Linux jobs path-filtered per stack, iOS on a self-hosted Mac runner, slow suites nightly, paid suites never automatic, and the manifest's `ci` fields written so /pr-create stops re-running them locally. Also tunes an existing CI that burns minutes. Trigger when: 'set up CI', 'move tests to CI', 'CI is too slow/expensive', '/ci-setup', or the user accepts /pr-create's graduation nudge."
argument-hint: "[audit] - audit only reports minutes and gaps, writes nothing"
---

# CI setup

Principle: **CI owns determinism, the local session owns judgment.** Anything a script can pass/fail (unit, type-check, build, DB tier, e2e with replayed models, simulator suites) belongs in CI, where it runs in parallel and nobody's context window babysits it. Review, docs, visual verification and failure diagnosis stay in `/pr-create` and the ship skills, on the user's subscription. Never put LLM calls on runners.

The shape this skill builds: `.github/workflows/check.yml` (Linux per PR, path-filtered), `ios.yml` (self-hosted Mac), `nightly.yml`, `testflight.yml` + a script that uploads (iOS), and a CI section in the project's testing doc. When one of the user's other repos already has this setup, read its workflows before writing new ones rather than starting from memory.

## Phase 1: Inventory

1. Read `.claude/test-manifest.json` (every stack, `tier`, commands, env setup) and any existing `.github/workflows/`.
2. Visibility and budget: `gh api repos/{owner}/{repo} -q .private`. Public repos: Actions is free, skip the budget math. Private repos draw on the owner's plan: Free 2,000 Linux min/month, Pro 3,000 (Pro also enables required checks on private repos). Overage is ~$0.006/min Linux; macOS-hosted bills 10x; self-hosted runners are free (GitHub's proposed self-hosted fee was postponed indefinitely as of 2026 - re-check if in doubt).
3. Existing CI: measure what it actually costs. Per-job billed minutes (rounded up per job) over recent runs:
   ```bash
   gh run list -L 50 --json databaseId,event,workflowName,conclusion
   gh run view <id> --json jobs -q '.jobs[] | [.name, ((.completedAt|fromdate)-(.startedAt|fromdate))] | @tsv'
   ```
   Look for: runs per merged PR (fix-loop pushes, cancelled runs from follow-up commits), a full re-run on push to main, jobs that run on every PR regardless of paths, scheduled jobs billing a minute each hour.

`audit` stops here: report minutes/day, the top three sinks, and which stacks run nowhere but the ship skill.

## Phase 2: Place every stack

| Stack kind | Where |
|---|---|
| fast tier (unit, type-check, lint, build) | GitHub-hosted Linux, every PR, path-filtered; also on push to main as the merge-skew guard |
| full tier that runs on Linux (DB tier, e2e with fixtures/replayed models, browser suites) | Linux, PRs only, path-filtered |
| iOS/macOS suites, TestFlight uploads | self-hosted Mac runner (the dev Mac); never macOS-hosted unless the user asks and accepts 10x minutes |
| slow suites (visual baselines, full e2e, persona suites needing a seeded backend) | nightly schedule, plus `workflow_dispatch` with a suite filter |
| anything that spends real money (live models, paid APIs) | never automatic: `workflow_dispatch` only, with a required budget input |

Registering a self-hosted Mac runner installs a launchd service on the user's machine: ask first, then use GitHub's documented commands (repo Settings -> Actions -> Runners -> New self-hosted runner). `svc.sh install` writes `SessionCreate: true` into the agent's plist, which cuts the runner off from the unlocked login keychain - simulator tests pass, but any codesign (archive, device build) fails with `errSecInternalComponent`. Set it false (`plutil -replace SessionCreate -bool false ~/Library/LaunchAgents/actions.runner.<...>.plist`) before `svc.sh start`, and again after any reinstall. Jobs on it queue while the Mac sleeps, so never make them required checks, and give anything that starts a local server its own port (a local agent's server on the default port would be silently reused).

## Phase 3: Write the workflows (budget defaults)

- A `changes` job (`dorny/paths-filter`) and a per-stack `if:` on its outputs. Skipped jobs cost nothing and still satisfy required checks.
- Skip what already passed: each test job checks for a pass of its stack's inputs (manifest `inputs`, `docs/test-manifest.md`) before running and records one after. Copy rollcall's results file into the project once (`cp ~/.claude/kesselrunner/packages/rollcall/src/results.mjs .github/rollcall-results.mjs`; it needs only node and git, and the copy computes the same key as `rollcall results` on any Mac), then give the job `permissions: contents: write` and three steps around its tests: `- id: passed` / `run: node .github/rollcall-results.mjs check <stack> --github-output`; the test steps with `if: steps.passed.outputs.passed != 'true'`; and, last, `node .github/rollcall-results.mjs record <stack>` under the same `if:`. Skip steps, not the job: the job still reports success, so the required check and branch protection stay as they are, and its log names the commit that passed. A pass is a ref (`refs/passed/<stack>/<hash>`) on origin, so a merge of main that left the stack's inputs alone, a re-run, the merge queue's train and a shipper's local run all find it. Re-copy the file when rollcall's `results.mjs` changes (a new key version just misses every old pass; it never matches a wrong one).
- `concurrency: { group: <wf>-${{ github.ref }}, cancel-in-progress: true }` on PR workflows; `false` for nightly runs and uploads.
- The self-hosted queue (one machine, one job at a time; the `ios.yml` above). When a suite on it is slow enough that open PRs wait on each other (say 20 minutes a run, 1-5 runs per PR), take it off the runner's critical path instead of tuning the queue: a manifest `ci.prePush` entry runs it on the shipper's machine and attests the pass (a commit status naming the tree that passed), the Linux gate job below accepts that status, and the runner stays as the fallback and for a run on the default branch after merges (a small attest script in the project, `docs/test-manifest.md`). For what stays on the runner:
  - Group per PR (`<wf>-${{ github.event.pull_request.number || github.ref }}`) with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`. With `false`, a run waiting for the runner holds the group, so the machine tests a commit that was replaced seconds later (/pr-create's worklog amend) in full before the real one.
  - A cancel must actually stop the work: `exec` the test script from the step so the runner's signal reaches it, have the script kill its build tool on INT/TERM (run it in the background and `wait`; bash defers a trap behind a foreground child), and have a run on the runner stop leftovers from an earlier one.
  - A Linux gate job in front of the self-hosted job: key = the tree hash of the paths under test at the commit being tested, looked up with `actions/cache/restore` (`lookup-only`), saved by a Linux job after a green run. A push that changes nothing under those paths (a merge of main, a docs amend) skips the queue instead of waiting in it.
  - A manual dispatch of the nightly suites does not repeat the PR job unless an input asks for it.
- Heavy jobs `if: github.event_name != 'push'`: a push to main re-runs only the fast jobs, and those only when the merge commit's tree differs from its second parent's (the `changes` job, checked out with `fetch-depth: 0`, compares `git rev-parse 'HEAD^{tree}'` with `'HEAD^2^{tree}'` and outputs `retest`; the `gate` job in `check.yml`). A merge whose tree is the PR head's holds exactly what the PR's required checks passed on - the merge queue's lander builds every PR or train on top of main before its checks run, so that is every merge it makes - and re-testing it is a billed minute per job for nothing.
- `timeout-minutes` on every job; dependency caches (`setup-python`/`setup-node` `cache:`); artifacts only `if: failure()` with short retention.
- Per-run databases/branches created and always deleted (`if: always()`), with an expiry as a backstop.
- Secrets via `secrets.*`, identifiers via `vars.*`, never echoed; signing keys stay on the self-hosted Mac.
- Set `defaults: run: shell: bash` on jobs with pipelines: only an explicit `shell: bash` runs with `-eo pipefail`; the implicit default is `bash -e`, so `script | tail -1` reports tail's success and a failed build passes. Capture output by assignment (`x="$(cmd)"`), never `echo "$(cmd)"`, which swallows the exit status either way.
- Prove every failure path once: a dry-run input (e.g. `upload=false`) that exercises the real build, and read the job log, not just its green check.

## Phase 4: Wire the harness to it

- Manifest: set `ci: "pr"` / `"nightly"` on each stack CI now runs, and write the top-level `ci` block (`workflows`, `watch`, `failedLogs`, `notes` - e.g. which checks can sit queued; and `prePush` when a slow runner suite is attested from the shipper's machine, with the attest refusal exit code in `notes`). Schema: `~/.claude/kesselrunner/docs/test-manifest.md`. This is what makes `/pr-create` stop running those stacks locally.
- Docs: a CI section in `docs/testing.md` or `docs/deployment.md` - what runs where, the minutes rules, required checks. Index it from `docs/architecture.md`.
- iOS projects that ship builds: an upload workflow on the Mac runner (the `testflight.yml` shape: dispatch with a `ref` input, a script that runs by hand too, a run summary naming ref + commit + "on main?" + build number) and the project's ship skill pointing at it.
- Docs gate: steps at the end of the `changes` job (one billed minute for the filter, the gate and the worklog check together, not one each; name the job `Docs gate` so it is the required check), checked out with `fetch-depth: 0`: `npx -y @eeshkulk/docsic@<version> gate --base "origin/$BASE_REF" --body-env PR_BODY` with the body read live (`gh pr view <n> --json body -q .body`, exported, never interpolated into the script) so a waiver added later needs a re-run of the job (which re-runs the suites with it), not a `pull_request: edited` trigger - a body edit was a billed minute, and /pr-create edits the body on every ship; plus a step checking the worklog gained an entry with this PR's number (a new file under `docs/worklog/`; a line in an older `docs/worklog.jsonl` also counts). The suites depend on the job with `!cancelled()` in their `if:`, so a red gate still runs them (one round of feedback) and a gate re-run never stands in for suites that did not run. Needs `owns:` frontmatter on the docs first (draft the globs and backtest them - `docs/project-docs.md`); the gate's `ignore`/`owns` config goes in `docs/gate.json`, never in `docs/docsic.json` (that file marks a full `docsic init` and turns on docsic's Stop gate).
- Required checks (private repos need Pro): the PR job names, never self-hosted ones. Give the user the `gh api -X PUT .../branches/main/protection` command or apply it with their OK.

## Phase 5: Verify

YAML parses (`python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" <file>`; `actionlint` if installed). The workflows only prove themselves on a real run: ship them through `/pr-create`, whose Step 5 watches the new checks, then report per-job minutes from that run and the expected minutes per merged PR before vs after.
