// PreToolUse guards: modules a user adds to deny tool calls, run by the one PreToolUse entry
// (scripts/hooks/pre-tool-use.mjs) in the same process as rollcall. A guard is a file in
// hooks/pre-tool-use/ of the core or of the overlay (the overlay's win on a shared name), run in
// file-name order:
//
//   export const tools = /^(Bash|Monitor)$/;     // optional: the tool names it sees (default: the shell tools)
//   export function check(payload, kit) { ... }  // a deny reason (string), or null to stay out of it
//
// kit is the shell lexer guards share (lib/shell-scan.mjs: SHELL, commandText, scan) plus `core`, the
// core's directory, so a guard in an overlay needs no import path into the core.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SHELL_TOOLS = /^(Bash|Monitor)$/;
/** The tools rollcall's part of the entry answers for. */
export const ROLLCALL_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/;

/** The guard files of the core and the overlay, sorted by file name; an overlay file replaces a core one of the same name. */
export function guardFiles(core, overlay) {
  const byName = new Map();
  for (const root of [core, overlay]) {
    const dir = root && join(root, "hooks", "pre-tool-use");
    if (!dir || !existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (/\.m?js$/.test(f) && !f.startsWith(".")) byName.set(f, join(dir, f));
  }
  return [...byName.keys()].sort().map((f) => byName.get(f));
}

/**
 * The PreToolUse entry's matcher: rollcall's tools plus each guard's. Claude Code tests a matcher with
 * regex characters unanchored, so each part stays anchored as its module wrote it. A guard that fails
 * to load adds nothing (the entry skips it at run time too).
 */
export async function preToolMatcher(core, overlay) {
  const parts = [ROLLCALL_TOOLS.source];
  for (const f of guardFiles(core, overlay)) {
    try {
      const src = ((await import(pathToFileURL(f).href)).tools ?? SHELL_TOOLS).source;
      if (!parts.includes(src)) parts.push(src);
    } catch {}
  }
  return parts.join("|");
}
