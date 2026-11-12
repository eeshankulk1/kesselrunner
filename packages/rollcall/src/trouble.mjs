// What stops work on this Mac or this account, as one record per cause (a blocker), however many workers it stops:
// a usage limit, GitHub billing, a full disk, the Mac on battery, memory running out, Spotlight's index stuck read-only. Each home's watcher looks here,
// and whichever looks first in a minute reads the machine, so the owner hears of each cause once, not once per
// worker. A worker waits on a blocker by name (`rollcall task wait-for`, or its hooks at a usage limit) and is
// brought back when the blocker closes: by itself when rollcall can see the cause is gone (a reset time passed, the
// disk has room, the Mac is on power, GitHub started a job again), or on the owner's `rollcall blockers clear`.
//
// This only notices and tells. It never queues, caps or holds work to prevent trouble: new work starts as ever.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, statfsSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { spawnDetached } from "./proc.mjs";
import { BIN } from "./session.mjs";
import { isOpen } from "./state.mjs";
import { noteNotice } from "./clients.mjs";
import * as store from "./store.mjs";
import { watcherEnv } from "./supervisor.mjs";

const num = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : dflt; };
const lookMs = () => num("ROLLCALL_TROUBLE_LOOK_MS", 60_000);
/** Free space under this much opens the disk blocker; it closes at this much plus DISK_ROOM_GB. */
const lowGb = () => num("ROLLCALL_DISK_LOW_GB", 10);
const DISK_ROOM_GB = 5;
/** Under this workers fail on writes, whether or not they said why they stopped. */
const FULL_GB = 2;
const BATTERY_LOW = 20;
const MEMORY_LOW = 10;
const MEMORY_OK = 20;
// How long after a reset a worker gets to go on by itself: Claude Code's own automatic continue fires around it.
const graceMs = () => num("ROLLCALL_LIMIT_GRACE_MS", 3 * 60_000);
/** A limit that names no reset time, or an account error: its workers try again this often. A try costs nothing. */
const retryMs = () => num("ROLLCALL_LIMIT_RETRY_MS", 15 * 60_000);
/** A cause that comes back this soon is not news again. */
const TELL_AGAIN_MS = 2 * 3600_000;
const LIST_AGAIN_MS = 5 * 60_000;
const PROBE_MS = 15 * 60_000;
const PROBE_MAX_MS = 60 * 60_000;
const PROBE_SETTLE_MS = 60_000;

/** The causes a worker can wait on by name (`usage` comes from its own hooks). */
export const WAITABLE = ["disk", "power", "billing"];
export const NAMES = { usage: "the usage limit", "usage-codex": "Codex's usage limit", billing: "GitHub billing", disk: "disk space", power: "power", memory: "memory", spotlight: "Spotlight" };
/** Every kind `rollcall blockers clear` takes. */
export const KINDS = Object.keys(NAMES);

/**
 * What brings back a Spotlight index that went read-only. mds marks its index read-only when the disk runs low and
 * keeps it so after space returns, while it runs: `mdutil -E /` alone leaves the old one, so mds restarts first.
 */
export const SPOTLIGHT_FIX = "sudo killall mds; sleep 5; sudo mdutil -i on / && sudo mdutil -E /System/Volumes/Data";

const appleString = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** `tag`: what a front end acts on beside the words, for a notice about one item (`{ kind, ref, held }`, away.mjs). */
export function notify(title, text, { sound = true, tag = null } = {}) {
  // A front end that shows the owner's notifications (clients.mjs) gets this one through its stream instead.
  if (noteNotice({ title, text, sound, ...(tag ?? {}) })) return;
  const log = process.env.ROLLCALL_NOTIFY_LOG;
  if (log) { appendFileSync(log, `${JSON.stringify({ title, text, ...(tag ?? {}) })}\n`); return; }
  spawnSync("osascript", ["-e", `display notification ${appleString(text)} with title ${appleString(title)}${sound ? ' sound name "Glass"' : ""}`], { stdio: "ignore", timeout: 5000 });
}

// ---------------------------------------------------------------- reading the machine

/** What the Mac runs on: { on: "ac" }, { on: "battery", pct }, or null where pmset cannot say. */
export function power() {
  const r = spawnSync(process.env.ROLLCALL_PMSET || "pmset", ["-g", "batt"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  const out = r.stdout ?? "";
  if (/'AC Power'/.test(out)) return { on: "ac" };
  if (/'Battery Power'/.test(out)) return { on: "battery", pct: Number(/(\d+)%/.exec(out)?.[1]) || null };
  return null;
}

/** Free space on the disk rollcall lives on, in GB, or null. */
function diskGb() {
  try { const s = statfsSync(store.home()); return (s.bavail * s.bsize) / 1024 ** 3; } catch { return null; }
}

/** The share of memory the OS counts as free, in percent (macOS), or null. */
function memoryPct() {
  const r = spawnSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  const v = Number((r.stdout ?? "").trim());
  return r.status === 0 && Number.isFinite(v) && v > 0 ? v : null;
}

/** Whether Spotlight's index is read-only on the startup disk (macOS), or null where mdutil cannot say. */
function spotlightReadOnly() {
  const r = spawnSync("mdutil", ["-s", "/", "/System/Volumes/Data"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  const out = r.stdout ?? "";
  if (/Index is read-only/i.test(out)) return true;
  return /Indexing (enabled|disabled)/i.test(out) ? false : null;
}

/** { diskGb, power, memoryPct, spotlightReadOnly }; ROLLCALL_MACHINE_FACTS names a JSON file that stands in for them (the tests'). */
function machineFacts() {
  const fake = process.env.ROLLCALL_MACHINE_FACTS;
  if (fake === undefined) return { diskGb: diskGb(), power: power(), memoryPct: memoryPct(), spotlightReadOnly: spotlightReadOnly() };
  try { return JSON.parse(readFileSync(fake, "utf8")); } catch { return {}; }
}

// Load per core past which the Mac is the likely reason a stage runs long.
const LOAD_HIGH = 2;

/** "Mac load high" while it is, else null: a plain fact beside a ship's stage, never a reason to hold anything. */
export function loadNote() {
  const fake = process.env.ROLLCALL_MACHINE_FACTS;
  let load = loadavg()[0] / (cpus().length || 1);
  if (fake !== undefined) { try { load = JSON.parse(readFileSync(fake, "utf8")).load ?? 0; } catch { load = 0; } }
  return load >= LOAD_HIGH ? "Mac load high" : null;
}

// ---------------------------------------------------------------- the record

export const openBlockers = () => store.readTrouble().open;
/**
 * A usage limit is a blocker per plan: "usage" is Claude's (the supervisor's own harness, so its news waits too),
 * "usage-codex" Codex's, which holds only the tasks that run there.
 */
export const USAGE_KINDS = ["usage", "usage-codex"];
export const isUsage = (kind) => USAGE_KINDS.includes(kind);
/** Whether Claude itself is refusing work now: news for a supervisor's model waits for this to end. */
export const paused = () => !!openBlockers().usage;

/** Opens the `kind` blocker, or adds `fields` to the open one (a later reset wins). */
export function openBlocker(kind, fields = {}, now = Date.now()) {
  store.updateTrouble((t) => {
    const b = t.open[kind];
    t.open[kind] = { ...b, ...fields, kind, since: b?.since ?? now };
    if (isUsage(kind) && b?.until) t.open[kind].until = fields.until ? Math.max(b.until, fields.until) : b.until;
  });
}

/** Closes the `kind` blocker. Returns whether it was open. */
export function closeBlocker(kind) {
  return store.updateTrouble((t) => { const was = !!t.open[kind]; delete t.open[kind]; return was; }) === true;
}

/**
 * What the machine's facts `f` change, given the blockers `open`: { want: [{ kind, ...fields }] to open or update,
 * gone: [kind] to close }. Pure, so every rule has a test with no machine behind it.
 */
export function assess(f, open, now) {
  const want = [];
  const gone = [];
  if (Number.isFinite(f.diskGb)) {
    const gb = Math.round(f.diskGb * 10) / 10;
    if (f.diskGb < lowGb()) want.push({ kind: "disk", gb, full: f.diskGb < FULL_GB });
    else if (open.disk && f.diskGb >= lowGb() + DISK_ROOM_GB) gone.push("disk");
    else if (open.disk) want.push({ kind: "disk", gb, full: false });
  }
  if (f.power?.on === "ac") { if (open.power) gone.push("power"); }
  else if (f.power?.on === "battery") {
    const low = f.power.pct !== null && f.power.pct <= BATTERY_LOW;
    // A worker's own wait on power stays until the Mac is plugged in; the watch's lasts as long as its reason.
    if (low || f.shipping || open.power?.waited) want.push({ kind: "power", pct: f.power.pct, low, shipping: !!f.shipping });
    else if (open.power) gone.push("power");
  }
  if (Number.isFinite(f.memoryPct)) {
    if (f.memoryPct <= MEMORY_LOW) want.push({ kind: "memory", pct: f.memoryPct });
    else if (open.memory && f.memoryPct >= MEMORY_OK) gone.push("memory");
  }
  // Spotlight stays read-only after the disk has room again, so it is a cause of its own, closed only by mdutil's word.
  if (f.spotlightReadOnly === true) { if (!open.spotlight) want.push({ kind: "spotlight" }); }
  else if (f.spotlightReadOnly === false && open.spotlight) gone.push("spotlight");
  for (const k of USAGE_KINDS) if (open[k] && now >= (open[k].until ?? open[k].since + retryMs()) + graceMs()) gone.push(k);
  return { want, gone };
}

// ---------------------------------------------------------------- a usage limit

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const macZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** `name` if the clock knows that zone, else the Mac's own. */
function readableZone(name) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: name }); return name; } catch { return macZone(); }
}

/** The epoch time of a wall clock reading in `zone`. */
function zoned(y, mo, d, h, mi, zone) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const part = (x) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(x).map((p) => [p.type, Number(p.value)]));
  const seen = (x) => { const p = part(x); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute); };
  const once = guess - (seen(guess) - guess);
  return guess - (seen(once) - once); // twice, across a clock change
}

/**
 * When a limit resets, from Claude Code's line ("You've hit your session limit · resets 2:20pm (America/Los_Angeles)",
 * "... resets Oct 21 at 11am (...)"), or null when it names no time. A time already past is its next occurrence.
 */
export function resetAt(text, now = Date.now()) {
  const m = /\bresets\s+(?:([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i.exec(String(text ?? ""));
  if (!m) return null;
  const zone = readableZone(m[6]?.trim() || macZone());
  const hour = (Number(m[3]) % 12) + (m[5].toLowerCase() === "pm" ? 12 : 0);
  const minute = Number(m[4] ?? 0);
  const today = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now);
  const got = Object.fromEntries(today.map((p) => [p.type, Number(p.value)]));
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return null;
    const at = zoned(got.year, month, Number(m[2]), hour, minute, zone);
    return at > now ? at : zoned(got.year + 1, month, Number(m[2]), hour, minute, zone);
  }
  const at = zoned(got.year, got.month - 1, got.day, hour, minute, zone);
  return at > now ? at : zoned(got.year, got.month - 1, got.day + 1, hour, minute, zone);
}

/** "2:20 PM" today, "Oct 21, 11:00 AM" further out. */
export function clock(at, now = Date.now()) {
  const far = at - now > 20 * 3600_000;
  return new Date(at).toLocaleString("en-US", { ...(far ? { month: "short", day: "numeric" } : {}), hour: "numeric", minute: "2-digit" }).replace(/ /g, " ");
}

/** What a task's tab says while it waits: "paused until 2:20 PM", "waits on disk space", "waits on `curl ...`". */
export function waitLabel(wait, now = Date.now()) {
  if (isUsage(wait.on)) return wait.until ? `paused until ${clock(wait.until, now)}` : "paused at the usage limit";
  if (wait.on) return `waits on ${NAMES[wait.on]}`;
  return `waits on ${wait.why ?? `\`${store.clip(wait.check, 40)}\``}`;
}

// ---------------------------------------------------------------- GitHub billing

/**
 * Whether GitHub starts jobs again. The only sign is a job: the run it refused goes again every so often (a refusal
 * costs nothing and fails in seconds, and a job that starts is work the ship wanted anyway), and a later look reads
 * how that went. Returns true once a job got past the refusal, else the fields to keep on the blocker.
 */
function probeBilling(b, now) {
  if (!b.main || !b.run) return {};
  const gh = (args) => spawnSync(process.env.ROLLCALL_GH || "gh", args, { cwd: b.main, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
  if (b.probed && now - b.probed >= PROBE_SETTLE_MS && !b.read) {
    const r = gh(["run", "view", String(b.run), "--json", "status,conclusion,jobs"]);
    let run = null;
    try { run = JSON.parse(r.stdout); } catch { return {}; }
    if (run.status !== "completed" || run.conclusion === "success") return true;
    const failed = (run.jobs ?? []).filter((j) => j.conclusion === "failure");
    if (failed.some((j) => j.steps?.length)) return true;
    return { read: true };
  }
  const every = Math.min(PROBE_MS * 2 ** (b.probes ?? 0), PROBE_MAX_MS);
  if (now - (b.probed ?? b.since) < every) return {};
  gh(["run", "rerun", String(b.run), "--failed"]);
  return { probed: now, probes: (b.probes ?? 0) + 1, read: false };
}

// ---------------------------------------------------------------- telling the owner

const CLEAR = (kind) => `Already fixed? rollcall blockers clear ${kind}`;

/** What the owner hears of blocker `b`, once. The disk's notice comes from `rollcall clean --low-disk`, with its list. */
function notice(b, now) {
  if (isUsage(b.kind)) return `${(b.text ?? (b.kind === "usage" ? "Claude's usage limit stopped your workers" : "Codex's usage limit stopped its workers")).replace(/\.?$/, ".")} ${b.until ? `rollcall resumes them after ${clock(b.until, now)}.` : `rollcall tries them again every ${Math.round(retryMs() / 60_000)} minutes.`} ${CLEAR(b.kind)}`;
  if (b.kind === "billing") return `GitHub would not start jobs over billing${b.text ? `: "${store.clip(b.text, 200)}"` : ""}. Fix it under Billing and plans on GitHub${b.run ? `: rollcall retries by itself, and what waits on it goes on. ${CLEAR("billing")}` : ", then run rollcall blockers clear billing."}`;
  if (b.kind === "memory") return `Memory is low (${b.pct}% free). rollcall closed the test browsers nothing uses; anything that ran out comes back by itself.`;
  if (b.kind === "spotlight") return `Spotlight's index went read-only, which macOS does when the disk runs low and keeps after space returns, so Cmd-Space stops finding apps (Cockpit among them). Run this in Terminal, with your password: ${SPOTLIGHT_FIX}. Spotlight then rebuilds its index, and rollcall sees it is back.`;
  if (b.kind === "power") return `The Mac is on battery${b.pct ? ` at ${b.pct}%` : ""}${b.shipping ? " with a ship running: a sleep stalls it until it wakes" : ""}. Plug it in, and what waits on power goes on.`;
  return `${NAMES[b.kind]} stopped work.`;
}

const isNews = (told, kind, now) => now - (told[kind] ?? 0) >= TELL_AGAIN_MS;

/** Tells the owner of each open blocker once; a cause that came back soon after is no news. */
function tell(now, clean) {
  const { open, told } = store.readTrouble();
  for (const b of Object.values(open)) {
    if (b.heard) continue;
    if (b.kind === "disk") {
      // The list takes a minute or two of du, so it runs apart, and tells the owner itself. A run that died is tried again.
      if (!b.listing || now - b.listing > LIST_AGAIN_MS) { store.updateTrouble((t) => { if (t.open.disk) t.open.disk.listing = now; }); clean("--low-disk"); }
      continue;
    }
    if (b.kind === "memory") clean("--sweep");
    const fresh = isNews(told, b.kind, now);
    if (fresh) notify(`rollcall: ${NAMES[b.kind]}`, notice(b, now));
    heard(b.kind, now, fresh);
  }
}

/** The owner has heard of `kind`, so no watcher tells them again. */
export function heard(kind, now = Date.now(), told = true) {
  store.updateTrouble((t) => {
    if (t.open[kind]) t.open[kind].heard = now;
    if (told) t.told[kind] = now;
  });
}

/**
 * The low-disk run ended: `freed` is what it cleared, in words or null, and `found` what more it can delete, in words
 * or null. If that made room the blocker closes with nothing to say; if not the owner hears once, with the list.
 */
export function diskRunEnded({ freed, found }, now = Date.now()) {
  const { open, told } = store.readTrouble();
  if (!open.disk) return;
  const gb = machineFacts().diskGb;
  if (gb >= lowGb() + DISK_ROOM_GB) { closeBlocker("disk"); return; }
  store.updateTrouble((t) => { if (t.open.disk) t.open.disk.total = found; });
  const fresh = isNews(told, "disk", now);
  if (fresh) notify(`rollcall: ${NAMES.disk}`, `The disk has ${Number.isFinite(gb) ? Math.round(gb * 10) / 10 : open.disk.gb ?? "?"} GB free.${freed ? ` rollcall already cleared ${freed} of leftovers.` : ""} ${found ? `It found ${found} more it can delete, listed in ${store.cleanListPath()}. Say "clean up" to a supervisor, or run rollcall clean to see it: nothing goes until you say yes.` : "It found nothing more it can delete by itself."} Work goes on, and what waits on disk space resumes once there is room.`);
  heard("disk", now, fresh);
}

/** One line per open blocker, for the status line. */
export function lines(now = Date.now()) {
  return Object.values(openBlockers()).map((b) => {
    if (isUsage(b.kind)) return b.until ? `${b.kind === "usage" ? "" : "Codex "}usage limit: workers resume after ${clock(b.until, now)}` : "usage limit: rollcall tries again shortly";
    if (b.kind === "disk") return `disk: ${b.gb ?? "?"} GB free${b.total ? `, rollcall clean lists ${b.total} it can free` : ""}`;
    if (b.kind === "billing") return b.run ? "GitHub billing refuses jobs: rollcall retries by itself" : "GitHub billing refuses jobs: rollcall blockers clear billing once fixed";
    if (b.kind === "spotlight") return `Spotlight read-only, Cmd-Space misses apps: ${SPOTLIGHT_FIX}`;
    if (b.kind === "power") return `on battery${b.pct ? ` at ${b.pct}%` : ""}: plug in the Mac`;
    return `memory low: ${b.pct}% free`;
  });
}

// ---------------------------------------------------------------- the look

let lastLook = 0;

const startClean = (flag) => spawnDetached(process.execPath, [BIN, "clean", flag], { env: watcherEnv() });

/**
 * One look at the machine, from a home's watcher, or a lander with entries a blocker holds (no supervisor need run):
 * at most one a minute across all of them. A full disk can refuse this record: the look still runs, and each
 * process's own memory (`lastLook`) keeps it to one a minute.
 */
export function look(now = Date.now()) {
  if (now - lastLook < lookMs()) return;
  lastLook = now;
  try {
    if (store.updateTrouble((t) => { if (now - t.looked < lookMs()) return false; t.looked = now; return true; }) === false) return;
  } catch {}
  const shipping = store.listTasks().some((t) => isOpen(t) && (t.state === "pr-open" || t.state === "queued"));
  const { open } = store.readTrouble();
  const { want, gone } = assess({ ...machineFacts(), shipping }, open, now);
  for (const { kind, ...fields } of want) {
    if (!open[kind] || Object.entries(fields).some(([k, v]) => open[kind][k] !== v)) openBlocker(kind, fields, now);
  }
  for (const kind of gone) closeBlocker(kind);
  if (open.billing) {
    const r = probeBilling(open.billing, now);
    if (r === true) closeBlocker("billing");
    else if (Object.keys(r).length) openBlocker("billing", r, now);
  }
  tell(now, startClean);
}
