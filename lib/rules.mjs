// Optional rules: instruction files in the core's or the overlay's rules/ that a user switches
// on with `kesselrunner rules on <name>`. Sync adds the ones that are on to the
// managed CLAUDE.md block, the one file every writer reads: the main session,
// its subagents, and Codex (the bridge copies CLAUDE.md into AGENTS.md). The
// choice lives in ~/.claude/settings.json under env, like the delegation backend.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgent } from "./agents.mjs";
import { knob } from "./legacy.mjs";

export const RULES_KEY = "KESSELRUNNER_RULES"; // read with its old name DOTCLAUDE_RULES as a fallback

/** [{ name, description, body }] for each rules/<name>.md in the core and the overlay (the overlay's win on a shared name), sorted by name. */
export function listRules(core, overlay) {
  const byName = new Map();
  for (const root of [core, overlay]) {
    const dir = root && join(root, "rules");
    if (!dir || !existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".md") && !f.startsWith(".")) byName.set(f.slice(0, -3), join(dir, f));
  }
  return [...byName.keys()].sort().map((name) => {
    const raw = readFileSync(byName.get(name), "utf8");
    const parsed = parseAgent(raw);
    return { name, description: parsed?.get("description") ?? "", body: (parsed?.body ?? raw).trim() };
  });
}

/**
 * Names switched on, from settings.json's env (comma-separated). Callers pass
 * the file's env, never process.env: a session's environment is as old as the
 * session, so a toggle run inside one would read the value it is replacing.
 */
export const enabledRules = (env) => String((env && knob("RULES", env)) ?? "").split(",").map((n) => n.trim()).filter(Boolean);

/** A rule as it appears in CLAUDE.md: its text, then how to switch it off. */
export const ruleSection = ({ name, body }) => `${body}\n\nOptional rule \`${name}\`: \`kesselrunner rules off ${name}\` turns it off.`;
