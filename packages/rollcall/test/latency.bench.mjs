// Hook overhead on the hot path (PreToolUse, PostToolUse), measured end to end
// the way the harness pays for it: spawn node, pipe the payload, wait for exit.
// Target ~50 ms; the assertion ceiling is looser so a busy machine does not flake.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sandbox } from "./helpers.mjs";

const RUNS = Number(process.env.ROLLCALL_BENCH_RUNS) || 25;
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] };
};
const fmt = ({ median, p95 }) => `median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`;

test("hot-path hook latency", async (t) => {
  const sb = sandbox(t);
  // A realistic store: four peers in their own worktrees with edits and claims, and ~100 events of history.
  for (let i = 0; i < 4; i++) {
    const wt = sb.worktree(`peer-${i}`);
    const s = sb.session(wt);
    s.start();
    s.prompt(`peer ${i} task`);
    s.cli(["claim", `peer ${i} claim`, "--scope", `src/p${i}/**`]);
    for (const f of ["src/a.js", `src/p${i}/x.js`, `src/p${i}/y.js`]) s.edit(join(wt, f));
  }
  process.env.ROLLCALL_HOME = sb.home;
  t.after(() => { delete process.env.ROLLCALL_HOME; });
  const store = await import("../src/store.mjs");
  const key = readdirSync(sb.home).find((n) => !n.startsWith("_"));
  for (let m = 0; m < 100; m++) store.appendEvent(key, { type: "msg", session: "peer", who: "peer", to: "all", text: `note ${m}` });
  const wt = sb.worktree("me");
  const me = sb.session(wt);
  me.start();
  me.prompt("measure");
  me.bash(); // drain the backlog once

  const node = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    spawnSync(process.execPath, ["-e", "0"]);
    node.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const results = {
    "node -e 0 (baseline)": node,
    "PreToolUse Edit": [],
    "PostToolUse Edit": [],
    "PostToolUse Bash": [],
    "PreToolUse Bash (no git)": [],
    "PreToolUse Bash (git)": [],
    "UserPromptSubmit": [],
  };
  for (let i = 0; i < RUNS; i++) {
    const f = join(wt, `src/bench-${i % 5}.js`);
    results["PreToolUse Edit"].push(me.pre(f).ms);
    results["PostToolUse Edit"].push(me.post(f).ms);
    results["PostToolUse Bash"].push(me.bash().ms);
    results["PreToolUse Bash (no git)"].push(me.bashPre("npm test").ms);
    results["PreToolUse Bash (git)"].push(me.bashPre("git status && git checkout -b x").ms);
    results["UserPromptSubmit"].push(me.prompt("next").ms);
  }
  const lines = Object.entries(results).map(([k, v]) => `${k.padEnd(22)} ${fmt(stats(v))}`);
  for (const l of lines) t.diagnostic(l);
  if (process.env.ROLLCALL_BENCH_PRINT) console.log(lines.join("\n"));
  for (const k of ["PreToolUse Edit", "PostToolUse Edit", "PostToolUse Bash", "PreToolUse Bash (no git)", "PreToolUse Bash (git)"]) {
    assert.ok(stats(results[k]).median < 150, `${k}: ${fmt(stats(results[k]))}`);
  }
});
