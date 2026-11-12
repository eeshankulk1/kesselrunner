# /pr-create reference: the docs gate, the worklog entry, memory

The detail behind Step 3 of [SKILL.md](../SKILL.md).

## Docs: the trigger is deterministic, the content is yours

Same for every tier:

1. Run the gate: `npx -y @eeshkulk/docsic gate --json` (base `origin/main`; it counts uncommitted files too).
2. `owners: 0` in the result (no doc in the repo declares `owns:` yet - `required`/`unowned` are always empty in this case, so check this first): run `/update-docs {summary}` in change mode, and suggest once in the report that `/update-docs` can draft `owns:` frontmatter so the gate can run. Skip the rest of these steps.
3. Otherwise, the gate lists the **required** docs - every doc whose `owns:` frontmatter matches a changed file, plus files `docs/gate.json` `owns` maps (e.g. the test manifest) - with the files that triggered each, and the **unowned** changed code no doc covers.
4. Nothing required, nothing unowned, and nothing in your own read of the change that a doc claims (a cross-cutting behavior change the globs can't see): skip the docs agent entirely; Docs line "none required (gate)".
5. Otherwise run `/update-docs` in **gate mode** with the summary and the gate JSON. The docs-updater edits the required docs, returns a one-line waiver (`Docs-skip: <doc> - <reason>`, reason 10+ characters or the gate rejects it) for any required doc that truly needs no change, fixes coverage for unowned paths (extends a doc's `owns:` or adds it to `ignore` in `docs/gate.json`), and may edit other docs it finds affected through the hub index.
6. Write the waiver lines (if any) to a temp file and re-run `npx -y @eeshkulk/docsic gate --json --body-file <temp file>`. If it still reports a required doc as missing (edit not recognized, or a waiver reason too short), send that output back to `/update-docs` gate mode for another pass; loop until it exits 0. The final waiver lines go into the PR body in Step 4 as `Docs-skip: <doc> - <reason>` lines, which CI's `Docs gate` check re-reads.
7. **README due** (the gate JSON's `readme` block has `due: true`; advisory, never blocks): refresh README.md in this PR. Pass `/update-docs` (whichever mode already runs, or README mode alone when nothing else needed docs) the `readme` block plus the worklog entries since its `date`: `{ cat docs/worklog.jsonl; find docs/worklog -name '*.json' -exec cat {} +; } 2>/dev/null | jq -c --arg d "<readme.date>" 'select(.date >= $d)'`. Docs line gains "README refreshed (<reason>)". Older docsic without a `readme` block: skip.

## The worklog entry

Write one entry file, `docs/worklog/<YYYY-MM>/<YYYY-MM-DD>-<branch with / as ->.json` (e.g. `docs/worklog/2026-10/2026-10-01-fix-ios-queue.json` for branch `fix/ios-queue`; if that path already exists for a different PR, e.g. a reused branch name on the same day, add `-2` before `.json` rather than overwrite it; a later push of this same PR updates its own file), holding one JSON object on a single line plus a trailing newline, so it rides this PR.

```json
{"date": "<ISO date>", "project": "<slug>", "summary": "<1-2 sentences: what shipped and why it matters>", "pr": 0, "why": "<optional rationale>"}
```

- One file per entry, never a shared file: when every PR appended to one `docs/worklog.jsonl`, each merge made every other open PR conflict (GitHub does not apply a `merge=union` rule), a conflicting PR's checks do not start until main is merged in, and each such merge re-ran CI - a quarter of one project's merges of main were forced by that file alone. A repo's existing `docs/worklog.jsonl` is history: never append to it, never delete it; readers read both.
- Keep the entry an index, not a changelog: `summary` at most 2 sentences (~300 characters) naming what shipped and why it matters, `why` at most 1 sentence; the PR body holds the detail and `pr` links to it.
- Write `"pr": 0` now; Step 4 fills in the real number once `gh pr create` returns it. Never predict the number: a wrong guess cost a red docs gate and a second full CI run.
- `project` is the repo's memory slug (its hub project folder name when docsic has a hub configured), else the repo name.

## Memory

If project state moved or a durable decision/gotcha surfaced, record it with `docsic_save` (state or note). A `state` save replaces the whole snapshot and is capped at 800 tokens: trim what's stale, don't append. Then run any post-ship step your personal instructions define (e.g. a knowledge-base sync). It does not depend on the merge: do it now, before the report.
