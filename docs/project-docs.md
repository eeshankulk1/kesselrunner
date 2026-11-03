# Project Docs Standard

Every project repo carries a `docs/` directory that is the source of truth for how the project works NOW. Cross-session memory (state, notes) is kept by docsic, and decisions/product specs may live in a personal knowledge hub; repo docs hold the what and the how. This file is the canonical definition of the structure, the ownership rules, and the freshness machinery. Templates live in `docs/templates/` (in kesselrunner: `~/.claude/kesselrunner/docs/templates/`).

## The doc set

| Doc | When | Scope |
|-----|------|-------|
| `architecture.md` | always | The hub: system overview, repo layout, tech stack, doc index. See hub rule below. |
| `local-dev.md` | always | Clone-to-running narrative: prereqs, setup, env var meanings, seeded data, gotchas. Exact commands defer to the test manifest (see ownership). |
| `deployment.md` | always | Deploy targets, build, prod env, CI/CD. |
| `api.md` | server API exists | Routes, models, RLS/auth, wire contracts (SSE shapes, error formats). |
| `frontend.md` | web UI exists | Routes/pages, components, state, API integration. |
| `data-flow.md` | nontrivial data movement | Request lifecycle, key flows, external integrations. |
| `worker.md` | background jobs exist | Jobs, queues, schedules, state, retries. |
| `design-system.md` | project has a design language | Tokens, type, voice, component rules. The design source of truth. |
| `<surface>.md` (e.g. `ios.md`) | per additional platform/client | That surface's stack, layout, run + test procedure. |
| `<subsystem>.md` (e.g. `messaging.md`) | subsystem outgrows architecture.md | Deep dive on one subsystem; architecture.md keeps a summary + link. |
| `plans/` | as needed | One-off working artifacts with a lifecycle - see below. |
| `worklog/` | always (written by /pr-create) | The ship log: one entry file per PR, `worklog/<YYYY-MM>/<date>-<branch>.json`, so parallel PRs never touch the same file. Never hand-edit. A `worklog.jsonl` beside it is the older single-file log, kept as history and read together with the entry files. |

## Doc frontmatter - `owns:`

Every doc in `docs/` root except the machine-written worklog (`worklog/`, `worklog.jsonl`) starts with frontmatter naming the code it describes:

```yaml
---
owns:
  - backend/app/routes/**
  - backend/app/schemas.py
status: current
---
```

`owns:` globs (git pathspec: `**` spans directories, `*` one segment) are what make the docs trigger deterministic: a change to an owned file requires that doc to be edited or explicitly waived (the PR gate below). Keep them tight - a glob that fires on changes the doc never describes breeds reflexive waivers; broad ownership belongs to the hub index, not to globs. `docs/gate.json` holds the rest of the gate's config: `ignore` (changed code no doc should describe - tests, fixtures, lockfiles) and `owns` (a non-doc file that must follow code the same way, e.g. `.claude/test-manifest.json` following the Makefile). Draft globs by backtesting them against the repo's recent merged PRs: which docs each PR actually touched vs which the globs would require.

## Hub rule

`architecture.md` contains a doc index table listing **every** file and subdirectory in `docs/` (`plans/` as a single row, not per-file). "Start at architecture.md - it links everything" must be literally true; a doc not in the index is a bug. The docs-updater agent verifies this on every run.

## Ownership - each fact has exactly one home

| Home | Owns |
|------|------|
| `docs/*.md` | Current-state truth about the system: structure, contracts, procedures, design language. |
| `.claude/test-manifest.json` | Command-grade facts: exact test/build/dev-server commands, ports, seed/reset, auth bypass, key routes. Machine-first, self-healing (agents write back corrections). See `test-manifest.md`. |
| Repo `CLAUDE.md` | Orientation (pointers into docs/) plus genuine gotchas that fit no doc. No commands (manifest's job), no architecture prose (docs' job). If a CLAUDE.md paragraph restates a doc, delete the paragraph and keep the pointer. |
| `README.md` | The public face, in a fixed four-part shape (below). Nothing version-volatile (versions, model names, counts, prices, build numbers, repo layouts, named sub-feature lists) - that belongs in docs/, where the freshness machinery reaches it. Refreshed on a cadence, not per PR (freshness layer 4). |
| Memory (docsic: local store or hub `projects/<slug>/`) | State, notes; with a hub, also decisions + rationale and product specs. Nothing in repo docs should duplicate a decisions.md row - link to it. |

**Sanctioned duplication - safety warnings only.** A destructive-command prohibition (e.g. "never `supabase db reset` here - it wipes 144k ingested rows") lives in BOTH the manifest `notes` and `local-dev.md`, and in any skill that could run the command. Everything else: one home.

On conflict: the manifest wins for command-grade facts (it is the copy agents actually heal); docs win for narrative and warnings. Whoever notices a conflict fixes the losing copy in the same session.

### README shape

1. **Pitch** - 1-2 lines: what it is, for whom, where it lives.
2. **What it does** - at most 6 capability-level bullets ("chat with an agent that reads your inbox", not "4 routines: A, B, C, D").
3. **Surfaces and stack** - one line per surface (web, API, iOS, worker) with its major tech; no versions.
4. **Next** - links into docs/: architecture, local-dev, deployment.

Branding, repo layout, setup steps and status live in their docs (design-system.md, architecture.md, local-dev.md, docsic state). A README in this shape only goes stale when the product's capabilities or surfaces change, which is exactly what its refresh cadence watches.

## plans/ - working artifacts with a lifecycle

Implementation plans, rollout runbooks, one-off audits, handoff notes: these are real work products but they rot into misinformation when left in `docs/` root. They live in `docs/plans/` instead:

- **Name**: `YYYY-MM-DD-<slug>.md` with frontmatter `status: active | done | superseded`.
- **On ship**: absorb anything durable into the standard docs, then flip `status: done` (optionally note `absorbed-into:`). Done plans are historical record - never edited, never cited as current truth.
- **Agents**: never read a `done`/`superseded` plan to answer a current-state question; the standard docs are the answer.
- **Migration**: existing repos move one-off docs into `plans/` opportunistically (the drift sweep proposes this).

## Freshness machinery

Four layers keep docs true to main:

1. **PR gate** (`/pr-create` step 3, and CI's `Docs gate` required check): `docsic gate` maps the change's files through every doc's `owns:` to a required list - deterministic, no model. Each required doc is edited in the PR or waived in the PR body with `Docs-skip: <doc> - <reason>` (10+ character reason, or the gate treats it as missing); the docs-updater writes the content and the waivers, scoped to the required docs, and may edit others it finds affected. Changed code no doc owns is flagged for the agent to cover (`owns:` or `ignore` in `docs/gate.json`). A repo whose docs don't declare `owns:` yet falls back to a full docs-updater pass per PR.
2. **Post-merge catch** (deploy-watch hook): any in-session `gh pr merge` that bypassed /pr-create injects a `[docs-sync]` instruction - check whether the merged PR carried doc changes; if it changed code but no docs, run the drift sweep and ship a docs-only follow-up PR.
3. **Drift sweep** (`/update-docs sync`): reconciles all docs against commits that landed since docs were last touched, verifies the hub index, and spot-checks cross-doc consistency (docs vs docs, docs vs CLAUDE.md, docs vs README). Run it when returning to a repo after out-of-band merges (e.g. mobile), or whenever docs feel stale.
4. **README cadence** (`docsic gate`'s advisory `readme` block, never a failing check): README.md is due once `every` PRs (default 10, `docs/gate.json` `readme.every`, 0 = off) landed on the default branch since it last changed, or when a top-level directory appeared or disappeared (usually a new surface). `/pr-create` refreshes it inside the PR that found it due, from the worklog entries since its last change - about one README pass per ten PRs, never a PR of its own.
