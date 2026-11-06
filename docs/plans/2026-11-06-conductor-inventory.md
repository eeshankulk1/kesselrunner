---
status: active
date: 2026-11-06
covers: "Reference for the Conductor parity plans: every Conductor capability mapped against kesselrunner and Claude Code"
---

# Conductor vs kesselrunner: capability inventory

Written 2026-11-06. Feeds implementation plans for closing gaps.

**Conductor today.** Conductor (conductor.build) joined Meta on 2026-11-04 (`0.93.0-conductor-is-joining-meta.md`). New sign-ups and downloads stopped; Cloud goes read-only on Nov 13 and shuts down Nov 20; the local Mac app gets new models and critical fixes until early 2027.

**kesselrunner.** The owner's open-source Claude Code harness (this repo, v0.1.0) plus the owner's private overlay. Claude Code on this Mac is 2.1.319.

## How to read this

**Sources.** Changelog entries are cited by file name; they are the entries at https://www.conductor.build/changelog. Where a row cites several, the version alone stands for the file (`0.80.0` means `0.80.0-stacks.md`; each version maps to one file). Docs pages are cited by a file name made from their path under https://www.conductor.build/docs (`docs_concepts_workflow.md` is `/docs/concepts/workflow`; an `x_` prefix marks the same), or as `llms-full:/docs/...` for pages found only in the site's `llms-full.txt`. Claude Code facts come from code.claude.com, checked 2026-11-06: the desktop and agent-view pages were read directly; checkpointing, worktrees, remote-control, routines, sessions, deep-links, code-review, statusline and model-config came through a research subagent.

**Status.**

| Status | Meaning |
|---|---|
| HAVE | kesselrunner core or the owner's overlay does it, maybe in another form |
| PARTIAL | kesselrunner does part of it, or only through an instruction to the agent rather than a mechanism |
| MISSING | neither kesselrunner nor Claude Code does it for this setup |
| NATIVE | NATIVE-IN-CLAUDE-CODE: Claude Code itself does it (CLI, desktop app, web or mobile) and kesselrunner adds nothing material. The note says when falcon workers (CLI sessions in tmux) cannot reach it |
| N/A | NOT-APPLICABLE: tied to Conductor's GUI shell, cloud, teams, or harnesses, with no value for a solo terminal setup |

**Paths.** kesselrunner paths are relative to its repo root. "rollcall README" is `packages/rollcall/README.md`. "The manifest" is a project's `.claude/test-manifest.json` (schema: `docs/test-manifest.md`). "Overlay" means the owner's private overlay folder (see `docs/overlay.md`).

UNCONFIRMED marks a claim the sources do not settle.

## Summary counts

| Area | HAVE | PARTIAL | MISSING | NATIVE | N/A | Rows |
|---|---|---|---|---|---|---|
| 1. Workspace and worktree lifecycle | 12 | 13 | 6 | 4 | 3 | 38 |
| 2. Agent harnesses and accounts | 10 | 4 | 2 | 10 | 4 | 30 |
| 3. Review and verification | 7 | 6 | 2 | 6 | 1 | 22 |
| 4. Shipping | 9 | 3 | 2 | 0 | 3 | 17 |
| 5. Orchestration and automation | 8 | 2 | 2 | 5 | 4 | 21 |
| 6. UX surface | 9 | 13 | 0 | 9 | 1 | 32 |
| 7. Config and settings | 7 | 0 | 1 | 4 | 3 | 15 |
| **Total** | **62** | **41** | **15** | **38** | **19** | **175** |

Three facts shape the reading:

- **Much of Conductor's GUI is native in Claude Code now**: Desktop has a per-session diff view with line comments that go to Claude, PR creation with CI status, Auto-fix and "Merge when ready", a terminal, a Browser pane and a file editor; `claude agents` (Agent View) and `claude --bg` give a CLI dashboard of background sessions. Falcon workers are CLI sessions in tmux, so these NATIVE rows do not reach them today.
- **Conductor's orchestration was cloud-only and is closing.** Its API, hosted MCP, routines and multiplayer ran on Conductor Cloud (shut down Nov 20), and `0.90.0` removed CLI orchestration from local workspaces. kesselrunner's supervisor, rollcall and merge queue already go further locally.
- **The real gaps cluster around the running app and review**: per-task ports, worktree preparation, line-level review, PR review comments, phone access, usage visibility.

---

## 1. Workspace and worktree lifecycle

| # | Conductor capability (source) | Status | Where in kesselrunner, or why missing | Gap note |
|---|---|---|---|---|
| 1.1 | Each workspace is its own git worktree and branch, under `~/conductor/workspaces/<repo>/<city>` (`docs_concepts_git-worktrees.md`; moved out of an in-repo `.conductor/` in `0.25.0`) | HAVE | `CLAUDE.md` "Worktrees"; `rollcall task new` makes `<repo>/.claude/worktrees/<slug>` on `<type>/<slug>`; rollcall PreToolUse denies edits in a main checkout (rollcall README "Worktrees only") | kesselrunner enforces isolation; Conductor only offered it |
| 1.2 | New workspace fetches `origin` and branches from `origin/<base>`, still succeeds if the pull fails, leaves the root checkout alone (`docs_concepts_workspaces-and-branches.md`, `0.23.2`, `0.25.7`) | HAVE | `CLAUDE.md` start command; `task new` uses origin's default branch, or `--base <ref\|task>` | - |
| 1.3 | Setup-script line to fast-forward the root checkout too (`docs_reference_scripts.md`) | N/A | The main checkout is read-only for agents by design; the owner pulls it | - |
| 1.4 | Create a workspace from a prompt: ⌘N Dispatcher with "create more", quick dispatcher, Alt+Enter to create without sending (`docs_concepts_parallel-agents.md`, `0.8.0`, `0.61.0`, `0.63.0`, `0.68.0`, `0.70.0`) | HAVE | Supervisor: a plain request becomes a task and a worker; several asks in one prompt become several tasks (`skills/supervisor/SKILL.md` "What the owner types") | - |
| 1.5 | Create from an existing branch (checks that branch out, no new branch on top), or duplicate a workspace (`docs_concepts_workspaces-and-branches.md`, `0.36.9`, `0.69.0`) | PARTIAL | `task new --base <ref\|task>` starts a new branch on top of one; `--worktree <dir>` takes over a worktree that exists; `CLAUDE.md` "Continue" covers an existing branch by hand | No flag that checks an existing branch out into a new task worktree |
| 1.6 | Create from a GitHub PR, contributor forks and merged PRs included, showing only that PR's diff (`0.10.1`, `0.15.2`, `0.33.4`, `0.54.0`, `0.77.0`, `0.78.0`) | PARTIAL | A worker can `gh pr checkout` in its worktree; Claude Code's `claude --from-pr <n>` resumes a session tied to a PR | No `task new --pr <n>` |
| 1.7 | Create from a GitHub issue: one click, issue picker in "Create from" (⌘I), issue as an attachment (`0.0.17`, `0.32.0`, `0.36.5`, `0.66.0`, `docs_guides_issue-to-pr.md`) | PARTIAL | Global `CLAUDE.md` "Work Tracking": `gh issue view`, confirm scope, `Closes #N`; the supervisor takes an issue only as the owner's typed words | No issue import into the task record, no picker, no "one task per issue" fan-out |
| 1.8 | Create from a Linear issue; paste a Linear link; Linear's "open in coding tool" deep link (`0.8.0`, `0.15.0`, `0.36.4`, `0.66.0`, `0.80.0`, `llms-full:/docs/reference/deep-links`) | MISSING | The owner's queue is GitHub Issues | Low value for this owner |
| 1.9 | Add a repo from disk, GitHub or any git URL (clone dialog, SSH/HTTPS hints); drag a folder in; Quick start a new repo; offer to create a remote; starter project (`0.2.0`, `0.3.0`, `0.24.0`, `0.50.0`, `0.67.0`, `0.74.0`, `llms-full:/docs/first-workspace`) | N/A | No repo registry: the supervisor picks a checkout under the owner's projects folder from the words; `gh repo create/clone` by a worker | - |
| 1.10 | Default branch detected and changeable per repo; change the base branch of a new workspace and remember it (`0.0.20`, `0.28.0`, `0.71.0`, `0.74.0`) | HAVE | Read from `origin` per command; `task new --base` picks another base | - |
| 1.11 | City name per workspace (295+ cities, capitals), Passport, workspace numbers (W-123) (`llms-full:/docs/reference/cities`, `docs_faq.md`, `0.28.2`, `0.74.0`, `0.85.0`) | HAVE | Another form: task ids (t1, t2) each with a Star Wars character name (t1 yoda); supervisors named for ships (rollcall README "Supervisors") | - |
| 1.12 | Branch named from the work: placeholder renamed by the agent on first message or in the background; prefix setting; keep names fixed (`docs_concepts_workspaces-and-branches.md`, `0.6.0`, `0.25.3`, `0.50.0`, `0.51.0`, `0.57.0`, `0.89.0`) | HAVE | Branch `<type>/<slug>` chosen at creation (`task new --type --slug`; `CLAUDE.md`) | Named before the agent starts, so no rename step |
| 1.13 | Rename a workspace (dialog, API); manual names stick (`0.54.0`, `0.75.0`, `docs_api.md`) | PARTIAL | `rollcall task set --title`; branch rename by hand | - |
| 1.14 | Setup script per new workspace: logs in the UI, rerun, stop, "ask AI to fix" on failure, stdin `/dev/null`, prompts can be sent while it runs (`docs_reference_scripts.md`, `0.0.20`, `0.31.0`, `0.32.1`, `0.45.0`, `0.54.0`, `0.72.0`) | PARTIAL | Manifest `worktree.setup` and `setupFlags`; `scripts/supervisor/start.mjs` (lines 169-179) tells the worker to run it first; the merge-queue lander runs it in its scratch tree | Setup is an agent step (tokens, wall time, no separate log), not run by `task new` before the session starts |
| 1.15 | Archive script runs before archive (`docs_reference_scripts.md`, `0.6.0`) | HAVE | Manifest `worktree.teardown`, run by `rollcall gc` inside the worktree before removal; a failure keeps the worktree | - |
| 1.16 | Run button with named actions (`scripts.run.<id>`: command, args, cwd, icon, default, hide, available_in); ⌘R; auto-run after setup (`scripts.auto_run_after_setup`); Run/Setup/Terminal tabs (`docs_reference_scripts.md`, `0.9.0`, `0.63.0`, `0.70.0`, `0.72.0`, `0.73.0`, `0.92.0`) | PARTIAL | Manifest `devServer.command` and `backend.startCommand` are commands agents run (frontend-tester, test-runner); the owner starts things in a tmux window | No owner-facing "run this task's app" |
| 1.17 | Run mode `concurrent` / `nonconcurrent` (starting an action stops the others); "exclusive port forwarding" for cloud (`docs_reference_scripts.md`, `0.85.0`) | MISSING | Nothing coordinates two worktrees' dev servers on one port or database | The owner's "no machine throttles" rule argues against a lock; port isolation (1.18) is the better fix |
| 1.18 | Ten ports per workspace: `CONDUCTOR_PORT` to `+9` (`docs_reference_environment-variables.md`, `0.25.12`) | MISSING | Manifest `devServer.port` is one fixed port; frontend-tester reuses whatever answers on it (`agents/frontend-tester.md` "1. Server") | Parallel UI tasks collide, and a browser check can pass against another worktree's server |
| 1.19 | Stop sends SIGTERM to the action's process group, SIGKILL after 5 s (`docs_reference_scripts.md`) | NATIVE | Background Bash tasks stop with TaskStop; rollcall's lander ends suite process groups | - |
| 1.20 | Workspace env vars `CONDUCTOR_WORKSPACE_NAME/PATH/ROOT_PATH/DEFAULT_BRANCH/IS_LOCAL/SESSION_ID`, workspace IDs (`docs_reference_environment-variables.md`, `0.29.2`, `0.63.0`, `0.74.0`) | PARTIAL | Workers get `ROLLCALL_TASK=<home>:<id>` (rollcall README "Environment") | Setup and teardown scripts get no root path, name or port |
| 1.21 | Custom repo env vars (`environment_variables`, `.local`, `.cloud`); paste a `KEY=VALUE` block; load vars from env files at user, repo and local scope (`docs_reference_environment-variables.md`, `0.22.4`, `0.64.0`, `0.71.0`) | NATIVE | `env` in `.claude/settings.json` / `settings.local.json` | Env files are not parsed into the agent's environment (UNCONFIRMED) |
| 1.22 | Files to copy / `.worktreeinclude`: only gitignored files, default `.env*`, `.worktreeinclude` wins (`docs_reference_files-to-copy.md`, `docs_reference_worktreeinclude.md`, `0.48.0`, `0.51.0`, `0.78.0`) | PARTIAL | Claude Code reads `.worktreeinclude` only for its own worktrees (`claude --worktree`, Desktop, `--bg`); kesselrunner makes worktrees with plain `git worktree add`, so copying falls to `worktree.setup` or the agent (`CLAUDE.md`: "copy the gitignored env files the task needs from the main checkout") | `task new` could honor `.worktreeinclude` with a `.env*` default |
| 1.23 | Login-shell env capture with a 5 s budget; zsh, fish, `ZDOTDIR`; direnv, mise, asdf per workspace (`llms-full:/docs/reference/shells`, `0.12.0`, `0.38.4`, `0.50.0`) | NATIVE | Claude Code's shell snapshot; workers start from a login shell (rollcall README "Workers in tmux") | UNCONFIRMED: direnv reloads per worktree in Claude Code |
| 1.24 | Spotlight testing: a workspace's tracked changes synced into the root checkout (a checkpoint commit, one way), one workspace at a time, per repo (`x_docs_reference_scripts_spotlight-testing.md`, `0.28.2`, `0.55.0`) | MISSING | rollcall keeps the main checkout read-only for agents | Useful for one heavy stack every task shares (Docker, one simulator); needs a deliberate exception to the main-checkout rule |
| 1.25 | Preview URLs (named, port offsets) behind an Open button; detected localhost URLs open in the browser; "View deployment(s)" (`docs_reference_settings_reference.md`, `0.9.1`, `0.35.3`, `0.63.0`, `0.70.0`, `0.83.0`) | MISSING | Manifest `devServer.baseUrl` serves agents only | Pairs with 1.18 |
| 1.26 | Archive any workspace by hand (⌘⇧A): stops its processes, saves uncommitted work as a commit, optional branch delete, force-archive running chats, undo toast (`docs_concepts_workflow.md`, `0.31.1`, `0.33.5`, `0.44.0`, `0.46.0`, `0.65.0`, `0.74.0`) | PARTIAL | `rollcall gc` removes merged, clean, unused worktrees and their branches at session start and end (`packages/rollcall/src/gc.mjs`); `rollcall task close` finishes a task | An unmerged or abandoned worktree stays for good (gc keeps it as "not merged"); no archive that saves WIP to a ref and frees the folder |
| 1.27 | Auto-archive when the PR merges, with an Unarchive toast (`0.21.0`, `0.38.4`, `0.49.0`, `git.archive_on_merge`) | HAVE | Background `rollcall gc`; a landed task's window closes 10 minutes after its worker's last turn | - |
| 1.28 | Restore an archived workspace with its chats from History or Home; read archived chats without restoring; "Clear & unarchive"; delete a broken one (`docs_concepts_workflow.md`, `0.23.3`, `0.28.0`, `0.35.3`, `0.46.0`, `0.72.0`, `0.83.0`) | PARTIAL | `start.mjs <t> --resume` adds a removed worktree back at its old path and resumes the conversation; finished task records stay 2 days (`task list --all`); `claude --resume` | Past 2 days only git history and transcripts remain |
| 1.29 | "Continue" after the PR merges: new branch in the same workspace, chats and ignored files kept, a note in the chat (`0.32.0`, `0.35.0`, `0.72.0`, `0.80.0`) | PARTIAL | A landed worker can come back with `--resume`; new work is a new task | One task is one PR by design |
| 1.30 | Fork a workspace or chat: changes to the fork point plus a summary, `.context` and model kept; fork mid-turn (`0.25.6`, `0.27.0`, `0.28.1`, `0.62.0`, `0.78.0`) | PARTIAL | Native `/branch` and `--fork-session` fork a conversation; `task new --base <task>` stacks on a task's branch | No "fork code and conversation into a new task" |
| 1.31 | Link other folders or workspaces with `/add-dir` and `@add directory`, linked-workspace chips (`x_docs_guides_repositories_linking-multiple-directories.md`, `0.25.6`, `0.34.2`, `0.44.0`, `0.62.0`) | NATIVE | `/add-dir`, `--add-dir`; `start.mjs` passes `--add-dir` for the task's files folder | A task names one repo; multi-repo tasks are done by hand |
| 1.32 | Monorepo "Set working directories" through git sparse checkout (`llms-full:/docs/guides/repositories/monorepos`, `0.28.1`) | MISSING | - | Low value for the owner's repos |
| 1.33 | `.context/` gitignored folder for notes, plans, diff comments, screenshots, attachments; a Notes tab (`docs_concepts_git-worktrees.md`, `0.27.0`, `0.28.0`, `0.28.1`, `0.62.0`, `docs_api.md`) | HAVE | Task record (owner's words, notes, handoff, report), task files folder `~/.rollcall/_supervisors/<name>/files/<id>/`, docsic notes, baton's `.baton/handoff.md` | Kept outside the worktree so gc and git never touch it |
| 1.34 | Deep links `conductor://prompt=&path=&branch=&linear_id=`; async-plan link (`llms-full:/docs/reference/deep-links`, `0.86.0`, `0.89.0`) | PARTIAL | Native `claude-cli://open?repo=&cwd=&q=` opens a session with the prompt filled but not sent | Nothing opens a falcon task from a link |
| 1.35 | The agent configures the project (setup script, actions, files to copy); bundled Conductor skill (`llms-full:/docs/configure-your-project`, `0.11.3`, `0.52.0`, `0.56.0`, `0.73.0`) | HAVE | test-runner discovers and writes the manifest; `/ci-setup` | - |
| 1.36 | Clear errors for "branch already checked out"; workspace error screen with retry (`docs_troubleshooting_issues.md`, `0.74.0`) | HAVE | rollcall deny messages carry the exact `git worktree add` command; a worker that fails to start is news for the supervisor | - |
| 1.37 | Clean workspace artifacts (`0.65.0`) | HAVE | `rollcall clean` (rebuildable folders, sizes shown, `--yes` to delete) and gc's leftovers sweep (DerivedData, temp folders, orphan browsers) | - |
| 1.38 | Custom workspace root folder; private workspaces; git falls back to HTTPS; GitHub Enterprise, LFS, SSH host aliases (`0.31.0`, `0.51.0`, `0.74.0`, `0.85.0`, `0.91.0`) | N/A | Fixed `<repo>/.claude/worktrees/` (Claude Code's own place); plain git and `gh` | - |

## 2. Agent harnesses and accounts

| # | Conductor capability (source) | Status | Where in kesselrunner, or why missing | Gap note |
|---|---|---|---|---|
| 2.1 | Claude Code through the Agent SDK, bundled binary or system `claude`, run with Bun (`llms-full:/docs/reference/harnesses/claude-code`, `docs_faq.md`, `0.48.0`) | HAVE | Workers are real interactive `claude` sessions in tmux (`scripts/supervisor/start.mjs`), with hooks, plugins and mods | Conductor fought SDK gaps (`.mcp.json` in `0.25.2`, async subagents, memory leaks); kesselrunner has none of them |
| 2.2 | Codex harness, bundled; CLI login, `CODEX_API_KEY`, Sign in with ChatGPT; plan and fast mode, checkpoints, personalities, goals, `/review` (`docs_reference_harnesses_codex.md`, `0.18.0`, `0.43.0`, `0.44.0`, `0.65.0`, `0.76.0`, `0.89.0`) | PARTIAL | The Codex bridge projects the setup into `~/.codex` and rollcall hooks run there (`docs/codex-parity.md`); `kesselrunner delegate codex` runs the helper agents on Codex (`scripts/delegate/`) | Falcon workers always launch `claude`; no per-task Codex worker |
| 2.3 | Cursor Agent through the Cursor API (Composer, Auto, Grok) (`llms-full:/docs/reference/harnesses/cursor`, `0.63.0`, `0.73.2`) | MISSING | - | Low value |
| 2.4 | OpenCode with OpenRouter, Baseten, Cerebras, AI Gateway keys (`llms-full:/docs/reference/harnesses/opencode`, `0.68.0`, `0.69.0`, `0.87.0`) | MISSING | Claude Code can reach compatible providers through `ANTHROPIC_BASE_URL` | Low value |
| 2.5 | Other CLI agents (Amp, Pi, Copilot, Gemini) through Big Terminal presets (`llms-full:/docs/reference/big-terminal-mode`, `0.22.4`, `0.48.0`, `0.86.0`) | N/A | Any CLI runs in a tmux window | - |
| 2.6 | One harness and model per chat tab; switching harness opens a new tab with a summary (`llms-full:/docs/reference/harnesses`, `0.28.4`, `0.36.2`) | PARTIAL | `task new --model --effort` per task (Claude models) | Harness fixed to Claude Code |
| 2.7 | "Auto" mode: Opus plans, Sonnet implements (`0.8.0`) | NATIVE | `opusplan` model alias | UNCONFIRMED in 2.1.319 |
| 2.8 | Claude auth: subscription, CLI login, API key mode, login button on 401, `setup-token` hint, auth source shown; keys in the macOS Keychain (`docs_guides_providers.md`, `0.10.3`, `0.27.0`, `0.38.5`, `0.51.0`, `0.69.0`, `0.72.0`) | NATIVE | `/login`, `/status`; rollcall opens an `authentication_failed` blocker (rollcall README "Usage limits") | - |
| 2.9 | Custom endpoints: Bedrock, Vertex, Foundry, OpenRouter, AI Gateway, GLM, HTTP proxy, `AWS_PROFILE` (`docs_guides_providers.md`, `0.1.1`, `0.2.0`, `0.13.6`, `0.39.0`, `0.62.0`) | NATIVE | Env vars in settings | Remote Control, cloud sessions and fast mode stop working on third-party providers |
| 2.10 | Model picker with search, number keys, favorites, default model, separate review model, provider model mapping (`0.19.0`, `0.36.2`, `0.71.0`, `0.85.0`, `0.87.5`) | NATIVE | `/model`, Option+P; `model` in settings (overlay: `opus[1m]`); per-task `--model`; agent frontmatter for helpers; `kesselrunner delegate codex --model` | - |
| 2.11 | Model "loadouts": a shared set of favorite models, one-click import (`0.85.0`, `0.86.0`) | N/A | One harness and a few models; `/model` aliases cover it | - |
| 2.12 | Thinking and effort levels, ⌥T, default and review effort, "Ultracode", change effort mid-chat without losing the cache (`docs_concepts_agent-modes.md`, `0.29.2`, `0.48.5`, `0.61.0`, `0.64.0`, `0.82.0`) | NATIVE | `/effort`, Option+T; overlay `effortLevel: high`; per-task `--effort` | "Ultracode" as Claude Code's workflow orchestration: UNCONFIRMED |
| 2.13 | Fast mode, default fast mode, fast-mode credit limits in the composer (`docs_concepts_agent-modes.md`, `0.40.1`, `0.55.0`, `0.85.0`) | NATIVE | `/fast` | - |
| 2.14 | Concise responses setting (`0.82.0`) | NATIVE | `/output-style` | - |
| 2.15 | Context meter, always visible, live during a turn, detailed breakdown (`0.28.0`, `0.33.0`, `0.50.0`, `0.55.0`) | HAVE | Claude Code shows context; rollcall `task list` and the tabs show each worker's context % and tokens; handoff at 35% (worker judges) and 70% (forced) | - |
| 2.16 | Usage and limits: when Claude becomes usable again; plan usage, account limits and reset times on hover; Codex rate limits with a near-limit warning (`0.9.2`, `0.44.0`, `0.86.0`, `0.92.0`, `0.93.0`) | PARTIAL | Native `/usage` and status-line `rate_limits` fields (five hour, seven day, reset time); rollcall reacts once a limit hits (usage blocker with the reset time, "paused until 2:20 PM", auto-resume) | No meter across all workers before a limit; `rollcall statusline` prints no rate limits |
| 2.17 | Cost and tokens per response, per workspace, to the cent (`0.24.0`, `0.25.7`, `0.80.0`, `0.85.0`; turn cost REMOVED in `0.39.0`) | PARTIAL | Native `/usage` per session; `task list` shows each worker's context tokens | No per-task or per-ship spend total |
| 2.18 | Retry on rate limits and capacity errors (Codex) (`0.84.0`, `0.89.0`, `0.91.0`) | HAVE | rollcall usage blocker: workers wait, restart 3 minutes past the reset (rollcall README "Usage limits") | - |
| 2.19 | Idle agent processes stopped to save memory (`0.38.3`, `0.51.0`) | HAVE | rollcall parking: idle workers after 15 minutes, a falcon supervisor after a quiet hour (rollcall README "Parking") | - |
| 2.20 | Bundled, pinned agent versions (`docs_faq.md`) | N/A | System `claude`; `kesselrunner doctor` checks the tools | - |
| 2.21 | Setup checks at launch: `gh auth`, Claude and Codex logins, onboarding (`docs_installation.md`, `0.25.9`) | HAVE | `falcon` first-run check (`packages/rollcall/src/needs.mjs`); `kesselrunner doctor` | - |
| 2.22 | Skills across harnesses; "Sync Agent Configs" copies skills, commands and MCP between Claude Code and Codex (`docs_concepts_agent-modes.md`, `0.57.0`, `0.62.0`) | HAVE | Codex bridge at every session start: `CLAUDE.md` to `AGENTS.md`, skills symlinked, agents to TOML, hooks projected (`docs/codex-parity.md`) | Only the Playwright MCP is projected |
| 2.23 | Custom subagents: create in settings, `@`-mention, project agents, async subagents and background tasks shown (`0.2.0`, `0.9.3`, `0.26.0`, `0.30.0`, `0.73.0`) | NATIVE | `/agents`; kesselrunner ships seven named agents (`agents/`) | - |
| 2.24 | Agent teams through an env flag (`docs_faq.md`) | NATIVE | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | Not turned on in core settings |
| 2.25 | MCP from each agent's own config; status in the composer and a dialog, refresh and re-auth; tool counts (`docs_reference_mcp.md`, `0.1.0`, `0.48.0`, `0.50.0`, `0.90.0`) | NATIVE | `/mcp`; workers start the browser MCP servers only where a repo needs them (`--browser`) | - |
| 2.26 | Executable path overrides (`docs_reference_settings_reference.md`, `0.51.0`, `0.68.0`) | N/A | `KESSELRUNNER_CLAUDE_BIN` exists for tests only | - |
| 2.27 | Compaction: threshold, "Compact and Continue", "Export to new chat" when out of context or after an error (`0.0.19`, `0.17.0`, `0.25.4`, `0.54.0`) | HAVE | Native `/compact`; rollcall worker handoff to a fresh session (`task handoff`, `start.mjs --fresh`); baton `/baton` | A handoff beats compaction for long tasks |
| 2.28 | Conductor's own agent tools: ask the user, read the workspace diff (`GetWorkspaceDiff`), read terminal output (`0.28.4`, `0.29.5`, `0.46.0`, `0.73.0`) | HAVE | rollcall CLI for workers (`task set --ask-json`, `task show here`, `inbox`) | - |
| 2.29 | `/restart` the agent process in a chat (`0.31.1`) | HAVE | `start.mjs <t> --resume`, `--fresh`, `--interrupt` | - |
| 2.30 | Conductor system-prompt additions: what a workspace is, default branch, `.context`, stay in the workspace, keep key facts in the final message, compare with `origin/main` (`0.2.2`, `0.28.2`, `0.44.0`, `0.49.0`) | HAVE | Core `CLAUDE.md` block; the worker contract in each first prompt (`start.mjs`) | - |

## 3. Review and verification

| # | Conductor capability (source) | Status | Where in kesselrunner, or why missing | Gap note |
|---|---|---|---|---|
| 3.1 | Diff viewer (⌘⇧D): file tree with line counts, unified and split views, by commit, uncommitted vs committed, target-branch choice, hide whitespace, image diffs, large files (`docs_reference_diff-viewer.md`, `0.3.0`, `0.14.1`, `0.36.0`, `0.54.0`, `0.62.0`, `0.66.0`, `0.80.0`) | NATIVE | Claude Code Desktop: a diff view per session, file by file (code.claude.com/docs/en/desktop) | Falcon workers are CLI sessions in tmux; the owner reviews on GitHub. UNCONFIRMED whether Desktop can open a CLI-started worker |
| 3.2 | Line and multi-line comments on the diff sent to the agent as attachments, before a PR exists; comments from the file editor (`docs_concepts_workflow.md`, `0.10.0`, `0.38.3`, `0.41.0`, `0.62.0`, `0.87.0`) | NATIVE | Desktop: "+" on a line, submit all comments at once | Out of reach for falcon workers; `@t3` takes prose only |
| 3.3 | GitHub PR review comments synced onto the diff (bot reviewers too: Bugbot, Greptile), suggested changes shown, resolvable; the PR view's Review row adds unresolved comments to the chat (`docs_reference_diff-viewer.md`, `0.25.4`, `0.29.0`, `0.44.0`, `0.87.0`, `0.89.0`) | MISSING | `/pr-create` watches checks, not review threads; pr-band reads no comments | Claude Code's `/autofix-pr` and Desktop Auto-fix answer review comments, but the ship chain uses neither |
| 3.4 | Review action (⌘⇧R): an agent reviews the diff with numbered issues, custom prompt, chosen reviewer model and thinking, edit before sending; Codex `/review` (`docs_guides_review-and-merge.md`, `0.22.0`, `0.22.6`, `0.29.1`, `0.38.0`, `0.71.0`, `0.76.0`) | HAVE | code-reviewer agent in `/pr-create` Step 2 (one pass; deeper for security changes); built-in `/code-review`; reviewer on Codex through `kesselrunner delegate codex --model` | No short command to review a running task's diff outside a ship (works only as words to its worker) |
| 3.5 | Claude leaves comments on your diff (`0.29.0`) | PARTIAL | `/code-review --comment` posts inline PR comments; code-reviewer fixes directly instead | - |
| 3.6 | Edit files in the diff (Pierre editor), built-in editor, discard a file's changes (`0.14.6`, `0.37.0`, `0.48.5`, `0.84.0`) | NATIVE | Desktop file pane (local sessions) | Not for tmux workers; the owner uses their own editor |
| 3.7 | Mark files viewed (⌃V), "Next comment", semantic diff preview (`0.29.1`, `0.54.0`, `0.58.0`, `0.62.0`) | N/A | No GUI review surface | - |
| 3.8 | Checkpoints: a private git ref per turn; "Reset chat" with "Also reset files"; Codex checkpoints (`docs_reference_checkpoints.md`, `0.19.0`, `0.44.0`, `0.80.0`) | NATIVE | `/rewind`, Esc Esc: code, chat or both | Claude Code tracks only edit-tool changes; files changed by Bash are not restored. Conductor's git-ref snapshot caught everything |
| 3.9 | Diff of the last turn or any single message; each turn lists its changed files; inline diffs of agent edits (`0.19.0`, `0.22.0`, `0.25.0`, `0.79.0`, `0.87.0`) | PARTIAL | rollcall records each session's edited files (`sessions/<id>.touched`); git history | No per-turn diff view |
| 3.10 | Todos: owner and agent todos; `@todos`; they blocked the merge until `0.73.1` dropped the block (`docs_reference_todos.md`, `0.28.4`, `0.32.0`, `0.33.0`, `0.73.0`) | PARTIAL | Native task list (Ctrl+T); rollcall decisions list and open questions (`task decisions`); the merge gate is green checks plus the docs gate | No owner checklist per task |
| 3.11 | Checks tab: git status, PR metadata, CI with run times, deployments, comments, todos (`docs_reference_checks.md`, `0.29.4`, `0.31.1`, `0.76.0`) | PARTIAL | pr-band mod: checks by name, mergeable / conflicts / behind / blocked, "main is red", deployments, toasts (`mods/pr-band/`); `rollcall queue status` | No comments or todos |
| 3.12 | Read GitHub Actions logs in-app, re-run failed checks, copy logs, GitHub's reason when a job fails to start (`0.33.2`, `0.34.2`, `0.84.0`) | HAVE | `/pr-create` Step 5 reads `gh run view --log-failed` and reruns a flake once; the lander reruns failed jobs once and reads billing annotations | Agent-side, no viewer |
| 3.13 | Forward failing checks to the agent; "Fix errors" (⌘⇧X) with an editable prompt (`0.12.0`, `0.29.4`, `0.44.0`) | HAVE | `/pr-create` Step 5 sorts each failure (implementation, test, flake, red on main, infra) and fixes; merge-queue `failed` news names the check and who to blame | - |
| 3.14 | Vercel and GitHub deployments per PR, preview deployment links (`0.25.7`, `0.29.2`, `0.54.0`, `0.76.0`) | HAVE | pr-band deployments per environment after merge; deploy-watcher agent; Vercel statuses arrive as checks | Preview link before merge not drawn (UNCONFIRMED) |
| 3.15 | Plan approval with feedback, copy a plan, plan handoff to a new session (`0.12.1`, `0.21.0`, `0.25.5`, `0.45.0`, `0.66.0`) | NATIVE | Plan mode; the supervisor's plan task then build task (`--after --base --until landed`) adds the cross-session part | - |
| 3.16 | Interactive planning: questions with notifications while it waits (`0.28.0`) | HAVE | AskUserQuestion is native; worker questions reach the supervisor's picker with notifications | - |
| 3.17 | Test from the workspace with actions or Spotlight (`llms-full:/docs/concepts/testing`) | PARTIAL | test-runner (manifest tiers), `/frontend-test`, `/ios-sim` | See 1.16 and 1.24 |
| 3.18 | Claude in Chrome to test changes (`0.30.0`, `0.51.0`) | NATIVE | `claude --chrome`; Playwright and Chrome DevTools plugins in the owner's settings | - |
| 3.19 | In-app browser preview with Agentation: click UI elements, leave notes, attach them to the composer (`0.62.0`, `0.63.0`) | MISSING | `/frontend-test` drives a headless browser and returns screenshots; Desktop's Browser pane shows the app | No way to point at a UI element and hand that note to a worker |
| 3.20 | Artifacts tab lists files the agent produced; agents embed screenshots in replies (`0.87.0`, `0.92.0`) | HAVE | Worker contract: screenshots for visible changes in the task's files folder; the supervisor passes reports on as links | - |
| 3.21 | Conflict UI: conflicted files first, accept buttons in the diff (`0.43.0`, `0.45.0`) | PARTIAL | The worker resolves (`git merge-tree` checks; Mergiraf in the lander) | No owner UI; by design the agent resolves |
| 3.22 | "Update memory" when addressing comments or after a merge (`0.29.0`, `0.32.0`) | HAVE | docsic distiller at task end; `/pr-create` Step 3 memory update; `/note` | - |

## 4. Shipping

| # | Conductor capability (source) | Status | Where in kesselrunner, or why missing | Gap note |
|---|---|---|---|---|
| 4.1 | Create PR (⌘⇧P): the agent drafts from the diff and the repo PR template; editable title and body; custom prompt (`docs_guides_issue-to-pr.md`, `0.18.4`, `0.22.4`, `0.34.1`) | HAVE | `/pr-create`: quality pass sized to the diff, worklog entry, docs gate, PR body template, CI watch (`skills/pr-create/SKILL.md`) | - |
| 4.2 | Draft PR option (`0.9.0`, `0.56.0`) | MISSING | `rollcall queue add` refuses drafts; `/pr-create` opens ready PRs | Low value solo |
| 4.3 | Commit and push (⌘⇧Y), pull (⌘⇧L), suggested next git action, open the PR on GitHub (⌘⇧G) (`0.3.0`, `0.8.1`, `0.18.0`, `0.36.9`, `0.68.0`) | HAVE | `/pr-create` Step 4; workers commit their own work | - |
| 4.4 | PR page: one timeline of status, checks, deployments, comments and commits; edit title and body; merge (`0.73.0`, `0.76.0`, `0.89.0`) | PARTIAL | pr-band line above the prompt; news lines link the PR; the owner reads GitHub | No comments in any kesselrunner view |
| 4.5 | Merge in-app (⌘⇧M) when green; only the workspace's code merges, blocked if the PR changed on GitHub (`docs_guides_review-and-merge.md`, `0.8.2`, `0.89.0`) | HAVE | "Ship it" joins the merge queue; the lander merges with `gh pr merge --match-head-commit` | - |
| 4.6 | Automerge once CI passes (`0.15.2`, `0.45.0`, `0.55.0`, `0.82.0`) | HAVE | The merge queue lands on green; `task new --ship` lets a worker ship without asking again | - |
| 4.7 | Treat optional checks as blocking (`0.62.0`, `0.71.0`) | HAVE | `rollcall queue add` needs every check green; the lander waits for no pending check and no `BLOCKED` | - |
| 4.8 | GitHub merge-queue status shown (`0.55.0`) | HAVE | Own merge queue: trains of up to 4 tested as one tree, blame, known flakes, bounce guard, `land.serial` groups, `rollcall queue status`; tabs show place and stage (`packages/rollcall/src/lander.mjs`) | Conductor only displayed GitHub's |
| 4.9 | Stacks: GitHub stacks through `gh stack` (switch PRs, stack readiness, stack merge, recovery when a lower PR merges) and Graphite stacks (`0.32.0`, `0.50.0`, `0.80.0`, `0.84.0`, `0.85.0`, `0.91.0`) | PARTIAL | `task new --after t4 --base t4 [--until landed]`; the queue holds a PR that carries another PR's commits behind it | No stack view, no gh-stack or Graphite; squash cascades handled by hand (owner memory "Stacked PR Squash Cascade") |
| 4.10 | Pick or change a PR's target branch (`0.28.3`, `0.28.7`, `0.38.3`) | MISSING | The queue lands only PRs aimed at the default branch | Low value |
| 4.11 | Resolve merge conflicts action with an editable prompt (`0.12.1`, `0.44.0`, `prompts.resolve_merge_conflicts`) | HAVE | "Main moved" notices (`git merge-tree`), pre-push conflict check (`/pr-create` Step 4), the lander's Mergiraf pass, `conflict` news with files and the next step | - |
| 4.12 | Sidebar GitHub status: PR number, review-waiting icon, pending checks, merged, failing CI, conflicts (`0.9.0`, `0.12.1`, `0.39.0`, `0.44.0`, `0.69.0`) | HAVE | Falcon tabs and status-line chips (state, stage, minutes against the usual); pr-band per session | - |
| 4.13 | Copy PR link or number, branch name; choose where PR links open; workspace link in PR descriptions (`0.18.4`, `0.31.3`, `0.83.0`, `0.84.0`) | PARTIAL | News lines and the task record carry the PR URL; the clickable mod makes it a link | - |
| 4.14 | Deploy status after merge (`0.25.7`, `0.29.2`) | HAVE | deploy-watcher; pr-band; manifest `release.afterMerge` and `release.production` | - |
| 4.15 | Approve a PR in one click (`0.83.0`) | N/A | Solo owner: no reviewers | - |
| 4.16 | Upstream set on first push (`git.worktree_push_auto_setup_remote`, `0.55.0`) | N/A | The agent runs `git push -u` | - |
| 4.17 | GitHub App with fine-grained access, `GH_TOKEN`, bundled `gh`, GitHub Enterprise (`0.0.21`, `0.10.5`, `0.22.4`, `0.25.12`) | N/A | Uses the owner's `gh` login | - |

## 5. Orchestration and automation

| # | Conductor capability (source) | Status | Where in kesselrunner, or why missing | Gap note |
|---|---|---|---|---|
| 5.1 | Many workspaces in parallel, each with its agents (`docs_concepts_parallel-agents.md`) | HAVE | Falcon / supervisor with one worker per task in tmux (`skills/supervisor/`, `scripts/supervisor/start.mjs`) | - |
| 5.2 | Several chat tabs in one workspace on one branch (implement, review, fix tests); up to 10 tabs; split tabs (`0.17.0`, `0.50.0`, `0.77.0`, `docs_concepts_parallel-agents.md`) | PARTIAL | rollcall blocks a second live session's edits in a checkout (`allow-shared` opts in); subagents and agent teams work inside one session | Deliberate |
| 5.3 | Agent-to-agent messages ("Send message" label) (`0.93.0`) | HAVE | `rollcall send / wait / done / claim`, `task tell`, `inbox`, `reply:` notes (rollcall README "CLI") | Claude Code also has native cross-session messaging |
| 5.4 | Message queue: several messages run in order, editable, reorderable, survives compaction (`0.1.0`, `0.38.3`, `0.54.0`, `0.85.0`) | NATIVE | Claude Code queues messages typed while it works | rollcall's delivery queue with receipts covers `@t3` and doorbells |
| 5.5 | Steering: a follow-up goes into the running turn or waits, per setting; ⌘⏎ does the other (`0.50.0`, `0.51.0`, `0.86.0`) | NATIVE | Queued messages reach Claude after the current tool calls; Ctrl+Enter sends the queue now | - |
| 5.6 | New chat with a summary of earlier chats; hand a plan to another chat or agent (`0.22.6`, `0.22.7`, `0.30.0`, `0.39.0`, `0.45.0`) | HAVE | `rollcall task handoff` plus `start.mjs --fresh`; baton | - |
| 5.7 | Background tasks and async subagents in chats, with a timer and stop (`0.25.8`, `0.29.5`, `0.77.0`, `0.78.0`) | NATIVE | Background Bash and subagents; workers in tmux run with no window open; `rollcall wait` and `queue wait` in the background | - |
| 5.8 | Dispatcher / quick dispatcher (`0.61.0`, `0.63.0`) | HAVE | The Falcon | - |
| 5.9 | Conductor CLI for agents: create workspaces, start chats, send follow-ups, monitor, list models, attach files; REMOVED for local workspaces in `0.90.0` (`0.80.0`, `0.90.0`, `docs_api.md`) | HAVE | Local and agent-facing: `rollcall task new / tell / list / show / set`, `start.mjs`, JSON output | No file attachments through the CLI |
| 5.10 | REST API v0: projects, workspaces, sessions, messages, status, cancel, sleep, archive, attachments (`docs_api.md`, `0.77.0`, `0.78.0`) | MISSING | Everything is a local CLI plus files in `~/.rollcall` | Matters only for driving falcon from off the Mac |
| 5.11 | Hosted MCP server for ChatGPT, Claude, Codex, Cursor: create and follow workspaces, review a diff and comment, start another workspace (`docs_api_mcp.md`, `0.82.0`) | MISSING | - | An MCP over rollcall tasks would let Claude mobile, Desktop or another agent start and follow falcon tasks |
| 5.12 | Read-only SQL over all session transcripts; "daily report" recipe; `conductor sql` REMOVED in `0.92.0` (`docs_api.md`) | PARTIAL | `/recap` (worklog, memory, git and PR history), `docsic_recall`, `rollcall task show`; native `/resume` search | No full-text search across every worker's transcript |
| 5.13 | Routines: a saved prompt in a fresh workspace on a schedule, GitHub triggers filtered by label, author or base branch, or a webhook (`0.85.0`, `0.86.0`, `0.92.0`, `docs_api.md`) | NATIVE | `/schedule` (cron, an API `/fire` URL, GitHub events) runs in Anthropic's cloud; `/loop` local; `rollcall remind` (reminders for the owner), `task wait-for` (condition waits) | No local trigger that turns an event into a falcon task |
| 5.14 | Cloud workspaces: sandboxes that outlive the laptop, sleep and wake, SSH, one-way file sync, port forwarding, remote desktop, Chrome preinstalled; cloud agents run approved commands on your Mac (`docs_cloud.md`, `llms-full:/docs/cloud/*`, `0.78.0`, `0.80.0`, `0.83.0`, `0.84.0`, `0.89.0`) | NATIVE | Claude Code on the web (`claude --cloud`, `--teleport`) | kesselrunner is local only |
| 5.15 | Cloud Computer: shared org environment, install script, builds, an admin agent; org settings, SSO, SCIM (`llms-full:/docs/cloud/cloud-computer`, `0.65.0`, `0.81.0`) | N/A | Solo owner | - |
| 5.16 | Multiplayer: shared workspaces, presence, typing, follow, reassign, `@` teammates, profiles, pokes (`llms-full:/docs/cloud/collaboration`, `0.74.0`, `0.77.0`, `0.78.0`, `0.91.0`) | N/A | Solo owner | - |
| 5.17 | Plan-then-implement and multi-PR fan-out run by a managing agent (`docs_api.md` cookbook) | HAVE | The supervisor splits work into tasks; `--after` and `--until landed` chain them; the merge queue lands them | - |
| 5.18 | Slack MCP for cloud agents (`llms-full:/slack`) | N/A | MCP is native | - |
| 5.19 | Transfer a cloud workspace to local; export all data (`0.93.0`) | N/A | Local by default | - |
| 5.20 | "Caffeinate while agents are running", off under 10% battery (`0.50.0`, `0.51.0`) | HAVE | rollcall holds `caffeinate -i` on AC while a PR ships; battery warning; power blocker (rollcall README "Machine trouble") | Holds only while shipping, not while building |
| 5.21 | Ask before quitting while an agent runs; install updates once agents are idle (`0.25.4`, `0.39.0`, `0.63.0`) | HAVE | Closing a falcon tab only detaches; workers keep running; `kesselrunner sync` applies at session start; a supervisor hears when its skill changed | - |

## 6. UX surface

| # | Conductor capability (source) | Status | Where in kesselrunner, or why missing | Gap note |
|---|---|---|---|---|
| 6.1 | Mac app: sidebar, chat, right panel (diff, checks, files, terminal), zen mode, remembered layout (`docs_concepts_workflow.md`, `0.19.0`, `0.22.0`) | PARTIAL | Terminal UI: falcon tmux tab bar, status-line chips, rollcall-band and pr-band lines (`docs/architecture.md` "Mods") | No GUI by design; Claude Code Desktop and Agent View (`claude agents`) are the native dashboards |
| 6.2 | Sidebar status: groups (backlog, in progress, in review, done), icons for plan approval, input and permission, bold when waiting, line-diff counts, hover card, status matrix (`0.33.5`, `0.35.0`, `0.44.0`, `0.85.0`) | HAVE | A tab per task, filled while it waits on the owner, with the minutes; ship stage against its usual time; task states in `rollcall task list` | No diff counts |
| 6.3 | Group by repo, sections with emoji, pinned, arrange by hand, search, filters, sort (`0.25.3`, `0.26.0`, `0.35.2`, `0.85.0`, `0.92.0`) | PARTIAL | Separate supervisors (falcon, venator) give separate lists; `task list --all` | No pins, sections or search |
| 6.4 | Next workspace needing attention (⌘⌥L), next unread, mark read or unread, unread counts, ⌘1-9 (`0.1.0`, `0.25.11`, `0.36.4`, `0.37.0`, `0.83.0`, `0.91.0`) | PARTIAL | The supervisor relays every question into its own picker; notifications repeat every 10 minutes; `/attach t3`; tabs are clickable | No key for "next task waiting on me" |
| 6.5 | Command palette ⌘K: workspaces, chats, PRs, settings, actions (`0.14.0`, `0.39.0`, `0.71.0`) | N/A | Slash commands | - |
| 6.6 | Search in a chat (⌘F, thinking included), chat outline, AI hover summaries, file picker ⌘P (`0.15.1`, `0.31.0`, `0.32.0`, `0.34.2`, `0.90.0`, `0.92.0`) | PARTIAL | Native `@` file search, transcript view, `/resume` search | No outline |
| 6.7 | Keyboard shortcut cheatsheet with search; custom shortcuts (`x_docs_reference_keyboard-shortcuts.md`, `0.23.0`, `0.92.0`) | NATIVE | `?`, `/keybindings` | - |
| 6.8 | macOS notifications for completion, questions, plan reviews, permission requests; click opens the chat; Dock badge (`0.2.0`, `0.28.7`, `0.44.0`, `0.48.0`, `0.89.0`) | HAVE | rollcall watcher: waiting tasks after 30-60 s then every 10 minutes, PR open / queued / landed, blockers; pr-band toasts; `rollcall remind`; overlay `agentPushNotifEnabled: true` for phone pushes | - |
| 6.9 | Completion sounds, novelty sounds, custom sounds (`0.6.1`, `0.52.0`, `0.83.0`, `0.93.0`) | PARTIAL | Blocker notifications play "Glass" (`packages/rollcall/src/trouble.mjs`) | No per-event or custom sounds |
| 6.10 | Integrated terminal per workspace: tabs, restore after restart, ⌘J, search, scrollback limit, clickable URLs (`0.0.16`, `0.38.1`, `0.48.0`, `0.63.0`, `0.75.0`) | HAVE | Each worker is a tmux window on rollcall's tmux server; native `!` bash mode | - |
| 6.11 | Big Terminal Mode with agent presets (`llms-full:/docs/reference/big-terminal-mode`, `0.8.0`, `0.48.0`) | HAVE | Falcon is terminal-first | - |
| 6.12 | Send terminal output to the chat (⌘L, `@terminal`); the agent reads your terminal (`0.7.2`, `0.29.5`, `0.46.0`, `0.70.0`) | PARTIAL | `!cmd` output joins the context natively | No "send this pane's output to t3" |
| 6.13 | Built-in file editor, file tabs, file explorer, search across files (⌘⇧F), previews for markdown, PDF, CSV, JSON, SVG, images (`0.16.0`, `0.37.0`, `0.82.0`, `0.83.0`, `0.85.0`, `0.87.0`) | NATIVE | Desktop file pane | The owner uses their own editor |
| 6.14 | "Open In" Cursor, VS Code, Zed, Xcode, JetBrains, Warp, Finder (⌘O) (`llms-full:/docs/guides/migrate-from-cursor`, `0.0.20`, `0.33.3`, `0.62.0`) | PARTIAL | The clickable mod opens paths in replies; native `/ide` | No "open t3's worktree in my editor" |
| 6.15 | Clickable file mentions, `path:line` links, app links (`0.19.0`, `0.27.1`, `0.34.0`, `0.45.0`) | HAVE | clickable mod (`mods/clickable/`) | - |
| 6.16 | Copy buttons on messages and code, copy chat as markdown (⌘⌥C), copy a transcript from a tab (`0.2.0`, `0.38.3`, `0.89.0`) | HAVE | clickable `[copy]` links and `/copy`; native `/export` | - |
| 6.17 | Run button on bash snippets in replies, output shown inline (`0.91.0`) | PARTIAL | clickable `[copy]` link, then `!` | - |
| 6.18 | Mermaid (fullscreen, zoom), LaTeX, tables, HTML previews, Tufte style, frontmatter in chat (`0.27.0`, `0.34.2`, `0.55.0`, `0.68.0`, `0.93.0`) | PARTIAL | Artifacts publish pages; the terminal renders none | UNCONFIRMED: any native mermaid preview |
| 6.19 | Attachments: images, files, folders, long pastes, GitHub issues, `#` PR autocomplete, Linear issues (⌘I), video player (`0.0.20`, `0.29.3`, `0.32.0`, `0.44.0`, `0.84.0`) | NATIVE | Paste or drag images, `@` files; supervisor picks carry attached pictures to workers | No issue or PR attachment |
| 6.20 | `@` mentions for files, folders, agents, comments (`0.0.19`, `llms-full:/docs/first-workspace`) | NATIVE | `@` | - |
| 6.21 | Slash commands from `.claude/commands`, plugin commands, skills as pills, UI commands (`/hooks`, `/agents`, `/permissions`) (`docs_reference_slash-commands.md`, `0.25.0`, `0.69.0`, `0.78.0`) | NATIVE | Skills | - |
| 6.22 | AskUserQuestion keyboard UI, multi-select (`0.31.3`, `0.62.0`) | HAVE | Native tool; worker questions reach the supervisor's picker and picks are typed back (`skills/supervisor/SKILL.md` "Picks") | - |
| 6.23 | Chat titles generated by AI, rename, chat history menu (`0.17.5`, `0.20.0`, `0.89.0`) | PARTIAL | Session names (`-n`, `/rename`); tasks titled by the supervisor | - |
| 6.24 | Thinking shown or hidden; "Garry mode" expands every tool call; ⌃O shows all messages (`0.15.1`, `0.41.0`, `0.72.0`) | NATIVE | Transcript view (Ctrl+O) | - |
| 6.25 | Links to a workspace or chat as pills, copy link (⌘⇧C) (`0.71.0`, `llms-full:/docs/cloud/collaboration`) | PARTIAL | `/attach t3`, `rollcall attach`; native `claude-cli://` | - |
| 6.26 | Voice dictation, voice mode (`0.78.0`, `0.91.0`) | NATIVE | Claude Code voice (overlay `voiceEnabled: true`) | - |
| 6.27 | iOS app for cloud workspaces: chat with agents, merge PRs (`0.90.0`, `0.91.0`) | NATIVE | Claude iOS app Code tab and cloud sessions | Falcon itself is not on the phone |
| 6.28 | Remote control of local workspaces from the iPhone: browse and create workspaces, read chats, send, pick models, stop, archive; QR pairing, end-to-end encrypted; keeps the Mac awake while connected (`docs_reference_remote-control.md`, `0.91.0`, `0.92.0`) | PARTIAL | Native Remote Control per session (`/remote-control`, `--rc`) | kesselrunner starts neither the Falcon nor its workers with it, so the owner cannot drive falcon from the phone. Not available on an API key or a custom base URL |
| 6.29 | Themes, accessible palettes, fonts, zoom, ligatures, low-contrast dark mode (`0.9.0`, `0.14.5`, `0.52.0`, `0.86.0`) | NATIVE | `/theme` (overlay: `dark-daltonized`); terminal settings | - |
| 6.30 | Diagnostics: per-process CPU and memory, resource and app logs, env diagnostics (`0.37.1`, `0.54.0`, `0.62.0`) | HAVE | rollcall blockers (disk, memory, power, usage, billing), "Mac load high" on tabs, `kesselrunner doctor` | - |
| 6.31 | Outage banners for Anthropic and GitHub (`0.22.5`) | PARTIAL | rollcall's billing and usage blockers | No status-page check |
| 6.32 | Onboarding, sample project, Conductor Wrapped, Passport (`0.11.3`, `0.25.1`, `0.49.0`) | HAVE | `install.sh`, `falcon` first-run check; no novelty features | - |

## 7. Config and settings

| # | Conductor capability (source) | Status | Where in kesselrunner, or why missing | Gap note |
|---|---|---|---|---|
| 7.1 | Layered settings: user, repo shared, repo local, managed; precedence; JSON schemas; the UI names the layer that set a value (`docs_reference_settings_user-project.md`, `docs_reference_settings_reference.md`, `0.62.0`) | HAVE | Claude Code scopes plus kesselrunner's `settings.core.json` merged with the overlay's `settings.json` (`docs/overlay.md`); per-repo manifest | - |
| 7.2 | Settings UI pages, searchable, with `conductor://settings/<page>` links (`llms-full:/docs/reference/deep-links`, `0.77.0`) | N/A | `/config` | - |
| 7.3 | Share repo settings by committing `.conductor/settings.toml` (`llms-full:/docs/reference/scripts/share-with-teammates`) | HAVE | Committed manifest and `.claude/settings.json` | - |
| 7.4 | Per-action prompts: general, code review, create PR, fix errors, resolve conflicts, branch rename; team prompts combined with personal ones (`docs_reference_settings_reference.md`, `docs_reference_agent-behavior.md`, `0.29.1`, `0.44.0`, `0.83.0`, `0.86.0`) | HAVE | Skills and agents are the action prompts (`/pr-create`, code-reviewer, test-runner); an overlay skill or agent with the same name replaces the core one; repo `CLAUDE.md` | - |
| 7.5 | Tool approvals on or off, "always allow", managed approvals for subagents, auto permission mode (`0.41.0`, `0.43.0`, `0.45.0`, `0.70.0`) | HAVE | Native permission modes including auto (overlay `autoMode` rules); workers run in the supervisor's mode; overlay guards (`hooks/pre-tool-use/`: gws, porkbun, prod) and rollcall's denies hold in every mode | - |
| 7.6 | Codex tool approval policy, auto-approve setting (`models.codex.tool_approval_policy`, `0.82.0`, `0.83.0`) | HAVE | `KESSELRUNNER_CODEX_SANDBOX` for delegated Codex workers | - |
| 7.7 | Enterprise / strict data privacy (no AI titles, no custom MCP, no cloud) (`docs_reference_privacy.md`, `0.20.0`, `0.36.3`, `0.77.0`) | N/A | No AI side features to switch off | - |
| 7.8 | Local chats stay on the Mac; PostHog analytics; redacted logs; error reports omit env and messages (`docs_reference_privacy.md`, `0.76.0`, `0.91.0`) | HAVE | No telemetry; rollcall state in `~/.rollcall`; overlay guards keep keys out of commands and output (porkbun, gws) | docsic pushes memory to the brain repo on GitHub |
| 7.9 | Managed settings file (`x_docs_reference_settings_managed.md`, `0.51.0`) | NATIVE | `managed-settings.json` | No use solo |
| 7.10 | Global hooks and memory configurable; project agents and commands honored (`0.9.0`) | HAVE | Core hooks in `settings.core.json`; docsic memory; overlay | - |
| 7.11 | Send key (Enter or ⌘Enter) (`0.1.0`, `0.84.0`) | NATIVE | Keybindings | - |
| 7.12 | Linear integration: auth, team filter, Linear tab (`0.15.0`, `0.31.0`, `0.66.0`) | MISSING | GitHub Issues only | Low value |
| 7.13 | MCP settings: one-click popular servers, recommendations, import from local agent configs, re-auth notices (`0.23.0`, `0.82.0`, `0.86.0`) | NATIVE | `/mcp`, plugins (context7, github, supabase, vercel in the overlay) | - |
| 7.14 | Legacy `conductor.json` and a migration PR (`x_docs_reference_conductor-json.md`, `0.11.0`, `0.62.0`) | N/A | - | - |
| 7.15 | Defaults: model, fast mode, plan mode, agent, auto-archive (`docs_reference_settings_reference.md`) | NATIVE | `model`, `effortLevel`, `permissions.defaultMode` | - |

---

## (a) What kesselrunner has that Conductor lacked

1. Its own merge queue: trains of up to 4 PRs tested as one tree, failure blame by stack, known-flake reruns, a bounce guard against weakened tests, `land.serial` groups for one-head migrations (`packages/rollcall/src/lander.mjs`). Conductor only showed GitHub's queue.
2. Enforced isolation: edits in a main checkout, or in a checkout another live session owns, are denied, and so are checkout-changing git commands, in every permission mode (rollcall PreToolUse). Conductor's isolation was a convention.
3. Awareness across sessions: claims with scopes, file-overlap warnings, "main moved" notices from an in-memory merge, `rollcall wait` and `done` (rollcall README).
4. A supervisor the owner talks to: every worker's question relayed into one picker, the owner's words kept verbatim on the task record, typed delivery with receipts (`@t3`) (`skills/supervisor/`). Conductor never had a local supervisor and dropped local CLI orchestration in `0.90.0`.
5. Workers that last: handoff to a fresh session at 35% (worker judges) or 70% (forced), parking idle workers, resume after a crash or exit, a watcher that takes routine steps with no model turn.
6. Machine and account blockers: usage limit with its reset time, GitHub billing, low disk, memory, battery; work waits and resumes on its own (rollcall README "Machine trouble").
7. A ship chain sized to the diff: quick checks, one review, the docs gate (`docsic gate` over `owns:` frontmatter), worklog entries, CI watch with failure triage, deploy watch, release steps such as TestFlight, and production as a separate word (`skills/pr-create/`).
8. Input-keyed test results: `rollcall results` skips a check whose input files already passed on any tree, in CI or on another machine.
9. Pre-push suites for a scarce self-hosted runner, attested to CI (manifest `ci.prePush`), and `/ci-setup` to move suites into GitHub Actions on a budget.
10. Project memory: docsic state and notes injected into each session, `/recap`, `/note`.
11. A test manifest as the one home for commands, ports, auth bypass, routes and iOS fixtures, read by every test tool (`docs/test-manifest.md`).
12. iOS verification and release: `/ios-sim` with the ios-driver agent and `iosim`; `/ship-ios-build` to TestFlight.
13. Browser checks scoped by blast radius: `/frontend-test` with the frontend-tester agent.
14. Seven named helper agents (code-reviewer, test-runner, test-updater, docs-updater, deploy-watcher, frontend-tester, ios-driver), runnable on a Codex plan (`kesselrunner delegate codex`).
15. One setup in both Claude Code and Codex through the Codex bridge: instructions, skills, agents, hooks.
16. Guards that deny tool calls in every mode: no mail sends or deletes, DNS limited to safe adds, the production release kept for the owner (overlay `hooks/pre-tool-use/`).
17. Optional rules switched on per machine, such as the Orwell prose rules and frontend fundamentals (`kesselrunner rules`).
18. A decisions list across supervisors, reminders for the owner (`rollcall remind`), and worker waits on a condition kept out of the model's context (`task wait-for`).
19. Disk care: gc of merged worktrees, a sweep of what ended work left (DerivedData, temp folders, orphan test browsers), `rollcall clean` with the list shown first.
20. A docs standard enforced in CI (the Docs gate) with a README refresh cadence.
21. Mods drawn inside Claude Code: rollcall-band, pr-band (checks, verdict, deploys, toasts), clickable (copy links, path links).
22. Open source (MIT), no server, no telemetry, macOS and Linux, self-updating at every session start, with the owner's layer kept apart in an overlay.
23. Several supervisors side by side, tasks movable between them (`rollcall task move`).
24. Plan-then-build task chains that start the build only once the plan's work has landed (`--after --until landed`).

## (b) The ten gaps most worth closing

Ranked for a power user running several agents at once. Row numbers point into the tables above.

1. **Per-task ports and dev-server isolation** (1.18, 1.25, 1.16). Two UI tasks share the manifest's one port, and frontend-tester reuses whatever answers there, so a browser check can pass against another task's code: a correctness bug, not a convenience. Give each task a port block, template the manifest's `devServer` with it, and have the tester confirm the server runs from its own worktree.
2. **Worktrees ready before the worker starts** (1.22, 1.14, 1.20). Every task pays this today as an agent step that costs tokens and fails late. `task new` could copy `.worktreeinclude` files (default `.env*`), run `worktree.setup` with a log, and export the root path, task name and port to scripts.
3. **The Falcon on the phone through Remote Control** (6.28, 6.27). The native piece exists; launching the Falcon (and, when wanted, a worker) with `--remote-control` lets the owner answer pickers and send `@t3` lines from the Claude app, the way the owner already works GitHub from the phone. Works only on a subscription login.
4. **PR review comments in the ship loop** (3.3, 4.4). `/pr-create` and the lander watch checks but never review threads, so comments left on GitHub (by the owner from the phone, or by bot reviewers) never reach the worker. Read unresolved threads after CI, fix and resolve them, or call Claude Code's `/autofix-pr`.
5. **Line-level feedback on a running task's diff** (3.1, 3.2). Before a ship, the owner's only channel is prose to the supervisor. Route line comments into the worker as attachments: open the task's worktree in Desktop's diff view, or a small local diff page whose comments go through `rollcall task tell`.
6. **A usage meter across all workers** (2.16, 2.17). Several workers drain one plan, and rollcall hears of a limit only when a turn fails. The status line already receives `rate_limits` (five-hour and weekly use, reset times); show them, plus tokens per task.
7. **Tasks from GitHub issues and PRs** (1.7, 1.6, 1.5). The owner's queue is GitHub Issues jotted from the phone, and today the owner retypes them. `task new --issue <n>` (issue body as the owner's words, `Closes #N`) and `--pr <n>` / `--branch <b>` remove that, and open the way to label-triggered intake (5.13).
8. **Archive for unmerged work** (1.26, 1.28). gc keeps every unmerged worktree for good, so dropped experiments pile up and feed the low-disk blocker. An archive that commits WIP to a ref, frees the folder and restores later fixes it, listing what goes before anything is deleted.
9. **Per-turn snapshots that cover Bash changes** (3.8, 3.9). Native `/rewind` restores only edit-tool changes, and workers in auto mode change much through Bash (codegen, formatters, migrations). A private ref per turn from a Stop hook gives exact per-turn diffs and a safe undo.
10. **Codex as a falcon worker** (2.2, 2.6). The bridge and rollcall's Codex hooks exist, and the owner has a Codex plan; a `--harness codex` task spreads work across two plans when Claude limits bite (pairs with item 6). Next in line after these ten: an MCP server over rollcall tasks (5.11), and Spotlight-style testing for one shared heavy stack (1.24).

## UNCONFIRMED claims

- 1.21: whether Claude Code can load env files into the agent's environment.
- 1.23: whether direnv reloads per worktree in Claude Code.
- 2.7: the `opusplan` alias in Claude Code 2.1.319.
- 2.12: what Conductor's "Ultracode" maps to in Claude Code.
- 3.1, 3.2: whether Claude Code Desktop can open a session started in the CLI (a falcon worker) to use its diff view and line comments.
- 3.14: whether pr-band shows a preview deployment link before merge.
- 6.18: any native mermaid or markdown preview in Claude Code.
- Conductor changelog conflicts: `0.86.0` says Codex goals and message queuing were removed, yet later entries still describe both (likely Codex-only).
