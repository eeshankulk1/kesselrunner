// Supervisors and their workers. A supervisor is a named home (store.mjs "supervisor homes") that one live
// session holds at a time: `/supervisor alpha` in one tab, `/supervisor beta` in another, each with its own
// tasks, id counter, wake queue and tmux session. A worker is an ordinary interactive session of its task's
// harness (Claude Code or Codex: harness/) in a tmux window of its home's tmux session, started in the task's
// worktree with a known session id, so a dead one resumes with its context. Its hooks (Claude Code's, from a settings
// file passed at launch) or its protocol events (Codex's, codex/worker.mjs) record what it is doing through
// workerHook; the owner's words and picks reach it as its next prompt, with a receipt (delivery.mjs); the
// supervisor's own messages go to its file inbox.
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe } from "./asked.mjs";
import { dialogFlag, drop, enqueue, flush, keyQuietMs, launching, noteTyped, received, waiting } from "./delivery.mjs";
import { defaultBranch, fetchSync, gitSync, locate } from "./git.mjs";
import { sameProcess, spawnDetached } from "./proc.mjs";
import { BIN, P, currentSession, isHolding, short } from "./session.mjs";
import { isOpen, transition } from "./state.mjs";
import * as store from "./store.mjs";
import * as tmux from "./tmux.mjs";
import { openBlocker, resetAt } from "./trouble.mjs";
import { adapter, effortOk, harnessOf, sessionHarness, workerAdapter } from "./harness/index.mjs";
import { MODES, modelOk } from "./harness/claude.mjs";

/** A worker's environment names its task, so its own `rollcall task ...` commands need no home. */
export const TASK_ENV = "ROLLCALL_TASK";
/** The task this process works for ({ home, id }), from its worker's environment, or null. */
export function taskEnv(env = process.env) {
  const m = /^([a-z][a-z0-9-]*):(t\d+)$/.exec(env[TASK_ENV] ?? "");
  return m ? { home: m[1], id: m[2] } : null;
}

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
/**
 * Each task's color, by its number: its chip, its tab and its worker's status line are drawn in it (truecolor,
 * so the terminal's theme does not change it), and the band draws a picker question's task line in it, so the
 * owner tells tasks apart at a glance.
 */
export const TASK_COLORS = [{ hex: "#0A84FF" }, { hex: "#30D158" }, { hex: "#BF5AF2" }, { hex: "#FF9F0A" }, { hex: "#FFD60A" }, { hex: "#FF453A" }];
const numberOf = (id) => Math.max(1, Number(String(id).replace(/^t/i, "")) || 1);
export const colorOf = (id) => TASK_COLORS[(numberOf(id) - 1) % TASK_COLORS.length];
/** How the owner sees a task: its name and its title ("yoda · chat header"). */
export const label = (t) => `${nameOf(t.id)} · ${t.title}`;
/** How the supervisor starts, resumes and stops workers (kesselrunner's launcher). */
export const START = "node ~/.claude/kesselrunner/scripts/supervisor/start.mjs";

// ---------------------------------------------------------------- names

// Supervisors are named for ships, the first for falcon itself; tasks for characters. One word each.
/** A new supervisor's name, picked for the owner: the first of these no home has taken yet. */
export const SHIPS = ["falcon", "venator", "ghost", "tantive", "executor", "razorcrest", "outrider", "devastator", "scimitar", "xwing", "ywing", "awing"];
/** A task's name, by its number: t1 is yoda, t2 leia, and so on; t19 is yoda-2. */
export const CHARACTERS = ["yoda", "leia", "luke", "han", "rey", "finn", "poe", "lando", "chewie", "ahsoka", "padme", "anakin", "grogu", "mace", "hera", "ezra", "jyn", "wedge"];

/** The first ship no home uses, then the same with -2, -3, ... once all are taken. */
export function pickName(taken = new Set(store.listHomes())) {
  for (let i = 1; ; i++) for (const n of SHIPS) if (!taken.has(i === 1 ? n : `${n}-${i}`)) return i === 1 ? n : `${n}-${i}`;
}

/** Task `id`'s name: "t1" is "yoda", "t19" "yoda-2". */
export function nameOf(id) {
  const n = numberOf(id) - 1;
  const round = Math.floor(n / CHARACTERS.length) + 1;
  return `${CHARACTERS[n % CHARACTERS.length]}${round > 1 ? `-${round}` : ""}`;
}

/** The task id a word the owner typed stands for: a name ("yoda", "yoda-2") or an id ("t3", "3"); else null. */
export function idOf(word) {
  const w = String(word ?? "").trim().toLowerCase();
  if (/^t?\d+$/.test(w)) return `t${Number(w.replace(/^t/, ""))}`;
  const m = /^([a-z]+)(?:-(\d+))?$/.exec(w);
  const i = m ? CHARACTERS.indexOf(m[1]) : -1;
  if (i < 0 || (m[2] !== undefined && Number(m[2]) < 2)) return null;
  return `t${(Number(m[2] ?? 1) - 1) * CHARACTERS.length + i + 1}`;
}

// ---------------------------------------------------------------- which session runs which home

/** The home session `id` runs, or null. One lock read per home: this runs on every status line refresh. */
export function homeOf(id) {
  if (!id) return null;
  for (const h of store.listHomes()) if (store.readHomeFile(h, "lock")?.session === id) return h;
  return null;
}

/** The live session holding home `h` (following one sent to the background to its successor), or null. */
export function holderOf(h) {
  const lock = store.readHomeFile(h, "lock");
  const cur = lock?.session ? currentSession(lock.session) : null;
  return isHolding(cur) ? cur : null;
}

/**
 * Supervisors nobody came back to, once nothing in the home changed for a week, neither it nor a worker runs and
 * no tmux window of it is left (a parked tab waits for Enter however long it takes): its open tasks close, which
 * starts their own two days (store.pruneTasks) and a new week, and a home left with no open task is dropped. Its
 * decisions stay on the owner's one list.
 */
export function pruneHomes(now = Date.now()) {
  // A home going now must not take its list with it: each home's list moves to the one list before anything else.
  store.readDecisions();
  if (!store.decisionsGathered()) return; // the lock was busy: a home dropped now would take its list with it
  for (const h of store.listHomes()) {
    try {
      if (now - store.homeLastChange(h) <= 7 * 86400_000 || holderOf(h)) continue;
      const open = store.listTasks(h).filter(isOpen);
      if (tmux.windows(h).size || open.some((t) => workerState(t, now)?.alive)) continue;
      for (const t of open) {
        store.withTasksLock(h, () => {
          const x = store.readTask(h, t.id);
          if (!isOpen(x)) return;
          transition(x, "abandoned", { now });
          x.notes.push({ at: now, by: "rollcall", text: "closed: its supervisor and worker were gone for a week" });
          store.writeTask(x);
        });
      }
      // A closed task's record waits for pruneTasks (it may hold a report not yet saved); a session may take the home meanwhile.
      if (!open.length) store.dropHome(h, () => !holderOf(h) && !store.listTasks(h).length);
    } catch {} // This runs in SessionStart: one home's trouble must not stop the start.
  }
}

/**
 * Session `g` takes home `h`: refused while another live session holds it (the second tab stays a plain
 * session and can read the home's tasks). A session holds one home: taking one lets go of any other.
 * Returns { ok, holder }.
 */
export function takeHome(g, h, now = Date.now()) {
  const r = store.withHomeLock(h, () => {
    const holder = holderOf(h);
    if (holder && holder.id !== g.id) return { ok: false, holder };
    store.writeHomeFile(h, "lock", { session: g.id, at: now });
    // A session that takes a parked home runs it now: its parked watcher stands down at its next look.
    store.writeHomeFile(h, "parked", null);
    return { ok: true };
  });
  if (!r) return { ok: false, holder: null };
  if (r.out.ok) for (const other of store.listHomes()) if (other !== h && store.readHomeFile(other, "lock")?.session === g.id) store.writeHomeFile(other, "lock", null);
  return r.out;
}

export function releaseHome(g) {
  for (const h of store.listHomes()) if (store.readHomeFile(h, "lock")?.session === g.id) store.writeHomeFile(h, "lock", null);
}

/**
 * At session start: a session that continues a supervisor (Claude Code sent it to the background under a
 * new id) takes over its home, so its tasks, chips and watcher follow it. Returns the notice lines.
 */
export function inheritHome(g, now = Date.now()) {
  const lines = [];
  for (const h of store.listHomes()) {
    const lock = store.readHomeFile(h, "lock");
    if (!lock?.session || lock.session === g.id || currentSession(lock.session)?.id !== g.id) continue;
    store.writeHomeFile(h, "lock", { session: g.id, at: now, from: lock.session });
    const old = store.readGlobal(lock.session);
    store.writeGlobal({ ...store.readGlobal(g.id), ...g, supervisor: { ...old?.supervisor, home: h, at: now }, mode: g.mode ?? old?.mode });
    const open = store.listTasks(h).filter(isOpen).map((t) => t.id);
    lines.push(`${P} This session continues supervisor ${h} (session ${short(lock.session)} was sent to the background), so it runs ${h} now${open.length ? `: ${open.join(", ")}` : ""}.`);
  }
  return lines;
}

// ---------------------------------------------------------------- the home's watcher

/** Whether home `h` has its watcher process (watch.mjs) running now. A watcher from before this kind (its file carries a generation) does not count: a new one takes the home from it. */
export const watcherRuns = (h) => { const w = store.readHomeFile(h, "watch"); return !!w?.pid && w.gen === undefined && sameProcess(w.pid, w.start); };

/** What a watcher must not inherit from the session that happened to start it: it is nobody's, and outlives them all. */
const NOT_THE_WATCHERS = ["ROLLCALL_SESSION", "ROLLCALL_TASK", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PROJECT_DIR", "CLAUDE_ENV_FILE"];
export function watcherEnv() {
  const env = { ...process.env };
  for (const k of NOT_THE_WATCHERS) delete env[k];
  return env;
}

/**
 * Starts home `h`'s watcher unless one runs. Every place a home gets something to do calls this (the supervisor's
 * status line and session start, a worker's turn, the sweep at any session start), and two that race settle it
 * under the home's lock (watchHome), so a watcher that died (a crash, a Mac restart) comes back by itself.
 */
export function ensureWatcher(h) {
  if (store.envFlag("ROLLCALL_WATCHER") !== false && !watcherRuns(h)) spawnDetached(process.execPath, [BIN, "watch", h], { env: watcherEnv(), cwd: store.homeDir(h) });
}

// ---------------------------------------------------------------- what a worker is doing

/**
 * What a worker's status log says about it, folded in one place: the hooks and rollcall only ever add events, and
 * this alone reads them. { turn (the last busy, idle or launch event), last (the same, or its exit), launch (the
 * last launch event), started (a session came up since it), up (when its Claude Code last started), held ("parked" or
 * "stopped" when rollcall stopped it and nothing started it since) }. Other events change nothing here.
 */
export function running(log) {
  const r = { turn: null, last: null, launch: null, started: true, up: 0, held: null };
  for (const e of log) {
    if (e.ev === "launch") Object.assign(r, { turn: e, last: e, launch: e, started: false, up: e.at, held: null });
    else if (e.ev === "session") Object.assign(r, { started: true, up: e.at, held: null });
    else if (e.ev === "busy" || e.ev === "idle") Object.assign(r, { turn: e, last: e });
    else if (e.ev === "exit") r.last = e;
    else if (e.ev === "parked" || e.ev === "stopped") r.held = e.ev;
  }
  return r;
}

/** What the open dialog's flag says it asks: { type, message, tool, what, why }; a flag from before it said so holds the message alone. */
function dialogAsks(h, id) {
  let text = "";
  try { text = readFileSync(dialogFlag(h, id), "utf8"); } catch { return null; }
  try { const x = JSON.parse(text); if (x && typeof x === "object") return x; } catch {}
  return { type: null, message: text || null, tool: null, what: null, why: null };
}

/**
 * The task's worker now, from its hooks' log and its tmux pane, or null when it never had one:
 * { window, alive, busy, dialog (since when a dialog has been open in it), asks (what that dialog asks:
 * { type, message, tool, what, why }), session, legacy, context (percent),
 * tokens and size (its context in tokens, and the window's), since, and from the end of its last turn: bg (the
 * background work still running then, or null where Claude Code does not say) and last (its last words) }.
 * A legacy worker is a v2 background session (`claude --bg`): v3 cannot drive it, and resumes it in tmux.
 */
export function workerState(t, now = Date.now()) {
  const s = t.sessions?.at(-1);
  if (!s || s.endedAt) return null;
  const c = store.readHomeFile(t.home, `context-${t.id}`);
  const ctx = c && now - c.at < 6 * 3600_000 && (!c.session || c.session === s.id) ? c : null;
  const context = ctx?.pct ?? null;
  const tokens = ctx?.tokens ?? null;
  const size = ctx?.size ?? null;
  // A Codex worker's thread also says what it used in all, across compactions.
  const total = ctx?.total ?? null;
  if (!s.tmux) return { window: false, alive: false, busy: false, dialog: null, asks: null, session: s.id, harness: "claude", legacy: true, parked: false, context, tokens, size, total, since: s.at, bg: null, last: null };
  const w = tmux.windowOf(t.home, t.id);
  const r = running(store.readStatus(t.home, t.id));
  const idle = r.turn?.ev === "idle";
  let dialog = null;
  try { dialog = statSync(dialogFlag(t.home, t.id)).mtimeMs; } catch {}
  return {
    window: !!w, alive: !!w?.alive, busy: !!w?.alive && !idle, dialog: w?.alive ? dialog : null,
    asks: w?.alive && dialog ? dialogAsks(t.home, t.id) : null,
    // Parked: rollcall stopped it while it sat idle. Stopped: on purpose (start.mjs --stop), and no one resumes it unasked.
    session: s.id, harness: sessionHarness(s), legacy: false, parked: r.held === "parked" && !w?.alive, context, tokens, size, total, since: r.turn?.at ?? s.at,
    stopped: r.held === "stopped",
    bg: idle ? r.turn.bg ?? null : null, last: idle ? r.turn.last ?? null : null,
    // The mode, model and effort it was launched with, so a parked or stopped worker comes back on the same ones.
    mode: r.launch?.mode ?? null, model: r.launch?.model ?? null, effort: r.launch?.effort ?? null,
    // When its Claude Code last started (a resume by Enter in a parked tab ends no turn, so `since` stays old).
    up: r.up, launchedAt: r.launch?.at ?? null, started: r.started,
  };
}

// ---------------------------------------------------------------- a finished task's window

/**
 * How long a finished task's window stays after its worker's last turn, so the owner can still ask it
 * something. Each new turn (the owner typed into it) starts the wait again.
 */
export const closeAfterMs = () => { const v = Number(process.env.ROLLCALL_CLOSE_AFTER_MS); return Number.isFinite(v) && v > 0 ? v : 10 * 60_000; };

/** When a finished task's window closes, for its worker state `w`: null while the worker works, now once it left. */
export function closesAt(w, now = Date.now()) {
  if (!w?.alive) return now;
  return w.busy ? null : w.since + closeAfterMs();
}

/**
 * What a finished task's tab says about its window: "closes in 7m", "closes when you leave it" (due while a
 * terminal shows it), "closing" (due: the watcher's next poll), or null while its worker works.
 */
export function closing(t, w, now = Date.now()) {
  const at = closesAt(w, now);
  if (at === null) return null;
  if (at > now) return `closes in ${Math.ceil((at - now) / 60_000)}m`;
  return w?.alive && tmux.viewed(t.home, t.id) ? "closes when you leave it" : "closing";
}

/**
 * A finished task's worktree back where it was after gc removed it, since Claude Code finds a conversation
 * only from the folder it ran in: on its branch when that still exists, else the default branch (where its
 * work landed), detached. gc collects it again once its worker leaves. Returns { ok, err }.
 */
function restoreWorktree(t) {
  if (existsSync(t.worktree)) return { ok: true };
  const info = locate(t.repo.main);
  const b = info && defaultBranch(info);
  if (!b) return { ok: false, err: `${t.repo.name} has no origin default branch to bring back ${t.worktree} from` };
  fetchSync(info.top, b);
  gitSync(info.top, ["worktree", "prune"]);
  const own = t.branch && gitSync(info.top, ["rev-parse", "--verify", "--quiet", `refs/heads/${t.branch}`]).status === 0;
  const r = gitSync(info.top, ["worktree", "add", ...(own ? [t.worktree, t.branch] : ["--detach", t.worktree, `origin/${b}`])], { timeout: 300_000 });
  return r.status === 0 ? { ok: true } : { ok: false, err: `git worktree add failed: ${r.stderr.trim()}` };
}

// ---------------------------------------------------------------- handing off

/**
 * A worker's context use, in percent, at which a fresh worker takes over. At `soft` the worker hears one
 * note and judges whether the task needs one now (the owner finds a worker does its best work below about
 * 35%); at `cap` rollcall makes the worker hand off, whatever it is doing.
 */
export const HANDOFF = { soft: 35, cap: 70 };

/** What a handoff holds, in one sentence for the brief and both notes: it says what to read, so the next worker need not find out. */
export const HANDOFF_HOLDS =
  "the prompt the owner would paste into a fresh session to carry on: where the work stands, what is done (commits, PR, checks run), " +
  "the files to read first and what each is for, what remains, the owner's decisions and any open question. Facts, not orders: the next worker picks its own steps.";

/** The cap flag: up while the worker has something to hear about its context use (markCap). */
export const capFlag = (h, id) => join(store.workerDir(h, id), "cap");

// The session that heard the soft mark: the worker is told once, then judges for itself.
const softFlag = (h, id) => join(store.workerDir(h, id), "soft");
const softHeard = (h, id) => { try { return readFileSync(softFlag(h, id), "utf8"); } catch { return null; } };

/**
 * From the worker's status line: the cap flag is up while session `session` has something to hear about its
 * context use and has not handed off: once at the soft mark while the task is being worked ("soft"), and for
 * as long as it is at the cap ("cap"). Its hooks test for the file in the shell, so node runs only while it is up.
 */
export function markCap(t, session, pct) {
  const flag = capFlag(t.home, t.id);
  const ok = isOpen(t) && !!session && t.handoff?.session !== session;
  const level = !ok ? null : pct >= HANDOFF.cap ? "cap" : pct >= HANDOFF.soft && t.state === "working" && softHeard(t.home, t.id) !== session ? "soft" : null;
  if (!level) { if (existsSync(flag)) rmSync(flag, { force: true }); return; }
  let up = null;
  try { up = JSON.parse(readFileSync(flag, "utf8")); } catch {}
  if (up?.session !== session || up.pct !== pct || up.level !== level) writeFileSync(flag, JSON.stringify({ session, pct, level, at: Date.now() }));
}

export const clearCap = (h, id) => rmSync(capFlag(h, id), { force: true });

/** The cap flag when it is up for session `session`: { session, pct, level, at }, else null. */
function capDue(h, id, session) {
  try {
    const up = JSON.parse(readFileSync(capFlag(h, id), "utf8"));
    // A status line that read the task just before the handoff may raise the flag again: the handoff wins.
    return up.session && up.session === session && store.readTask(h, id)?.handoff?.session !== session ? up : null;
  } catch { return null; }
}

/** The soft mark is heard once: the flag goes, and the status line raises it again only at the cap. */
function heardSoft(h, id, session) {
  writeFileSync(softFlag(h, id), session);
  clearCap(h, id);
}

/** What a worker past the soft mark hears, once: it judges whether a fresh worker should carry on. */
export const softText = (t, pct) =>
  `${P} Your context is at ${pct}%. A worker does its best work below about ${HANDOFF.soft}%, so judge now whether a fresh worker should carry on: ` +
  "when more than a small part of the task remains (you are not shipping, not nearly done, and did not just start from a handoff), hand off at your next clean point " +
  `(after a commit or a passing check): commit, write ${HANDOFF_HOLDS} Save it with \`rollcall task handoff ${t.id} --file <file>\` and end your turn. ` +
  "When only checks and the ship question remain, a fresh worker would pay to learn what you know: do not hand off. " +
  `Otherwise carry on, and say what is left in one line: \`rollcall task note ${t.id} "context ${pct}%: carrying on, <what is left>"\`. At ${HANDOFF.cap}% rollcall makes you hand off.`;

/** What a worker at the cap hears: stop, hand off, end the turn. Whole in itself, for workers briefed before the cap existed. */
export const capText = (t, pct) =>
  `${P} Your context is at ${pct}%, the cap for a worker (${HANDOFF.cap}%): hand off now, whatever you are doing, and do no more of the task. ` +
  "Let background work that is about to finish finish, else stop it. Commit what you have (a WIP commit is fine). " +
  `Then write your handoff, ${HANDOFF_HOLDS} Save it with \`rollcall task handoff ${t.id} --file <file>\` and end your turn. rollcall starts a fresh worker from it.`;

/**
 * What a worker hears when a turn starts while its task still waits on the owner, or null. Only the owner's words
 * (ownerSaid) or the worker's own `task set` clear needs-you, and the owner is reminded until one does: a worker
 * that moved on without either kept the owner's notifications coming for a question nobody needed answered. `ours`:
 * the prompt was a delivery of rollcall's. Any other may be the owner's own answer, which the transcript settles
 * only after this hook, so the line allows for it.
 */
function stillWaits(t, ours) {
  if (t.state !== "needs-you") return null;
  return `${P} Task ${t.id} still waits on the owner (needs-you), and they get a reminder every 10 minutes until it clears: ` +
    `"${store.clip(store.oneLine(t.question ?? "a question"), 200)}". If you still need them, their answer comes back typed as your prompt; ` +
    `if you no longer do, run \`rollcall task set ${t.id} --state working\`.${ours ? "" : " If this prompt is their answer, rollcall closes the question by itself."}`;
}

// ---------------------------------------------------------------- launching

/**
 * A worker starts on a model and effort named on its command line, never on whatever `/model` last saved to the
 * owner's settings (harness/claude.mjs). Each harness maps a task's model to one it takes (harness/*.mjs `models`).
 */
export { EFFORTS, effortOk } from "./harness/index.mjs";
export { modelOk, trusted } from "./harness/claude.mjs";

/**
 * The plugins whose MCP servers drive a browser. Of the plugins the core enables, only these start a local
 * process in every session (through npx, two or three node processes each, ~160 MB a session); the others
 * reach a remote server or start nothing until used.
 */
export const BROWSER_PLUGINS = ["playwright@claude-plugins-official", "chrome-devtools-mcp@claude-plugins-official"];

const readManifest = (dir) => { if (!dir) return null; try { return JSON.parse(readFileSync(join(dir, ".claude", "test-manifest.json"), "utf8")); } catch { return null; } };

/**
 * Whether the task's worker gets the browser servers: the task asked for them (`task new --browser`), its
 * repo's test manifest shows something a browser can test (a dev server, routes, a browser or web stack),
 * or there is no manifest to say. A worker without them loses nothing it could use.
 */
export function wantsBrowser(t) {
  if (t.browser) return true;
  const m = readManifest(t.worktree) ?? readManifest(t.repo?.main ?? "");
  if (!m || typeof m !== "object") return true;
  const stacks = Array.isArray(m.stacks) ? m.stacks : [];
  const webby = /\b(web|frontend|e2e|browser)\b/i;
  return !!(m.devServer || m.routes || m.auth?.storageState || stacks.some((x) => /playwright|cypress|webdriver|puppeteer/i.test(String(x?.runner ?? "")) || webby.test(String(x?.name ?? "")) || webby.test(String(x?.dir ?? ""))));
}

/** Plugin choices for a session that needs no browser: the browser servers off. */
export const noBrowser = () => Object.fromEntries(BROWSER_PLUGINS.map((p) => [p, false]));

/** rollcall's status line, refreshed every `seconds` besides on each new message (settings merge key by key, so the user's 5 s goes unless replaced). */
export const statusLine = (seconds) => ({ type: "command", command: `node ${q(BIN)} statusline`, refreshInterval: seconds });

/**
 * Starts the task's worker in its tmux window on the task's harness (harness/): a new session, with `prompt` as its
 * first prompt (the brief), or with `resume` its last session again, or the earlier one `session` names (with
 * `prompt` as the owner's words or a nudge), each on the harness it ran on. A resumed worker whose worktree gc removed
 * gets it back first. `model` and `effort` go on its command line where its harness takes them (else the harness's
 * own choice). Records the session, and its harness, on the task. Returns { ok, session, err }.
 */
export function launch(t, { prompt, resume = false, session: pick = null, mode = null, name = null, model = null, effort = null }) {
  if (!tmux.available()) return { ok: false, err: "tmux is not installed (brew install tmux)" };
  if (resume) { const r = restoreWorktree(t); if (!r.ok) return r; }
  const last = t.sessions?.at(-1);
  const again = resume && last ? t.sessions.find((s) => s.id === (pick ?? last.id)) ?? last : null;
  const harness = again ? sessionHarness(again) : harnessOf(t);
  const a = adapter(harness);
  // A v2 worker is a background session the daemon may still run: stopped first, so one conversation has one process.
  if (last && !last.tmux && !last.endedAt) adapter(last).stopLegacy(last.id);
  model = modelOk(model) ? model : null;
  effort = effortOk(effort) ? effort : null;
  const { script, session } = a.writeLaunch(t, { prompt, resume, session: pick, mode, name, model, effort });
  rmSync(dialogFlag(t.home, t.id), { force: true });
  launching(t, prompt, { fresh: session !== last?.id });
  // Another session than the last starts with a context of its own: the last one's use and cap flag are not its.
  if (session !== last?.id) { clearCap(t.home, t.id); store.writeHomeFile(t.home, `context-${t.id}`, null); }
  const r = tmux.runInWindow(t.home, t.id, t.worktree, paneCommand(script));
  if (!r.ok) return { ok: false, err: r.err || "tmux could not open the window" };
  // Its tab reads right at once; the supervisor's status line adds its state and color within seconds.
  tmux.setTabs(t.home, new Map([[t.id, { tab: label(t) }]]));
  store.appendStatus(t.home, t.id, { ev: "launch", session, resume, harness, mode: MODES.has(mode) ? mode : null, model, effort });
  store.withTasksLock(t.home, () => {
    const x = store.readTask(t.home, t.id);
    if (!x) return;
    const now = Date.now();
    if (resume && x.sessions.at(-1)?.id === session) {
      Object.assign(x.sessions.at(-1), { tmux: true, endedAt: null });
    } else {
      // An earlier worker brought back becomes the task's worker again, under its own name.
      const was = x.sessions.find((s) => s.id === session);
      for (const s of x.sessions) s.endedAt ??= now;
      x.sessions.push({ id: session, name: name ?? was?.name ?? null, at: now, endedAt: null, tmux: true, ...(harness !== "claude" ? { harness } : {}), ...(was?.thread ? { thread: was.thread } : {}) });
      transition(x, "fresh-worker", { now });
    }
    delete x.legacy;
    store.writeTask(x);
  });
  return { ok: true, session };
}

/** What a task's pane runs: a login shell that sources `script`, then stays a shell (a pane back at a bare shell is a dead worker). */
function paneCommand(script) {
  const shell = process.env.SHELL || "/bin/zsh";
  return [shell, "-lic", `. ${q(script)}; exec ${q(shell)} -li`];
}

/** Stops the task's worker (its worktree and record stay). */
export function stopWorker(t) {
  store.appendStatus(t.home, t.id, { ev: "stopped" });
  return tmux.killWindow(t.home, t.id);
}

// ---------------------------------------------------------------- parking

// A worker that sits idle while its task waits on a PR or the owner holds a whole Claude Code session (its
// MCP servers too) for nothing: past PARK_AFTER it parks, and comes back when it is needed. A supervisor
// falcon runs parks once its conversation has been quiet PARK_SUPERVISOR_AFTER between turns (park.mjs): an
// hour, the prompt cache's lifetime, past which its next turn re-reads the whole conversation anyway.
const msEnv = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : dflt; };
export const parkAfterMs = () => msEnv("ROLLCALL_PARK_AFTER_MS", 15 * 60_000);
export const parkSupervisorAfterMs = () => msEnv("ROLLCALL_PARK_SUPERVISOR_MS", 3600_000);
// A worker counts as starting (not dead, not stuck) this long after its launch.
export const startingMs = () => msEnv("ROLLCALL_STARTING_MS", 20_000);
/** ROLLCALL_PARK=0 keeps every session running. */
export const parkingOn = () => store.envFlag("ROLLCALL_PARK") !== false;
const PARKABLE = new Set(["pr-open", "queued", "needs-you"]);

/**
 * Whether the task's worker `w` parks now: its task waits on a PR, the owner or a check (`t.wait`), its turn ended long enough
 * ago with nothing left running (where Claude Code did not say what runs, it stays), no words or doorbell
 * wait for it, and no terminal shows its window.
 */
export function parkDue(t, w, now = Date.now()) {
  if (!parkingOn() || !isOpen(t) || !(PARKABLE.has(t.state) || t.wait)) return false;
  if (!w || w.legacy || !w.alive || w.busy || w.dialog || !Array.isArray(w.bg) || w.bg.length) return false;
  if (now - Math.max(w.since, w.up ?? 0) < parkAfterMs()) return false;
  if (waiting(t.home, t.id).length) return false;
  return !tmux.viewed(t.home, t.id);
}

/**
 * Parks the task's worker: its Claude Code stops (its conversation is saved, and its SessionEnd hooks run as
 * on any exit), and its tab says so; Enter there resumes the same conversation in place, waiting for the
 * owner's words. A shell stays in the worktree meanwhile, so gc leaves it alone. The worker also comes back
 * by itself when it is needed (unpark). Returns whether it parked.
 */
export function park(t, w, now = Date.now()) {
  const { script } = workerAdapter(t).writeLaunch(t, { resume: true, mode: w.mode, model: w.model, effort: w.effort });
  const parked = join(store.workerDir(t.home, t.id), "parked.sh");
  const idle = Math.max(1, Math.round((now - w.since) / 60_000));
  const lines = [
    `# rollcall: task ${t.home}:${t.id}'s worker is parked. Its tmux pane sources this file; Enter resumes it here.`,
    `printf '\\n  %s is parked: its worker stopped after %s minutes idle, to free memory. Its conversation is saved.\\n  Press Enter to bring it back here. It also comes back by itself when the owner or the supervisor writes to it.\\n\\n' ${q(label(t))} ${q(String(idle))}`,
    "read -r _ || exit 0",
    `. ${q(script)}`,
  ];
  writeFileSync(parked, `${lines.join("\n")}\n`);
  store.appendStatus(t.home, t.id, { ev: "parked", session: w.session, idle: now - w.since });
  const r = tmux.runInWindow(t.home, t.id, t.worktree, paneCommand(parked));
  // Its pane was not respawned: the worker still runs, so it is not parked.
  if (!r.ok) store.appendStatus(t.home, t.id, { ev: "session", source: "park-failed" });
  return r.ok;
}

/** Brings a parked worker back in its window with `prompt` (null: none, it waits for words). Returns { ok, err }. */
export const unpark = (t, prompt, w = workerState(t)) => launch(t, { prompt, resume: true, mode: w?.mode ?? null, model: w?.model, effort: w?.effort });

// ---------------------------------------------------------------- the owner's words, typed

/**
 * Delivers the owner's own words (an `@t3` line, a pick in the supervisor's picker) to the task's worker,
 * typed as its next prompt, which auto mode takes as the owner's: into its pane when it runs (a busy one takes
 * them in its turn), or as the prompt that resumes a dead one. They wait on its queue while it cannot take them
 * (delivery.mjs), and the watcher types them once it can. `record` puts the words on the task first, whatever
 * happens next. Returns { ok, how, why }.
 */
export function deliverWords(t, text, { record, mode = null }) {
  record(text);
  const w = workerState(t);
  if (!w) {
    store.enqueueWake(t.home, { task: t.id, kind: "undelivered" });
    ensureWatcher(t.home);
    return { ok: false, why: "it has no worker yet; rollcall starts one, with your words in its brief" };
  }
  if (w.alive) {
    if (!enqueue(t, "words", text)) return { ok: false, why: "the task store stayed busy: your words are on its record, so say them again" };
    const r = flush(t, w);
    // The watcher hears of the queue at once, and may have typed them first.
    if (r.typed || waiting(t.home, t.id).every((x) => x.typedAt)) return { ok: true, how: "typed" };
    return { ok: true, how: "held", why: r.err ? `typing into its pane failed (${r.err}), so rollcall tries again` : whyHeld(t, w) };
  }
  const r = launch(t, { prompt: text, resume: true, mode: mode ?? w.mode, model: w.model, effort: w.effort });
  return r.ok ? { ok: true, how: "resumed" } : { ok: false, why: `its worker could not be resumed: ${r.err}` };
}

/** Why words wait on a running worker's queue, as the owner reads it. */
function whyHeld(t, w) {
  if (w.dialog) return `a prompt is open in its worker: your words go in once it closes (/attach ${t.id} to answer it)`;
  if (!w.started) return "its worker is still starting: your words go in once it runs";
  return Date.now() - tmux.lastUsed(t.home, t.id) < keyQuietMs() ? "you are using its window: your words go in once it is quiet" : "your words go in shortly";
}

// ---------------------------------------------------------------- the supervisor's messages: inbox and doorbell

export const DOORBELL = `${P} The supervisor left you a message: run \`rollcall inbox\` to read it.`;

/**
 * The supervisor's own words for a worker: a file in its inbox, then one fixed line typed into its pane
 * (the doorbell) saying so. The message reaches the worker as a command's output, never as typed input, so
 * auto mode never takes the supervisor's words for the owner's. A worker with a dialog open, or none
 * running, hears the doorbell later: the watcher rings it. Returns whether it rang now.
 */
export function tell(t, text) {
  store.writeInbox(t.home, t.id, text);
  // On its log too: a finished task's worker owes a reply to what it hears (replyOwed).
  store.appendStatus(t.home, t.id, { ev: "told" });
  return ring(t);
}

/**
 * A finished task whose worker heard from the supervisor after it finished (the owner's words, a message, its
 * worker brought back), before its latest turn began: when it last heard, while no `reply:` note or report has
 * come since, else null. Its answer is the owner's, and a finished task reports nothing else that would carry it.
 */
export function replyOwed(t, log = store.readStatus(t.home, t.id)) {
  if (isOpen(t)) return null;
  const turn = log.findLast((e) => e.ev === "busy")?.at ?? 0;
  const heard = [...t.words.filter((w) => w.via === "supervisor"), ...log.filter((e) => e.ev === "told" || e.ev === "launch")]
    .map((x) => x.at).filter((at) => at > (t.stateAt ?? 0) && at <= turn);
  if (!heard.length) return null;
  const at = Math.max(...heard);
  const answered = t.notes.some((n) => n.at > at && n.by !== "supervisor" && /^reply:/i.test(n.text)) || (t.output?.at ?? 0) > at;
  return answered ? null : at;
}

export function ring(t) {
  const w = workerState(t);
  // A parked worker comes back to hear it.
  if (w?.parked && isOpen(t) && unpark(t, DOORBELL, w).ok) return true;
  enqueue(t, "doorbell", DOORBELL);
  return flush(t, w).typed > 0;
}

/**
 * One look at the task's delivery queue, from the watcher: a parked worker with something waiting comes back with
 * it, and otherwise what is due goes out. Returns flush's result.
 */
export function pump(t, now = Date.now()) {
  const w = workerState(t, now);
  const items = waiting(t.home, t.id);
  if (w?.parked && isOpen(t) && items.length) {
    const r = unpark(t, items.map((x) => x.text).join("\n\n"), w);
    if (r.ok) drop(t, items);
    return { typed: r.ok ? items.length : 0, err: r.ok ? null : r.err, lost: [] };
  }
  return flush(t, w, now);
}

// ---------------------------------------------------------------- the worker's hooks

const TAB_EVENTS = new Set(["session-start", "prompt-submit", "stop", "stop-failure", "session-end"]);

/** Errors that end a turn and hold for every session of the account until something changes: `rate_limit` is the usage limit. */
export const ACCOUNT_ERRORS = new Set(["rate_limit", "billing_error", "authentication_failed"]);

/** Task `h`:`id` waits on `wait` now, or no more (null): `task wait-for`, a usage limit, a full disk. */
export function setWait(h, id, wait) {
  store.withTasksLock(h, () => {
    const t = store.readTask(h, id);
    if (t) { t.wait = wait; store.writeTask(t); }
  });
}

/**
 * A published Artifact's live-updates subscription, which Claude Code lists among a session's background tasks
 * for as long as the session runs: it is no work the worker waits on (one kept its worker from ever parking).
 */
const watchesArtifact = (x) => /artifact/i.test(String(x?.type ?? "")) || /^live updates for artifact\b/i.test(String(x?.description ?? ""));
/** A background `rollcall queue wait` is no work either: what it reports reaches a parked worker through its task (one never parked). */
const waitsOnQueue = (x) => /\brollcall(\.mjs["']?)?\s+(?:-C\s+\S+\s+)?queue\s+wait\b/.test(String(x?.command ?? ""));

/** Rewrites the dialog flag `flag`, which keeps its time: when the first of its dialogs opened (settleDialog needs it). */
function keepFlag(flag, open) {
  let at;
  try { at = statSync(flag); } catch { return; } // taken down meanwhile: its dialog is gone, so is the flag
  writeFileSync(flag, JSON.stringify(open));
  utimesSync(flag, at.atime, at.mtime);
}

/**
 * A tool call just ended: whether the dialog flag `flag` comes down. It stays while another dialog waits: the one it
 * names, or one that opened behind it (`more`), since Enter typed into that one would approve it. A flag or an
 * entry that names no call (an elicitation) ends with any call, as a flag alone always did. Run under the home's lock.
 */
function dialogEnded(flag, p) {
  let open = null;
  try { open = JSON.parse(readFileSync(flag, "utf8")); } catch { return true; }
  if (!open || !p.tool_name) return true;
  const { what } = describe({ name: p.tool_name, input: p.tool_input });
  const ended = (x) => x.tool && x.tool === p.tool_name && x.what === what;
  let more = open.more ?? [];
  if (!ended(open)) {
    const i = more.findIndex(ended);
    if (i >= 0) more = more.toSpliced(i, 1);
    if (open.tool) {
      if (i >= 0) keepFlag(flag, { ...open, more });
      return false;
    }
  }
  if (!more.length) return true;
  keepFlag(flag, { ...open, ...more[0], more: more.slice(1) });
  return false;
}

/**
 * `rollcall worker-hook <home> <task> <event>`: the hooks of the worker's launch settings. They write the
 * task's status log, which the supervisor's watcher and status line read. `recordAsk(t, questions)` puts a
 * question on the task for the owner's picker. Returns the hook's stdout, or null.
 */
export function workerHook(h, id, event, p, { recordAsk }) {
  const t = store.readTask(h, id);
  if (!t) return null;
  // The supervisor's watcher redraws the tabs when its worker's turn starts or ends or it exits (a dialog that
  // opens or closes pokes it once its flag changed).
  if (TAB_EVENTS.has(event)) store.pokeWatcher(h);
  const flag = dialogFlag(h, id);
  const clearFlag = () => rmSync(flag, { force: true });
  // Parallel calls run their hooks at once: the flag's read-and-rewrite takes the home's lock (a busy store runs it
  // anyway, for the flag must go up).
  const locked = (fn) => { const r = store.withHomeLock(h, fn); return r ? r.out : fn(); };
  switch (event) {
    case "session-start":
      clearFlag();
      ensureWatcher(h);
      store.appendStatus(h, id, { ev: "session", session: p.session_id ?? null, source: p.source ?? null });
      // /clear starts a new session id in the same process: the task follows it, so a resume finds it.
      if (p.source === "clear" && p.session_id && t.sessions.at(-1)?.id !== p.session_id) {
        store.withTasksLock(h, () => {
          const x = store.readTask(h, id);
          if (!x?.sessions.length) return;
          const now = Date.now();
          x.sessions.at(-1).endedAt = now;
          x.sessions.push({ id: p.session_id, name: x.sessions.at(-1).name, at: now, endedAt: null, tmux: true });
          store.writeTask(x);
        });
      }
      return null;
    case "prompt-submit": {
      clearFlag();
      store.appendStatus(h, id, { ev: "busy" });
      // A worker whose turn starts is waiting no more, whoever started it (Claude Code's own continue after a limit).
      if (t.wait) setWait(h, id, null);
      // A delivery of rollcall's has its receipt; any other prompt waits for the transcript to say whose it is.
      const ours = received(t, p.prompt);
      if (!ours.length) noteTyped(t, p);
      const said = [];
      const cap = capDue(h, id, p.session_id);
      if (cap?.level === "soft") { heardSoft(h, id, p.session_id); said.push(softText(t, cap.pct)); }
      else if (cap) said.push(`${capText(t, cap.pct)} Words the owner typed above are on the task's record, so the next worker gets them.`);
      const open = stillWaits(t, ours.length > 0);
      if (open) said.push(open);
      return said.length ? JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: said.join("\n\n") } }) : null;
    }
    case "cap": {
      // After each tool call while the flag is up: once at the soft mark, every time at the cap until it hands off.
      // A subagent's tool call (its shipper's) hears nothing: the worker hands off, never a ship mid-step.
      if (p.agent_id) return null;
      const cap = capDue(h, id, p.session_id);
      if (cap?.level === "soft") heardSoft(h, id, p.session_id);
      return cap ? JSON.stringify({ hookSpecificOutput: { hookEventName: p.hook_event_name || "PostToolUse", additionalContext: cap.level === "soft" ? softText(t, cap.pct) : capText(t, cap.pct) } }) : null;
    }
    case "stop": {
      clearFlag();
      ensureWatcher(h);
      // A worker at the cap does not end its turn before it hands off; once is enough (stop_hook_active: it was told).
      const cap = !p.stop_hook_active && capDue(h, id, p.session_id);
      if (cap && cap.level !== "soft") return JSON.stringify({ decision: "block", reason: capText(t, cap.pct) });
      // What it left running and its last words: the supervisor's view of a quiet worker (null where Claude Code does not say).
      const bg = Array.isArray(p.background_tasks)
        ? p.background_tasks.filter((x) => !/^(complet|fail|kill|stop|cancel|error|done)/i.test(String(x?.status ?? "")) && !watchesArtifact(x) && !waitsOnQueue(x)).slice(0, 5).map((x) => store.clip(store.oneLine(String(x?.description || x?.command || x?.type || "a background task")), 80))
        : undefined;
      const last = typeof p.last_assistant_message === "string" ? store.clip(store.oneLine(p.last_assistant_message), 240) : undefined;
      // A finished task's worker that answered in its window alone: its last words, whole, go to the supervisor,
      // once per thing it heard, unless it left work running that may still reply.
      const log = store.readStatus(h, id);
      const owed = !bg?.length ? replyOwed(t, log) : null;
      const unanswered = owed && !log.some((e) => e.ev === "idle" && e.owed === owed);
      store.appendStatus(h, id, { ev: "idle", bg, last, ...(unanswered ? { owed } : {}) });
      if (unanswered) {
        const said = typeof p.last_assistant_message === "string" ? store.clip(p.last_assistant_message.trim(), 4000) : null;
        store.enqueueWake(h, { task: id, kind: "unanswered", said });
      }
      return null;
    }
    case "stop-failure": {
      // No Stop hook runs after an API error: without this the worker reads as busy for good. bg is unknown here, and
      // empty lets it park at a limit, and raise stuck news after any other error.
      clearFlag();
      ensureWatcher(h);
      const text = typeof p.last_assistant_message === "string" ? store.clip(store.oneLine(p.last_assistant_message), 240) : undefined;
      store.appendStatus(h, id, { ev: "idle", bg: [], last: text, failed: p.error ?? "unknown" });
      if (ACCOUNT_ERRORS.has(p.error)) {
        // Codex says when its limit resets; Claude Code only in its words.
        const until = Number.isFinite(p.resets_at) ? p.resets_at : resetAt(text);
        // Each plan's limit is its own blocker: a Codex limit holds only the tasks that run on Codex.
        const kind = p.limit === "usage-codex" ? "usage-codex" : "usage";
        openBlocker(kind, { until, text });
        setWait(h, id, { on: kind, until, at: Date.now() });
      }
      return null;
    }
    case "session-end": clearFlag(); store.appendStatus(h, id, { ev: "exit", reason: p.reason ?? null }); return null;
    case "clear":
      // Another call finishing (a parallel one, a subagent's) leaves the dialog of the call that waits.
      if (!locked(() => { const gone = dialogEnded(flag, p); if (gone) clearFlag(); return gone; })) return null;
      store.pokeWatcher(h);
      return null;
    case "dialog": {
      // The flag says what the dialog asks, for the supervisor to tell the owner; its time is when it opened. The
      // transcript's path lets the watcher see a dialog closed with no hook (settleDialog). A dialog that opens while
      // the flag is up goes on its list, so the flag stays until that call ends too.
      const asks = { type: p.notification_type ?? null, message: p.message ?? null, tool: null, what: null, why: null, ...(p.tool_name ? describe({ name: p.tool_name, input: p.tool_input }) : null) };
      locked(() => {
        let open = null;
        try { open = JSON.parse(readFileSync(flag, "utf8")); } catch {}
        if (open) keepFlag(flag, { ...open, more: [...(open.more ?? []), asks] });
        else writeFileSync(flag, JSON.stringify({ ...asks, transcript: p.transcript_path ?? null }));
      });
      store.appendStatus(h, id, { ev: "dialog", why: p.notification_type ?? "permission_request" });
      store.pokeWatcher(h);
      return null;
    }
    case "ask": {
      // Only the worker's own question is the owner's. A subagent's, or one from a fork Claude Code runs on the
      // worker's conversation (the prompt-suggestion pass after each turn, whose tool calls it denies anyway),
      // carries an agent_id: taken for the worker's, it turned the task needs-you over a question no one asked.
      if (p.agent_id) return null;
      // While the owner watches this window, the question opens right here.
      if (tmux.viewed(h, id)) return null;
      const questions = p.tool_input?.questions;
      if (!Array.isArray(questions) || !questions.length) return null;
      const res = recordAsk(t, questions);
      if (!res) return null; // malformed: nothing went to the picker, so let the worker's own prompt show
      const deny = (permissionDecisionReason) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason } });
      if (res.finished) return deny(`${P} This question did not go to the owner: task ${id} is ${res.finished}, and a finished task asks nothing. Put it in a reply instead (\`rollcall task note ${id} "reply: <it>"\`): the supervisor gives it to the owner.`);
      if (res.long) return deny(`${P} This question did not go to the owner: ${res.long}. Shorten it and ask again; detail that will not fit goes in a report (\`rollcall task output ${id} --file <f>\`).`);
      return deny(
        `${P} This question went to the owner's picker in the supervisor (task ${id} is needs-you now). ` +
        "Their pick comes back typed as your next prompt. End your turn now, and ask nothing else meanwhile.",
      );
    }
    default: return null;
  }
}

/**
 * The picker questions the supervisor opens for a worker's AskUserQuestion: the task's name leads each header
 * ("luke Ship"), and the question is the worker's own, so the owner reads it without a tag in front.
 */
export function taggedQuestions(t, questions) {
  return questions.map((x) => ({
    question: x.question,
    header: `${nameOf(t.id)} ${x.header || t.title}`.slice(0, 12).trimEnd(),
    multiSelect: !!x.multiSelect,
    options: x.options.map((o) => ({ label: o.label, description: o.description ?? "" })),
  }));
}

/**
 * The task a picker question ({ question, header }) is for: its header starts with the task's name ("luke Ship",
 * taggedQuestions), or null. A question tagged in its text ("luke · chat header: ...", "T3 · ...", a colored dot
 * before it), as rollcall did until 2026-10-18, still finds its task.
 */
const HEADER_NAME = /^([a-z]+(?:-\d+)?)(?: |$)/;
const LEADING_TAG = /^(?:(?:🔵|🟢|🟣|🟠|🟡|🔴) )?([A-Za-z][\w-]*) · /u;
export function taskOfQuestion(q) {
  const h = HEADER_NAME.exec(String(q?.header ?? ""));
  const id = h ? idOf(h[1]) : null;
  if (id) return id;
  const m = LEADING_TAG.exec(String(q?.question ?? ""));
  return m ? idOf(m[1]) : null;
}
