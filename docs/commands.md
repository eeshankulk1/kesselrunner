# Commands

Everything you type, in one place. Agents run most of the `rollcall` commands themselves; the ones here are the ones a person reaches for. Every `kesselrunner` command also works as `node ~/.kesselrunner/bin/kesselrunner.mjs <command>`, and the old name `dotclaude` still works as an alias.

## Setup and sync

| Command | Does |
|---|---|
| `kesselrunner install [--overlay <dir>] [--force]` | First-time setup; run it again to change the [overlay](overlay.md). `--force` skips the "quit Claude first" check when converting an old symlinked `~/.claude` |
| `kesselrunner sync` | Pull the latest core now and apply it again |
| `kesselrunner doctor` | Report drift without changing anything. Issues: broken links, missing hooks, missing docsic, a core command (`kesselrunner`, `rollcall`) not linked onto PATH, an unusable delegation backend, a rule switched on that no longer exists. A missing git, Node 20 or Claude Code is an issue; a missing tmux or `gh`, or a dirty core checkout, is a warning. The `tools:` line summarizes them |
| `kesselrunner` | Print the command summary |

Sync is automatic: every session start runs `kesselrunner sync --quiet` (at most once per 15 minutes), which fast-forwards the core and applies it again. It prints one line only when something changed.

## falcon

| Command | Does |
|---|---|
| `falcon` | Open a new supervisor in this terminal tab, with a clickable tab per task at the bottom |
| `falcon continue` | Come back to the supervisor used last |
| `falcon resume [name]` | Pick a supervisor from a list (it marks parked ones and shows decision counts, and hides closed supervisors with nothing open that went unused 2+ days), or open that one |

Closing the terminal tab only detaches it: the supervisor and its workers keep running. Each supervisor is named for a Star Wars ship (the Falcon first, then the Venator, the Ghost and on down the list) and each task for a character (yoda, leia, luke, han, chewie, ...), so several supervisors can run side by side, each with its own tasks and ids.

Inside a supervisor:

| You type | Does |
|---|---|
| a plain request | Becomes a task: a worker starts in its own worktree and tmux tab. "Ship it" in the request lets the worker ship without asking again |
| `@t3 <text>` (or the task's name) | Typed into that task's worker word for word; it never reaches the supervisor |
| `@t3` alone | Every line after it goes to that task, until a line that is just `@` |
| a pick in the picker | A worker's question opens in the supervisor's picker, and your pick is typed back into the worker |
| `/attach t3` | Show that task's worker: in place inside the Falcon, else in a new terminal tab |

What the supervisor and its workers do on their own:

- Task chips sit in the status line (inside the Falcon the tab bar shows the tasks, and chips stay only for open tasks without a tab).
- A worker that runs long hands off to a fresh one: the worker judges it past 35% of its context, and rollcall makes it at 70%. The supervisor hands over to a fresh one past 35% of its own.
- A stopped worker resumes with its context. An idle worker whose task waits on a PR or on you parks after 15 minutes to free memory; your words, Enter in its tab or the supervisor's message bring it back.
- A falcon supervisor parks after a quiet hour with no terminal on it; Enter in its tab, `falcon continue` or its tasks' news bring it back, as a fresh session once its conversation grew big.
- Workers start the browser MCP servers only in repos with something a browser can test.
- A landed or closed task's window closes 10 minutes after its worker's last turn (the tab bar, chips and `rollcall task list` show the countdown). The worker can still come back with `--resume` or an `@name` message.

## Inside a Claude Code session

| Command | Does |
|---|---|
| `/supervisor [name]` | Make this session a supervisor (what `falcon` runs for you) |
| `/pr-create <summary>` | Ship: a quality pass sized to the diff (fast tests, review, a UI check when warranted, the docs gate), worklog, commit, push, PR, then a watch on the PR's CI. "Ship it" goes on through the merge queue and the release steps |
| `/ci-setup [audit]` | Move deterministic suites into GitHub Actions on a budget and mark them CI-owned in the test manifest |
| `/update-docs <what changed>` or `/update-docs sync` | Update docs for a change, or check every doc against recent commits |
| `/update-tests <what changed>` | Bring tests in line with implementation changes (the test-updater agent) |
| `/frontend-test <what changed>` | Check UI changes in a real browser |
| `/ios-sim <what changed>` | Check an iOS app in the simulator: the ios-driver agent taps through the changed flows and returns screenshots |
| `/ship-ios-build` | iOS verify, then a TestFlight upload (a project's own ship skill takes precedence) |
| `/recap <project> [window]` | What happened recently, from memory, worklog and git/PR history |
| `/note <project> <text>` | Save a discovery, gotcha, decision or idea for future sessions |

## rollcall

The commands a person types. The full list, and what each session sees, is in [rollcall's README](../packages/rollcall/README.md#cli).

| Command | Does |
|---|---|
| `rollcall status [--json] [--all]` | The other live sessions in this repo: branch, checkout, claim, edited files |
| `rollcall task list` / `rollcall task show <id>` | A supervisor's open tasks, or one task whole: your words, notes, worker sessions, last report |
| `rollcall queue status` | Who is landing now, and who touches your files |
| `rollcall allow-main [--off]` | Let agents edit this repo's main checkout, shared by every session (for example a notes repo that commits straight to main) |
| `rollcall allow-shared` | Let a session edit, and run checkout-changing git in, a checkout another session is using, on purpose |
| `rollcall gc [--dry-run] [--all]` | Remove merged, clean, unused task worktrees and their branches, running the manifest's `worktree.teardown` first. An open task's worktree, and a branch made in the last day with nothing committed yet, stay. It also sweeps what ended work left behind (DerivedData of gone projects, old session temp folders, orphan test browsers). Runs in the background at session start and end |
| `rollcall clean [--yes]` | A low disk's delete list, with sizes; nothing goes until `--yes` |
| `rollcall blockers [clear <kind>]` | What stops work on this machine or account now (usage limit, GitHub billing, disk, power, memory). You hear each once, work resumes by itself when the cause is gone, and `clear <kind>` says it is fixed |
| `rollcall remind "<text>" --in <2h>` | A line for you later, for a step only you can take |

The hooks keep agents in task worktrees: an edit in a repo's main checkout is denied with the `git worktree add` command to run instead (unless the repo ran `rollcall allow-main`), and a second session's edits and checkout-changing git commands (`checkout`, `reset`, `stash`, `commit`...) in a checkout another live session owns are denied the same way. While a task's PR is open or in the merge queue, rollcall holds `caffeinate -i` on AC power and tells you once if the Mac is on battery with a ship running.

| Variable | Does |
|---|---|
| `ROLLCALL_MAIN_EDITS=allow` | Lift the main-checkout rule everywhere |
| `ROLLCALL_GC=0` | Stop the background gc |
| `ROLLCALL_AWAKE=0` | Stop the `caffeinate` hold |
| `ROLLCALL_DISABLE=1` | Turn rollcall's hooks into no-ops (shell or settings `env`) |

## Running the helper agents on Codex

The named agents (code-reviewer, test-runner, test-updater, docs-updater, frontend-tester, deploy-watcher) normally run as Claude subagents. With a Codex plan, `kesselrunner delegate codex` runs them there instead: Claude Code keeps orchestrating, each worker runs as a non-interactive `codex exec` in the repo with the same instructions and returns the same report, and your Claude usage drops to the orchestration. ios-driver always stays on Claude: it needs the iOS simulator, which a Codex worker cannot reach. Needs a logged-in Codex CLI (the ChatGPT desktop app's bundled one is found; `npm i -g @openai/codex` also works). How it works and what Codex workers lack: [codex-parity.md](codex-parity.md).

| Command | Does |
|---|---|
| `kesselrunner delegate` | Show the current backend, and for codex the model and effort |
| `kesselrunner delegate codex` | Turn it on (checks the Codex CLI is installed and logged in) |
| `kesselrunner delegate codex --model <m> --effort <e>` | Pick the Codex model and reasoning effort; `default` for either goes back to Codex's own `config.toml` |
| `kesselrunner delegate models` | List the Codex models and efforts your plan offers |
| `kesselrunner delegate claude` | Turn it off: agents run as Claude subagents again (your model pick is kept for next time) |

Every change takes effect in the next Claude Code session.

## Optional rules

| Command | Does |
|---|---|
| `kesselrunner rules` | List the optional rules and whether each is on |
| `kesselrunner rules on <name>` | Switch a rule on: its text joins the managed block in `~/.claude/CLAUDE.md` |
| `kesselrunner rules off <name>` | Switch it off: the block goes back to what it was |

The core ships the mechanism; rules come from your overlay. How they work and how to write one: [overlay.md](overlay.md#optional-rules).

## Per-machine settings

Keys under `env` in `~/.claude/settings.json`.

| Key | Default | Does |
|---|---|---|
| `KESSELRUNNER_CODEX_SANDBOX` | `workspace-write` | Codex agents write only inside the repo, its git dir and existing build and cache dirs (Xcode DerivedData, CoreSimulator, XCTestDevices, simulator logs, package caches). The sandbox cannot drive the iOS simulator or reach Docker sockets; those suites run again on a Claude subagent. `danger-full-access` lifts the sandbox (simulator suites then run on Codex too), `read-only` forbids writes |
| `KESSELRUNNER_CODEX_ADD_DIRS` | none | Extra writable dirs for Codex agents, colon-separated |
| `KESSELRUNNER_CODEX_BIN` | auto | Path to the Codex CLI when it is not on PATH or in the ChatGPT app |
| `CODEX_CLI_PATH` | none | Another name for an explicit Codex CLI path |
| `KESSELRUNNER_DELEGATE_LOG_DIR` | `$TMPDIR/kesselrunner-delegate` | Where Codex agent logs stream (live) and final reports land |
| `KESSELRUNNER_SYNC_THROTTLE_MS` | 15 minutes | Least time between automatic session-start syncs |

`KESSELRUNNER_DELEGATE`, `KESSELRUNNER_CODEX_MODEL` and `KESSELRUNNER_CODEX_EFFORT` live there too, but `kesselrunner delegate` manages them, and `kesselrunner rules` manages `KESSELRUNNER_RULES`. `KESSELRUNNER_CODEX_BIN` and `KESSELRUNNER_CODEX_ADD_DIRS` are also read from the environment. Each key's name from before the rename (`DOTCLAUDE_*`) still works when the new one is absent, and sync moves the ones you set to the new name.

## Scripts it runs for you

| Command | Does |
|---|---|
| `node ~/.claude/kesselrunner/scripts/delegate/run.mjs <agent> --cwd <repo> < prompt.txt` | Run one named agent on Codex by hand and print its report. `--dry-run` shows the Codex command without running it, `--sandbox <mode>` overrides for one run, `--prompt-file <f>` instead of stdin |
| `node ~/.claude/kesselrunner/scripts/delegate/run.mjs status` | Which backend is set, and whether Codex is usable |
| `node ~/.claude/kesselrunner/scripts/codex-bridge/generate.mjs` | Project this setup into `~/.codex` again (runs at every session start) |
| `node ~/.claude/kesselrunner/scripts/supervisor/start.mjs <task>` | Start a task's worker (the supervisor runs it). `--fresh` replaces a worker that outgrew its session, `--resume "<why>"` brings a stopped one back with its conversation (also on a landed or closed task), `--session <id-prefix>` picks an earlier worker; `--dry-run`, `--stop`, `--interrupt` and `--home <name>` too |

## Developing kesselrunner

CI (`.github/workflows/check.yml`) runs every suite below except the mods on each PR that touches its paths, on hosted Linux. `/pr-create` watches those checks instead of running the suites locally (`.claude/test-manifest.json` marks them `ci: "pr"`).

| Command | Does |
|---|---|
| `bash test/sandbox.sh` | End-to-end install and sync in a throwaway HOME, with a fixture overlay rule and guard (needs network: installs docsic) |
| `bash test/delegate.sh` | Offline check of the Codex delegation (fake Codex binary) |
| `node --test test/rules.test.mjs` | `kesselrunner rules` in a throwaway HOME: on, off, the `CLAUDE.md` block before and after, an overlay rule winning over a core one, and what it refuses |
| `node --test test/hooks.test.mjs` | The per-event hook entries: fixture guards in a throwaway overlay (order, override, the matcher built from their tools), rollcall answering for edits, deploy-watch for merges |
| `node --test test/supervisor.test.mjs` | The supervisor on a real tmux server (private socket) with a fake `claude`: the start, `@t3` and picks typed in, resume after a kill or a lost tmux server, `--fresh`, the worker's questions, the watcher, the status line and notifications, a supervisor handing over (needs tmux; offline) |
| `node --test test/ios-sim.test.mjs` | iosim's accessibility listing, element matching, simulator naming and install's checksum refusal (no simulator needed) |
| `npm test --prefix packages/rollcall` | rollcall's suites on throwaway git repos, then its hook-latency bench |
| `claude plugin validate . && claude plugin test mods/<name>` | The marketplace file and a mod's hooks module as the engine reads them, then the mod's tests (rollcall and `gh` faked; no session, no login) |
