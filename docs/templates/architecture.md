---
owns:
  - <glob of the code this doc describes, e.g. backend/app/routes/**>
status: current
---

# Architecture

## Overview

<!-- One paragraph: what this project is and does -->

## System Overview

<!-- Table of runtime surfaces/services and their roles -->

| Surface | Path | Role |
|---------|------|------|
| | | |

## Repository Layout

```text
.
├── ...
```

## Tech Stack

<!-- Bullet list of frameworks, languages, databases, services -->

## Doc Index

<!-- EVERY file and subdirectory in docs/ gets a row (plans/ as a single row).
     A doc missing from this table is a bug - the docs-updater agent enforces it. -->

| Doc | Scope |
|-----|-------|
| [Local Development](local-dev.md) | Setup narrative, env vars (exact commands: `.claude/test-manifest.json`) |
| [Deployment](deployment.md) | Deploy targets, CI/CD |
| [Plans](plans/) | Working artifacts (plans, runbooks, audits) - historical once `status: done` |
<!-- Add rows for api.md, frontend.md, data-flow.md, worker.md, design-system.md,
     per-surface docs (ios.md), and subsystem docs as applicable -->

## Current Scope

<!-- What the project does today, any constraints -->

## Limitations

<!-- Known constraints, missing features, tech debt -->
