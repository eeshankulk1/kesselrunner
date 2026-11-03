---
name: ship-ios-build
description: "Generic verify -> deploy loop for native iOS projects: build against the local/dev backend, verify the changed flows in the simulator through /ios-sim (the ios-driver agent taps through them and returns screenshots, light + dark), run the project's canonical e2e, restore prod config, commit, gate on backend schema/config parity, then archive and upload to App Store Connect (internal testers get it; external beta only when the user asks for that build). Also runs in post-merge mode (upload from merged main) when /pr-create's ship chain calls it. Trigger when: user says 'ship a build', 'push to TestFlight', 'verify and deploy' in an iOS project. IMPORTANT: if the current project has its own ship skill (e.g. .claude/skills/ship-build/), invoke THAT instead - it parameterizes this procedure."
---

# Ship an iOS build (generic procedure)

The reusable verify -> deploy pipeline for a native iOS app with a backend.
Principle: verify visually like a real user before anything ships, and never
let prod config or prod schema drift from the build being uploaded. Split of
work: you do the judgment (visual verification, parity gate, report); when
the project has CI for it, CI does the deterministic parts (the canonical
e2e, archive + upload) - trigger and watch those runs instead of running them
locally.

## Project parameters (resolve these FIRST)

Projects parameterize this procedure with a thin project-level skill
(`.claude/skills/ship-build/SKILL.md` in the repo) that supplies:

| Parameter | Example |
|-----------|---------|
| Bundle id | `com.example.app` |
| Simulator facts | the manifest's `ios` block: build command, fixtures (launch arguments that render a screen without an account), sign-in, driving notes |
| Project generation | e.g. XcodeGen: regenerate after file add/remove |
| Local backend | how to start/reset it; seeded accounts and test data |
| Secrets swap | which file points the app at local vs prod, and how to swap WITHOUT printing secrets |
| Canonical e2e | the test target that must stay green (and its preconditions); whether CI runs it (manifest `ci`) and how to dispatch it for a branch |
| Schema gate | how migrations reach prod, and whether pushes need user approval |
| ASC upload | an upload workflow on a self-hosted Mac runner (preferred: `gh workflow run <file> -f ref=<branch>`), else API key id + issuer, ExportOptions plist, build numbering for a local archive |
| External beta | ASC app id + the external group name (e.g. `Public Beta`), used only when the user asks to submit a build (Phase 6b) |
| Report extras | anything the user always wants called out |

If no project ship skill exists: discover the parameters from the repo
(`docs/local-dev.md`, `docs/deployment.md`, CI config, `project.yml`,
fastlane files), confirm them with the user, and OFFER to write the
project's `.claude/skills/ship-build/SKILL.md` so the next ship is turnkey.

Environment invariants that commonly bite:
- `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` before
  xcodebuild/simctl when the standalone CLT are stale.
- Never print secret files (`cat` on env/xcconfig files, raw backend status
  dumps). Check which environment config points at by grepping for host
  substrings only.

## Post-merge mode

`/pr-create`'s ship chain invokes this skill (via the project's ship skill,
args `post-merge`) after it merged a PR that touched the app. The PR already
passed review, CI and any visual check, so:

- Skip Phases 1-4. Build from the release branch, never the feature branch:
  every build then carries every merged PR, so parallel ships can't drop each
  other's work.
- Phase 5: backend changes in the merged PR count as live once the
  deploy-watcher report for that merge is green and the change itself answers
  on prod (probe the new route or field). Client-only: say the gate is skipped.
- Phase 6 with `ref=<release branch>`, then Phase 7 (no Phase 6b: external testers are the user's step).

## Phase 1 - point the app at the local/dev backend

1. Back up the prod secrets/config file to the session scratchpad.
2. Write local values without echoing them (pipe from the backend CLI's env
   output through grep/cut into the config file).
3. Start/reset the local backend so the seed data is pristine.
4. Regenerate the project if the project uses generation and files changed.

## Phase 2 - verify like a user

Scale this phase to the change - a judgment call, not a checklist: a copy
tweak needs one screenshot, a new screen needs both appearances and its edge
states, a change to a shared component (tab bar, navigation, a core list)
earns a broader pass over the screens that render it.

1. Run `/ios-sim <what changed>` with the flows this build changes. It
   writes the brief and the **ios-driver** agent builds, installs, drives
   the app with taps and typing, and returns a report plus the few
   screenshots worth your eyes. Do not drive the simulator from here and do
   not write a throwaway XCUITest to look at a screen: that loop is a
   rebuild and a test run per look, in this context.
2. Phase 1 is this skill's half of the readiness /ios-sim asks for: the
   backend is up and seeded and the app points at it BEFORE the driver is
   spawned. A flow a fixture can show (a launch argument that renders seeded
   data with no account) needs neither - prefer it.
3. Look at every screenshot the report returns and judge it against the
   project's design system in both modes: no overlap, no clipping, correct
   tokens. The driver says what it saw; whether it looks right is yours.
4. The project's canonical e2e must stay green. If CI owns it, it runs on the
   PR (Phase 4) - dispatch any extra suites the change touches and watch
   them; don't re-run them locally. Otherwise run it here. If the flow
   legitimately changed (new tab, renamed button), update the e2e minimally
   rather than skipping it. A flow worth pinning for good becomes a test in
   that suite, not a one-off run.

## Phase 3 - clean up and document

1. Whatever Phase 2 left: a simulator kept for re-checks (`iosim delete`),
   a throwaway test the driver was allowed to write.
2. Reset the local backend seed so the next session starts pristine.
3. Update project docs for anything architectural; record strategic
   decisions where the project keeps them.

## Phase 4 - restore prod config, commit, push, and open a release PR

1. Restore the prod secrets/config backup and VERIFY by grepping for the
   prod host (and absence of the local host).
2. Commit on the project's working branch (never the release branch) with the
   standard co-author trailer. One commit per shipped concern.
3. Push the working branch to the remote (`git push -u origin <branch>`) so
   GitHub matches what's being shipped. If the remote has no such branch yet,
   this creates it; if the local branch is ahead by earlier commits, this
   catches them up too. VERIFY with `git status` reporting the branch
   up to date with its upstream (0 ahead). Skip only if the repo has no
   remote - and if so, say so in the report.
4. Open a release PR so the repo's release branch tracks each shipped build.
   The release branch is a project parameter (default `main`).
   - If the release branch doesn't exist yet, bootstrap it at the commit
     BEFORE this build's changes (so the first PR contains exactly what this
     build shipped), push it, and set it as the repo's default branch.
   - Open a PR from the working branch into the release branch
     (`gh pr create --base <release> --head <branch>`), titled for the build
     and versioned, with a body listing what shipped and how it was verified.
   - If an open PR from this working branch into the release branch already
     exists, the new commit lands on it automatically - just note its URL.
   - LEAVE THE PR OPEN for the user to review and merge (merging is what
     advances the release branch); do NOT auto-merge unless the user asks.
     A change that should merge and reach testers goes through `/pr-create`
     on "ship it" instead, which merges and then calls post-merge mode.
   - Report the PR URL. Skip only if the repo has no remote.

## Phase 5 - backend parity gate

- Schema/config the new build depends on must reach prod BEFORE the upload,
  or the shipped app breaks at runtime.
- Production pushes are user-gated: ask for approval (or give the user the
  exact command to run), then VERIFY the migration/config landed via a
  read-only listing before uploading.
- Purely client-side changes: state explicitly that the gate is skipped.

## Phase 6 - archive and upload

**With an upload workflow** (project parameter): trigger it on the pushed
ref and watch it:

```bash
gh workflow run <file> -f ref=<branch>
run_id=$(gh run list --workflow=<file> --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$run_id" --exit-status
```

`gh run watch` with no id picks interactively, which hangs non-interactively -
always resolve the id first (`gh run list` sorts newest-first; the dispatch
above is that newest run for the workflow). Run the watch as a background
Bash call (`run_in_background: true`, 45-minute timeout) and end the turn; the
default foreground 2-minute timeout kills it mid-run and costs a re-poll per
cut-off. The run records the ref, commit
and build number. Only archive locally (below) if the workflow is broken,
and say so in the report.
If the project ships builds but has no upload workflow, offer `/ci-setup`
once in the report (a self-hosted Mac runner keeps the signing key local
and costs no Actions minutes).

**Local archive**, with prod config verified:

```bash
xcodebuild -project <proj> -scheme <scheme> \
  -destination 'generic/platform=iOS' -archivePath build/<name>-bN.xcarchive archive \
  -allowProvisioningUpdates \
  -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8 \
  -authenticationKeyID <KEYID> -authenticationKeyIssuerID <ISSUER>

xcodebuild -exportArchive -archivePath build/<name>-bN.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/export-bN \
  -allowProvisioningUpdates \
  -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8 \
  -authenticationKeyID <KEYID> -authenticationKeyIssuerID <ISSUER>
```

Success = `Upload succeeded` + `** EXPORT SUCCEEDED **`. With
`manageAppVersionAndBuildNumber` in the export plist, ASC assigns the next
build number at upload.

## Phase 6b - external beta

The user's step: they pace what external testers get, so a ship stops at the
upload. When they ask for a specific build to go out (and the project names
an external group), tell them the build number and the group, and that the
step is theirs in App Store Connect (TestFlight -> the group -> add the
build, then submit it for beta review). Only the first build of a version
gets a full review; later builds of an approved version usually clear
without one. If another build of the app is still waiting for review, say
so: submitting now would not speed that review up. If the project's own
ship skill names a tool for this step, follow that skill instead.

## Phase 7 - report

Tell the user: what shipped and how it was verified, the ref + commit hash
and whether that commit is on the release branch yet (a build from an
unmerged branch gives testers code main doesn't have - say so plainly), the
assigned/expected build number (TestFlight processing ~5-15 min), the
external beta (ready for the user to submit, or held behind build M), any backend changes applied, and what to spot-check on a physical device -
especially behavior the simulator cannot prove (newer-OS-only UI, real
network conditions, permissions UX).

Then record the build in project state (`docsic_save`, kind `state`): one
line `TestFlight build N = <ref>@<short sha> (PR #a, #b; external: <outcome>)`,
replacing the previous build's line. That ledger is how the next session knows
which PRs testers have.

## Failure posture

- A failed flow or an ugly screenshot stops the line: fix, then re-check
  the failing flows (the same driver, continued, already knows the screens).
- Never upload with local secrets, never upload ahead of a required backend
  change, never leave throwaway tests or a dirty seed world behind.
