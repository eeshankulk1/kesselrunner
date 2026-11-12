// On-disk layout (all under ROLLCALL_HOME, default ~/.rollcall):
//   _sessions/<id>.json            one per agent session: harness pid, repos joined
//   _supervisors/<name>/           one per named supervisor: its tasks, their workers' status, wake queue
//                                  (layout under "supervisor homes" below)
//   _machine/trouble.json          what stops work on this Mac or account now, one record per cause (trouble.mjs)
//   _machine/clean-list.{json,txt} what `rollcall clean --yes` would delete
//   _machine/decisions.json        what waits on the owner, one list for every supervisor
//   _snapshots/<hash>.git/         per-turn snapshots of one linked worktree (snapshot.mjs): a private bare repo
//                                  that borrows the repo's objects, so its refs are never pushed
//   <repo-key>/events.jsonl        append-only: claim, done, msg, wait
//   <repo-key>/sessions/<id>.json  the session's live state in this repo
//   <repo-key>/sessions/<id>.touched  append-only list of repo-relative paths it edited
//   <repo-key>/sessions/<id>.main  cache: files changed on origin/main since the session's base
//   <repo-key>/fetch.stamp         throttle for the background fetch
//   <repo-key>/gc.stamp            throttle for the background worktree gc
//   <repo-key>/refs.stamp          throttle for gc's sweep of old refs
//   <repo-key>/gc.lock/            held while a gc runs in the repo (one at a time)
//   <repo-key>/gc-report.txt       what background gc runs removed, until SessionStart reports it
//   <repo-key>/queue/              the merge queue and its lander (layout under "merge queue" below)
// This module is the only one that knows the layout: a different backend (a
// server, a synced git repo) replaces it behind the same exports. Cursors are
// opaque to callers. Keep the hook path local-first either way: the ~50 ms
// budget leaves no room for a network round trip per edit.
// Every write is small: records are replaced via temp file + rename, logs are
// O_APPEND lines. Views (who is live, what is unread) are computed on read.
import {
  appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pidAlive, sameProcess, startOf } from "./proc.mjs";
import { isOpen } from "./state.mjs";

export const home = () => process.env.ROLLCALL_HOME || join(homedir(), ".rollcall");
const minutes = (name, dflt) => {
  const v = process.env[name] ? Number(process.env[name]) : NaN;
  return (Number.isFinite(v) ? v : dflt) * 60_000;
};
/** A heartbeat older than this means "not confirmed live": never enough to deny an edit. */
export const staleMs = () => minutes("ROLLCALL_STALE_MINUTES", 60);

/** A boolean knob's value: true (1/true/yes/on/allow), false (0/false/no/off), or null when unset or unrecognized. */
export function parseFlag(v) {
  if (typeof v !== "string") return null;
  if (/^(1|true|yes|on|allow)$/i.test(v.trim())) return true;
  if (/^(0|false|no|off)$/i.test(v.trim())) return false;
  return null;
}
export const envFlag = (name) => parseFlag(process.env[name]);

/**
 * Every agent-supplied string (intent, message, summary) is read by every peer
 * and injected into its context, so each one is capped before it is stored.
 */
export const MAX_TEXT = 1000;
export const clip = (s, n = MAX_TEXT) => (typeof s === "string" && s.length > n ? `${s.slice(0, n - 3)}...` : s);
/** Newlines would let one field forge extra `[rollcall]` lines in a peer's context. */
export const oneLine = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : s);

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
function writeAtomic(p, text) {
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, p);
}
const writeJson = (p, v) => writeAtomic(p, JSON.stringify(v));

function readJsonDir(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch {}
  return names.filter((n) => n.endsWith(".json")).map((n) => readJson(join(dir, n))).filter(Boolean);
}

const safeId = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, "_");

// ---------------------------------------------------------------- sessions (global)

const globalDir = () => join(home(), "_sessions");
const globalPath = (id) => join(globalDir(), `${safeId(id)}.json`);

export const readGlobal = (id) => readJson(globalPath(id));
export function writeGlobal(g) {
  mkdirSync(globalDir(), { recursive: true });
  writeJson(globalPath(g.id), g);
}
export const listGlobals = () => readJsonDir(globalDir());

// ---------------------------------------------------------------- supervisor homes
//   _supervisors/<name>/lock.json           the session running this supervisor: { session, at }
//   _supervisors/<name>/seq                 the last task number handed out here (ids are never reused)
//   _supervisors/<name>/tasks/<id>.json     one per task: the owner's words, its worker sessions, state, PR
//   _supervisors/<name>/status/<id>.jsonl   append-only: what the worker's hooks saw (busy, idle, a dialog, its session)
//   _supervisors/<name>/inbox/<id>/*.md     the supervisor's messages to the worker; read/ once the worker read them
//   _supervisors/<name>/wake/q-*.json       news for the supervisor, queued; d-* once a wake carried it
//   _supervisors/<name>/workers/<id>.*      the worker's launch files (settings, launch script, first prompt)
//   _supervisors/<name>/<file>.json         small state: watch (the live watcher), notified, reply-to
// Each home is one supervisor's own: nothing reads across homes except lookups by worktree and gc.

export const HOME_NAME = /^[a-z][a-z0-9-]{0,23}$/;
export const DEFAULT_HOME = "default";
const homesDir = () => join(home(), "_supervisors");
export const homeDir = (name) => join(homesDir(), safeId(name));
const tasksDir = (h) => join(homeDir(h), "tasks");
const taskPath = (h, id) => join(tasksDir(h), `${safeId(id)}.json`);

/** Every home's name. */
export function listHomes() {
  migrateV2Tasks();
  try { return readdirSync(homesDir(), { withFileTypes: true }).filter((d) => d.isDirectory() && HOME_NAME.test(d.name)).map((d) => d.name).sort(); } catch { return []; }
}

export const readTask = (h, id) => (h ? readJson(taskPath(h, id)) : null);
export function writeTask(t) {
  mkdirSync(tasksDir(t.home), { recursive: true });
  writeJson(taskPath(t.home, t.id), { ...t, updatedAt: Date.now() });
}
/** A home's tasks by number; with no home, every home's. */
export function listTasks(h) {
  if (!h) return listHomes().flatMap((x) => listTasks(x));
  return readJsonDir(tasksDir(h)).map((t) => ({ ...t, home: h })).sort((a, b) => a.n - b.n);
}

/** A mkdir lock (atomic): `fn`'s result as { out }, or null when it stays busy. A lock older than 5 s is a crashed holder's. */
function withDirLock(p, fn) {
  mkdirSync(dirname(p), { recursive: true });
  for (let attempt = 0; attempt < 40; attempt++) {
    try { mkdirSync(p); }
    catch (e) {
      if (e.code !== "EEXIST") return null;
      try { if (Date.now() - statSync(p).mtimeMs >= 5000) { rmdirSync(p); continue; } } catch { continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      continue;
    }
    try { return { out: fn() }; } finally { try { rmdirSync(p); } catch {} }
  }
  return null;
}

/** Runs `fn` under a home's task lock (task numbering, read-modify-write of one task). Null when it stays busy. */
export const withTasksLock = (h, fn) => withDirLock(join(tasksDir(h), ".lock"), fn);

/** The next task number in a home (call under withTasksLock). */
export function nextTaskNumber(h) {
  const p = join(homeDir(h), "seq");
  let n = 0;
  try { n = Number(readFileSync(p, "utf8").trim()) || 0; } catch {}
  n = Math.max(n, ...listTasks(h).map((t) => t.n ?? 0)) + 1;
  writeAtomic(p, String(n));
  return n;
}

/**
 * Where a task's worker puts what the owner opens (screenshots, a page to look at, an export): outside its
 * worktree, which gc removes once the work lands (one was removed 29 minutes after the owner was told to open it).
 */
export const filesDir = (h, id) => join(homeDir(h), "files", safeId(id));
/** Where a task's report waits for the owner: saved with `task output`, and kept with its files for good. */
export const reportPath = (h, id) => join(filesDir(h, id), "task-report.md");
export function writeReport(h, id, text) {
  mkdirSync(filesDir(h, id), { recursive: true });
  writeAtomic(reportPath(h, id), text);
}

/**
 * Finished tasks (landed or closed) go two days after their last change: the PR and the worklog keep what
 * shipped. The files a task left for the owner never go, since project memory cites them by path, and the
 * task's report joins them first: a report that cannot be saved keeps its record for the next try.
 */
export function pruneTasks(now = Date.now()) {
  for (const t of listTasks()) {
    if (isOpen(t) || now - (t.updatedAt ?? 0) <= 2 * DAY) continue;
    if (t.output?.text) {
      try { writeReport(t.home, t.id, t.output.text); } catch { continue; }
    }
    for (const p of [taskPath(t.home, t.id), statusPath(t.home, t.id), join(homeDir(t.home), `comments-${t.id}.json`)]) { try { rmSync(p, { force: true }); } catch {} }
    for (const p of [join(homeDir(t.home), "inbox", safeId(t.id)), join(homeDir(t.home), "workers", safeId(t.id))]) { try { rmSync(p, { recursive: true, force: true }); } catch {} }
  }
}

/** When anything in a home last changed, what stays for good aside. */
export function homeLastChange(h) {
  let last = 0;
  try { last = statSync(homeDir(h)).mtimeMs; } catch {}
  const walk = (d, depth) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (["files", "seq"].includes(e.name)) continue;
      const p = join(d, e.name);
      try { last = Math.max(last, statSync(p).mtimeMs); if (depth && e.isDirectory()) walk(p, depth - 1); } catch {}
    }
  };
  try { walk(homeDir(h), 2); } catch {}
  return last;
}

/**
 * Clears a home nobody uses. Its files stay, for the same reason pruneTasks keeps them, and with them its seq,
 * so a task of a name used again never lands in an old task's folder. A home without files goes altogether.
 * `still` is asked under the home's lock, where a session taking the home waits: false leaves the home alone.
 */
export function dropHome(h, still = () => true) {
  const d = homeDir(h);
  withHomeLock(h, () => {
    if (!still()) return;
    const keep = existsSync(join(d, "files")) ? ["files", "seq", ".home.lock"] : [".home.lock"];
    for (const n of readdirSync(d)) if (!keep.includes(n)) rmSync(join(d, n), { recursive: true, force: true });
  });
  try { rmdirSync(d); } catch {}
}

/** A home's small state files (lock, watch, turn, delivery, feed, notified, reply-to). */
export const readHomeFile = (h, name) => readJson(join(homeDir(h), `${name}.json`));
export function writeHomeFile(h, name, v) {
  mkdirSync(homeDir(h), { recursive: true });
  if (v === null) { try { rmSync(join(homeDir(h), `${name}.json`), { force: true }); } catch {} return; }
  writeJson(join(homeDir(h), `${name}.json`), v);
}
/** Runs `fn` under a home's lock for its small state (who holds the home, which watcher runs). */
export const withHomeLock = (h, fn) => withDirLock(join(homeDir(h), ".home.lock"), fn);
/**
 * Runs `fn` under a lock of checkouts' runtime state (runtime.mjs). "ports" guards the port blocks and must stay quick;
 * "spotlight" guards the main checkout's moves (a git checkout), so a slow one never holds up a task's port claim.
 */
export const withRuntimeLock = (fn, scope = "ports") => withDirLock(join(home(), "_runtime", `.${scope}.lock`), fn);

/** A worker's launch files live here (settings, launch script, prompt). */
export function workerDir(h, id) {
  const d = join(homeDir(h), "workers", safeId(id));
  mkdirSync(d, { recursive: true });
  return d;
}

// What a task's worker did, from its hooks: one JSON line per event, newest last.
const statusPath = (h, id) => join(homeDir(h), "status", `${safeId(id)}.jsonl`);
export function appendStatus(h, id, ev) {
  const p = statusPath(h, id);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, `${JSON.stringify({ at: Date.now(), ...ev })}\n`);
  // Keeps the log small: the last 200 events are all anyone reads.
  try { if (statSync(p).size > 128 * 1024) writeAtomic(p, readStatus(h, id).slice(-200).map((e) => `${JSON.stringify(e)}\n`).join("")); } catch {}
}
export function readStatus(h, id) {
  let raw = "";
  try { raw = readFileSync(statusPath(h, id), "utf8"); } catch {}
  return raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// The supervisor's messages to a worker: one file each, moved to read/ once the worker printed it.
const inboxDir = (h, id) => join(homeDir(h), "inbox", safeId(id));
export function writeInbox(h, id, text) {
  mkdirSync(inboxDir(h, id), { recursive: true });
  const name = `${Date.now()}-${process.pid}.md`;
  writeAtomic(join(inboxDir(h, id), name), text);
  return name;
}
/** Unread messages, oldest first: [{ name, at, text }]. */
export function unreadInbox(h, id) {
  let names = [];
  try { names = readdirSync(inboxDir(h, id)).filter((n) => n.endsWith(".md")).sort(); } catch {}
  return names.map((name) => { try { return { name, at: Number(name.split("-")[0]), text: readFileSync(join(inboxDir(h, id), name), "utf8") }; } catch { return null; } }).filter(Boolean);
}
export function markRead(h, id, name) {
  mkdirSync(join(inboxDir(h, id), "read"), { recursive: true });
  try { renameSync(join(inboxDir(h, id), name), join(inboxDir(h, id), "read", name)); } catch {}
}

// The supervisor's news queue. A queued entry (q-) becomes delivered (d-) when a prompt carries it, and goes once
// the turn that prompt started has ended (the Stop hook acks it), so a crash mid-turn loses nothing: the watcher
// queues again what a session that is gone never finished.
const wakeDir = (h) => join(homeDir(h), "wake");
export function enqueueWake(h, w) {
  mkdirSync(wakeDir(h), { recursive: true });
  writeAtomic(join(wakeDir(h), `q-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`), JSON.stringify({ at: Date.now(), ...w }));
}
/**
 * Tells a home's watcher to look now: it watches the wake folder for changes, so a write there wakes it. For
 * news that is not a wake (words held for a worker, a new watcher taking over); listWakes passes it over.
 */
export function pokeWatcher(h) {
  mkdirSync(wakeDir(h), { recursive: true });
  try { writeFileSync(join(wakeDir(h), "poke"), String(Date.now())); } catch {}
}
/** The folder a home's watcher watches (created here, so the watch has something to hold). */
export function wakeFolder(h) {
  mkdirSync(wakeDir(h), { recursive: true });
  return wakeDir(h);
}
/** { queued: [{ name, ...entry }], delivered: [...] }, oldest first. */
export function listWakes(h) {
  let names = [];
  try { names = readdirSync(wakeDir(h)).filter((n) => n.endsWith(".json")).sort(); } catch {}
  const read = (n) => { const w = readJson(join(wakeDir(h), n)); return w ? { ...w, name: n } : null; };
  return { queued: names.filter((n) => n.startsWith("q-")).map(read).filter(Boolean), delivered: names.filter((n) => n.startsWith("d-")).map(read).filter(Boolean) };
}
export function markDelivered(h, names) {
  for (const n of names) { try { renameSync(join(wakeDir(h), n), join(wakeDir(h), `d-${n.slice(2)}`)); } catch {} }
}
export function requeueWakes(h, names) {
  for (const n of names) { try { renameSync(join(wakeDir(h), n), join(wakeDir(h), `q-${n.slice(2)}`)); } catch {} }
}
export function ackWakes(h, names) {
  for (const n of names) { try { rmSync(join(wakeDir(h), n), { force: true }); } catch {} }
}

/**
 * v2 kept every task in one global _tasks/ folder with one id counter. They move to the default home once,
 * ids kept, so a running owner's open tasks carry on there; their v2 workers (`claude --bg`) are marked
 * legacy, and the next start gives each a tmux worker.
 */
function migrateV2Tasks() {
  const old = join(home(), "_tasks");
  if (!existsSync(old)) return;
  withDirLock(join(home(), "_migrate.lock"), () => {
    if (!existsSync(old)) return;
    const h = DEFAULT_HOME;
    mkdirSync(tasksDir(h), { recursive: true });
    for (const t of readJsonDir(old)) {
      if (existsSync(taskPath(h, t.id))) continue;
      const { supervisor, ...rest } = t;
      writeJson(taskPath(h, t.id), { ...rest, home: h, legacy: rest.sessions?.length ? true : undefined });
    }
    let seq = 0;
    try { seq = Number(readFileSync(join(old, "seq"), "utf8").trim()) || 0; } catch {}
    try { if (seq > (Number(readFileSync(join(homeDir(h), "seq"), "utf8")) || 0)) writeAtomic(join(homeDir(h), "seq"), String(seq)); } catch { writeAtomic(join(homeDir(h), "seq"), String(seq)); }
    renameSync(old, join(home(), `_tasks.v2-${Date.now()}`));
  });
}

// ---------------------------------------------------------------- the machine

const machineDir = () => join(home(), "_machine");
const troublePath = () => join(machineDir(), "trouble.json");
const cleanPath = (ext) => join(machineDir(), `clean-list.${ext}`);

/** Where a task with no repo works (`task new --no-repo`, a job on the machine): the same folder each time, so Claude Code asks to trust it once. */
export function machineFolder() {
  const d = join(machineDir(), "jobs");
  mkdirSync(d, { recursive: true });
  return d;
}

/** What stops work now: { open: { <kind>: blocker }, told: { <kind>: when the owner last heard }, looked }. */
export function readTrouble() {
  const t = readJson(troublePath()) ?? {};
  return { open: t.open ?? {}, told: t.told ?? {}, looked: t.looked ?? 0 };
}
/** Runs `fn(t)` on the record under its lock and saves what it leaves: `fn`'s result, or null when the lock stays busy. */
export function updateTrouble(fn) {
  mkdirSync(machineDir(), { recursive: true });
  const r = withDirLock(join(machineDir(), ".lock"), () => {
    const t = readTrouble();
    const out = fn(t);
    writeJson(troublePath(), t);
    return out;
  });
  return r ? r.out : null;
}

const decisionsPath = () => join(machineDir(), "decisions.json");

const decisionsLock = () => join(machineDir(), ".decisions.lock");

/**
 * Under the list's lock: each home's list becomes the one list, once, numbered by age, and the file's being there
 * says it is done. A home's file stays beside it as .moved, whole, since one that cannot be read holds nothing here
 * and may hold the owner's decisions. They once lived in their supervisor's home, and 67 sat across six of them, one
 * unseen while its cause stopped workers.
 */
function gatherDecisions() {
  if (existsSync(decisionsPath())) return;
  const homes = listHomes();
  const items = homes.flatMap((h) => {
    const list = readHomeFile(h, "decisions")?.items;
    return (Array.isArray(list) ? list : []).map((x) => ({ ...x, home: h }));
  }).sort((a, b) => a.at - b.at);
  writeJson(decisionsPath(), { seq: items.length, items: items.map((x, i) => ({ ...x, n: i + 1 })) });
  for (const h of homes) { try { renameSync(join(homeDir(h), "decisions.json"), join(homeDir(h), "decisions.json.moved")); } catch {} }
}

function readList() {
  const d = readJson(decisionsPath());
  return { seq: d?.seq ?? 0, items: Array.isArray(d?.items) ? d.items : [] };
}

/** Whether each home's list has moved to the one list (false while the lock stayed busy). */
export const decisionsGathered = () => existsSync(decisionsPath());

/** What waits on the owner, whichever supervisor it came from: { seq, items: [{ n, text, where, home, from, at }] }, oldest first. */
export function readDecisions() {
  if (!existsSync(decisionsPath())) withDirLock(decisionsLock(), gatherDecisions);
  return readList();
}
/** Runs `fn(d)` on the list under its lock and saves what it leaves: { out }, or null when the lock stays busy. */
export function updateDecisions(fn) {
  return withDirLock(decisionsLock(), () => {
    gatherDecisions();
    const d = readList();
    const out = fn(d);
    writeJson(decisionsPath(), d);
    return out;
  });
}
/** A machine-wide record of rollcall's (`_machine/<name>.json`: away mode, held requests, grants), or null. */
export const readMachineFile = (name) => readJson(join(machineDir(), `${name}.json`));
/**
 * Runs `fn(value)` on machine record `name` under its own lock; `fn` returns { value, out }, and `value` is written
 * (null removes the file). Returns { out }, or null when the lock stays busy.
 */
export function updateMachineFile(name, fn) {
  mkdirSync(machineDir(), { recursive: true });
  return withDirLock(join(machineDir(), `.${name}.lock`), () => {
    const { value, out } = fn(readMachineFile(name));
    const p = join(machineDir(), `${name}.json`);
    if (value === null || value === undefined) rmSync(p, { force: true });
    else writeJson(p, value);
    return out;
  });
}

/** The file the owner opens to see the delete list. */
export const cleanListPath = () => cleanPath("txt");
/** { items, shown (when the owner was shown it, 0 for never) }. */
export const readCleanList = () => { const l = readJson(cleanPath("json")); return { items: l?.items ?? [], shown: l?.shown ?? 0 }; };
export function writeCleanList(items, text, shown = 0) {
  mkdirSync(machineDir(), { recursive: true });
  writeJson(cleanPath("json"), { items, shown });
  writeAtomic(cleanPath("txt"), text);
}

// ---------------------------------------------------------------- repo stores

const repoDir = (key) => join(home(), key);
const stagesPath = (key) => join(repoDir(key), "stages.json");

/** The last few times of each stage of a ship in a repo, { <stage>: [ms] }, for its usual time. */
export const readStageTimes = (key) => (key && readJson(stagesPath(key))) || {};
const STAGE_RUNS = 9;
export function addStageTime(key, stage, took) {
  if (!key) return;
  const t = readStageTimes(key);
  mkdirSync(repoDir(key), { recursive: true });
  writeJson(stagesPath(key), { ...t, [stage]: [...(t[stage] ?? []), took].slice(-STAGE_RUNS) });
}
const sessionsDir = (key) => join(repoDir(key), "sessions");
/** A per-session file in a repo store: `.json` (the record), `.touched`, `.main`, `.lock`. */
const sessionFile = (key, id, ext) => join(sessionsDir(key), `${safeId(id)}.${ext}`);
const eventsPath = (key) => join(repoDir(key), "events.jsonl");

/** Where per-turn worktree snapshots live (snapshot.mjs owns what is inside). */
export const snapshotsDir = () => join(home(), "_snapshots");

export function listRepoKeys() {
  let names = [];
  try { names = readdirSync(home(), { withFileTypes: true }); } catch {}
  return names.filter((d) => d.isDirectory() && !d.name.startsWith("_")).map((d) => d.name);
}

export const readRecord = (key, id) => readJson(sessionFile(key, id, "json"));
export function writeRecord(key, rec) {
  mkdirSync(sessionsDir(key), { recursive: true });
  writeJson(sessionFile(key, rec.id, "json"), rec);
}
export const listRecords = (key) => readJsonDir(sessionsDir(key));

export function readTouched(key, id) {
  let raw = "";
  try { raw = readFileSync(sessionFile(key, id, "touched"), "utf8"); } catch {}
  return [...new Set(raw.split("\n").filter(Boolean))];
}
/** Records `rel` as edited by this session; returns the full touched list. */
export function addTouched(key, id, rel) {
  const touched = readTouched(key, id);
  if (touched.includes(rel)) return touched;
  mkdirSync(sessionsDir(key), { recursive: true });
  appendFileSync(sessionFile(key, id, "touched"), `${rel}\n`);
  return [...touched, rel];
}

/** Small per-session caches (e.g. "main": files changed on main since the session's base). */
export const readCache = (key, id, name) => readJson(sessionFile(key, id, name));
export function writeCache(key, id, name, v) {
  try { mkdirSync(sessionsDir(key), { recursive: true }); writeJson(sessionFile(key, id, name), v); } catch {}
}

/** True at most once per `ms` per repo and name: the caller may start that background job. */
function claimSlot(key, name, ms, now) {
  const stamp = join(repoDir(key), `${name}.stamp`);
  let last = 0;
  try { last = statSync(stamp).mtimeMs; } catch {}
  if (now - last < ms) return false;
  try { mkdirSync(repoDir(key), { recursive: true }); writeFileSync(stamp, ""); return true; } catch { return false; }
}

/** At most once per ROLLCALL_FETCH_MINUTES per repo: a background fetch of origin's default branch. */
export const claimFetchSlot = (key, now = Date.now()) => claimSlot(key, "fetch", minutes("ROLLCALL_FETCH_MINUTES", 5), now);
/** At most once per ROLLCALL_GC_MINUTES (default 60) per repo: a background worktree gc. */
export const claimGcSlot = (key, now = Date.now()) => claimSlot(key, "gc", minutes("ROLLCALL_GC_MINUTES", 60), now);
/** At most once a day per repo: a gc's sweep of its old refs, which pushes to origin. */
export const claimRefsSlot = (key, now = Date.now()) => claimSlot(key, "refs", minutes("ROLLCALL_REFS_MINUTES", 1440), now);
/** At most once per ROLLCALL_LEFTOVERS_MINUTES (default 60) on this machine: gc's sweep of what ended work left behind (leftovers.mjs). */
export const claimLeftoversSlot = (now = Date.now()) => claimSlot("_machine", "leftovers", minutes("ROLLCALL_LEFTOVERS_MINUTES", 60), now);
/** At most once per ROLLCALL_PARK_MINUTES (default 10) on this machine: a background sweep that parks idle sessions (park.mjs). */
export const claimParkSlot = (now = Date.now()) => claimSlot("_park", "park", minutes("ROLLCALL_PARK_MINUTES", 10), now);

/** One gc per repo at a time (mkdir is atomic; a lock older than 15 min is a crashed run's). A release function, or null when busy. */
export function lockGc(key) {
  const p = join(repoDir(key), "gc.lock");
  try { mkdirSync(repoDir(key), { recursive: true }); } catch { return null; }
  try { mkdirSync(p); }
  catch (e) {
    if (e.code !== "EEXIST") return null;
    try {
      if (Date.now() - statSync(p).mtimeMs < 15 * 60_000) return null;
      rmdirSync(p);
      mkdirSync(p);
    } catch { return null; }
  }
  return () => { try { rmdirSync(p); } catch {} };
}

// Background gc runs append what they removed; the next SessionStart in the repo reports it once.
const gcReportPath = (key) => join(repoDir(key), "gc-report.txt");
export function appendGcReport(key, line) {
  try { mkdirSync(repoDir(key), { recursive: true }); appendFileSync(gcReportPath(key), `${oneLine(line)}\n`); } catch {}
}
/** The pending report lines (and clears them). */
export function takeGcReport(key) {
  try { const text = readFileSync(gcReportPath(key), "utf8"); rmSync(gcReportPath(key), { force: true }); return text.split("\n").filter(Boolean); } catch { return []; }
}

/**
 * Runs `fn` under a per-session lock (mkdir is atomic) and returns its result,
 * or null when the lock stays busy. Retries back off exponentially (2, 4, 8 ...
 * 64 ms). Most hooks pass none and skip their update rather than wait; the
 * next hook delivers it. A lock older than 5 s is a crashed holder's.
 */
export function withLock(key, id, fn, { retries = 0 } = {}) {
  const p = sessionFile(key, id, "lock");
  mkdirSync(sessionsDir(key), { recursive: true });
  for (let attempt = 0; attempt <= retries + 1; attempt++) {
    try { mkdirSync(p); }
    catch (e) {
      if (e.code !== "EEXIST") return null;
      let age = 0;
      try { age = Date.now() - statSync(p).mtimeMs; } catch { continue; }
      if (age >= 5000) { try { rmdirSync(p); } catch {} continue; }
      if (attempt < retries) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(2 << attempt, 64));
      continue;
    }
    try { return fn(); } finally { try { rmdirSync(p); } catch {} }
  }
  return null;
}

// ---------------------------------------------------------------- merge queue
//   <repo-key>/queue/state.json   { seq, entries: { <pr>: entry }, bounced: { <pr>: { head, count } }, joined: { <pr>: at },
//                                   train, outcomes, times: { <suite>: [ms] } }
//   <repo-key>/queue/lander.json  the running lander: { pid, at, seen }
//   <repo-key>/queue/lander.log   what the lander did, newest last
//   <repo-key>/queue/tree/        the lander's scratch worktree

const queueDir = (key) => join(repoDir(key), "queue");
export const queueTree = (key) => join(queueDir(key), "tree");
const queueState = (key) => join(queueDir(key), "state.json");

export function readQueue(key) {
  const q = readJson(queueState(key)) ?? {};
  return {
    seq: q.seq ?? 0, entries: q.entries ?? {}, bounced: q.bounced ?? {}, joined: q.joined ?? {}, train: q.train ?? null,
    outcomes: q.outcomes ?? [], times: q.times ?? {}, after: q.after ?? {},
  };
}

/** Runs `fn(q)` on the queue's state under its lock and saves what it leaves: `fn`'s result as { out }, or null when the lock stays busy. */
export function updateQueue(key, fn) {
  return withDirLock(join(queueDir(key), ".lock"), () => {
    const q = readQueue(key);
    const out = fn(q);
    q.outcomes = q.outcomes.slice(-50);
    writeJson(queueState(key), q);
    return out;
  });
}

export const readLander = (key) => readJson(join(queueDir(key), "lander.json"));

/** Takes the repo's lander slot for `pid` (none held, or its holder's process is gone). True when this pid holds it now. */
export function claimLander(key, pid) {
  return withDirLock(join(queueDir(key), ".lander.lock"), () => {
    const cur = readLander(key);
    if (cur?.pid && cur.pid !== pid && sameProcess(cur.pid, cur.start)) return false;
    const mine = cur?.pid === pid;
    writeJson(join(queueDir(key), "lander.json"), { pid, start: mine ? cur.start : startOf(pid), at: mine ? cur.at : Date.now(), seen: Date.now() });
    return true;
  })?.out === true;
}
export function releaseLander(key, pid) {
  withDirLock(join(queueDir(key), ".lander.lock"), () => {
    if (readLander(key)?.pid === pid) rmSync(join(queueDir(key), "lander.json"), { force: true });
  });
}

export function appendLanderLog(key, line) {
  const p = join(queueDir(key), "lander.log");
  try {
    mkdirSync(queueDir(key), { recursive: true });
    appendFileSync(p, `${new Date().toISOString()} ${oneLine(line)}\n`);
    if (statSync(p).size > 256 * 1024) writeAtomic(p, readFileSync(p, "utf8").split("\n").slice(-1000).join("\n"));
  } catch {}
}

// ---------------------------------------------------------------- events

/** `text` (a message) keeps its line breaks: it is always shown JSON-quoted. Every other string is made one line. */
export function appendEvent(key, ev) {
  mkdirSync(repoDir(key), { recursive: true });
  const e = { ts: Date.now(), ...ev };
  for (const k of Object.keys(e)) e[k] = clip(k === "text" ? e[k] : oneLine(e[k]));
  appendFileSync(eventsPath(key), `${JSON.stringify(e)}\n`);
  return e;
}

/** Parses one log line. A line torn by a crashed writer and completed by the next append still yields that next event. */
function parseEvent(line) {
  try { return JSON.parse(line); } catch {}
  const k = line.lastIndexOf('{"ts":'); // ts is always the first key, and cannot occur inside a JSON string
  if (k <= 0) return null;
  try { return JSON.parse(line.slice(k)); } catch { return null; }
}

/**
 * The end of the log, as a cursor: a new reader starts here and sees only what
 * comes after. With no log yet, everything that appears later is new (ts 0).
 */
export function logEnd(key) {
  try { const st = statSync(eventsPath(key)); return { ino: st.ino, off: st.size, ts: Date.now() }; }
  catch { return { ino: 0, off: 0, ts: 0 }; }
}

/** Cheap check (one stat) for whether anything was appended after `cursor`. */
export function hasNewEvents(key, cursor) {
  try { const st = statSync(eventsPath(key)); return !cursor || st.ino !== cursor.ino || st.size !== cursor.off; }
  catch { return false; }
}

/**
 * Events after `cursor`. A cursor is { ino, off, ts }: the byte offset into the
 * log file it was taken from. When pruning replaced the file (new inode), the
 * whole new file is scanned and only events newer than cursor.ts are returned.
 * A trailing line without a newline (an append in flight) is left for next time.
 */
export function readEventsSince(key, cursor) {
  let fd;
  try { fd = openSync(eventsPath(key), "r"); } catch { return { events: [], cursor }; }
  try {
    const st = fstatSync(fd);
    const sameFile = cursor && cursor.ino === st.ino && cursor.off <= st.size;
    const start = sameFile ? cursor.off : 0;
    if (st.size === start) return { events: [], cursor: { ino: st.ino, off: start, ts: cursor?.ts ?? 0 } };
    const buf = Buffer.alloc(st.size - start);
    readSync(fd, buf, 0, buf.length, start);
    const end = buf.lastIndexOf(0x0a) + 1;
    const events = [];
    let ts = cursor?.ts ?? 0;
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      if (!line) continue;
      const e = parseEvent(line);
      if (!e) continue;
      if (!sameFile && cursor && e.ts <= cursor.ts) continue;
      events.push(e);
      if (e.ts > ts) ts = e.ts;
    }
    return { events, cursor: { ino: st.ino, off: start + end, ts } };
  } finally { closeSync(fd); }
}

export const readAllEvents = (key) => readEventsSince(key, null).events;

// ---------------------------------------------------------------- pruning

const DAY = 24 * 60 * 60_000;

/** Keeps the store small: old events and long-dead sessions go. Runs at SessionStart only. */
export function prune(key) {
  const now = Date.now();
  const gone = (r) => (r.endedAt ? now - r.endedAt > DAY : !pidAlive(r.pid, r.pidStart) && now - (r.seen ?? r.startedAt ?? 0) > DAY);
  try {
    if (statSync(eventsPath(key)).size > 256 * 1024) {
      const keep = readAllEvents(key).filter((e) => now - e.ts < 3 * DAY).slice(-2000);
      writeAtomic(eventsPath(key), keep.map((e) => `${JSON.stringify(e)}\n`).join(""));
    }
  } catch {}
  for (const rec of listRecords(key).filter(gone)) {
    for (const ext of ["json", "touched", "main"]) { try { rmSync(sessionFile(key, rec.id, ext), { force: true }); } catch {} }
  }
  for (const g of listGlobals().filter(gone)) { try { rmSync(globalPath(g.id), { force: true }); } catch {} }
}
