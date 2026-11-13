---
name: prod-read
description: "Read a live production system during an incident or root-cause question: service status, deployments, recent logs, variable names, the error tracker and read-only database queries, through the prod-reader agent (Sonnet) and a script that knows each provider's CLI and never prints a secret. This skill checks the project's test manifest `production` block (and drafts it when missing), keeps a single quick read inline, and writes the brief for anything more. Trigger when: 'is prod down', 'why did X fail in production', 'check the logs', 'what happened after the deploy', an RCA, a Sentry alert to explain, or '/prod-read'. Reads only: any write (restart, redeploy, a variable, a data fix) still needs the user's go."
---

# /prod-read

The session keeps the reasoning; the prod-reader does the reading. It runs the provider CLIs through one script (`~/.claude/kesselrunner/scripts/prod-read/read.mjs`), so no session re-learns a CLI with `--help` or prints a variable's value. The contract all helpers follow: `~/.claude/kesselrunner/docs/helpers.md`.

Reading production is safe to do without asking unless the project's or the user's instructions say otherwise. A write is never part of this skill: restart, redeploy, scale, a variable, a migration or a data fix needs the user's go, and the user's guards stay as they are.

## 1. The manifest block

```bash
node ~/.claude/kesselrunner/scripts/prod-read/read.mjs services
```

Exit 3 means the project's `.claude/test-manifest.json` has no usable `production` block. Draft it from `docs/deployment.md`, the provider config in the repo (`railway.json`, `vercel.json`, `fly.toml`) and the project's docs: the services with their provider and names, the error tracker's org and project, and the read-only way into the database if one exists (a read-only role's connection, never a password in the manifest). Schema: `~/.claude/kesselrunner/docs/test-manifest.md`, "production". Run `services` again to check it, and keep the block: it rides the next PR. Do not guess a value you cannot find; leave that entry out and say so.

## 2. Inline or hand over

- **Inline**: one quick read that answers the question (`status`, or one `logs --since 30m --errors`).
- **Hand over**: anything more: a timeline, several services, logs matched to tracker events, a database check.

## 3. The brief

- **The symptom** in the user's words, and since when.
- **The window** to read (`--since`), with the time zone.
- **The services** in question, or "all".
- **What is known**: a deploy that just went out, a change suspected, what you already read (so it is not read again).
- **The question** the report must answer ("did the 14:00 deploy cause the 500s on /api/sync?").

Spawn with the Agent tool, `subagent_type: "prod-reader"` (its file sets Sonnet), from the project's checkout.

## 4. Check the proof

The report quotes log lines, deployment records and tracker events with timestamps. Before acting on its answer, check that the timeline holds (the deploy time against the first error) and re-run the one script command the conclusion hinges on. A report whose proof does not hold goes back once with what was wrong; the same failure twice, read it yourself or step the agent up (`model: "opus"`).

## 5. After

The fix is the session's work, in a worktree, through the normal build and ship. A write to production the report suggests goes to the user as one plain question with what it would change.
