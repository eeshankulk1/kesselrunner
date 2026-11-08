// One history per task (and later per supervisor), across sessions: `history.jsonl` in its worker folder, an
// append-only log of events (docs/plans/2026-11-08-agent-host.md, "History"):
//
//   { seq, at, ev: "session", session, harness, how }       a session began here: new, resume or backfill
//   { seq, at, ev: "item", session, item }                  an item, new or replacing the one with its id
//   { seq, at, ev: "request", request }                     a question or permission prompt opened
//   { seq, at, ev: "closed", id, how, by, answer }          it closed: answered, cancelled, or delivered as words
//
// Only the host appends; anyone may read (a page with the host down reads the file).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as store from "../store.mjs";

const PAGE = 200;

export const historyFile = (h, id) => join(store.workerDir(h, id ?? h), "history.jsonl");

export class History {
  constructor(file) {
    this.file = file;
    this.items = []; // in order of first appearance
    this.index = new Map(); // item id -> position
    this.sessions = []; // { session, harness, how, at }
    this.open = new Map(); // request id -> request
    this.closed = new Map(); // request id -> the closing event
    this.seq = 0;
    this.load();
  }

  get exists() { return existsSync(this.file); }

  load() {
    let text = "";
    try { text = readFileSync(this.file, "utf8"); } catch { return; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { this.apply(JSON.parse(line)); } catch {}
    }
  }

  apply(e) {
    if (Number.isFinite(e.seq) && e.seq > this.seq) this.seq = e.seq;
    switch (e.ev) {
      case "session": if (!this.sessions.some((s) => s.session === e.session && s.how === e.how && s.at === e.at)) this.sessions.push({ session: e.session, harness: e.harness, how: e.how, at: e.at }); return;
      case "item": this.put(e.item); return;
      case "request": if (!this.closed.has(e.request?.id)) this.open.set(e.request.id, e.request); return;
      case "closed": this.open.delete(e.id); this.closed.set(e.id, e); return;
      default:
    }
  }

  put(item) {
    if (!item?.id) return;
    if (this.index.has(item.id)) this.items[this.index.get(item.id)] = item;
    else { this.index.set(item.id, this.items.length); this.items.push(item); }
  }

  get(id) { return this.index.has(id) ? this.items[this.index.get(id)] : null; }

  /** Appends one event (seq and at filled in) and applies it. */
  append(e) {
    const ev = { seq: this.seq + 1, at: Date.now(), ...e };
    appendFileSync(this.file, `${JSON.stringify(ev)}\n`);
    this.apply(ev);
    return ev;
  }

  hasSession(id) { return this.sessions.some((s) => s.session === id); }

  /**
   * A page, as `api conversation` prints one: the last `limit` top-level items (children right after their
   * subagent, not counted), or those before item `before`. `extra` are items not logged yet (streaming, queued).
   */
  page({ before = null, limit = PAGE, extra = [] } = {}) {
    const all = [...this.items, ...extra.filter((x) => !this.index.has(x.id))];
    const top = all.filter((x) => !x.parent);
    const kids = new Map();
    for (const x of all) if (x.parent) { if (!kids.has(x.parent)) kids.set(x.parent, []); kids.get(x.parent).push(x); }
    let end = top.length;
    if (before != null) {
      end = top.findIndex((x) => x.id === before);
      if (end < 0) return { ok: false, error: { code: "not-found", message: `no item ${before} in this conversation: read the last page again` } };
    }
    const n = Math.max(1, Math.min(Number(limit) || PAGE, 5000));
    const start = Math.max(0, end - n);
    const items = [];
    for (const x of top.slice(start, end)) {
      const c = kids.get(x.id) ?? [];
      items.push(x.kind === "subagent" ? { ...x, children: Math.max(x.children ?? 0, c.length) } : x, ...c);
    }
    return { ok: true, items, cursor: start > 0 ? top[start].id : null, more: start > 0 };
  }
}

/**
 * Writes every earlier session of task `t` the history does not name yet, folded from its Claude transcript or Codex
 * journal (conversation.mjs, the same reader `api conversation` used), as a `session` event (`how: "backfill"`) and its
 * items. `skip` is a session not to backfill (one about to start fresh). Returns how many items it wrote.
 */
export async function backfill(hist, t, { skip = null } = {}) {
  if (!t?.sessions?.length) return 0;
  const conv = await import("../conversation.mjs");
  const { journalFile } = await import("../harness/codex.mjs");
  const { sessionHarness } = await import("../harness/index.mjs");
  const dir = store.workerDir(t.home, t.id);
  const cwd = t.worktree ?? t.repo?.main ?? null;
  let n = 0;
  for (const s of t.sessions) {
    if (!s?.id || s.id === skip || hist.hasSession(s.id)) continue;
    const harness = sessionHarness(s);
    const transcript = harness === "codex" ? journalFile(t.home, t.id, s.id) : conv.transcriptFor(s.id, cwd);
    // `dir` gives a turn its time and tokens (turns.jsonl); "none.json" keeps the stream worker's record out of it.
    const target = { ok: true, ref: `${t.home}:${t.id}`, home: t.home, id: t.id, harness, dir, session: s.id, cwd, transcript, record: "none.json" };
    const pages = [];
    let before = null;
    for (let i = 0; i < 1000; i++) {
      const p = conv.readPage(target, { before, limit: 5000 });
      if (!p.ok) break;
      pages.unshift(p.items);
      if (!p.more) break;
      before = p.cursor;
    }
    hist.append({ ev: "session", session: s.id, harness, how: "backfill", started: s.at ?? null });
    const prefix = harness === "codex" ? `${s.id.slice(0, 8)}:` : "";
    for (const x of pages.flat()) {
      // What a stream worker's live file adds is not the transcript's: never logged.
      if (x.streaming || x.queued) continue;
      const item = prefix ? { ...x, id: `${prefix}${x.id}`, ...(x.parent ? { parent: `${prefix}${x.parent}` } : {}) } : x;
      hist.append({ ev: "item", session: s.id, item });
      n++;
    }
  }
  return n;
}
