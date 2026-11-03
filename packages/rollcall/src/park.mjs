// Parking: a session nothing needs holds a whole Claude Code process, and its MCP servers, for nothing. A
// worker parks from its home's watcher (supervisor.mjs parkDue and park) and comes back when its task needs
// it. A supervisor falcon runs parks once its conversation has been quiet for parkSupervisorAfterMs between
// turns, whatever its tasks are doing: the watcher parks it, works on and brings it back with their next news as
// its prompt. The owner brings it back with Enter in its tab or `falcon continue`. A throttled
// sweep runs parkAll at session start (hooks.mjs), and `rollcall park` runs it by hand.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isOpen } from "./state.mjs";
import * as store from "./store.mjs";
import { ensureWatcher, holderOf, label, park, parkDue, parkSupervisorAfterMs, parkingOn, workerState } from "./supervisor.mjs";
import * as tmux from "./tmux.mjs";
import { parkWindow } from "./window.mjs";

/**
 * Supervisor `h`, when it parks now: { h, session, quiet (ms since its conversation last moved) }, else null.
 * Due once its turn ended (no tool call waits: an open picker is one) at least parkSupervisorAfterMs ago, and
 * no terminal on its window has been used since. Its tasks do not hold it: news brings it back.
 */
export function supervisorDue(h, now = Date.now()) {
  if (!parkingOn()) return null;
  // Only a supervisor falcon runs in rollcall's tmux: one in a terminal tab of its own is the owner's to close.
  if (!tmux.windowOf(h, h)?.alive) return null;
  const holder = holderOf(h);
  const last = holder ? lastEntry(store.readGlobal(holder.id)?.transcript) : null;
  if (!last || last.pending) return null;
  const after = parkSupervisorAfterMs();
  // Just brought back, its transcript is old until its prompt lands, and its own SessionStart sweeps: back.json counts too.
  const quiet = now - Math.max(last.at, store.readHomeFile(h, "back")?.at ?? 0);
  if (quiet < after || now - tmux.lastUsed(h, h) < after) return null;
  return { h, session: holder.id, quiet };
}

/**
 * Where a transcript's conversation stands: { at (when it last moved: its last message), pending (its last
 * message is a tool call still waiting, such as a picker open for the owner), tool (that call's name) }, from
 * its last 64 KB, or null when unreadable. Messages only: Claude Code writes other entries to an idle session's
 * transcript too.
 */
export function lastEntry(file) {
  if (!file) return null;
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const n = Math.min(size, 65536);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let e = null;
      try { e = JSON.parse(lines[i]); } catch {}
      if (e?.type !== "user" && e?.type !== "assistant") continue;
      const at = Date.parse(e.timestamp);
      if (!Number.isFinite(at)) continue;
      const content = e.message?.content;
      const call = e.type === "assistant" && Array.isArray(content) ? content.findLast((b) => b?.type === "tool_use") : null;
      return { at, pending: !!call, tool: call?.name ?? null };
    }
  } catch {} finally { if (fd !== undefined) closeSync(fd); }
  return null;
}

/**
 * Parks supervisor `h` (a supervisorDue): its window says it is parked, which stops its Claude Code; the
 * watcher works on meanwhile. Returns whether it parked.
 */
export function parkSupervisor(h, due, now = Date.now()) {
  const open = store.listTasks(h).filter(isOpen).length;
  store.writeHomeFile(h, "parked", { at: now, session: due.session, quiet: due.quiet });
  if (open) ensureWatcher(h);
  const r = parkWindow(h, { idle: due.quiet, open });
  if (!r.ok) store.writeHomeFile(h, "parked", null);
  return r.ok;
}

/**
 * Parks what is due on this machine: each supervisor supervisorDue names, and each worker parkDue names; a
 * parked supervisor with open tasks, or a task on a wait, whose watcher is gone (a crash, a Mac restart) gets one back.
 * Returns [{ kind: "supervisor" | "worker", h, t?, idle, open? }].
 */
export function parkAll(now = Date.now(), { dryRun = false } = {}) {
  if (!parkingOn()) return [];
  const out = [];
  for (const h of store.listHomes()) {
    const open = store.listTasks(h).filter(isOpen);
    for (const t of open) {
      const w = workerState(t, now);
      if (!parkDue(t, w, now)) continue;
      if (dryRun || park(t, w, now)) out.push({ kind: "worker", h, t, idle: now - w.since });
    }
    if (open.some((t) => t.wait) && !dryRun) ensureWatcher(h);
    if (store.readHomeFile(h, "parked")) {
      if (open.length && !dryRun) ensureWatcher(h);
      continue;
    }
    const due = supervisorDue(h, now);
    if (due && (dryRun || parkSupervisor(h, due, now))) out.push({ kind: "supervisor", h, idle: due.quiet, open: open.length });
  }
  return out;
}

/** One line per parked session, for `rollcall park`. */
export function parkedLines(rows, { dryRun = false } = {}) {
  const verb = dryRun ? "would park" : "parked";
  const m = (ms) => `${Math.round(ms / 60_000)}m`;
  const tasks = (n) => (n ? `${n} open task${n === 1 ? "" : "s"}, whose news brings it back` : "no open task");
  return rows.map((r) => r.kind === "supervisor"
    ? `${verb} supervisor ${r.h} (quiet ${m(r.idle)}, ${tasks(r.open)}): Enter in its tab or falcon continue resumes it`
    : `${verb} ${label(r.t)} of ${r.h} (idle ${m(r.idle)}, ${r.t.state}): Enter in its tab brings it back, and so does the owner's or the supervisor's next word`);
}
