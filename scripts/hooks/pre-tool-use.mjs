#!/usr/bin/env node
// PreToolUse for every tool kesselrunner watches, in one process: the guards (lib/guards.mjs: the modules in
// hooks/pre-tool-use/ of the core and the overlay), then rollcall. Each guard was a node process of its own on
// every Bash call: several starts, 25 ms each on a quiet Mac and several hundred under load. One start now
// runs them all, each on the tools it names and with its own decision. A guard that crashes, or whose file
// does not load, allows, and the others still run; a guard's deny is final and skips rollcall; rollcall
// answers within its budget or says nothing, as its own hook did. ROLLCALL_DISABLE turns off rollcall's part
// only. The overlay's directory is the first argument (sync writes it into the hook command; empty without one).
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { denyOutput, readPayload } from "../../lib/hook-io.mjs";
import { ROLLCALL_TOOLS, SHELL_TOOLS, guardFiles } from "../../lib/guards.mjs";

const CORE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const overlay = process.argv[2] || null;

const payload = await readPayload();
if (!payload || typeof payload !== "object") process.exit(0); // not a payload these hooks understand
const tool = String(payload.tool_name ?? "");
// A payload with a command and no tool name is a shell call, as each guard read it alone.
const shell = !tool && payload.tool_input?.command != null;
const reasons = [];
let kit;
for (const f of guardFiles(CORE, overlay)) {
  try {
    const g = await import(pathToFileURL(f).href);
    // The tools a guard names are anchored as it wrote them: a matcher with regex characters (the entry's
    // own) is tested unanchored, so TodoWrite or an MCP tool named ...WriteFile reaches this script and must
    // not reach a guard that never asked for it.
    if (!(g.tools ?? SHELL_TOOLS).test(tool) && !shell) continue;
    kit ??= { ...(await import("../../lib/shell-scan.mjs")), core: CORE };
    const r = await g.check(payload, kit);
    if (r) reasons.push(r);
  } catch (e) {
    process.stderr.write(`kesselrunner: guard ${f} failed and allowed: ${e?.message ?? e}\n`); // visible in Claude Code's hook output, never a deny
  }
}
if (reasons.length) {
  process.stdout.write(denyOutput(reasons.join("\n\n")));
  process.exit(0);
}
if (ROLLCALL_TOOLS.test(tool)) {
  try {
    const rollcall = await import("../../packages/rollcall/src/entry.mjs");
    if (!rollcall.disabled()) {
      setTimeout(() => process.exit(0), Number(process.env.ROLLCALL_HOOK_BUDGET_MS) || 3000).unref();
      const out = await rollcall.hookAnswer("pre-tool-use", payload);
      if (out) process.stdout.write(out);
    }
  } catch {}
}
process.exit(0);
