# Overlay

The overlay is a folder of your own (any repo or plain directory) that sync layers on top of the core. It is where your personal instructions, tools and guards live, so the core stays generic and a sync never touches your additions. Set it with:

```bash
kesselrunner install --overlay <dir>
```

Run it again to change the folder. Without an overlay, the core runs on its own.

## What goes in it

Every path is optional.

| Path | Applied as |
|---|---|
| `CLAUDE.md` | Appended to the managed block in `~/.claude/CLAUDE.md`, after the core's instructions and the optional rules that are on |
| `settings.json` | Merged over the core's `settings.core.json`, with the same default-value rules (see below): your plugins, marketplaces, `env` keys, hooks |
| `docsic.json` | Merged into `~/.docsic/config.json`, for example a `hub` for memory across projects |
| `skills/`, `agents/` | Linked beside the core's in `~/.claude/skills/` and `~/.claude/agents/`; one with the same name as a core one replaces it |
| `rules/<name>.md` | Optional rules, off until `kesselrunner rules on <name>` (below); one with the same name as a core rule wins |
| `hooks/pre-tool-use/*.mjs` | Guards: modules that can deny a tool call (below); one with the same file name as a core guard replaces it |

## Paths inside your files

Sync fills these in, in any string of a JSON value (`settings.json`) or text (`CLAUDE.md`):

| Placeholder | Becomes |
|---|---|
| `{{KESSELRUNNER}}` | The core's directory (`{{DOTCLAUDE}}`, the old name, still works) |
| `{{OVERLAY}}` | Your overlay's directory (empty without one) |
| `{{DOCSIC}}` | The docsic command |

So a hook in your `settings.json` can run `node {{OVERLAY}}/scripts/my-hook.mjs`, and your `CLAUDE.md` can point at `{{OVERLAY}}/scripts/` without a fixed path.

## Guards

A guard is a PreToolUse check you add to deny tool calls, for example a tool that must never send mail or touch DNS without you. Each is a file in `hooks/pre-tool-use/` of the core or the overlay, run in file-name order by the one PreToolUse entry (`scripts/hooks/pre-tool-use.mjs`), in the same process as rollcall. The contract, from `lib/guards.mjs`:

```js
export const tools = /^(Bash|Monitor)$/;     // optional: the tool names it sees (default: the shell tools)
export function check(payload, kit) { ... }  // a deny reason (string), or null to stay out of it
```

`payload` is the hook's input from Claude Code. `kit` is the shell lexer guards share (`lib/shell-scan.mjs`: `SHELL`, `commandText`, `scan`) plus `core`, the core's directory, so a guard in an overlay needs no import path into the core. Sync builds the PreToolUse matcher from rollcall's tools plus each guard's `tools`; a guard that fails to load adds nothing and is skipped at run time. The core ships one guard, `agent-model.mjs` (an Agent call names its model, and test, review and docs work goes to the named agents; see `CLAUDE.md` "Delegation"). An overlay file of the same name replaces it, so one whose `check` returns `null` turns it off.

## Optional rules

Instructions that stay off until you switch them on. Each is one file, `rules/<name>.md`, in the core or your overlay (the overlay's wins on a shared name); `kesselrunner rules` lists them.

`kesselrunner rules on <name>` adds the rule to the managed block in `~/.claude/CLAUDE.md`, between the core's instructions and your overlay's. `kesselrunner rules off <name>` takes it out and leaves the block exactly as it was. That block is the one file every writer reads: the main session, its subagents, and Codex through the `AGENTS.md` the bridge generates. (The built-in Explore and Plan agents skip `CLAUDE.md`; they only read.) A change takes effect in new sessions.

The choice is `env.KESSELRUNNER_RULES` in `~/.claude/settings.json`, a comma-separated list of names. Your overlay can switch a rule on by default by setting that key in its `settings.json`; once you have run `kesselrunner rules on` or `off`, that choice wins. A name that is on but exists in neither the core nor the overlay is skipped with a warning, and `kesselrunner doctor` reports it.

To add a rule, add `rules/<name>.md`: a `description:` in the frontmatter for the listing, then the text as it should read in `CLAUDE.md`, saying what it covers and what it leaves alone.

## What sync changes in `~/.claude`

`~/.claude` stays yours. kesselrunner manages only:

- **Links** in `skills/` and `agents/` pointing into the core and your overlay, plus `~/.claude/kesselrunner` pointing at the core. A skill or agent you made yourself with the same name wins; kesselrunner warns and skips it.
- **A marked block** at the top of `CLAUDE.md`: the core's instructions, the optional rules you switched on, then your overlay's. Write your own instructions below the end marker; they are never touched.
- **`settings.json`**: the hook entries it owns, default values for keys it sets (plugins, marketplaces, overlay settings), and `env.KESSELRUNNER_DELEGATE`, `env.KESSELRUNNER_CODEX_MODEL`, `env.KESSELRUNNER_CODEX_EFFORT` and `env.KESSELRUNNER_RULES`. If you change one of the default values, your change sticks: kesselrunner rewrites a key only while it still holds what it wrote last time. If the file is malformed or not a JSON object, sync refuses to overwrite it and doctor reports an issue.
- **docsic**: the pinned version (`package.json` -> `kesselrunner.docsic`), its MCP registration, and default keys in `~/.docsic/config.json`. Memory distillation is on, once per rollcall task and at session end for other sessions. The note sweep runs as `sweep: carry`: its doc edits ride your next PR on a branch that has no PR yet, never one that has or had a PR, and only edits no PR takes in a week land as a docs-only PR.
- **rollcall**: its hooks (they run the core's `packages/rollcall` directly) and the `rollcall` and `falcon` commands on PATH (every sync links the core's commands again with `npm install -g <core>` when one is missing). Its state lives in `~/.rollcall/`, outside `~/.claude`.
- **Mods**: the `kesselrunner` marketplace entry in `settings.json` points Claude Code at the core checkout, which loads the [mods](architecture.md#mods) from there. Claude Code keeps its own record of that under `~/.claude/plugins/`, like any plugin.
- **iosim**: the `iosim` command on PATH, linked the same way. It downloads nothing until an iOS check first needs it; `iosim install` then puts a pinned, checksum-verified [AXe](https://github.com/cameroncooke/AXe) release in `~/.local/share/kesselrunner/axe/`, outside `~/.claude` (no Homebrew, no sudo).

Sessions, history, plugin caches and the rest of Claude Code's own state stay in `~/.claude`, untouched.
