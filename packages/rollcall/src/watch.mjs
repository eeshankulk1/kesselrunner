// A supervisor home's watcher: one long-lived process per home (`rollcall watch <home>`, started by
// ensureWatcher), at no token cost while nothing happens. It wakes at once when a hook queues news (it watches
// the home's wake folder) and otherwise looks over the home's tasks and workers every 30 s. It does the chores
// (owner notifications, working through each worker's delivery queue, noticing a merged PR, closing a finished
// task's window, parking), takes the fixed steps itself (a fresh worker after a handoff, a resume when a worker exits
// mid-task, a start when a task becomes ready or gets words with no worker), and tells the owner plain facts
// through the tab, the status line and a notification. Only news that needs a judgment reaches the supervisor's
// model: typed into its falcon window once its turn has ended, as the prompt that brings it back when it is
// parked or crashed, or with the owner's next prompt when it runs in a terminal of its own, where nothing can
// type. News stays on disk until a turn that carried it ends, so a crash loses none. A supervisor past its
// context mark hands over to a fresh session on the same home, picker or not. It also looks at the machine
// (trouble.mjs) and ends a task's wait: it runs the check a worker named while that worker parks, and brings back
// every worker waiting on a blocker once it closes.
// The status line (`rollcall statusline`) draws the home's task chips on every refresh.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync, watch as watchFolder } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asksText } from "./asked.mjs";
import { enqueue, keyQuietMs, receiptMs, settleDialog, settleTyped, typedWaiting, waiting } from "./delivery.mjs";
import { lastEntry, parkSupervisor, supervisorDue } from "./park.mjs";
import { sameProcess, spawnDetached, startOf } from "./proc.mjs";
import * as store from "./store.mjs";
import { P, cli } from "./session.mjs";
import { isOpen } from "./state.mjs";
import * as trouble from "./trouble.mjs";
import {
  HANDOFF, closesAt, closing, colorOf, ensureWatcher, holderOf, homeOf, label, markCap, nameOf, park, parkDue, pump, running, setWait, startingMs, taggedQuestions, taskEnv,
  unpark, watcherEnv, workerState,
} from "./supervisor.mjs";
import { headOf, unlanded } from "./gc.mjs";
import { allSpotlights, setupState } from "./checkout.mjs";
import { defaultBranch, locate, repoKey } from "./git.mjs";
import { allDecisions, mergeSeen, ownerTypedInWorker, queueState } from "./task.mjs";
import * as tmux from "./tmux.mjs";
import { fullest, nearPct, recordClaude, refreshCodex, usageLine, when } from "./usage.mjs";
import { HARNESSES, harnessOf } from "./harness/index.mjs";
import { comeBack, contextOf, markBack, startWindow, supervisorMark } from "./window.mjs";

const ms = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : dflt; };
// A task waits on the owner this long before the first notification, then reminds every 10 minutes.
const NOTIFY_AFTER = { prompt: 30_000, "needs-you": 60_000, stopped: 60_000 };
const REMIND_EVERY = 10 * 60_000;
// A worker gone from its pane counts as gone once it stays gone this long: one tmux read under load can miss a live one.
const goneMs = () => ms("ROLLCALL_GONE_MS", 15_000);
// How often the watcher looks over every task and worker. News a hook queues (a worker's question, a report)
// wakes it at once through the wake folder; this beat is for what no file announces (a worker that died, a
// dialog left open, a merged PR, a task free to start) and for a change the OS failed to report.
const pollMs = () => ms("ROLLCALL_WATCH_POLL_MS", 30_000);
// While something waits to reach a live worker, or a prompt to be settled from its transcript, or news for the
// supervisor, the watcher looks this often.
const heldMs = () => Math.min(ms("ROLLCALL_WATCH_HELD_MS", 5_000), pollMs());
// A worker that ended its turn with nothing running and no report is news once it has sat this long.
const stuckMs = () => ms("ROLLCALL_STUCK_MS", 10 * 60_000);
// A ship (PR open or queued) with no push, check, queue event or worker turn for this long is news.
const stallMs = () => ms("ROLLCALL_STALL_MS", 60 * 60_000);
// How often a task's check runs unless its worker said (`task wait-for --every`), how long one may take, and how
// long a wait goes before the owner hears it still runs.
const checkEveryMs = () => ms("ROLLCALL_CHECK_EVERY_MS", 2 * 60_000);
const checkMs = () => ms("ROLLCALL_CHECK_MS", 60_000);
const longWaitMs = () => ms("ROLLCALL_LONG_WAIT_MS", 12 * 3600_000);

// ---------------------------------------------------------------- what each task is waiting on

/**
 * The task as the chips and the watcher see it: { t, w, wait: { kind, since } | null, label } where a
 * wait is the owner's to clear: a prompt open in its worker ("prompt"), a question ("needs-you"), or its
 * worker gone while the task is being worked ("stopped").
 */
export function view(t, now = Date.now()) {
  if (!isOpen(t)) return finishedView(t, now);
  const w = workerState(t, now);
  const launchedAt = w?.launchedAt ?? null;
  let wait = null;
  if (w?.alive && w.dialog) wait = { kind: "prompt", since: w.dialog };
  else if (w?.alive && w.started === false && now - launchedAt > startingMs()) wait = { kind: "prompt", since: launchedAt + startingMs() };
  else if (t.state === "needs-you") wait = { kind: "needs-you", since: t.stateAt ?? t.updatedAt };
  // A parked worker is not a stopped one: the watcher brings it back once its task is worked again.
  else if (w && !w.alive && !w.parked && !w.stopped && !t.wait && t.state === "working" && !(launchedAt && now - launchedAt < startingMs())) wait = { kind: "stopped", since: Math.max(w.since ?? 0, launchedAt ?? 0) };
  const said = !isOpen(t) ? t.state
    : wait?.kind === "prompt" ? "waiting on a prompt"
      : wait?.kind === "needs-you" ? "needs you"
        : t.wait ? trouble.waitLabel(t.wait, now)
        : prMergedSeen(t) ? withStage(t, "merged", now)
        : t.state === "pr-open" ? withStage(t, "PR open", now)
          : t.state === "queued" ? (t.queueLine ? `queued · ${t.queueLine}` : trainLine(t, now) ?? withStage(t, "queued", now))
          : !w ? notStarted(t)
            : w.legacy ? "v2 worker"
              : w.parked ? "parked"
              : !w.alive ? "worker stopped"
                : withStage(t, w.busy ? "working" : "idle", now);
  return { t, w, wait, said, launchedAt };
}

/** The usual time of something that ran `runs`: the middle one, or null with none. */
const usual = (runs) => (runs?.length ? [...runs].sort((a, b) => a - b)[Math.floor(runs.length / 2)] : null);
const usualStage = (t, name) => usual(store.readStageTimes(t.repo.key)[name]);

/** How far a stage has got, as the owner reads it: "CI 12m (usual 8m) · Mac load high". */
function howFar(name, took, typical) {
  const done = duration(took) || "under 1m";
  return [`${name} ${done}${typical ? ` (usual ${duration(typical) || "under 1m"})` : ""}`, trouble.loadNote()].filter(Boolean).join(" · ");
}

/** The ship's stage in place of a bare state: slow and stuck read differently at a glance, and nobody has to ask. */
const withStage = (t, plain, now) => (t.stage ? howFar(t.stage.name, now - t.stage.at, usualStage(t, t.stage.name)) : plain);

/** The suite running for the train this task's PR is on, against its usual time (the lander's own record), or null. */
function trainLine(t, now) {
  const q = store.readQueue(t.repo.key);
  const train = q.train;
  const pr = Number(/\/pull\/(\d+)/.exec(t.pr ?? "")?.[1]);
  if (!train?.started || !train.prs?.includes(pr)) return null;
  return `queued · ${howFar(train.suite, now - train.started, usual(q.times?.[train.suite]))}`;
}

/**
 * A finished task: its state, and while its worker still runs, what happens to its window ("landed · closes
 * in 7m", or "landed · worker busy" while it works again), so a tab's staying or going is never a surprise.
 * A worker whose session ended asks tmux nothing.
 */
function finishedView(t, now) {
  const plain = { t, w: null, wait: null, said: t.state, launchedAt: null };
  const { last } = running(store.readStatus(t.home, t.id));
  if (!last || last.ev === "exit") return plain;
  const w = workerState(t, now);
  if (!w?.alive) return plain;
  return { ...plain, w, said: `${t.state} · ${closing(t, w, now) ?? "worker busy"}` };
}

/**
 * A task no worker has run yet (a launch records its session at once, so this is never one starting): "held" on
 * the owner's word, the open tasks it waits on ("waits on grogu"), until each has a PR or has landed, else "not started".
 */
function notStarted(t) {
  const held = heldBy(t);
  return t.hold ? "held" : held.length ? `waits on ${held.map((p) => nameOf(p.id)).join(", ")}` : "not started";
}

/** The tasks `t` was made to wait on (`--after`) that hold it: not landed under `--until landed`, else no PR yet or back at work. */
const heldBy = (t) => (t.after ?? []).map((id) => store.readTask(t.home, id)).filter((p) => p && (t.until === "landed" ? isOpen(p) : p.state === "working" || p.state === "needs-you"));

/** A task made to wait on others that no worker has run, and that nothing holds any more: rollcall starts it. */
const readyToStart = (t) => isOpen(t) && !!t.after?.length && !t.sessions?.length && !t.hold && !heldBy(t).length;

// ---------------------------------------------------------------- the status line

/** A task's color as a truecolor SGR (foreground, or with `fill` the background under black). */
const sgr = (id, { fill = false, dim = false } = {}) => {
  const [r, g, b] = colorOf(id).hex.slice(1).match(/../g).map((x) => parseInt(x, 16));
  return `\x1b[${dim ? "2;" : ""}${fill ? `1;38;2;0;0;0;48;2;${r};${g};${b}` : `38;2;${r};${g};${b}`}m`;
};
const clip = (s, n) => { const x = String(s).replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x; };
/** "4m", "1h05m"; "" under a minute. */
export function duration(d) {
  const m = Math.floor(d / 60_000);
  if (m < 1) return "";
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * `rollcall statusline` (Claude Code's status line command, stdin: its JSON): in a supervisor, one chip per
 * task of its home, a task waiting on the owner drawn filled with how long it has waited, a finished one with
 * when its window closes, and the same on each task's tab in its tmux session (falcon's tab bar). Inside
 * falcon the tab bar is the task list, so the status line keeps only what the bar cannot show: who hears the
 * next line, and open tasks with no window.
 * In a worker: its own task's chip in the task's color, its context use recorded for `task list` and the
 * watcher, and the cap flag set once that use reaches the handoff cap. Elsewhere, nothing.
 */
export function statusline(p, now = Date.now()) {
  // Every Claude Code session on a Pro or Max plan reports the account's limits: the usage meter keeps the latest.
  if (p?.rate_limits) { try { recordClaude(p.rate_limits, now); } catch {} }
  const env = taskEnv();
  if (env) {
    const t = store.readTask(env.home, env.id);
    const cw = p?.context_window;
    const pct = cw?.used_percentage;
    if (Number.isFinite(pct)) {
      const last = store.readHomeFile(env.home, `context-${env.id}`);
      const session = p.session_id ?? null;
      if (!last || Math.round(pct) !== last.pct || session !== (last.session ?? null) || now - last.at > 30 * 60_000) {
        // In tokens too: the owner thinks in them ("any worker over 500k?"), and windows differ in size.
        const size = Number.isFinite(cw.context_window_size) ? cw.context_window_size : null;
        const tokens = Number.isFinite(cw.total_input_tokens) ? cw.total_input_tokens : size ? Math.round((pct / 100) * size) : null;
        store.writeHomeFile(env.home, `context-${env.id}`, { pct: Math.round(pct), at: now, session, tokens, size });
      }
      if (t) markCap(t, session, Math.round(pct));
    }
    return t ? `${sgr(t.id, { fill: true })} ${clip(label(t), 60)} \x1b[0m\x1b[2m worker for supervisor ${env.home}\x1b[0m` : "";
  }
  const h = homeOf(p?.session_id);
  if (!h) return "";
  const { to, tasks, tabs, chips } = faces(h, now);
  ensureWatcher(h);
  // Its own context use, for the watcher's hand-over and for how it comes back after parking.
  const pct = p?.context_window?.used_percentage;
  if (Number.isFinite(pct) && Math.round(pct) !== store.readHomeFile(h, "context")?.pct) store.writeHomeFile(h, "context", { pct: Math.round(pct), session: p.session_id, at: now });
  // The tab bar of falcon's tmux (and of any terminal on this home's session) says the same as the chips.
  const windows = tmux.setTabs(h, tabs);
  const hears = to ? `→ ${nameOf(to)} (@ alone: back)` : "";
  const n = allDecisions().length;
  const owed = n ? `\x1b[2m${n} decision${n === 1 ? "" : "s"} wait${n === 1 ? "s" : ""} on you\x1b[0m` : "";
  // Questions the supervisor has not opened yet: a picker on screen hides that others wait behind it.
  const waiting = [...new Set(store.listWakes(h).queued.filter((e) => e.kind === "ask" || e.kind === "needs-you").map((e) => nameOf(e.task)))];
  const behind = waiting.length ? `\x1b[2mquestions waiting: ${waiting.join(", ")}\x1b[0m` : "";
  const feed = feedLines(h, now);
  if (tmux.inside() && windows?.has(h)) {
    // Inside falcon: no second task list under the prompt.
    const tabless = chips.filter((c) => isOpen(c.t) && !windows.has(c.t.id)).map((c) => c.text);
    return [[hears && `\x1b[2m${hears}\x1b[0m`, behind, owed, ...tabless].filter(Boolean).join(" "), ...meter(now), ...blocked(now), ...feed].filter(Boolean).join("\n");
  }
  const head = `\x1b[2msupervisor ${h}${hears ? ` · ${hears}` : ""}${tasks.length ? "" : " · no open tasks"}\x1b[0m`;
  return [[head, behind, owed, ...chips.map((c) => c.text)].filter(Boolean).join(" "), ...meter(now), ...blocked(now), ...feed].join("\n");
}

/** Each plan's room (usage.mjs), dim, and yellow once one nears its limit; nothing when no reading is fresh. */
function meter(now) {
  const line = usageLine(now);
  if (!line) return [];
  return [near(now).length ? `\x1b[33m${line}\x1b[0m` : `\x1b[2m${line}\x1b[0m`];
}

/** What stops work now, in the status line of every supervisor, so a notification missed is still in plain sight. */
const blocked = (now) => trouble.lines(now).map((l) => `\x1b[33m${l}\x1b[0m`);

/**
 * How home `h`'s tasks look now, for the status line and the watcher: { to (who hears the next line), tasks
 * (open, and finished in the last hour), tabs (window name -> its tab), chips (one per task, in its color) }.
 */
function faces(h, now) {
  const to = store.readHomeFile(h, "reply-to")?.task ?? null;
  const tasks = store.listTasks(h).filter((t) => isOpen(t) || now - (t.updatedAt ?? 0) < 3600_000);
  const tabs = new Map([[h, tmux.supervisorTab(h, { parked: !!store.readHomeFile(h, "parked") })]]);
  const chips = tasks.map((t) => {
    const v = view(t, now);
    const { hex } = colorOf(t.id);
    const replying = t.id === to;
    const said = `${replying ? "replying" : v.said}${v.wait ? ` ${duration(now - v.wait.since)}`.trimEnd() : ""}`;
    const filled = isOpen(t) && (replying || !!v.wait);
    tabs.set(t.id, { tab: `${nameOf(t.id)} ${clip(t.title, 18)} · ${said}`, style: !isOpen(t) ? `fg=${hex},dim` : filled ? `bg=${hex},fg=black,bold` : `fg=${hex}` });
    const text = ` ${nameOf(t.id)} ${clip(t.title, 22)}: ${said} `;
    return { t, text: `${sgr(t.id, { fill: filled, dim: !isOpen(t) })}${text}\x1b[0m` };
  });
  return { to, tasks, tabs, chips };
}

/** Redraws home `h`'s tabs: the watcher does it when a worker's hooks poke it, so they change at once, not on a timer. */
export const drawTabs = (h, now = Date.now()) => tmux.setTabs(h, faces(h, now).tabs);

// ---------------------------------------------------------------- notifications

/** One notification per wait once it passes its threshold, and a reminder every 10 minutes while it lasts. */
function alertOwner(h, views, now) {
  const notified = store.readHomeFile(h, "notified") ?? {};
  const live = {};
  for (const { t, w, wait } of views) {
    if (!wait) continue;
    const key = `${t.id}:${wait.kind}:${wait.since}`;
    const last = notified[key];
    live[key] = last ?? null;
    if (last ? now - last < REMIND_EVERY : now - wait.since < NOTIFY_AFTER[wait.kind]) continue;
    live[key] = now;
    const long = duration(now - wait.since) || "under a minute";
    const text = wait.kind === "prompt" ? `${label(t)} has waited ${long} on ${w?.asks ? asksText(w.asks) : "a prompt"} in its worker. In the supervisor: /attach ${t.id}`
      : wait.kind === "needs-you" ? `${label(t)} has waited ${long} for you: ${clip((t.question ?? "a question").split("\n")[0], 120)}`
        : `${label(t)}: its worker stopped ${long} ago while the task was being worked; the supervisor is told.`;
    notify(`${nameOf(t.id)} needs you (${h})`, text);
  }
  store.writeHomeFile(h, "notified", Object.fromEntries(Object.entries(live).filter(([, v]) => v !== null)));
}

const { notify } = trouble;

/** What home `h` must still remind the owner of: [{ at, text }]. */
export const reminders = (h) => store.readHomeFile(h, "reminders") ?? [];

// ---------------------------------------------------------------- staying awake through a ship

/** How long one hold on the Mac's sleep lasts; the watcher renews it while a ship lasts. */
const AWAKE_MS = 5 * 60_000;
/** ROLLCALL_AWAKE=0 turns it off; ROLLCALL_PMSET and ROLLCALL_CAFFEINATE name other binaries (the tests' fakes). */
const awakeOn = () => store.envFlag("ROLLCALL_AWAKE") !== false && (process.platform === "darwin" || store.envFlag("ROLLCALL_AWAKE") === true);

/**
 * While a task ships (its PR open or in the merge queue) the Mac stays awake: on AC, `caffeinate -i` holds off
 * idle sleep a few minutes at a time, renewed while the ship lasts. On battery, where the owner may want it to
 * sleep, trouble.mjs tells them once. One ship lost three of its four hours to a Mac asleep on battery. A closed
 * lid still sleeps it.
 */
function keepAwake(h, views, now) {
  if (!awakeOn()) return;
  if (!views.some((v) => isOpen(v.t) && (v.t.state === "pr-open" || v.t.state === "queued"))) return;
  if ((store.readHomeFile(h, "awake")?.until ?? 0) - now > 60_000) return;
  store.withHomeLock(h, () => {
    if ((store.readHomeFile(h, "awake")?.until ?? 0) - now > 60_000) return;
    const p = trouble.power();
    if (p?.on === "ac") spawnDetached(process.env.ROLLCALL_CAFFEINATE || "caffeinate", ["-i", "-t", String(Math.round(AWAKE_MS / 1000))]);
    store.writeHomeFile(h, "awake", { until: now + AWAKE_MS, on: p?.on ?? null });
  });
}

// ---------------------------------------------------------------- the zero-token chores

/** A pr-open or queued task whose PR rollcall saw merged, while its worker finishes its after-merge steps. */
const prMergedSeen = (t) => (t.state === "pr-open" || t.state === "queued") && !!t.pr && t.merged?.pr === t.pr;

/**
 * What gh says of the PR of a task in pr-open or queued, every few minutes per task: { merged (into the default
 * branch: a PR merged into another branch, a stacked PR, has not landed, and gc lands its task once its commits
 * reach main), at (the last push, comment or check on it) }.
 */
function prFacts(t) {
  const r = spawnSync("gh", ["pr", "view", t.pr, "--json", "state,baseRefName,updatedAt,statusCheckRollup"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
  try {
    const { state, baseRefName, updatedAt, statusCheckRollup } = JSON.parse(r.stdout);
    const info = locate(t.repo.main);
    const main = info && defaultBranch(info);
    const times = [updatedAt, ...(statusCheckRollup ?? []).flatMap((c) => [c.startedAt, c.completedAt])].map((x) => Date.parse(x)).filter(Number.isFinite);
    return { merged: state === "MERGED" && (!main || baseRefName === main), at: times.length ? Math.max(...times) : 0 };
  } catch { return { merged: false, at: 0 }; }
}

/**
 * When task `t`'s ship last showed a sign of life: its record, its worker's last turn, the PR (`prAt`) or any
 * merge queue event in its repo (a train ahead of it counts: the queue is moving). While its worker runs a turn, now.
 */
function shipMoved(t, w, prAt, now) {
  if (w?.busy) return now;
  const info = locate(t.repo.main);
  const queue = info ? store.readAllEvents(repoKey(info).key).findLast((e) => e.type === "queue")?.ts ?? 0 : 0;
  return Math.max(t.updatedAt ?? 0, t.stateAt ?? 0, w?.since ?? 0, prAt, queue);
}

/**
 * A dialog open in task `t`'s live worker `w` is news once per dialog (`seen` keeps which), since only the
 * owner answers it, unless a terminal shows that worker: the owner sees it there, and it is news once they
 * leave it open. Returns whether it queued news.
 */
function promptDue(h, t, w, seen) {
  if (!isOpen(t) || !w?.alive || !w.dialog || seen[`prompt:${t.id}`] === w.dialog || tmux.viewed(h, t.id)) return false;
  seen[`prompt:${t.id}`] = w.dialog;
  store.enqueueWake(h, { task: t.id, kind: "prompt" });
  return true;
}

/** Between the slow looks, on a worker's poke: a dialog that just opened is news now, not at the next look. */
function promptsNow(h, now) {
  const seen = store.readHomeFile(h, "seen") ?? {};
  let changed = false;
  for (const t of store.listTasks(h).filter(isOpen)) if (promptDue(h, t, workerState(t, now), seen)) changed = true;
  if (changed) store.writeHomeFile(h, "seen", seen);
}

/** When each task's worker first looked gone, in this watcher: gone counts only once it stays gone. */
const goneSince = new Map();

/** One poll of a home: chores, and news queued. */
export function tick(h, now = Date.now()) {
  const views = store.listTasks(h).map((t) => view(t, now));
  const seen = store.readHomeFile(h, "seen") ?? {};
  const windowed = tmux.windows(h);
  let changed = false;
  for (const v of views) {
    const { t, w } = v;
    const gk = `${h}:${t.id}`;
    if (v.wait?.kind !== "stopped") goneSince.delete(gk);
    else if (!goneSince.has(gk)) goneSince.set(gk, now);
    // Not yet confirmed gone: no news and no notification this poll.
    if (v.wait?.kind === "stopped" && now - goneSince.get(gk) < goneMs()) v.wait = null;
    const { wait } = v;
    try {
      if (isOpen(t) && w?.parked && t.state === "working" && !t.wait) {
        // A parked worker comes back once its task is worked again (the merge queue sent it back, the supervisor
        // set it working): any news is on its session, and its hooks read it out with this prompt.
        const n = t.notes.findLast((x) => x.at >= (w.since ?? 0))?.text;
        unpark(t, `[rollcall] You were parked (stopped while idle, to free memory), and task ${t.id} is being worked again${n ? `: ${store.clip(store.oneLine(n), 300)}` : ""}. Carry on; \`rollcall task show ${t.id}\` has the record.`, w);
      } else if (isOpen(t) && parkDue(t, w, now)) park(t, w, now);
    } catch {} // one task's worker never costs the others their look
    if (isOpen(t)) {
      if (promptDue(h, t, w, seen)) changed = true;
      // A worker gone mid-task is news once per launch; one asleep while it waits on the owner or a merge is not.
      if (wait?.kind === "stopped" && seen[`exited:${t.id}`] !== (v.launchedAt ?? w?.session)) {
        seen[`exited:${t.id}`] = v.launchedAt ?? w?.session;
        changed = true;
        store.enqueueWake(h, { task: t.id, kind: "exited" });
      }
      // A worker that ended its turn with nothing left running while the task is still being worked reported
      // nothing and waits on no one: news once per such turn. Where Claude Code does not say what runs, no news.
      if (w?.alive && !w.busy && !wait && !t.wait && t.state === "working" && w.bg?.length === 0 && now - w.since > stuckMs() && seen[`stuck:${t.id}`] !== w.since) {
        seen[`stuck:${t.id}`] = w.since;
        changed = true;
        store.enqueueWake(h, { task: t.id, kind: "stuck" });
      }
      // A task that waited on others is news once nothing holds it, whenever that came about: a PR opened or landed
      // under this watcher or before it ran, or the task was made after its parent had shipped.
      if (readyToStart(t) && !seen[`ready:${t.id}`]) {
        seen[`ready:${t.id}`] = now;
        changed = true;
        store.enqueueWake(h, { task: t.id, kind: "ready" });
      }
      const due = now - (seen[`pr:${t.id}`] ?? 0) > ms("ROLLCALL_PR_CHECK_MS", 5 * 60_000);
      if ((t.state === "pr-open" || t.state === "queued") && t.pr && due) {
        seen[`pr:${t.id}`] = now;
        changed = true;
        // A PR seen merged is not asked about again: what is left is whether its worker still runs (mergeSeen).
        const pr = prMergedSeen(t) ? { merged: true, at: 0 } : prFacts(t);
        if (pr.merged) {
          // Its worktree may hold more than that PR did (a second PR on the way): then the task stays open.
          const more = t.branch ? unlanded(t.worktree) : null;
          if (!more) mergeSeen(t, { why: "its PR merged", head: t.branch ? headOf(t.worktree) : null }, w, now);
          else {
            queueState(h, t.id, "merged-more-to-do", { note: `merged: ${t.pr} landed, but its worktree holds ${more}, so the task stays open` });
            store.enqueueWake(h, { task: t.id, kind: "merged" });
          }
        } else {
          // Once per silence: the next sign of life starts a new one.
          const moved = shipMoved(t, w, pr.at, now);
          if (now - moved > stallMs() && !t.wait && seen[`stalled:${t.id}`] !== moved) {
            seen[`stalled:${t.id}`] = moved;
            store.enqueueWake(h, { task: t.id, kind: "stalled", since: moved });
          }
        }
      }
      if (slowDue(t, now, seen)) changed = true;
    } else if (windowed.has(t.id)) {
      // A finished task's window goes closeAfterMs() after its worker's last turn (its tab counts down), not while
      // a terminal shows it, and at once when its worker left. That frees the worktree for gc. Words and doorbells
      // for its worker, brought back, are typeWaiting's.
      const st = workerState(t, now);
      const at = closesAt(st, now);
      if (at !== null && now >= at && (!st?.alive || !tmux.viewed(h, t.id))) tmux.killWindow(h, t.id);
    }
  }
  try { if (usageOffers(h, views, seen, now)) changed = true; } catch {}
  if (changed) store.writeHomeFile(h, "seen", seen);
  alertOwner(h, views.filter((v) => isOpen(v.t)), now);
  try { keepAwake(h, views, now); } catch {}
  try { trouble.look(now); } catch {}
  try { settleWaits(h, views, now); } catch {}
  try { followSpotlights(h); } catch {}
  try { remindOwner(h, now); } catch {}
  drawTabs(h, now);
}

/**
 * A spotlit task's changes reach the main checkout each poll. One that can no longer follow (someone changed the main
 * checkout) is news for the supervisor, once per reason.
 */
function followSpotlights(h) {
  // Most polls find no spotlight: one folder read, and the code that moves a checkout never loads.
  if (!allSpotlights().some((s) => s.task?.home === h)) return;
  import("./archive.mjs").then(({ syncSpotlights }) => {
    const results = syncSpotlights(h);
    // Read again now: the poll that started this wrote its own changes meanwhile.
    const seen = store.readHomeFile(h, "seen") ?? {};
    let changed = false;
    for (const { spot, result } of results) {
      const key = `spotlight:${spot.task.id}`;
      // A sync that works again forgets the failure, so the same one later is news again.
      if (result.ok) { if (key in seen) { delete seen[key]; changed = true; } continue; }
      if (seen[key] === result.err) continue;
      seen[key] = result.err;
      changed = true;
      store.enqueueWake(h, { task: spot.task.id, kind: "spotlight", err: result.err });
    }
    if (changed) store.writeHomeFile(h, "seen", seen);
  }).catch(() => {});
}

/**
 * When one plan nears its limit and the other has room, the supervisor offers the owner to move each task that waits
 * on the full one (held by its limit, not started yet, or parked while it is worked) to the other harness: news once
 * per task and window. rollcall never moves a task by itself. Codex's limits are read now and then while a task
 * runs on Codex or Codex was read before. Returns whether it queued news.
 */
function usageOffers(h, views, seen, now) {
  // Codex is asked only while it matters: a task runs there, or Claude is near its limit and Codex may take tasks.
  if (views.some((v) => isOpen(v.t) && harnessOf(v.t) === "codex") || fullest(now).some((w) => w.harness === "claude" && w.pct >= nearPct())) void refreshCodex(now);
  let queued = false;
  for (const { window: w, other, room, tasks } of usageMoves(views, now)) {
    for (const t of tasks) {
      const key = `usage:${t.id}:${w.harness}:${w.resetsAt ?? w.name}`;
      if (seen[key]) continue;
      seen[key] = now;
      store.enqueueWake(h, { task: t.id, kind: "usage-near", harness: w.harness, other, window: w.name, pct: w.pct, resetsAt: w.resetsAt, room: room.pct });
      queued = true;
    }
  }
  return queued;
}

/**
 * The moves worth offering now: for each plan near its limit while the other has room, the open tasks that wait on
 * it (held by its limit, not started yet, or parked or stopped while worked). `views`: [{ t, w }] as view() gives
 * them. Returns [{ window (a fullest() entry), other, room (the other plan's fullest window), tasks }], none empty.
 * The watcher turns them into news; the front-end snapshot shows the first as its usage offer.
 */
export function usageMoves(views, now = Date.now()) {
  const all = fullest(now);
  const out = [];
  for (const w of all.filter((x) => x.pct >= nearPct())) {
    const other = w.harness === "claude" ? "codex" : "claude";
    const room = all.find((x) => x.harness === other);
    if (!room || room.pct >= nearPct()) continue; // no room known on the other plan: nothing to offer
    const tasks = views.filter(({ t, w: worker }) => isOpen(t) && harnessOf(t) === w.harness
      && (!t.sessions?.length || trouble.isUsage(t.wait?.on) || (t.state === "working" && (worker?.parked || worker?.stopped)))).map((v) => v.t);
    if (tasks.length) out.push({ window: w, other, room, tasks });
  }
  return out;
}

/** A ship's stage past twice its usual time is one line for the owner, once per stage. Returns whether it said so. */
function slowDue(t, now, seen) {
  if (!t.stage || t.state === "needs-you" || seen[`slow:${t.id}`] === t.stage.at) return false;
  const typical = usualStage(t, t.stage.name);
  const took = now - t.stage.at;
  if (!typical || took <= 2 * typical) return false;
  seen[`slow:${t.id}`] = t.stage.at;
  const load = trouble.loadNote();
  told(t.home, t, `${label(t)}: ${t.stage.name} has run ${duration(took)}, past twice its usual ${duration(typical) || "1m"}.${load ? ` ${load}.` : ""}`);
  return true;
}

/** Reminders that have come due reach the owner like any other line, each once. */
function remindOwner(h, now) {
  const due = reminders(h).filter((r) => r.at <= now);
  if (!due.length) return;
  store.withHomeLock(h, () => store.writeHomeFile(h, "reminders", reminders(h).filter((r) => r.at > now)));
  for (const r of due) told(h, null, `Reminder: ${r.text}`, { sound: true });
}

// ---------------------------------------------------------------- waits, run outside the model

/** Tasks whose check runs now, by id, and when each last started. */
const checks = new Map();
const checked = new Map();

/** What a worker hears when its wait ends. */
function waitOver(t, wait) {
  const on = `\`${cli()} task show ${t.id}\` has the record.`;
  if (trouble.isUsage(wait.on)) return `${P} The usage limit that stopped you is over. Carry on where you left off; ${on}`;
  if (wait.on === "disk") return `${P} The disk has room again. Carry on where you left off, and run again what failed for lack of space; ${on}`;
  if (wait.on === "power") return `${P} The Mac is on power again. Carry on where you left off; ${on}`;
  if (wait.on === "billing") return `${P} GitHub is starting jobs again. Re-run what it refused (\`gh run rerun <run> --failed\`) if that has not started, and carry on; ${on}`;
  return `${P} Your check passed: \`${store.clip(wait.check, 200)}\`. Carry on where you left off; ${on}`;
}

/**
 * Task `t`'s wait is over: its worker comes back. One still running hears it, except at a usage limit, where a
 * dialog can sit in front of its prompt: there it restarts on its conversation, which reaches it whatever is on screen.
 */
function endWait(t, now) {
  const { wait } = t;
  setWait(t.home, t.id, null);
  const w = workerState(t, now);
  if (!w || w.stopped) return;
  const text = waitOver(t, wait);
  if (!w.alive || trouble.isUsage(wait.on)) unpark(t, text, w);
  else enqueue(t, "notice", text);
}

/** Runs the check task `t` named, apart from the watcher, and ends its wait when it passes. */
function runCheck(t, now) {
  const every = (t.wait.every ?? 0) || checkEveryMs();
  if (checks.has(t.id) || now - (checked.get(t.id) ?? 0) < every) return;
  checked.set(t.id, now);
  const c = spawn("/bin/sh", ["-c", t.wait.check], { cwd: existsSync(t.worktree) ? t.worktree : homedir(), stdio: "ignore", env: watcherEnv() });
  checks.set(t.id, c);
  const timer = setTimeout(() => c.kill("SIGKILL"), checkMs());
  const end = (code) => {
    if (checks.get(t.id) !== c) return;
    clearTimeout(timer);
    checks.delete(t.id);
    // Its task may have moved on while the check ran: a worker that came back meanwhile is waiting no more.
    const x = store.readTask(t.home, t.id);
    if (code === 0 && isOpen(x) && x.wait?.at === t.wait.at) endWait(x, Date.now());
    store.pokeWatcher(t.home);
  };
  c.on("error", () => end(1));
  c.on("close", end);
}

/**
 * The tasks' waits, one look: a blocker that closed ends every wait on it, and a task's own check runs when due. A
 * worker a full disk stopped waits on it whether or not it could say so: at no room the store may have refused it.
 */
function settleWaits(h, views, now) {
  const open = trouble.openBlockers();
  const seen = store.readHomeFile(h, "seen") ?? {};
  let changed = false;
  for (const { t, w } of views) {
    if (!isOpen(t)) continue;
    if (!t.wait) {
      if (open.disk?.full && t.state === "working" && w?.alive && !w.busy && (w.since ?? 0) >= open.disk.since) setWait(h, t.id, { on: "disk", at: now });
      continue;
    }
    if (t.wait.on && !open[t.wait.on]) { endWait(t, now); continue; }
    if (t.wait.check) runCheck(t, now);
    if (now - t.wait.at > longWaitMs() && seen[`waited:${t.id}`] !== t.wait.at) {
      seen[`waited:${t.id}`] = t.wait.at;
      changed = true;
      told(h, t, `${label(t)}: ${trouble.waitLabel(t.wait, now)}, for ${duration(now - t.wait.at)} now. It goes on by itself once that clears.`);
    }
  }
  if (changed) store.writeHomeFile(h, "seen", seen);
}

// ---------------------------------------------------------------- what the owner hears with no model turn

const FEED_KEEP = 20;
const FEED_SHOW_MS = 15 * 60_000;
const FEED_LINES = 3;

/** A line for the owner with no model turn: under their prompt for a while, and as a notification. */
function told(h, t, text, { report = null, sound = false } = {}) {
  const feed = store.readHomeFile(h, "feed") ?? [];
  store.writeHomeFile(h, "feed", [...feed, { at: Date.now(), task: t?.id ?? null, text, report }].slice(-FEED_KEEP));
  notify(t ? `${nameOf(t.id)} (${h})` : h, report ? `${text} Report: ${report}` : text, { sound });
}

const fileLink = (path, text) => `\x1b]8;;file://${encodeURI(path)}\x1b\\${text}\x1b]8;;\x1b\\`;

/** The status line's last few things the owner was told, a report as a link. */
const feedLines = (h, now) => (store.readHomeFile(h, "feed") ?? [])
  .filter((e) => now - e.at < FEED_SHOW_MS).slice(-FEED_LINES)
  .map((e) => `${e.task ? sgr(e.task) : "\x1b[2m"}${clip(e.text, 110)}\x1b[0m${e.report ? ` ${fileLink(e.report, "report")}` : ""}`);

/** Task `t`'s report on disk, where the owner opens it; null with none. */
function reportFile(t) {
  if (!t.output?.text) return null;
  try { store.writeReport(t.home, t.id, t.output.text); } catch { return null; }
  return store.reportPath(t.home, t.id);
}

/** The report's first line of prose, what a line about it quotes. */
const reportGist = (t) => clip(t.output.text.split("\n").map((l) => l.replace(/^[#>*\s-]+/, "").trim()).find(Boolean) ?? "", 120);

/** News with no judgment in it: the owner hears it from rollcall. */
function tellOwner(h, e, t) {
  if (e.kind === "pr-open" && t.state === "pr-open") told(h, t, `${label(t)}: PR open ${t.pr ?? "(no link recorded)"}.`);
  else if (e.kind === "landed" || e.kind === "closed") {
    const report = reportFile(t);
    if (reportToShow(t)) markReported(h, new Map([[t.id, t.output.at]]));
    told(h, t, `${label(t)}: ${t.state}${t.pr ? ` (${t.pr})` : ""}.${report ? ` ${reportGist(t)}` : " It saved no report."}`, { report });
  } else if (e.kind === "decision") {
    // Its own decision, not one that took its number when each home's list became one.
    const d = allDecisions().find((x) => x.n === e.n && x.home === h && x.from === e.task);
    if (d) told(h, t, `${label(t)} leaves you a decision, d${d.n}: ${d.text}${d.where ? ` (you answer: ${d.where})` : ""}`);
  } else if (e.kind === "merged" && t.state === "working") {
    const n = t.notes.findLast((x) => /^merged:/.test(x.text));
    told(h, t, `${label(t)}: ${store.oneLine(n?.text.replace(/^merged:\s*/, "") ?? "its PR merged and work remains")} (back to working).`);
  } else if (e.kind === "prompt" && isOpen(t)) {
    // Still open when the news goes out: one the owner answered meanwhile is no news.
    const w = workerState(t);
    if (w?.alive && w.dialog) told(h, t, `${label(t)}: its worker waits on ${asksText(w.asks)}. Answer it in ${nameOf(t.id)}'s tab, or /attach ${nameOf(t.id)}.`, { sound: true });
  }
}

// ---------------------------------------------------------------- the steps rollcall takes itself

const START_FILE = fileURLToPath(new URL("../../../scripts/supervisor/start.mjs", import.meta.url));
// A worker that handed off gets this long to end its turn before a fresh worker replaces it.
const handoffWaitMs = () => ms("ROLLCALL_HANDOFF_WAIT_MS", 60_000);
// A worker that keeps exiting is not resumed for ever: past this, a judgment call.
const MAX_RESUMES = 3;
const RESUME_WINDOW_MS = 30 * 60_000;
/** Tasks whose start.mjs runs now, by id. */
const steps = new Map();

/** Waits for the worker that handed off: its turn may still be ending. */
function handoffStep(t, now) {
  if (t.handoff?.session !== t.sessions.at(-1)?.id) return null;
  const w = workerState(t, now);
  if (w?.alive && w.busy && now - t.handoff.at < handoffWaitMs()) return "wait";
  const pct = t.handoff.context;
  const known = pct !== null && pct !== undefined;
  const why = !known ? "its worker handed off" : pct >= HANDOFF.cap ? `context at ${pct}%, the cap` : `context at ${pct}%`;
  return { args: ["--fresh", why], line: `${label(t)}: its worker handed off${known ? ` (${why})` : ""}; a fresh worker carries on.` };
}

/** A worker gone mid-task comes back, unless it keeps going. */
function resumeStep(h, t, now) {
  if (view(t, now).wait?.kind !== "stopped") return null;
  const seen = store.readHomeFile(h, "seen") ?? {};
  const key = `resumes:${t.id}`;
  const recent = (seen[key] ?? []).filter((at) => now - at < RESUME_WINDOW_MS);
  if (recent.length >= MAX_RESUMES) { store.enqueueWake(h, { task: t.id, kind: "exit-loop", times: recent.length }); return null; }
  store.writeHomeFile(h, "seen", { ...seen, [key]: [...recent, now] });
  return { args: ["--resume", "it exited while the task was being worked"], line: `${label(t)}: its worker exited mid-task; rollcall resumed it.` };
}

/** A worker that left before its work merged comes back for what follows the merge; one already back needs nothing. */
function afterMergeStep(t, now) {
  const w = workerState(t, now);
  if (!w || w.alive || w.stopped) return null; // a worker stopped on purpose is not called back (mergeHold lands it)
  return { args: ["--resume", "its work merged: run its after-merge steps, save your report and set the task landed"], line: `${label(t)}: its work merged; its worker came back for what follows.` };
}

/** The step a queued `e` asks for now: { args, line }, "wait", or null when it no longer stands. */
function stepFor(h, e, t, now) {
  if (!isOpen(t)) return null;
  if (e.kind === "handoff") return handoffStep(t, now);
  if (e.kind === "exited") return resumeStep(h, t, now);
  if (e.kind === "after-merge") return afterMergeStep(t, now);
  if (e.kind === "ready") return readyToStart(t) ? { args: [], line: `${label(t)}: nothing holds it now; its worker started.` } : null;
  return !workerState(t, now) ? { args: [], line: `${label(t)}: your words started its worker.` } : null;
}

/** The permission mode a worker of this home runs in: its supervisor's, else its own last one's. */
function modeFor(h, t) {
  const session = store.readHomeFile(h, "lock")?.session;
  return (session ? store.readGlobal(session)?.mode : null) ?? store.readStatus(h, t.id).findLast((x) => x.ev === "launch")?.mode ?? null;
}

/** Runs `step` for queued entry `e` in the background: the queue keeps `e` until it ends, so a crash mid-step loses nothing. */
function runStep(h, t, e, step) {
  const mode = modeFor(h, t);
  const c = spawn(process.execPath, [START_FILE, t.id, "--home", h, ...(mode ? ["--mode", mode] : []), ...step.args], { stdio: ["ignore", "ignore", "pipe"], env: watcherEnv(), cwd: store.homeDir(h) });
  steps.set(t.id, c);
  let err = "";
  c.stderr.on("data", (d) => { err += d; });
  let ended = false;
  const end = (code) => {
    if (ended) return;
    ended = true;
    steps.delete(t.id);
    store.ackWakes(h, [e.name]);
    // Exit 4: it waits on Claude Code's trust prompt, which the owner answers in its window.
    if (code === 0) told(h, t, step.line);
    else if (code === 4) told(h, t, `${label(t)}: its worker waits on Claude Code's trust prompt for this repo. Answer it in ${nameOf(t.id)}'s tab.`, { sound: true });
    else store.enqueueWake(h, { task: t.id, kind: "failed", what: step.args[0] ?? "start", err: store.clip(store.oneLine(err), 400) });
    store.pokeWatcher(h);
  };
  c.on("error", (x) => { err = x.message; end(1); });
  c.on("close", end);
}

// ---------------------------------------------------------------- the news a model turn is for

const STEPS = new Set(["handoff", "exited", "after-merge", "ready", "undelivered"]);
const TOLD = new Set(["pr-open", "queued", "landed", "closed", "decision", "merged", "prompt"]);
const judgment = (e) => !STEPS.has(e.kind) && !TOLD.has(e.kind);

/** The worker's report, when the supervisor has not been handed it yet. */
const reportToShow = (t) => (t.output && t.output.at > (t.reportedAt ?? 0) ? t.output : null);

/** The reports in `shown` (task id -> that report's time) went to the supervisor: later news does not repeat them. */
export function markReported(h, shown) {
  if (!shown.size) return;
  store.withTasksLock(h, () => {
    for (const [id, at] of shown) {
      const t = store.readTask(h, id);
      // The report that went out, not a newer one saved since.
      if (t?.output && (t.reportedAt ?? 0) < at) { t.reportedAt = at; store.writeTask(t); }
    }
  });
}

/** A new report as a question carries it: where it is and what changed, never its text. */
function reportNote(t) {
  const out = reportToShow(t);
  const path = out && reportFile(t);
  if (!path) return "";
  const moved = out.added === undefined ? "" : ` (since the last one: +${out.added} -${out.removed} lines)`;
  return `\n  Its report: \`${path}\`${moved}: "${reportGist(t)}". Give the owner that path and line first, not the text; read it only if you need it.`;
}

/**
 * The text a wake hands the supervisor: one line per piece of news that needs its judgment, or null when none
 * still stands. `shown` collects the tasks whose report went in, for markReported once it is delivered.
 */
export function wakeText(h, entries, { shown = new Map() } = {}) {
  const lines = [];
  const done = new Set();
  for (const e of [...entries].reverse()) {
    const key = `${e.task}:${e.kind}`;
    if (done.has(key)) continue;
    done.add(key);
    const t = store.readTask(h, e.task);
    if (!t) continue;
    const note = reportNote(t);
    const carries = (line) => { if (note) shown.set(t.id, t.output.at); return `${line}${note}`; };
    let line = null;
    if (e.kind === "ask" && t.state === "needs-you" && t.ask) {
      line = carries(`${label(t)} asks the owner. Open AskUserQuestion now with exactly these questions: ${JSON.stringify(taggedQuestions(t, t.ask.questions))}`);
    } else if (e.kind === "needs-you" && t.state === "needs-you" && !t.ask) {
      line = carries(`${label(t)} needs you: "${t.question ?? "(no question recorded)"}". Open AskUserQuestion with that question, as written, the header "${nameOf(t.id)} <a word or two>" (12 characters at most: the name is how the pick finds its worker), and 2-4 answers you suggest, yours first with "(Recommended)" at the end of its label.`);
    } else if (e.kind === "stuck" && t.state === "working") {
      const w = workerState(t);
      if (w?.alive && !w.busy && w.bg?.length === 0) {
        line = `${label(t)}: its worker ended its turn ${duration(Date.now() - w.since) || "minutes"} ago with nothing running and reported nothing; the task is still working. Its last words: "${w.last ?? "(none recorded)"}". ` +
          `If they ask the owner something, ask the owner with AskUserQuestion as for "needs you"; else ask the worker what it waits on: \`rollcall task tell ${t.id} "<question>"\` (its answer comes back as a reply).`;
      }
    } else if (e.kind === "stalled" && (t.state === "pr-open" || t.state === "queued")) {
      line = `${label(t)}: its ship has been silent ${duration(Date.now() - e.since) || "a while"}: no push, check or queue event on ${t.pr} (${t.state}). Ask its worker what it waits on: \`rollcall task tell ${t.id} "<question>"\`. One line to the owner.`;
    } else if (e.kind === "reply") {
      // A finished task's reply too: the owner may have asked it something after it landed. Every reply since the
      // first this wake names, whole when long, since it may be the answer the owner waits on.
      const since = Math.min(...entries.filter((x) => x.task === e.task && x.kind === "reply").map((x) => x.note ?? Infinity));
      const all = t.notes.filter((n) => n.by !== "supervisor" && /^reply:/i.test(n.text));
      const texts = (Number.isFinite(since) && all.some((n) => n.at >= since) ? all.filter((n) => n.at >= since) : all.slice(-1)).map((n) => n.text.replace(/^reply:\s*/i, "").trim());
      const said = !texts.length ? ': "(no note)".'
        : texts.length === 1 && !texts[0].includes("\n") && texts[0].length <= 400 ? `: "${texts[0]}".`
          : `, as written:\n${texts.map((x) => x.replace(/^/gm, "    ")).join("\n\n")}\n `;
      line = `${label(t)}${isOpen(t) ? "" : ` (${t.state})`} replies${said} Act on it, then one line to the owner; an answer to the owner's own words goes to them whole, as written.`;
    } else if (e.kind === "unanswered" && !isOpen(t)) {
      const said = e.said ? `Its last words, as written:\n${e.said.replace(/^/gm, "    ")}\n ` : "It left no last words.";
      line = `${label(t)} (${t.state}) heard from you after it finished and ended its turn without a reply. ${said} If they answer what the owner asked, give the owner that answer whole, as written; ` +
        `else ask it: \`rollcall task tell ${t.id} "<question>"\` (its answer comes back as a reply).`;
    } else if (e.kind === "grew" && isOpen(t)) {
      const grew = t.notes.findLast((n) => /^grew:/i.test(n.text));
      line = `${label(t)}: its worker says the work grew: "${store.clip(store.oneLine(grew?.text.replace(/^grew:\s*/i, "") ?? "(no note)"), 300)}". Judge it per "Stay or fresh": split the new part into a task of its own, or let this worker carry on.`;
    } else if (e.kind === "failed" && isOpen(t)) {
      line = `${label(t)}: rollcall could not start its worker (${e.what}): ${e.err || "no reason given"}. Fix what you can, or tell the owner in one line.`;
    } else if (e.kind === "setup-failed" && isOpen(t) && setupState(t.worktree)?.state === "failed") {
      const st = setupState(t.worktree);
      line = `${label(t)}: its worktree setup failed: "${store.clip(store.oneLine(st.last ?? ""), 200)}" (log: ${st.log}). Fix what you can: \`rollcall task setup ${t.id} --rerun\` runs it again. ` +
        `Its worker reads the result before it starts work; tell it with \`rollcall task tell ${t.id} "<text>"\` if you change something. One line to the owner when it needs them.`;
    } else if (e.kind === "spotlight" && isOpen(t)) {
      line = `${label(t)}: the main checkout no longer follows it in the spotlight: ${e.err}. \`rollcall task spotlight ${t.id} --off\` ends the spotlight (it refuses while the main checkout has changes of its own). One line to the owner.`;
    } else if (e.kind === "answered-elsewhere") {
      // answer.mjs closed the Falcon's picker (Esc) once a front end answered every question in it.
      line = `${label(t)}: the owner answered its question from ${e.by ?? "a front end"} ("${store.clip(store.oneLine(t.answered?.answer ?? ""), 200)}"), and it went to its worker, so rollcall closed your picker for it. Do not ask it again.`;
    } else if (e.kind === "hooks-untrusted" && isOpen(t)) {
      line = `${label(t)} runs on Codex, where ${e.count} of the owner's hooks are not trusted yet, so they do not run on its tool calls (the owner's guards and rollcall's checkout checks among them). Tell the owner in one line: it is their one step, once, in its window (/attach ${t.id}: "Review hooks", then trust all) or in Codex's /hooks.`;
    } else if (e.kind === "usage-near" && isOpen(t) && harnessOf(t) === e.harness) {
      const [full, other] = [HARNESSES[e.harness].title, HARNESSES[e.other].title];
      line = `${label(t)} runs on ${full}, whose ${e.window} limit is at ${e.pct}%${e.resetsAt ? ` (it resets ${when(e.resetsAt)})` : ""}; ${other} has room (${e.room}% used). ` +
        `Ask the owner with AskUserQuestion whether to move it to ${other} (a fresh worker there carries on from the task's record); on yes: \`rollcall task move ${t.id} --harness ${e.other}\`. Never move it unasked.`;
    } else if (e.kind === "exit-loop" && isOpen(t)) {
      line = `${label(t)}: its worker exited ${e.times} times in ${RESUME_WINDOW_MS / 60_000} minutes, so rollcall stopped resuming it. Check \`rollcall task show ${t.id}\`, then ask the owner what to do.`;
    }
    if (line) lines.unshift(`- ${line}`);
  }
  if (!lines.length) return null;
  return [`${P} supervisor ${h}: news from your tasks. Act on each line per the /supervisor skill, then end your turn.`, ...lines].join("\n");
}

// ---------------------------------------------------------------- the supervisor's turn

// A turn that ended with no Stop hook (Esc, an API error) shows as a transcript this long quiet.
const turnQuietMs = () => ms("ROLLCALL_TURN_QUIET_MS", 60_000);
// Claude Code needs a moment after a session starts before its prompt box takes input.
const settleMs = () => ms("ROLLCALL_SETTLE_MS", 2_000);
const MAX_MISSES = 3;
// A supervisor's window stays as it is while the owner uses it this recently.
const handOverQuietMs = () => ms("ROLLCALL_HAND_OVER_QUIET_MS", 2 * 60_000);
const BACK_TRIES = 3;
const BACK_WINDOW_MS = 10 * 60_000;
// A window just brought back runs its shell before Claude Code starts: not crashed, and not to be started twice.
const BACK_START_MS = 20_000;

/** The session-start, prompt and Stop hooks of a session holding home `h` keep this: where its turn stands. */
const markTurn = (h, g, idle, now) => store.writeHomeFile(h, "turn", { session: g.id, idle, at: now });

/** `h`'s supervisor session started: idle until a prompt lands, whatever it did before a crash. */
export const turnReady = (h, g, now = Date.now()) => { markTurn(h, g, true, now); store.pokeWatcher(h); };

/**
 * A turn of `h`'s supervisor starts, from a prompt that reached its model: it takes any news queued now, so
 * the owner's line and the news go in one turn. Returns the lines to add to the prompt.
 */
export function turnStarted(h, g, now = Date.now()) {
  const news = store.listWakes(h).queued.filter(judgment);
  const taken = news.length ? takeNews(h, g.id, news, now) : null;
  markTurn(h, g, false, now);
  if (taken) markReported(h, taken.shown);
  return taken ? [taken.text] : [];
}

/** A turn of `h`'s supervisor ended: the news it carried is handled. */
export function turnEnded(h, g, now = Date.now()) {
  if (store.readHomeFile(h, "delivery")?.session === g.id) {
    store.ackWakes(h, store.listWakes(h).delivered.map((w) => w.name));
    store.writeHomeFile(h, "delivery", null);
  }
  markTurn(h, g, true, now);
  store.pokeWatcher(h);
}

/** A turn of `h`'s supervisor ended on an API error: the news it carried was not handled, so it goes back in the queue. */
export function turnFailed(h, g, now = Date.now()) {
  if (store.readHomeFile(h, "delivery")?.session === g.id) {
    store.requeueWakes(h, store.listWakes(h).delivered.map((w) => w.name));
    store.writeHomeFile(h, "delivery", null);
  }
  markTurn(h, g, true, now);
  store.pokeWatcher(h);
}

/**
 * Marks `entries` delivered to `session`, under the home's lock, so a prompt hook and the watcher never both
 * carry them: { text, shown, names }, or null when none is still queued or none still stands.
 */
function takeNews(h, session, entries, now) {
  const r = store.withHomeLock(h, () => {
    const queued = new Set(store.listWakes(h).queued.map((w) => w.name));
    const mine = entries.filter((e) => queued.has(e.name));
    if (!mine.length) return null;
    const names = mine.map((e) => e.name);
    const shown = new Map();
    const text = wakeText(h, mine, { shown });
    if (!text) { store.ackWakes(h, names); return null; }
    store.markDelivered(h, names);
    store.writeHomeFile(h, "delivery", { session, at: now });
    // Its receipt: the owner's line is told from this prompt by this text (hooks.mjs ownerLine).
    store.writeHomeFile(h, "sent", { text, at: now });
    return { text, shown, names };
  });
  return r?.out ?? null;
}

/**
 * Where home `h`'s supervisor stands: { at, holder, picker }, where `at` is "idle" (typing reaches its model),
 * "busy" (a turn runs; `picker` when that turn waits on the owner's pick), "terminal" (it runs outside falcon, so
 * no one can type into it: news goes with the owner's next prompt), "starting" (its window runs a session that
 * holds nothing yet), "parked", "crashed" (falcon ran it and it died with no goodbye) or "closed".
 */
function supervisorNow(h, now) {
  const holder = holderOf(h);
  const inWindow = !!tmux.windowOf(h, h)?.alive;
  if (holder) {
    if (!inWindow) return { at: "terminal", holder };
    const last = lastEntry(store.readGlobal(holder.id)?.transcript);
    if (last?.pending) return { at: "busy", holder, picker: last.tool === "AskUserQuestion" };
    const turn = store.readHomeFile(h, "turn");
    const ended = turn?.session === holder.id && turn.idle ? now - turn.at >= settleMs() : !!last && now - last.at >= turnQuietMs();
    return { at: ended ? "idle" : "busy", holder };
  }
  if (inWindow) return { at: "starting" };
  if (store.readHomeFile(h, "parked")) return { at: "parked" };
  if (now - (store.readHomeFile(h, "back")?.at ?? 0) < BACK_START_MS) return { at: "starting" };
  const lock = store.readHomeFile(h, "lock");
  const g = lock?.session ? store.readGlobal(lock.session) : null;
  return { at: g && !g.endedAt && store.readHomeFile(h, "falcon") ? "crashed" : "closed" };
}

/** Prompts typed that never arrived, in a row, and when the last one was found lost. */
const lost = { misses: 0, at: 0 };

/**
 * Whether typing into `h`'s window lands in nothing the owner is doing: no recent key, nothing in the box (a tool
 * call waiting, a picker or an approval, already makes it busy). It asks tmux afresh: a kept listing can be a
 * second old, and a key pressed in that second counts.
 */
function clearToType(h, now) {
  tmux.forget(h);
  return now - tmux.lastUsed(h, h) >= keyQuietMs() && !tmux.draft(h, h);
}

/** Queues again what a session that is gone never finished, and what a typed prompt that got lost carried. */
function reclaim(h, s, now) {
  const { delivered } = store.listWakes(h);
  if (!delivered.length) return;
  const names = delivered.map((w) => w.name);
  const d = store.readHomeFile(h, "delivery");
  if (d?.session && d.session === s.holder?.id) {
    const turn = store.readHomeFile(h, "turn");
    if (turn?.session === d.session && turn.at >= d.at) { lost.misses = 0; return; }
    if (now - d.at < receiptMs()) return;
    lost.misses += 1;
    lost.at = now;
    if (lost.misses === MAX_MISSES) notify(`news waits (${h})`, `Supervisor ${h} has news that typing into its window could not deliver. Your next line to it carries the news.`);
  } else if (s.at === "starting" && d && now - d.at < receiptMs()) return;
  store.requeueWakes(h, names);
  store.writeHomeFile(h, "delivery", null);
}

/** Times this watcher brought a dead supervisor back: one that keeps dying is left for the owner. */
const backs = [];

/**
 * Brings supervisor `h` back for its `queued` news, under its home's lock, so Enter in its tab (which takes the
 * same lock) and this never both do: resumed with the news as its prompt, or a fresh supervisor, which the
 * watcher hands the news once its first turn ends. On a failed start it stays parked, its news queued.
 */
function bringBack(h, queued, why, now) {
  // News nothing stands behind any more (a question the owner answered meanwhile) is no reason to start a session.
  if (!wakeText(h, queued)) { store.ackWakes(h, queued.map((w) => w.name)); return; }
  if (why === "crashed") {
    while (backs.length && now - backs[0] > BACK_WINDOW_MS) backs.shift();
    if (backs.length >= BACK_TRIES) return;
    backs.push(now);
  }
  store.withHomeLock(h, () => {
    const parked = store.readHomeFile(h, "parked");
    if (why === "parked" && !parked) return;
    const b = comeBack(h, store.readHomeFile(h, "falcon")?.cwd ?? process.cwd());
    markBack(h);
    store.writeHomeFile(h, "parked", null);
    const shown = new Map();
    const text = b.resume ? wakeText(h, queued, { shown }) : null;
    const first = why === "parked" ? "was parked while idle, and news from its tasks brought it back" : "stopped without warning, and news from its tasks brought it back";
    const started = startWindow(h, b, { prompt: text ? `${P} Supervisor ${h} ${first}.\n${text}` : null });
    if (started.ok && text) {
      store.markDelivered(h, queued.map((w) => w.name));
      store.writeHomeFile(h, "delivery", { session: b.session, at: now });
      markReported(h, shown);
    }
    if (!started.ok) store.writeHomeFile(h, "parked", { ...parked, failed: started.err });
  });
}

/** News that needs a judgment goes to the model: typed at the end of its turn, or as the prompt that brings it back. */
function deliver(h, s, news, now) {
  // Past a usage limit a model turn would end at once on the same error: the news stays queued until it is over.
  if (trouble.paused()) return;
  if (s.at === "parked" || s.at === "crashed") { bringBack(h, news, s.at, now); return; }
  if (s.at !== "idle" || !clearToType(h, now)) return;
  if (lost.misses >= MAX_MISSES && (store.readHomeFile(h, "turn")?.at ?? 0) <= lost.at) return;
  const taken = takeNews(h, s.holder.id, news, now);
  if (!taken) return;
  const r = tmux.type(h, h, taken.text);
  if (r.ok) { markReported(h, taken.shown); return; }
  store.requeueWakes(h, taken.names.map((n) => `d-${n.slice(2)}`));
  store.writeHomeFile(h, "delivery", null);
}

/** Works through the queue: fixed steps run, plain facts go to the owner, and what needs judgment goes to the model. */
function drain(h, s, now) {
  const { queued } = store.listWakes(h);
  const news = [];
  const gone = [];
  const heard = new Set();
  for (const e of queued) {
    const t = store.readTask(h, e.task);
    if (!t) gone.push(e.name);
    else if (STEPS.has(e.kind)) {
      if (steps.has(t.id)) continue;
      const step = stepFor(h, e, t, now);
      if (step === "wait") continue;
      if (step) runStep(h, t, e, step);
      else gone.push(e.name);
    } else if (TOLD.has(e.kind)) {
      const key = `${e.task}:${e.kind}:${e.n ?? ""}`;
      if (!heard.has(key)) tellOwner(h, e, t);
      heard.add(key);
      gone.push(e.name);
    } else news.push(e);
  }
  store.ackWakes(h, gone);
  if (news.length) deliver(h, s, news, now);
}

/**
 * A supervisor past its context mark hands over to a fresh session on the same home, picker or not: its task
 * records hold what the new one needs, and a question left open is asked again (reclaim). Only between
 * turns or under a picker, in falcon's window, while the owner is not using it. Returns whether it did.
 */
function handOver(h, s, now) {
  if (!s.holder || !(s.at === "idle" || s.picker)) return false;
  const pct = contextOf(h, s.holder.id);
  if (!Number.isFinite(pct) || pct < supervisorMark()) return false;
  tmux.forget(h);
  if (now - tmux.lastUsed(h, h) < handOverQuietMs() || tmux.draft(h, h)) return false;
  const cwd = store.readHomeFile(h, "falcon")?.cwd;
  const lock = store.readHomeFile(h, "lock");
  store.writeHomeFile(h, "lock", null);
  const r = startWindow(h, { session: randomUUID(), cwd: cwd && existsSync(cwd) ? cwd : homedir(), resume: false });
  if (!r.ok) { store.writeHomeFile(h, "lock", lock); return false; }
  told(h, null, `Supervisor ${h} reached ${pct}% of its context, so a fresh session took over from its task records. Your tasks carry on.`);
  return true;
}

// ---------------------------------------------------------------- the loop

/**
 * One look at each worker's delivery: a dialog closed with no hook comes down, prompts the transcript now settles go on
 * the record, and what is due is typed. Words that ran out of tries reach the owner once. Returns true while something
 * waits on a running worker, or on its transcript: the watcher looks again soon.
 */
function typeWaiting(h, now) {
  let names = [];
  try { names = readdirSync(store.homeDir(h)); } catch {}
  const ids = new Set(names.map((n) => /^(?:outbox|typed)-(.+)\.json$/.exec(n)?.[1]).filter(Boolean));
  for (const t of store.listTasks(h).filter(isOpen)) if (workerState(t, now)?.dialog) settleDialog(t, now);
  let soon = false;
  for (const id of ids) {
    const t = store.readTask(h, id);
    if (!t) continue; // a finished task's worker, brought back, hears the owner's words too
    const turnEnded = store.readStatus(h, id).findLast((e) => e.ev === "idle")?.at ?? 0;
    for (const x of settleTyped(t, turnEnded, now)) ownerTypedInWorker(t, x.session, x.text, x.at);
    const r = pump(t, now);
    for (const x of r.lost) {
      const what = x.kind === "doorbell" ? "a message from the supervisor" : "your words";
      const where = x.kind === "doorbell" ? "It stays in its inbox" : "They are on its record";
      // One that left the queue: rollcall saw no sign it arrived, though it went in again and again.
      if (x.gone) told(h, t, `${label(t)}: rollcall stopped typing ${what} into its worker: they went in several times with no sign they arrived. ${where}. Look in ${nameOf(t.id)}'s tab.`, { sound: true });
      else told(h, t, `${label(t)}: ${what} did not reach its worker after three tries. ${where}, and rollcall tries again once the worker moves. Look in ${nameOf(t.id)}'s tab.`, { sound: true });
    }
    if ((waiting(h, id).length && workerState(t, now)?.alive) || typedWaiting(h, id).length) soon = true;
  }
  return soon;
}

/**
 * The wake folder, watched: `wait(ms)` resolves after `ms`, or at once when anything there changed since the
 * last wait (a wake queued, a poke). Where the OS refuses the watch, `watching` is false and waits only time out.
 */
function wakeChanges(h) {
  let changed = false;
  let poked = false;
  let wake = null;
  let watcher = null;
  try {
    watcher = watchFolder(store.wakeFolder(h), () => { changed = true; poked = true; wake?.(); });
    watcher.on("error", () => { watcher?.close(); watcher = null; });
  } catch { watcher = null; }
  return {
    get watching() { return watcher !== null; },
    /** Whether the folder changed since the last ask. */
    poked: () => { const was = poked; poked = false; return was; },
    wait: (delay) => new Promise((resolve) => {
      if (changed) { changed = false; resolve(); return; }
      const timer = setTimeout(() => done(), Math.max(0, delay));
      const done = () => { clearTimeout(timer); wake = null; changed = false; resolve(); };
      wake = done;
    }),
    close: () => watcher?.close(),
  };
}

const SRC = fileURLToPath(new URL(".", import.meta.url));
/** When rollcall's code last changed: a long-lived process must not outlive its own code (a `kesselrunner sync`). */
function codeStamp() {
  try { return Math.max(...readdirSync(SRC).map((n) => statSync(join(SRC, n)).mtimeMs)); } catch { return 0; }
}

/** Whether home `h` holds nothing a watcher can act on, so it may end: the next need starts a new one (ensureWatcher). */
function homeDone(h, s) {
  if (s.holder || s.at === "starting" || steps.size || checks.size) return false;
  if (s.at === "parked" && store.listWakes(h).queued.length) return false;
  if (reminders(h).length) return false;
  return !store.listTasks(h).some(isOpen) && ![...tmux.windows(h).keys()].some((n) => store.readTask(h, n));
}

/**
 * `rollcall watch <h>`: home `h`'s one watcher. It stands down at once when another runs, and at each look
 * when another took over. `once`: one look, then the steps it started, then it ends. Returns its exit code.
 */
export async function watchHome(h, { once = false } = {}) {
  const claim = store.withHomeLock(h, () => {
    const w = store.readHomeFile(h, "watch");
    // A watcher from before this kind (it carries a generation) stands down once this file changes.
    if (w?.pid && w.pid !== process.pid && w.gen === undefined && sameProcess(w.pid, w.start)) return false;
    store.writeHomeFile(h, "watch", { pid: process.pid, start: startOf(process.pid), at: Date.now() });
    return true;
  });
  if (!claim?.out) return 0;
  store.pokeWatcher(h);
  const code = codeStamp();
  const changes = wakeChanges(h);
  try {
    let due = 0;
    for (;;) {
      if (store.readHomeFile(h, "watch")?.pid !== process.pid) return 0;
      const now = Date.now();
      const looked = now >= due;
      if (looked) {
        try { tick(h, now); } catch {}
        due = now + pollMs();
      }
      // A worker's hooks poke the watcher at each turn and when a dialog opens: its tab changes now, not at the
      // status line's next refresh, and a dialog is news at once.
      else if (changes.poked()) { try { promptsNow(h, now); drawTabs(h, now); } catch {} }
      let soon = false;
      try { soon = typeWaiting(h, now); } catch {}
      const s = supervisorNow(h, now);
      try {
        reclaim(h, s, now);
        drain(h, s, now);
        if (looked) {
          const quiet = supervisorDue(h, now);
          if (quiet) parkSupervisor(h, quiet, now);
          else handOver(h, s, now);
        }
      } catch {} // the next look tries again: nothing here is worth the home's watcher
      if (once && !steps.size && !checks.size) { store.writeHomeFile(h, "watch", null); return 0; }
      if (looked && !steps.size && !checks.size) {
        if (codeStamp() !== code) { store.writeHomeFile(h, "watch", null); ensureWatcher(h); return 0; }
        if (homeDone(h, s)) { store.writeHomeFile(h, "watch", null); return 0; }
      }
      // News held for the supervisor waits on a key going quiet or a turn ending with no event (Esc), so it looks often.
      const held = store.listWakes(h).queued.length ? heldMs() : Infinity;
      await changes.wait(Math.min(due - Date.now(), soon || !changes.watching ? heldMs() : Infinity, held));
    }
  } finally {
    changes.close();
  }
}
