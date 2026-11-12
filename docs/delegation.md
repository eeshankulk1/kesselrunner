# Delegation: running a named agent

The always-loaded rule (core `CLAUDE.md`, "Delegation") says who runs on what. This page is the detail a session reads when it hands work to a named agent on Codex. The mechanics behind it: [codex-parity.md](codex-parity.md#delegation---running-the-agents-on-codex). The contract every helper follows: [helpers.md](helpers.md).

## Which backend runs an agent

- **Claude** (the default): the Agent tool with `subagent_type: "X"`. The agent's own `model:` line picks its model; pass `model` only to step a helper up (`"opus"`) after it failed the same job twice.
- **Codex**: when the session-start context says `delegation backend: codex` (every named agent), or `delegation backend: claude, except X on codex` (the agents it names), those agents run on the user's Codex plan instead. Bash with `run_in_background: true`, the task prompt on stdin:

  ```bash
  node ~/.claude/kesselrunner/scripts/delegate/run.mjs X --cwd "<repo root>" <<'EOF'
  <exactly the prompt you would have given the Agent tool>
  EOF
  ```

  It prints only the worker's final report plus one trailer line (exit code, minutes, log path); treat that output like an Agent tool result. Exit 2 = this agent runs on Claude: use the Agent tool. Exit 3 is a usage or setup failure with no worker log. Any other non-zero exit: read the log it names, retry once, then fall back to the Agent tool and say so in your report.

The global switch is `kesselrunner delegate codex|claude`. An agent's frontmatter can pick its own: `backend: codex` runs it on Codex while the rest stay on Claude, and `backend: claude` (or the older `codex: never`) keeps it on the Agent tool whatever the switch says. ios-driver is pinned to Claude: it drives the iOS simulator, which a Codex worker's sandbox cannot reach.

## What stays the same on both

- Same prompt and same report format; which agent runs, when, and what happens with its report never changes.
- Only the named agents route to Codex. Orchestrating skills, plugin agents (`/simplify`) and the claude-code-guide agent stay on Claude.

## Codex workers

- `kesselrunner delegate codex --model M --effort E` picks the worker model (`kesselrunner delegate models` lists them; default is Codex's own config). An agent's `codex_model:` / `codex_effort:` frontmatter overrides that for one agent. `kesselrunner doctor` shows the backend and every agent that picks its own.
- Codex workers write only inside the repo plus its git dir and the usual build and cache dirs (Xcode DerivedData, simulators, package caches), network on. The live log path is printed when the worker starts; tail it to check progress.
- The sandbox cannot reach the iOS simulator or local service sockets (Docker, some Postgres setups). When a Codex worker reports suites as blocked, unverified or denied by the sandbox, re-run exactly those on the Agent tool before treating the gate as passed, and say so in the report.
- `KESSELRUNNER_CODEX_SANDBOX` / `KESSELRUNNER_CODEX_ADD_DIRS` in settings `env` are the user's knobs: never change them yourself.
- Whether the user's PreToolUse guards run inside a Codex worker is not settled ([codex-parity.md](codex-parity.md#known-gaps-no-codex-equivalent-degrade-gracefully)). Check before moving a helper that works in the user's accounts (browser-operator, prod-reader) to Codex.
