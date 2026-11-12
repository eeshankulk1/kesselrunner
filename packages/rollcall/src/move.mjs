// Moving a chat (a hosted home: a chat or a hosted crew) between this machine and another, mid-work: cockpit's "Move to
// Cloud" and "Move to This Mac" (cockpit docs/plans/2026-11-12-move-chat-to-cloud.md, Pieces > 1). The source pauses
// its agents and packs one archive: the home folder, each worktree's unsaved state (a git bundle of the commits origin
// lacks, the tracked changes as a binary diff, the untracked files, the gitignored files `.worktreeinclude` names) and
// each agent's own Claude or Codex session files. The target unpacks it into worktrees of its own checkout of the same
// origin, rewrites every path, and leaves the agents parked; resume wakes the ones that were running. Nothing is pushed
// to GitHub, and no verb stashes, resets or deletes the source's files. Same code on macOS and Linux: system git and tar.
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { manifestOf } from "./checkout.mjs";
import { transcriptFor } from "./conversation.mjs";
import { gitSync, isMainCheckout, locate, mainCheckout, remoteUrl, repoKey } from "./git.mjs";
import * as store from "./store.mjs";

export const FORMAT = 1;
const DAY = 86400_000;

/** A refusal: the API turns it into { ok: false, error: { code, message, ...extra } }. */
export class MoveError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}
const refuse = (code, message, extra) => { throw new MoveError(code, message, extra); };

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`); };
const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const lines = (s) => String(s ?? "").split("\n").filter(Boolean);

export const movesDir = () => join(store.home(), "_moves");
const claudeProjects = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const codexSessions = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
/** The folder name Claude Code keeps a session's transcript in, for the session's cwd. */
export const encodeCwd = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, "-");

// git that never prompts and never writes the index on a read (GIT_OPTIONAL_LOCKS), so packing leaves the source as it was.
const GIT_ENV = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes" });
const git = (dir, args, opts = {}) => gitSync(dir, args, { env: GIT_ENV(), maxBuffer: 1 << 30, ...opts });
const gitOk = (dir, args, opts) => git(dir, args, opts).status === 0;
const gitOut = (dir, args, opts) => { const r = git(dir, args, opts); return r.status === 0 ? r.stdout : null; };
const why = (r) => (r.stderr || r.stdout || r.error?.message || "failed").trim().split("\n").filter(Boolean).at(-1)?.replace(/^(fatal|error):\s*/, "") ?? "failed";

// ---------------------------------------------------------------- what a home holds

/** Home files only this machine's copy has: the move's own records. They never travel. */
const MOVE_FILES = new Set(["moved.json", "moved-in.json", "move-out.json"]);
/** Live-process files, left out of the archive: locks, sockets, the watcher's record, and the host's compat records. */
const liveFile = (rel) => {
  const n = basename(rel);
  if (n.endsWith(".lock") || n.endsWith(".sock") || n === "watch.json") return true;
  if (!rel.includes("/") && MOVE_FILES.has(n)) return true;
  return /^workers\/[^/]+\/(claude|codex)\.json$/.test(rel);
};

const homeExists = (h) => existsSync(join(store.homeDir(h), "runtime.json")) || isDir(join(store.homeDir(h), "workers"));
const isHosted = (h) => store.readHomeFile(h, "runtime")?.runtime === "host";
export const movedAway = (h) => !!h && existsSync(join(store.homeDir(h), "moved.json"));

/** A home's agents: its own session and each task's worker, from their worker folders. */
export function agentsOf(h) {
  const dir = join(store.homeDir(h), "workers");
  let ids = [];
  try { ids = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch {}
  const chat = store.readHomeFile(h, "chat");
  const out = [];
  for (const wid of ids) {
    const wd = join(dir, wid);
    const tid = wid === h ? null : wid;
    const task = tid ? store.readTask(h, tid) : null;
    if (tid && !task) continue;
    const rec = readJson(join(wd, "agent.json"));
    const cl = readJson(join(wd, "claude-launch.json"));
    const cx = readJson(join(wd, "codex-launch.json"));
    if (!rec && !cl && !cx) continue;
    const harness = rec?.harness ?? (cx && (!cl || mtime(join(wd, "codex-launch.json")) > mtime(join(wd, "claude-launch.json"))) ? "codex" : "claude");
    const launch = harness === "codex" ? cx : cl;
    const cwd = launch?.cwd ?? task?.worktree ?? (tid ? null : chat?.worktree ?? chat?.folder ?? store.readHomeFile(h, "falcon")?.cwd ?? null);
    out.push({ ref: tid ? `${h}:${tid}` : h, wid, task: tid, harness, state: rec?.state ?? "parked", cwd, launch, rec, taskRec: task });
  }
  return out;
}

/** The gitignored paths `.worktreeinclude` names in checkout `top` (relative; a folder ends in /). */
function includesOf(top, main) {
  const list = existsSync(join(top, ".worktreeinclude")) ? join(top, ".worktreeinclude") : main && existsSync(join(main, ".worktreeinclude")) ? join(main, ".worktreeinclude") : null;
  if (!list) return [];
  const named = lines(gitOut(top, ["ls-files", "--others", "--ignored", "--directory", "--no-empty-directory", `--exclude-from=${list}`]));
  if (!named.length) return [];
  const r = git(top, ["check-ignore", "--stdin"], { input: named.join("\n"), stdio: ["pipe", "pipe", "pipe"] });
  return lines(r.stdout);
}

/** Every other ignored path in `top` (relative; a folder ends in /): what stays behind. */
function ignoredOf(top, secrets) {
  const all = lines(gitOut(top, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"]));
  const taken = (p) => secrets.some((s) => p === s || p.startsWith(s.endsWith("/") ? s : `${s}/`) || s.startsWith(p.endsWith("/") ? p : `${p}/`));
  return all.filter((p) => !taken(p));
}

const untrackedOf = (top) => String(gitOut(top, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "").split("\0").filter(Boolean);

/** What a worktree's state is, for the clash rule: its tip, tracked changes and untracked files, hashed. */
export function fingerprint(top) {
  const h = createHash("sha256");
  h.update(String(gitOut(top, ["rev-parse", "HEAD"]) ?? "").trim());
  h.update("\0");
  h.update(git(top, ["diff", "--binary", "HEAD"], { encoding: "buffer" }).stdout ?? Buffer.alloc(0));
  for (const rel of untrackedOf(top).sort()) {
    h.update(`\0${rel}\0`);
    try { h.update(readFileSync(join(top, rel))); } catch {}
  }
  return h.digest("hex");
}

/** The repo's iPhone work, which a Linux machine cannot build: the manifest's `ios` block or an xcuitest stack. */
function iosOf(top) {
  const m = manifestOf(top);
  return !!m && (!!m.ios || /xcuitest/i.test(JSON.stringify(m.stacks ?? m)));
}

/** The home's worktrees, one per checkout its agents work in. */
function worktreesOf(agents) {
  const by = new Map();
  const problems = [];
  for (const a of agents) {
    if (!a.cwd || !existsSync(a.cwd)) continue;
    const info = locate(a.cwd);
    if (!info) { problems.push({ code: "no-repo", ref: a.ref, message: `${a.ref} works in ${a.cwd}, which is not a git checkout` }); continue; }
    const w = by.get(info.top);
    if (w) { w.refs.push(a.ref); continue; }
    by.set(info.top, { info, refs: [a.ref] });
  }
  const out = [];
  for (const [top, { info, refs }] of by) {
    const main = isMainCheckout(info);
    const origin = remoteUrl(info) ?? null;
    const { key, name } = repoKey(info);
    const branch = String(gitOut(top, ["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? "").trim() || null;
    const tip = String(gitOut(top, ["rev-parse", "HEAD"]) ?? "").trim() || null;
    const w = { ref: refs[0], refs, top, main, mainCheckout: mainCheckout(info), repo: name, key, origin, branch, tip, changed: 0, added: 0, unpushed: 0, secrets: [], staying: [] };
    if (!origin) problems.push({ code: "no-origin", ref: w.ref, message: `${name} has no origin to fetch from at the far side` });
    if (!main) {
      if (!branch) problems.push({ code: "no-branch", ref: w.ref, message: `${top} is not on a branch` });
      w.changed = lines(gitOut(top, ["diff", "--name-only", "HEAD"])).length;
      w.added = untrackedOf(top).length;
      w.unpushed = tip ? Number(String(gitOut(top, ["rev-list", "--count", tip, "--not", "--remotes=origin"]) ?? "0").trim()) || 0 : 0;
      w.secrets = includesOf(top, w.mainCheckout);
      w.staying = ignoredOf(top, w.secrets);
    }
    out.push(w);
  }
  return { worktrees: out, problems };
}

// ---------------------------------------------------------------- check

/** `chat.move.check`: what would move, and what blocks it. */
export function check({ home: h }) {
  if (!homeExists(h)) refuse("not-found", `no chat ${h}`);
  const agents = agentsOf(h);
  const problems = [];
  if (!isHosted(h)) problems.push({ code: "not-hosted", message: `${h} runs in a terminal (tmux), not the agent host: only a chat or a hosted crew moves` });
  if (movedAway(h)) problems.push({ code: "moved", message: `${h} moved to ${store.readHomeFile(h, "moved")?.movedTo ?? "another machine"} already` });
  for (const a of agents) if (a.state === "terminal") problems.push({ code: "busy-terminal", ref: a.ref, message: `${a.ref} is open in a terminal: close it first` });
  const wt = worktreesOf(agents);
  problems.push(...wt.problems);
  const uniq = (xs) => [...new Set(xs)];
  return {
    home: h,
    agents: agents.map((a) => ({ ref: a.ref, state: a.state, harness: a.harness })),
    worktrees: wt.worktrees.map(({ ref, refs, top, main, repo, origin, branch, tip, changed, added, unpushed, secrets, staying }) => ({ ref, refs, path: top, main, repo, origin, branch, tip, changed, added, unpushed, secrets, staying })),
    secrets: uniq(wt.worktrees.flatMap((w) => w.secrets)),
    staying: uniq(wt.worktrees.flatMap((w) => w.staying)),
    ios: wt.worktrees.some((w) => iosOf(w.top)),
    problems,
  };
}

// ---------------------------------------------------------------- pack

/** Waits until `ok(state)` for `ref` on the host; the last state seen. */
async function waitState(host, ref, ok, ms = 20_000) {
  const until = Date.now() + ms;
  let s = null;
  for (;;) {
    const r = await host("state", { ref }, { start: false });
    s = r?.ok ? r.agent?.state : null;
    if (!r?.ok || ok(s) || Date.now() > until) return s;
    await new Promise((res) => setTimeout(res, 100));
  }
}

/**
 * Pauses the home's agents: each running one is interrupted, then each live one parked, through the host. Returns the
 * refs that were running. With no host running, a record that says running or idle has no process (the host that ran
 * it is gone): it counts as it says, and there is nothing to pause.
 */
async function pause(agents, host) {
  const running = [];
  for (const a of agents) {
    const s = await host("state", { ref: a.ref }, { start: false });
    const state = s?.ok ? s.agent?.state : a.state;
    if (state === "terminal") refuse("busy-terminal", `${a.ref} is open in a terminal: close it first`);
    if (state === "running") running.push(a.ref);
    if (!s?.ok || (state !== "running" && state !== "idle")) continue;
    if (state === "running") {
      await host("interrupt", { ref: a.ref }, { start: false });
      await waitState(host, a.ref, (x) => x !== "running");
    }
    await host("park", { ref: a.ref }, { start: false });
    const end = await waitState(host, a.ref, (x) => x === "parked" || x === "stopped" || x === null);
    if (end === "running" || end === "idle") refuse("busy", `${a.ref} did not pause (it may be waiting on a question): answer it, then move again`, { running });
  }
  return running;
}

/** Copies `rel` from `from` into `to` (files, folders, links as they are). */
function copyRel(from, to, rel) {
  const dst = join(to, rel.replace(/\/$/, ""));
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(join(from, rel.replace(/\/$/, "")), dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, force: true });
}

/** The session files of an agent: Claude transcripts (and their subagent folders), Codex rollouts. */
function sessionFilesOf(a) {
  const out = [];
  if (a.harness === "codex" || a.taskRec?.sessions?.some((s) => s.harness === "codex")) {
    const threads = new Set([a.launch?.thread, a.rec?.thread, ...(a.taskRec?.sessions ?? []).map((s) => s.thread)].filter(Boolean));
    if (threads.size) {
      const root = codexSessions();
      const walk = (d, depth) => {
        let es = [];
        try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of es) {
          const p = join(d, e.name);
          if (e.isDirectory() && depth) walk(p, depth - 1);
          else if (e.isFile() && e.name.startsWith("rollout-") && [...threads].some((t) => e.name.endsWith(`-${t}.jsonl`))) out.push({ harness: "codex", rel: relative(root, p), file: p });
        }
      };
      walk(root, 4);
    }
  }
  const ids = new Set([...(a.harness === "claude" ? [a.launch?.session, a.rec?.session] : []), ...(a.taskRec?.sessions ?? []).filter((s) => (s.harness ?? "claude") === "claude").map((s) => s.id)].filter(Boolean));
  if (!a.task && a.harness === "claude") { const lock = store.readHomeFile(a.ref, "lock")?.session; if (lock) ids.add(lock); }
  for (const id of ids) {
    const file = transcriptFor(id, a.cwd);
    if (!file || !existsSync(file)) continue;
    out.push({ harness: "claude", id, dir: basename(dirname(file)), file, cwd: firstCwd(file) ?? a.cwd });
  }
  return out;
}

/** The first `cwd` a transcript's lines name: the folder Claude Code filed it under. */
function firstCwd(file) {
  try {
    const head = readFileSync(file, "utf8").slice(0, 200_000).split("\n");
    for (const l of head) { const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(l); if (m) return JSON.parse(`"${m[1]}"`); }
  } catch {}
  return null;
}

/** Drops archives and unpack leftovers older than two days. */
function pruneMoves(now = Date.now()) {
  let es = [];
  try { es = readdirSync(movesDir()); } catch { return; }
  for (const n of es) { const p = join(movesDir(), n); if (now - mtime(p) > 2 * DAY) rmSync(p, { recursive: true, force: true }); }
}

/**
 * `chat.move.pack`: pauses every agent of the home and writes one archive under `_moves/`. { path, bytes, sha256, running }.
 * The source's files are only read.
 */
export async function pack({ home: h }, { host = defaultHost } = {}) {
  const c = check({ home: h });
  if (c.problems.length) refuse(c.problems[0].code, c.problems.map((p) => p.message).join("; "), { problems: c.problems });
  pruneMoves();
  const agents = agentsOf(h);
  // A pack tried before and never undone parked its running agents: they still count as running.
  const before = store.readHomeFile(h, "move-out");
  const id = `${h}-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  const path = join(movesDir(), `${id}.tar.gz`);
  store.writeHomeFile(h, "move-out", { id, archive: path, running: before?.running ?? [], at: Date.now(), state: "pausing" });
  let running;
  try { running = [...new Set([...(before?.running ?? []), ...(await pause(agents, host))])]; }
  catch (e) { store.writeHomeFile(h, "move-out", { id, archive: null, running: [...new Set([...(before?.running ?? []), ...(e.extra?.running ?? [])])], at: Date.now(), state: "failed" }); throw e; }
  store.writeHomeFile(h, "move-out", { id, archive: path, running, at: Date.now(), state: "packing" });

  const stage = join(movesDir(), `${id}.stage`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    // The home, minus what only a live process here means.
    const hd = store.homeDir(h);
    cpSync(hd, join(stage, "home"), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, filter: (src) => src === hd || !liveFile(relative(hd, src)) });
    // Each worktree's state.
    const { worktrees } = worktreesOf(agents);
    const wts = [];
    worktrees.forEach((w, i) => {
      const d = join(stage, "wt", String(i));
      mkdirSync(d, { recursive: true });
      const meta = { i, refs: w.refs, path: w.top, main: w.main, mainCheckout: w.mainCheckout, repo: w.repo, key: w.key, origin: w.origin, branch: w.branch, tip: w.tip, bundle: false, diff: false, untracked: [], secrets: [], fingerprint: null };
      if (!w.main) {
        if (w.unpushed > 0) {
          const r = git(w.top, ["bundle", "create", join(d, "branch.bundle"), `refs/heads/${w.branch}`, "--not", "--remotes=origin"]);
          if (r.status !== 0) refuse("failed", `could not bundle ${w.branch}'s unpushed commits: ${why(r)}`);
          meta.bundle = true;
        }
        const diff = git(w.top, ["diff", "--binary", "HEAD"], { encoding: "buffer" });
        if (diff.status !== 0) refuse("failed", `could not read ${w.top}'s changes: ${why({ stderr: String(diff.stderr) })}`);
        if (diff.stdout.length) { writeFileSync(join(d, "changes.diff"), diff.stdout); meta.diff = true; }
        meta.untracked = untrackedOf(w.top);
        for (const rel of meta.untracked) copyRel(w.top, join(d, "untracked"), rel);
        meta.secrets = w.secrets;
        for (const rel of w.secrets) copyRel(w.top, join(d, "include"), rel);
        meta.fingerprint = fingerprint(w.top);
      }
      wts.push(meta);
    });
    // Each agent's own session files.
    const sessions = [];
    for (const a of agents) {
      for (const s of sessionFilesOf(a)) {
        if (s.harness === "claude") {
          const at = join("sessions", "claude", s.dir);
          copyRel(dirname(s.file), join(stage, at), `${s.id}.jsonl`);
          if (isDir(join(dirname(s.file), s.id))) copyRel(dirname(s.file), join(stage, at), s.id);
          sessions.push({ ref: a.ref, harness: "claude", id: s.id, dir: s.dir, cwd: s.cwd });
        } else {
          copyRel(codexSessions(), join(stage, "sessions", "codex"), s.rel);
          sessions.push({ ref: a.ref, harness: "codex", rel: s.rel });
        }
      }
    }
    const move = {
      format: FORMAT, id, home: h, at: Date.now(), from: { host: hostname(), store: store.home(), homeDir: hd, home: homedir(), claude: dirname(claudeProjects()), codex: dirname(codexSessions()) },
      agents: agents.map((a) => ({ ref: a.ref, task: a.task, harness: a.harness, state: a.state, cwd: a.cwd, session: a.launch?.session ?? a.rec?.session ?? null, thread: a.launch?.thread ?? a.rec?.thread ?? null })),
      running, worktrees: wts, sessions,
    };
    writeJson(join(stage, "move.json"), move);
    const t = spawnSync("tar", ["-czf", path, "-C", stage, "."], { encoding: "utf8", maxBuffer: 1 << 26 });
    if (t.status !== 0) refuse("failed", `tar could not write the archive: ${(t.stderr || t.error?.message || "").trim()}`);
    store.writeHomeFile(h, "move-out", { id, archive: path, running, at: Date.now(), state: "packed", worktrees: wts.map((w) => ({ path: w.path, branch: w.branch, tip: w.tip, fingerprint: w.fingerprint })) });
    const buf = readFileSync(path);
    return { path, bytes: buf.length, sha256: sha256(buf), running };
  } catch (e) {
    rmSync(path, { force: true });
    throw e;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- unpack

/** Checkouts this store knows of (tasks' and chats' repos), as main checkout paths. */
function knownCheckouts() {
  const out = new Set();
  for (const h of store.listHomes()) {
    for (const t of store.listTasks(h)) if (t.repo?.main) out.add(t.repo.main);
    const c = store.readHomeFile(h, "chat");
    if (c?.repo?.main) out.add(c.repo.main);
  }
  return [...out].filter((p) => isDir(p));
}

const keyOf = (dir) => { const info = locate(dir); return info ? { key: repoKey(info).key, main: mainCheckout(info) } : null; };

/** A checkout here of the worktree's origin: one rollcall knows, else $HOME/<repo>, else a clone there. */
function checkoutFor(w, made) {
  for (const p of knownCheckouts()) { const k = keyOf(p); if (k?.key === w.key) return k.main; }
  const base = join(homedir(), w.repo);
  for (let n = 1; n < 20; n++) {
    const dir = n === 1 ? base : `${base}-${n}`;
    if (existsSync(dir)) { const k = keyOf(dir); if (k?.key === w.key) return k.main; continue; }
    const gh = /github\.com[:/]/.test(w.origin) && spawnSync("gh", ["--version"], { stdio: "ignore" }).status === 0;
    const r = gh
      ? spawnSync("gh", ["repo", "clone", w.origin, dir, "--", "--quiet"], { encoding: "utf8", env: GIT_ENV(), timeout: 600_000 })
      : spawnSync("git", ["clone", "--quiet", w.origin, dir], { encoding: "utf8", env: GIT_ENV(), timeout: 600_000 });
    if (r.status !== 0) { rmSync(dir, { recursive: true, force: true }); refuse("failed", `could not clone ${w.origin}: ${why(r)}`); }
    made.clones.push(dir);
    return dir;
  }
  refuse("failed", `no free folder for a clone of ${w.repo} in ${homedir()}`);
}

/** The worktree checked out on `branch` in `main`'s repo, or null. */
function worktreeOn(main, branch) {
  let cur = null;
  for (const l of lines(gitOut(main, ["worktree", "list", "--porcelain"]))) {
    if (l.startsWith("worktree ")) cur = l.slice(9);
    else if (l === `branch refs/heads/${branch}`) return cur;
  }
  return null;
}

const clean = (top) => !lines(gitOut(top, ["diff", "--name-only", "HEAD"])).length && !untrackedOf(top).length;
const isAncestor = (dir, a, b) => gitOk(dir, ["merge-base", "--is-ancestor", a, b]);

/** Path pairs (source -> target), longest source first, and a function that rewrites text with them. */
function rewriter(pairs) {
  const ps = pairs.filter(([a, b]) => a && b && a !== b).sort((x, y) => y[0].length - x[0].length);
  const fn = (s) => {
    if (!ps.length) return s;
    // One pass, so a target path that contains another source path is never rewritten twice.
    const re = new RegExp(ps.map(([a]) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
    const map = new Map(ps);
    return s.replace(re, (m) => map.get(m));
  };
  fn.pairs = ps;
  return fn;
}

const TEXT = /\.(json|jsonl|md|sh|txt)$/;
/** Rewrites every text file under `dir` in place. */
function rewriteTree(dir, rw, { skip = () => false } = {}) {
  let es = [];
  try { es = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = join(dir, e.name);
    if (skip(p)) continue;
    if (e.isDirectory()) rewriteTree(p, rw, { skip });
    else if (e.isFile() && TEXT.test(e.name)) rewriteFile(p, rw);
  }
}
function rewriteFile(p, rw) {
  try { const s = readFileSync(p, "utf8"); const t = rw(s); if (t !== s) writeFileSync(p, t); } catch {}
}

/** Applies a binary diff in `top`: { ok, notes }. What does not apply as a whole goes in hunk by hunk, the rest named. */
function applyDiff(top, file) {
  const r = git(top, ["apply", "--binary", "--whitespace=nowarn", file]);
  if (r.status === 0) return [];
  const r2 = git(top, ["apply", "--binary", "--whitespace=nowarn", "--reject", file]);
  const out = `${r2.stderr ?? ""}`;
  const bad = new Set();
  for (const m of out.matchAll(/(?:patch failed|Rejected hunk[^\n]*?): ?([^\s:]+)/g)) bad.add(m[1]);
  for (const m of out.matchAll(/error: ([^:\n]+): (?:does not exist|already exists|patch does not apply)/g)) bad.add(m[1]);
  if (!bad.size && r2.status !== 0) bad.add("(changes)");
  return [...bad].map((p) => ({ path: p, why: "its changes did not apply over the branch here" }));
}

/**
 * `chat.move.unpack`: recreates the chat from an archive, every agent parked. { home, refs, notes }. Refuses `exists`
 * (a live home of that name) and `clash` (the branch here moved on, or a worktree of it has changes of its own).
 */
export async function unpack({ path, from, sha256: want = null }, { host = defaultHost, setup = store.envFlag("ROLLCALL_MOVE_SETUP") !== false } = {}) {
  if (!path || !path.startsWith("/") || !existsSync(path)) refuse("bad-payload", `no archive at ${path}`);
  if (want && sha256(readFileSync(path)) !== want) refuse("bad-payload", "the archive's sha256 does not match: it changed on the way");
  const fromName = String(from ?? "").trim() || "another machine";
  mkdirSync(movesDir(), { recursive: true });
  const id = `in-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  const work = join(movesDir(), id);
  const x = join(work, "x");
  mkdirSync(x, { recursive: true });
  const t = spawnSync("tar", ["-xzf", path, "-C", x], { encoding: "utf8" });
  if (t.status !== 0) { rmSync(work, { recursive: true, force: true }); refuse("bad-payload", `tar could not read the archive: ${(t.stderr || "").trim()}`); }
  const move = readJson(join(x, "move.json"));
  if (!move || move.format !== FORMAT || !store.HOME_NAME.test(move.home ?? "")) { rmSync(work, { recursive: true, force: true }); refuse("bad-payload", "not a chat move archive (or one from a newer rollcall)"); }
  const h = move.home;
  const back = homeExists(h) && movedAway(h) ? store.readHomeFile(h, "moved") : null;
  if (homeExists(h) && !back) { rmSync(work, { recursive: true, force: true }); refuse("exists", `a live chat ${h} is here already`); }

  const made = { home: null, oldHome: null, worktrees: [], branches: [], clones: [], sessions: [], replaced: [], reused: [] };
  const notes = [];
  try {
    // Plan each worktree first, so a clash leaves nothing made but the clones.
    const plans = [];
    for (const w of move.worktrees) {
      const main = checkoutFor(w, made);
      if (w.main) { plans.push({ w, main, top: main, how: "main" }); continue; }
      git(main, ["fetch", "--quiet", "--no-tags", "origin"], { timeout: 300_000 });
      if (w.bundle) {
        const r = git(main, ["bundle", "unbundle", join(x, "wt", String(w.i), "branch.bundle")]);
        if (r.status !== 0) refuse("failed", `the unpushed commits of ${w.branch} did not apply: ${why(r)}`);
      }
      if (!gitOk(main, ["cat-file", "-e", `${w.tip}^{commit}`])) refuse("failed", `${w.branch}'s tip ${w.tip.slice(0, 8)} is neither in the archive nor on origin`);
      const on = worktreeOn(main, w.branch);
      if (on) {
        // A chat coming back finds the worktree it left: reused when it is exactly as it was packed then.
        const left = back?.worktrees?.find((y) => y.branch === w.branch && y.path === on);
        const same = left?.fingerprint && fingerprint(on) === left.fingerprint;
        const tipHere = String(gitOut(on, ["rev-parse", "HEAD"]) ?? "").trim();
        if (!same && !(clean(on) && isAncestor(main, tipHere, w.tip))) refuse("clash", `${w.repo}'s branch ${w.branch} is checked out here at ${on} with work of its own`, { repo: w.repo, branch: w.branch, path: on });
        plans.push({ w, main, top: on, how: "reuse" });
        continue;
      }
      const has = gitOk(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`]);
      if (has) {
        const tipHere = String(gitOut(main, ["rev-parse", `refs/heads/${w.branch}`]) ?? "").trim();
        if (!isAncestor(main, tipHere, w.tip)) refuse("clash", `${w.repo}'s branch ${w.branch} here has commits the moved one does not`, { repo: w.repo, branch: w.branch });
      }
      let top = join(main, ".claude", "worktrees", basename(w.path));
      for (let n = 2; existsSync(top); n++) top = join(main, ".claude", "worktrees", `${basename(w.path)}-${n}`);
      plans.push({ w, main, top, how: has ? "branch" : "new" });
    }

    // Make each worktree and lay the changes over it.
    for (const p of plans) {
      const { w } = p;
      if (p.how === "main") continue;
      const d = join(x, "wt", String(w.i));
      if (p.how === "reuse") {
        // Known to hold only what left from here, or nothing of its own: brought to the moved state.
        const r = git(p.top, ["reset", "--quiet", "--hard", w.tip]);
        if (r.status !== 0) refuse("failed", `could not bring ${p.top} to ${w.tip.slice(0, 8)}: ${why(r)}`);
        git(p.top, ["clean", "-fdq"]);
        made.reused.push(p.top);
      } else {
        mkdirSync(dirname(p.top), { recursive: true });
        const r = p.how === "new"
          ? git(p.main, ["worktree", "add", "--quiet", "--no-track", "-b", w.branch, p.top, w.tip], { timeout: 300_000 })
          : (git(p.main, ["branch", "--quiet", "-f", w.branch, w.tip]), git(p.main, ["worktree", "add", "--quiet", p.top, w.branch], { timeout: 300_000 }));
        if (r.status !== 0) refuse("failed", `git worktree add ${p.top} failed: ${why(r)}`);
        made.worktrees.push({ main: p.main, path: p.top });
        if (p.how === "new") made.branches.push({ main: p.main, branch: w.branch });
        if (gitOk(p.main, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${w.branch}`])) git(p.top, ["branch", "--quiet", `--set-upstream-to=origin/${w.branch}`]);
      }
      if (w.diff) notes.push(...applyDiff(p.top, join(d, "changes.diff")).map((n) => ({ ...n, path: join(p.top, n.path) })));
      for (const [sub, list] of [["untracked", w.untracked], ["include", w.secrets]]) {
        for (const rel of list) {
          try { copyRel(join(d, sub), p.top, rel); } catch (e) { notes.push({ path: join(p.top, rel), why: e.message }); }
        }
      }
    }

    // The home, every path rewritten from the source's to this machine's.
    const f = move.from;
    const pairs = [[f.store, store.home()], [f.homeDir, store.homeDir(h)], [f.claude, dirname(claudeProjects())], [f.codex, dirname(codexSessions())]];
    for (const p of plans) { pairs.push([p.w.path, p.top]); if (p.w.mainCheckout) pairs.push([p.w.mainCheckout, p.main]); }
    for (const p of plans) pairs.push([join(f.claude, "projects", encodeCwd(p.w.path)), join(claudeProjects(), encodeCwd(p.top))]);
    const rw = rewriter(pairs);
    // A launch's own paths (the binary, settings) may sit under the source's HOME: the HOME pair goes there only.
    const rwLaunch = rewriter([...rw.pairs, [f.home, homedir()]]);

    if (back) {
      made.oldHome = join(work, "old-home");
      renameSync(store.homeDir(h), made.oldHome);
    }
    mkdirSync(dirname(store.homeDir(h)), { recursive: true });
    made.home = store.homeDir(h);
    cpSync(join(x, "home"), store.homeDir(h), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    rewriteTree(store.homeDir(h), rw, { skip: (p) => p === join(store.homeDir(h), "files") || /-launch\.json$|host-env\.sh$/.test(p) });
    const refs = [];
    for (const a of agentsOf(h)) {
      const wd = join(store.homeDir(h), "workers", a.wid);
      for (const n of ["claude-launch.json", "codex-launch.json", "host-env.sh"]) if (existsSync(join(wd, n))) rewriteFile(join(wd, n), rwLaunch);
      fixLaunchBins(wd);
      const rec = readJson(join(wd, "agent.json"));
      if (rec) writeJson(join(wd, "agent.json"), { ...rec, state: rec.state === "stopped" ? "stopped" : "parked", parkedAt: Date.now(), pid: null, host: null, serverSock: null, terminal: null, at: Date.now() });
      refs.push(a.ref);
    }

    // Each session's files, filed under the folder Claude Code derives from the new cwd.
    for (const s of move.sessions) {
      if (s.harness === "claude") {
        const dir = s.cwd ? encodeCwd(rw(s.cwd)) : s.dir;
        const src = join(x, "sessions", "claude", s.dir);
        for (const name of [`${s.id}.jsonl`, s.id]) {
          if (!existsSync(join(src, name))) continue;
          const dst = join(claudeProjects(), dir, name);
          keepOld(dst, work, made);
          copyRel(src, join(claudeProjects(), dir), name);
          made.sessions.push(dst);
          if (isDir(dst)) rewriteTree(dst, rw); else rewriteFile(dst, rw);
        }
      } else {
        const dst = join(codexSessions(), s.rel);
        keepOld(dst, work, made);
        copyRel(join(x, "sessions", "codex"), codexSessions(), s.rel);
        made.sessions.push(dst);
        rewriteFile(dst, rw);
      }
    }

    // A chat's session is bound to its home here, as at its start (its hooks mark its turns and bring task news).
    if (store.readHomeFile(h, "runtime")?.kind === "chat") {
      const session = readJson(join(store.homeDir(h), "workers", h, "claude-launch.json"))?.session;
      if (session) { const { bindChat } = await import("./host/chat.mjs"); bindChat(h, session); }
    }
    const agentsHere = Object.fromEntries(move.agents.map((a) => [a.ref, a.cwd ? rw(a.cwd) : null]));
    store.writeHomeFile(h, "moved-in", { id: move.id, from: fromName, at: Date.now(), archive: path, running: move.running, agents: agentsHere, made });
    // The running host takes the home as it is on disk now (an agent it held before, from a home that moved away, too).
    await host("adopt", { refs }, { start: false });
    if (setup) {
      const { checkoutFacts, startSetup } = await import("./runtime.mjs");
      const { BIN } = await import("./session.mjs");
      for (const p of plans) if (p.how !== "main") { try { checkoutFacts(p.top); startSetup(p.top, { bin: BIN }); } catch {} }
    }
    rmSync(x, { recursive: true, force: true });
    return { home: h, refs, notes };
  } catch (e) {
    undoMade(h, made);
    rmSync(work, { recursive: true, force: true });
    throw e;
  }
}

/** A session file about to be replaced (a chat coming back finds its old copy): kept, so discard can put it back. */
function keepOld(dst, work, made) {
  if (!existsSync(dst)) return;
  const keep = join(work, "kept", String(made.replaced.length));
  mkdirSync(dirname(keep), { recursive: true });
  cpSync(dst, keep, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  made.replaced.push({ path: dst, kept: keep });
  rmSync(dst, { recursive: true, force: true });
}

/** A launch's binary from the source that is not here: this machine's own. */
function fixLaunchBins(wd) {
  const cl = join(wd, "claude-launch.json");
  const c = readJson(cl);
  if (c?.bin && c.bin.startsWith("/") && !existsSync(c.bin)) writeJson(cl, { ...c, bin: process.env.KESSELRUNNER_CLAUDE_BIN || process.env.DOTCLAUDE_CLAUDE_BIN || "claude" });
  const xl = join(wd, "codex-launch.json");
  const x = readJson(xl);
  if (x?.bin && x.bin.startsWith("/") && !existsSync(x.bin)) writeJson(xl, { ...x, bin: process.env.ROLLCALL_CODEX_BIN || "codex" });
}

/** Removes what an unpack made, newest first, and puts back what it replaced. */
function undoMade(h, made) {
  const removed = { worktrees: [], branches: [], clones: [], sessions: [], home: false };
  for (const s of made.sessions ?? []) { rmSync(s, { recursive: true, force: true }); removed.sessions.push(s); }
  for (const r of made.replaced ?? []) { if (existsSync(r.kept)) { mkdirSync(dirname(r.path), { recursive: true }); cpSync(r.kept, r.path, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true }); } }
  for (const w of made.worktrees ?? []) { if (gitOk(w.main, ["worktree", "remove", "--force", w.path]) || !existsSync(w.path)) removed.worktrees.push(w.path); }
  for (const b of made.branches ?? []) { if (gitOk(b.main, ["branch", "-D", b.branch])) removed.branches.push(b.branch); }
  for (const c of made.clones ?? []) { rmSync(c, { recursive: true, force: true }); removed.clones.push(c); }
  const hd = store.homeDir(h);
  if (made.home && existsSync(hd)) {
    rmSync(hd, { recursive: true, force: true });
    removed.home = true;
  }
  if (made.oldHome && existsSync(made.oldHome)) renameSync(made.oldHome, hd);
  return removed;
}

// ---------------------------------------------------------------- after

/** `chat.move.finish`: marks the home moved away; its agents stay parked and its worktrees on disk. */
export async function finish({ home: h, to }) {
  if (!homeExists(h)) refuse("not-found", `no chat ${h}`);
  const out = store.readHomeFile(h, "move-out");
  const was = store.readHomeFile(h, "moved");
  if (!out && was) return { home: h, movedTo: was.movedTo, movedAt: was.movedAt, already: true };
  if (!out || out.state !== "packed") refuse("not-found", `${h} has no packed move to finish`);
  const movedTo = String(to ?? "").trim() || "another machine";
  const movedAt = Date.now();
  store.writeHomeFile(h, "moved", { movedTo, movedAt, id: out.id, archive: out.archive, running: out.running, worktrees: out.worktrees ?? [] });
  if (store.readHomeFile(h, "chat")) { const { updateChat } = await import("./host/chat.mjs"); updateChat(h, (c) => { c.movedTo = movedTo; c.movedAt = movedAt; return true; }); }
  store.writeHomeFile(h, "move-out", null);
  store.pokeWatcher(h);
  return { home: h, movedTo, movedAt };
}

/** Wakes `refs` with `text(ref)` as rollcall's words: { woke, failed }. */
async function wake(refs, text, host) {
  const woke = [];
  const failed = [];
  for (const ref of refs) {
    const r = await host("say", { ref, text: text(ref), from: "rollcall" }, { start: true });
    if (r?.ok) woke.push(ref); else failed.push({ ref, why: r?.error?.message ?? "the agent host did not answer" });
  }
  return { woke, failed };
}

const placeName = (here) => String(here ?? "").trim() || process.env.ROLLCALL_PLACE_NAME || hostname();

/** `chat.move.resume`: on the target, wakes the agents that were running at pack time, told they moved. */
export async function resume({ home: h, here = null }, { host = defaultHost } = {}) {
  const m = store.readHomeFile(h, "moved-in");
  if (!m) refuse("not-found", `nothing moved into ${h} here`);
  const place = placeName(here);
  await host("system", { ref: h, text: `Moved to ${place} from ${m.from}` }, { start: true });
  const r = await wake(m.running ?? [], (ref) => `This chat moved from ${m.from} to ${place}. Your files are now at ${m.agents?.[ref] ?? "the same place in this machine's checkout"}. Carry on where you left off.`, host);
  store.writeHomeFile(h, "moved-in", { ...m, resumedAt: Date.now() });
  return { home: h, ...r };
}

/** `chat.move.undo`: on the source after a failed move: the home is live here again, its running agents carry on. */
export async function undo({ home: h }, { host = defaultHost } = {}) {
  if (!homeExists(h)) refuse("not-found", `no chat ${h}`);
  const out = store.readHomeFile(h, "move-out") ?? store.readHomeFile(h, "moved");
  if (!out) refuse("not-found", `${h} has no move to undo`);
  store.writeHomeFile(h, "moved", null);
  if (store.readHomeFile(h, "chat")?.movedTo) { const { updateChat } = await import("./host/chat.mjs"); updateChat(h, (c) => { delete c.movedTo; delete c.movedAt; return true; }); }
  store.writeHomeFile(h, "move-out", null);
  let deleted = false;
  if (out.archive && existsSync(out.archive)) { rmSync(out.archive, { force: true }); deleted = true; }
  const cwd = Object.fromEntries(agentsOf(h).map((a) => [a.ref, a.cwd]));
  const r = await wake(out.running ?? [], (ref) => `This chat was paused for a move that did not go ahead. Your files are where they were${cwd[ref] ? `, at ${cwd[ref]}` : ""}. Carry on where you left off.`, host);
  store.pokeWatcher(h);
  return { home: h, ...r, archiveDeleted: deleted };
}

/** `chat.move.discard`: on the target, drops what an unpack made; a checkout it did not make is never touched. */
export async function discard({ home: h }, { host = defaultHost } = {}) {
  const m = store.readHomeFile(h, "moved-in");
  if (!m?.made) refuse("not-found", `nothing moved into ${h} here`);
  const refs = agentsOf(h).map((a) => a.ref);
  for (const ref of refs) {
    const s = await host("state", { ref }, { start: false });
    if (s?.ok && (s.agent?.state === "running" || s.agent?.state === "idle")) { await host("stop", { ref }, { start: false }); await waitState(host, ref, (x) => x === "stopped" || x === "parked" || x === null, 10_000); }
  }
  const removed = undoMade(h, m.made);
  await host("adopt", { refs }, { start: false });
  return { home: h, removed };
}

// ---------------------------------------------------------------- the host

/** The agent host, asked one op: its answer, or { ok: false } when none runs (and `start` is false). */
async function defaultHost(op, payload, { start = false } = {}) {
  const { call } = await import("./host/client.mjs");
  try { return await call(op, payload, { start }); } catch (e) { return { ok: false, error: { code: "failed", message: e.message } }; }
}
