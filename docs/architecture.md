# Architecture

kesselrunner is a Claude Code setup in one repo: global instructions, skills, agents, hooks, mods and two packages, installed with one line and kept in sync at every session start. Start here; every doc is linked below.

## The parts

| Part | What it does | Where |
|---|---|---|
| Instructions | The rules every session follows: worktrees, build phase and ship phase, docs, delegation | `CLAUDE.md`, applied into `~/.claude/CLAUDE.md` |
| Supervisor (the Falcon) | One session you talk to (on Claude Code); a worker per task in its own worktree and tmux tab, on Claude Code or Codex | `skills/supervisor/`, `scripts/supervisor/`, `falcon` in `packages/rollcall/` |
| rollcall | Sessions aware of each other, task records, the merge queue, worktree cleanup, machine trouble, away mode (a worker's permission prompts held while the owner is out), the harness layer that runs a worker on either agent CLI, and the usage meter | `packages/rollcall/` ([README](../packages/rollcall/README.md)) |
| Front-end interface | One versioned way in for every front end (the Falcon's actions, native apps, scripts): a snapshot, a stream of changes, every action, the reads a screen needs (diffs, turns, review comments, PR timeline, logs, repo items) so an app never runs git or gh itself, terminal attach, as `rollcall api` | `packages/rollcall/src/api*.mjs` ([API.md](../packages/rollcall/API.md)) |
| Ship chain | `/pr-create` and the skills and agents it calls: checks, review, docs, PR, CI watch, landing, release steps | `skills/`, `agents/` |
| Memory | Project state and notes, loaded into each session | [docsic](https://github.com/eeshankulk1/docsic), installed and wired up by sync |
| Codex bridge | The same setup in OpenAI Codex, Codex workers for the Falcon, and the helper agents on a Codex plan | `scripts/codex-bridge/`, `packages/rollcall/src/harness/` and `src/codex/`, `scripts/delegate/` ([codex-parity.md](codex-parity.md)) |
| Overlay | Your personal layer on top of the core | a folder of yours ([overlay.md](overlay.md)) |

Why it is built this way: [principles.md](principles.md). Everything you type: [commands.md](commands.md).

## Repo layout

| Path | Purpose |
|---|---|
| `CLAUDE.md` | Core global instructions |
| `settings.core.json` | Core settings: hooks, plugins, marketplaces, the status line (`rollcall statusline`). `{{KESSELRUNNER}}` and `{{DOCSIC}}` are filled in at sync (see [overlay.md](overlay.md#paths-inside-your-files)) |
| `.claude-plugin/marketplace.json` | Makes this repo the `kesselrunner` plugin marketplace: the mods in `mods/` by relative path, third-party mods pinned to a reviewed commit |
| `mods/` | `rollcall-band`, `pr-band`, `clickable`: one folder per mod (manifest, hooks module, state contract, tests) |
| `agents/` | code-reviewer, test-runner, test-updater, frontend-tester, ios-driver, docs-updater, deploy-watcher |
| `skills/` | `/pr-create`, `/ci-setup`, `/recap`, `/note`, `/frontend-test`, `/ios-sim`, `/update-docs`, `/update-tests`, `/ship-ios-build`, `/supervisor` |
| `docs/` | These docs, plus the project docs standard, templates, the test-manifest schema, plans and the worklog |
| `bin/kesselrunner.mjs` | The install, sync, doctor, delegate and rules CLI (`bin/dotclaude.mjs` is the old name) |
| `lib/reconcile.mjs` | Install and sync: links, the `CLAUDE.md` block, settings merge, docsic, migrations, the malformed-settings guard |
| `lib/pull.mjs` | Fast-forwards the core clone; never resets or touches a dirty tree |
| `lib/guards.mjs` | Finds the PreToolUse guards in the core and the overlay and builds the hook's matcher |
| `lib/rules.mjs` | Optional rules: the files in `rules/` of the core and overlay, and which are on |
| `lib/agents.mjs` | Agent frontmatter parser and TOML escaper, shared by the Codex bridge and the delegation runner |
| `lib/delegate.mjs` | Delegation settings, Codex CLI discovery and status, the model catalog |
| `lib/legacy.mjs` | The names from before the rename, so old machines keep working |
| `lib/shell-scan.mjs` | The shell lexer guards read command lines with |
| `lib/hook-io.mjs` | A command hook's stdin and stdout, so each guard is a function `scripts/hooks/` calls and still a script of its own |
| `migrations/` | One-off per-machine steps `sync` runs once (see its README) |
| `scripts/hooks/` | The PreToolUse and PostToolUse entries: one node process per tool call runs the guards and rollcall before it, and deploy-watch and rollcall after it |
| `scripts/supervisor/` | `start.mjs`: starts a task's worker in a window of its supervisor's tmux session (below) |
| `scripts/codex-bridge/` | SessionStart: projects `~/.claude` into `~/.codex` |
| `scripts/delegate/` | Runs a named agent on Codex (`kesselrunner delegate codex`); SessionStart: announces the backend |
| `scripts/deploy-watch/` | PostToolUse: a successful `gh pr merge` triggers the deploy-watcher agent |
| `scripts/ios-sim/` | `iosim` (on PATH): drives an iOS simulator for the ios-driver agent: a compact accessibility listing, taps and typing through [AXe](https://github.com/cameroncooke/AXe), screenshots, throwaway simulators |
| `scripts/copy-helper/` | `kesselrunner Copy.app` (macOS): opens the `clickable` mod's copy links and copies the saved text; built and registered by `sync` |
| `packages/rollcall/` | Self-contained package (own README, tests, no dependencies): imports nothing from kesselrunner. `src/runtime.mjs` and `src/runtime-cli.mjs` are a checkout's runtime (port blocks, setup, run actions, `serving`), with its read-only facts in `src/checkout.mjs`, the only part the hooks load (a test keeps it so), `src/archive.mjs` archive, restore and spotlight. `src/needs.mjs` is the first-run check `falcon` makes for tmux, git, Claude Code and Node 20 (`gh` only warns); `package.json` publishes it as `rollcall` |
| `install.sh` | The one-line installer: clones the public repo over https with plain git (no `gh` needed) |
| `scripts/release.sh` | Bumps the version, updates `CHANGELOG.md`, tags, and prints the remaining steps; never pushes or publishes |
| `CHANGELOG.md`, `LICENSE` | Release notes and the MIT license (`packages/rollcall/LICENSE` for the package) |

### How a worker starts

`scripts/supervisor/start.mjs` starts a task's worker in a tmux window of its supervisor's session (`sv-<name>` on rollcall's own tmux server), in the task's worktree and the supervisor's permission mode. A Claude Code worker gets a session id fixed at launch and the hooks of a launch settings file; a Codex worker is set out below. Claude Code workers run on the task's model and effort, else the harness's (core `settings.core.json` merged with the overlay's `settings.json`), never what `/model` saved. The first prompt comes from the task record: your words verbatim, stamped in local time, plus the worker contract (report before every finish, screenshots for visible changes in the task's files folder, subagents hand back before 35% context, answer or resolve the owner's line comments, and, for the shipping worker, settle PR review threads); a discussion task has its own. `--fresh` replaces a worker that outgrew its session and hands the new one the notes and branch state. `--resume "<why>"` brings a stopped worker back in its window with its conversation; on a landed or closed task the worker answers with a `reply:` note, which the supervisor passes on. A worktree that gc removed is added again at its old path.

### Harnesses and the usage meter

Each task records the agent CLI its workers run on: `claude` or `codex` (`rollcall task new --harness`, else `ROLLCALL_WORKER_HARNESS` in settings `env`, else Claude Code), and `rollcall task move <id> --harness <h>` moves it, with a fresh worker on the other side. rollcall keeps one module per CLI behind one shape in `packages/rollcall/src/harness/` (launch, trust, words in, interrupt, transcript, models, the question tool's name); the Claude Code module is the old behavior, unchanged. A Codex worker is one process in the task's window (`rollcall codex-worker`, `src/codex/`): its own `codex app-server`, the task's thread, and Codex's own terminal UI attached to that server for you to watch and type into. Codex's protocol events stand in for Claude Code's hooks, and rollcall's words go in through the protocol rather than as keys. The supervisor itself stays on Claude Code. Details and gaps: [codex-parity.md](codex-parity.md#codex-as-a-falcon-worker).

The usage meter (`src/usage.mjs`, `~/.rollcall/usage-claude.json` and `usage-codex.json`) records how much of each plan's limits is used: Claude's from Claude Code's status line, Codex's from its app server. `rollcall usage`, `task list` and the supervisor's status line show it. When one plan nears its limit and the other has room, the supervisor asks you whether to move the tasks that wait on the full one; rollcall never moves one by itself.

Before that first prompt, `task new` has already made the worktree ready, so the worker starts in a checkout that runs. rollcall hands the checkout a block of 10 ports when the manifest uses `{port}`, then starts in the background the copy of the gitignored files `.worktreeinclude` names, then the manifest's `worktree.setup` (no stdin, a log, a 30-minute limit). The worker's launch script waits for it (`rollcall setup --wait`); a failure goes on the task and reaches the supervisor once. Setup, teardown, run actions and the worker share one environment (`ROLLCALL_WORKTREE`, `ROLLCALL_MAIN_CHECKOUT`, `ROLLCALL_DEFAULT_BRANCH`, `ROLLCALL_PORT`, `ROLLCALL_PORT_COUNT`, `ROLLCALL_TASK_ID`, `ROLLCALL_TASK_HOME`, `ROLLCALL_TASK_NAME`), and the brief says what already ran, not to run it again, and the worker's ports and run actions. A task can also start from an issue, an open PR or an existing branch (`task new --issue|--pr|--branch`); the brief then says its PR closes the issue, or that the worker pushes to the PR's branch. Details: [test-manifest.md](test-manifest.md) and the [rollcall README](../packages/rollcall/README.md).

### The review loop

Feedback reaches a running worker, or the PR, without prose. All three pieces live in `packages/rollcall/` and work from the terminal; details and syntax are in [rollcall's README](../packages/rollcall/README.md#review-loop).

- **Line comments.** `rollcall task comment` stores a comment on a file and line of a task's worktree; `task comments <id> send` delivers all pending ones as one item through the worker's outbox, and the worker resolves or replies to each. The supervisor adds and sends them for the owner (`skills/supervisor/SKILL.md`).
- **PR review threads.** `rollcall pr threads|reply|resolve` list and answer threads through `gh api graphql`. `queue add` refuses a PR with open threads (unless the owner says otherwise), and the lander pulls a PR back when a thread appears before the merge. `/pr-create` Steps 5 and 6 run this loop.
- **Turn snapshots.** Every turn in a linked worktree, a Claude Code worker's or a Codex worker's, is saved to a private repo under the rollcall home, outside the project's refs. `rollcall turns` lists, diffs and restores them, including changes made by shell commands.

## Mods

A [mod](https://code.claude.com/docs/en/plugins/mods/overview) is a plugin whose code runs inside Claude Code and can draw in it. This repo is a plugin marketplace named `kesselrunner`, and `settings.core.json` points Claude Code at the core checkout itself, so the mods in `mods/` load from that folder: there is no install step, and a change a sync pulls is live at the next session start (or `/reload-plugins`). Needs Claude Code 2.1.287 or later.

| Mod | Draws |
|---|---|
| `rollcall-band` | One line above the prompt: the session's repo, branch and checkout, its task if it is a worker, its claim, and the other live sessions in the repo, with one that waits on this session highlighted. In a supervisor it draws only the task each picker question is for, in the task's color, above the picker. `/attach t3` shows that task's worker: in place inside the Falcon, else in a new terminal tab (Warp, iTerm2, Terminal; elsewhere it prints the command); closing that tab leaves the worker running. It reads `rollcall status --json` every 15 seconds and after each turn, and draws nothing with nothing to show |
| `pr-band` | One line above the prompt for the PR the session is shipping. Open: checks passed, running, queued and failed by name, GitHub's verdict (`mergeable`, `conflicts with main`, `behind main`, `blocked`), and `main is red` when the default branch's last commit fails. Merged: what the merge started, each environment's deployment, and `production unchanged` in a project whose test manifest has `release.production` while no production deployment rides that commit. Toasts when checks settle, on the merge, and when the deploys finish |
| `clickable` | In the classic terminal view, a `[copy]` link under each code block in a reply, which copies the block's exact text without the line breaks a wrapped mouse copy picks up, plus `[open]` on a block that is only a URL or a path. In prose, URLs and existing paths become links that open whole even when the terminal wraps them. It changes only the drawing, never the stored reply |

`pr-band` knows nothing about `/pr-create`. Every fact is GitHub's, read with one `gh api graphql` call (every 20 seconds while something runs, every 2 minutes once settled, every 5 with no PR, and 2 seconds after a `git push` or a `gh pr` change in the session; a headless run polls nothing), so it follows a PR however it was made. It finds the PR by the branch of the session's folder or by the URL a `gh pr create` in the session printed, and keeps following it after the merge: for 30 minutes, and past that while something the merge started is still unsettled (3 hours at most). It only draws and toasts, so the ship's own CI watch and the deploy-watcher stay the only things the model hears from.

`clickable` works around one limit of the classic view: Claude Code never hears a click there, the terminal does, and a terminal can only open a link. So the copy link is `kesselrunner-copy://<id>`, the block's text is saved as `~/.claude/clickable/copy/<id>.txt` (deleted after 30 days), and a small macOS app, `kesselrunner Copy` (`scripts/copy-helper/`), opens that scheme, copies the file and shows a notification. `kesselrunner sync` builds it into `~/Library/Application Support/kesselrunner/` and registers the scheme, again whenever its sources change; `node scripts/copy-helper/install.mjs --force` rebuilds it by hand. On Linux the copy links draw but open nothing; `/copy` still lists each block.

To turn a mod off on one machine, set it to `false` under `enabledPlugins` in `~/.claude/settings.json` (your change sticks across syncs) or disable it in `/plugin`.

**Third-party mods.** A mod runs with your permissions and is not sandboxed. One is listed here only after its source was read, with its `source` pinned to that commit (`sha`), so nothing upstream reaches anyone until a PR moves the pin. Before listing one or moving a pin: clone it, run `claude plugin validate <dir>` (it lists the events the mod hooks and every call it makes), and read the module.

**Writing one.** Ask Claude for it: the built-in `plugin-authoring` skill writes the mod into a per-session folder that reloads while you iterate. To keep it, move the folder to `mods/<name>/`, list it in `.claude-plugin/marketplace.json` and enable it in `settings.core.json`. Keep its facts to what the machine can observe (a CLI's JSON, GitHub) rather than a skill's internal state, and its tests in `tests/*.test.ts` with whatever it shells out to faked beneath it.

## Doc index

| Doc | Covers |
|---|---|
| [architecture.md](architecture.md) | This page: the parts, repo layout, mods |
| [principles.md](principles.md) | Why it works the way it does |
| [commands.md](commands.md) | Every command and setting a person types |
| [overlay.md](overlay.md) | The personal layer, guards, optional rules, what sync changes in `~/.claude` |
| [codex-parity.md](codex-parity.md) | The Codex bridge, Codex workers for the Falcon (and what they lack), and running the helper agents on Codex |
| [../packages/rollcall/API.md](../packages/rollcall/API.md) | rollcall's front-end interface: the snapshot, stream, actions and attach a front end relies on |
| [project-docs.md](project-docs.md) | The docs standard the agents keep in each project repo |
| [test-manifest.md](test-manifest.md) | The `.claude/test-manifest.json` schema test tooling reads |
| [templates/](templates/) | Starting points for a project's docs |
| [assets/](assets/) | The README banner |
| [plans/](plans/) | Plans with a `status:`, one per piece of work |
| [worklog/](worklog/) and `worklog.jsonl` | One entry per shipped PR |
