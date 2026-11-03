// What a command hook does around its decision: read the payload from stdin and answer on stdout. A guard's
// decision is a function of the payload, so kesselrunner's per-event hook entry (scripts/hooks/) can run
// several in one process, and each guard still runs as a script of its own (its tests, Codex).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Whether the module at `url` is the script node started (not one imported by another). */
export function isMain(url) {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url)); } catch { return false; }
}

/** The hook payload on stdin, parsed; null when there is none or it is not JSON. */
export async function readPayload() {
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    return JSON.parse(raw);
  } catch { return null; }
}

/** A PreToolUse deny, as Claude Code reads it from stdout. */
export const denyOutput = (reason) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

/** Context added after a tool call, as Claude Code reads it from stdout. */
export const contextOutput = (event, text) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
