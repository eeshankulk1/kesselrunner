// A hosted crew: a supervisor a front end (cockpit) makes in the agent host, and its tasks, which run there too.
// `rollcall host new` (or the API's `supervisor.new`) makes one; `rollcall host end` (`supervisor.end`) stops it and
// its workers. Its home's `runtime.json` ({ runtime: "host" }) is what makes it hosted (host/client.mjs hostedHome);
// a supervisor falcon or /supervisor starts never has one, and it and its tasks never touch the host.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { isOpen } from "../state.mjs";
import * as store from "../store.mjs";
import { pickName, stopWorker, workerState } from "../supervisor.mjs";
import { startWindow } from "../window.mjs";
import { callSync, hostedHome } from "./client.mjs";

/** Makes home `name` (or the next free ship name) and returns it, or null when `name` is taken. */
function reserve(name) {
  mkdirSync(dirname(store.homeDir(name ?? "x")), { recursive: true });
  for (let tries = 0; tries < 50; tries++) {
    const h = name ?? pickName();
    try { mkdirSync(store.homeDir(h)); return h; } catch (e) { if (e.code !== "EEXIST") throw e; if (name) return null; }
  }
  return null;
}

/**
 * A new hosted supervisor working in `cwd`: its home (named `name`, else the next free ship name), recorded as
 * hosted, and its first session started in the host on `/supervisor <h>`. Returns { ok, home, session, runtime } or
 * { ok: false, code, err }.
 */
export function newCrew({ cwd = process.cwd(), name = null } = {}) {
  if (name !== null && !store.HOME_NAME.test(String(name))) return { ok: false, code: "bad-payload", err: `name is a supervisor name like falcon: ${name}` };
  try { if (!statSync(cwd).isDirectory()) throw new Error(); } catch { return { ok: false, code: "bad-payload", err: `no such folder: ${cwd}` }; }
  const h = reserve(name);
  if (!h) return { ok: false, code: "refused", err: name ? `${name} is taken` : "could not find a free supervisor name" };
  store.writeHomeFile(h, "runtime", { runtime: "host", at: Date.now() });
  const session = randomUUID();
  const r = startWindow(h, { session, cwd, resume: false });
  if (!r.ok) return { ok: false, code: "failed", err: r.err ?? "the agent host did not start it", home: h };
  return { ok: true, home: h, session, runtime: "host" };
}

/**
 * Ends hosted supervisor `h`: its open tasks' workers stop, then its own session (all saved: the owner's words to it,
 * or a task resumed, bring them back). Returns { ok, stopped: [refs] } or { ok: false, code, err }.
 */
export function endCrew(h) {
  if (!existsSync(store.homeDir(h)) || !hostedHome(h)) return { ok: false, code: "not-found", err: `${h} is not a hosted supervisor` };
  const stopped = [];
  for (const t of store.listTasks(h)) {
    if (!isOpen(t) || !t.sessions?.length) continue;
    const w = workerState(t);
    if (w?.alive && stopWorker(t)) stopped.push(`${h}:${t.id}`);
  }
  const r = callSync("stop", { ref: h });
  if (r.ok) stopped.push(h);
  return { ok: true, stopped };
}

/** `rollcall host new [--cwd <dir>] [--name <h>]` and `rollcall host end <h>`: one JSON line out. */
export function crewCommand(verb, args) {
  const opt = (n) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
  const r = verb === "new" ? newCrew({ cwd: opt("--cwd") ?? process.cwd(), name: opt("--name") ?? null }) : endCrew(args[0]);
  const out = r.ok ? r : { ok: false, error: { code: r.code, message: r.err }, ...(r.home ? { home: r.home } : {}) };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return r.ok ? 0 : 1;
}
