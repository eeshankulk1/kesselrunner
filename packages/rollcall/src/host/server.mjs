// `rollcall host`: the agent host (docs/plans/2026-11-08-agent-host.md). One long-lived process per store that runs
// every hosted agent as its child (host/claude.mjs, host/codex.mjs), owns each agent's state (agent.json), keeps one
// history per task (host/history.mjs), saves questions and permission prompts as requests, and serves a socket where
// front ends call and subscribe. Each agent also gets the control socket and record the stream worker had
// (claude/live.mjs), so delivery, `task tell`, answers and away mode reach it unchanged.
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRecordFile, launchFile, readJson, recordFile, writeJson } from "../claude/live.mjs";
import { PLAN_MODES, SET_MODES, decisionFor, promptOf } from "../claude/worker.mjs";
import { dialogFlag } from "../delivery.mjs";
import { pidAlive } from "../proc.mjs";
import * as store from "../store.mjs";
import { recordClaude } from "../usage.mjs";
import { startClaude } from "./claude.mjs";
import { hostDir, infoFile, lockFile, logFile, socketPath } from "./client.mjs";
import { History, backfill, historyFile } from "./history.mjs";

export const INTERFACE = 1;
const VERSION = "0.1.0";
export const STATES = ["running", "idle", "parked", "stopped"];
const SEND = { running: "join", idle: "start", parked: "wake", stopped: "wake" };
const msEnv = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : dflt; };
/** An idle agent parks after this long: Claude Code's own background agents stop after about an hour. */
export const parkMs = () => msEnv("ROLLCALL_HOST_PARK_MS", 3600_000);

const err = (code, message) => ({ ok: false, error: { code, message } });
const hex = (n) => randomBytes(n).toString("hex");

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

class Agent {
  constructor(h, id) {
    this.h = h; this.id = id; this.ref = `${h}:${id}`;
    this.dir = store.workerDir(h, id);
    this.file = join(this.dir, "agent.json");
    const rec = readJson(this.file);
    this.rec = rec ?? { ref: this.ref, home: h, task: id, harness: "claude", state: null, session: null, since: Date.now(), turnAt: null, parkedAt: null, model: null, mode: null };
    this.proc = null;
    this.pending = new Map(); // request id -> { rid, input, prompt }
    this.queued = []; // words sent, not taken yet: { uuid, text, at, from, attachments }
    this.streaming = new Map(); // item id -> a streamed item not finished yet
    this.ending = null; // "park" | "stop" while the process is asked to end
    this.parkTimer = null;
    this.ctl = null; // the control socket's path
    this.server = null;
    this.starting = null;
  }

  /** The history, read from its file on first use. */
  get hist() { return (this._hist ??= new History(historyFile(this.h, this.id))); }

  state() {
    const s = this.rec.state ?? "stopped";
    return {
      ref: this.ref, home: this.h, task: this.id, harness: this.rec.harness, state: s, send: SEND[s], session: this.rec.session,
      since: this.rec.since, turnAt: this.rec.turnAt, parkedAt: this.rec.parkedAt, model: this.rec.model, mode: this.rec.mode,
      pid: this.proc?.pid ?? null, requests: [...this.hist.open.values()], queued: this.queued.map(({ uuid, text, at, from }) => ({ uuid, text, at, from })),
    };
  }

  /** agent.json, the compat record, and a `state` event. */
  persist() {
    this.rec.pid = this.proc?.pid ?? null;
    this.rec.host = process.pid;
    this.rec.at = Date.now();
    writeJson(this.file, this.rec);
    const recFile = this.rec.harness === "codex" ? codexRecordFile(this.h, this.id) : recordFile(this.h, this.id);
    if (this.rec.state === "stopped" || !this.ctl) rmSync(recFile, { force: true });
    else {
      const prompt = [...this.hist.open.values()][0] ?? null;
      const compat = { pid: process.pid, child: this.proc?.pid ?? null, sock: this.ctl, ctl: this.ctl, home: this.h, task: this.id, session: this.rec.session, view: "chat", switching: null, busy: this.rec.state === "running", turnAt: this.rec.turnAt, prompt, at: Date.now(), hosted: true, state: this.rec.state };
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

  /** The stream worker's socket requests (claude/live.mjs send), answered by the host. */
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
      case "switch": return { ok: false, code: "refused", err: "a hosted agent has no terminal view yet" };
      default: return { ok: false, err: `unknown op ${req.op}` };
    }
  }

  /** Writes earlier sessions into the history once, before anything else is appended (`skip`: a session starting fresh). */
  async backfill(skip = null) {
    const t = store.readTask(this.h, this.id);
    if (t) await backfill(this.hist, t, { skip });
  }

  item(item, session = this.rec.session) {
    this.hist.append({ ev: "item", session, item });
    this.streaming.delete(item.id);
    broadcast(this.ref, "item", { item });
  }

  /** Starts the agent's process on its launch file: a new session, or its last one resumed. */
  async start({ prompt = null } = {}) {
    if (this.proc) return { ok: true, agent: this.state(), already: true };
    if (this.starting) return this.starting;
    this.starting = this._start({ prompt }).finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start({ prompt }) {
    const cfg = readJson(launchFile(this.h, this.id));
    if (!cfg?.session || !cfg.bin) return err("not-found", `${this.ref} has no Claude launch file`);
    await this.listen();
    const resume = !!cfg.resume;
    if (!this.hist.exists || !this.hist.hasSession(cfg.session)) await this.backfill(resume ? null : cfg.session);
    this.rec.harness = "claude";
    this.rec.session = cfg.session;
    this.rec.model = cfg.model ?? null;
    this.rec.mode = cfg.mode ?? null;
    this.hist.append({ ev: "session", session: cfg.session, harness: "claude", how: resume ? "resume" : "new" });
    broadcast(this.ref, "session", { session: cfg.session, how: resume ? "resume" : "new" });
    let first = "";
    if (cfg.prompt) { try { first = readFileSync(cfg.prompt, "utf8"); } catch {} }
    writeJson(launchFile(this.h, this.id), { ...cfg, resume: true, prompt: null });
    const envFile = join(this.dir, "host-env.sh");
    this.ending = null;
    this.proc = startClaude({ cfg, resume, envFile, env: childEnv(), on: (e) => this.onEvent(e), log: (l) => log(`${this.ref}: ${l}`) });
    log(`${this.ref}: started ${resume ? "resumed" : "new"} session ${cfg.session} (pid ${this.proc.pid})`);
    this.setState("idle");
    for (const q of this.queued) this.proc.say(q.text, q.attachments ?? [], q.uuid); // words a dead process never took
    if (first.trim()) this.send(first, [], "rollcall");
    if (prompt?.trim()) this.send(prompt, [], "rollcall");
    if (this.queued.length) this.setState("running");
    return { ok: true, agent: this.state() };
  }

  send(text, attachments, from, uuid = randomUUID()) {
    const q = { uuid, text, at: Date.now(), from, attachments };
    this.queued.push(q);
    broadcast(this.ref, "item", { item: { id: uuid, at: q.at, kind: "user", text, images: [], from, queued: true } });
    this.proc.say(text, attachments, uuid);
    if (this.rec.state !== "running") { this.rec.turnAt = Date.now(); this.setState("running"); }
    return uuid;
  }

  async say({ text = "", attachments = [], from = "owner", uuid = null } = {}) {
    text = String(text ?? "");
    attachments = Array.isArray(attachments) ? attachments.filter((p) => typeof p === "string").slice(0, 10) : [];
    if (!text.trim() && !attachments.length) return err("bad-payload", "nothing to say");
    if (this.rec.state === "stopped" && from === "rollcall") return err("refused", `${this.ref} is stopped`);
    let how;
    if (!this.proc) {
      const r = await this.start();
      if (!r.ok) return r;
      how = "resumed";
    } else how = this.rec.state === "running" ? "queued" : "sent";
    const id = this.send(text, attachments, from ?? "owner", typeof uuid === "string" && uuid ? uuid : randomUUID());
    return { ok: true, how, uuid: id };
  }

  async interrupt() {
    if (!this.proc || this.rec.state !== "running") return { ok: true, interrupted: false };
    await this.proc.interrupt().catch(() => null);
    return { ok: true, interrupted: true };
  }

  async set({ model = null, mode = null } = {}) {
    if (mode && !SET_MODES.has(mode)) return err("bad-payload", `mode is one of ${[...SET_MODES].join(", ")}`);
    if (!model && !mode) return err("bad-payload", "set takes a model or a mode");
    const done = {};
    if (model) {
      if (this.proc) { const r = await this.proc.setModel(model).catch((e) => ({ error: e.message })); if (r?.error) return err("failed", r.error); }
      const cfg = readJson(launchFile(this.h, this.id));
      if (cfg) writeJson(launchFile(this.h, this.id), { ...cfg, model });
      this.rec.model = model;
      done.model = model;
    }
    if (mode) {
      if (!this.proc) return err("refused", `${this.ref} is not running: a mode lasts for a running session`);
      const r = await this.proc.setMode(mode).catch((e) => ({ error: e.message }));
      if (r?.error) return err("failed", r.error);
      this.rec.mode = mode;
      done.mode = mode;
    }
    this.persist();
    return { ok: true, set: done };
  }

  closeRequest(id, how, by, answer = null) {
    this.pending.delete(id);
    this.hist.append({ ev: "closed", id, how, by: by ?? null, answer });
    broadcast(this.ref, "closed", { id, how, by: by ?? null });
    if (!this.hist.open.size) rmSync(dialogFlag(this.h, this.id), { force: true });
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
    const answer = { allow: a.allow ?? null, why: a.why ?? null, always: a.always ?? null, mode: a.mode ?? null, answers: a.answers ?? null };
    const p = this.pending.get(id);
    if (p && this.proc) {
      const decision = decisionFor(p.prompt, p.input, a);
      this.closeRequest(id, "answered", by, answer);
      this.proc.respond(p.rid, decision);
      if (req.kind === "plan" && decision.behavior === "allow" && a.mode) void this.proc.setMode(a.mode).catch(() => {});
      this.persist();
      return { ok: true, answered: true, how: "answered" };
    }
    this.closeRequest(id, "words", by, answer);
    const r = await this.say({ text: wordsFor(req, a), from: "owner" });
    if (!r.ok) return r;
    return { ok: true, answered: true, how: "words", delivered: r.how };
  }

  maybePark() {
    if (this.rec.state !== "idle" || !this.proc || this.pending.size || this.queued.length) return false;
    return this.park();
  }

  park() {
    if (!this.proc) {
      if (this.rec.state === "running" || this.rec.state === "idle") this.setState("parked");
      return true;
    }
    if (this.rec.state === "running" || this.pending.size) return false;
    this.ending = "park";
    this.proc.close();
    const p = this.proc;
    setTimeout(() => { if (this.proc === p) p.kill(); }, 10_000).unref();
    return true;
  }

  stop() {
    for (const id of [...this.hist.open.keys()]) this.closeRequest(id, "cancelled", "stop");
    this.queued = [];
    if (!this.proc) { this.setState("stopped"); return true; }
    this.ending = "stop";
    this.proc.close();
    const p = this.proc;
    setTimeout(() => { if (this.proc === p) p.kill(); }, 5_000).unref();
    setTimeout(() => { if (this.proc === p) p.kill("SIGKILL"); }, 10_000).unref();
    return true;
  }

  onEvent(e) {
    switch (e.type) {
      case "init":
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
      case "taken":
        this.queued = this.queued.filter((q) => q.uuid !== e.uuid);
        if (this.rec.state !== "running") { this.rec.turnAt = Date.now(); this.setState("running"); }
        return;
      case "turn-end":
        this.streaming.clear();
        if (e.context) recordContext(this, e.context);
        this.rec.turnAt = this.queued.length ? Date.now() : null;
        this.setState(this.queued.length ? "running" : "idle");
        return;
      case "request": {
        const id = `rq-${hex(6)}`;
        const input = e.req.input && typeof e.req.input === "object" ? e.req.input : {};
        const p = promptOf(e.req, id, { cwd: readJson(launchFile(this.h, this.id))?.cwd ?? null });
        const request = { ...p, ref: this.ref, session: this.rec.session };
        this.pending.set(id, { rid: e.rid, input, prompt: p });
        this.hist.append({ ev: "request", request });
        broadcast(this.ref, "request", { request });
        this.persist();
        return;
      }
      case "cancel": {
        const id = [...this.pending].find(([, v]) => v.rid === e.rid)?.[0];
        if (id) { this.closeRequest(id, "cancelled", null); this.persist(); }
        return;
      }
      case "limits": try { recordClaude(e.limits); } catch {} return;
      case "exit": {
        const how = this.ending;
        this.proc = null;
        this.ending = null;
        this.pending.clear(); // open requests stay open in the history: answered later, they go in as words
        this.streaming.clear();
        rmSync(dialogFlag(this.h, this.id), { force: true });
        log(`${this.ref}: process ended (${how ?? `exit ${e.code}`})`);
        if (how === "stop") { this.setState("stopped"); return; }
        if (how !== "park" && e.code !== 0) {
          this.item({ id: `host-exit:${hex(6)}`, at: Date.now(), kind: "system", text: `Claude Code stopped (exit ${e.code}). A message brings it back.${e.err ? `\n${e.err}` : ""}` });
        }
        this.setState("parked");
        return;
      }
      default:
    }
  }
}

function childEnv() {
  const env = { ...process.env };
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PROJECT_DIR", "CLAUDE_ENV_FILE", "ROLLCALL_SESSION"]) delete env[k];
  return env;
}

function recordContext(a, c) {
  const now = Date.now();
  store.writeHomeFile(a.h, `context-${a.id}`, { pct: c.pct, at: now, session: a.rec.session, tokens: c.tokens, size: c.size });
  import("../supervisor.mjs").then(({ markCap }) => { const t = store.readTask(a.h, a.id); if (t) markCap(t, a.rec.session, c.pct); }).catch(() => {});
}

function parseRef(ref) {
  const m = /^([a-z][a-z0-9-]{0,23}):([A-Za-z0-9._-]+)$/.exec(String(ref ?? ""));
  return m ? { h: m[1], id: m[2] } : null;
}

/** The agent for `ref`, made on first use (nothing starts). */
function agentFor(ref) {
  const r = parseRef(ref);
  if (!r) return null;
  let a = agents.get(`${r.h}:${r.id}`);
  if (!a) {
    if (!store.listHomes().includes(r.h) || !store.readTask(r.h, r.id)) return null;
    a = new Agent(r.h, r.id);
    agents.set(a.ref, a);
  }
  return a;
}

/** Every agent a host ran before, from disk: a process recorded running is gone with that host, so it is parked. */
async function restore() {
  for (const h of store.listHomes()) {
    let ids = [];
    try { ids = readdirSync(join(store.homeDir(h), "workers")); } catch { continue; }
    for (const id of ids) {
      const rec = readJson(join(store.homeDir(h), "workers", id, "agent.json"));
      if (!rec?.state) continue;
      const a = new Agent(h, id);
      agents.set(a.ref, a);
      if (rec.state === "running" || rec.state === "idle") {
        a.item({ id: `host-restart:${hex(6)}`, at: Date.now(), kind: "system", text: "The host restarted, which ended this agent's process. A message brings it back." });
        a.rec.state = "parked";
        a.rec.parkedAt = Date.now();
      }
      if (rec.state !== "stopped") await a.listen();
      a.persist();
    }
  }
}

// ---------------------------------------------------------------- the socket

/** Line-delimited JSON on a connection: each request line gets one answer line (`id` echoed). */
function lineServer(c, handle) {
  let buf = "";
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
      case "hello": return { ok: true, pid: process.pid, version: VERSION, interface: INTERFACE };
      case "list": return { ok: true, agents: [...agents.values()].filter((a) => a.rec.state).map((a) => a.state()) };
      case "state": return { ok: true, agent: need().state() };
      case "start": return await need().start({ prompt: typeof req.prompt === "string" ? req.prompt : null });
      case "say": return await need().say(req);
      case "interrupt": return await need().interrupt();
      case "set": return await need().set(req);
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
        const extra = [...a.streaming.values(), ...a.queued.map((q) => ({ id: q.uuid, at: q.at, kind: "user", text: q.text, images: [], from: q.from, queued: true }))];
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
      case "shutdown": setTimeout(() => shutdown?.(0), 20); return { ok: true };
      default: return err("bad-payload", `no op ${req.op}`);
    }
  } catch (e) {
    return err(e.code ?? "failed", e.message);
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
export async function hostCommand([verb] = []) {
  const { call } = await import("./client.mjs");
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
  if (verb && verb !== "run") { process.stderr.write("usage: rollcall host [run|status|stop]\n"); return 2; }
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
  await restore();
  writeJson(infoFile(), { pid: process.pid, sock, at: Date.now(), version: VERSION });
  log(`host ${process.pid} listens on ${sock} (${agents.size} agents restored)`);

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
