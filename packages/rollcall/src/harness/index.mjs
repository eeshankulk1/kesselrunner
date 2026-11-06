// The harness layer: which agent CLI runs a task's worker, and the one module per CLI that knows how. A task
// names its harness (`task new --harness codex`, "on codex" in the owner's words), else the default
// (ROLLCALL_WORKER_HARNESS, set in the owner's settings `env`), else Claude Code. Each worker session records the
// harness it ran on, so a task moved to the other harness still resumes its earlier sessions on theirs.
//
// Every adapter exports the same shape:
//   name, title                      "claude", "Claude Code"
//   available()                      { ok, err }: the CLI is installed (and signed in, where that can be read)
//   writeLaunch(t, opts)             the worker's launch files; returns { script, session, thread? }
//   trusted(t)                       whether the CLI will start in the task's worktree without asking, or null
//   type(t, text, { before })        rollcall's words into the worker, as its next prompt; { ok, err }
//   interrupt(t)                     stops the worker's turn; true when the stop went out
//   takesTyping(t, w, now)           the harness's own part of "can take words now" (delivery.canTake)
//   transcriptOf(w)                  the worker session's transcript file, or null
//   models                           { ok(m), map(model) }: which model names it takes
//   questionTool, trustPrompt        how the brief names its question tool and its first-run prompt
import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";

export const HARNESSES = { claude, codex };
export const NAMES = Object.keys(HARNESSES);

/** "codex", "Codex", "on codex": the harness a word names, or null. */
export function harnessName(word) {
  const w = String(word ?? "").trim().toLowerCase().replace(/^on\s+/, "");
  if (w === "claude" || w === "claude-code" || w === "claude code" || w === "cc") return "claude";
  if (w === "codex" || w === "openai") return "codex";
  return null;
}

/** The harness new tasks run on when they name none: the owner's setting, else Claude Code. */
export const defaultHarness = (env = process.env) => harnessName(env.ROLLCALL_WORKER_HARNESS) ?? "claude";

/** Task `t`'s harness: its own, else the default when it was made (a task from before harnesses ran on Claude Code). */
export const harnessOf = (t) => harnessName(t?.harness) ?? "claude";

/** The harness worker session `s` ran on (sessions from before the layer ran on Claude Code). */
export const sessionHarness = (s) => harnessName(s?.harness) ?? "claude";

/** The adapter for harness `name` (a name, a task or a session). */
export function adapter(x) {
  const name = typeof x === "string" ? harnessName(x) : x?.sessions ? harnessOf(x) : sessionHarness(x);
  return HARNESSES[name ?? "claude"];
}

/** The adapter that runs task `t`'s live worker now: its last session's, else the task's. */
export function workerAdapter(t) {
  const s = t?.sessions?.at(-1);
  return s && !s.endedAt ? adapter(sessionHarness(s)) : adapter(harnessOf(t));
}

/** The efforts both harnesses take, lowest first. A worker's effort means the same on either. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const effortOk = (e) => EFFORTS.includes(e);
