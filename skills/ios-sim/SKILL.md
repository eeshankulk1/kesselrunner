---
name: ios-sim
description: "Look at or drive an iOS app in the simulator: verify a changed screen or flow the way a user would meet it, reproduce a UI bug, find your way through an unfamiliar flow, or capture screenshots. This skill does the thinking (what to check, the app, simulator and launch state, a complete brief) and spawns the ios-driver agent (Sonnet), which taps, types and screenshots with `iosim` - build logs, UI listings and intermediate screenshots stay out of the main context; a report and a few screenshots come back. Use it whenever iOS UI code changed and compiling plus unit tests cannot show it works (the build phase's one targeted check; the ship phase's visual verification, from /pr-create and the iOS ship skills), and whenever you are about to run `xcrun simctl` or `xcodebuild test` just to see a screen, or to write a throwaway XCUITest to look at one. Trigger when: user says 'check it in the simulator', 'test this on iOS', 'does it work in the app', 'screenshot the app', 'reproduce this in the sim', '/ios-sim'. NOT for running a project's unit or XCUITest suites (test-runner, or CI) and NOT for uploading builds (the ship skill)."
argument-hint: <what changed, or what to look at - screens, flows, the bug>
---

# iOS Sim

Checks an iOS app in the simulator the way a user meets it. This skill does the thinking (scope, facts, readiness, the brief); the **ios-driver agent** does the driving and returns only a report and a few screenshots, so build output, UI listings and every intermediate screenshot stay out of this context.

Division of work with the rest of the setup:

| Need | Tool |
|---|---|
| See or drive a screen: a changed flow, a bug, a screenshot | this skill |
| The project's unit / XCUITest suites | test-runner, or CI when the manifest says `ci` |
| A build for testers | the project's ship skill (`/ship-ios-build`) |
| What a simulator cannot prove (push delivery, camera, real network, performance, newer-OS-only UI) | say so in the report; it is a device check on a TestFlight build |

## Phase 1: Scope the flows

From the argument and `git diff --name-only` (plus `git status --short`), work out which screens the change reaches (a changed view -> that screen; a changed component -> grep where it is used; a changed model or API call -> the screens that show it) and write the check as numbered flows. Each flow is: a start state, the steps a user takes, and the result to expect, in words someone who has never seen the app can check ("the Settings screen opens, titled Settings", not "settings works"). Name what tells the new screen from the one it covers (its title, an id only it has) and, where a fixture seeds data, what data should be there ("the thread opens on the seeded conversation 'Inbox and week check'", not "a thread opens") - otherwise the driver sets the pass bar itself.

Scale to the phase, and say in one line what you chose:

- **Build phase** (the one targeted check): the changed surface only - usually one flow, one appearance.
- **Ship phase**: a judgment call. A new screen earns both appearances and its empty and error states; a change to a shared component (tab bar, navigation, a core list) earns the screens that render it; a copy tweak earns one screenshot.
- **A bug or a question** ("why does the sheet not open"): mode `explore` - the goal and what is known, instead of fixed steps.

Nothing a simulator would show (a refactor, a background job): report "no simulator-visible change" and stop.

Collect the accessibility ids the flows touch while you are in the diff: grep the changed views for `.accessibilityIdentifier(` / `.accessibilityLabel(` and the project's UI tests for the same screens. An id in the brief saves the driver a discovery round per control. A label is only a target when it is unique on screen: where the same control also exists on a screen that stays underneath (a composer in the chat and in the thread pushed over it), say so.

## Phase 2: Facts (manifest-first)

Read the `ios` block of `.claude/test-manifest.json` (schema: kesselrunner docs/test-manifest.md): bundle id, build command, project generation, fixtures, sign-in, driving notes. Whatever is missing, find once and **write back before finishing**:

- **Bundle id, project, scheme**: `project.yml`, the `.xcodeproj`, the project's ship skill, `docs/ios.md`.
- **Fixtures**: launch arguments or environment that render a screen with seeded data and no account or backend (grep `ProcessInfo.processInfo.arguments`, `launchArguments` in the UI tests, `docs/ios.md`). The cheapest state there is: prefer a fixture to a signed-in session whenever one shows the changed surface.
- **Sign-in**: how a test user gets in (the UI tests' helper says), and which backend that needs.

## Phase 3: Readiness (stays here, not in the driver)

1. **Tool**: `iosim doctor`. Missing AXe -> `iosim install` (a pinned, checksum-verified download into `~/.local/share/kesselrunner/axe`; no brew, no sudo).
2. **Checkout**: the absolute path the driver builds from - the task worktree, with the change in it. Regenerating a generated project is a line in the brief, not something to do here.
3. **State the flows need**:
   - A fixture: nothing to prepare.
   - A backend: YOU start and seed the local one, point the app at it, and confirm it answers before spawning. Swapping config or secrets files is your job, never the driver's: do it without printing them, and restore them when the report is back. Test accounts and local or dev backends only, never production.
4. **Simulator**: default `throwaway` - the driver creates one and deletes it, so parallel sessions never share a device. For a fix-and-recheck loop say `Teardown: keep`, reuse the UDID the report returns, and delete it yourself at the end (`iosim delete --udid <UDID>`).
5. **Artifact dir** (absolute): `<repo>/.claude/artifacts/ios-sim/<ISO timestamp>/` when the repo ignores it (`git check-ignore -q .claude/artifacts/x`), else `$TMPDIR/ios-sim/<ISO timestamp>/` - screenshots must never sit in the checkout as untracked files a ship could commit.

A flow whose state you cannot provide (no fixture, no backend you can start, no test account) is not sent to the driver to improvise: drop it from the brief and list it as not verified, with why.

## Phase 4: Brief the driver

Spawn **ios-driver** with the Agent tool (`subagent_type: "ios-driver"`) on every delegation backend: it needs the simulator, which a Codex worker's sandbox cannot reach. It has seen none of this conversation, the diff or the repo's docs, so the brief is everything it knows. Fill every line; write `none` where there is nothing, never leave a line out:

```
Mode: verify | explore | capture
Goal: <what changed and why, in two or three sentences; what "working" looks like>
Repo: <absolute path of the checkout>
App: bundle id <id>; build: <exact command, with the simulator as `id=<UDID>`> | built app: <absolute .app path>; generate first: <command | none>
Simulator: throwaway (<device | any>) | reuse <UDID>; Teardown: delete | keep
Launch: <per flow: the arguments / environment> | sign in as <test account, how> against <backend URL, already running>
State: <permissions to grant, location, fresh sign-in, the data the screens should show | none>
Flows:
  1. <start state> -> <steps> -> expect <observable result>; appearance <light | dark | both>; screenshot <which moments>
  2. ...
Known ids: <accessibility ids / labels for the controls in the flows, and which labels are not unique | none known>
Evidence: return at most <N> screenshots: <which states>; artifact dir <absolute path>
Gotchas: <the manifest's ios.notes and anything in the repo CLAUDE.md that bites driving | none>
Out of scope: <screens and flows not to touch | none>
```

Ask for the screenshots you will actually look at - the end state of each flow, usually 1-3 - not every step. While it runs, continue other work; act when the report returns.

## Phase 5: Act on the report

- **Look at the screenshots under "Look at"** (the small copies; a full-size file only to inspect a detail) and judge them against the project's design system. The driver reports what it saw; whether it looks right is your call, and the reason those few images come back here.
- **PASS** -> relay one line and proceed. **WARN** -> show the user the specific items; their call. **FAIL / BLOCKED** -> nothing downstream proceeds (in /pr-create this re-enters the fix loop).
- **After a fix**, re-check only the failed flows: continue the same driver (SendMessage to it - it already knows the screens) when it is still available, otherwise a fresh spawn with the failed flows plus the ids its report listed.
- **Fold "Learned" into the manifest's `ios` block** now: new fixtures, ids worth knowing, driving quirks (`ios.notes`). The next brief starts from them.
- **Clean up** what this skill set up: a kept simulator, a swapped config, a backend you started.

## What this skill does NOT do

- Drive the simulator from the main context. No `iosim tap`, `xcrun simctl launch` or screenshot loop here - only `iosim doctor`, `iosim install` and `iosim delete`.
- Write a throwaway XCUITest to look at a screen. (The driver may, as a fallback, when the brief allows it for something taps cannot express.)
- Run test suites, or upload builds.
- Touch a production backend or a real account.
