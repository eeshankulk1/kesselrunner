// `rollcall api stream`: a front end follows rollcall's state as it changes, without polling every file. The
// process belongs to the front end that starts it (rollcall runs no server): it prints the snapshot, then one
// JSON line per change, until the front end stops it. A front end that slept or lost its stream starts a new one
// and begins again from that first snapshot, so a missed line costs nothing.
//
// It wakes on any change under rollcall's store (fs.watch) and on a short beat for what no file announces (a
// worker's process ending, a tmux window), builds the snapshot again and prints what differs. The hooks write
// nothing extra for it, so their hot path stays as it was. It also reads each open PR's checks now and then, the
// one thing in the snapshot no hook or watcher records.
import { watch as watchFolder } from "node:fs";
import { INTERFACE, snapshot } from "./api.mjs";
import { noticesSince, registerClient, unregisterClient } from "./clients.mjs";
import { checksOf, prLook } from "./queue.mjs";
import * as store from "./store.mjs";

const ms = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : dflt; };
// The beat for what no file announces; the snapshot is built at most this often on file changes too.
const beatMs = () => ms("ROLLCALL_API_BEAT_MS", 5000);
const settleMs = () => Math.min(250, beatMs());
// The least time between two builds (one costs a tmux call per supervisor, ~50 ms each), however busy the store is.
const gapMs = () => Math.min(1000, beatMs());
// Changes that reach a front end: supervisors' homes, the machine's records, merge queues. A repo's session files change
// on every tool call of every agent; the beat picks up what they mean (a session idle, stale or gone).
const RELEVANT = /^(_supervisors|_machine)\b|[\\/]queue[\\/]/;
const heartbeatMs = () => ms("ROLLCALL_API_HEARTBEAT_MS", 15_000);
// How often an open PR's checks are read (one gh call per PR).
const prEveryMs = () => ms("ROLLCALL_API_PR_MS", 60_000);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const byKey = (list, key) => new Map(list.map((x) => [x[key], x]));

/** The fields of task views `a` and `b` that differ. */
const changedFields = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k]));

/**
 * The change lines between two snapshots, in the order a front end applies them. Each task change also comes as
 * the event a front end acts on (a question asked or closed, a turn ended, a PR change, the owner's words, a report).
 */
export function changes(prev, next) {
  const out = [];
  const before = byKey(prev.tasks, "ref");
  const after = byKey(next.tasks, "ref");
  for (const [ref, t] of after) {
    const p = before.get(ref);
    if (!p) { out.push({ type: "task.added", task: t }); if (t.question) out.push({ type: "question.asked", ref, question: t.question }); continue; }
    const fields = changedFields(p, t);
    if (!fields.length) continue;
    out.push({ type: "task.changed", ref, fields, task: t });
    if (p.state !== t.state) out.push({ type: "task.state", ref, from: p.state, to: t.state });
    if (p.question?.id !== t.question?.id) {
      if (p.question) {
        const a = t.answered && (t.answered.qid === p.question.id || p.question.questions.every((x) => t.answered.questions?.includes(x.question))) ? t.answered : null;
        out.push({ type: "question.closed", ref, question: p.question.id, answered: a });
      }
      if (t.question) out.push({ type: "question.asked", ref, question: t.question });
    }
    if (p.worker?.busy && t.worker && !t.worker.busy && t.worker.alive) out.push({ type: "worker.turn-ended", ref, lastWords: t.worker.lastWords, background: t.worker.background });
    if (!p.worker?.dialog && t.worker?.dialog) out.push({ type: "worker.dialog", ref, dialog: t.worker.dialog });
    if (!same(p.pr, t.pr)) out.push({ type: "pr.changed", ref, pr: t.pr });
    if (t.words.length > p.words.length) out.push({ type: "words", ref, words: t.words.slice(p.words.length) });
    if (t.report && t.report.at !== p.report?.at) out.push({ type: "report", ref, report: t.report });
  }
  for (const ref of before.keys()) if (!after.has(ref)) out.push({ type: "task.removed", ref });

  const sup = byKey(prev.supervisors, "name");
  for (const s of next.supervisors) {
    const p = sup.get(s.name);
    if (!p || !same(p, s)) out.push({ type: "supervisor.changed", supervisor: s });
    // News: what rollcall told the owner with no model turn (the Falcon's status line shows it).
    const last = Math.max(0, ...(p?.feed ?? []).map((e) => e.at));
    for (const e of s.feed) if (e.at > last && p) out.push({ type: "news", home: s.name, ...e });
  }
  for (const name of sup.keys()) if (!next.supervisors.some((s) => s.name === name)) out.push({ type: "supervisor.removed", name });

  for (const k of ["tmux", "sessions", "queues", "blockers", "blockerLines", "decisions", "usage", "usageOffer", "clients", "away", "held"]) {
    if (!same(prev[k], next[k])) out.push({ type: `${k}.changed`, [k]: next[k] });
  }
  return out;
}

/** The checks of open PRs (tasks pr-open or queued), read at most every prEveryMs per task and kept beside the task for the snapshot. */
function refreshPrs(snap, last, now) {
  for (const t of snap.tasks) {
    if (!t.pr || !["pr-open", "queued"].includes(t.state)) continue;
    if (now - (last.get(t.ref) ?? 0) < prEveryMs()) continue;
    last.set(t.ref, now);
    const { pr } = prLook(t.worktree && t.repo?.main ? t.repo.main : process.cwd(), t.pr.url);
    if (!pr) continue;
    const c = checksOf(pr.statusCheckRollup);
    const checks = { state: c.failed.length ? "failing" : c.pending.length ? "pending" : c.passed.length ? "passing" : "none", passed: c.passed, pending: c.pending, failed: c.failed, merge: pr.mergeStateStatus ?? null };
    const rec = { url: t.pr.url, state: pr.state ?? null, checks, at: now };
    const was = store.readHomeFile(t.home, `api-pr-${t.id}`);
    if (!was || !same({ ...was, at: 0 }, { ...rec, at: 0 })) store.writeHomeFile(t.home, `api-pr-${t.id}`, rec);
  }
}

/**
 * Runs the stream: the snapshot first, then each change as a line, a heartbeat while nothing changes, until
 * the front end stops it (a signal, or its end of stdout closing). `client` and `notifies` register the front end
 * (clients.mjs): one that shows the owner's notifications keeps rollcall's own quiet. Resolves on the end.
 */
export function stream({ home = null, client = null, notifies = false, out = process.stdout } = {}) {
  return new Promise((resolveEnd) => {
    let seq = 0;
    let ended = false;
    const prChecked = new Map();
    let noticeAt = Date.now();
    let lastLine = Date.now();
    const write = (o) => {
      if (ended) return;
      lastLine = Date.now();
      out.write(`${JSON.stringify({ v: INTERFACE, seq: ++seq, at: lastLine, ...o })}\n`);
    };
    if (client || notifies) registerClient({ client: client ?? "frontend", notifies });
    let prev = snapshot({ home });
    write({ type: "snapshot", snapshot: prev });

    let timer = null;
    let building = false;
    const look = () => {
      timer = null;
      if (ended || building) return;
      building = true;
      try {
        const now = Date.now();
        refreshPrs(prev, prChecked, now);
        const next = snapshot({ home, now });
        for (const c of changes(prev, next)) write(c);
        for (const n of noticesSince(noticeAt)) { noticeAt = Math.max(noticeAt, n.at); write({ type: "notice", ...n }); }
        prev = next;
        builtAt = Date.now();
        if (Date.now() - lastLine >= heartbeatMs()) write({ type: "heartbeat" });
      } catch (e) {
        write({ type: "error", message: String(e?.message ?? e) });
      } finally {
        building = false;
      }
    };
    let builtAt = 0;
    const soon = (_, file) => {
      // A stream-mode worker's live text (stream.live.json) changes many times a second and is the conversation's, not the snapshot's.
      if (timer || ended || (file && (!RELEVANT.test(String(file)) || String(file).endsWith(".live.json")))) return;
      timer = setTimeout(look, Math.max(settleMs(), builtAt + gapMs() - Date.now()));
    };
    let watcher = null;
    try { watcher = watchFolder(store.home(), { recursive: true }, soon); watcher.on("error", () => {}); } catch {}
    const beat = setInterval(look, beatMs());

    const end = () => {
      if (ended) return;
      ended = true;
      clearInterval(beat);
      if (timer) clearTimeout(timer);
      try { watcher?.close(); } catch {}
      if (client || notifies) unregisterClient();
      resolveEnd();
    };
    out.on?.("error", end);
    out.on?.("close", end);
    // A front end that goes away ends the stream: a signal, or its end of stdout closing (the next line or heartbeat fails).
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(sig, end);
  });
}
