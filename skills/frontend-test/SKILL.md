---
name: frontend-test
description: "Frontend verification orchestrator. Scopes the blast radius from the diff, picks a tier (smoke|full), then spawns the frontend-tester agent to drive a real browser via Playwright MCP - browser noise stays out of the main context; only a structured PASS/WARN/FAIL report comes back. Use when frontend code changed (.tsx/.jsx/.vue/.svelte, CSS, routes, or any API a UI consumes) and the change must be validated as a real user would experience it - NOT just type-checked or unit-tested. Trigger when: user says 'test the frontend', 'verify the UI', 'check the UX', 'make sure it works in the browser', '/frontend-test'. Called by /pr-create when a UI change warrants a browser check (new route, visual change, shared surface)."
argument-hint: <summary of what changed - components, routes, or behaviors affected>
---

# Frontend Test

Validates that frontend changes work the way a user will experience them. This skill does the thinking (scope, tier, auth readiness); the **frontend-tester agent** does the browser driving and returns only a report, so snapshots and screenshots never land in the main context.

## Phase 1: Scope the blast radius

Read `.claude/test-manifest.json` if it exists (schema: kesselrunner docs/test-manifest.md) - it supplies dev server command/port, auth bypass env, key routes, and skip routes. No manifest: detect these the hard way (package.json scripts, next/vite config, grep for auth providers) and **write the manifest before finishing** so the next run skips this.

From the argument + `git diff --name-only HEAD` (and `git status --short`), map changed files to routes:

- Route page changed -> that route.
- Component changed -> grep import sites, trace up to the route pages that render it.
- API handler changed -> the routes whose UI calls it.
- Shared surface changed (layout, shell, global CSS, design tokens) -> the manifest's `routes.key` list (or every top-level route without a manifest).

Drop anything in `routes.skip`. Output a checklist of `[route x viewport x golden-path interaction]`, both viewports (375px mobile, 1280px desktop; if the project's breakpoints differ, use the manifest's `notes` or the CSS). Empty checklist -> report "no UI-reachable changes" and stop.

## Phase 2: Pick the tier

**smoke** (default): console + network + golden-path interactions; screenshots only as failure evidence.

**full**: everything in smoke, plus before/after screenshots per check, a visual pass over every route, and edge states (empty/loading/error).

Escalate to full when any of: global CSS / layout / shell / design-token files changed; a route or page is new; the change is explicitly visual (spacing, theming, responsive behavior); the user asked for thorough verification. State the tier in one line; the user can override.

## Phase 3: Auth readiness (trust boundary - stays here, not in the agent)

If the app has auth, the agent needs a way through it before it can verify gated routes. Either one satisfies this phase:

- **Signed-in state** (preferred when the manifest has `auth.storageState`): a Playwright storage-state file written by signing a test user in for real (e.g. `@clerk/testing`), so the app carries no bypass. Run `auth.storageStateCommand` yourself when the file is missing or older than a few hours (sessions expire), and confirm it now exists. It needs whatever the command needs (dev-instance keys, seeded users); if it fails, HALT and report its error.
- **Bypass env**: the manifest's `auth.bypassEnv`, else grep for the conventions: `E2E_TEST_AUTH === "1"` short-circuiting the session callback, `src/lib/test-auth.ts`, a `PLAYWRIGHT_TEST`/`NEXT_PUBLIC_E2E` flag in auth/middleware config.

**If neither exists, HALT and report** - do not spawn the agent. If the auth provider has a test sign-in path, propose a storage-state command instead of a bypass. Otherwise, propose the standard patch (stub session in the auth callback + middleware pass-through, both gated on `E2E_TEST_AUTH === "1"` AND `NODE_ENV !== "production"`), apply it on the current feature branch (branch first if on main), then re-enter this skill. The tester agent never writes auth code.

## Phase 4: Spawn the frontend-tester agent

Spawn **frontend-tester** (see "Delegation" in the global instructions) with everything it needs - it has no other context:

- the checklist from Phase 1 and tier from Phase 2
- change summary (so golden paths and edge cases are grounded in what changed)
- base URL + dev server start command + port, and whether a server may already be running
- auth: the storage-state file path (absolute), or the bypass env var name (if any)
- artifact dir: `.claude/artifacts/frontend-test/<ISO-timestamp>/`
- anything unusual from the manifest's `notes`

While it runs, continue other pending work; act when its report returns.

## Phase 5: Act on the report

- **PASS** -> proceed; relay the one-line summary.
- **WARN** -> surface the specific suspicious items to the user; their call.
- **FAIL / BLOCKED** -> do not proceed to any downstream step (in /pr-create this re-enters the fix loop). Fix the cause, then re-spawn frontend-tester with the failed rows plus anything the fix touched.

If the run produced durable discoveries (real port, working start command, bypass env, key routes), fold them into `.claude/test-manifest.json` now.

## What this skill does NOT do

- Run unit tests or type-check (test-runner's job; assume those passed).
- Drive the browser inline (the agent does; keep it there).
- Hit anything but the local dev server.
