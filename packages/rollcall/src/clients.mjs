// Front ends that follow rollcall now (`rollcall api stream`, api.mjs), and the notices the owner gets. A front end
// that shows the owner's notifications itself (the cockpit app) says so when it opens its stream; while one does,
// rollcall's own macOS notification stays quiet and the notice reaches the owner through that front end's stream
// alone, so nothing alerts twice. Every notice also goes on a short log, which each open stream reads once.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sameProcess, startOf } from "./proc.mjs";
import * as store from "./store.mjs";

const machine = () => join(store.home(), "_machine");
const clientsDir = () => join(machine(), "clients");
const noticesPath = () => join(machine(), "notices.jsonl");
// The notices log keeps this many, read by streams that are open now; a stream that opens later starts from a snapshot.
const NOTICES_KEEP = 200;

/** Front end `client` follows rollcall from process `pid`; `notifies`: it shows the owner's notifications. Returns its record. */
export function registerClient({ client, notifies = false, pid = process.pid, now = Date.now() }) {
  const rec = { client: String(client || "front end").slice(0, 40), pid, start: startOf(pid), notifies: !!notifies, at: now };
  mkdirSync(clientsDir(), { recursive: true });
  writeFileSync(join(clientsDir(), `${pid}.json`), JSON.stringify(rec));
  return rec;
}

export function unregisterClient(pid = process.pid) {
  rmSync(join(clientsDir(), `${pid}.json`), { force: true });
}

/** The front ends following rollcall now: [{ client, pid, notifies, at }]. A record whose process is gone is dropped. */
export function liveClients() {
  let names = [];
  try { names = readdirSync(clientsDir()).filter((n) => n.endsWith(".json")); } catch { return []; }
  const live = [];
  for (const n of names) {
    let rec = null;
    try { rec = JSON.parse(readFileSync(join(clientsDir(), n), "utf8")); } catch {}
    if (rec?.pid && sameProcess(rec.pid, rec.start)) live.push(rec);
    else rmSync(join(clientsDir(), n), { force: true });
  }
  return live;
}

/** The open front end that shows the owner's notifications, or null. */
export const notifyingClient = () => liveClients().find((c) => c.notifies) ?? null;

/**
 * A notice for the owner (trouble.notify's): it goes on the log the streams read. Returns the front end that shows
 * it, or null when rollcall shows it itself. Never throws: a notice must not stop the watcher.
 */
export function noteNotice({ title, text, sound = false }, now = Date.now()) {
  try {
    mkdirSync(machine(), { recursive: true });
    appendFileSync(noticesPath(), `${JSON.stringify({ at: now, title, text, sound: !!sound })}\n`);
    // Kept short: past twice the limit, the newest half stays.
    if (statSync(noticesPath()).size > NOTICES_KEEP * 2 * 400) {
      const lines = readFileSync(noticesPath(), "utf8").trim().split("\n");
      if (lines.length > NOTICES_KEEP * 2) writeFileSync(noticesPath(), `${lines.slice(-NOTICES_KEEP).join("\n")}\n`);
    }
    return notifyingClient();
  } catch {
    return null;
  }
}

/** The notices after `since` (ms), oldest first: [{ at, title, text, sound }]. */
export function noticesSince(since) {
  try {
    return readFileSync(noticesPath(), "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((n) => n && n.at > since);
  } catch {
    return [];
  }
}
