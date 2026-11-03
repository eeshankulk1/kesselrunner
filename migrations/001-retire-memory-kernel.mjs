// One-time cleanup for machines set up before docsic took over memory:
// drop the memory-kernel, pre-rename ctx, and old dotclaude-sync hooks from
// settings.json, and the pre-rename `ctx` MCP server. dotclaude adds the
// current hooks right after migrations run.
import { join } from "node:path";

const LEGACY = [/scripts\/memory-kernel\//, /ctx\/dist\/cli\.js"? hook /, /scripts\/dotclaude-sync\/sync\.mjs/];

export default function ({ claudeDir, readJson, writeJson, sh, log }) {
  const p = join(claudeDir, "settings.json");
  const s = readJson(p, {});
  let dropped = 0;
  for (const [event, entries] of Object.entries(s.hooks ?? {})) {
    const kept = entries
      .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !LEGACY.some((re) => re.test(String(h.command))) || (dropped++, false)) }))
      .filter((e) => e.hooks.length);
    if (kept.length) s.hooks[event] = kept; else delete s.hooks[event];
  }
  if (dropped) { writeJson(p, s); log.change(`removed ${dropped} legacy hook(s)`); }
  try { sh("claude", ["mcp", "remove", "--scope", "user", "ctx"]); log.change("removed legacy ctx MCP server"); } catch { /* not registered */ }
}
