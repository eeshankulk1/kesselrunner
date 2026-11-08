// The front-end interface: one versioned way in for every front end (the cockpit Mac and iOS apps, scripts), over
// the same state and the same code the terminal Falcon uses. Six verbs, JSON out:
//   rollcall api version                     the interface version and what it offers
//   rollcall api snapshot [--home <h>]       everything a front end draws, as one document
//   rollcall api stream [--home <h>] [--client <name>] [--notifies]
//                                            the snapshot, then each change as one JSON line, until stopped
//   rollcall api do <action> [<json> | -]    every action the Falcon can take (api-actions.mjs)
//   rollcall api attach <home>[:<task>]      what a front end runs to show that session's real terminal
//   rollcall api conversation <ref> [--follow] a worker's (or the Falcon's) conversation as items (conversation.mjs)
// The contract is API.md beside this package's README; a breaking change bumps INTERFACE. rollcall stays daemonless:
// a stream is a process the front end starts and stops, and nothing here runs on the hooks' hot path.
import { readFileSync } from "node:fs";
import { asksText } from "./asked.mjs";
import { awayState, heldView } from "./away.mjs";
import { readComments } from "./comments.mjs";
import { runtimeOf } from "./checkout.mjs";
import { openQuestions, questionId } from "./answer.mjs";
import { liveClients } from "./clients.mjs";
import { harnessOf, sessionHarness } from "./harness/index.mjs";
import { isAlive, isLive, intentOf } from "./session.mjs";
import { isOpen } from "./state.mjs";
import * as store from "./store.mjs";
import { colorOf, holderOf, idOf, label, nameOf } from "./supervisor.mjs";
import { turnsSummary } from "./snapshot.mjs";
import { allDecisions, visibleTasks } from "./task.mjs";
import * as tmux from "./tmux.mjs";
import * as trouble from "./trouble.mjs";
import { tokensOf, usageOf, when } from "./usage.mjs";
import { usageMoves, view } from "./watch.mjs";
import { viewOf } from "./claude/live.mjs";

/** The interface's version. A front end checks it; any change that could break one (a field gone or retyped, an action's meaning) bumps it. Added fields and actions do not. */
export const INTERFACE = 1;

// Whether tmux is installed, asked once per process: a stream builds a snapshot every few seconds.
let tmuxThere = null;
const tmuxAvailable = () => (tmuxThere ??= tmux.available());

export const VERSION = (() => { try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; } catch { return null; } })();

export const USAGE = `  rollcall api version | snapshot [--home <h>] | stream [--home <h>] [--client <name>] [--notifies]
              | do <action> [<json> | -] | attach <home>[:<task>] [--client <name>] [--resume]
                                         the front-end interface (JSON): what a front end draws, its changes,
                                         every action, and its terminals (API.md)`;

// ---------------------------------------------------------------- refs

/** "falcon:t3" (or "falcon:luke") as { home, id }; a bare "falcon" is a supervisor ({ home, id: null }). Null when malformed. */
export function parseRef(ref) {
  const m = /^([a-z][a-z0-9-]*)(?::(.+))?$/.exec(String(ref ?? "").trim());
  if (!m || !store.HOME_NAME.test(m[1])) return null;
  if (m[2] === undefined) return { home: m[1], id: null };
  const id = idOf(m[2]);
  return id ? { home: m[1], id } : null;
}
export const refOf = (t) => `${t.home}:${t.id}`;

// ---------------------------------------------------------------- the snapshot

/** A worker as a front end draws it, or null when the task never had one (or its session ended). */
function workerView(w, t) {
  if (!w) return null;
  return {
    // Where it runs (claude/live.mjs): the chat (stream mode) or the terminal, a switch waiting, the prompt open in the chat.
    ...(t ? viewOf(t.home, t.id) : { view: "terminal", switching: null, prompt: null }),
    session: w.session, alive: w.alive, busy: w.busy, parked: !!w.parked, stopped: !!w.stopped, legacy: !!w.legacy,
    dialog: w.dialog ? { since: w.dialog, asks: w.asks, text: asksText(w.asks) } : null,
    context: w.context === null ? null : { pct: w.context, tokens: w.tokens, size: w.size },
    since: w.since, upAt: w.up ?? null, started: w.started ?? null,
    lastWords: w.last ?? null, background: w.bg ?? null,
    mode: w.mode ?? null, model: w.model ?? null, effort: w.effort ?? null,
  };
}

/** The open question as a front end shows it (a card), with the id its answer names; null when none is open. */
function questionView(t) {
  const id = questionId(t);
  if (!id) return null;
  return { id, at: t.ask?.at ?? t.stateAt ?? null, text: t.question, picker: !!t.ask, questions: openQuestions(t) };
}

/** The PR as the snapshot has it: what the record holds, and the checks a stream last read (api-stream.mjs refreshes them). */
function prView(t) {
  if (!t.pr) return null;
  const cached = store.readHomeFile(t.home, `api-pr-${t.id}`);
  return {
    url: t.pr, number: Number(/\/pull\/(\d+)/.exec(t.pr)?.[1]) || null, queueLine: t.queueLine ?? null, merged: t.merged ?? null,
    state: cached?.url === t.pr ? cached.state ?? null : null,
    checks: cached?.url === t.pr ? cached.checks ?? null : null,
    checkedAt: cached?.url === t.pr ? cached.at : null,
  };
}

/** One task, whole enough for a front end's panels. `v`: its view() when the caller has it already. */
export function taskView(t, now = Date.now(), v = view(t, now)) {
  const w = v.w;
  const win = tmux.windowOf(t.home, t.id);
  return {
    ref: refOf(t), id: t.id, home: t.home, name: nameOf(t.id), title: t.title, label: label(t), color: colorOf(t.id).hex,
    kind: t.kind ?? "build", state: t.state, stateAt: t.stateAt ?? null, open: isOpen(t),
    // What its tab says ("PR open", "needs you", "parked", "CI 12m (usual 8m)"), and what it waits on from the owner.
    status: v.said, needsOwner: v.wait ? { kind: v.wait.kind, since: v.wait.since } : null,
    harness: harnessOf(t), model: t.model ?? null, effort: t.effort ?? null,
    repo: t.repo, worktree: t.worktree, branch: t.branch, base: t.base ?? null,
    after: t.after ?? [], until: t.until ?? null, hold: !!t.hold, ship: !!t.ship, browser: !!t.browser,
    words: (t.words ?? []).map((x) => ({ at: x.at, text: x.text, via: x.via ?? "supervisor", client: x.client ?? null, closed: x.closed ?? null })),
    notes: (t.notes ?? []).slice(-20),
    notesCount: (t.notes ?? []).length,
    question: questionView(t),
    answered: t.answered ?? null,
    report: t.output ? { at: t.output.at, by: t.output.by, text: t.output.text } : null,
    handoff: t.handoff ? { at: t.handoff.at, context: t.handoff.context ?? null } : null,
    pr: prView(t),
    // The owner's line comments on its diff, where they were written (`rollcall task comments <task> --json` says where each sits now).
    comments: readComments(t.home, t.id).items.map((c) => ({ n: c.n, state: c.state, file: c.file, line: c.line, end: c.end, text: c.text, by: c.by, at: c.at, sentAt: c.sentAt ?? null, reply: c.reply ?? null, resolved: c.resolved ?? null })),
    turns: t.worktree ? turnsSummary(t.worktree) : null,
    // Its worker's context tokens now, the window's size, and on Codex the thread's total so far.
    tokens: tokensOf(t),
    stage: t.stage ?? null,
    wait: t.wait ? { ...t.wait, label: trouble.waitLabel(t.wait, now) } : null,
    worker: workerView(w, t),
    terminal: { window: !!win, alive: !!win?.alive },
    files: store.filesDir(t.home, t.id),
    createdAt: t.createdAt ?? null, updatedAt: t.updatedAt ?? null,
    // Plan A: where the task came from (an issue, a PR, a branch), and its worktree's runtime (ports, setup, run
    // actions with their preview links, spotlight, archive), read only: no lock, no process started.
    from: t.from ?? null,
    runtime: runtimeOf(t),
  };
}

/** A supervisor as a front end draws it: who holds it, its window, and what the owner was told lately. */
function supervisorView(h, now) {
  const holder = holderOf(h);
  const win = tmux.windowOf(h, h);
  const turn = store.readHomeFile(h, "turn");
  const ctx = store.readHomeFile(h, "context");
  return {
    name: h, running: !!holder, session: holder?.id ?? null, mode: holder?.mode ?? null,
    parked: !!store.readHomeFile(h, "parked"),
    terminal: { window: !!win, alive: !!win?.alive },
    turn: turn && holder && turn.session === holder.id ? { idle: !!turn.idle, at: turn.at } : null,
    context: ctx?.pct ?? null,
    replyTo: store.readHomeFile(h, "reply-to")?.task ? `${h}:${store.readHomeFile(h, "reply-to").task}` : null,
    feed: (store.readHomeFile(h, "feed") ?? []).slice(-20).map((e) => ({ at: e.at, task: e.task ? `${h}:${e.task}` : null, text: e.text, report: e.report ?? null })),
    reminders: (store.readHomeFile(h, "reminders") ?? []).map((r) => ({ at: r.at, text: r.text })),
    openTasks: store.listTasks(h).filter(isOpen).length,
    ...viewOf(h, null),
  };
}

/** Live agent sessions in every repo rollcall knows, supervisors and workers among them. */
function sessionsView(now) {
  const out = [];
  for (const key of store.listRepoKeys()) {
    for (const r of store.listRecords(key).filter(isAlive)) {
      out.push({
        id: r.id, repo: { key, name: r.repoName ?? key }, branch: r.branch ?? null, checkout: r.checkout ?? null, mainCheckout: !!r.main && r.checkout === r.main,
        harness: sessionHarness(r), state: !isLive(r, now) ? "stale" : r.idle ? "idle" : "working", since: r.since ?? null,
        intent: intentOf(r) ?? null, claim: r.claim ?? null,
      });
    }
  }
  return out;
}

/** Each repo's merge queue that has anything in it: waiting and parked entries, the train landing, the lander, the last outcomes. */
function queuesView() {
  const out = [];
  for (const key of store.listRepoKeys()) {
    const q = store.readQueue(key);
    const entries = Object.values(q.entries);
    if (!entries.length && !q.train) continue;
    const lander = store.readLander(key);
    const name = store.listRecords(key).find((r) => r.repoName)?.repoName ?? key;
    out.push({
      repo: { key, name },
      entries: entries.sort((a, b) => a.at - b.at).map((e) => ({ pr: e.pr, branch: e.branch, task: e.task ?? null, session: e.session ?? null, state: e.state, why: e.why ?? null, readyAt: e.at, files: e.files ?? [], stuck: e.stuck ?? null })),
      train: q.train ? { n: q.train.n, prs: q.train.prs, stage: q.train.stage ?? null, pr: q.train.pr ?? null, suite: q.train.suite ?? null, startedAt: q.train.at ?? null } : null,
      lander: lander?.pid ? { pid: lander.pid, since: lander.at ?? null } : null,
      outcomes: q.outcomes.slice(-10),
    });
  }
  return out;
}

/**
 * Everything a front end draws, as one document: supervisors and their tasks (state, words, worktree, branch, PR and
 * checks, the open question, the last report, what needs the owner), live sessions, the merge queues, what blocks
 * work, the decisions waiting on the owner and the front ends open now. `home` keeps it to one supervisor.
 */
export function snapshot({ home = null, now = Date.now() } = {}) {
  const homes = store.listHomes().filter((h) => !home || h === home);
  const views = homes.flatMap((h) => visibleTasks(h, { now })).map((t) => ({ t, v: view(t, now) }));
  return {
    interface: INTERFACE, rollcall: VERSION, at: now,
    tmux: { socket: tmux.SOCKET(), available: tmuxAvailable() },
    supervisors: homes.map((h) => supervisorView(h, now)),
    tasks: views.map(({ t, v }) => taskView(t, now, v)),
    sessions: sessionsView(now),
    queues: queuesView(),
    blockers: Object.values(trouble.openBlockers()).map((b) => ({ ...b })),
    blockerLines: trouble.lines(now),
    decisions: allDecisions().filter((d) => !home || d.home === home).map((d) => ({ ...d, from: d.from ? `${d.home}:${d.from}` : null })),
    // The usage meter: each plan's room (usage.mjs), as `rollcall usage --json` prints it.
    usage: usageOf(now),
    usageOffer: usageOffer(views, now),
    clients: liveClients().map(({ client, pid, notifies, at }) => ({ client, pid, notifies, at })),
    // Away mode (away.mjs): the machine's switch, and the permission requests it held for the owner.
    away: awayState(),
    held: heldView(now),
  };
}

const PLAN = { claude: "Claude", codex: "Codex" };

/**
 * The watcher's offer as a front end shows it: one plan near its limit while the other has room, and the open tasks
 * waiting on the full one that could move (task.move with harness: to). Null when there is nothing to offer.
 */
function usageOffer(views, now) {
  const m = usageMoves(views.map(({ t, v }) => ({ t, w: v.w })), now)[0];
  if (!m) return null;
  const { window: w, other, room, tasks } = m;
  const names = tasks.map((t) => nameOf(t.id));
  const shown = names.length > 4 ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more` : names.join(", ");
  return {
    from: w.harness, to: other, pct: w.pct, resetsAt: w.resetsAt ?? null, window: w.name, room: room.pct,
    tasks: tasks.map(refOf),
    text: `${PLAN[w.harness]} is at ${w.pct}% of its ${w.name} limit${w.resetsAt ? ` until ${when(w.resetsAt, now)}` : ""}, and ${PLAN[other]} has room (${room.pct}%). Move ${tasks.length === 1 ? "the waiting task" : `${tasks.length} waiting tasks`} (${shown}) to ${PLAN[other]}?`,
  };
}

// ---------------------------------------------------------------- terminal attach

/**
 * What a front end runs to show a session's real terminal: a tmux client on rollcall's server, in a grouped view
 * session of its own (so it can show another window than the Falcon's terminal does, and goes when it detaches).
 * `ref` is "<home>" for the supervisor or "<home>:<task>" for a worker. A parked worker's window shows its parked
 * line, where Enter resumes it; `resume` brings back a worker whose window is gone first. Returns
 * { ok, ...target } or { ok: false, code, message }.
 */
export function attachInfo(ref, { client = "frontend", resume = null } = {}) {
  const r = parseRef(ref);
  if (!r) return { ok: false, code: "bad-payload", message: `not a supervisor or task: ${ref} (falcon, or falcon:t3)` };
  if (!store.listHomes().includes(r.home)) return { ok: false, code: "not-found", message: `no supervisor named ${r.home}` };
  const t = r.id ? store.readTask(r.home, r.id) : null;
  if (r.id && !t) return { ok: false, code: "not-found", message: `no task ${r.id} in supervisor ${r.home}` };
  if (!tmux.available()) return { ok: false, code: "unavailable", message: "tmux is not installed" };
  const window = r.id ?? r.home;
  let win = tmux.windowOf(r.home, window);
  let resumed = false;
  if (!win && t && resume) {
    const s = resume(t);
    if (!s.ok) return { ok: false, code: "failed", message: s.message };
    tmux.forget(r.home);
    win = tmux.windowOf(r.home, window);
    resumed = !!win;
  }
  if (!win) {
    return {
      ok: false, code: "no-window",
      message: t ? `${label(t)} has no worker window: attach with resume to bring its worker back` : `supervisor ${r.home} has no window on rollcall's tmux (it runs outside falcon)`,
    };
  }
  const session = tmux.sessionName(r.home);
  const tag = String(client).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 20) || "frontend";
  const view = `${session}-${window}-view-${tag}`;
  const w = t ? workerViewFor(t) : null;
  return {
    ok: true, ref: t ? refOf(t) : r.home, harness: t ? harnessOf(t) : "claude",
    socket: tmux.SOCKET(), session, window, pane: win.pane, alive: !!win.alive, parked: !!w?.parked, resumed,
    view,
    argv: ["tmux", "-L", tmux.SOCKET(), "new-session", "-A", "-t", `=${session}`, "-s", view, ";", "set-option", "destroy-unattached", "on", ";", "select-window", "-t", `=${view}:=${window}`],
  };
}

const workerViewFor = (t) => workerView(view(t).w, t);
