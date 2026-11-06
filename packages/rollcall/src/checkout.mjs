// A checkout's runtime facts, read-only: what every hook may need (a worker's launch lines, a wake's setup line, the
// spotlights to follow) without loading the code that changes anything. Nothing here spawns a process or takes a
// lock, so it costs a hook almost nothing; runtime.mjs builds the rest (port hand-out, setup, run actions, snapshots)
// on top of it and loads only for the commands that use it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { defaultBranch, locate, mainCheckout } from "./git.mjs";
import { pidAlive } from "./proc.mjs";
import * as store from "./store.mjs";

export const real = (p) => { try { return realpathSync(p); } catch { return p; } };
export const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

export const num = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : dflt; };

export const runtimeRoot = () => join(store.home(), "_runtime");

/** A checkout's own folder in the store, by its path. */
export const keyOf = (path) => createHash("sha1").update(real(path)).digest("hex").slice(0, 16);

export const runtimeDir = (path) => join(runtimeRoot(), keyOf(path));

/** The range blocks come from and a block's size: ROLLCALL_PORT_MIN / _MAX / _BLOCK. */
export const portRange = () => ({ min: num("ROLLCALL_PORT_MIN", 41000), max: num("ROLLCALL_PORT_MAX", 48999), size: num("ROLLCALL_PORT_BLOCK", 10) });
export const portsPath = () => join(runtimeRoot(), "ports.json");
export const readBlocks = () => readJson(portsPath())?.blocks ?? [];

/** The test manifest of the checkout at `top`, raw, or null. */
export function manifestOf(top) {
  return readJson(join(top, ".claude", "test-manifest.json"));
}

export const PORT_REF = /\{port(?:\s*\+\s*(\d+))?\}/g;
export const usesPorts = (m) => /\{port(?:\s*\+\s*\d+)?\}/.test(JSON.stringify(m ?? {}));

/** `value` with every `{port}` and `{port+N}` filled in from `base` (left as written when there is none). */
export function fillPorts(value, base) {
  if (base === null || base === undefined) return value;
  if (typeof value === "string") return value.replace(PORT_REF, (_, n) => String(base + Number(n ?? 0)));
  if (Array.isArray(value)) return value.map((v) => fillPorts(v, base));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillPorts(v, base)]));
  return value;
}

/**
 * The environment a checkout's setup, teardown, run actions and worker get: who it is and where. `task` is its
 * task record when it has one. ROLLCALL_TASK itself stays the worker's alone (it makes rollcall's commands act as
 * that worker).
 */
export function checkoutEnv(f, task = null) {
  const env = {
    ROLLCALL_WORKTREE: f.top,
    ROLLCALL_MAIN_CHECKOUT: f.main,
  };
  const b = f.info && defaultBranch(f.info);
  if (b) env.ROLLCALL_DEFAULT_BRANCH = b;
  if (f.base !== null && f.base !== undefined) env.ROLLCALL_PORT = String(f.base);
  if (f.ports) env.ROLLCALL_PORT_COUNT = String(f.ports.size);
  if (task) Object.assign(env, { ROLLCALL_TASK_ID: task.id, ROLLCALL_TASK_HOME: task.home, ROLLCALL_TASK_NAME: task.name ?? task.id });
  return env;
}

export const setupPath = (top) => join(runtimeDir(top), "setup.json");
export const setupLog = (top) => join(runtimeDir(top), "setup.log");

/**
 * The checkout's last setup: { state: running|done|failed, cmd, copied, exit, at, endedAt, log, last } or null when
 * none ran. A run whose process is gone without a word is failed ("stopped").
 */
export function setupState(top) {
  const s = readJson(setupPath(top));
  if (!s) return null;
  // pid is null for the moment between startSetup writing the record and the background run writing its own.
  const gone = s.pid ? !pidAlive(s.pid, s.start) : Date.now() - s.at > 60_000;
  if (s.state === "running" && gone) return { ...s, state: "failed", exit: null, last: "it stopped before it finished (the machine slept or restarted, or it was killed)" };
  return s;
}

export const spotDir = () => join(runtimeRoot(), "spotlight");
/** The spotlight file of the repo whose main checkout is `main`. */
export const spotlightPath = (main) => join(spotDir(), `${keyOf(main)}.json`);
/** The repo's spotlight: { main, worktree, task: { home, id }, before: { branch, head }, mirrored: { tree, at } } or null. */
export const spotlightOf = (main) => readJson(spotlightPath(main));
/** Every spotlight on the machine. */
export function allSpotlights() {
  try { return readdirSync(spotDir()).filter((n) => n.endsWith(".json")).map((n) => readJson(join(spotDir(), n))).filter(Boolean); } catch { return []; }
}

export const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * The shell lines a worker's launch script runs before it starts the harness: the checkout's environment, and a wait
 * for a setup still running, so the worker's first turn finds its worktree ready. `bin` is rollcall's own script.
 */
export function launchLines(t, bin) {
  if (!t.branch || !t.repo?.key || !existsSync(t.worktree)) return [];
  const f = factsOf(t.worktree);
  if (!f) return [];
  const env = checkoutEnv(f, t);
  return [
    ...Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`),
    // Only where a setup ran here: every other launch skips a node start.
    `[ -e ${q(setupPath(t.worktree))} ] && { ${q(process.execPath)} ${q(bin)} -C ${q(t.worktree)} setup --wait --quiet || true; }`,
  ];
}

/** The block of ports checkout `path` holds now ({ base, size, last }), or null: a read, no lock (a write is one rename). */
export function heldPorts(path) {
  const p = real(path);
  const b = readBlocks().find((x) => x.path === p);
  return b ? { base: b.base, size: b.size, last: b.base + b.size - 1 } : null;
}

/**
 * The checkout's facts as they stand, handing nothing out: { top, main, isMain, info, manifest, ports, base }. `base`
 * is the number `{port}` stands for: the main checkout's manifest `ports.default` when it names one (an OAuth
 * callback registered on one URL keeps working there), else the checkout's own block.
 */
export function factsOf(dir) {
  const info = locate(dir);
  if (!info) return null;
  const top = info.top;
  const main = mainCheckout(info);
  const isMain = real(top) === real(main);
  const manifest = manifestOf(top);
  const dflt = Number(manifest?.ports?.default);
  const ports = heldPorts(top);
  const base = isMain && dflt > 0 ? dflt : ports?.base ?? null;
  return { top, main, isMain, info, manifest, ports, base, dflt: dflt > 0 ? dflt : null };
}
