// A stream-mode Claude worker's files, and how the rest of rollcall reaches it. The worker (claude/worker.mjs) runs
// in a task's window, or with no task in the supervisor's own; its folder is the task's worker folder, or for the
// supervisor workerDir(h, h). Everything here reads files or runs the one-shot sender: no process keeps a connection.
//
//   claude-launch.json   what the worker starts with (harness/claude.mjs, window.mjs)
//   claude.json          its record: { pid, child, sock, home, task, session, view, switching, busy, turnAt, prompt, at }
//   stream.live.json     text streaming now and messages waiting for the turn: { session, at, items, queued }
//   turns.jsonl          one line per finished turn: { at, ms, tokens, error, session }
//
// A Codex worker (codex/worker.mjs) keeps codex.json and stream.live.json in the same folder, and takes the same
// socket requests: record() and send() reach either.
import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { liveClients } from "../clients.mjs";
import { pidAlive } from "../proc.mjs";
import { BIN } from "../session.mjs";
import * as store from "../store.mjs";

export const VIEWS = ["chat", "terminal"];

/** The worker's folder: its task's, or the supervisor's own (`task` null). */
export const dirOf = (h, task) => store.workerDir(h, task ?? h);
export const launchFile = (h, task) => join(dirOf(h, task), "claude-launch.json");
export const recordFile = (h, task) => join(dirOf(h, task), "claude.json");
export const liveFile = (h, task) => join(dirOf(h, task), "stream.live.json");
export const turnsFile = (h, task) => join(dirOf(h, task), "turns.jsonl");

/** Writes `v` as JSON, swapped in whole: readers never see half a file. */
export function writeJson(f, v) {
  const tmp = `${f}.${process.pid}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(v)); renameSync(tmp, f); } catch { rmSync(tmp, { force: true }); }
}
export function readJson(f) {
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}

/** A Codex worker's record (codex/worker.mjs): its own app server's socket is `sock`, its control socket `ctl`. */
export const codexRecordFile = (h, task) => join(dirOf(h, task), "codex.json");

/**
 * The running worker's record, or null when no worker with a chat view runs there (none started, its process is
 * gone, or a Codex worker from before the chat view, which has no control socket). A Claude worker's, else a Codex
 * worker's with `harness: "codex"` and `sock` set to its control socket, which takes the same requests.
 */
export function record(h, task) {
  const r = readJson(recordFile(h, task));
  if (r && pidAlive(r.pid)) return r;
  if (!task) return null;
  const c = readJson(codexRecordFile(h, task));
  return c?.ctl && pidAlive(c.pid) ? { ...c, harness: "codex", sock: c.ctl } : null;
}

/** The worker runs in the chat view: rollcall's words, interrupts and answers go through its stream. */
export const inChat = (h, task) => record(h, task)?.view === "chat";

/** The view a worker shows, for a front end: its record's, else the terminal (a plain CLI, or none running). */
export function viewOf(h, task) {
  const r = record(h, task);
  return { view: r?.view ?? "terminal", switching: r?.switching ?? null, prompt: r?.view === "chat" ? r.prompt ?? null : null };
}

/**
 * The view a new worker starts in: ROLLCALL_WORKER_VIEW (`chat` or `terminal`), else the chat while a front end
 * follows rollcall (cockpit's stream), else the terminal: an owner with no front end reads the real CLI, as before.
 */
export function defaultView(env = process.env) {
  const named = String(env.ROLLCALL_WORKER_VIEW ?? "").trim().toLowerCase();
  if (VIEWS.includes(named)) return named;
  try { return liveClients().length ? "chat" : "terminal"; } catch { return "terminal"; }
}

/** Whether workers run under the stream worker at all (ROLLCALL_STREAM=0 starts the plain CLI, as before this). */
export const streamOn = () => store.envFlag("ROLLCALL_STREAM") !== false;

/** The owner's words with the files they attached, as one text: a last line names them, for either view. */
export const withAttachments = (text, paths = []) => (paths.length ? `${text}\n\n[Attached: ${paths.join(", ")}]` : text);

/** The words and the attached files' paths back out of withAttachments' text. */
export function attachmentsIn(text) {
  const m = /\n\n\[Attached: (\/.*)\]$/s.exec(text);
  if (!m) return { body: text, attachments: [] };
  return { body: text.slice(0, m.index), attachments: m[1].split(/, (?=\/)/) };
}

/**
 * One request to the worker's socket from a synchronous caller, through the one-shot sender (claude/send.mjs).
 * Returns the worker's answer ({ ok, ... }) or { ok: false, err }.
 */
export function send(h, task, req) {
  const r = record(h, task);
  if (!r?.sock) return { ok: false, err: "no stream worker runs there" };
  const out = spawnSync(process.execPath, [BIN, "_claude-send", r.sock], { encoding: "utf8", input: JSON.stringify(req), timeout: 20_000 });
  try { return JSON.parse(String(out.stdout).trim().split("\n").at(-1)); } catch {
    return { ok: false, err: (out.stderr || "the worker did not answer").trim().split("\n").at(-1) };
  }
}
