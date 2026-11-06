// A checkout's runtime facts, read-only: what every hook may need (a worker's launch lines, a wake's setup line, the
// spotlights to follow) without loading the code that changes anything. Nothing here spawns a process or takes a
// lock, so it costs a hook almost nothing; runtime.mjs builds the rest (port hand-out, setup, run actions, snapshots)
// on top of it and loads only for the commands that use it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { uptime } from "node:os";
import { join, sep } from "node:path";
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

/** Whether `path` is `top` or inside it. */
export const inside = (path, top) => !!path && !!top && (real(path) === real(top) || real(path).startsWith(real(top) + sep));

// ---------------------------------------------------------------- run actions and a task's runtime, read

/** The last `n` lines of a file. */
export function lastLines(path, n) {
  try { return readFileSync(path, "utf8").trimEnd().split("\n").slice(-n); } catch { return []; }
}

/** One line on a setup state, for `task show` and `rollcall setup`. */
export function setupLine(s, now = Date.now()) {
  if (!s) return null;
  const what = [s.copied?.length ? `copied ${s.copied.length} file${s.copied.length === 1 ? "" : "s"} from .worktreeinclude` : null, s.cmd ? `ran \`${s.cmd}\`` : null].filter(Boolean).join(", then ") || "nothing to run";
  if (s.state === "running") return `setup running for ${Math.max(1, Math.round((now - s.at) / 60_000))}m (${s.cmd ? `\`${s.cmd}\`` : "copying files"}); log: ${s.log}`;
  if (s.state === "done") return `setup done: ${what}`;
  return `setup FAILED${s.exit !== null && s.exit !== undefined ? ` (exit ${s.exit})` : ""}: ${store.clip(store.oneLine(s.last ?? ""), 200) || "no output"}; log: ${s.log}`;
}

export const actionsDir = (top) => join(runtimeDir(top), "actions");
export const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/**
 * The checkout's run actions, from its manifest with ports filled in: [{ name, command, dir, url, port }]. The
 * manifest's `run` map names them; without one, `devServer.command` is `dev` and `backend.startCommand` is `backend`.
 */
export function actionsOf(f) {
  const m = f.manifest ? fillPorts(f.manifest, f.base) : null;
  if (!m) return [];
  const out = [];
  const add = (name, a) => {
    if (!NAME.test(name) || !a || typeof a.command !== "string" || !a.command.trim()) return;
    out.push({ name, command: a.command.trim(), dir: typeof a.dir === "string" ? a.dir : ".", url: typeof a.url === "string" ? a.url : null, port: Number(a.port) > 0 ? Number(a.port) : portIn(a.url) });
  };
  if (m.run && typeof m.run === "object") for (const [name, a] of Object.entries(m.run)) add(name, a);
  else {
    if (m.devServer?.command) add("dev", { command: m.devServer.command, url: m.devServer.baseUrl ?? (m.devServer.port ? `http://localhost:${m.devServer.port}` : null), port: m.devServer.port });
    if (m.backend?.startCommand) add("backend", { command: m.backend.startCommand, url: m.backend.baseUrl });
  }
  return out;
}

const portIn = (url) => { try { const p = Number(new URL(url).port); return p > 0 ? p : null; } catch { return null; } };

/** Whether process group `pgid` still has a process in it. */
export function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** What was started for action `name` in the checkout, with whether it still runs: { ...record, running } or null. */
export function actionState(top, name) {
  const rec = readJson(join(actionsDir(top), `${name}.json`));
  if (!rec) return null;
  // A group started before this boot is gone, whatever holds its id now.
  const booted = Date.now() - uptime() * 1000 - 5000;
  return { ...rec, running: rec.at >= booted && groupAlive(rec.pid) };
}

/** Every action of the checkout: the manifest's, plus any started that the manifest no longer names. */
export function listActions(f) {
  const named = actionsOf(f);
  let started = [];
  try { started = readdirSync(actionsDir(f.top)).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)); } catch {}
  const names = [...new Set([...named.map((a) => a.name), ...started])];
  return names.map((name) => {
    const a = named.find((x) => x.name === name) ?? null;
    const s = actionState(f.top, name);
    return { name, command: s?.running ? s.command : a?.command ?? s?.command ?? null, url: s?.running ? s.url : a?.url ?? null, port: s?.running ? s.port ?? null : a?.port ?? null, running: !!s?.running, pid: s?.running ? s.pid : null, since: s?.running ? s.at : null, log: s?.log ?? join(actionsDir(f.top), `${name}.log`), inManifest: !!a };
  });
}

/**
 * Task `t`'s runtime as front ends draw it: { ports: { base, last } | null, setup, actions: [{ name, url, running, log,
 * since }], previews: [url], spotlit, archived }. Null for a task with no worktree of its own.
 */
export function runtimeOf(t) {
  if (!t?.branch || !t.repo?.key) return null;
  const spot = spotlightOf(t.repo.main);
  const spotlit = spot?.task?.home === t.home && spot?.task?.id === t.id ? { since: spot.at, mirroredAt: spot.mirrored?.at ?? null } : null;
  if (t.archived || !existsSync(t.worktree)) return { ports: null, setup: null, actions: [], previews: [], spotlit, archived: t.archived ?? null };
  const f = factsOf(t.worktree);
  const actions = f ? listActions(f).map(({ name, url, running, log, since, port }) => ({ name, url, port, running, log, since })) : [];
  return {
    ports: f?.ports ? { base: f.ports.base, last: f.ports.last } : null,
    setup: setupState(t.worktree),
    actions,
    previews: actions.filter((a) => a.running && a.url).map((a) => a.url),
    spotlit,
    archived: null,
  };
}

/** The lines `task show` prints for a task's runtime (none when there is nothing to say). */
export function runtimeLines(t, rt, now = Date.now()) {
  if (!rt) return [];
  const out = [];
  if (rt.archived) out.push(`archived ${new Date(rt.archived.at).toISOString()}: worktree removed, ${rt.archived.files ? `${rt.archived.files} uncommitted file${rt.archived.files === 1 ? "" : "s"} saved` : "nothing uncommitted"} (${rt.archived.ref}); bring it back: rollcall task restore ${t.id}`);
  if (rt.ports) out.push(`ports ${rt.ports.base}-${rt.ports.last} (ROLLCALL_PORT=${rt.ports.base})`);
  const s = setupLine(rt.setup, now);
  if (s) out.push(s + (rt.setup?.state === "failed" ? `; rerun: rollcall task setup ${t.id} --rerun` : ""));
  for (const a of rt.actions) out.push(`run ${a.name}: ${a.running ? `running${a.url ? ` at ${a.url}` : ""}` : "stopped"} (log: ${a.log})`);
  if (rt.spotlit) out.push(`spotlit: the main checkout runs this task's files (rollcall task spotlight ${t.id} --off puts it back)`);
  return out;
}
