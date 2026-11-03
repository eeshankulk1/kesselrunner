// The real identity path, no test overrides: hooks find their harness by
// walking process ancestry, and the CLI finds its session the same way.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { BIN, FIXTURES, sandbox } from "./helpers.mjs";

const NODE = process.execPath;
const HARNESS = join(FIXTURES, "harness.mjs");

class Harness {
  constructor(sb) {
    this.p = sb.track(spawn(NODE, [HARNESS], { env: sb.env, stdio: ["pipe", "pipe", "inherit"] }));
    this.waiting = [];
    createInterface({ input: this.p.stdout }).on("line", (l) => this.waiting.shift()(JSON.parse(l)));
  }
  get pid() { return this.p.pid; }
  run(cmd, input = "") {
    return new Promise((res) => { this.waiting.push(res); this.p.stdin.write(`${JSON.stringify({ cmd, input })}\n`); });
  }
  hook(event, payload) { return this.run(`"${NODE}" "${BIN}" hook ${event}`, JSON.stringify(payload)); }
  cli(args, cwd) { return this.run(`cd "${cwd}" && "${NODE}" "${BIN}" ${args}`); }
}

const payload = (id, cwd, event, extra = {}) => ({ session_id: id, cwd, hook_event_name: event, transcript_path: "/tmp/t.jsonl", ...extra });

test("hooks record the harness pid; the CLI resolves its own session from process ancestry", async (t) => {
  const sb = sandbox(t);
  const h = new Harness(sb);
  const id = randomUUID();
  const r = await h.hook("session-start", payload(id, sb.main, "SessionStart", { source: "startup" }));
  assert.equal(r.code, 0);
  const g = JSON.parse(readFileSync(join(sb.home, "_sessions", `${id}.json`), "utf8"));
  assert.equal(g.pid, h.pid, "the harness is the first non-shell ancestor of the hook");

  const claim = await h.cli(`claim "ancestry works"`, sb.main);
  assert.equal(claim.code, 0, claim.stderr);
  const status = await h.cli("status", sb.main);
  assert.match(status.stdout, new RegExp(`\\* ${id.slice(0, 8)} .*<- you`));
  assert.match(status.stdout, /claim: "ancestry works"/);
});

test("a harness running inside another session's harness is the same family: never denied by its parent", async (t) => {
  const sb = sandbox(t);
  const outer = new Harness(sb);
  const parent = randomUUID();
  await outer.hook("session-start", payload(parent, sb.main, "SessionStart"));

  // A nested harness (think `claude -p` or a delegated worker) started from inside the parent.
  const child = randomUUID();
  const lines = [
    { cmd: `"${NODE}" "${BIN}" hook session-start`, input: JSON.stringify(payload(child, sb.main, "SessionStart")) },
    { cmd: `"${NODE}" "${BIN}" hook pre-tool-use`, input: JSON.stringify(payload(child, sb.main, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(sb.main, "src/a.js") } })) },
  ].map((l) => JSON.stringify(l)).join("\n");
  const nested = await outer.run(`"${NODE}" "${HARNESS}"`, `${lines}\n`);
  const [start, pre] = nested.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(start.stdout, "", "the parent is family, not a peer");
  assert.equal(pre.stdout, "", "not denied, not warned");

  // Control: an unrelated harness in the same checkout is denied.
  const other = new Harness(sb);
  const stranger = randomUUID();
  await other.hook("session-start", payload(stranger, sb.main, "SessionStart"));
  const denied = await other.hook("pre-tool-use", payload(stranger, sb.main, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(sb.main, "src/a.js") } }));
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
});
