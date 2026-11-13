// The usage report: where Claude Code spend went over a date range, read from the transcripts Claude Code keeps
// (~/.claude/projects), and the shapes the harness plans act on (context size, idle gaps, handoffs, single-call
// requests, ship stages) plus cheap quality signals. A range can be saved as a baseline and a later one compared
// against it. Aggregates only: no message text is kept or printed.
//
// Spend is in weighted units, the same weights the 2026-11-12 study used, so a share stays comparable across ranges
// and price changes: tokens weigh input 1, cache write (5 min) 1.25, cache write (1 h) 2, cache read 0.1, output 5;
// models weigh Haiku 1, Sonnet 3, Opus 5, Fable 10. "M" is millions of those units.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import * as store from "./store.mjs";
import { listFiles, scanFile } from "./usage-scan.mjs";

const TOKEN_W = { inp: 1, w5: 1.25, w1: 2, cr: 0.1, out: 5 };
export function modelWeight(m) {
  m = m ?? "";
  if (m.includes("haiku")) return 1;
  if (m.includes("sonnet")) return 3;
  if (m.includes("opus")) return 5;
  if (m.includes("fable") || m.includes("mythos")) return 10;
  return 0; // "<synthetic>": no API call
}
const weighted = (r) => modelWeight(r.model) * (r.inp * TOKEN_W.inp + r.w5 * TOKEN_W.w5 + r.w1 * TOKEN_W.w1 + r.cr * TOKEN_W.cr + r.out * TOKEN_W.out);
const ctx = (r) => r.inp + r.cr + r.w1 + r.w5;
const DAY = 86_400_000;

/** Where Claude Code keeps transcripts. */
export const transcriptsDir = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");

/** A range from CLI words: `--from 2026-10-13 --to 2026-11-12`, or `--days 30` back from today (UTC days, `to` included). */
export function rangeOf({ from, to, days } = {}, now = Date.now()) {
  const day = (s) => { const t = Date.parse(`${s}T00:00:00Z`); if (!Number.isFinite(t)) throw new Error(`not a date: ${s} (use YYYY-MM-DD)`); return t; };
  const today = Math.floor(now / DAY) * DAY;
  const end = to ? day(to) + DAY : today + DAY;
  const start = from ? day(from) : end - (Number(days) > 0 ? Number(days) : 30) * DAY;
  if (start >= end) throw new Error("the range is empty: --from must be on or before --to");
  return { from: start, to: end };
}
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

/** Scan every transcript that may hold requests in the range, in worker threads. */
export async function scanAll({ root = transcriptsDir(), from = 0, threads } = {}) {
  const files = listFiles(root, from);
  const n = Math.max(1, Math.min(threads ?? Math.max(1, availableParallelism() - 1), 8, files.length));
  if (n === 1 || files.length < 20) {
    const out = [];
    for (const f of files) { try { out.push(await scanFile(f, root)); } catch {} }
    return out;
  }
  // Even out the bytes per worker: the largest files first, each to the lightest worker.
  const sized = files.map((f) => { let s = 0; try { s = statSync(f).size; } catch {} return [f, s]; }).sort((a, b) => b[1] - a[1]);
  const chunks = Array.from({ length: n }, () => ({ files: [], bytes: 0 }));
  for (const [f, s] of sized) { const c = chunks.reduce((a, b) => (b.bytes < a.bytes ? b : a)); c.files.push(f); c.bytes += s; }
  const url = new URL("./usage-scan.mjs", import.meta.url);
  const parts = await Promise.all(chunks.map((c) => new Promise((resolve, reject) => {
    const w = new Worker(url, { workerData: { usageScan: true, files: c.files, root } });
    w.once("message", resolve);
    w.once("error", reject);
    w.once("exit", (code) => { if (code !== 0) reject(new Error(`scan worker exited ${code}`)); });
  })));
  return parts.flat();
}

// Small statistics, matching the study's: the median averages the middle pair, a percentile takes the element at n*p.
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pctile = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const pct = (x, total) => (total ? Math.round((1000 * x) / total) / 10 : 0);
const M = (x) => Math.round(x / 1e5) / 10;
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

function laneOf(f) { return f.sub ? "subagent" : !f.entry || f.entry === "cli" ? "main" : "headless"; }
function kindOf(cwd) {
  const c = cwd ?? "";
  if (c.includes("/_supervisors")) return "supervisor";
  if (c.includes("/.claude/worktrees/")) return "task-worker";
  return "plain";
}
/** The repo a cwd belongs to (a worktree collapsed to its repo), by folder name. */
export function projectOf(cwd, fallback = "?") {
  if (!cwd) return fallback;
  const c = cwd.split("/.claude/worktrees/")[0];
  if (c.includes("/_supervisors")) return "(supervisors)";
  if (/^(\/private)?\/tmp\b|\/var\/folders\//.test(c)) return "(scratch)";
  if (c === homedir()) return "~";
  return c.split("/").filter(Boolean).pop() ?? fallback;
}
/** What ran a subagent: the shipper, an implementer, a named helper (code-reviewer, ...), or an unnamed run. */
function agentGroup(f) {
  if (!f.sub) return laneOf(f) === "main" ? "main loop" : "headless";
  if (f.agentType && f.agentType !== "general-purpose" && !f.marked) return f.agentType;
  if (f.cls === "shipper" || f.cls === "implementer") return f.cls;
  return f.marked ? f.cls : `unnamed (${f.cls})`;
}

/**
 * Output tokens: transcripts undercount them against Claude Code's own record of a session (`cost-state`, main and
 * subagents together). Where that record exists and says more, scale each model's output in that session up to it.
 * Returns the factor per `${sid}\t${model}`.
 */
function outputFactors(files) {
  const seen = new Map(), recorded = new Map();
  for (const f of files) {
    for (const r of f.reqs) { const k = `${f.sid}\t${r.model}`; seen.set(k, (seen.get(k) ?? 0) + r.out); }
    for (const run of Object.values(f.costRuns ?? {})) for (const [m, o] of Object.entries(run.out)) { const k = `${f.sid}\t${m}`; recorded.set(k, (recorded.get(k) ?? 0) + o); }
  }
  const factors = new Map();
  for (const [k, o] of recorded) {
    const s = seen.get(k) ?? 0;
    if (s > 0 && o > s && o / s <= 3) factors.set(k, o / s);
  }
  return factors;
}

function rows(map, total, top) {
  const r = [...map].map(([key, v]) => ({ key, requests: v.n, tokens: v.tokens, weightedM: M(v.w), share: pct(v.w, total) })).sort((a, b) => b.weightedM - a.weightedM);
  return top ? r.slice(0, top) : r;
}
function add(map, key, r) {
  const v = map.get(key) ?? { n: 0, tokens: 0, w: 0 };
  v.n++; v.tokens += ctx(r) + r.out; v.w += r.w;
  map.set(key, v);
}

/** Build the report from scanned files for a range. */
export function build(files, { from, to }) {
  const factors = outputFactors(files);
  let outRaw = 0, outFixed = 0;
  const inWin = (t) => t >= from && t < to;
  const live = [];
  for (const f of files) {
    f.lane = laneOf(f); f.kind = kindOf(f.cwd); f.proj = projectOf(f.cwd, f.project); f.group = agentGroup(f);
    for (const r of f.reqs) {
      const fac = factors.get(`${f.sid}\t${r.model}`) ?? 1;
      if (inWin(r.ts)) { outRaw += r.out; outFixed += r.out * fac; }
      r.out = r.out * fac;
      r.w = weighted(r);
    }
    f.win = f.reqs.filter((r) => inWin(r.ts));
    if (f.win.length) live.push(f);
  }
  const all = live.flatMap((f) => f.win.map((r) => [f, r]));
  const total = all.reduce((s, [, r]) => s + r.w, 0);
  const by = (keyf, pairs = all) => { const m = new Map(); for (const [f, r] of pairs) add(m, keyf(f, r), r); return m; };
  const sessions = new Set(live.map((f) => f.sid));
  const costUsd = live.filter((f) => !f.sub).reduce((s, f) => s + Object.values(f.costRuns ?? {}).reduce((a, r) => a + (r.usd ?? 0), 0), 0);

  const spend = {
    model: rows(by((f, r) => r.model.replace(/^claude-/, "")), total),
    lane: rows(by((f) => f.lane), total),
    agent: rows(by((f) => f.group), total),
    agentModel: rows(by((f, r) => `${f.group} | ${r.model.replace(/^claude-/, "")}`), total, 20),
    project: rows(by((f) => f.proj), total, 15),
    kind: rows(by((f) => `${f.kind} | ${f.lane}`), total),
  };

  // Shapes, main loop. Requests in order within each session file; "<synthetic>" ones are no API call.
  const mains = live.filter((f) => f.lane === "main");
  const real = (r) => modelWeight(r.model) > 0;
  const mainReqs = mains.flatMap((f) => f.win.filter(real));
  const mainTotal = mainReqs.reduce((s, r) => s + r.w, 0);
  const cs = mainReqs.map(ctx);
  const context = {
    requests: cs.length, median: median(cs), p90: pctile(cs, 0.9), max: cs.length ? Math.max(...cs) : 0,
    over150k: pct(cs.filter((x) => x > 150_000).length, cs.length), over300k: pct(cs.filter((x) => x > 300_000).length, cs.length), over500k: pct(cs.filter((x) => x > 500_000).length, cs.length),
  };
  let after200k = 0;
  const gaps = { short: { n: 0, w: 0, cw: 0 }, long: { n: 0, w: 0, cw: 0 } };
  const handoffCtx = [], handoffs = [];
  let compacts = 0;
  for (const f of mains) {
    compacts += f.compacts;
    let passed = false, prev = null;
    for (const r of f.reqs.filter(real)) {
      if (ctx(r) >= 200_000) passed = true;
      if (inWin(r.ts)) {
        if (passed) after200k += r.w;
        const gap = prev ? r.ts - prev.ts : 0;
        const g = gap > 3_600_000 ? gaps.long : gap > 300_000 ? gaps.short : null;
        if (g) { g.n++; g.w += r.w; g.cw += r.w1 + r.w5; }
        if (r.flags.includes("handoff")) { handoffCtx.push(ctx(r)); handoffs.push({ ts: r.ts, cwd: f.cwd, sid: f.sid }); }
      }
      prev = r;
    }
  }
  // A fresh worker: a task-worker session whose first request comes 0-10 minutes after a handoff in the same worktree.
  const fresh = mains.filter((f) => f.kind === "task-worker" && f.reqs.length && inWin(f.reqs[0].ts)
    && handoffs.some((h) => h.cwd === f.cwd && h.sid !== f.sid && f.reqs[0].ts >= h.ts && f.reqs[0].ts - h.ts <= 600_000));
  const workers = mains.filter((f) => f.kind === "task-worker");
  const workerTotal = workers.reduce((s, f) => s + f.win.reduce((a, r) => a + r.w, 0), 0);
  let afterPr = 0, prTasks = 0;
  for (const f of workers) {
    const i = f.reqs.findIndex((r) => r.cats.includes("Skill:pr-create"));
    if (i < 0) continue;
    prTasks++;
    for (const r of f.reqs.slice(i + 1)) if (inWin(r.ts)) afterPr += r.w;
  }
  // Batching: requests that make one tool call, and runs of 3+ single reads each within 20 s of the last.
  let one = 0, two = 0, none = 0, runReqs = 0, runW = 0, runs = 0;
  for (const f of workers) {
    const R = f.win.filter(real);
    let run = [];
    const close = () => { if (run.length >= 3) { runs++; runReqs += run.length - 1; runW += run.slice(1).reduce((s, r) => s + r.w, 0); } run = []; };
    for (const r of R) {
      if (r.cats.length === 1) one++; else if (r.cats.length > 1) two++; else none++;
      if (r.singleRead && (!run.length || r.ts - run[run.length - 1].ts < 20_000)) run.push(r);
      else { close(); if (r.singleRead) run.push(r); }
    }
    close();
  }
  const nWorkerReqs = one + two + none;
  const firstCtx = {};
  for (const f of live) {
    const r = f.reqs.find(real);
    if (!r || !inWin(r.ts)) continue;
    const k = f.lane === "main" ? f.kind : f.lane;
    (firstCtx[k] ??= []).push(ctx(r));
  }

  // Ships: shipper runs. Stages are cut at the first event of each (docs, a push, the merge queue, a release step).
  const STAGES = ["prep+checks", "docs", "CI", "merge queue", "release"];
  const ships = live.filter((f) => f.sub && f.group === "shipper" && f.win.length >= 2);
  const walls = [], stageMins = STAGES.map(() => []), stageTotals = STAGES.map(() => 0);
  const q = { pushed: 0, firstPass: 0, reviews: 0, pushes: 0, ciFails: 0 };
  for (const f of ships) {
    const R = f.win, t0 = R[0].ts, t1 = R[R.length - 1].ts;
    walls.push((t1 - t0) / 60_000);
    const first = (pred) => { const r = R.find(pred); return r ? r.ts : null; };
    const tDocs = first((r) => r.cats.includes("Agent:docs-updater") || r.cats.includes("Skill:update-docs"));
    const tPush = first((r) => r.flags.includes("push"));
    const tQ = first((r) => r.flags.includes("queue"));
    const tRel = tQ ? first((r) => r.ts > tQ && (r.cats.includes("Agent:deploy-watcher") || r.cats.some((c) => /^Skill:ship-/.test(c)))) : null;
    const b = [t0, tDocs && (!tPush || tDocs <= tPush) ? tDocs : null, tPush, tQ, tRel];
    let cur = t0;
    for (let i = 1; i < 5; i++) if (b[i] != null) { b[i] = Math.max(b[i], cur); cur = b[i]; }
    const pts = b.map((t, i) => [t, i]).filter(([t]) => t != null);
    pts.forEach(([t, i], k) => { const e = k + 1 < pts.length ? pts[k + 1][0] : t1; const m = Math.max(0, e - t) / 60_000; stageMins[i].push(m); stageTotals[i] += m; });
    const pushes = R.filter((r) => r.flags.includes("push")).length;
    const fails = R.filter((r) => r.flags.includes("cifail")).length;
    q.pushes += pushes; q.ciFails += fails;
    q.reviews += R.reduce((s, r) => s + r.cats.filter((c) => c === "Agent:code-reviewer").length, 0);
    if (pushes) { q.pushed++; if (!fails) q.firstPass++; }
  }
  const wallTotal = stageTotals.reduce((a, b) => a + b, 0);
  const humans = mains.flatMap((f) => f.humans.filter((h) => inWin(h.ts)).map((h) => ({ ...h, sid: f.sid })));
  const promptSessions = new Set(humans.map((h) => h.sid));
  const corrSessions = new Set(humans.filter((h) => h.corr).map((h) => h.sid));
  const corrections = humans.filter((h) => h.corr).length;

  return {
    range: { from: isoDay(from), to: isoDay(to - DAY), days: Math.round((to - from) / DAY) },
    totals: {
      requests: all.length, sessions: sessions.size, files: live.length, weightedM: M(total), weightedMPerDay: M(total / Math.max(1, (to - from) / DAY)),
      costStateUsd: Math.round(costUsd), outputCorrection: outRaw ? round(outFixed / outRaw, 3) : 1,
    },
    spend,
    shapes: {
      context,
      after200kShareOfMain: pct(after200k, mainTotal),
      idleGaps: {
        "5-60 min": { requests: gaps.short.n, cacheWriteM: M(gaps.short.cw), share: pct(gaps.short.w, total) },
        "over 60 min": { requests: gaps.long.n, cacheWriteM: M(gaps.long.cw), share: pct(gaps.long.w, total) },
      },
      handoffs: { count: handoffCtx.length, contextMedian: median(handoffCtx), freshWorkers: fresh.length, freshFirstContextMedian: median(fresh.map((f) => ctx(f.reqs.find(real) ?? f.reqs[0]))) },
      compactions: compacts,
      afterFirstPrCreate: { tasks: prTasks, shareOfWorkerMain: pct(afterPr, workerTotal) },
      batching: { workerRequests: nWorkerReqs, single: pct(one, nWorkerReqs), several: pct(two, nWorkerReqs), noTool: pct(none, nWorkerReqs), readRuns: runs, avoidable: runReqs, avoidableShareOfAll: pct(runW, total) },
      firstContext: Object.fromEntries(Object.entries(firstCtx).map(([k, v]) => [k, { sessions: v.length, median: median(v) }])),
      ships: {
        count: ships.length, wallMedian: round(median(walls)), wallP75: round(pctile(walls, 0.75)), wallP90: round(pctile(walls, 0.9)),
        stages: Object.fromEntries(STAGES.map((s, i) => [s, { ships: stageMins[i].length, median: round(median(stageMins[i])), share: pct(stageTotals[i], wallTotal) }])),
      },
    },
    quality: {
      ships: ships.length,
      firstRunCiPass: q.pushed ? pct(q.firstPass, q.pushed) : null,
      reviewsPerShip: ships.length ? round(q.reviews / ships.length, 2) : null,
      pushesPerShip: ships.length ? round(q.pushes / ships.length, 2) : null,
      ciFailuresPerShip: ships.length ? round(q.ciFails / ships.length, 2) : null,
      ownerPrompts: humans.length, corrections, correctionsPerSession: promptSessions.size ? round(corrections / promptSessions.size, 3) : 0,
      sessionsWithCorrection: pct(corrSessions.size, promptSessions.size),
    },
  };
}

/** The report as named numbers, for baselines and compare: "spend.model.opus-5-5" -> 90.3 (a share), ... */
export function flatten(rep) {
  const out = {};
  out["total.weightedM/day"] = rep.totals.weightedMPerDay;
  for (const [k, list] of Object.entries(rep.spend)) for (const r of list) out[`spend.${k}.${r.key}`] = r.share;
  const walk = (prefix, o) => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === "object") walk(`${prefix}.${k}`, v); else if (typeof v === "number") out[`${prefix}.${k}`] = v; } };
  walk("shapes", rep.shapes);
  walk("quality", rep.quality);
  return out;
}

/** Where saved baselines live: rollcall's home, never the repo. */
const BASE_DIR = () => join(store.home(), "usage-reports");
export const safe = (name) => { if (!/^[A-Za-z0-9._-]{1,80}$/.test(name ?? "")) throw new Error(`a baseline name is letters, digits, dot, dash or underscore: "${name}"`); return name; };
export function saveBaseline(name, rep) {
  const dir = BASE_DIR(), file = join(dir, `${safe(name)}.json`);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ name, saved: new Date().toISOString(), report: rep }, null, 1));
  renameSync(tmp, file);
  return file;
}
export function loadBaseline(name) {
  try { return JSON.parse(readFileSync(join(BASE_DIR(), `${safe(name)}.json`), "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
export function listBaselines() {
  try { return readdirSync(BASE_DIR()).filter((f) => f.endsWith(".json")).map((f) => { try { const b = JSON.parse(readFileSync(join(BASE_DIR(), f), "utf8")); return { name: b.name, saved: b.saved, range: b.report?.range }; } catch { return null; } }).filter(Boolean); } catch { return []; }
}
export function deleteBaseline(name) { rmSync(join(BASE_DIR(), `${safe(name)}.json`), { force: true }); }

/** Each named number in either report: { key, base, now, delta }, the ones that moved most first within each section. */
export function compare(base, now) {
  const a = flatten(base), b = flatten(now);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.map((key) => ({ key, base: a[key] ?? null, now: b[key] ?? null, delta: a[key] != null && b[key] != null ? round(b[key] - a[key], 3) : null }));
}

// Text.
const n = (x) => (typeof x === "number" ? (Number.isInteger(x) ? x.toLocaleString("en-US") : x.toLocaleString("en-US", { maximumFractionDigits: 2 })) : x == null ? "-" : String(x));
const k = (x) => `${Math.round(x / 1000)}k`;
function table(headers, data) {
  const cells = [headers, ...data.map((r) => r.map(n))];
  const w = headers.map((_, i) => Math.max(...cells.map((r) => String(r[i]).length)));
  return cells.map((r, j) => r.map((c, i) => (i === 0 ? String(c).padEnd(w[i]) : String(c).padStart(w[i]))).join("  ") + (j === 0 ? `\n${w.map((x) => "-".repeat(x)).join("  ")}` : "")).join("\n");
}
const spendTable = (title, list) => `${title}\n${table(["", "requests", "weighted M", "share %"], list.map((r) => [r.key, r.requests, r.weightedM, r.share]))}`;

export function format(rep) {
  const t = rep.totals, s = rep.shapes, q = rep.quality;
  const out = [];
  out.push(`Usage ${rep.range.from} to ${rep.range.to} (${rep.range.days} days): ${n(t.requests)} requests, ${n(t.sessions)} sessions, ${n(t.weightedM)}M weighted (${n(t.weightedMPerDay)}M a day), $${n(t.costStateUsd)} by Claude Code's own session records.`);
  out.push(`Output tokens scaled by ${t.outputCorrection} to match those records where they exist.`,
    "Weighted = tokens x model: input 1, cache write 1.25 (5 min) or 2 (1 h), cache read 0.1, output 5; Haiku 1, Sonnet 3, Opus 5, Fable 10.");
  out.push("", spendTable("By model", rep.spend.model), "", spendTable("By lane", rep.spend.lane), "", spendTable("By agent", rep.spend.agent));
  out.push("", spendTable("By agent and model (top 20)", rep.spend.agentModel), "", spendTable("By project (top 15)", rep.spend.project), "", spendTable("By session kind and lane", rep.spend.kind));
  out.push("", "Main-loop context per request",
    `  median ${k(s.context.median)}, p90 ${k(s.context.p90)}, max ${k(s.context.max)}; over 150k ${s.context.over150k}%, over 300k ${s.context.over300k}%, over 500k ${s.context.over500k}%`,
    `  spend after a session first passes 200k: ${s.after200kShareOfMain}% of main-loop spend`,
    `  compactions: ${s.compactions}`);
  out.push("", "Idle gaps (main loop; the request after the gap rewrites the cache)",
    ...Object.entries(s.idleGaps).map(([g, v]) => `  ${g}: ${n(v.requests)} requests, ${n(v.cacheWriteM)}M tokens written, ${v.share}% of all spend`));
  out.push("", "Handoffs and fresh starts",
    `  handoffs: ${s.handoffs.count}, context at handoff median ${k(s.handoffs.contextMedian)}`,
    `  fresh workers after a handoff: ${s.handoffs.freshWorkers}, first-request context median ${k(s.handoffs.freshFirstContextMedian)}`,
    `  task-worker main spend after its first /pr-create: ${s.afterFirstPrCreate.shareOfWorkerMain}% (${s.afterFirstPrCreate.tasks} sessions)`);
  out.push("", "Tool calls per request (task-worker main loop)",
    `  one call ${s.batching.single}%, several ${s.batching.several}%, none ${s.batching.noTool}% of ${n(s.batching.workerRequests)} requests`,
    `  runs of 3+ single reads within 20 s: ${n(s.batching.readRuns)}; batching them saves ${n(s.batching.avoidable)} requests, ${s.batching.avoidableShareOfAll}% of all spend`);
  out.push("", "First-request context by session kind",
    ...Object.entries(s.firstContext).map(([kk, v]) => `  ${kk}: median ${k(v.median)} over ${n(v.sessions)} sessions`));
  out.push("", `Ships (shipper runs): ${s.ships.count}, wall minutes median ${s.ships.wallMedian}, p75 ${s.ships.wallP75}, p90 ${s.ships.wallP90}`,
    table(["stage", "ships", "median min", "share of time %"], Object.entries(s.ships.stages).map(([st, v]) => [st, v.ships, v.median, v.share])),
    "  (stages are cut at the first docs run, push, merge-queue command and release step)");
  out.push("", "Quality signals",
    `  first-run CI pass: ${q.firstRunCiPass ?? "-"}% of ships that pushed; per ship: ${n(q.reviewsPerShip)} reviews, ${n(q.pushesPerShip)} pushes, ${n(q.ciFailuresPerShip)} CI failure reads`,
    `  owner corrections: ${n(q.corrections)} of ${n(q.ownerPrompts)} prompts, ${n(q.correctionsPerSession)} per session, in ${q.sessionsWithCorrection}% of sessions`);
  return out.join("\n");
}

export function formatCompare(name, base, now, rows) {
  const out = [`${now.range.from} to ${now.range.to} against baseline "${name}" (${base.range.from} to ${base.range.to}). Shares in %, sizes in tokens, times in minutes.`, ""];
  const sections = new Map();
  for (const r of rows.filter((x) => x.delta !== 0)) {
    const parts = r.key.split(".");
    const cut = parts.length > 2 ? 2 : 1; // "spend.model.opus-5-5" sits under spend.model; "quality.ships" under quality
    const s = parts.slice(0, cut).join(".");
    if (!sections.has(s)) sections.set(s, []);
    sections.get(s).push([`  ${parts.slice(cut).join(".")}`, r.base, r.now, r.delta == null ? "-" : `${r.delta > 0 ? "+" : ""}${n(r.delta)}`]);
  }
  const data = [...sections].sort(([a], [b]) => a.localeCompare(b)).flatMap(([s, list]) => [[s, "", "", ""], ...list]);
  out.push(table(["", "baseline", "now", "change"], data));
  return out.join("\n");
}

/** One call for the CLI and the API: scan, build, optionally save. */
export async function report({ from, to, days, root, threads, now } = {}) {
  const range = rangeOf({ from, to, days }, now);
  const files = await scanAll({ root, from: range.from, threads });
  return build(files, range);
}
