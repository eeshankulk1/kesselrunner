// The usage report. Done when: one command reads a folder of Claude Code transcripts for a date range and gives
// spend by model, lane, agent class and project; one API response written as several lines counts once; output is
// scaled up to a session's own cost record; a caller's role marker beats the keyword guess; ship stages and quality
// signals come from a shipper's calls; machine-typed prompts are not the owner's; a saved baseline compares against a
// later range; and no message text reaches the output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BIN, cleanEnv } from "./helpers.mjs";
import { agentClass, bashHead, isCorrection } from "../src/usage-scan.mjs";
import { build, compare, format, rangeOf, report, scanAll } from "../src/usage-report.mjs";

const SECRET = "zebra-quartz-lighthouse"; // in every prompt: must never show in any output
const T0 = Date.parse("2026-11-03T10:00:00Z");
const at = (min) => new Date(T0 + min * 60_000).toISOString();

let n = 0;
const asst = (min, { model = "claude-opus-5-5", id, ctx = 10_000, out = 100, tools = [] } = {}) => ({
  type: "assistant", timestamp: at(min), cwd: undefined,
  message: { id: id ?? `msg_${++n}`, model, usage: { input_tokens: 0, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, output_tokens: out },
    content: tools.map(([name, input]) => ({ type: "tool_use", id: `tu_${++n}`, name, input })) },
});
const user = (min, text, extra = {}) => ({ type: "user", timestamp: at(min), message: { role: "user", content: text }, ...extra });

/** A response with one more tool call, by a known id. */
const withCall = (rec, block) => ({ ...rec, message: { ...rec.message, content: [...rec.message.content, block] } });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "usage-report-"));
  const repo = "/Users/someone/code/shop";
  const proj = join(root, "-Users-someone-code-shop");
  mkdirSync(join(proj, "s1", "subagents"), { recursive: true });
  const lines = (path, cwd, recs) => writeFileSync(path, recs.map((r) => JSON.stringify({ ...r, cwd, entrypoint: "cli", sessionId: "s1" })).join("\n") + "\n");
  // Main session in a task worktree: an owner prompt, a correction, a machine prompt, a split response, an idle gap.
  const wt = `${repo}/.claude/worktrees/feat-x`;
  lines(join(proj, "s1.jsonl"), wt, [
    user(0, `build the thing ${SECRET}`),
    asst(1, { id: "msg_split", ctx: 250_000, out: 10, tools: [["Read", { file_path: "/a" }]] }),
    asst(1, { id: "msg_split", ctx: 250_000, out: 40, tools: [] }), // the same response's second line
    asst(1.1, { ctx: 260_000, tools: [["Bash", { command: `cd "${wt}" && sed -n 1,20p a.js` }]] }),
    asst(1.2, { ctx: 261_000, tools: [["Grep", { pattern: "x" }]] }),
    user(2, `that's not what I asked ${SECRET}`),
    user(3, "[rollcall] supervisor falcon: why did you stop"), // rollcall's, not the owner's
    asst(70, { ctx: 270_000, tools: [["Skill", { skill: "pr-create" }]] }), // after a 67-minute gap
    asst(71, { ctx: 280_000 }),
    { type: "cost-state", startTime: 1, totalCostUSD: 4.5, modelUsage: { "claude-opus-5-5": { outputTokens: 500 }, "claude-sonnet-5-5": { outputTokens: 100 } } },
  ]);
  // A shipper (marked by its caller), with docs, a push, a CI failure read, a second push and the queue.
  writeFileSync(join(proj, "s1", "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "general-purpose" }));
  lines(join(proj, "s1", "subagents", "agent-a1.jsonl"), wt, [
    user(72, `[role: shipper] ship it ${SECRET}`),
    withCall(asst(73, { tools: [["Agent", { subagent_type: "code-reviewer" }]] }), { type: "tool_use", id: "tu_check", name: "Bash", input: { command: "npm test" } }),
    { type: "user", timestamp: at(75), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_check", content: "ok" }] } },
    asst(75, { tools: [["Agent", { subagent_type: "docs-updater" }]] }),
    asst(80, { tools: [["Bash", { command: "git push -u origin feat/x" }]] }),
    asst(85, { tools: [["Bash", { command: "gh run view 1 --log-failed | tail" }]] }),
    asst(86, { tools: [["Bash", { command: "git push" }]] }),
    asst(90, { tools: [["Bash", { command: "rollcall queue add" }]] }),
    asst(100, {}),
  ]);
  // A named helper on Sonnet.
  writeFileSync(join(proj, "s1", "subagents", "agent-a2.meta.json"), JSON.stringify({ agentType: "code-reviewer", parentAgentId: "a1" }));
  lines(join(proj, "s1", "subagents", "agent-a2.jsonl"), wt, [user(73, `review ${SECRET}`), asst(74, { model: "claude-sonnet-5-5", out: 50 })]);
  // A session outside the range.
  lines(join(proj, "old.jsonl"), repo, [user(-20_000, "old"), asst(-20_000, {})]);
  return root;
}

test("the report: spend, dedupe, cost-state output, classes, shapes, ships, quality, no text", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rep = await report({ root, from: "2026-11-01", to: "2026-11-05", threads: 1 });
  const json = JSON.stringify(rep);
  assert.ok(!json.includes(SECRET), "no prompt text in the report");

  // One row per response: the split message counts once.
  assert.equal(rep.totals.requests, 5 + 7 + 1);
  assert.equal(rep.totals.sessions, 1);
  // Output: transcripts hold 40+100*4=440 Opus main + 700 shipper Opus; the record says 500, less, so no
  // scaling for Opus; Sonnet 50 against 100 scales by 2.
  const sonnet = rep.spend.model.find((r) => r.key === "sonnet-5-5");
  assert.equal(sonnet.requests, 1);
  assert.ok(rep.totals.outputCorrection > 1);

  const groups = Object.fromEntries(rep.spend.agent.map((r) => [r.key, r]));
  assert.ok(groups["main loop"] && groups.shipper && groups["code-reviewer"]);
  assert.equal(rep.spend.lane.find((r) => r.key === "subagent").requests, 8);
  assert.deepEqual(rep.spend.project.map((r) => r.key), ["shop"]);
  assert.equal(rep.spend.kind[0].key.startsWith("task-worker"), true);

  // Shapes.
  assert.equal(rep.shapes.context.requests, 5);
  assert.equal(rep.shapes.idleGaps["over 60 min"].requests, 1);
  assert.equal(rep.shapes.afterFirstPrCreate.tasks, 1);
  assert.equal(rep.shapes.batching.readRuns, 1, "Read, sed, Grep within 20 s is one run");
  assert.equal(rep.shapes.batching.avoidable, 2);

  // Ships: one, with every stage but release; one push before a failure, so no first-run pass.
  assert.equal(rep.shapes.ships.count, 1);
  assert.equal(rep.shapes.ships.wallMedian, 27);
  assert.equal(rep.shapes.ships.stages.docs.median, 5);
  assert.equal(rep.shapes.ships.stages.CI.median, 10);
  assert.equal(rep.shapes.ships.stages["merge queue"].median, 10);
  assert.equal(rep.shapes.ships.stages.release.ships, 0);
  // Its own work before the first push: 2 minutes of commands, a 1-minute review; no docs helper ran under it.
  assert.equal(rep.shapes.ships.phases["to first push"].median, 7);
  assert.equal(rep.shapes.ships.phases.checks.median, 2);
  assert.equal(rep.shapes.ships.phases.review.median, 1);
  assert.equal(rep.shapes.ships.phases.docs.ships, 0);
  assert.equal(rep.quality.firstRunCiPass, 0);
  assert.equal(rep.quality.pushesPerShip, 2);
  assert.equal(rep.quality.reviewsPerShip, 1);
  assert.equal(rep.quality.ciFailuresPerShip, 1);
  // Owner prompts: two of theirs (rollcall's line is not), one a correction.
  assert.equal(rep.quality.ownerPrompts, 2);
  assert.equal(rep.quality.corrections, 1);

  // A baseline compared with itself moves nothing; with a changed one, the change shows.
  const same = compare(rep, rep);
  assert.ok(same.every((r) => r.delta === 0 || r.delta === null));
  const later = structuredClone(rep);
  later.quality.pushesPerShip = 1;
  assert.equal(compare(rep, later).find((r) => r.key === "quality.pushesPerShip").delta, -1);
});

test("ships by shipper model: quality, the spend before the first push, and step-ups", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "usage-report-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wt = "/Users/someone/code/shop/.claude/worktrees/feat-y";
  const dir = join(root, "-Users-someone-code-shop", "s2", "subagents");
  mkdirSync(dir, { recursive: true });
  const agent = (id, recs) => {
    writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: "general-purpose" }));
    writeFileSync(join(dir, `agent-${id}.jsonl`), recs.map((r) => JSON.stringify({ ...r, cwd: wt, entrypoint: "cli", sessionId: "s2" })).join("\n") + "\n");
  };
  const sonnet = "claude-sonnet-5-5";
  // An Opus shipper that pushes once and passes; a Sonnet one that stops before any push; the Opus step-up after it.
  agent("o1", [user(0, `[role: shipper] ship ${SECRET}`), asst(1, { tools: [["Agent", { subagent_type: "code-reviewer" }]] }), asst(2), asst(3, { tools: [["Bash", { command: "git push -u origin HEAD" }]] }), asst(4)]);
  agent("s1", [user(10, `[role: shipper] ship ${SECRET}`), asst(11, { model: sonnet }), asst(12, { model: sonnet }), asst(13, { model: sonnet })]);
  agent("o2", [user(20, `[role: shipper] [step-up] ship ${SECRET}`), asst(21), asst(22, { tools: [["Bash", { command: "git push" }]] })]);
  const rep = await report({ root, from: "2026-11-01", to: "2026-11-05", threads: 1 });
  const bm = rep.quality.byShipperModel;
  assert.deepEqual(Object.keys(bm), ["opus-5-5", "sonnet-5-5"], "most ships first");
  assert.equal(bm["opus-5-5"].ships, 2);
  assert.equal(bm["opus-5-5"].stepUps, 1);
  assert.equal(bm["opus-5-5"].firstRunCiPass, 100);
  assert.equal(bm["opus-5-5"].reviewsPerShip, 0.5);
  assert.equal(bm["opus-5-5"].prePushRequestsMedian, 1.5, "2 requests before the push, then 1");
  assert.equal(bm["sonnet-5-5"].ships, 1);
  assert.equal(bm["sonnet-5-5"].firstRunCiPass, null, "it never pushed");
  assert.equal(bm["sonnet-5-5"].prePushRequestsMedian, 3, "no push: every request counts");
  assert.ok(bm["sonnet-5-5"].prePushMedianM > 0 && bm["sonnet-5-5"].prePushMedianM < bm["opus-5-5"].prePushMeanM * 3);
  const text = format(rep);
  assert.match(text, /Ships by shipper model/);
  assert.ok(!text.includes(SECRET) && !JSON.stringify(rep).includes(SECRET));
  assert.equal(compare(rep, rep).find((r) => r.key === "quality.byShipperModel.sonnet-5-5.ships").delta, 0);
});

test("scanning in worker threads gives what scanning inline gives", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Enough files to take the thread path.
  for (let i = 0; i < 25; i++) {
    const p = join(root, `-tmp-p${i}`);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, `x${i}.jsonl`), [user(0, "hi"), asst(1, {})].map((r) => JSON.stringify({ ...r, cwd: `/tmp/p${i}`, entrypoint: "cli" })).join("\n"));
  }
  const range = rangeOf({ from: "2026-11-01", to: "2026-11-05" });
  const a = build(await scanAll({ root, from: range.from, threads: 1 }), range);
  const b = build(await scanAll({ root, from: range.from, threads: 3 }), range);
  assert.deepEqual(b, a);
  assert.equal(a.totals.sessions, 26);
});

test("the CLI: report, save, baselines, compare, forget, and usage errors", (t) => {
  const root = fixture();
  const home = mkdtempSync(join(tmpdir(), "usage-home-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  const run = (...args) => spawnSync(process.execPath, [BIN, "usage", ...args, ...(args[0] === "baselines" || args[0] === "forget" ? [] : ["--transcripts", root])], { encoding: "utf8", env: cleanEnv({ ROLLCALL_HOME: home }) });
  const r = run("report", "--from", "2026-11-01", "--to", "2026-11-05", "--save", "before");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Usage 2026-11-01 to 2026-11-05 \(5 days\)/);
  assert.match(r.stdout, /By agent/);
  assert.ok(!r.stdout.includes(SECRET));
  assert.match(r.stderr, /saved as baseline "before"/);
  assert.match(run("baselines").stdout, /^before {2}2026-11-01 to 2026-11-05/);
  const c = run("compare", "before", "--from", "2026-11-03", "--to", "2026-11-03", "--json");
  assert.equal(c.status, 0, c.stderr);
  assert.equal(JSON.parse(c.stdout).baseline, "before");
  assert.equal(run("compare", "nope").status, 1);
  assert.equal(run("report", "--from", "nonsense").status, 1);
  assert.equal(run("report", "--save", "../escape").status, 1);
  assert.equal(run("forget", "before").status, 0);
  assert.match(run("baselines").stdout, /no baselines saved yet/);
});

test("pieces: role markers, the keyword fallback, bash heads, corrections", () => {
  assert.equal(agentClass("general-purpose", "[role: implementer] fix it").cls, "implementer");
  assert.equal(agentClass("general-purpose", "You are the shipper. Read SKILL.md").cls, "shipper");
  assert.equal(agentClass("general-purpose", "implement the API in /r/.claude/worktrees/x").cls, "implementer");
  assert.equal(agentClass("general-purpose", "investigate why the build is slow").cls, "research");
  assert.equal(agentClass("code-reviewer", "review this").cls, "code-reviewer");
  assert.equal(bashHead('cd "/a b/c" && FOO=1 git status'), "git");
  assert.equal(bashHead("sed -n 1,5p x"), "read:sed");
  assert.equal(bashHead("gh pr checks 3 --watch"), "sleep/wait/watch");
  assert.ok(isCorrection("I told you to use the other one"));
  assert.ok(!isCorrection("looks good, ship it"));
  assert.throws(() => rangeOf({ from: "2026-11-05", to: "2026-11-01" }), /empty/);
  assert.deepEqual(rangeOf({ days: 7 }, Date.parse("2026-11-12T15:00:00Z")), { from: Date.parse("2026-11-06T00:00:00Z"), to: Date.parse("2026-11-13T00:00:00Z") });
});
