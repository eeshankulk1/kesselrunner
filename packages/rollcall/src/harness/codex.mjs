// The Codex adapter. A Codex worker is one rollcall process in the task's tmux window (`rollcall codex-worker`,
// codex/worker.mjs) that starts the worker's own `codex app-server` on a unix socket, starts or resumes its thread,
// and runs Codex's terminal UI attached to that server (`codex --remote`), so the owner watches and types into the
// real UI. rollcall sends words through the protocol (turn/start, turn/steer), never as keys, and reads the worker's
// turns, dialogs, questions and context use from it: no screen reading and no per-worker Codex hooks. The owner's
// own Codex hooks (the projected guards) still run on its tool calls once trusted in Codex's /hooks.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import * as live from "../claude/live.mjs";
import { received } from "../delivery.mjs";
import { callSync, hostedHome } from "../host/client.mjs";
import { pidAlive } from "../proc.mjs";
import { BIN } from "../session.mjs";
import * as store from "../store.mjs";
import { wantsBrowser } from "../supervisor.mjs";
import { preamble } from "./claude.mjs";
import { effortOk } from "./index.mjs";

export const name = "codex";
export const title = "Codex";
export const questionTool = "request_user_input";
export const trustPrompt = "Codex's hooks review";

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const APP_BUNDLE = "/Applications/ChatGPT.app/Contents/Resources/codex";

/** The codex CLI: ROLLCALL_CODEX_BIN, else PATH's, else the one inside the ChatGPT app. Null when none runs. */
export function bin(env = process.env) {
  const named = env.ROLLCALL_CODEX_BIN || env.KESSELRUNNER_CODEX_BIN;
  if (named) return named;
  const onPath = spawnSync("sh", ["-c", "command -v codex"], { encoding: "utf8", env }).stdout?.trim();
  if (onPath) return onPath;
  return existsSync(APP_BUNDLE) ? APP_BUNDLE : null;
}

/** Whether Codex can run a worker: installed and signed in. { ok, err, version }. */
export function available() {
  const b = bin();
  if (!b) return { ok: false, err: "the codex CLI is not installed (npm i -g @openai/codex, or the ChatGPT app)" };
  const v = spawnSync(b, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (v.status !== 0) return { ok: false, err: `${b} does not run` };
  const login = spawnSync(b, ["login", "status"], { encoding: "utf8", timeout: 10_000 });
  if (login.status !== 0) return { ok: false, err: "Codex is not signed in: the owner runs `codex login` once" };
  return { ok: true, version: v.stdout.trim() };
}

/** Codex's own models ("gpt-5.6-terra"); a Claude model name means nothing here. */
const OWN = /^(gpt|o\d|codex)[\w.-]*$/i;
export const models = { ok: (m) => typeof m === "string" && OWN.test(m), map: (m) => (typeof m === "string" && OWN.test(m) ? m : null) };

/**
 * How a worker runs on Codex, from the supervisor's permission mode: its approval policy, who reviews an
 * approval, and its sandbox. Auto mode's counterpart is Codex's auto review (a reviewing subagent decides);
 * acceptEdits and the default ask the owner. Network is on in the workspace sandbox: a worker pushes and opens PRs.
 */
export function policyFor(mode) {
  if (mode === "bypassPermissions") return { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" };
  if (mode === "dontAsk") return { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "workspace-write" };
  if (mode === "auto") return { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" };
  return { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" };
}

/** The git common dir of `dir` (a worktree's metadata lives in its main checkout's .git), or null. */
function gitCommonDir(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/**
 * The folders a workspace-sandboxed worker writes besides its worktree: the repo's git dir (commits), rollcall's
 * own store (its `rollcall task` commands), the task's files folder (screenshots), and ROLLCALL_CODEX_ADD_DIRS.
 */
export function writableRoots(t, env = process.env) {
  const dirs = [gitCommonDir(t.worktree), store.home(), store.filesDir(t.home, t.id), join(homedir(), ".cache"), ...(env.ROLLCALL_CODEX_ADD_DIRS ?? "").split(":")];
  return [...new Set(dirs.filter((d) => d && existsSync(d)))];
}

/** The model and effort a Codex worker asks for: the task's when they are Codex's, else the owner's Codex defaults. */
export function modelFor({ model = null, effort = null } = {}, env = process.env) {
  return {
    model: models.map(model) ?? models.map(env.ROLLCALL_CODEX_MODEL) ?? null,
    effort: effortOk(effort) ? effort : effortOk(env.ROLLCALL_CODEX_EFFORT) ? env.ROLLCALL_CODEX_EFFORT : null,
  };
}

/** The worker's launch file: what codex/worker.mjs reads to start or resume it. */
export const launchFile = (h, id) => join(store.workerDir(h, id), "codex-launch.json");
/** The running worker's own record: { pid, sock, session, thread, turn (the turn running now, or null), at }. */
export const stateFile = (h, id) => join(store.workerDir(h, id), "codex.json");
/** The chat's items for rollcall session `session` (codex/items.mjs), journaled by a hosted Codex agent. */
export const journalFile = (h, id, session) => join(store.workerDir(h, id), `codex-${String(session).replace(/[^\w-]/g, "")}.jsonl`);
export function workerRecord(h, id) {
  try { return JSON.parse(readFileSync(stateFile(h, id), "utf8")); } catch { return null; }
}

/**
 * Writes the worker's launch files for a new thread (with `prompt` as its first turn: the brief), or with `resume`
 * the last session's thread again (or the one `session` names). The session id is rollcall's own; Codex's thread id
 * is learned when the worker starts it and recorded on the session. Returns { script, session }.
 */
export function writeLaunch(t, { prompt, resume = false, session: pick = null, mode = null, name = null, model = null, effort = null }) {
  const dir = store.workerDir(t.home, t.id);
  const last = t.sessions?.at(-1);
  const session = resume && last ? pick ?? last.id : randomUUID();
  const thread = resume ? t.sessions?.find((s) => s.id === session)?.thread ?? null : null;
  const promptFile = join(dir, "prompt.txt");
  const script = join(dir, "launch.sh");
  if (prompt) writeFileSync(promptFile, prompt); else rmSync(promptFile, { force: true });
  const browser = wantsBrowser(t);
  const files = store.filesDir(t.home, t.id);
  mkdirSync(files, { recursive: true });
  const on = modelFor({ model, effort });
  writeFileSync(launchFile(t.home, t.id), JSON.stringify({
    home: t.home, task: t.id, session, thread, name, cwd: t.worktree, prompt: prompt ? promptFile : null,
    model: on.model, effort: on.effort, mode, ...policyFor(mode), writableRoots: writableRoots(t), bin: bin(),
    // Codex's question tool runs outside plan mode only behind this flag (under development in 0.146).
    questions: store.envFlag("ROLLCALL_CODEX_QUESTIONS") !== false,
  }, null, 2));
  const lines = [...preamble(t, { browser, files }), `${q(process.execPath)} ${q(BIN)} codex-worker ${q(t.home)} ${q(t.id)}`];
  writeFileSync(script, `${lines.join("\n")}\n`);
  return { script, session, thread };
}

/** Runs the one-shot sender (codex/send.mjs) against the worker's socket: { ok, err }. */
function send(t, args, input) {
  const rec = workerRecord(t.home, t.id);
  if (!rec?.sock || !rec.thread) return { ok: false, err: "its Codex worker has not started its thread yet" };
  // The running turn as the worker last recorded it saves the sender reading the thread's history to find it.
  const r = spawnSync(process.execPath, [BIN, "_codex-send", rec.sock, rec.thread, ...args, rec.turn ?? "-"], { encoding: "utf8", input, timeout: 20_000 });
  return r.status === 0 ? { ok: true } : { ok: false, err: (r.stderr || r.stdout || "the app server refused").trim().split("\n").at(-1) };
}

/**
 * rollcall's words to the worker as its next prompt: a new turn when it is idle, else steered into the running one
 * (Codex reads them before its next step, as Claude Code takes a prompt typed mid-turn). Nothing is typed, so the
 * owner's half-written words in the UI stay theirs. `before` is for keystrokes; there are none here.
 */
export function type(t, text) {
  // A hosted worker (a hosted supervisor's task) takes the words through the host: files the owner attached go in,
  // images as images.
  if (hostedHome(t.home)) {
    const { body, attachments } = live.attachmentsIn(String(text));
    const r = live.record(t.home, t.id)
      ? live.send(t.home, t.id, { op: "say", text: body, attachments, from: "rollcall" })
      : (({ ok, how, error }) => ({ ok, how, err: error?.message }))(callSync("say", { ref: `${t.home}:${t.id}`, text: body, attachments, from: "rollcall" }));
    if (!r.ok) return { ok: false, err: r.err ?? "the agent host refused" };
    received(t, String(text));
    return { ok: true, how: r.how };
  }
  const r = send(t, ["say"], String(text));
  // The server took it into the thread: that is the receipt (a steer adds no prompt event of its own to wait for).
  if (r.ok) received(t, String(text));
  return r;
}

/** Stops the worker's running turn (turn/interrupt). */
export const interrupt = (t) => (hostedHome(t.home) ? callSync("interrupt", { ref: `${t.home}:${t.id}` }).interrupted === true : send(t, ["interrupt"]).ok);

/** Words go through the protocol, never into the UI's input box: the worker takes them once its thread runs. */
export function takesTyping(t) {
  const rec = workerRecord(t.home, t.id);
  // A record whose process is gone (killed outright, no handler ran) has no server behind its socket.
  return !!rec?.thread && pidAlive(rec.pid);
}

/** Codex keeps its own transcript format: rollcall reads the protocol instead. */
export const transcriptOf = () => null;

/** No folder trust to read: the worker starts its thread with an explicit sandbox; untrusted hooks raise a dialog. */
export const trusted = () => null;

export const stopLegacy = () => {};
