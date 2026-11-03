---
name: update-docs
description: "Update project documentation after code changes, or drift-sweep a repo's docs against everything that landed since they were last touched. Use when the user says things like: 'update docs', 'update documentation', 'sync docs', 'docs are outdated', 'document this change', 'update architecture docs', or after implementing a feature/fix/refactor that affects architecture, data flow, API routes, worker behavior, frontend screens, dev setup, or deployment. Argument: a description of the changes made, or 'sync' (also the no-arg default) for a full drift sweep."
argument-hint: <description of changes made | sync | gate JSON from docsic gate --json>
---

# Update Documentation

This skill updates project documentation by spawning the **docs-updater** agent (defined in `agents/docs-updater.md`). The docs standard it enforces is `~/.claude/kesselrunner/docs/project-docs.md`.

## Procedure

Pick the mode from the argument:

- **Gate mode** - the caller (usually /pr-create) ran `docsic gate --json` and passes its output. Preferred whenever the repo's docs declare `owns:`: the required list replaces guessing which docs are affected.
- **Change mode** - the argument describes changes. Pass the description plus, when available, the changed-file list (`git diff --name-only main...HEAD` on a branch, or the relevant commit range).
- **README refresh** - add-on to any mode, or alone: the gate's `readme` block says `due: true` (or the user asks to refresh the README). Pass the block and the worklog entries since its `date`; the agent rewrites README.md to the fixed shape in `project-docs.md`.
- **Sync mode** - the argument is `sync`, empty, or clearly asks for a staleness check. The agent derives the drift window from git history itself and additionally runs the full consistency pass (hub index, doc-vs-doc, doc-vs-CLAUDE.md, doc-vs-README).

Spawn **docs-updater** (see "Delegation" in the global instructions) with the prompt for the mode:

Gate mode prompt:
```
Run in gate mode. The change:

{change description}

docsic gate output (required docs with their triggering files, unowned code):
{gate JSON}

For each required doc: update it, or return a one-line waiver if it truly needs no change.
Fix coverage for unowned paths. Edit any other doc the change affects.
```

README refresh (append to the prompt above, or send alone):
```
README.md is due for a refresh ({readme.reason}). What shipped since it last changed:
{worklog entries since readme.date}

Rewrite it to the README shape in project-docs.md, as a minimal diff: fix what is false,
add capabilities or surfaces that are missing, drop anything version-volatile.
```

Change mode prompt:
```
The following changes were made to the project:

{change description}

Changed files:
{file list, when available}

Update all affected documentation in docs/ to reflect these changes accurately.
```

Sync mode prompt:
```
Run in sync mode: no change description. Derive the drift window from git history,
reconcile all docs against what landed, and run the full consistency pass.
```

Wait for the agent to complete and relay its summary to the user, including any Flags (stale manifest commands, CLAUDE.md duplication, proposed plans/ moves). If the sweep produced doc edits and you are on main, branch (`docs/<short-description>`) before committing - docs changes ship like any other change.
