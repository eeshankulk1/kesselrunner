// Effort levels: which ones each harness takes. A worker starts on the effort its task names, checked here against
// its harness's own list.

/** Claude Code's effort levels, lowest first (`--effort`, settings `effortLevel`). */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Codex's reasoning efforts, lowest first (`model_reasoning_effort`, `turn/start`'s `effort`). Codex has no `max`. */
export const CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];

/** The levels harness `h` takes at all, lowest first. */
export const effortsOf = (h) => (h === "codex" ? CODEX_EFFORTS : CLAUDE_EFFORTS);
/** Whether `e` is a level harness `h` takes. */
export const effortOk = (e, h = "claude") => typeof e === "string" && effortsOf(h).includes(e);
