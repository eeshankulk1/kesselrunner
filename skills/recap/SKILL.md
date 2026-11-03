---
name: recap
description: "Answer 'what was done recently on <project>' accurately and concisely by reading the project's memory (state.md, notes, worklog) plus git/PR/issue history. Trigger when: user asks what happened recently, what was done last week, where a project stands, 'catch me up on X', or '/recap <project> [window]'."
---

# Recap

Produce an accurate, non-bloated answer to "what happened on <project> recently". Sources in priority order - read them, then synthesize; do not dump them.

## Arguments

`/recap <project> [window]` - project slug (`acme`, `my-app`, ...); window defaults to 2 weeks (accepts things like `3d`, `1w`, `1m`).

## Procedure

1. **Resolve the project** to its repo path (from the argument, the cwd, or the hub's project list when docsic has a hub - `docsic config` shows it). Ask for the repo path only if needed.

2. **Read the memory layer** (fast, local):
   - `docsic_load` with `cwd: <repo>` - state (where things stand now) and open notes
   - the worklog - one entry file per PR under `<repo>/docs/worklog/<YYYY-MM>/`, plus the older single file `<repo>/docs/worklog.jsonl`. Entries inside the window only, never all of it, run from the repo root: `{ cat docs/worklog.jsonl; find docs/worklog -name '*.json' -exec cat {} +; } 2>/dev/null | jq -c --arg d "<window start, YYYY-MM-DD>" 'select(.date >= $d)'`

3. **Read the code trail** (scoped to the window):
   - `git -C <repo> log --oneline --no-merges --since="<window>"` on the default branch
   - `gh pr list -R <owner>/<repo> --state merged --search "merged:><date>" --json number,title,mergedAt`
   - `gh issue list -R <owner>/<repo> --state closed --search "closed:><date>" --json number,title` (if issues are in use)

4. **Synthesize** - a short paragraph (or a few bullets if >5 distinct items): what shipped, what changed, what's in flight, what's next (from state.md). Include PR numbers/build numbers. No filler, no chronological dump; lead with the most significant item. If the window is quiet, say so plainly.

## Notes

- Worklog entries are the authoritative "why" record; git shows the "what". Prefer worklog phrasing when both cover an item.
- Cross-project recap ("what did I do this week overall"): run steps 2-3 per project (the hub's project list, or the repos the user names), one line each.
