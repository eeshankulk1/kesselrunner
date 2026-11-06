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
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gitSync, locate, mainCheckout } from "./git.mjs";
import { startOf } from "./proc.mjs";
import * as store from "./store.mjs";
import {
  actionState, actionsDir, factsOf, fillPorts, groupAlive, inside, lastLines, manifestOf, num, portRange, portsPath, readBlocks, readJson,
  real, runtimeDir, setupLog, setupPath, spotlightPath, usesPorts,
} from "./checkout.mjs";

// The read-only half lives in checkout.mjs, light enough for every hook; its names are this module's too.
export {
  actionsOf, actionState, allSpotlights, checkoutEnv, factsOf, fillPorts, heldPorts, inside, keyOf, lastLines, launchLines, listActions, manifestOf,
  portRange, runtimeDir, runtimeLines, runtimeOf, runtimeRoot, setupLine, setupLog, setupState, spotlightOf, spotlightPath,
} from "./checkout.mjs";

const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(`${p}.${process.pid}.tmp`, JSON.stringify(v)); renameSync(`${p}.${process.pid}.tmp`, p); };


// ---------------------------------------------------------------- ports


/**
 * Up to `want` of `bases` whose ports base..base+size-1 are all free to listen on now, in order. One child node binds
 * each port (every interface, 127.0.0.1 and ::1) and stops once it has found `want` wholly free blocks.
 */
export function freeBlocks(bases, size, want = 8) {
  if (!bases.length) return [];
  const script = `const net=require("net");const bases=${JSON.stringify(bases)};const size=${size};
const tryOn=(p,host)=>new Promise((ok)=>{const s=net.createServer();s.once("error",(e)=>ok(e.code==="EADDRNOTAVAIL"||e.code==="EAFNOSUPPORT"));s.listen({port:p,host,exclusive:true},()=>s.close(()=>ok(true)));});
const free=async(b)=>{for(let p=b;p<b+size;p++){if(!(await tryOn(p))||!(await tryOn(p,"127.0.0.1"))||!(await tryOn(p,"::1")))return false;}return true;};
(async()=>{const out=[];for(const b of bases){if(await free(b)){out.push(b);if(out.length>=${want})break;}}process.stdout.write(JSON.stringify(out));})();`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 });
  try { return JSON.parse(r.stdout); } catch { return []; }
}

/**
 * The block of ports checkout `path` holds: { base, size, last } or null. With `allocate`, one is handed out when it
 * holds none: the lowest block in range that no checkout holds and whose ports are all free now. A block whose checkout
 * is gone goes back to the pool first.
 */
export function portsFor(path, { allocate = false } = {}) {
  const p = real(path);
  const shape = (b) => (b ? { base: b.base, size: b.size, last: b.base + b.size - 1 } : null);
  // Reading takes no lock: front ends ask for every task's ports on each refresh, and a write is one atomic rename.
  const own = readBlocks().find((b) => b.path === p);
  if (own || !allocate) return shape(own);
  const { min, max, size } = portRange();
  for (let tries = 0; tries < 5; tries++) {
    // Free ports are found outside the lock (one child, however many blocks are busy); the lock only claims one, the
    // first that no other checkout claimed while this one looked.
    const held = new Set(readBlocks().filter((b) => existsSync(b.path)).map((b) => b.base));
    const bases = [];
    for (let base = min; base + size - 1 <= max; base += size) if (!held.has(base)) bases.push(base);
    const free = freeBlocks(bases, size);
    if (!free.length) return null;
    const r = store.withRuntimeLock(() => {
      const kept = readBlocks().filter((b) => existsSync(b.path));
      const mine = kept.find((b) => b.path === p);
      if (mine) return mine;
      const taken = new Set(kept.map((b) => b.base));
      const base = free.find((x) => !taken.has(x));
      if (base === undefined) return null;
      const b = { base, size, path: p, at: Date.now() };
      writeJson(portsPath(), { blocks: [...kept, b] });
      return b;
    });
    if (r?.out) return shape(r.out);
  }
  return null;
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


/**
 * factsOf, and a block of ports handed out when the checkout holds none: when the manifest uses `{port}` and `allocate`
 * says so, or always with "always" (rollcall ports). The main checkout keeps the manifest's ports.default when it names one.
 */
export function checkoutFacts(dir, { allocate = true } = {}) {
  const f = factsOf(dir);
  if (!f || f.ports) return f;
  const wanted = allocate === "always" || (allocate && usesPorts(f.manifest));
  if (!wanted || (f.isMain && f.dflt)) return f;
  const ports = portsFor(f.top, { allocate: true });
  return { ...f, ports, base: f.isMain && f.dflt ? f.dflt : ports?.base ?? null };
}


/** The manifest of the checkout holding `dir` with its ports filled in, or null with none. */
export function resolvedManifest(dir) {
  const f = checkoutFacts(dir);
  if (!f?.manifest) return null;
  return fillPorts(f.manifest, f.base);
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

const setupMs = () => num("ROLLCALL_SETUP_MINUTES", 30) * 60_000;

/** The manifest's worktree.setup command for `top`, or null. */
export function setupCommand(top) {
  const cmd = manifestOf(top)?.worktree?.setup;
  return typeof cmd === "string" && cmd.trim() ? cmd.trim() : null;
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
  // Not written again: the background run records its own pid and may already have finished.
  return { state: "running", pid: child.pid, start: null, at: now, cmd, copied: [], log: setupLog(top) };
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


// ---------------------------------------------------------------- run actions


/** Starts action `a` of the checkout as its own process group, output to its log. Returns { ok, err, state }. */
export function startAction(f, a, env = {}) {
  const now = actionState(f.top, a.name);
  if (now?.running) return { ok: true, already: true, state: now };
  const dir = resolve(f.top, a.dir ?? ".");
  if (!inside(dir, f.top)) return { ok: false, err: `its dir ${a.dir} is outside the checkout` };
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
  if (!child.pid) return { ok: false, err: "the shell did not start" };
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


// ---------------------------------------------------------------- snapshots (archive and spotlight)

/**
 * A commit holding checkout `top`'s files as they are now: tracked changes and untracked files, gitignored ones
 * not, on top of HEAD. The checkout's own index is left alone (a copy of it seeds a private one, so unchanged
 * files are not hashed again). With `unless` (a tree), no commit is written when the files make that tree: { commit: null,
 * tree, head }. Returns { commit, tree, head } or null.
 */
export function snapshot(top, message = "rollcall snapshot", { unless = null } = {}) {
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
    if (tree === unless) return { commit: null, tree, head };
    const commit = gitSync(top, ["commit-tree", tree, "-p", head, "-m", message], { env: { ...env, GIT_AUTHOR_NAME: "rollcall", GIT_AUTHOR_EMAIL: "rollcall@localhost", GIT_COMMITTER_NAME: "rollcall", GIT_COMMITTER_EMAIL: "rollcall@localhost" } }).stdout?.trim();
    return commit ? { commit, tree, head } : null;
  } finally { rmSync(idx, { force: true }); }
}

// ---------------------------------------------------------------- spotlight state (archive.mjs runs it)

export const writeSpotlight = (main, v) => (v ? writeJson(spotlightPath(main), v) : rmSync(spotlightPath(main), { force: true }));

// ---------------------------------------------------------------- a task's runtime, for task show and front ends


