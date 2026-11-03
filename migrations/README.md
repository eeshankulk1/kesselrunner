# Migrations

One-off steps `kesselrunner sync` runs once per machine, in filename order, after pulling and before reconciling. Use one when a change needs more than the declarative reconcile can express: moving a file users already have, removing something an old version installed, renaming a key.

- Name: `NNN-kebab-description.mjs`, next free number. Never renumber or edit a shipped migration; add a new one.
- Export a default (optionally async) function receiving `{ claudeDir, core, overlay, state, readJson, writeJson, sh, log }` (`state` is the live state object reconcile writes back afterwards, so a migration can rename an `applied` entry).
- Must be safe to run on a machine that never had the old state (a fresh install runs every migration).
- Throwing stops the run; the migration and every later one retry on the next sync.
- Applied ids are recorded in `~/.claude/.kesselrunner/state.json`.
