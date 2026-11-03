---
name: note
description: "Capture a discovery, gotcha, decision, or idea as a durable project note that future sessions auto-surface until it's acted on. Trigger when: user says 'note this', 'note that down', 'remember this for later', 'jot this down', 'make a note', or '/note <project> <text>'. Also use proactively when the user states something clearly durable that another agent will need later. '/note triage <project>' (or 'triage/clean up the notes for X') drains a project's open notes into their permanent homes."
---

# Note

File one note through docsic. Open notes are injected at session start (and on a project's first mention, with a hub) until absorbed - that is the note -> pickup pipeline; keep notes worth injecting.

## Procedure

1. **Resolve the project**: from the argument, the conversation, or the cwd. The note belongs to a repo: use that repo's root as `cwd` for the tool call (for another project, its repo path). If genuinely ambiguous, ask.

2. **Classify**: `discovery` (learned fact), `gotcha` (trap/quirk), `decision` (call made), `idea` (unvetted). If the content is actually *in-flight state* (build numbers, pending reviews), update state instead: `docsic_save` with `kind: "state"`.

3. **Write**: `docsic_save` with `kind: "note"`, `cwd: <repo root>`, `title` (short, imperative), `type`, and `content` = at most 10 lines: the fact, why it matters, concrete links (file paths, PR/issue URLs). docsic stores it in the right place (the hub project folder when one is configured, else the local store) and syncs the hub itself.

4. Confirm to the user in one line: what was noted and for which project.

## Absorbing notes

Notes are an **inbox, not a shelf** - every note is in transit to a permanent home, and absorbing means the content arrived there:

- `decision` -> the project's decision record (a `decisions.md` row in the hub, or the repo's docs)
- `idea` -> a GitHub issue on the project repo, or deliberately dropped
- `gotcha` / `discovery` -> folded into the project repo's `docs/` where it contextually belongs (or auto-memory if behavioral); may stay open while genuinely still useful at session start

When a session acts on an open note, move the content to its destination, then `docsic_save` with `kind: "absorb"`, `content: <note filename>`, `absorbedInto: <where it went>`. Do this proactively when you notice a surfaced note has been handled - open notes should trend toward zero.

## Triage (`/note triage <project>`)

Open notes pile up faster than sessions absorb them, and every open note costs injection budget in every session. Triage drains the inbox in one pass.

1. **List** the project's open notes, oldest first (docsic's injection names the notes directory; read each file whole - they are at most 10 lines).
2. **Decide one action per note**, checking the claim against the code or the tracker when that's cheap (a grep, `gh issue list`, `git log -S`):
   - `decision` -> a row in the hub's `decisions.md` (`| date | decision | reasoning |`), or the repo doc that owns the area
   - `idea` -> a GitHub issue on the project repo, unless an open issue already covers it
   - `gotcha` / `discovery` still true -> folded into the repo doc that owns the area (or repo `CLAUDE.md` if it fits no doc); still true AND worth reading at every session start -> keep open
   - anything resolved, superseded, duplicated, or really in-flight state (build numbers, PRs awaiting review - state.md owns those) -> drop
3. **Confirm once**: show a compact table (note title -> action -> destination) with counts per action, and wait for the user's go. This is the only question; issue creation and drops are why it exists.
4. **Execute**: decision rows and issues directly; all repo-doc folds together in one docs change in a task worktree, shipped via `/pr-create` (Simple tier). Then `docsic_save` `kind: "absorb"` for every handled note, with `absorbedInto` naming the destination (`decisions.md`, `issue #N`, `docs/<doc>.md (PR #N)`, or `dropped: <reason>`), and run any post-step your personal instructions define for hub edits.
5. **Report** one line: `<project>: N -> M open notes (a decisions, b issues, c folded into docs, d dropped, e kept)`.

