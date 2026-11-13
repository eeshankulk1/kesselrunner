// The usage report's reader: one Claude Code transcript file in, the numbers the report needs out. It keeps no
// message text: a first prompt becomes an agent class, an owner's prompt a yes or no for "a correction", a tool call
// its category and a few flags. Runs in worker threads (usage-report.mjs starts them), or inline for tests.
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { parentPort, workerData, isMainThread } from "node:worker_threads";

/** Shell commands that only read files: a request whose one call is one of these is a "single read". */
const READ_HEADS = new Set(["cat", "sed", "head", "tail", "grep", "rg", "ls", "find", "wc", "nl", "less", "awk", "jq", "tree", "stat", "file"]);
const BROWSER = ["mcp__plugin_playwright", "mcp__plugin_chrome-devtools", "mcp__claude-in-chrome", "mcp__Claude_Browser", "mcp__playwright"];

/** A Bash command's head: its first word after `cd x &&` and `VAR=x` prefixes, sorted into a category. */
export function bashHead(cmd) {
  let c = String(cmd ?? "").trim();
  for (let i = 0; i < 5; i++) {
    const cd = c.match(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/);
    if (cd) { c = c.slice(cd[0].length).trim(); continue; }
    const env = c.match(/^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/);
    if (env) { c = c.slice(env[0].length).trim(); continue; }
    break;
  }
  const h = basename(c.split(/\s+/)[0] ?? "").replace(/^\(+/, "").replace(/^["']+|["']+$/g, "");
  if (/\bsleep\b|\bwatch\b|\bwait\b|--watch|\buntil\b|\bwhile\b/.test(String(cmd).slice(0, 400))) return "sleep/wait/watch";
  if (h === "git" || h === "gh" || h === "rollcall" || h === "docsic" || h === "curl") return h;
  if (["xcodebuild", "swift", "swiftc", "xcrun", "iosim", "xcbeautify"].includes(h)) return "xcode/swift";
  if (["npm", "pnpm", "node", "npx", "yarn", "bun", "tsc", "vitest", "jest", "next"].includes(h)) return "node";
  if (["pytest", "python", "python3", "uv", "pip", "pip3", "ruff", "mypy"].includes(h)) return "python";
  if (READ_HEADS.has(h)) return `read:${h}`;
  return "other";
}

/** A tool call's category: "Bash:git", "Agent:code-reviewer", "Read", "Browser", "MCP:docsic", ... */
export function category(name, input) {
  const i = input ?? {};
  if (name === "Bash") return `Bash:${bashHead(typeof i.command === "string" ? i.command : "")}`;
  if (name === "Agent" || name === "Task") return `Agent:${i.subagent_type || "general-purpose"}`;
  if (name === "Skill") return `Skill:${i.skill}`;
  if (["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(name)) return "Edit/Write";
  if (name === "Grep" || name === "Glob") return "Grep/Glob";
  if (name === "Read") return "Read";
  if (name === "WebSearch" || name === "WebFetch") return "Web";
  if (name?.startsWith("mcp__")) return BROWSER.some((b) => name.startsWith(b)) ? "Browser" : `MCP:${name.split("__")[1]}`;
  return `Tool:${name}`;
}

const isRead = (cat) => cat === "Read" || cat === "Grep/Glob" || cat.startsWith("Bash:read:");

/** The ship events a Bash command marks: a push, a CI wait, a failed-log read, the merge queue, a handoff. */
export function bashFlags(cmd) {
  const c = String(cmd ?? "").trim().replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, "").slice(0, 400);
  const f = [];
  if (/(^|[;&|]\s*)git\s+push\b/.test(c)) f.push("push");
  if (/gh\s+(pr\s+checks|run\s+watch|run\s+view)/.test(c)) f.push("ciwait");
  if (/--log-failed/.test(c)) f.push("cifail");
  if (/rollcall\s+queue\b/.test(c) || /gh\s+pr\s+merge\b/.test(c)) f.push("queue");
  if (/^rollcall\s+task\s+handoff\b/.test(c)) f.push("handoff");
  if (/gh\s+pr\s+create\b/.test(c)) f.push("propen");
  return f;
}

/**
 * Corrections: an owner's prompt that pushes back ("I told you", "that's not what I asked", "stop asking"). Phrase
 * matching, so a lower bound; the same patterns the 2026-11-12 study used.
 */
const CORRECTION = /(\bi (already )?(said|told you|asked|just said|meant)\b|how many times|for the love of|so sick|\bagain[?!.]|you keep\b|you (still )?(didn.t|did not|forgot|never)\b|why (did|are|do) you\b|why didn.t you|stop (asking|saying|doing|hand)|don.t (ask|be|do|give|use|say|make|add|worry|obsess|just)|\bdont (ask|be|do|give|use|say|make|add|worry|obsess|just)|not what i (meant|asked|said)|that.s not (what|it|right)|thats not (what|it|right)|why is this (still|taking)|\bno,? (dude|i|that|not|don|just)|\bwait,? (what|no|why)|\bnope\b|babysit|hand.?wav|you should (have|not|be)|shouldn.t (have|you)|i didn.t (ask|say|want)|i don.t want you)/i;
/** A prompt a program typed, not the owner: rollcall's own lines, Claude Code's command echoes. */
export const isMachine = (text) => /^\s*(\[rollcall\]|<task-notification|<command-|<local-command|Caveat: The messages below)/.test(text);
export const isCorrection = (text) => text.length > 0 && text.length <= 700 && CORRECTION.test(text);

/**
 * A subagent's class from its first prompt. A caller's marker wins: `[role: <name>]` in the prompt's first 500
 * characters (pr-create's shipper prompt carries `[role: shipper]`). Without one, the study's keyword tests.
 */
export function agentClass(agentType, prompt) {
  const t = String(prompt ?? "").slice(0, 30000).toLowerCase();
  const marked = t.slice(0, 500).match(/\[role:\s*([a-z0-9_-]+)\s*\]/);
  if (marked) return { cls: marked[1], marked: true };
  if (agentType && agentType !== "general-purpose") return { cls: agentType, marked: false };
  if (t.includes("you are the shipper") || t.includes("pr-create")) return { cls: "shipper", marked: false };
  const edits = /\b(edit|write|implement|fix|modify|create|change|update|commit)/.test(t);
  if (t.includes(".claude/worktrees/") && /\b(implement|build|fix)/.test(t)) return { cls: "implementer", marked: false };
  if (/\b(research|investigate|find|audit|compare)/.test(t) && !edits) return { cls: "research", marked: false };
  return { cls: "other", marked: false };
}

const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text ?? "").join(" ") : "");
const ms = (iso) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? t : 0; };

/**
 * Read one transcript. `root` is Claude Code's projects folder; the path below it says whether this is a main session
 * (`<project>/<session>.jsonl`) or a subagent (`<project>/<session>/subagents/agent-<id>.jsonl`). Requests come back
 * whole (window filtering is the report's), one per API message id: a response written as several lines counts once,
 * each field the largest any of its lines carried.
 */
export async function scanFile(path, root) {
  const rel = relative(root, path).split(sep);
  const sub = rel.includes("subagents");
  const out = {
    path, project: rel[0], sid: sub ? rel[1] : basename(rel[1] ?? "", ".jsonl"), sub,
    agentType: null, cls: null, marked: false, cwd: null, entry: null,
    reqs: [], humans: [], compacts: 0, costRuns: {},
  };
  if (sub) {
    try { out.agentType = JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8")).agentType ?? null; } catch {}
  }
  const byId = new Map();
  let firstPrompt = null;
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const a = line.includes('"type":"assistant"'), u = line.includes('"type":"user"');
    const s = line.includes('"type":"system"'), c = line.includes('"type":"cost-state"');
    if (!a && !u && !s && !c) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "cost-state") {
      // Session totals so far, main and subagents together; a resumed run starts its own (a new startTime).
      const run = String(d.startTime ?? "?");
      const per = {};
      for (const [m, v] of Object.entries(d.modelUsage ?? {})) per[m] = v?.outputTokens ?? 0;
      out.costRuns[run] = { usd: d.totalCostUSD ?? 0, out: per };
      continue;
    }
    if (d.type !== "assistant" && d.type !== "user" && d.type !== "system") continue;
    out.cwd ??= d.cwd ?? null;
    out.entry ??= d.entrypoint ?? null;
    if (d.type === "system") { if (d.subtype === "compact_boundary") out.compacts++; continue; }
    if (d.type === "user") {
      const m = d.message?.content;
      if (Array.isArray(m) && m.some((b) => b?.type === "tool_result")) continue;
      if (d.isMeta || d.isCompactSummary) continue;
      const kind = d.origin?.kind;
      if (kind === "task-notification" || kind === "peer") continue;
      const text = textOf(m);
      if (firstPrompt === null) firstPrompt = text;
      if (!sub && !isMachine(text)) out.humans.push({ ts: ms(d.timestamp), corr: isCorrection(text) });
      continue;
    }
    const msg = d.message ?? {};
    const id = msg.id, us = msg.usage;
    if (!id || !us) continue;
    let r = byId.get(id);
    if (!r) {
      r = { ts: ms(d.timestamp), model: msg.model ?? "?", effort: d.effort ?? null, inp: 0, w1: 0, w5: 0, cr: 0, out: 0, cats: [], flags: [] };
      byId.set(id, r);
      out.reqs.push(r);
    }
    const cc = us.cache_creation ?? {};
    let w1 = cc.ephemeral_1h_input_tokens, w5 = cc.ephemeral_5m_input_tokens;
    if (w1 == null && w5 == null) { w1 = 0; w5 = us.cache_creation_input_tokens ?? 0; }
    r.inp = Math.max(r.inp, us.input_tokens ?? 0);
    r.w1 = Math.max(r.w1, w1 ?? 0);
    r.w5 = Math.max(r.w5, w5 ?? 0);
    r.cr = Math.max(r.cr, us.cache_read_input_tokens ?? 0);
    r.out = Math.max(r.out, us.output_tokens ?? 0);
    for (const b of msg.content ?? []) {
      if (b?.type !== "tool_use") continue;
      r.cats.push(category(b.name, b.input));
      if (b.name === "Bash") for (const f of bashFlags(b.input?.command)) if (!r.flags.includes(f)) r.flags.push(f);
    }
  }
  if (sub) Object.assign(out, agentClass(out.agentType, firstPrompt));
  for (const r of out.reqs) {
    r.single = r.cats.length === 1;
    r.singleRead = r.single && isRead(r.cats[0]);
  }
  return out;
}

/** Every transcript under `root` changed at or after `since` (ms): main sessions and their subagents. */
export function listFiles(root, since = 0) {
  const files = [];
  const fresh = (p) => { try { return statSync(p).mtimeMs >= since; } catch { return false; } };
  let projects = [];
  try { projects = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return files; }
  for (const p of projects) {
    const dir = join(root, p);
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jsonl")) { const f = join(dir, e.name); if (fresh(f)) files.push(f); }
      else if (e.isDirectory()) {
        const sd = join(dir, e.name, "subagents");
        let subs = [];
        try { subs = readdirSync(sd); } catch { continue; }
        for (const s of subs) if (s.endsWith(".jsonl")) { const f = join(sd, s); if (fresh(f)) files.push(f); }
      }
    }
  }
  return files;
}

// Worker thread: scan the files it was handed, post the results back.
if (!isMainThread && workerData?.usageScan) {
  const { files, root } = workerData;
  const results = [];
  for (const f of files) {
    try { results.push(await scanFile(f, root)); } catch {}
  }
  parentPort.postMessage(results);
}
