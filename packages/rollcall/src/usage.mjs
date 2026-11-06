// The usage meter: how much room each plan has before a turn fails on it. Claude's comes from Claude Code's status
// line (`rate_limits`: the five-hour and weekly windows, for Pro and Max plans, after a session's first answer);
// Codex's from its app server (`account/rateLimits/updated` in a worker, else one short read). Both land in one file
// in rollcall's store (one file per plan), read by `task list`, the supervisor's status line, the front end and the watcher, which offers
// the owner to move waiting tasks to the other harness when one plan nears its limit. It never moves one by itself.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as store from "./store.mjs";

// One file per plan's reading and one for when Codex was last asked, so two writers of different things never drop
// each other's; each write swaps a whole file in, so no reader sees half of one.
const FILE = (plan) => join(store.home(), `usage-${plan}.json`);
function readPlan(plan) { try { return JSON.parse(readFileSync(FILE(plan), "utf8")) ?? null; } catch { return null; } }
function writePlan(plan, v) {
  try {
    mkdirSync(store.home(), { recursive: true });
    const tmp = `${FILE(plan)}.${process.pid}.tmp`;
    try { writeFileSync(tmp, JSON.stringify(v)); renameSync(tmp, FILE(plan)); } catch { rmSync(tmp, { force: true }); }
  } catch {}
}
/** At or past this percent of a window, a plan is near its limit. */
export const nearPct = () => { const v = Number(process.env.ROLLCALL_USAGE_NEAR_PCT); return Number.isFinite(v) && v > 0 && v <= 100 ? v : 85; };
/** A reading older than this says nothing about now. */
const STALE_MS = 6 * 3600_000;
const CODEX_READ_EVERY_MS = 10 * 60_000;

const read = () => ({ claude: readPlan("claude"), codex: readPlan("codex") });

const window = (pct, resetsAtSec, mins = null) => (Number.isFinite(pct) ? { pct: Math.round(pct), resetsAt: Number.isFinite(resetsAtSec) ? resetsAtSec * 1000 : null, ...(mins ? { windowMins: mins } : {}) } : null);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Claude Code's status line `rate_limits`, recorded when it says something new (or every few minutes). */
export function recordClaude(limits, now = Date.now()) {
  if (!limits || typeof limits !== "object") return;
  const next = { fiveHour: window(limits.five_hour?.used_percentage, limits.five_hour?.resets_at), weekly: window(limits.seven_day?.used_percentage, limits.seven_day?.resets_at) };
  if (!next.fiveHour && !next.weekly) return;
  const was = readPlan("claude");
  // Every session reports the account's limits, an idle one's from its last answer: within one window use only rises,
  // so a lower reading for the same window is an old one, and the higher stands.
  const merge = (n, o) => (n && o && n.resetsAt && o.resetsAt && Math.abs(n.resetsAt - o.resetsAt) < 120_000 && o.pct > n.pct ? { ...n, pct: o.pct } : n ?? o ?? null);
  if (was) { next.fiveHour = merge(next.fiveHour, was.fiveHour); next.weekly = merge(next.weekly, was.weekly); }
  if (was && same({ fiveHour: was.fiveHour, weekly: was.weekly }, next) && now - was.at < 5 * 60_000) return;
  writePlan("claude", { ...next, at: now });
}

/** Codex's rate limits (the protocol's RateLimitSnapshot), recorded as they come. */
export function recordCodex(r, now = Date.now()) {
  if (!r || typeof r !== "object") return;
  const next = {
    primary: window(r.primary?.usedPercent, r.primary?.resetsAt, r.primary?.windowDurationMins),
    secondary: window(r.secondary?.usedPercent, r.secondary?.resetsAt, r.secondary?.windowDurationMins),
    plan: r.planType ?? null,
    reached: r.rateLimitReachedType ?? null,
    credits: r.credits?.hasCredits ? (r.credits.unlimited ? "unlimited" : r.credits.balance ?? "some") : null,
  };
  if (!next.primary && !next.secondary) return; // a snapshot of another limit (Codex sends several) says nothing of the plan's
  writePlan("codex", { ...next, at: now });
}

/** One read of Codex's limits through a short-lived app server, at most every ten minutes. Fails soft. */
let reading = null;
export function refreshCodex(now = Date.now(), { force = false } = {}) {
  if (reading) return reading;
  const last = readPlan("codex")?.at ?? 0;
  const tried = readPlan("codex-tried")?.at ?? 0;
  if (!force && (now - last < CODEX_READ_EVERY_MS || now - tried < CODEX_READ_EVERY_MS)) return null;
  writePlan("codex-tried", { at: now });
  reading = (async () => {
    try {
      const [{ bin }, { once }] = await Promise.all([import("./harness/codex.mjs"), import("./codex/rpc.mjs")]);
      const b = bin();
      if (!b) return;
      const r = await once(b, "account/rateLimits/read", undefined);
      recordCodex(r?.rateLimitsByLimitId?.codex ?? r?.rateLimits);
    } catch {} finally { reading = null; }
  })();
  return reading;
}

/** A window whose reset has passed is empty again. */
const live = (w, now) => (w && (!w.resetsAt || w.resetsAt > now) ? w : w ? { ...w, pct: 0, reset: true } : null);

/**
 * Each plan's room now: { claude: { fiveHour, weekly, at } | null, codex: { primary, secondary, plan, at } | null },
 * windows { pct, resetsAt (ms) }. A stale reading is dropped.
 */
export function usageOf(now = Date.now()) {
  const u = read();
  const fresh = (x) => (x && now - x.at < STALE_MS ? x : null);
  const c = fresh(u.claude);
  const x = fresh(u.codex);
  return {
    claude: c ? { ...c, fiveHour: live(c.fiveHour, now), weekly: live(c.weekly, now) } : null,
    codex: x ? { ...x, primary: live(x.primary, now), secondary: live(x.secondary, now) } : null,
  };
}

/** The fullest window of each plan: { harness, name, pct, resetsAt }[]. */
export function fullest(now = Date.now()) {
  const u = usageOf(now);
  const out = [];
  const pick = (harness, wins) => {
    const w = wins.filter(([, x]) => x).sort((a, b) => b[1].pct - a[1].pct)[0];
    if (w) out.push({ harness, name: w[0], pct: w[1].pct, resetsAt: w[1].resetsAt });
  };
  if (u.claude) pick("claude", [["five-hour", u.claude.fiveHour], ["weekly", u.claude.weekly]]);
  if (u.codex) pick("codex", [[windowName(u.codex.primary), u.codex.primary], [windowName(u.codex.secondary), u.codex.secondary]]);
  return out;
}

/** "five-hour", "weekly", "monthly": a Codex window by its length. */
function windowName(w) {
  const m = w?.windowMins;
  if (!m) return "limit";
  if (m <= 6 * 60) return `${Math.round(m / 60)}-hour`;
  if (m <= 8 * 1440) return "weekly";
  return "monthly";
}

/** "3:40 PM", or "Nov 16" past a day. */
export function when(at, now = Date.now()) {
  if (!at) return "";
  const d = new Date(at);
  return at - now < 20 * 3600_000 ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The plans near their limit now: fullest() entries at or past nearPct(). */
export const near = (now = Date.now()) => fullest(now).filter((w) => w.pct >= nearPct());

/** One short line for the status line and `task list`: "Claude 5h 62% · wk 40% | Codex mo 100% until Nov 16", or "". */
export function usageLine(now = Date.now()) {
  const u = usageOf(now);
  const pct = (w, short) => (w ? `${short} ${w.pct}%${w.pct >= nearPct() && w.resetsAt ? ` until ${when(w.resetsAt, now)}` : ""}` : null);
  const parts = [];
  if (u.claude) parts.push(`Claude ${[pct(u.claude.fiveHour, "5h"), pct(u.claude.weekly, "wk")].filter(Boolean).join(" · ")}`);
  if (u.codex) {
    const s = (w) => (w ? windowName(w).replace(/^(\d+)-hour$/, "$1h").replace("weekly", "wk").replace("monthly", "mo") : null);
    parts.push(`Codex ${[pct(u.codex.primary, s(u.codex.primary)), pct(u.codex.secondary, s(u.codex.secondary))].filter(Boolean).join(" · ")}${u.codex.plan === "free" ? " (free plan)" : ""}`);
  }
  return parts.join(" | ");
}

/** Task `t`'s tokens: its worker's context now, and on Codex the thread's total so far. */
export function tokensOf(t) {
  const c = store.readHomeFile(t.home, `context-${t.id}`);
  return c ? { context: c.tokens ?? null, size: c.size ?? null, total: c.total ?? null } : null;
}
