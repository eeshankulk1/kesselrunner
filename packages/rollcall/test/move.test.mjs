// Moving a chat between two machines (move.mjs): two stores and two HOMEs in one sandbox stand in for the Mac and the
// cloud machine, with a bare origin both reach. The verbs run in this process with the place's environment set; the
// agent host is a fake that records what it was asked (the real host's side: host-move.test below).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { git, sandbox, until, write } from "./helpers.mjs";
import { setup } from "./host-helpers.mjs";
import * as move from "../src/move.mjs";

const H = "chat-abc123";
const S = "11111111-2222-4333-8444-555555555555";
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");

/** A machine: its own store and HOME. */
function place(sb, name) {
  const root = join(sb.root, name);
  const p = { name, store: join(root, "store"), home: join(root, "home") };
  mkdirSync(p.store, { recursive: true });
  mkdirSync(p.home, { recursive: true });
  return p;
}

const KEYS = ["ROLLCALL_HOME", "HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "ROLLCALL_MOVE_SETUP", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
/** Runs `fn` with place `p`'s environment. */
async function as(p, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { ROLLCALL_HOME: p.store, HOME: p.home, ROLLCALL_MOVE_SETUP: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" });
  try { return await fn(); } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

/** A fake agent host: `states` by ref; interrupt ends a turn, park parks. Records every call. */
function fakeHost(states = {}) {
  const calls = [];
  const fn = async (op, payload) => {
    calls.push({ op, ...payload });
    if (op === "state") return states[payload.ref] ? { ok: true, agent: { state: states[payload.ref] } } : { ok: false, error: { code: "not-found" } };
    if (op === "interrupt") { if (states[payload.ref] === "running") states[payload.ref] = "idle"; return { ok: true, interrupted: true }; }
    if (op === "park") { states[payload.ref] = "parked"; return { ok: true, parked: true }; }
    if (op === "stop") { states[payload.ref] = "stopped"; return { ok: true }; }
    return { ok: true };
  };
  fn.calls = calls;
  return fn;
}
const noHost = () => fakeHost();

/** Every file under `dir` but .git, with its content's hash. */
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex") + statSync(p).mode;
    }
  };
  walk(dir);
  return out;
}

/**
 * The Mac: the repo with a .worktreeinclude, a chat in its own worktree with an unpushed commit, an edited file, a new
 * file, a secret file that goes and node_modules that stays, its agent running, and its Claude transcript.
 */
function mac(sb, t) {
  const a = place(sb, "mac");
  write(join(sb.main, ".gitignore"), ".env\nnode_modules/\n");
  write(join(sb.main, ".worktreeinclude"), ".env\n");
  git(sb.main, "add", ".");
  git(sb.main, "commit", "-qm", "ignores");
  git(sb.main, "push", "-q", "origin", "main");
  const wt = join(sb.main, ".claude", "worktrees", H);
  git(sb.main, "worktree", "add", "-q", "--no-track", "-b", `chat/${H}`, wt, "origin/main");
  write(join(wt, "src/c.js"), "committed here only\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "unpushed");
  write(join(wt, "src/a.js"), "edited, not committed\n");
  write(join(wt, "notes.txt"), "a new file\n");
  write(join(wt, ".env"), "SECRET=1\n");
  write(join(wt, "node_modules/x/index.js"), "stays\n");
  const hd = join(a.store, "_supervisors", H);
  const wd = join(hd, "workers", H);
  write(join(hd, "runtime.json"), JSON.stringify({ runtime: "host", kind: "chat", at: 1 }));
  write(join(hd, "chat.json"), JSON.stringify({ title: "Fix it", titleBy: "owner", folder: sb.main, repo: { key: "k", name: "repo", main: sb.main }, worktree: wt, branch: `chat/${H}`, harness: "claude", model: "opus", mode: "default" }));
  write(join(hd, "chat-contract.md"), `Work in ${wt}.\n`);
  write(join(hd, "watch.json"), "{}");
  write(join(wd, "agent.json"), JSON.stringify({ ref: H, home: H, task: null, harness: "claude", state: "running", session: S, pid: 999999, host: 999998 }));
  write(join(wd, "claude-launch.json"), JSON.stringify({ home: H, task: null, session: S, resume: true, settings: null, cwd: wt, bin: "/nowhere/claude", appendPrompt: join(hd, "chat-contract.md"), view: "chat" }));
  write(join(wd, "claude.json"), JSON.stringify({ pid: 999998, sock: "/tmp/x.sock" }));
  write(join(wd, "history.jsonl"), `${JSON.stringify({ seq: 1, at: 1, ev: "item", session: S, item: { id: "u1", kind: "user", text: `look at ${wt}/src/a.js` } })}\n`);
  const proj = join(a.home, ".claude", "projects", enc(wt));
  write(join(proj, `${S}.jsonl`), `${JSON.stringify({ type: "user", cwd: wt, sessionId: S, message: { content: `edit ${wt}/src/a.js` } })}\n`);
  write(join(proj, S, "subagents", "agent-1.jsonl"), `${JSON.stringify({ cwd: wt })}\n`);
  return { a, wt, hd, tip: git(wt, "rev-parse", "HEAD") };
}

test("move: check counts what goes and what stays", async (t) => {
  const sb = sandbox(t);
  const { a } = mac(sb, t);
  const c = await as(a, () => move.check({ home: H }));
  assert.deepEqual(c.agents, [{ ref: H, state: "running", harness: "claude" }]);
  assert.equal(c.worktrees.length, 1);
  const w = c.worktrees[0];
  assert.equal(w.repo, "origin", "named by its origin, as rollcall names repos");
  assert.equal(w.origin, sb.origin);
  assert.equal(w.branch, `chat/${H}`);
  assert.deepEqual([w.changed, w.added, w.unpushed], [1, 1, 1]);
  assert.deepEqual(c.secrets, [".env"]);
  assert.deepEqual(c.staying, ["node_modules/"]);
  assert.equal(c.ios, false);
  assert.deepEqual(c.problems, []);
  // An agent open in a terminal blocks the move.
  const f = join(a.store, "_supervisors", H, "workers", H, "agent.json");
  writeFileSync(f, JSON.stringify({ ...readJson(f), state: "terminal" }));
  const c2 = await as(a, () => move.check({ home: H }));
  assert.deepEqual(c2.problems.map((p) => p.code), ["busy-terminal"]);
});

test("move: pack, unpack: changes, secrets, history and transcript arrive, paths rewritten, the source untouched", async (t) => {
  const sb = sandbox(t);
  const { a, wt, tip } = mac(sb, t);
  const b = place(sb, "cloud");
  const before = tree(wt);
  const status = git(wt, "status", "--porcelain");
  const host = fakeHost({ [H]: "running" });
  const packed = await as(a, () => move.pack({ home: H }, { host }));
  assert.deepEqual(packed.running, [H]);
  assert.deepEqual(host.calls.filter((c) => c.op !== "state").map((c) => c.op), ["interrupt", "park"], "interrupted, then parked");
  assert.ok(packed.path.startsWith(join(a.store, "_moves")) && packed.bytes > 0 && /^[0-9a-f]{64}$/.test(packed.sha256));
  assert.deepEqual(tree(wt), before, "the source's files are byte for byte as they were");
  assert.equal(git(wt, "status", "--porcelain"), status);
  assert.equal(git(wt, "rev-parse", "HEAD"), tip);
  assert.equal(git(sb.main, "stash", "list"), "");

  const out = await as(b, () => move.unpack({ path: packed.path, from: "MacBook Pro", sha256: packed.sha256 }, { host: noHost() }));
  assert.equal(out.home, H);
  assert.deepEqual(out.refs, [H]);
  assert.deepEqual(out.notes, []);
  const clone = join(b.home, "origin");
  const nwt = join(clone, ".claude", "worktrees", H);
  assert.equal(git(nwt, "rev-parse", "HEAD"), tip, "the unpushed commit came in the bundle");
  assert.equal(git(nwt, "branch", "--show-current"), `chat/${H}`);
  assert.equal(readFileSync(join(nwt, "src/a.js"), "utf8"), "edited, not committed\n");
  assert.equal(readFileSync(join(nwt, "src/c.js"), "utf8"), "committed here only\n");
  assert.equal(readFileSync(join(nwt, "notes.txt"), "utf8"), "a new file\n");
  assert.equal(readFileSync(join(nwt, ".env"), "utf8"), "SECRET=1\n");
  assert.equal(existsSync(join(nwt, "node_modules")), false, "other ignored files stay");
  const hd = join(b.store, "_supervisors", H);
  const chat = readJson(join(hd, "chat.json"));
  assert.equal(chat.worktree, nwt);
  assert.equal(chat.folder, clone);
  const launch = readJson(join(hd, "workers", H, "claude-launch.json"));
  assert.equal(launch.cwd, nwt);
  assert.equal(launch.appendPrompt, join(hd, "chat-contract.md"));
  assert.equal(launch.bin, "claude", "a binary the source had and this machine lacks is this machine's own");
  assert.equal(readFileSync(join(hd, "chat-contract.md"), "utf8"), `Work in ${nwt}.\n`);
  const rec = readJson(join(hd, "workers", H, "agent.json"));
  assert.equal(rec.state, "parked");
  assert.equal(rec.pid, null);
  assert.equal(existsSync(join(hd, "workers", H, "claude.json")), false, "the source host's record stays behind");
  assert.equal(existsSync(join(hd, "watch.json")), false);
  assert.match(readFileSync(join(hd, "workers", H, "history.jsonl"), "utf8"), new RegExp(`look at ${nwt}/src/a.js`));
  const tr = join(b.home, ".claude", "projects", enc(nwt), `${S}.jsonl`);
  assert.equal(JSON.parse(readFileSync(tr, "utf8")).cwd, nwt, "the transcript sits under the new cwd's folder, its paths rewritten");
  assert.equal(readJson(join(b.home, ".claude", "projects", enc(nwt), S, "subagents", "agent-1.jsonl")).cwd, nwt);
  assert.deepEqual(readJson(join(hd, "moved-in.json")).running, [H]);
  // A second unpack of the same chat meets the live one.
  await assert.rejects(as(b, () => move.unpack({ path: packed.path, from: "MacBook Pro" }, { host: noHost() })), (e) => e.code === "exists");
});

test("move: resume wakes the running agents told they moved; undo resumes at the source", async (t) => {
  const sb = sandbox(t);
  const { a, wt } = mac(sb, t);
  const b = place(sb, "cloud");
  const packed = await as(a, () => move.pack({ home: H }, { host: noHost() }));
  assert.deepEqual(packed.running, [H], "a record that says running, with no host, counts as running");
  await as(b, () => move.unpack({ path: packed.path, from: "MacBook Pro" }, { host: noHost() }));
  const host = fakeHost();
  const r = await as(b, () => move.resume({ home: H, here: "Cloud" }, { host }));
  assert.deepEqual(r.woke, [H]);
  const nwt = join(b.home, "origin", ".claude", "worktrees", H);
  assert.deepEqual(host.calls[0], { op: "system", ref: H, text: "Moved to Cloud from MacBook Pro" });
  assert.equal(host.calls[1].op, "say");
  assert.equal(host.calls[1].from, "rollcall");
  assert.equal(host.calls[1].text, `This chat moved from MacBook Pro to Cloud. Your files are now at ${nwt}. Carry on where you left off.`);

  // Undo at the source, as after a move that failed at the far side.
  const back = fakeHost();
  const u = await as(a, () => move.undo({ home: H }, { host: back }));
  assert.deepEqual(u.woke, [H]);
  assert.equal(u.archiveDeleted, true);
  assert.equal(existsSync(packed.path), false);
  assert.match(back.calls[0].text, new RegExp(`paused for a move that did not go ahead\\. Your files are where they were, at ${wt}\\. Carry on where you left off\\.`));
  assert.equal(existsSync(join(a.store, "_supervisors", H, "move-out.json")), false);
});

test("move: an idle agent (its background commands stopped by the pause) is woken and told; a parked one is not", async (t) => {
  const sb = sandbox(t);
  const { a, wt } = mac(sb, t);
  const b = place(sb, "cloud");
  const host = fakeHost({ [H]: "idle" });
  const packed = await as(a, () => move.pack({ home: H }, { host }));
  assert.deepEqual([packed.running, packed.idle], [[], [H]]);
  assert.deepEqual(host.calls.filter((c) => c.op !== "state").map((c) => c.op), ["park"], "parked, not interrupted");
  await as(b, () => move.unpack({ path: packed.path, from: "MacBook Pro" }, { host: noHost() }));
  const there = fakeHost();
  const r = await as(b, () => move.resume({ home: H, here: "Cloud" }, { host: there }));
  assert.deepEqual(r.woke, [H]);
  const nwt = join(b.home, "origin", ".claude", "worktrees", H);
  assert.equal(there.calls[1].text, `This chat moved from MacBook Pro to Cloud. Your files are now at ${nwt}. Commands you left running in the background were stopped by the move: start again any you still need; otherwise there is nothing to do.`);
  const back = fakeHost();
  const u = await as(a, () => move.undo({ home: H }, { host: back }));
  assert.deepEqual(u.woke, [H]);
  assert.equal(back.calls[0].text, `This chat was paused for a move that did not go ahead. Your files are where they were, at ${wt}. Commands you left running in the background were stopped; start again any you still need.`);

  // Parked at pack time: it stays parked at the far side.
  const sb2 = sandbox(t);
  const m2 = mac(sb2, t);
  const c = place(sb2, "cloud");
  const p2 = await as(m2.a, () => move.pack({ home: H }, { host: fakeHost({ [H]: "parked" }) }));
  assert.deepEqual([p2.running, p2.idle], [[], []]);
  await as(c, () => move.unpack({ path: p2.path, from: "MacBook Pro" }, { host: noHost() }));
  const quiet = fakeHost();
  const r2 = await as(c, () => move.resume({ home: H, here: "Cloud" }, { host: quiet }));
  assert.deepEqual(r2.woke, []);
  assert.deepEqual(quiet.calls.map((x) => x.op), ["system"], "only the moved line in its history");
});

test("move: clash refuses and leaves nothing; discard removes only what unpack made", async (t) => {
  const sb = sandbox(t);
  const { a } = mac(sb, t);
  const b = place(sb, "cloud");
  // The cloud machine has its own clone, with the branch moved on by commits the chat does not have.
  const clone = join(b.home, "origin");
  git(sb.root, "clone", "-q", sb.origin, clone);
  git(clone, "checkout", "-q", "-b", `chat/${H}`);
  write(join(clone, "other.txt"), "other work\n");
  git(clone, "add", ".");
  git(clone, "commit", "-qm", "other");
  git(clone, "checkout", "-q", "main");
  const packed = await as(a, () => move.pack({ home: H }, { host: noHost() }));
  await assert.rejects(as(b, () => move.unpack({ path: packed.path, from: "Mac" }, { host: noHost() })), (e) => e.code === "clash");
  assert.equal(existsSync(join(b.store, "_supervisors", H)), false);
  assert.equal(existsSync(join(clone, ".claude", "worktrees", H)), false);

  // Without the clash: the unpack works in that clone, and discard takes back only what it made.
  git(clone, "branch", "-q", "-D", `chat/${H}`);
  const out = await as(b, () => move.unpack({ path: packed.path, from: "Mac" }, { host: noHost() }));
  const nwt = join(clone, ".claude", "worktrees", H);
  assert.ok(existsSync(nwt));
  const tr = join(b.home, ".claude", "projects", enc(nwt), `${S}.jsonl`);
  assert.ok(existsSync(tr));
  const host = fakeHost();
  const d = await as(b, () => move.discard({ home: out.home }, { host }));
  assert.equal(d.removed.home, true);
  assert.deepEqual(d.removed.clones, [], "a checkout it did not make stays");
  assert.ok(existsSync(join(clone, "README.md")));
  assert.equal(existsSync(nwt), false);
  assert.equal(git(clone, "branch", "--list", `chat/${H}`), "");
  assert.equal(existsSync(tr), false);
  assert.equal(existsSync(join(b.store, "_supervisors", H)), false);
  assert.ok(host.calls.some((c) => c.op === "adopt"));
});

test("move: archives are owner-only and go on finish; an archive that reaches outside its folders is refused", async (t) => {
  const sb = sandbox(t);
  const { a } = mac(sb, t);
  const b = place(sb, "cloud");
  const packed = await as(a, () => move.pack({ home: H }, { host: noHost() }));
  assert.equal(statSync(packed.path).mode & 0o777, 0o600, "the archive carries secret files");
  assert.equal(statSync(join(a.store, "_moves")).mode & 0o777, 0o700);

  // A crafted copy: unpacked by hand, changed, packed again.
  const craft = (name, change) => {
    const d = join(sb.root, `craft-${name}`);
    mkdirSync(d, { recursive: true });
    assert.equal(spawnSync("tar", ["-xzf", packed.path, "-C", d]).status, 0);
    change(d);
    const out = join(sb.root, `${name}.tar.gz`);
    assert.equal(spawnSync("tar", ["-czf", out, "-C", d, "."]).status, 0);
    return out;
  };
  const victim = join(b.home, "keep-me");
  write(join(victim, "x.txt"), "precious\n");
  const editMove = (fn) => (d) => { const m = readJson(join(d, "move.json")); fn(m); writeFileSync(join(d, "move.json"), JSON.stringify(m)); };
  const cases = {
    session: editMove((m) => { m.sessions[0].id = "../../../keep-me"; }),
    untracked: editMove((m) => { m.worktrees[0].untracked.push("../../keep-me/x.txt"); }),
    repo: editMove((m) => { m.worktrees[0].repo = "../keep-me"; }),
    branch: editMove((m) => { m.worktrees[0].branch = "--upload-pack=touch"; }),
    origin: editMove((m) => { m.worktrees[0].origin = "ext::sh -c touch% /tmp/pwned"; }),
  };
  for (const [name, change] of Object.entries(cases)) {
    await assert.rejects(as(b, () => move.unpack({ path: craft(name, change), from: "Mac" }, { host: noHost() })), (e) => e.code === "bad-payload", name);
  }
  // A member under a symlink member (tar would not write one itself: the second file's name is swapped in).
  const d = join(sb.root, "craft-symlink");
  mkdirSync(join(d, "home"), { recursive: true });
  symlinkSync(victim, join(d, "home", "out"));
  write(join(d, "x.txt"), "overwritten\n");
  const bsd = /bsdtar/.test(spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout);
  const swap = bsd ? ["-s", ",^x.txt$,home/out/x.txt,"] : ["--transform", "s,^x.txt$,home/out/x.txt,"];
  const linked = join(sb.root, "symlink.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", linked, "-C", d, ...swap, "home/out", "x.txt"]).status, 0);
  assert.match(spawnSync("tar", ["-tzf", linked], { encoding: "utf8" }).stdout, /home\/out\/x\.txt/);
  await assert.rejects(as(b, () => move.unpack({ path: linked, from: "Mac" }, { host: noHost() })), (e) => e.code === "bad-payload" && /symlink/.test(e.message));
  assert.equal(readFileSync(join(victim, "x.txt"), "utf8"), "precious\n", "nothing outside was touched");
  assert.equal(existsSync(join(b.store, "_supervisors", H)), false);

  // The real one goes through; finish deletes the source's archive.
  await as(b, () => move.unpack({ path: packed.path, from: "Mac" }, { host: noHost() }));
  await as(a, () => move.finish({ home: H, to: "Cloud" }));
  assert.equal(existsSync(packed.path), false);
});

test("move: a chat coming back replaces the home marked moved and reuses its old worktree", async (t) => {
  const sb = sandbox(t);
  const { a, wt, hd } = mac(sb, t);
  const b = place(sb, "cloud");
  const there = await as(a, () => move.pack({ home: H }, { host: noHost() }));
  await as(b, () => move.unpack({ path: there.path, from: "MacBook Pro" }, { host: noHost() }));
  const f = await as(a, () => move.finish({ home: H, to: "Cloud" }));
  assert.equal(f.movedTo, "Cloud");
  assert.equal(readJson(join(hd, "chat.json")).movedTo, "Cloud");
  assert.ok(existsSync(join(hd, "moved.json")));
  assert.equal(existsSync(join(hd, "move-out.json")), false);
  const { snapshot } = await import("../src/api.mjs");
  assert.equal((await as(a, () => snapshot())).supervisors.some((s) => s.name === H || s.home === H), false, "it leaves the snapshot");

  // Work goes on in the cloud, then the chat comes back.
  const nwt = join(b.home, "origin", ".claude", "worktrees", H);
  write(join(nwt, "src/a.js"), "edited again in the cloud\n");
  const home = await as(b, () => move.pack({ home: H }, { host: noHost() }));
  // The old worktree here gained work of its own while the chat was away: a clash.
  write(join(wt, "stray.txt"), "made while away\n");
  await assert.rejects(as(a, () => move.unpack({ path: home.path, from: "Cloud" }, { host: noHost() })), (e) => e.code === "clash");
  assert.ok(existsSync(join(hd, "moved.json")), "a refused unpack leaves the moved-away home as it was");
  rmSync(join(wt, "stray.txt"));
  const out = await as(a, () => move.unpack({ path: home.path, from: "Cloud" }, { host: noHost() }));
  assert.deepEqual(out.notes, []);
  assert.equal(readFileSync(join(wt, "src/a.js"), "utf8"), "edited again in the cloud\n", "the old worktree, reused");
  assert.equal(existsSync(join(hd, "moved.json")), false);
  assert.equal(readJson(join(hd, "chat.json")).worktree, wt, "paths rewritten back to this machine's");
  assert.equal(readJson(join(hd, "workers", H, "claude-launch.json")).cwd, wt);
  assert.equal(JSON.parse(readFileSync(join(a.home, ".claude", "projects", enc(wt), `${S}.jsonl`), "utf8")).cwd, wt);
});

test("move: each worktree gets its own ports at the far side; finish gives the source's block back", async (t) => {
  const sb = sandbox(t);
  // The repo's manifest uses {port}, as a dev server's does: a task's worktree gets a block of its own.
  write(join(sb.main, ".claude", "test-manifest.json"), JSON.stringify({ devServer: { command: "npm run dev -- --port {port}", url: "http://localhost:{port+1}" } }));
  git(sb.main, "add", ".");
  git(sb.main, "commit", "-qm", "manifest");
  git(sb.main, "push", "-q", "origin", "main");
  const { a, wt, hd } = mac(sb, t);
  const b = place(sb, "cloud");
  const { portsFor } = await import("../src/runtime.mjs");
  const { heldPorts, readBlocks } = await import("../src/checkout.mjs");
  const src = await as(a, () => portsFor(wt, { allocate: true }));
  assert.ok(src, "the source worktree holds a block");
  // Its worker's launch files carry those numbers, as launchLines writes them.
  const wd = join(hd, "workers", H);
  write(join(wd, "host-env.sh"), [`export ROLLCALL_WORKTREE='${wt}'`, `export ROLLCALL_MAIN_CHECKOUT='${sb.main}'`, `export ROLLCALL_PORT='${src.base}'`, `export ROLLCALL_PORT_COUNT='${src.size}'`, ""].join("\n"));
  write(join(wd, "launch.sh"), `export DEV_URL='http://localhost:${src.base + 1}'\n`);
  // The far side already gave the source's block to a checkout of its own.
  write(join(b.store, "_runtime", "ports.json"), JSON.stringify({ blocks: [{ base: src.base, size: src.size, path: sb.root, at: 1 }] }));

  const packed = await as(a, () => move.pack({ home: H }, { host: noHost() }));
  await as(b, () => move.unpack({ path: packed.path, from: "Mac" }, { host: noHost() }));
  const nwt = join(b.home, "origin", ".claude", "worktrees", H);
  const got = await as(b, () => heldPorts(nwt));
  assert.ok(got, "the new worktree holds a block here");
  assert.notEqual(got.base, src.base);
  const nwd = join(b.store, "_supervisors", H, "workers", H);
  const env = readFileSync(join(nwd, "host-env.sh"), "utf8");
  assert.match(env, new RegExp(`^export ROLLCALL_PORT='${got.base}'$`, "m"));
  assert.match(env, new RegExp(`^export ROLLCALL_PORT_COUNT='${got.size}'$`, "m"));
  assert.match(env, new RegExp(`^export ROLLCALL_WORKTREE='${nwt}'$`, "m"));
  assert.equal(readFileSync(join(nwd, "launch.sh"), "utf8"), `export DEV_URL='http://localhost:${got.base + 1}'\n`, "another launch file's ports swapped too");

  // Finish gives the source's block back; undo would not.
  assert.ok((await as(a, () => readBlocks())).some((x) => x.path === wt));
  await as(a, () => move.finish({ home: H, to: "Cloud" }));
  assert.equal((await as(a, () => readBlocks())).some((x) => x.path === wt), false);
  // Discard at the far side gives back the block the unpack took.
  await as(b, () => move.discard({ home: H }, { host: fakeHost() }));
  assert.equal(await as(b, () => heldPorts(nwt)), null);
});

test("move: a Codex agent's rollout travels to the far side's Codex folder, its cwd rewritten", async (t) => {
  const sb = sandbox(t);
  const { a, wt, hd } = mac(sb, t);
  const b = place(sb, "cloud");
  const wd = join(hd, "workers", H);
  write(join(wd, "agent.json"), JSON.stringify({ ...readJson(join(wd, "agent.json")), harness: "codex", thread: "th-1" }));
  write(join(wd, "codex-launch.json"), JSON.stringify({ home: H, task: null, thread: "th-1", cwd: wt, bin: "/nowhere/codex" }));
  const rel = join("2026", "11", "12", "rollout-x-th-1.jsonl");
  write(join(a.home, ".codex", "sessions", rel), `${JSON.stringify({ cwd: wt })}\n`);
  const packed = await as(a, () => move.pack({ home: H }, { host: noHost() }));
  await as(b, () => move.unpack({ path: packed.path, from: "Mac" }, { host: noHost() }));
  const nwt = join(b.home, "origin", ".claude", "worktrees", H);
  assert.equal(readJson(join(b.home, ".codex", "sessions", rel))?.cwd, nwt, "the rollout sits under the far side's Codex folder, its cwd rewritten");
  assert.equal(readJson(join(b.store, "_supervisors", H, "workers", H, "codex-launch.json")).cwd, nwt);
});

test("move: the CLI answers check as the API does", async (t) => {
  const sb = sandbox(t);
  const { a } = mac(sb, t);
  const { execFileSync } = await import("node:child_process");
  const { BIN, cleanEnv } = await import("./helpers.mjs");
  const out = JSON.parse(execFileSync(process.execPath, [BIN, "chat", "move", "check", "--json", JSON.stringify({ home: H })], { encoding: "utf8", env: cleanEnv({ ROLLCALL_HOME: a.store, HOME: a.home }) }));
  assert.equal(out.ok, true);
  assert.equal(out.result.worktrees[0].unpushed, 1);
});

test("host: a home that appears while the host runs is adopted; words to one moved away are held", async (t) => {
  const x = setup(t);
  await x.startHost();
  const c = await x.client();
  const h = "beta";
  const wd = join(x.sb.home, "_supervisors", h, "workers", h);
  write(join(x.sb.home, "_supervisors", h, "runtime.json"), JSON.stringify({ runtime: "host", at: Date.now() }));
  write(join(wd, "agent.json"), JSON.stringify({ ref: h, home: h, task: null, harness: "claude", state: "parked", session: S }));
  write(join(wd, "claude-launch.json"), JSON.stringify({ home: h, task: null, session: S, resume: false, settings: join(x.sb.root, "settings.json"), cwd: x.sb.main, bin: join(x.sb.root, "..", "nothing"), prompt: null, mode: null, model: null, effort: null, addDir: [], name: null, view: "chat" }));
  const s = await c.call("state", { ref: h });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(s.agent.state, "parked");
  const ad = await c.call("adopt", { refs: [h] });
  assert.deepEqual(ad.adopted, [h]);
  const sys = await c.call("system", { ref: h, text: "Moved to Cloud from Mac" });
  assert.equal(sys.ok, true);
  await until(() => readFileSync(join(wd, "history.jsonl"), "utf8").includes("Moved to Cloud from Mac"));
  write(join(x.sb.home, "_supervisors", h, "moved.json"), JSON.stringify({ movedTo: "Cloud", movedAt: Date.now() }));
  const said = await c.call("say", { ref: h, text: "hello" });
  assert.equal(said.how, "held");
  assert.match(said.why, /moved to Cloud/);
});

/** What the host does with words said to a moving home: it adds them to the home's move-held.json. */
function hold(storeDir, word) {
  const f = join(storeDir, "_supervisors", H, "move-held.json");
  const held = readJson(f) ?? { words: [] };
  held.words.push({ ref: H, at: Date.now(), from: "owner", attachments: [], ...word });
  writeFileSync(f, JSON.stringify(held));
}

test("move: words said while moving wait, travel with the chat, and go in after the moved line (or at the source on undo)", async (t) => {
  const sb = sandbox(t);
  const { a } = mac(sb, t);
  const b = place(sb, "cloud");
  // Words arrive while the agents pause: they travel. Words after the archive is written do not.
  const host = fakeHost({ [H]: "running" });
  const park = host;
  const pauseHost = async (op, payload, opts) => { if (op === "park") hold(a.store, { uuid: "u1", text: "first, while it paused" }); return park(op, payload, opts); };
  const packed = await as(a, () => move.pack({ home: H }, { host: pauseHost }));
  hold(a.store, { uuid: "u2", text: "late, after the archive" });
  await as(b, () => move.unpack({ path: packed.path, from: "MacBook Pro" }, { host: noHost() }));
  assert.deepEqual(readJson(join(b.store, "_supervisors", H, "move-held.json")).words.map((w) => w.uuid), ["u1"]);
  const there = fakeHost();
  const r = await as(b, () => move.resume({ home: H, here: "Cloud" }, { host: there }));
  assert.deepEqual(there.calls.map((c) => `${c.op}:${c.from ?? ""}:${c.uuid ?? ""}`), ["system::", "say:rollcall:", "say:owner:u1"], "the moved line, then the held words in order, as the owner's, uuid kept");
  assert.deepEqual(r.held.delivered, ["u1"]);
  assert.equal(existsSync(join(b.store, "_supervisors", H, "move-held.json")), false);

  // At the source: finish keeps holding and names the words that did not travel; undo delivers every held word here.
  const f = await as(a, () => move.finish({ home: H, to: "Cloud" }));
  assert.deepEqual(f.held.map((w) => w.uuid), ["u2"]);
  const back = fakeHost();
  const u = await as(a, () => move.undo({ home: H }, { host: back }));
  assert.deepEqual(back.calls.map((c) => `${c.op}:${c.from}:${c.uuid ?? ""}`), ["say:rollcall:", "say:owner:u1", "say:owner:u2"]);
  assert.deepEqual(u.held.delivered, ["u1", "u2"]);
  for (const n of ["move-held.json", "move-out.json", "moved.json"]) assert.equal(existsSync(join(a.store, "_supervisors", H, n)), false, n);
});

test("host: words to a moving or moved-away home are held with the home, never waking its agents", async (t) => {
  const x = setup(t);
  x.launch();
  await x.startHost();
  const c = await x.client();
  const hd = join(x.sb.home, "_supervisors", x.h);
  write(join(hd, "move-out.json"), JSON.stringify({ id: "m", state: "pausing" }));
  const r1 = await c.call("say", { ref: `${x.h}:t1`, text: "while moving", uuid: "w-1" });
  assert.equal(r1.how, "held");
  assert.equal(r1.uuid, "w-1");
  rmSync(join(hd, "move-out.json"));
  write(join(hd, "moved.json"), JSON.stringify({ movedTo: "Cloud", movedAt: Date.now() }));
  const r2 = await c.call("say", { ref: `${x.h}:t1`, text: "after it left", from: "rollcall" });
  assert.equal(r2.how, "held");
  assert.match(r2.why, /moved to Cloud/);
  const held = readJson(join(hd, "move-held.json")).words;
  assert.deepEqual(held.map((w) => [w.ref, w.text, w.from]), [[`${x.h}:t1`, "while moving", "owner"], [`${x.h}:t1`, "after it left", "rollcall"]]);
  assert.equal(x.fake().length, 0, "the agent never started");
  assert.notEqual(x.agent()?.state, "running");
});
