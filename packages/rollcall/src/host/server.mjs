// `rollcall host`: the agent host (docs/plans/2026-11-08-agent-host.md). One long-lived process per store that runs
// every hosted agent as its child (claude/stream.mjs, host/codex.mjs), owns each agent's state (agent.json), keeps one
// history per task (host/history.mjs), saves questions and permission prompts as requests, and serves a socket where
// front ends call and subscribe. It runs a hosted crew's agents only (host/client.mjs hostedHome: a supervisor a front
// end made with `rollcall host new`, and its tasks); falcon's crews stay in tmux. Each agent also gets a control
// socket and record (claude/live.mjs), so delivery, `task tell`, answers and away mode reach it as they reach a worker.
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRecordFile, launchFile, readJson, recordFile, writeJson } from "../claude/live.mjs";
import { PLAN_MODES, SET_MODES, appendedPrompt, commandOf, promptOf } from "../claude/stream.mjs";
import { dialogFlag } from "../delivery.mjs";
import { pidAlive, sameProcess, startOf } from "../proc.mjs";
import * as store from "../store.mjs";
import { recordClaude } from "../usage.mjs";
import { startClaude } from "../claude/stream.mjs";
import { killServer } from "../codex/session.mjs";
import { launchFile as codexLaunchFile, policyFor } from "../harness/codex.mjs";
import { trustWorktree } from "../harness/claude.mjs";
import { loadFinder, relaysOf } from "./relays.mjs";
import { startCodexAgent, terminalTurns } from "./codex.mjs";
import { SESSION_ENV, codeStamp, hostDir, infoFile, lockFile, logFile, socketPath, withoutSessionEnv } from "./client.mjs";
import { History, addNew, backfill, catchUp, historyFile } from "./history.mjs";
import { archiveChat, archiveDue, bindChat, isChat, modesOf, openTasks, readChat, refreshCodexModels, setTitle, taskItem, touchChat, unarchiveChat, updateChat, writeTitle } from "./chat.mjs";
import { chatHook } from "./chat-hooks.mjs";
import { BIN, P } from "../session.mjs";
import { spawn } from "node:child_process";

export const INTERFACE = 1;
const VERSION = "0.1.0";
/** The rollcall code this host runs (client.mjs codeStamp), read as it loads: a caller replaces a host whose code differs. */
const CODE = codeStamp();
export const STATES = ["running", "idle", "parked", "stopped", "terminal"];
const SEND = { running: "join", idle: "start", parked: "wake", stopped: "wake", terminal: "hold" };
const msEnv = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : dflt; };
/** An idle agent parks after this long: Claude Code's own background agents stop after about an hour. */
export const parkMs = () => msEnv("ROLLCALL_HOST_PARK_MS", 3600_000);

const err = (code, message) => ({ ok: false, error: { code, message } });
const hex = (n) => randomBytes(n).toString("hex");

const HARNESSES = new Set(["claude", "codex"]);
const NAME = { claude: "Claude Code", codex: "Codex" };
/** The launch file the harness adapter wrote for an agent (claude-launch.json, codex-launch.json). */
const launchOf = (h, id, harness) => (harness === "codex" ? codexLaunchFile(h, id) : launchFile(h, id));
const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return -1; } };
/**
 * Which harness a start without one means: the newer launch file. A supervisor is always Claude Code; a chat runs on
 * the harness its record names.
 */
const newerLaunch = (h, id) => (id ? (mtime(codexLaunchFile(h, id)) > mtime(launchFile(h, id)) ? "codex" : "claude") : isChat(h) && readChat(h)?.harness === "codex" ? "codex" : "claude");

let logPath = null;
export function log(line) {
  try { appendFileSync(logPath ?? logFile(), `${new Date().toISOString()} ${line}\n`); } catch {}
}

// ---------------------------------------------------------------- subscribers

const subscribers = new Set(); // { c, refs: Set | null }
let evSeq = 0;
function broadcast(ref, ev, payload) {
  if (!subscribers.size) return;
  const line = `${JSON.stringify({ type: "event", v: INTERFACE, seq: ++evSeq, at: Date.now(), ref, ev, ...payload })}\n`;
  for (const s of subscribers) if (!s.refs || s.refs.has(ref)) { try { s.c.write(line); } catch {} }
}

// ---------------------------------------------------------------- agents

const agents = new Map(); // ref -> Agent

/** The words an answer becomes when the process that asked is gone: the owner's, delivered on a resumed session. */
export function wordsFor(req, a) {
  const what = req.summary || req.tool || "that";
  if (req.kind === "question") {
    const picks = a.answers && typeof a.answers === "object" ? Object.entries(a.answers) : [];
    if (!picks.length || a.allow === false) return `You asked me something before this session restarted, and I did not answer it${a.why ? `: ${a.why}` : "."}`;
    return `You asked me before this session restarted. My answers:\n${picks.map(([q, x]) => `- ${q} ${x}`).join("\n")}`;
  }
  if (req.kind === "plan") return a.allow === true ? `I approve your plan (you asked before this session restarted). Go ahead with it.` : `I did not approve your plan${a.why ? `: ${a.why}` : "."}`;
  return a.allow === true ? `I approve ${what} (you asked before this session restarted). Go ahead with it.` : `I declined ${what}${a.why ? `: ${a.why}` : "."}`;
}

/**
 * One agent: a task's worker (`id` its task), or a supervisor's own session (`id` null, ref the bare home, its files in
 * the home's own worker folder, beside a task's).
 */
class Agent {
  constructor(h, id) {
    this.h = h; this.id = id ?? null; this.ref = id ? `${h}:${id}` : h;
    this.wid = id ?? h; // the worker folder's name
    this.dir = store.workerDir(h, this.wid);
    this.file = join(this.dir, "agent.json");
    const rec = readJson(this.file);
    this.rec = rec ?? { ref: this.ref, home: h, task: this.id, harness: "claude", state: null, session: null, since: Date.now(), turnAt: null, parkedAt: null, model: null, mode: null };
    this.proc = null;
    this.pending = new Map(); // request id -> { rid, input, prompt }
    // Words sent, not taken yet: { uuid, text, at, from, attachments }. Those held while open in a terminal are also on
    // the record (rec.held), so a host restart keeps them; they leave it when they go to a process (_start).
    this.queued = Array.isArray(this.rec.held) ? this.rec.held.filter((q) => q?.uuid && typeof q.text === "string") : [];
    this.streaming = new Map(); // item id -> a streamed item not finished yet
    this.ending = null; // "park" | "stop" while the process is asked to end
    this.parkTimer = null;
    this.ctl = null; // the control socket's path
    this.server = null;
    this.starting = null;
    this.exitWaiters = [];
    this.terminal = null; // { at, cwd, pid, start } while open in a terminal (also on the record, rec.terminal)
    this.terminalWatch = null;
  }

  /** Whether this is a chat's own session (host/chat.mjs): a hosted home of kind chat, and no task. */
  get chat() { return !this.id && isChat(this.h); }

  /** The history, read from its file on first use. */
  get hist() { return (this._hist ??= new History(historyFile(this.h, this.id))); }

  state() {
    const s = this.rec.state ?? "stopped";
    return {
      ref: this.ref, home: this.h, task: this.id, supervisor: !this.id, harness: this.rec.harness, state: s, send: SEND[s], session: this.rec.session,
      since: this.rec.since, turnAt: this.rec.turnAt, parkedAt: this.rec.parkedAt, model: this.rec.model, mode: this.rec.mode,
      pid: this.proc?.pid ?? null, requests: [...this.hist.open.values()], queued: this.queued.map(({ uuid, text, at, from }) => ({ uuid, text, at, from })),
      terminal: this.terminal ? { at: this.terminal.at, closing: this.terminal.closing ?? null } : null,
    };
  }

  /** agent.json, the compat record, and a `state` event. */
  persist() {
    this.rec.pid = this.proc?.pid ?? null;
    this.rec.serverSock = this.proc?.harness === "codex" ? this.proc.sock : null;
    this.rec.host = process.pid;
    this.rec.at = Date.now();
    this.rec.requests = this.hist.open.size; // for readers of the record: a chat's `busy` in the snapshot
    writeJson(this.file, this.rec);
    const recFile = this.rec.harness === "codex" ? codexRecordFile(this.h, this.id) : recordFile(this.h, this.id);
    if (this.rec.state === "stopped" || !this.ctl) rmSync(recFile, { force: true });
    else {
      const prompt = [...this.hist.open.values()][0] ?? null;
      const compat = { pid: process.pid, child: this.proc?.pid ?? null, sock: this.ctl, ctl: this.ctl, home: this.h, task: this.id, session: this.rec.session, view: "chat", switching: null, busy: this.rec.state === "running", turnAt: this.rec.turnAt, prompt, at: Date.now(), hosted: true, state: this.rec.state, ...(this.rec.harness === "codex" ? { thread: this.rec.thread ?? null, turn: this.proc?.turn ?? null } : {}) };
      writeJson(recFile, compat);
    }
    store.pokeWatcher(this.h);
    broadcast(this.ref, "state", { agent: this.state() });
  }

  setState(s) {
    if (this.rec.state !== s) { this.rec.state = s; this.rec.since = Date.now(); }
    if (s === "parked") this.rec.parkedAt = Date.now();
    clearTimeout(this.parkTimer);
    if (s === "idle") { this.parkTimer = setTimeout(() => this.maybePark(), parkMs()); this.parkTimer.unref?.(); }
    this.persist();
  }

  async listen() {
    if (this.server) return;
    this.ctl = join(tmpdir(), `rollcall-host-${process.pid}-${hex(4)}.sock`);
    rmSync(this.ctl, { force: true });
    this.server = createServer((c) => lineServer(c, (req) => this.control(req)));
    await new Promise((r) => this.server.listen(this.ctl, r));
    try { chmodSync(this.ctl, 0o600); } catch {}
  }

  closeSocket() {
    try { this.server?.close(); } catch {}
    if (this.ctl) rmSync(this.ctl, { force: true });
  }

  /** The agent's control socket requests (claude/live.mjs send), answered by the host. */
  async control(req) {
    if (!req || typeof req !== "object") return { ok: false, err: "bad request" };
    const flat = (r) => (r.ok ? r : { ok: false, code: r.error?.code, err: r.error?.message });
    switch (req.op) {
      case "state": return { ok: true, ...this.state(), view: "chat", busy: this.rec.state === "running" };
      case "say": return flat(await this.say(req));
      case "interrupt": return flat(await this.interrupt());
      case "answer": {
        const r = await this.answer({ ...req, request: req.prompt }, req.by ?? "rollcall");
        if (!r.ok && r.error?.code === "already-answered") return { ok: true, already: true };
        return flat(r);
      }
      case "set": return flat(await this.set(req));
      default: return { ok: false, err: `unknown op ${req.op}` };
    }
  }

  /** Writes earlier sessions into the history once, before anything else is appended (`skip`: a session starting fresh). */
  backfill(skip = null, also = null) {
    // One at a time: two callers at once (a history read, a start) would each write every session.
    const run = (this.backfilling ?? Promise.resolve()).catch(() => {}).then(() => this._backfill(skip, also));
    this.backfilling = run;
    return run;
  }

  async _backfill(skip, also) {
    const t = this.id ? store.readTask(this.h, this.id) : await supervisorTask(this.h, also);
    if (t) await backfill(this.hist, t, { skip });
  }

  item(item, session = this.rec.session) {
    this.hist.append({ ev: "item", session, item });
    this.streaming.delete(item.id);
    broadcast(this.ref, "item", { item });
  }

  /** Starts the agent's process on its launch file: a new session, or its last one resumed. */
  async start({ prompt = null, restart = false, harness = null } = {}) {
    if (this.rec.state === "terminal") return err("refused", `${this.ref} is open in a terminal: it carries on here when the terminal closes`);
    harness = !this.id ? newerLaunch(this.h, null) : HARNESSES.has(harness) ? harness : this.proc ? this.rec.harness : newerLaunch(this.h, this.id);
    if (this.proc && restart) {
      // supervisor.mjs launch wrote a launch file: the same session running takes its first prompt as words; another
      // session (a handoff, a fresh start, another harness) replaces the process.
      const cfg = readJson(launchOf(this.h, this.id, harness));
      if (cfg?.session && cfg.session === this.rec.session && harness === this.rec.harness) {
        let first = "";
        if (cfg.prompt) { try { first = readFileSync(cfg.prompt, "utf8"); } catch {} }
        writeJson(launchOf(this.h, this.id, harness), { ...cfg, ...(harness === "claude" ? { resume: true } : {}), prompt: null });
        if (first.trim()) this.send(first, [], "rollcall");
        return { ok: true, agent: this.state(), already: true };
      }
      await this.endProcess("handoff");
    }
    if (this.proc) return { ok: true, agent: this.state(), already: true };
    if (this.starting) return this.starting;
    this.starting = this._start({ prompt, harness }).finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start({ prompt, harness }) {
    const file = launchOf(this.h, this.id, harness);
    const cfg = readJson(file);
    if (!cfg?.session || !cfg.bin) return err("not-found", `${this.ref} has no ${NAME[harness]} launch file`);
    await this.listen();
    // Codex resumes the thread its launch names; Claude Code the session its launch says exists.
    const resume = harness === "codex" ? !!cfg.thread : !!cfg.resume;
    if (!this.hist.exists || !this.hist.hasSession(cfg.session)) await this.backfill(resume ? null : cfg.session, resume ? cfg.session : null);
    // A supervisor's question that names a task relays that task's question (host/relays.mjs).
    if (!this.id) await loadFinder();
    this.rec.harness = harness;
    this.rec.session = cfg.session;
    this.rec.model = cfg.model ?? null;
    this.rec.mode = cfg.mode ?? null;
    this.hist.append({ ev: "session", session: cfg.session, harness, how: resume ? "resume" : "new" });
    broadcast(this.ref, "session", { session: cfg.session, how: resume ? "resume" : "new" });
    let first = "";
    if (cfg.prompt) { try { first = readFileSync(cfg.prompt, "utf8"); } catch {} }
    const launch = { ...cfg, ...(harness === "claude" ? { resume: true } : {}), prompt: null };
    writeJson(file, launch);
    const envFile = join(this.dir, "host-env.sh");
    this.ending = null;
    // A chat's session holds its home as a supervisor's does (its hooks mark turns and bring task news), edits allowed.
    if (this.chat) {
      bindChat(this.h, cfg.session);
      import("../supervisor.mjs").then((m) => m.ensureWatcher(this.h)).catch(() => {});
    }
    const on = (e) => { if (this.proc === proc || !proc) this.onEvent(e); };
    let proc = null;
    if (harness === "codex") {
      // A Codex chat runs no rollcall hooks: the host does their part (chat-hooks.mjs), and its shell names its session,
      // so its own `rollcall task` commands find its home as a Claude chat's do.
      const chat = this.chat ? { hook: (event, p) => chatHook(this.h, event, p), env: { ...childEnv(), ROLLCALL_SESSION: cfg.session } } : null;
      try { proc = await startCodexAgent({ h: this.h, id: this.id, cfg: launch, envFile, env: chat?.env ?? childEnv(), hook: chat?.hook ?? null, on, log: (l) => log(`${this.ref}: ${l}`) }); }
      catch (e) {
        this.item({ id: `host-exit:${hex(6)}`, at: Date.now(), kind: "system", text: `Codex did not start. A message tries again.\n${e.message}` });
        if (this.rec.state !== "stopped") this.setState("parked");
        return err("failed", e.message);
      }
      this.rec.thread = proc.thread;
      if (first.trim()) await proc.baseline; // so a quick first turn's files are that turn's, not turn 0's
    } else proc = startClaude({ cfg, resume, envFile, env: childEnv(), on, log: (l) => log(`${this.ref}: ${l}`) });
    this.proc = proc;
    log(`${this.ref}: started ${resume ? "resumed" : "new"} ${harness} session ${cfg.session} (pid ${this.proc.pid})`);
    this.rec.held = null; // they go to the process just below: a later restart must not send them again
    this.setState("idle");
    for (const q of this.queued) Promise.resolve(this.proc.say(q.text, q.attachments ?? [], q.uuid)).catch(() => {}); // words a dead process never took
    if (first.trim()) this.send(first, [], "rollcall");
    if (prompt?.trim()) this.send(prompt, [], "rollcall");
    if (this.queued.length) this.setState("running");
    return { ok: true, agent: this.state() };
  }

  send(text, attachments, from, uuid = randomUUID()) {
    if (this.proc.idFor) uuid = this.proc.idFor(from, uuid);
    // `wait`: the words join a running turn, so the item says queued until the agent takes them. Words that start a
    // turn go in at once: their item is plain from the first event (a front end shows no "queued" for them).
    const q = { uuid, text, at: Date.now(), from, attachments, wait: this.rec.state === "running" };
    this.queued.push(q);
    broadcast(this.ref, "item", { item: sentItem(q) });
    const proc = this.proc;
    // Codex takes words over its protocol, which can refuse them: then they leave the queue, and the chat says so.
    Promise.resolve(proc.say(text, attachments, uuid)).catch((e) => {
      this.queued = this.queued.filter((x) => x.uuid !== uuid);
      this.item({ id: `host-refused:${hex(6)}`, at: Date.now(), kind: "system", text: `These words did not go in: ${e.message}` });
      if (this.proc === proc && this.rec.state === "running" && !proc.turn) this.setState("idle");
      else this.persist();
    });
    if (this.rec.state !== "running") { this.rec.turnAt = Date.now(); this.setState("running"); }
    return uuid;
  }

  async say({ text = "", attachments = [], from = "owner", uuid = null, now = false } = {}) {
    text = String(text ?? "");
    attachments = Array.isArray(attachments) ? attachments.filter((p) => typeof p === "string").slice(0, 10) : [];
    if (!text.trim() && !attachments.length) return err("bad-payload", "nothing to say");
    if (this.chat && readChat(this.h)?.archivedAt) {
      // An archived chat hears only the owner: their words unarchive it and wake it.
      if ((from ?? "owner") !== "owner") return err("refused", `${this.ref} is archived`);
      unarchiveChat(this.h);
      log(`${this.ref}: unarchived by the owner's words`);
    }
    if (this.chat && (from ?? "owner") === "owner") touchChat(this.h);
    if (this.rec.state === "stopped" && from === "rollcall") return err("refused", `${this.ref} is stopped`);
    // A supervisor's prompt hook tells the owner's lines from rollcall's by this note (hooks.mjs keyed).
    if (!this.id && (from ?? "owner") === "owner" && text.trim()) store.writeHomeFile(this.h, "app-line", { text, at: Date.now(), client: "host" });
    if (this.rec.state === "terminal") {
      // Open in a terminal: the words wait, and go in when the terminal closes (closeTerminal).
      const q = { uuid: typeof uuid === "string" && uuid ? uuid : randomUUID(), text, at: Date.now(), from: from ?? "owner", attachments, wait: true };
      this.queued.push(q);
      this.rec.held = this.queued.map(({ uuid, text, at, from, attachments }) => ({ uuid, text, at, from, attachments }));
      broadcast(this.ref, "item", { item: sentItem(q) });
      this.persist();
      return { ok: true, how: "held", uuid: q.uuid, why: `${this.ref} is open in a terminal: the words go in when it closes` };
    }
    // Words sent during a turn queue behind it, as in Claude Code. `now` (the owner's "send now") goes in at once:
    // it declines what waits on the owner's answer (a question, a permission, a plan), as Esc does in the terminal,
    // and otherwise interrupts the turn, so the words start the next one.
    const declined = [];
    let interrupted = false;
    if (now === true && (from ?? "owner") === "owner" && this.proc && this.rec.state === "running") {
      for (const rid of [...this.pending.keys()]) {
        const r = await this.answer({ request: rid, allow: false, why: `${P} The owner did not answer this: they sent a message instead, which follows. Read it before you ask again.` }, "the owner's message");
        if (r.ok) declined.push(rid);
      }
      if (!declined.length) {
        interrupted = (await this.interrupt()).interrupted === true;
        // Words written before the cut turn ends would join it and get no reply: they wait for its end.
        const until = Date.now() + 10_000;
        while (interrupted && this.proc && this.rec.state === "running" && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      }
    }
    let how;
    if (!this.proc) {
      const r = await this.start();
      if (!r.ok) return r;
      how = "resumed";
    } else how = this.rec.state === "running" ? "queued" : "sent";
    const id = this.send(text, attachments, from ?? "owner", typeof uuid === "string" && uuid ? uuid : randomUUID());
    return { ok: true, how, uuid: id, ...(declined.length ? { declined } : {}), ...(interrupted ? { interrupted } : {}) };
  }

  async interrupt() {
    if (this.rec.state === "terminal") return err("refused", `${this.ref} is open in a terminal: stop its turn there`);
    if (!this.proc || this.rec.state !== "running") return { ok: true, interrupted: false };
    await this.proc.interrupt().catch(() => null);
    return { ok: true, interrupted: true };
  }

  async set({ model = null, mode = null } = {}) {
    // A chat on Codex takes Codex's modes (host/chat.mjs CODEX_MODES) from its next turn; a Codex task's worker keeps its own.
    const codex = this.chat ? readChat(this.h)?.harness === "codex" : this.rec.harness === "codex" || (!this.rec.state && newerLaunch(this.h, this.id) === "codex");
    if (mode && codex && !this.chat) return err("bad-payload", "a Codex worker keeps the permission mode it started with");
    const modes = codex ? new Set(modesOf("codex").map((m) => m.id)) : SET_MODES;
    if (mode && !modes.has(mode)) return err("bad-payload", `mode is one of ${[...modes].join(", ")}`);
    if (!model && !mode) return err("bad-payload", "set takes a model or a mode");
    const done = {};
    if (model) {
      if (this.proc) { const r = await this.proc.setModel(model).catch((e) => ({ error: e.message })); if (r?.error) return err("failed", r.error); }
      // A running Codex session remembers it in its launch file itself.
      const cfg = readJson(launchOf(this.h, this.id, this.rec.harness));
      if (cfg && !(this.proc && this.rec.harness === "codex")) writeJson(launchOf(this.h, this.id, this.rec.harness), { ...cfg, model });
      this.rec.model = model;
      done.model = model;
    }
    if (mode) {
      if (!this.proc && !this.chat) return err("refused", `${this.ref} is not running: a mode lasts for a running session`);
      if (this.proc) {
        const r = await this.proc.setMode(mode).catch((e) => ({ error: e.message }));
        if (r?.error) return err("failed", r.error);
      }
      // The owner's pick lasts across park and wake (its chip shows it), as a model carries into a resume: a chat's
      // across archive too, and a task's worker's when the host wakes it after a park. A worker the host resumed in
      // its first mode kept asking for permissions the owner had switched off.
      const harness = codex ? "codex" : "claude";
      const cfg = readJson(launchOf(this.h, this.id, harness));
      if (cfg) writeJson(launchOf(this.h, this.id, harness), { ...cfg, mode, ...(codex ? policyFor(mode) : {}) });
      this.rec.mode = mode;
      done.mode = mode;
    }
    // The chat's record too: a launch written again from it (a worktree remade on unarchive) starts with the pick.
    if (this.chat) updateChat(this.h, (c) => { if (model) c.model = model; if (mode) c.mode = mode; });
    // A Codex chat's tasks start in the Claude mode its pick matches: the session's record says it (bindChat).
    if (this.chat && codex && mode && this.rec.session) bindChat(this.h, this.rec.session);
    this.persist();
    return { ok: true, set: done };
  }

  closeRequest(id, how, by, answer = null) {
    this.pending.delete(id);
    this.hist.append({ ev: "closed", id, how, by: by ?? null, answer });
    broadcast(this.ref, "closed", { id, how, by: by ?? null });
    if (!this.hist.open.size) rmSync(dialogFlag(this.h, this.wid), { force: true });
    this.persist();
  }

  /** The first answer wins; a request whose process is gone is answered as the owner's words on a resumed session. */
  async answer(a, by = null) {
    const id = a.request;
    const done = this.hist.closed.get(id);
    if (done) return err("already-answered", `request ${id} was ${done.how === "cancelled" ? "cancelled" : `answered${done.by ? ` from ${done.by}` : ""}`}`);
    const req = this.hist.open.get(id);
    if (!req) return err("not-found", `no request ${id}`);
    if (req.kind === "question" && !(a.answers && typeof a.answers === "object") && a.allow !== false) return err("bad-payload", "a question takes answers");
    if (a.mode != null && !PLAN_MODES.has(a.mode)) return err("bad-payload", `mode is one of ${[...PLAN_MODES].join(", ")}`);
    // A supervisor's question that relays a task's question is that task's request: the answer goes to the task as a
    // front end's does (answer.mjs, first answer wins), and closing its picker answers this one (closeFalconPicker).
    if (req.relays?.ref && a.allow !== false && a.answers && typeof a.answers === "object") {
      const r = await relayAnswer(req, a, by);
      if (r.ok || r.error?.code === "already-answered") {
        // Answered already on the task's side: this request waits on nothing, so it closes too, or the turn stays stuck.
        const from = r.ok ? by ?? "a front end" : r.error.answered?.by ?? "another surface";
        if (this.hist.open.has(id)) await this.answer({ request: id, allow: false, why: `${P} The owner answered this from ${from}, and the answer reached the worker already. Do not ask it again.` }, by);
        if (!r.ok) return err("already-answered", r.error.message);
        return { ok: true, answered: true, how: "relayed", delivered: r.how ?? null };
      }
      // The task asks nothing now (or something newer): the pick is the supervisor's own, as in its picker.
    }
    const answer = { allow: a.allow ?? null, why: a.why ?? null, always: a.always ?? null, mode: a.mode ?? null, answers: a.answers ?? null };
    const p = this.pending.get(id);
    if (p && this.proc) {
      this.closeRequest(id, "answered", by, answer);
      this.proc.answer(p.rid, p.prompt, p.input, a);
      this.persist();
      return { ok: true, answered: true, how: "answered" };
    }
    this.closeRequest(id, "words", by, answer);
    const r = await this.say({ text: wordsFor(req, a), from: "owner" });
    if (!r.ok) return r;
    return { ok: true, answered: true, how: "words", delivered: r.how };
  }

  /** Ends the running process (`how`: "park", "stop", "handoff") and resolves once it exited. */
  endProcess(how) {
    const p = this.proc;
    if (!p) return Promise.resolve();
    const gone = new Promise((r) => this.exitWaiters.push(r));
    this.ending = how;
    p.close();
    setTimeout(() => { if (this.proc === p) p.kill(); }, how === "park" ? 10_000 : 5_000).unref();
    setTimeout(() => { if (this.proc === p) p.kill("SIGKILL"); }, 15_000).unref();
    return gone;
  }

  maybePark() {
    if (this.rec.state !== "idle" || !this.proc || this.pending.size || this.queued.length) return false;
    return this.park();
  }

  park() {
    if (this.rec.state === "terminal") return false;
    if (!this.proc) {
      if (this.rec.state === "running" || this.rec.state === "idle") this.setState("parked");
      return true;
    }
    if (this.rec.state === "running" || this.pending.size) return false;
    void this.endProcess("park");
    return true;
  }

  stop() {
    for (const id of [...this.hist.open.keys()]) this.closeRequest(id, "cancelled", "stop");
    this.queued = [];
    this.rec.held = null;
    if (!this.proc) { this.setState("stopped"); return true; }
    void this.endProcess("stop");
    return true;
  }

  /**
   * The terminal escape hatch: the real CLI on this agent's own session, which the caller runs (`rollcall open`). The
   * host ends its process first (two processes never share a session), shows `terminal` until closeTerminal, holds
   * words sent meanwhile, and never parks it. `c` is the caller's connection: when it closes, so does the terminal.
   * `pid` is the caller's process (it waits on the CLI): a host that restarts meanwhile watches it (restore).
   */
  async openTerminal(c = null, { pid = null } = {}) {
    if (this.rec.state === "terminal") return err("refused", `${this.ref} is open in a terminal already`);
    if (this.rec.state === "running") return err("refused", `${this.ref} is in a turn: wait for it to end, or interrupt it, then open it`);
    const harness = this.rec.state ? this.rec.harness : newerLaunch(this.h, this.id);
    const cfg = readJson(launchOf(this.h, this.id, harness));
    if (!cfg?.session || !cfg.bin) return err("not-found", `${this.ref} has no ${NAME[harness]} launch file`);
    if (harness === "codex" && !(this.rec.thread ?? cfg.thread)) return err("refused", `${this.ref} has no Codex thread yet: start it first`);
    if (this.proc) await this.endProcess("terminal");
    if (this.rec.state === "running") return err("refused", `${this.ref} started a turn: try again when it ends`);
    const started = harness === "claude" ? !!cfg.resume : true;
    // The real CLI asks to trust a folder stream mode never asked about, and Enter there exits: a worktree rollcall
    // made is marked trusted first, as the owner's yes would record it.
    if (harness === "claude" && this.id) {
      const t = store.readTask(this.h, this.id);
      const wrote = t ? trustWorktree(t) : false;
      if (wrote) log(`${this.ref}: marked ${t.worktree} trusted for Claude Code`);
      else if (wrote === null) log(`${this.ref}: could not mark ${t.worktree} trusted; the CLI asks`);
    }
    if (!this.hist.exists || !this.hist.hasSession(cfg.session)) await this.backfill(started ? null : cfg.session, started ? cfg.session : null);
    let args;
    if (harness === "codex") args = ["resume", this.rec.thread ?? cfg.thread, ...(cfg.model ? ["-m", cfg.model] : [])];
    else {
      // A session that never ran starts with its name and first prompt.
      let first = "";
      if (!started && cfg.prompt) { try { first = readFileSync(cfg.prompt, "utf8"); } catch {} }
      args = [
        ...(started ? ["--resume", cfg.session] : ["--session-id", cfg.session]),
        ...(cfg.addDir?.length ? ["--add-dir", ...cfg.addDir] : []),
        ...(cfg.settings ? ["--settings", cfg.settings] : []),
        ...(cfg.mode ? ["--permission-mode", cfg.mode] : []),
        ...(cfg.model ? ["--model", cfg.model] : []),
        ...(cfg.effort ? ["--effort", cfg.effort] : []),
        ...(appendedPrompt(cfg) ? ["--append-system-prompt", appendedPrompt(cfg)] : []),
        ...(!started && cfg.name ? ["-n", cfg.name] : []),
        ...(first.trim() ? [first.startsWith("-") ? ` ${first}` : first] : []),
      ];
      writeJson(launchOf(this.h, this.id, harness), { ...cfg, resume: true, prompt: null });
    }
    const [cmd, argv] = commandOf(cfg.bin, args, join(this.dir, "host-env.sh"));
    this.rec.harness = harness;
    this.rec.session = cfg.session;
    if (this.hist.sessions.at(-1)?.session !== cfg.session) {
      this.hist.append({ ev: "session", session: cfg.session, harness, how: started ? "resume" : "new", terminal: true });
      broadcast(this.ref, "session", { session: cfg.session, how: started ? "resume" : "new" });
    }
    pid = Number.isInteger(pid) && pid > 1 ? pid : null;
    this.terminal = { at: Date.now(), cwd: cfg.cwd ?? null, pid, start: pid ? startOf(pid) : null };
    this.rec.terminal = this.terminal;
    this.setState("terminal");
    log(`${this.ref}: open in a terminal on session ${cfg.session}`);
    if (c) c.once("close", () => { void this.closeTerminal(); });
    return { ok: true, argv: [cmd, ...argv], cwd: cfg.cwd && existsSync(cfg.cwd) ? cfg.cwd : null, unset: CHILD_UNSET.filter((k) => !k.startsWith("TMUX")), agent: this.state() };
  }

  /**
   * A front end is done with the terminal (its setting went back to Chat, or its view closed): the command that runs
   * it (`rollcall open`, its `pid`) hears SIGTERM, ends the CLI once no turn runs, then closes it as any end does.
   * Meanwhile the agent stays `terminal`, with `terminal.closing` set, so a front end can say why it waits.
   */
  endTerminal() {
    if (!this.terminal) return { ok: true, closing: false, agent: this.state() };
    const { pid, start } = this.terminal;
    if (!pid) return err("refused", `${this.ref} runs in a terminal rollcall cannot reach: close it there`);
    if (!pidAlive(pid, start)) { void this.closeTerminal(); return { ok: true, closing: true, agent: this.state() }; }
    if (!this.terminal.closing) {
      this.terminal.closing = Date.now();
      this.rec.terminal = this.terminal;
      this.persist();
      log(`${this.ref}: asked to close its terminal`);
    }
    try { process.kill(pid, "SIGTERM"); } catch {}
    return { ok: true, closing: true, agent: this.state() };
  }

  /** The terminal closed: what its session added joins the history, and words held meanwhile wake the agent. */
  async closeTerminal() {
    if (!this.terminal) return { ok: true, closed: false };
    const was = this.terminal;
    this.terminal = null;
    clearInterval(this.terminalWatch);
    this.terminalWatch = null;
    let added = [];
    try { added = await this.terminalItems(was); } catch (e) {
      log(`${this.ref}: the terminal's turns were not read: ${e.message}`);
      if (this.rec.harness === "codex") this.item({ id: `host-terminal:${hex(6)}`, at: Date.now(), kind: "system", text: "Codex ran in a terminal, and what it did there could not be read here. It is in its thread, and Codex reads it on its next turn." });
    }
    for (const item of added) broadcast(this.ref, "item", { item });
    // Only now: a host that dies before this reads the terminal again on its restart, and adds what is missing.
    this.rec.terminal = null;
    log(`${this.ref}: the terminal closed (${added.length} items from it)`);
    if (this.rec.state !== "terminal") { this.persist(); return { ok: true, closed: true, added: added.length, agent: this.state() }; }
    this.setState("parked");
    if (this.queued.length) {
      const r = await this.start();
      if (!r.ok) log(`${this.ref}: held words did not go in: ${r.error?.message}`);
    }
    return { ok: true, closed: true, added: added.length, agent: this.state() };
  }

  /**
   * What the terminal added to the session, appended to the history: a Claude session's transcript lines, or a Codex
   * thread's turns (`codex resume` writes no journal: host/codex.mjs terminalTurns). Only what the history lacks, so
   * reading it twice adds nothing.
   */
  async terminalItems(was) {
    if (this.rec.harness !== "codex") return catchUp(this.hist, { home: this.h, id: this.wid, dir: this.dir, session: this.rec.session, cwd: was.cwd, harness: "claude" });
    const cfg = readJson(codexLaunchFile(this.h, this.id));
    const thread = this.rec.thread ?? cfg?.thread;
    if (!cfg?.bin || !thread) throw new Error("no Codex launch file or thread");
    const session = this.rec.session ?? cfg.session;
    const items = await terminalTurns({ h: this.h, id: this.id, cfg: { ...cfg, session }, thread, since: was.at, has: (x) => this.hist.index.has(x), envFile: join(this.dir, "host-env.sh"), env: childEnv() });
    return addNew(this.hist, session, items);
  }

  /** A host restarted while the terminal ran: the command that runs it is watched, and its end closes the terminal. */
  watchTerminal() {
    clearInterval(this.terminalWatch);
    this.terminalWatch = setInterval(() => {
      if (this.terminal && !pidAlive(this.terminal.pid, this.terminal.start)) void this.closeTerminal();
    }, msEnv("ROLLCALL_HOST_TERMINAL_POLL_MS", 1000));
    this.terminalWatch.unref?.();
  }

  onEvent(e) {
    switch (e.type) {
      case "init":
        if (this.rec.harness !== "claude") return;
        // A launch that named no model or mode runs Claude Code's own defaults: record what it says it runs, so a
        // front end shows the worker's real model and mode instead of nothing.
        if ((!this.rec.model && e.model) || (!this.rec.mode && e.mode)) {
          if (!this.rec.model && e.model) this.rec.model = e.model;
          if (!this.rec.mode && e.mode) this.rec.mode = e.mode;
          this.persist();
        }
        if (e.session && e.session !== this.rec.session) {
          this.rec.session = e.session;
          const cfg = readJson(launchFile(this.h, this.id));
          if (cfg) writeJson(launchFile(this.h, this.id), { ...cfg, session: e.session });
          this.persist();
        }
        return;
      case "items":
        for (const x of e.items) {
          if (x.kind === "user") this.queued = this.queued.filter((q) => q.uuid !== x.id);
          this.item(x);
        }
        return;
      case "text": {
        const s = this.streaming.get(e.id) ?? { id: e.id, at: Date.now(), kind: e.kind, text: "", streaming: true, ...(e.parent ? { parent: e.parent } : {}) };
        s.text += e.append;
        this.streaming.set(e.id, s);
        broadcast(this.ref, "text", { id: e.id, kind: e.kind, append: e.append, parent: e.parent ?? null });
        return;
      }
      case "turn-start":
        if (this.rec.state !== "running") { this.rec.turnAt = Date.now(); this.setState("running"); } else this.persist();
        return;
      case "taken":
        this.queued = this.queued.filter((q) => q.uuid !== e.uuid);
        if (this.rec.state !== "running") { this.rec.turnAt = Date.now(); this.setState("running"); }
        return;
      case "turn-end":
        this.streaming.clear();
        if (this.chat) touchChat(this.h);
        if (e.context) recordContext(this, e.context);
        if (this.rec.harness === "codex") {
          // Codex starts no turn for words steered in as one ended: they are gone, rather than shown waiting for good.
          this.rec.turnAt = null;
          this.setState("idle");
          if (this.queued.length) setTimeout(() => { if (this.rec.state === "idle" && this.queued.length) { this.queued = []; this.persist(); } }, 3000).unref();
          return;
        }
        this.rec.turnAt = this.queued.length ? Date.now() : null;
        this.setState(this.queued.length ? "running" : "idle");
        return;
      case "request": {
        const id = `rq-${hex(6)}`;
        const input = e.input ?? (e.req.input && typeof e.req.input === "object" ? e.req.input : {});
        // A Codex question carries its questions on the prompt, not in a tool input.
        const relays = this.id ? null : relaysOf(this.h, e.prompt?.kind === "question" ? { questions: e.prompt.questions } : input);
        const p = e.prompt ? { ...e.prompt, id, ...(relays ? { relays } : {}) } : promptOf(e.req, id, { cwd: readJson(launchFile(this.h, this.id))?.cwd ?? null, relays });
        const request = { ...p, ref: this.ref, session: this.rec.session };
        this.pending.set(id, { rid: e.rid, input, prompt: p });
        this.hist.append({ ev: "request", request });
        broadcast(this.ref, "request", { request });
        this.persist();
        return;
      }
      case "cancel": {
        const id = [...this.pending].find(([, v]) => v.rid === e.rid)?.[0];
        if (id) this.closeRequest(id, "cancelled", null);
        return;
      }
      case "limits": try { recordClaude(e.limits); } catch {} return;
      case "exit": {
        const how = this.ending;
        this.proc = null;
        this.ending = null;
        this.pending.clear(); // open requests stay open in the history: answered later, they go in as words
        this.streaming.clear();
        rmSync(dialogFlag(this.h, this.wid), { force: true });
        log(`${this.ref}: process ended (${how ?? `exit ${e.code}`})`);
        for (const w of this.exitWaiters.splice(0)) w();
        if (how === "handoff" || how === "terminal") return; // a new process starts at once, or the terminal takes over
        if (how === "stop") { this.setState("stopped"); return; }
        if (how !== "park" && e.code !== 0) {
          this.item({ id: `host-exit:${hex(6)}`, at: Date.now(), kind: "system", text: `${NAME[this.rec.harness] ?? "The agent"} stopped (exit ${e.code}). A message brings it back.${e.err ? `\n${e.err}` : ""}` });
        }
        this.setState("parked");
        // Words that came in while it was closing went to a dying process: the next process takes them.
        if (how === "park" && this.queued.length) void this.start().catch((x) => log(`${this.ref}: held words did not go in: ${x.message}`));
        return;
      }
      default:
    }
  }
}

/** Words sent and not taken yet, as an item: `queued` only while they wait (behind a running turn, or a terminal). */
const sentItem = (q) => ({ id: q.uuid, at: q.at, kind: "user", text: q.text, images: [], from: q.from, ...(q.wait === false ? {} : { queued: true }) });

/** What an agent's process must not inherit (client.mjs SESSION_ENV): another session's or task's own settings. */
export const CHILD_UNSET = SESSION_ENV;
const childEnv = () => withoutSessionEnv(process.env);

/**
 * Answers the task question a supervisor's question relays, as a front end does (the question.answer action). Run as
 * its own process, never in the host's: it reaches agents through their control sockets, which this process serves.
 */
function relayAnswer(req, a, by) {
  const qs = Array.isArray(req.questions) ? req.questions : [];
  const single = qs.length === 1 && typeof a.answers[qs[0].question] === "string" ? a.answers[qs[0].question] : null;
  const payload = { task: req.relays.ref, question: req.relays.question, answers: a.answers, ...(single ? { answer: single } : {}), client: by ?? "the chat" };
  const env = childEnv();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "api", "do", "question.answer", JSON.stringify(payload)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", (e) => resolve(err("failed", e.message)));
    child.on("exit", () => {
      try { const r = JSON.parse(out); resolve(r.ok ? { ok: true, how: r.result?.how ?? null } : r); } catch { resolve(err("failed", out.trim() || "the answer did not go")); }
    });
  });
}

function recordContext(a, c) {
  const now = Date.now();
  if (!a.id) { store.writeHomeFile(a.h, "context", { pct: c.pct, session: a.rec.session, at: now }); return; }
  store.writeHomeFile(a.h, `context-${a.id}`, { pct: c.pct, at: now, session: a.rec.session, tokens: c.tokens, size: c.size });
  import("../supervisor.mjs").then(({ markCap }) => { const t = store.readTask(a.h, a.id); if (t) markCap(t, a.rec.session, c.pct); }).catch(() => {});
}

/** `home:task` (a task's worker) or a bare `home` (its supervisor). */
function parseRef(ref) {
  const m = /^([a-z][a-z0-9-]{0,23})(?::([A-Za-z0-9._-]+))?$/.exec(String(ref ?? ""));
  return m ? { h: m[1], id: m[2] ?? null } : null;
}

/**
 * What a supervisor's history backfills from, shaped as a task: its home's worker folder, and its last session (the one
 * falcon or its lock names, as `falcon continue` would resume) plus `also`, read from their transcripts.
 */
async function supervisorTask(h, also = null) {
  const { lastSession } = await import("../window.mjs");
  const last = lastSession(h);
  const ids = [...new Set([last?.id, also].filter(Boolean))];
  return { id: h, home: h, worktree: last?.cwd ?? readJson(launchFile(h, null))?.cwd ?? null, sessions: ids.map((id) => ({ id, harness: "claude" })) };
}

/** The agent for `ref`, made on first use (nothing starts). */
function agentFor(ref) {
  const r = parseRef(ref);
  if (!r) return null;
  let a = agents.get(r.id ? `${r.h}:${r.id}` : r.h);
  if (!a) {
    if (!store.listHomes().includes(r.h) || (r.id && !store.readTask(r.h, r.id))) return null;
    a = new Agent(r.h, r.id);
    agents.set(a.ref, a);
  }
  return a;
}

/**
 * Every agent a host ran before, from disk: a process recorded running is gone with that host, so it is parked. One
 * open in a terminal stays `terminal` while the command that runs it lives, and closes (closeTerminal) once it is gone.
 */
async function restore() {
  const gone = []; // agents whose terminal closed while no host ran
  for (const h of store.listHomes()) {
    let ids = [];
    try { ids = readdirSync(join(store.homeDir(h), "workers")); } catch { continue; }
    for (const id of ids) {
      const rec = readJson(join(store.homeDir(h), "workers", id, "agent.json"));
      if (!rec?.state) continue;
      const a = new Agent(h, id === h ? null : id);
      agents.set(a.ref, a);
      if (rec.state === "terminal") {
        // The command that runs the terminal held its connection to the host that died, so nothing tells this one it
        // closed: while that command runs, it is watched; once it is gone, what the terminal added is read now.
        const t = rec.terminal ?? {};
        a.terminal = { at: t.at ?? rec.terminalAt ?? rec.since ?? 0, cwd: t.cwd ?? readJson(launchOf(h, a.id, rec.harness))?.cwd ?? null, pid: t.pid ?? null, start: t.start ?? null, closing: t.closing ?? null };
        if (sameProcess(a.terminal.pid, a.terminal.start)) { a.watchTerminal(); log(`${a.ref}: still open in a terminal (pid ${a.terminal.pid}); watching it`); }
        else gone.push(a);
      }
      if (rec.state === "running" || rec.state === "idle") {
        // A Codex agent's app server outlives a host killed outright: it goes, by the pid and socket on the record.
        if (rec.harness === "codex") { killServer(rec.pid, rec.serverSock); if (rec.serverSock) rmSync(rec.serverSock, { force: true }); }
        a.item({ id: `host-restart:${hex(6)}`, at: Date.now(), kind: "system", text: "The host restarted, which ended this agent's process. A message brings it back." });
        a.rec.state = "parked";
        a.rec.parkedAt = Date.now();
      }
      if (rec.state !== "stopped") await a.listen();
      a.persist();
    }
  }
  // Read in the background, so the host answers meanwhile: until then the agent shows `terminal` and holds words,
  // which go in after the terminal's turns.
  for (const a of gone) void a.closeTerminal().catch((e) => log(`${a.ref}: the terminal did not close: ${e.message}`));
}

// ---------------------------------------------------------------- the socket

/** Line-delimited JSON on a connection: each request line gets one answer line (`id` echoed). */
function lineServer(c, handle) {
  let buf = "";
  c.setEncoding("utf8"); // a character split across two chunks stays whole
  c.on("data", (d) => {
    buf += d;
    if (buf.length > 32_000_000) { c.destroy(); return; }
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let req = null;
      try { req = JSON.parse(line); } catch {}
      Promise.resolve()
        .then(() => handle(req, c))
        .catch((e) => err("failed", e.message))
        .then((r) => { try { c.write(`${JSON.stringify({ ...(r ?? err("failed", "no answer")), ...(req?.id != null ? { id: req.id } : {}) })}\n`); } catch {} });
    }
  });
  c.on("error", () => {});
}

let shutdown = null;

async function handle(req, c) {
  if (!req || typeof req !== "object") return err("bad-payload", "a call is one JSON object");
  const need = () => {
    const a = agentFor(req.ref);
    if (!a) throw Object.assign(new Error(`no task ${req.ref}`), { code: "not-found" });
    return a;
  };
  try {
    switch (req.op) {
      case "hello": return { ok: true, pid: process.pid, version: VERSION, code: CODE, interface: INTERFACE };
      case "list": return { ok: true, agents: [...agents.values()].filter((a) => a.rec.state).map((a) => a.state()) };
      case "state": return { ok: true, agent: need().state() };
      case "start": return await need().start({ prompt: typeof req.prompt === "string" ? req.prompt : null, restart: req.restart === true, harness: req.harness ?? null });
      case "say": return await need().say(req);
      case "interrupt": return await need().interrupt();
      case "set": return await need().set(req);
      // The terminal escape hatch. `open` is a front end's: the argv that runs it (`rollcall open <ref>`), as `api
      // attach` gives tmux's. `terminal` is that command's own call, held for as long as the terminal runs.
      case "open": { const a = need(); return { ok: true, argv: [process.execPath, BIN, "open", a.ref], ref: a.ref, agent: a.state() }; }
      case "terminal": return await need().openTerminal(c, { pid: req.pid });
      case "terminal-done": return await need().closeTerminal();
      case "terminal-end": return need().endTerminal();
      case "park": { const a = need(); return { ok: true, parked: a.park() }; }
      case "stop": { const a = need(); return { ok: true, stopped: a.stop() }; }
      case "answer": {
        const a = req.ref ? need() : [...agents.values()].find((x) => x.hist.open.has(req.request) || x.hist.closed.has(req.request));
        if (!a) return err("not-found", `no request ${req.request}`);
        return await a.answer(req, req.by ?? req.client ?? null);
      }
      case "history": {
        const a = need();
        if (!a.hist.exists) await a.backfill();
        const extra = [...a.streaming.values(), ...a.queued.map(sentItem)];
        const p = a.hist.page({ before: req.before ?? null, limit: req.limit ?? 200, extra });
        if (!p.ok) return p;
        return { ...p, ref: a.ref, session: a.rec.session, harness: a.rec.harness, agent: a.state(), requests: [...a.hist.open.values()] };
      }
      case "subscribe": {
        const refs = Array.isArray(req.refs) && req.refs.length ? new Set(req.refs.map(String)) : null;
        const s = { c, refs };
        subscribers.add(s);
        c.on("close", () => subscribers.delete(s));
        return { ok: true, subscribed: refs ? [...refs] : "all", agents: [...agents.values()].filter((a) => a.rec.state && (!refs || refs.has(a.ref))).map((a) => a.state()) };
      }
      // A chat (host/chat.mjs): its first words and title, a task card, and archiving, all where its agent runs.
      case "chat-start": return await chatStart(req);
      case "chat-task": {
        const a = agentFor(req.ref);
        if (!a?.chat) return err("not-found", `${req.ref} is not a chat`);
        a.item(taskItem(a.h, String(req.task ?? ""), req.title));
        return { ok: true };
      }
      case "chat-archive": {
        const a = agentFor(req.ref);
        if (!a?.chat) return err("not-found", `${req.ref} is not a chat`);
        return archiveAgent(a, req.by === "auto" ? "auto" : "owner");
      }
      case "shutdown": setTimeout(() => shutdown?.(0), 20); return { ok: true };
      default: return err("bad-payload", `no op ${req.op}`);
    }
  } catch (e) {
    return err(e.code ?? "failed", e.message);
  }
}

// ---------------------------------------------------------------- chats

/**
 * A new chat's first words (`chat.new`, after its launch is written): the owner's, attachments as `say` takes them,
 * which starts its session. Then, unless the owner named it, a title from a one-shot model in the background.
 */
async function chatStart(req) {
  const a = agentFor(req.ref);
  if (!a?.chat) return err("not-found", `${req.ref} is not a chat`);
  const r = await a.say({ text: req.text, attachments: req.attachments ?? [], from: "owner" });
  if (!r.ok) return r;
  if (readChat(a.h)?.titleBy === "draft") {
    void writeTitle(String(req.text ?? ""), { env: childEnv() }).then((title) => {
      if (!title) { log(`${a.ref}: no title came back; the draft stays`); return; }
      const c = setTitle(a.h, title, "auto");
      log(`${a.ref}: titled "${c?.title ?? title}"${c?.branch ? ` (${c.branch})` : ""}`);
    }).catch((e) => log(`${a.ref}: the title failed: ${e.message}`));
  }
  return { ok: true, how: r.how, uuid: r.uuid, session: a.rec.session, agent: a.state() };
}

/** Whether a chat's agent is mid-turn, open in a terminal, or holding words not yet taken: archiving would cut it short. */
const chatRunning = (a) => a.rec.state === "running" || a.rec.state === "terminal" || a.queued.length > 0;

/**
 * Archives a chat (refused with open tasks, a turn running or a request open) and ends its process; its session is
 * saved, and words bring it back.
 */
function archiveAgent(a, by) {
  const r = archiveChat(a.h, by, Date.now(), { running: chatRunning(a), requests: a.hist.open.size });
  if (!r.ok) return err(r.code, r.err);
  if (a.rec.state && a.rec.state !== "stopped") a.stop(); // never "terminal": chatRunning refused it above
  log(`${a.ref}: archived (${by})`);
  return { ok: true, chat: r.chat };
}

/** How often the host looks for chats to archive: every 10 minutes (ROLLCALL_CHAT_ARCHIVE_POLL_MS). */
const archivePollMs = () => msEnv("ROLLCALL_CHAT_ARCHIVE_POLL_MS", 600_000);

/** Archives each chat unused for the delay, with no open tasks, no turn running and no open request. */
export function archiveIdleChats(now = Date.now()) {
  for (const h of store.listHomes()) {
    if (!isChat(h)) continue;
    const c = readChat(h);
    if (!c || c.archivedAt) continue;
    const a = agentFor(h);
    if (!archiveDue(c, { open: openTasks(h).length, running: a ? chatRunning(a) : false, requests: a ? a.hist.open.size : 0 }, now)) continue;
    if (a) archiveAgent(a, "auto");
  }
}

// ---------------------------------------------------------------- the process

function takeLock() {
  mkdirSync(hostDir(), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" }); return true; } catch {}
    const held = readJson(lockFile());
    if (held && held.pid !== process.pid && pidAlive(held.pid)) return false;
    rmSync(lockFile(), { force: true });
  }
  return false;
}

/** `rollcall host [status|stop]`. */
export async function hostCommand([verb, ...rest] = []) {
  const { call } = await import("./client.mjs");
  // A hosted crew (cockpit's): made and ended here, run by the host.
  if (verb === "new" || verb === "end") {
    if (verb === "end" && !rest[0]) { process.stderr.write("usage: rollcall host end <supervisor>\n"); return 2; }
    return (await import("./crew.mjs")).crewCommand(verb, rest);
  }
  if (verb === "status") {
    const r = await call("list", {}, { start: false });
    process.stdout.write(`${JSON.stringify(r.ok ? { ok: true, running: true, sock: socketPath(), agents: r.agents } : { ok: true, running: false }, null, 2)}\n`);
    return 0;
  }
  if (verb === "stop") {
    const r = await call("shutdown", {}, { start: false });
    process.stdout.write(`${JSON.stringify({ ok: true, stopped: !!r.ok })}\n`);
    return 0;
  }
  if (verb && verb !== "run") { process.stderr.write("usage: rollcall host [run|status|stop|new [--cwd <dir>] [--name <h>]|end <h>]\n"); return 2; }
  return runHost();
}

export async function runHost() {
  logPath = logFile();
  if (!takeLock()) { log(`another host runs (pid ${readJson(lockFile())?.pid}); this one (${process.pid}) leaves`); return 0; }
  const sock = socketPath();
  rmSync(sock, { force: true });
  const server = createServer((c) => lineServer(c, handle));
  await new Promise((r, j) => { server.once("error", j); server.listen(sock, r); });
  try { chmodSync(sock, 0o600); } catch {}
  // Agent control sockets a killed host left behind (no handler ran): rollcall-host-<its pid>-<n>.sock.
  try {
    for (const n of readdirSync(tmpdir())) {
      const m = /^rollcall-host-(\d+)-[0-9a-f]+\.sock$/.exec(n);
      if (m && !pidAlive(Number(m[1]))) rmSync(join(tmpdir(), n), { force: true });
    }
  } catch {}
  await restore();
  writeJson(infoFile(), { pid: process.pid, sock, at: Date.now(), version: VERSION, code: CODE });
  log(`host ${process.pid} listens on ${sock} (${agents.size} agents restored; code ${CODE})`);
  const archiver = setInterval(() => { try { archiveIdleChats(); } catch (e) { log(`the chat archiver failed: ${e.message}`); } }, archivePollMs());
  archiver.unref?.();
  // Codex's model list for a new chat's model chip, read from Codex itself now and then (none when it is not installed).
  const readModels = () => { refreshCodexModels({ env: childEnv() }).catch((e) => log(`Codex's models were not read: ${e.message}`)); };
  readModels();
  const modelsTimer = setInterval(readModels, 3600_000);
  modelsTimer.unref?.();

  let ended = false;
  shutdown = async (code) => {
    if (ended) return;
    ended = true;
    log(`host ${process.pid} stops`);
    const live = [...agents.values()].filter((a) => a.proc);
    for (const a of live) { a.ending = "park"; a.proc.close(); }
    const until = Date.now() + 8000;
    while (live.some((a) => a.proc) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    for (const a of live) if (a.proc) a.proc.kill("SIGKILL");
    for (const a of agents.values()) a.closeSocket();
    try { server.close(); } catch {}
    rmSync(sock, { force: true });
    if (readJson(infoFile())?.pid === process.pid) rmSync(infoFile(), { force: true });
    if (readJson(lockFile())?.pid === process.pid) rmSync(lockFile(), { force: true });
    process.exit(code);
  };
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => void shutdown(0));
  process.on("uncaughtException", (e) => { log(`host failed: ${e?.stack ?? e}`); });
  await new Promise(() => {});
}
