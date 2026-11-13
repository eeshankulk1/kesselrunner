---
name: handoff
description: "Hand this session's work to the next session, or pick up where the last one stopped. Out: writes the prompt the next session starts from - the owner's decisions and the state of the work, never directions on tools or steps. Resume: finds the last session's worktree, branch, PR, where-I-am note and last report, and starts from them. Trigger when: 'write a handoff', 'handoff prompt', 'hand this off', '/handoff'; 'continue where the last agent left off', 'pick up where we left off', 'resume the last session', '/handoff resume'."
---

# Handoff

For sessions with no supervisor. A supervisor's worker hands off through rollcall, as its brief says.

## Out: `/handoff`

1. Commit what is in flight (a WIP commit is fine). Let background work finish, or stop it.
2. Write the prompt the next session starts from, in plain words:
   - **The owner's decisions**: what they asked for and what they settled, in their words where it matters, and what they ruled out.
   - **The state of the work**: repo, worktree path, branch, PR link; what is done, what is half-done, what remains; the files that matter and what each is for; questions still open to the owner.
   - **Nothing on how to do the rest**: no tools, no order of steps, no vendor or library picks. The next session makes those choices after its own look at the code. A finding is fine ("the flaky test is a race in X"); a direction is not ("use Y to fix it").
3. Where it goes:
   - Inside a rollcall task (`rollcall task show here` prints one): `rollcall task handoff here --file <f>`, then end your turn. rollcall starts the fresh worker from it.
   - Anywhere else: give the owner the prompt alone in one fenced block, ready to paste. Where docsic memory is on, also bring the project's state up to date (`docsic_save`, kind `state`), so a resume finds it without the prompt.

## Resume: `/handoff resume [repo, branch or PR]`

A prompt the owner pasted wins: start from it. Otherwise gather the last session's record, read it, then carry on:

- `git worktree list` in the repo: the worktree named, else the one changed most recently. Its branch, `git log --oneline origin/<default>..HEAD` and `git status --short`.
- `gh pr list --head <branch> --state all`: its PR, and whether it is open, merged or closed.
- `rollcall task show here` from inside that worktree, when it belongs to a task: the owner's words, the where-I-am note, the notes, the last report.
- The project's docsic state (injected at session start, or `docsic_load`).

Say in two or three lines where the work stands and what is next, then carry on. Ask first only when the owner's decisions leave a real choice open.
