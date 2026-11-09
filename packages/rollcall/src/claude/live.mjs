// How the rest of rollcall reaches an agent the agent host runs (host/server.mjs): the host keeps, for each hosted
// agent, a record and a control socket in its worker folder (a task's, or for the supervisor workerDir(h, h)), and
// delivery, `task tell`, answers and away mode reach the agent through them. Everything here reads files or runs the
// one-shot sender: no process keeps a connection.
//
//   claude-launch.json   what a hosted Claude agent starts with (harness/claude.mjs, window.mjs writeHostedLaunch)
//   claude.json          the host's record for it: { pid, child, sock, home, task, session, view, busy, turnAt, prompt, at }
//   codex.json           a hosted Codex agent's, with `ctl` its control socket; record() and send() reach either
//   turns.jsonl          one line per finished turn: { at, ms, tokens, error, session }
import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "../proc.mjs";
import { BIN } from "../session.mjs";
import * as store from "../store.mjs";

/** The worker's folder: its task's, or the supervisor's own (`task` null). */
export const dirOf = (h, task) => store.workerDir(h, task ?? h);
export const launchFile = (h, task) => join(dirOf(h, task), "claude-launch.json");
export const recordFile = (h, task) => join(dirOf(h, task), "claude.json");
export const turnsFile = (h, task) => join(dirOf(h, task), "turns.jsonl");

/** Writes `v` as JSON, swapped in whole: readers never see half a file. */
export function writeJson(f, v) {
  const tmp = `${f}.${process.pid}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(v)); renameSync(tmp, f); } catch { rmSync(tmp, { force: true }); }
}
export function readJson(f) {
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}

/** A hosted Codex agent's record: its app server's socket is `sock`, its control socket `ctl`. */
export const codexRecordFile = (h, task) => join(dirOf(h, task), "codex.json");

/**
 * The hosted agent's record, or null when the host keeps none there (none started, the host is gone, or a tmux
 * worker, whose Codex record has no control socket). A Claude agent's, else a Codex agent's with `harness: "codex"`
 * and `sock` set to its control socket, which takes the same requests.
 */
export function record(h, task) {
  const r = readJson(recordFile(h, task));
  if (r && pidAlive(r.pid)) return r;
  if (!task) return null;
  const c = readJson(codexRecordFile(h, task));
  return c?.ctl && pidAlive(c.pid) ? { ...c, harness: "codex", sock: c.ctl } : null;
}

/** The owner's words with the files they attached, as one text: a last line names them. */
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
  if (!r?.sock) return { ok: false, err: "no hosted agent runs there" };
  const out = spawnSync(process.execPath, [BIN, "_claude-send", r.sock], { encoding: "utf8", input: JSON.stringify(req), timeout: 20_000 });
  try { return JSON.parse(String(out.stdout).trim().split("\n").at(-1)); } catch {
    return { ok: false, err: (out.stderr || "the worker did not answer").trim().split("\n").at(-1) };
  }
}
