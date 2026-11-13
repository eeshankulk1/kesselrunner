// Every agent call names its model. An Agent call with no model runs on the session's own (Opus for most
// sessions), and in 30 days unnamed general-purpose runs doing test, review and docs work were about 6% of all
// spend, beside named Sonnet agents built for exactly that work. So this refuses two calls, with the fix:
//   - an agent that has no model of its own (general-purpose, Explore, Plan, or an agents/*.md without a
//     `model:` line) called without `model`;
//   - a general-purpose call whose description says it reviews, tests, verifies or writes docs, whatever its
//     model: the named agents hold the brief and the model for that work.
// A named agent with a `model:` line, a fork (it always runs on the session's model, by design) and agents
// this cannot see (plugins) pass. The rule itself is in the core CLAUDE.md, "Delegation".
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const tools = /^(Agent|Task)$/;

const BUILT_IN = new Set(["general-purpose", "Explore", "Plan"]);
// The description's first words, where a worker names the job ("Review the auth diff", "Run tests", "Update docs").
const CHECK_WORK = /^\s*(re-?review|review|verify|validate|run\s+(the\s+)?(\w+\s+)?tests?|test|update\s+(the\s+)?docs|write\s+(the\s+)?docs|docs?)\b|\b(code review|docs? (pass|update|sweep))\b/i;

/** The model an agent's own file names: a string, "" when the file has none (or says inherit), null when no file was found. */
function fileModel(name, cwd) {
  if (!/^[\w-]+$/.test(name)) return null;
  const dirs = [cwd && join(cwd, ".claude", "agents"), join(process.env.HOME || homedir(), ".claude", "agents")];
  for (const dir of dirs) {
    const f = dir && join(dir, `${name}.md`);
    if (!f || !existsSync(f)) continue;
    let model = "";
    try {
      const front = readFileSync(f, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
      model = front.match(/^model:\s*["']?([\w.[\]-]+)/m)?.[1] ?? "";
    } catch {}
    return model === "inherit" ? "" : model;
  }
  return null;
}

const FIX = "Name the model on the call: \"opus\" for an agent that implements, plans or decides; \"sonnet\" for reading, searching and research. Test, review and docs work goes to the named agents, which run on Sonnet and carry the brief for it: test-runner (run and diagnose tests), test-updater (fix tests after a change), code-reviewer (review), docs-updater (docs). A search across many files goes to code-scout, web research to web-researcher. See \"Delegation\" in the global instructions.";

export function check(payload) {
  if (!tools.test(String(payload.tool_name ?? ""))) return null;
  const input = payload.tool_input ?? {};
  const type = String(input.subagent_type ?? "").trim() || "general-purpose";
  if (type === "fork") return null;
  const model = String(input.model ?? "").trim();
  if (type === "general-purpose" && CHECK_WORK.test(String(input.description ?? ""))) {
    return `[kesselrunner] Agent call refused: "${input.description}" is test, review or docs work, which goes to a named agent, not general-purpose. ${FIX}`;
  }
  if (model) return null;
  const own = BUILT_IN.has(type) ? "" : fileModel(type, payload.cwd);
  if (own !== "") return null; // its file names a model, or this agent is not one we can see
  return `[kesselrunner] Agent call refused: ${type} has no model of its own, so it would run on this session's model. ${FIX}`;
}
