// A checkout's runtime: what makes a worktree run on its own, without a person finishing it by hand. A block
// of ports of its own, the gitignored files `.worktreeinclude` names copied in from the main checkout, the
// test manifest's worktree.setup run before its worker's first turn, and run actions (a dev server, a backend)
// started as process groups with a log each. Everything is kept per checkout under _runtime/ in rollcall's
// store, so a task's worktree and a worktree a person made by hand work the same; `task show --json` carries a
// task's. rollcall stays daemonless: a run action is an ordinary process group whose state is read when asked.
//
//   _runtime/ports.json                  { blocks: [{ base, size, path, at }] }: one block per checkout
//   _runtime/<key>/setup.json, setup.log   the last setup run: { state, pid, start, at, endedAt, exit, cmd, log }
//   _runtime/<key>/actions/<name>.json     a run action that was started: { pid, start, at, command, dir, url, log }
//   _runtime/<key>/actions/<name>.log      its output
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { defaultBranch, gitSync, locate, mainCheckout } from "./git.mjs";
import { pidAlive, startOf } from "./proc.mjs";
import * as store from "./store.mjs";

const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(`${p}.${process.pid}.tmp`, JSON.stringify(v)); renameSync(`${p}.${process.pid}.tmp`, p); };
const num = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : dflt; };

export const runtimeRoot = () => join(store.home(), "_runtime");
/** A checkout's own folder in the store, by its path. */
export const keyOf = (path) => createHash("sha1").update(real(path)).digest("hex").slice(0, 16);
export const runtimeDir = (path) => join(runtimeRoot(), keyOf(path));

// ---------------------------------------------------------------- ports

/** The range blocks come from and a block's size: ROLLCALL_PORT_MIN / _MAX / _BLOCK. */
export const portRange = () => ({ min: num("ROLLCALL_PORT_MIN", 41000), max: num("ROLLCALL_PORT_MAX", 48999), size: num("ROLLCALL_PORT_BLOCK", 10) });
const portsPath = () => join(runtimeRoot(), "ports.json");
const readBlocks = () => readJson(portsPath())?.blocks ?? [];

/** Whether ports base..base+size-1 are all free to listen on now (a child node binds each, on every interface and on 127.0.0.1). */
export function portsFree(base, size) {
  const script = `const net=require("net");const ports=${JSON.stringify(Array.from({ length: size }, (_, i) => base + i))};
const tryOn=(p,host)=>new Promise((ok)=>{const s=net.createServer();s.once("error",(e)=>ok(e.code==="EADDRNOTAVAIL"||e.code==="EAFNOSUPPORT"));s.listen({port:p,host,exclusive:true},()=>s.close(()=>ok(true)));});
(async()=>{for(const p of ports){if(!(await tryOn(p))||!(await tryOn(p,"127.0.0.1"))||!(await tryOn(p,"::1")))process.exit(1);}process.exit(0);})();`;
  return spawnSync(process.execPath, ["-e", script], { stdio: "ignore", timeout: 10_000 }).status === 0;
}

/**
 * The block of ports checkout `path` holds: { base, size, last } or null. With `allocate`, one is handed out when it
 * holds none: the lowest block in range that no checkout holds and whose ports are all free now. A block whose checkout
 * is gone goes back to the pool first.
 */
export function portsFor(path, { allocate = false } = {}) {
  const p = real(path);
  const r = store.withRuntimeLock(() => {
    const kept = readBlocks().filter((b) => existsSync(b.path));
    const own = kept.find((b) => b.path === p);
    if (own || !allocate) { if (kept.length !== readBlocks().length) writeJson(portsPath(), { blocks: kept }); return own ?? null; }
    const { min, max, size } = portRange();
    const taken = new Set(kept.map((b) => b.base));
    for (let base = min; base + size - 1 <= max; base += size) {
      if (taken.has(base) || !portsFree(base, size)) continue;
      const b = { base, size, path: p, at: Date.now() };
      writeJson(portsPath(), { blocks: [...kept, b] });
      return b;
    }
    writeJson(portsPath(), { blocks: kept });
    return null;
  });
  const b = r?.out ?? null;
  return b ? { base: b.base, size: b.size, last: b.base + b.size - 1 } : null;
}

/** Gives checkout `path`'s block back (its worktree went: gc, archive). */
export function releasePorts(path) {
  const p = real(path);
  store.withRuntimeLock(() => {
    const blocks = readBlocks();
    const kept = blocks.filter((b) => b.path !== p && b.path !== path);
    if (kept.length !== blocks.length) writeJson(portsPath(), { blocks: kept });
  });
}

// ---------------------------------------------------------------- the manifest, with this checkout's ports

/** The test manifest of the checkout at `top`, raw, or null. */
export function manifestOf(top) {
  return readJson(join(top, ".claude", "test-manifest.json"));
}

const PORT_REF = /\{port(?:\s*\+\s*(\d+))?\}/g;
const usesPorts = (m) => /\{port(?:\s*\+\s*\d+)?\}/.test(JSON.stringify(m ?? {}));

/**
 * The checkout's facts for its manifest and run actions: { top, main, isMain, ports, base }. `base` is the number
 * `{port}` stands for: the main checkout's manifest `ports.default` when it names one (an OAuth callback registered
 * on one URL keeps working there), else the checkout's own block, handed out when the manifest uses `{port}` and
 * `allocate` says so (or always, with "always").
 */
export function checkoutFacts(dir, { allocate = true } = {}) {
  const info = locate(dir);
  if (!info) return null;
  const top = info.top;
  const main = mainCheckout(info);
  const isMain = real(top) === real(main);
  const m = manifestOf(top);
  const dflt = Number(m?.ports?.default);
  // A block is handed out when the manifest uses {port}, or on an explicit ask (`allocate: "always"`, rollcall ports);
  // the main checkout keeps the manifest's ports.default when it names one.
  let ports = portsFor(top);
  const wanted = allocate === "always" || (allocate && usesPorts(m));
  if (!ports && wanted && !(isMain && dflt > 0)) ports = portsFor(top, { allocate: true });
  const base = isMain && dflt > 0 ? dflt : ports?.base ?? null;
  return { top, main, isMain, info, manifest: m, ports, base };
}

/** `value` with every `{port}` and `{port+N}` filled in from `base` (left as written when there is none). */
export function fillPorts(value, base) {
  if (base === null || base === undefined) return value;
  if (typeof value === "string") return value.replace(PORT_REF, (_, n) => String(base + Number(n ?? 0)));
  if (Array.isArray(value)) return value.map((v) => fillPorts(v, base));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillPorts(v, base)]));
  return value;
}

/** The manifest of the checkout holding `dir` with its ports filled in, or null with none. */
export function resolvedManifest(dir) {
  const f = checkoutFacts(dir);
  if (!f?.manifest) return null;
  return fillPorts(f.manifest, f.base);
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

// ---------------------------------------------------------------- .worktreeinclude

/**
 * Copies into worktree `top` the gitignored files and folders of the main checkout `main` that its
 * `.worktreeinclude` names (gitignore syntax, the format Claude Code reads for its own worktrees). A file that is
 * already there stays. Returns the paths copied, relative.
 */
export function copyIncludes(main, top) {
  const list = join(main, ".worktreeinclude");
  if (!existsSync(list) || real(main) === real(top)) return [];
  const named = gitSync(main, ["ls-files", "--others", "--ignored", "--directory", "--no-empty-directory", `--exclude-from=${list}`]);
  const paths = (named.stdout ?? "").split("\n").filter(Boolean);
  if (!paths.length) return [];
  // Only what git ignores: a tracked or plain untracked file comes with the checkout or is not the main checkout's to give.
  const ignored = gitSync(main, ["check-ignore", "--stdin"], { input: paths.join("\n"), stdio: ["pipe", "pipe", "pipe"] });
  const copied = [];
  for (const rel of (ignored.stdout ?? "").split("\n").filter(Boolean)) {
    const from = join(main, rel);
    const to = join(top, rel);
    if (existsSync(to.replace(/\/$/, ""))) continue;
    try {
      mkdirSync(dirname(to.replace(/\/$/, "")), { recursive: true });
      if (statSync(from).isDirectory()) cpSync(from, to, { recursive: true, preserveTimestamps: true });
      else copyFileSync(from, to);
      copied.push(rel);
    } catch {}
  }
  return copied;
}

// ---------------------------------------------------------------- setup

const setupPath = (top) => join(runtimeDir(top), "setup.json");
export const setupLog = (top) => join(runtimeDir(top), "setup.log");
const setupMs = () => num("ROLLCALL_SETUP_MINUTES", 30) * 60_000;

/** The manifest's worktree.setup command for `top`, or null. */
export function setupCommand(top) {
  const cmd = manifestOf(top)?.worktree?.setup;
  return typeof cmd === "string" && cmd.trim() ? cmd.trim() : null;
}

/**
 * The checkout's last setup: { state: running|done|failed, cmd, copied, exit, at, endedAt, log, last } or null when
 * none ran. A run whose process is gone without a word is failed ("stopped").
 */
export function setupState(top) {
  const s = readJson(setupPath(top));
  if (!s) return null;
  if (s.state === "running" && !pidAlive(s.pid, s.start)) return { ...s, state: "failed", exit: null, last: "it stopped before it finished (the machine slept or restarted, or it was killed)" };
  return s;
}

/**
 * Starts the checkout's setup in the background: `rollcall _setup <top>` copies the `.worktreeinclude` files, then runs
 * worktree.setup with no stdin and its output in the log. `skipCommand`: copy only (a discussion task). Returns its
 * state, or null when there is nothing to run.
 */
export function startSetup(top, { bin, skipCommand = false, env = {} } = {}) {
  const cmd = skipCommand ? null : setupCommand(top);
  const main = mainCheckout(locate(top));
  if (!cmd && !existsSync(join(main, ".worktreeinclude"))) return null;
  const now = Date.now();
  mkdirSync(runtimeDir(top), { recursive: true });
  writeFileSync(setupLog(top), "");
  writeJson(setupPath(top), { state: "running", pid: null, start: null, at: now, cmd, copied: [], log: setupLog(top) });
  const child = spawn(process.execPath, [bin, "_setup", top, ...(skipCommand ? ["--copy-only"] : [])], {
    detached: true, stdio: "ignore", env: { ...process.env, ...env },
  });
  child.on("error", () => {});
  child.unref();
  const s = { state: "running", pid: child.pid, start: startOf(child.pid), at: now, cmd, copied: [], log: setupLog(top) };
  writeJson(setupPath(top), s);
  return s;
}

/**
 * The background half of startSetup (`rollcall _setup <top>`): runs the steps, writes the state as they end, and
 * returns it. `onFail(state)` hears a failed run (its task's supervisor is told once).
 */
export function runSetup(top, { copyOnly = false, env = {}, onFail = () => {} } = {}) {
  const log = setupLog(top);
  const prev = readJson(setupPath(top)) ?? {};
  const base = { ...prev, pid: process.pid, start: startOf(process.pid), log };
  const say = (line) => { try { writeFileSync(log, `${line}\n`, { flag: "a" }); } catch {} };
  writeJson(setupPath(top), { ...base, state: "running" });
  const main = mainCheckout(locate(top));
  const copied = copyIncludes(main, top);
  say(copied.length ? `rollcall: copied from ${main} (.worktreeinclude): ${copied.join(", ")}` : `rollcall: nothing to copy from ${main}${existsSync(join(main, ".worktreeinclude")) ? " (.worktreeinclude names nothing there that is missing here)" : ""}`);
  const cmd = copyOnly ? null : setupCommand(top);
  if (!cmd) {
    const s = { ...base, state: "done", cmd: null, copied, exit: 0, endedAt: Date.now() };
    writeJson(setupPath(top), s);
    return s;
  }
  say(`rollcall: running ${cmd} (no input; stopped after ${Math.round(setupMs() / 60_000)} minutes)`);
  const fd = openSync(log, "a");
  const r = spawnSync("sh", ["-c", cmd], { cwd: top, stdio: ["ignore", fd, fd], timeout: setupMs(), killSignal: "SIGKILL", env: { ...process.env, ...env } });
  closeSync(fd);
  const timedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL";
  const ok = r.status === 0;
  const tail = lastLines(log, 1)[0] ?? "";
  say(ok ? "rollcall: setup done" : `rollcall: setup failed (${timedOut ? "it ran past its time limit" : r.signal ? `stopped by ${r.signal}` : `exit ${r.status}`})`);
  const s = { ...base, state: ok ? "done" : "failed", cmd, copied, exit: r.status, endedAt: Date.now(), ...(ok ? {} : { last: timedOut ? `it ran past ${Math.round(setupMs() / 60_000)} minutes (a prompt waiting for input?)` : tail }) };
  writeJson(setupPath(top), s);
  if (!ok) onFail(s);
  return s;
}

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

// ---------------------------------------------------------------- run actions

const actionsDir = (top) => join(runtimeDir(top), "actions");
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

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
function groupAlive(pgid) {
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

/** Starts action `a` of the checkout as its own process group, output to its log. Returns { ok, err, state }. */
export function startAction(f, a, env = {}) {
  const now = actionState(f.top, a.name);
  if (now?.running) return { ok: true, already: true, state: now };
  const dir = resolve(f.top, a.dir ?? ".");
  if (!dir.startsWith(f.top)) return { ok: false, err: `its dir ${a.dir} is outside the checkout` };
  mkdirSync(actionsDir(f.top), { recursive: true });
  const log = join(actionsDir(f.top), `${a.name}.log`);
  writeFileSync(log, `rollcall: ${new Date().toISOString()} starting \`${a.command}\` in ${dir}\n`);
  const fd = openSync(log, "a");
  let child;
  try {
    child = spawn("sh", ["-c", a.command], { cwd: dir, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, ...env, ...(a.port ? { PORT: String(a.port) } : {}) } });
  } catch (e) { closeSync(fd); return { ok: false, err: e.message }; }
  closeSync(fd);
  child.on("error", () => {});
  child.unref();
  const state = { name: a.name, pid: child.pid, start: startOf(child.pid), at: Date.now(), command: a.command, dir, url: a.url, port: a.port ?? null, log };
  writeJson(join(actionsDir(f.top), `${a.name}.json`), state);
  return { ok: true, state: { ...state, running: true } };
}

/** Stops action `name`'s whole process group (TERM, then KILL after `graceMs`). Returns whether one was running. */
export function stopAction(top, name, { graceMs = 5000 } = {}) {
  const s = actionState(top, name);
  rmSync(join(actionsDir(top), `${name}.json`), { force: true });
  if (!s?.running) return false;
  try { process.kill(-s.pid, "SIGTERM"); } catch {}
  for (const end = Date.now() + graceMs; groupAlive(s.pid) && Date.now() < end;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  if (groupAlive(s.pid)) { try { process.kill(-s.pid, "SIGKILL"); } catch {} }
  return true;
}

/** Stops every run action of the checkout at `top` (archive, gc). Returns the names it stopped. */
export function stopAllActions(top) {
  let names = [];
  try { names = readdirSync(actionsDir(top)).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)); } catch {}
  return names.filter((n) => stopAction(top, n, { graceMs: 3000 }));
}

/** The checkout's runtime folder goes with its worktree: its block back to the pool, its actions stopped. */
export function forgetCheckout(top) {
  stopAllActions(top);
  releasePorts(top);
  rmSync(runtimeDir(top), { recursive: true, force: true });
}

// ---------------------------------------------------------------- which checkout serves a port

/** The pid listening on TCP `port`, or null (lsof; ss on Linux without it). */
function listener(port) {
  const l = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout: 10_000 });
  if (!l.error) return Number((l.stdout ?? "").split("\n").find(Boolean)) || null;
  const s = spawnSync("ss", ["-Hltnp", `sport = :${port}`], { encoding: "utf8", timeout: 10_000 });
  return Number(/pid=(\d+)/.exec(s.stdout ?? "")?.[1]) || null;
}

/** The working folder of process `pid`, or null. */
function cwdOf(pid) {
  try { return realpathSync(`/proc/${pid}/cwd`); } catch {}
  const r = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 10_000 });
  const line = (r.stdout ?? "").split("\n").find((x) => x.startsWith("n"));
  return line ? real(line.slice(1)) : null;
}

/**
 * Who serves TCP `port`: { pid, cwd, top } (top: the checkout its folder is in), or null when nothing listens. A
 * browser check trusts a result only when `top` is its own checkout.
 */
export function servedFrom(port) {
  const pid = listener(port);
  if (!pid) return null;
  const cwd = cwdOf(pid);
  const top = cwd ? locate(cwd)?.top ?? null : null;
  return { pid, cwd, top };
}

/** Whether `path` is `top` or inside it. */
export const inside = (path, top) => !!path && !!top && (real(path) === real(top) || real(path).startsWith(real(top) + sep));

// ---------------------------------------------------------------- snapshots (archive and spotlight)

/**
 * A commit holding checkout `top`'s files as they are now: tracked changes and untracked files, gitignored ones
 * not, on top of HEAD. The checkout's own index is left alone (a copy of it seeds a private one, so unchanged
 * files are not hashed again). Returns { commit, tree, head } or null.
 */
export function snapshot(top, message = "rollcall snapshot") {
  const info = locate(top);
  if (!info) return null;
  const head = gitSync(top, ["rev-parse", "--verify", "--quiet", "HEAD"]).stdout?.trim();
  if (!head) return null;
  const idx = join(runtimeDir(top), `index.${process.pid}`);
  mkdirSync(dirname(idx), { recursive: true });
  try { copyFileSync(join(info.gitDir, "index"), idx); } catch { rmSync(idx, { force: true }); }
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    if (gitSync(top, ["add", "-A", "--", "."], { env, timeout: 300_000 }).status !== 0) return null;
    const tree = gitSync(top, ["write-tree"], { env }).stdout?.trim();
    if (!tree) return null;
    const commit = gitSync(top, ["commit-tree", tree, "-p", head, "-m", message], { env: { ...env, GIT_AUTHOR_NAME: "rollcall", GIT_AUTHOR_EMAIL: "rollcall@localhost", GIT_COMMITTER_NAME: "rollcall", GIT_COMMITTER_EMAIL: "rollcall@localhost" } }).stdout?.trim();
    return commit ? { commit, tree, head } : null;
  } finally { rmSync(idx, { force: true }); }
}

/** Paths relative to `top`, for messages. */
export const rel = (top, p) => relative(top, p) || ".";

// ---------------------------------------------------------------- spotlight state (archive.mjs runs it)

const spotDir = () => join(runtimeRoot(), "spotlight");
/** The spotlight file of the repo whose main checkout is `main`. */
export const spotlightPath = (main) => join(spotDir(), `${keyOf(main)}.json`);
/** The repo's spotlight: { main, worktree, task: { home, id }, before: { branch, head }, mirrored: { tree, at } } or null. */
export const spotlightOf = (main) => readJson(spotlightPath(main));
/** Every spotlight on the machine. */
export function allSpotlights() {
  try { return readdirSync(spotDir()).filter((n) => n.endsWith(".json")).map((n) => readJson(join(spotDir(), n))).filter(Boolean); } catch { return []; }
}
export const writeSpotlight = (main, v) => (v ? writeJson(spotlightPath(main), v) : rmSync(spotlightPath(main), { force: true }));

// ---------------------------------------------------------------- a task's runtime, for task show and front ends

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * The shell lines a worker's launch script runs before it starts the harness: the checkout's environment, and a wait
 * for a setup still running, so the worker's first turn finds its worktree ready. `bin` is rollcall's own script.
 */
export function launchLines(t, bin) {
  if (!t.branch || !t.repo?.key || !existsSync(t.worktree)) return [];
  const f = checkoutFacts(t.worktree);
  if (!f) return [];
  const env = checkoutEnv(f, t);
  return [
    ...Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`),
    // Only where a setup ran here: every other launch skips a node start.
    `[ -e ${q(setupPath(t.worktree))} ] && { ${q(process.execPath)} ${q(bin)} -C ${q(t.worktree)} setup --wait --quiet || true; }`,
  ];
}

/**
 * Task `t`'s runtime as front ends draw it: { ports: { base, last } | null, setup, actions: [{ name, url, running, log,
 * since }], previews: [url], spotlit, archived }. Null for a task with no worktree of its own.
 */
export function runtimeOf(t, now = Date.now()) {
  if (!t?.branch || !t.repo?.key) return null;
  const spot = spotlightOf(t.repo.main);
  const spotlit = spot?.task?.home === t.home && spot?.task?.id === t.id ? { since: spot.at, mirroredAt: spot.mirrored?.at ?? null } : null;
  if (t.archived || !existsSync(t.worktree)) return { ports: null, setup: null, actions: [], previews: [], spotlit, archived: t.archived ?? null };
  const f = checkoutFacts(t.worktree, { allocate: false });
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
