// Done when: a host that runs other rollcall code than the code on disk (an update landed while it ran) is replaced
// by the next call, so a new op such as chat-start never meets an old host; while an agent is in a turn the old host
// stays, until a call needs an op it lacks. A chat whose start the host refuses leaves nothing behind (no home, no
// worktree, no branch): the owner's words stay in cockpit's composer, to send again.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { codeStamp, socketFor } from "../src/host/client.mjs";
import { BIN, git, until } from "./helpers.mjs";
import { readJson, setup } from "./host-helpers.mjs";

const ref = "alpha:t1";
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The sandbox, with the host.json of whatever host runs at the end killed too (a replacement starts detached). */
function staleSetup(t, opts) {
  const x = setup(t, opts);
  const info = join(x.sb.home, "_host", "host.json");
  t.after(() => { const pid = readJson(info)?.pid; if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  /** Marks the running host as started from other code, as one started before an update would be. */
  x.markStale = () => { const i = readJson(info); writeFileSync(info, JSON.stringify({ ...i, code: "older-code" })); return i.pid; };
  x.info = () => readJson(info);
  // The host answers on its socket a moment before it writes host.json.
  const start = x.startHost.bind(x);
  x.startHost = async () => { const p = await start(); await until(() => readJson(info)?.pid === p.pid); return p; };
  /**
   * One call through `rollcall _host-call`, as callSync makes it. Not spawnSync: this process must keep reaping the
   * host it started, or the stopped one stays a zombie that still looks alive.
   */
  x.hostCall = (op, payload = {}) => new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, "_host-call"], { env: x.hostEnv });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => resolve(JSON.parse(out.trim().split("\n").at(-1))));
    p.stdin.end(JSON.stringify({ ...payload, op }));
  });
  return x;
}

test("host: records the code it runs; a call replaces a host started from other code", async (t) => {
  const x = staleSetup(t);
  await x.startHost();
  assert.equal(x.info().code, codeStamp());
  const old = x.markStale();
  const r = await x.hostCall("hello");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.notEqual(r.pid, old);
  assert.equal(r.code, codeStamp());
  assert.equal(alive(old), false);
  assert.equal(x.info().pid, r.pid);
  // Same code: the next call keeps it.
  assert.equal((await x.hostCall("hello")).pid, r.pid);
});

test("host: a stale host stays while an agent is in a turn, until a call needs an op it lacks", async (t) => {
  const x = staleSetup(t, { env: { FAKE_CLAUDE_SLOW_MS: "1000" } });
  x.launch();
  const p = await x.startHost();
  const c = await x.client();
  assert.equal((await c.call("start", { ref })).ok, true);
  assert.equal((await c.call("say", { ref, text: "SLOW please" })).how, "sent");
  await until(() => x.agent()?.state === "running");
  const old = x.markStale();
  assert.equal((await x.hostCall("hello")).pid, old, "a turn runs: the old host stays");
  // An op the old host lacks (here one no host has): it is replaced, and the new host answers.
  const r = await x.hostCall("no-such-op");
  assert.equal(r.ok, false);
  assert.match(r.error.message, /^no op no-such-op/);
  await p.exited;
  assert.notEqual(x.info().pid, old);
  assert.equal(x.info().code, codeStamp());
  // The cut turn's agent parks, and the restart note is in its history.
  await until(() => x.agent()?.state === "parked");
  assert.ok(readFileSync(join(x.dir, "history.jsonl"), "utf8").includes("The host restarted"));
});

test("host: a stale host goes once every turn has waited on the owner a while; the question outlives it", async (t) => {
  const x = staleSetup(t, { env: { ROLLCALL_HOST_STALE_WAIT_MS: "300" } });
  x.launch();
  const p = await x.startHost();
  const c = await x.client();
  await c.call("start", { ref });
  await c.call("say", { ref, text: "ASK please" });
  const req = await until(async () => (await c.call("state", { ref })).agent.requests[0]);
  const old = x.markStale();
  // A turn that has waited on the owner past the limit no longer holds the old code.
  await new Promise((r) => setTimeout(r, 400));
  const r = await x.hostCall("hello");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.notEqual(r.pid, old);
  await p.exited;
  assert.equal(x.info().code, codeStamp());
  // The question is still open on the new host, and its answer goes in as the owner's words.
  const st = await x.hostCall("state", { ref });
  assert.equal(st.agent.requests[0]?.id, req.id);
});

test("host: a host started from inside a task's session carries none of that session's settings to its agents", async (t) => {
  const x = staleSetup(t);
  x.launch();
  // As when a worker of another crew made the first call: its task and its Claude Code session ride in its env.
  const env = { ...x.hostEnv, ROLLCALL_TASK: "executor:t33", ROLLCALL_TASK_HOME: "executor", CLAUDE_CODE_SESSION_ID: "other-session", TMUX: "/tmp/tmux-x/rollcall,1,1" };
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, "_host-call"], { env });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => resolve(JSON.parse(out.trim().split("\n").at(-1))));
    p.stdin.end(JSON.stringify({ op: "start", ref }));
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const started = await until(() => x.fake().find((l) => l.argv));
  assert.equal(started.task, null, "the agent never sees executor's task");
  assert.equal(started.claudeSession, null);
  const hostEnv = spawnSync("ps", ["eww", "-p", String(x.info().pid)], { encoding: "utf8" }).stdout;
  assert.doesNotMatch(hostEnv, /ROLLCALL_TASK=executor/);
});

test("chat.new: a start the host refuses leaves no chat, worktree or branch behind", async (t) => {
  const x = staleSetup(t);
  // A host on today's code that refuses every call, as one would refuse chat-start.
  const sock = socketFor(x.sb.home);
  rmSync(sock, { force: true });
  const server = createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
        const req = JSON.parse(buf.slice(0, i));
        c.write(`${JSON.stringify({ id: req.id, ok: false, error: { code: "failed", message: `no luck with ${req.op}` } })}\n`);
      }
    });
  });
  await new Promise((r) => server.listen(sock, r));
  t.after(() => { server.close(); rmSync(sock, { force: true }); });
  mkdirSync(join(x.sb.home, "_host"), { recursive: true });
  writeFileSync(join(x.sb.home, "_host", "host.json"), JSON.stringify({ pid: process.pid, sock, at: Date.now(), version: "0.1.0", code: codeStamp() }));
  t.after(() => rmSync(join(x.sb.home, "_host", "host.json"), { force: true })); // its pid is this test's
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, "api", "do", "chat.new", JSON.stringify({ cwd: x.sb.main, text: "Make a thing" })], { env: x.hostEnv, cwd: x.sb.root });
    let o = "";
    p.stdout.on("data", (d) => { o += d; });
    p.on("close", () => resolve(JSON.parse(o)));
  });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.match(out.error.message, /no luck with chat-start/);
  assert.equal(out.error.home, undefined, "no home to open");
  assert.deepEqual(readdirSync(join(x.sb.home, "_supervisors")).filter((n) => n.startsWith("chat-")), [], "no chat home left");
  assert.equal(existsSync(join(x.sb.main, ".claude", "worktrees")) && readdirSync(join(x.sb.main, ".claude", "worktrees")).length, 0, "no worktree left");
  assert.equal(git(x.sb.main, "branch", "--list", "chat/*"), "", "no branch left");
  assert.equal(spawnSync("git", ["-C", x.sb.main, "worktree", "list"], { encoding: "utf8" }).stdout.trim().split("\n").length, 1);
});
