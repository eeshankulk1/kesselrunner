// Done when: two sessions in the same checkout - the second is blocked on its
// first edit and told how to create a worktree. Plus the escape hatches and
// the liveness rules that decide when a deny is allowed at all.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { denied, git, reason, sandbox } from "./helpers.mjs";

test("second session in the same checkout is denied on its first edit, with a working worktree command", (t) => {
  const sb = sandbox(t);
  const a = sb.session();
  const b = sb.session();
  assert.equal(a.start().stdout, "", "a lone session hears nothing");
  a.prompt("fix the login bug");
  a.edit(join(sb.main, "src/a.js"));

  const hello = b.start();
  assert.match(hello.context, /\[rollcall\] .*is also in origin, active just now: "fix the login bug"/);
  assert.match(hello.context, /already working in this checkout, so your edits here will be blocked/);
  for (const line of hello.context.split("\n")) assert.match(line, /^\[rollcall\] /);

  const first = b.pre(join(sb.main, "src/b.js"));
  assert.ok(denied(first), "the second session's first edit is denied");
  const why = reason(first);
  assert.match(why, new RegExp(`session ${a.short}`));
  assert.match(why, /"fix the login bug"/);
  assert.match(why, /git -C ".*" worktree add ".*\/\.claude\/worktrees\/<slug>" -b <type>\/<slug>/);
  assert.match(why, /allow-shared/);
  assert.match(why, /ROLLCALL_DISABLE=1/);

  // The command in the message actually works, and editing inside the new worktree is allowed.
  const cmd = why.match(/(git -C .*? -b \S+ origin\/main)/)[1].replaceAll("<slug>", "second").replaceAll("<type>", "fix");
  const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const wt = cmd.match(/worktree add "([^"]+)"/)[1];
  assert.ok(existsSync(join(wt, "src/b.js")));
  assert.equal(git(wt, "rev-parse", "HEAD"), git(sb.main, "rev-parse", "origin/main"), "starts from origin/main, not the owner's HEAD");
  b.cwd = wt;
  assert.ok(!denied(b.pre(join(wt, "src/b.js"))), "edits in the new worktree are allowed");

  // The first session was never blocked.
  assert.ok(!denied(a.pre(join(sb.main, "src/b.js"))));
});

test("the senior session keeps editing; the junior one stays blocked on every edit tool", (t) => {
  const sb = sandbox(t);
  const a = sb.session();
  const b = sb.session();
  a.start();
  b.start();
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    assert.ok(denied(b.pre(join(sb.main, "src/new.ipynb"), tool)), `${tool} is denied`);
    assert.ok(!denied(a.pre(join(sb.main, "src/new.ipynb"), tool)), `${tool} is allowed for the senior session`);
  }
  // Files outside any git checkout are never blocked.
  assert.equal(b.pre(join(sb.root, "notes.txt")).stdout, "");
});

test("rollcall allow-shared lets a session share the checkout on purpose, and --off undoes it", (t) => {
  const sb = sandbox(t);
  const a = sb.session();
  const b = sb.session();
  a.start();
  b.start();
  assert.ok(denied(b.pre(join(sb.main, "src/a.js"))));
  const on = b.cli(["-C", sb.main, "allow-shared"]);
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /may now edit/);
  assert.ok(!denied(b.pre(join(sb.main, "src/a.js"))));
  assert.equal(b.cli(["allow-shared", "--off"]).code, 0);
  assert.ok(denied(b.pre(join(sb.main, "src/a.js"))));
});

test("ROLLCALL_DISABLE=1 turns every hook into a no-op", (t) => {
  const sb = sandbox(t);
  const a = sb.session();
  const b = sb.session();
  a.start();
  b.start();
  const off = { ROLLCALL_DISABLE: "1" };
  for (const r of [
    b.pre(join(sb.main, "src/a.js"), "Edit", off),
    b.post(join(sb.main, "src/a.js"), "Edit", off),
    b.hook("session-start", "SessionStart", { source: "startup" }, off),
    b.hook("prompt-submit", "UserPromptSubmit", { prompt: "hi" }, off),
  ]) {
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  }
  assert.ok(denied(b.pre(join(sb.main, "src/a.js"))), "still denied once re-enabled");
});

test("a crashed session (dead pid, no SessionEnd) never blocks anyone", async (t) => {
  const sb = sandbox(t);
  const a = sb.session();
  const b = sb.session();
  a.start();
  a.edit(join(sb.main, "src/a.js"));
  b.start();
  assert.ok(denied(b.pre(join(sb.main, "src/b.js"))));
  await a.crash();
  assert.ok(!denied(b.pre(join(sb.main, "src/b.js"))), "dead pid: allowed");
  const status = b.cli(["status"]);
  assert.doesNotMatch(status.stdout, new RegExp(a.short), "status drops the crashed session");
});

test("a stale heartbeat is not confirmed liveness: no deny, and the returning session becomes the junior one", (t) => {
  const sb = sandbox(t);
  const a = sb.session();
  const b = sb.session();
  a.start();
  a.edit(join(sb.main, "src/a.js"));
  // A goes quiet for longer than the stale window (pid still alive).
  const rec = join(sb.home, readdir(sb.home)[0], "sessions", `${a.id}.json`);
  const r = JSON.parse(readFileSync(rec, "utf8"));
  writeFileSync(rec, JSON.stringify({ ...r, seen: Date.now() - 2 * 3600_000 }));
  b.start();
  assert.ok(!denied(b.pre(join(sb.main, "src/b.js"))), "stale owner: allowed");
  b.edit(join(sb.main, "src/b.js"));
  // A comes back: it lost seniority while stale, so now A is the one told to move.
  a.prompt("back again");
  assert.ok(denied(a.pre(join(sb.main, "src/a.js"))));
  assert.ok(!denied(b.pre(join(sb.main, "src/b.js"))));
});

test("the same harness process is one family: /clear and resume never block themselves", (t) => {
  const sb = sandbox(t);
  const a = sb.session();
  const b = sb.session();
  a.start();
  b.start(); // junior
  a.end("clear");
  const a2 = sb.session(sb.main, { harness: a.harness }); // new session id, same process
  const hello = a2.start("clear");
  assert.doesNotMatch(hello.context ?? "", /will be blocked/, "inherits its predecessor's seniority");
  assert.ok(!denied(a2.pre(join(sb.main, "src/a.js"))));
  assert.ok(denied(b.pre(join(sb.main, "src/a.js"))), "the other terminal is still the junior one");
});

test("`claude --resume` (same session id, new OS process) does not retroactively evict a session that took over while it was dead", async (t) => {
  const sb = sandbox(t);
  const a = sb.session();
  const b = sb.session();
  a.start();
  a.edit(join(sb.main, "src/a.js"));
  await a.crash(); // no SessionEnd: A's original pid is confirmed dead

  b.start();
  assert.ok(!denied(b.pre(join(sb.main, "src/b.js"))), "A is dead: B may take over");
  b.edit(join(sb.main, "src/b.js"));

  // A resumes: the same session id (per Claude Code's --resume/--continue), a brand-new harness pid.
  const a2 = sb.session(sb.main, { id: a.id });
  a2.start();
  assert.ok(denied(a2.pre(join(sb.main, "src/a.js"))), "resumed A rejoins as the newcomer, not the senior");
  assert.ok(!denied(b.pre(join(sb.main, "src/b.js"))), "B, which legitimately took over, is not retroactively evicted");
});

const readdir = (p) => readdirSync(p).filter((n) => !n.startsWith("_"));

test("a denied edit elsewhere never costs a session the checkout it owns", (t) => {
  const sb = sandbox(t);
  const wt = sb.worktree("theirs");
  const owner = sb.session(); // owns the main checkout, has not edited yet
  const other = sb.session(wt); // owns the worktree
  owner.start();
  other.start();
  const junior = sb.session(); // arrives in the main checkout last
  junior.start();
  assert.ok(denied(owner.pre(join(wt, "src/a.js"))), "reaching into another session's worktree is denied too");
  assert.ok(denied(junior.pre(join(sb.main, "src/a.js"))), "the owner still holds the main checkout");
  assert.ok(!denied(owner.pre(join(sb.main, "src/a.js"))));
});

test("a worktree-isolated subagent's edits do not move its parent session out of its checkout", (t) => {
  const sb = sandbox(t);
  const parent = sb.session();
  parent.start();
  parent.edit(join(sb.main, "src/a.js"));
  const iso = sb.worktree("agent-iso");
  const sub = { agent_id: "a1b2c3", agent_type: "general-purpose" };
  const edit = (file) => {
    const input = { file_path: file, old_string: "a", new_string: "b" };
    const pre = parent.hook("pre-tool-use", "PreToolUse", { ...sub, tool_name: "Edit", tool_input: input });
    parent.hook("post-tool-use", "PostToolUse", { ...sub, tool_name: "Edit", tool_input: input, tool_response: { success: true } });
    return pre;
  };
  assert.ok(!denied(edit(join(iso, "src/b.js"))));
  const junior = sb.session();
  junior.start();
  assert.ok(denied(junior.pre(join(sb.main, "src/b.js"))), "the parent still owns the main checkout");
});

test("/clear after going stale does not reclaim a checkout another session took meanwhile", (t) => {
  const sb = sandbox(t);
  const a = sb.session();
  a.start();
  const rec = join(sb.home, readdir(sb.home)[0], "sessions", `${a.id}.json`);
  const r = JSON.parse(readFileSync(rec, "utf8"));
  writeFileSync(rec, JSON.stringify({ ...r, seen: Date.now() - 2 * 3600_000 })); // A went quiet
  const b = sb.session();
  b.start();
  b.edit(join(sb.main, "src/b.js")); // B legitimately takes the checkout
  const a2 = sb.session(sb.main, { harness: a.harness }); // A's terminal runs /clear
  a2.start("clear");
  assert.ok(!denied(b.pre(join(sb.main, "src/b.js"))), "B keeps the checkout");
  assert.ok(denied(a2.pre(join(sb.main, "src/a.js"))), "the cleared session is the newcomer");
});

test("a subagent's Bash activity in another checkout does not relocate its parent either", (t) => {
  const sb = sandbox(t);
  const parent = sb.session(); // in the main checkout, has not edited yet
  parent.start();
  const iso = sb.worktree("agent-bash");
  const sub = sb.session(iso, { harness: parent.harness, id: parent.id }); // same session, subagent cwd
  sub.hook("post-tool-use", "PostToolUse", { agent_id: "a1", agent_type: "general-purpose", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {} });
  const junior = sb.session();
  junior.start();
  assert.ok(denied(junior.pre(join(sb.main, "src/a.js"))), "the parent still owns the main checkout");
});

test("a subagent's edit in the parent's own checkout pins the parent there", (t) => {
  const sb = sandbox(t);
  const parent = sb.session();
  parent.start();
  const sub = { agent_id: "a1", agent_type: "general-purpose" };
  const input = { file_path: join(sb.main, "src/a.js"), old_string: "a", new_string: "b" };
  parent.hook("pre-tool-use", "PreToolUse", { ...sub, tool_name: "Edit", tool_input: input });
  parent.hook("post-tool-use", "PostToolUse", { ...sub, tool_name: "Edit", tool_input: input, tool_response: {} });
  parent.cwd = sb.worktree("elsewhere");
  parent.bash(); // main-thread Bash from another worktree
  const junior = sb.session();
  junior.start();
  assert.ok(denied(junior.pre(join(sb.main, "src/b.js"))), "the checkout holding the subagent's edits stays owned");
});

test("parallel edits of one session keep every overlap warning", async (t) => {
  const sb = sandbox(t);
  const a = sb.session(sb.worktree("pa"));
  const b = sb.session(sb.worktree("pb"));
  a.start();
  b.start();
  a.edit(join(a.cwd, "src/a.js"));
  a.edit(join(a.cwd, "src/b.js"));
  const { spawn } = await import("node:child_process");
  const { BIN } = await import("./helpers.mjs");
  const run = (f) => new Promise((res) => {
    const p = spawn(process.execPath, [BIN, "hook", "pre-tool-use"], { env: b.env });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("exit", () => res(out));
    p.stdin.end(JSON.stringify(b.payload("PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(b.cwd, f) } })));
  });
  const outs = await Promise.all([run("src/a.js"), run("src/b.js")]);
  assert.equal(outs.filter((o) => o.includes("was also edited by")).length, 2);
});
