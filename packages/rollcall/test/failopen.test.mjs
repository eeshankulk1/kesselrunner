// Hooks fail open: any internal error is exit 0 with no output, and nothing
// is injected when nothing relevant changed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BIN, runHook, sandbox } from "./helpers.mjs";

test("malformed or empty payloads exit 0 silently", (t) => {
  const sb = sandbox(t);
  for (const [arg, input] of [
    ["pre-tool-use", "{not json"],
    ["pre-tool-use", ""],
    ["post-tool-use", "[]"],
    ["session-start", JSON.stringify({ cwd: sb.main })], // no session_id
    ["pre-tool-use", JSON.stringify({ session_id: "x", tool_name: "Edit", tool_input: { file_path: 42 } })],
    ["no-such-event", JSON.stringify({ session_id: "x", cwd: sb.main })],
  ]) {
    const r = runHook(arg, null, sb.env, input);
    assert.equal(r.code, 0, `${arg} ${input}`);
    assert.equal(r.stdout, "", `${arg} ${input}`);
    assert.equal(r.stderr, "", `${arg} ${input}`);
  }
});

test("an unusable store (ROLLCALL_HOME is a file) fails open, even when a deny would apply", (t) => {
  const sb = sandbox(t);
  const a = sb.session();
  const b = sb.session();
  a.start();
  b.start();
  const broken = join(sb.root, "not-a-dir");
  writeFileSync(broken, "");
  for (const s of [a, b]) s.env.ROLLCALL_HOME = broken;
  for (const r of [b.start(), b.pre(join(sb.main, "src/a.js")), b.post(join(sb.main, "src/a.js")), b.prompt("x"), b.stop(), b.end()]) {
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  }
});

test("a hook that cannot finish in its budget exits 0 with no output", async (t) => {
  const sb = sandbox(t);
  // stdin that never closes: the budget timer ends the hook.
  const p = spawn(process.execPath, [BIN, "hook", "pre-tool-use"], { env: { ...sb.env, ROLLCALL_HOOK_BUDGET_MS: "300" }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  const t0 = Date.now();
  const code = await new Promise((res) => p.on("exit", res));
  assert.equal(code, 0);
  assert.equal(out, "");
  assert.ok(Date.now() - t0 < 2000);
});

test("no notice when nothing relevant changed", (t) => {
  const sb = sandbox(t);
  const wt = sb.worktree("solo");
  const a = sb.session(wt);
  const b = sb.session(sb.worktree("elsewhere"));
  assert.equal(a.start().stdout, "");
  b.start(); // a peer exists, but has nothing to do with a's files
  b.edit(join(b.cwd, "src/b.js"));
  for (const r of [a.prompt("go"), a.pre(join(wt, "src/a.js")), a.post(join(wt, "src/a.js")), a.bash(), a.stop(), a.prompt("again")]) {
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "", "quiet");
  }
});

test("a cwd outside any git checkout is ignored", (t) => {
  const sb = sandbox(t);
  const s = sb.session(sb.root);
  for (const r of [s.start(), s.prompt("hello"), s.bash(), s.stop(), s.end()]) assert.equal(r.stdout, "");
});
