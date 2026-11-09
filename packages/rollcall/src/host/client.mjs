// Reaching the agent host (host/server.mjs) from any rollcall process: where it lives, starting it on demand
// (detached, so it outlives whoever started it), one call, a subscription, and a synchronous call through the one-shot
// `rollcall _host-call` for the synchronous callers (supervisor.mjs launch).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dialogFlag } from "../delivery.mjs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidAlive } from "../proc.mjs";
import { BIN } from "../session.mjs";
import * as store from "../store.mjs";

export const hostDir = () => join(store.home(), "_host");
export const lockFile = () => join(hostDir(), "host.lock");
export const infoFile = () => join(hostDir(), "host.json");
export const logFile = () => join(hostDir(), "host.log");
/** The host's socket: one per store, in the temp folder (a unix socket path is short on macOS). */
export const socketFor = (root) => join(tmpdir(), `rollcall-host-${createHash("sha256").update(root).digest("hex").slice(0, 8)}.sock`);
export const socketPath = () => socketFor(store.home());
/** ROLLCALL_HOST=1: new task workers start in the host instead of a tmux window (off by default during the build). */
export const hostOn = () => store.envFlag("ROLLCALL_HOST") === true;

const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
/** The running host's { pid, sock, at, version }, or null. */
export function hostInfo() {
  const i = readJson(infoFile());
  return i && pidAlive(i.pid) ? i : null;
}

/** A connection to the host: call(op, payload) resolves with its answer; events go to `onEvent`. */
export function connect({ onEvent = null, timeoutMs = 3000, sock = socketPath() } = {}) {
  return new Promise((resolve, reject) => {
    const c = createConnection(sock);
    const waiting = new Map();
    let n = 0;
    let buf = "";
    const timer = setTimeout(() => { c.destroy(); reject(new Error("the host did not answer")); }, timeoutMs);
    c.on("connect", () => {
      clearTimeout(timer);
      resolve({
        call(op, payload = {}, ms = 30_000) {
          return new Promise((ok, fail) => {
            const id = ++n;
            const t = setTimeout(() => { waiting.delete(id); fail(new Error(`the host did not answer ${op}`)); }, ms);
            waiting.set(id, (r) => { clearTimeout(t); ok(r); });
            c.write(`${JSON.stringify({ ...payload, id, op })}\n`);
          });
        },
        close() { try { c.end(); } catch {} },
        socket: c,
      });
    });
    c.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === "event") { onEvent?.(m); continue; }
        const w = waiting.get(m.id);
        if (w) { waiting.delete(m.id); w(m); }
      }
    });
    c.on("error", (e) => { clearTimeout(timer); reject(e); for (const w of waiting.values()) w({ ok: false, error: { code: "failed", message: e.message } }); waiting.clear(); });
    c.on("close", () => { for (const w of waiting.values()) w({ ok: false, error: { code: "failed", message: "the host closed the connection" } }); waiting.clear(); onEvent?.({ type: "closed" }); });
  });
}

/** Starts the host detached, its output to its log. */
export function spawnHost(env = process.env) {
  mkdirSync(hostDir(), { recursive: true });
  const fd = openSync(logFile(), "a");
  const p = spawn(process.execPath, [BIN, "host"], { detached: true, stdio: ["ignore", fd, fd], env, cwd: hostDir() });
  closeSync(fd);
  p.unref();
  return p.pid;
}

/** A connection to the host, started first when none answers. */
export async function ensureHost({ onEvent = null, waitMs = 10_000 } = {}) {
  try { return await connect({ onEvent }); } catch {}
  spawnHost();
  const until = Date.now() + waitMs;
  let last = null;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
    try { return await connect({ onEvent }); } catch (e) { last = e; }
  }
  throw new Error(`the host did not start: ${last?.message ?? "no answer"} (see ${logFile()})`);
}

/** One call, starting the host when needed: the answer, or { ok: false, error }. */
export async function call(op, payload = {}, { start = true } = {}) {
  let c;
  try { c = start ? await ensureHost() : await connect(); } catch (e) { return { ok: false, error: { code: "failed", message: e.message } }; }
  try { return await c.call(op, payload); } finally { c.close(); }
}

/** call() for a synchronous caller, through `rollcall _host-call` (stdin: { op, ...payload }). */
export function callSync(op, payload = {}, { timeoutMs = 60_000 } = {}) {
  const out = spawnSync(process.execPath, [BIN, "_host-call"], { encoding: "utf8", input: JSON.stringify({ ...payload, op }), timeout: timeoutMs });
  try { return JSON.parse(String(out.stdout).trim().split("\n").at(-1)); } catch {
    return { ok: false, error: { code: "failed", message: (out.stderr || "the host did not answer").trim().split("\n").at(-1) } };
  }
}

/** `rollcall _host-call` (stdin: one JSON call): prints the host's answer. */
export async function hostCall() {
  let req;
  try { req = JSON.parse(readFileSync(0, "utf8")); } catch { process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "bad-payload", message: "the call is not JSON" } })}\n`); return 2; }
  const { op, ...payload } = req;
  const r = await call(op, payload);
  process.stdout.write(`${JSON.stringify(r)}\n`);
  return r.ok ? 0 : 1;
}

/** The host's record of agent `h:id` (agent.json), as any process may read it, or null. */
export function agentRecord(h, id) {
  return readJson(join(store.workerDir(h, id ?? h), "agent.json"));
}

const END_POLL_MS = 300;

/**
 * Whether the CLI in a terminal is in a turn, by its task's status log (the launch settings' hooks write it): a turn
 * that started after `since` (when the terminal opened) with no end after it. A dialog open in the turn (a permission prompt, a question) counts
 * as no turn: nobody sees the terminal to answer it, and the session resumes past it. A supervisor's session and a
 * Codex thread write no such log, so they never count as in a turn.
 */
export function midTurn(agent, since) {
  if (!agent?.task || agent.harness === "codex") return false;
  if (existsSync(dialogFlag(agent.home, agent.task))) return false;
  const last = store.readStatus(agent.home, agent.task).filter((e) => (e.at ?? 0) >= since && ["busy", "idle", "exit"].includes(e.ev)).at(-1);
  return last?.ev === "busy";
}

/**
 * `rollcall open <ref>`: the terminal escape hatch. The real CLI on the agent's own session (`claude --resume`, `codex
 * resume`), in this terminal. The host ends its process first and shows the agent as `terminal` while this runs; when
 * the CLI exits, the host reads what the session added into the history, and words held meanwhile wake the agent.
 * When the host restarted meanwhile, the one running now hears it (and watches this process until then).
 */
export async function openCommand([ref] = [], { say = (s) => process.stderr.write(`${s}\n`) } = {}) {
  if (!ref || ref.startsWith("-")) { say("usage: rollcall open <supervisor>[:<task>]"); return 2; }
  let c;
  try { c = await ensureHost(); } catch (e) { say(`rollcall: ${e.message}`); return 1; }
  try {
    // Its pid lets a host that restarts meanwhile watch for the end of this command (it waits on the CLI).
    const r = await c.call("terminal", { ref, pid: process.pid });
    if (!r.ok) { say(`rollcall: ${r.error?.message ?? "the host did not open it"}`); return 1; }
    const env = { ...process.env };
    for (const k of [...(r.unset ?? []), "ROLLCALL_TASK"]) delete env[k];
    // Ctrl-C belongs to the CLI: this process only waits for it.
    const quiet = () => {};
    process.on("SIGINT", quiet);
    let child = null;
    let ending = null;
    const spawnedAt = Date.now();
    // SIGTERM (the host's `terminal-end`: a front end is done with this terminal) ends the CLI once no turn runs.
    const end = () => {
      if (ending) return;
      const opened = r.agent?.terminal?.at ?? spawnedAt;
      let told = false;
      ending = setInterval(() => {
        if (!child || child.exitCode !== null) return;
        if (midTurn(r.agent, opened)) {
          if (!told) say("\r\nrollcall: this terminal closes when the turn ends; the chat carries on from there.\r");
          told = true;
          return;
        }
        clearInterval(ending);
        child.kill("SIGTERM");
      }, END_POLL_MS);
    };
    process.on("SIGTERM", end);
    const code = await new Promise((resolve) => {
      child = spawn(r.argv[0], r.argv.slice(1), { cwd: r.cwd ?? undefined, stdio: "inherit", env });
      child.on("error", (e) => { say(`rollcall: ${e.message}`); resolve(1); });
      child.on("exit", (n, sig) => resolve(n ?? (sig ? 1 : 0)));
    });
    clearInterval(ending);
    process.off("SIGTERM", end);
    process.off("SIGINT", quiet);
    // The host that opened it may have restarted meanwhile: the one running now reads the terminal's turns.
    let done = c.socket.destroyed ? { ok: false } : await c.call("terminal-done", { ref });
    if (!done.ok && c.socket.destroyed) done = await call("terminal-done", { ref });
    if (done.ok && done.added) say(`rollcall: ${done.added} item${done.added === 1 ? "" : "s"} from the terminal joined ${ref}'s chat`);
    return code;
  } finally { c.close(); }
}
