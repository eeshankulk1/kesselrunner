#!/usr/bin/env node
// PostToolUse in one process: deploy-watch's follow-up to a merge (Bash), then rollcall's (edits, Bash, the
// picker). They were a node process each on every Bash call. Each runs on the tools its own hook entry
// matched; their context lines go out together. rollcall answers within its budget, or deploy-watch's line
// goes out alone. ROLLCALL_DISABLE turns off rollcall's part only.
import { contextOutput, readPayload } from "../../lib/hook-io.mjs";

const payload = await readPayload();
if (!payload || typeof payload !== "object") process.exit(0);
const tool = String(payload.tool_name ?? "");
const parts = [];
const answer = () => {
  if (parts.length) process.stdout.write(contextOutput("PostToolUse", parts.join("\n\n")));
  process.exit(0);
};
// Exact tool names, as the two entries matched them.
if (tool === "Bash") {
  try { const c = (await import("../deploy-watch/post-merge.mjs")).check(payload); if (c) parts.push(c); } catch {}
}
if (/^(Edit|Write|MultiEdit|NotebookEdit|Bash|AskUserQuestion)$/.test(tool)) {
  try {
    const rollcall = await import("../../packages/rollcall/src/entry.mjs");
    if (!rollcall.disabled()) {
      setTimeout(answer, Number(process.env.ROLLCALL_HOOK_BUDGET_MS) || 3000).unref();
      const out = await rollcall.hookAnswer("post-tool-use", payload);
      const ctx = out ? JSON.parse(out)?.hookSpecificOutput?.additionalContext : null;
      if (ctx) parts.push(ctx);
      else if (out && !parts.length) { process.stdout.write(out); process.exit(0); }
    }
  } catch {}
}
answer();
