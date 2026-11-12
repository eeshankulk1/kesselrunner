// Moving a chat between two machines (move.mjs): two stores and two HOMEs in one sandbox stand in for the Mac and the
// cloud machine, with a bare origin both reach. The verbs run in this process with the place's environment set; the
// agent host is a fake that records what it was asked (the real host's side: host-move.test below).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

test("move: the CLI answers check as the API does", async (t) => {
  const sb = sandbox(t);
  const { a } = mac(sb, t);
  const { execFileSync } = await import("node:child_process");
  const { BIN, cleanEnv } = await import("./helpers.mjs");
  const out = JSON.parse(execFileSync(process.execPath, [BIN, "chat", "move", "check", "--json", JSON.stringify({ home: H })], { encoding: "utf8", env: cleanEnv({ ROLLCALL_HOME: a.store, HOME: a.home }) }));
  assert.equal(out.ok, true);
  assert.equal(out.result.worktrees[0].unpushed, 1);
});

test("host: a home that appears while the host runs is adopted; one moved away hears nothing", async (t) => {
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
  assert.equal(said.ok, false);
  assert.match(said.error.message, /moved to Cloud/);
});
