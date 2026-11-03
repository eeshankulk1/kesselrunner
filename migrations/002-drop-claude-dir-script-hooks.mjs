// Hooks from the symlinked-~/.claude era called scripts as $HOME/.claude/scripts/...
// Now that ~/.claude is a real directory those paths no longer exist (the scripts
// live in the core, and dotclaude owns the current hook entries), so drop them.
import { join } from "node:path";

const OLD = /(\$HOME|~|\/Users\/[^/]+|\/home\/[^/]+)\/\.claude\/scripts\//;

export default function ({ claudeDir, readJson, writeJson, log }) {
  const p = join(claudeDir, "settings.json");
  const s = readJson(p, {});
  let dropped = 0;
  for (const [event, entries] of Object.entries(s.hooks ?? {})) {
    const kept = entries
      .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !OLD.test(String(h.command)) || (dropped++, false)) }))
      .filter((e) => e.hooks.length);
    if (kept.length) s.hooks[event] = kept; else delete s.hooks[event];
  }
  if (dropped) { writeJson(p, s); log.change(`removed ${dropped} hook(s) pointing at ~/.claude/scripts`); }
}
