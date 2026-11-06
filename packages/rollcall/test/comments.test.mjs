// Done when (plan 2026-11-06-review-loop, line comments): the owner leaves three comments on two files of a running
// task from the terminal; the worker receives them as one batch, fixes two and answers one, and the task shows all
// three resolved. A comment whose lines moved finds its place, one whose lines are gone says it went stale, and a
// file or line that does not exist is refused.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, sandbox, write } from "./helpers.mjs";

const json = (r) => { assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout); };
const ok = (r) => { assert.equal(r.code, 0, r.stderr); return r.stdout; };
const worker = { env: { ROLLCALL_TASK: "alpha:t1" } };
const outbox = (sb) => { try { return JSON.parse(readFileSync(join(sb.home, "_supervisors/alpha/outbox-t1.json"), "utf8")); } catch { return []; } };
const wakes = (sb) => { try { return readdirSync(join(sb.home, "_supervisors/alpha/wake")).filter((n) => n.startsWith("q-")).map((n) => JSON.parse(readFileSync(join(sb.home, "_supervisors/alpha/wake", n), "utf8"))); } catch { return []; } };
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}`).join("\n") + "\n";

function setup(t) {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  ok(sup.cli(["supervise", "alpha"]));
  ok(sup.cli(["task", "new", "review me", "--repo", sb.main]));
  const wt = json(sup.cli(["task", "show", "t1", "--json"])).worktree;
  // The task's work: a.js rewritten and committed, b.js changed in the working tree only.
  write(join(wt, "src/a.js"), lines(8, "a"));
  git(wt, "commit", "-qam", "work");
  write(join(wt, "src/b.js"), lines(5, "b"));
  return { sb, sup, wt };
}

test("three comments on two files go to the worker as one batch; it fixes two, answers one, and all three show resolved", (t) => {
  const { sb, sup, wt } = setup(t);
  // The owner, from a plain terminal: no session of rollcall's.
  const owner = (args) => sup.cli(args, { env: { ROLLCALL_SESSION: "" } });

  assert.match(ok(owner(["task", "comment", "t1", "src/a.js:2", "name this for what it holds"])), /^t1: comment #1 on src\/a\.js:2; 1 waiting to be sent/);
  ok(owner(["task", "comment", "t1", "src/a.js:4-5", "these two lines repeat each other"]));
  ok(sup.cli(["task", "comment", "t1", `${wt}/src/b.js:3`, "why a string here?"]));
  let all = json(sup.cli(["task", "comments", "t1", "--json"])).comments;
  assert.deepEqual(all.map((c) => [c.n, c.file, c.line, c.end, c.state]), [[1, "src/a.js", 2, 2, "pending"], [2, "src/a.js", 4, 5, "pending"], [3, "src/b.js", 3, 3, "pending"]]);
  assert.match(all[0].hunk, /^@@ .*\n[\s\S]*\+a line 2/, "the hunk it was written against, from the committed diff");
  assert.match(all[2].hunk, /\+b line 3/, "and from the working tree's");
  assert.deepEqual(outbox(sb), [], "nothing goes out until the owner sends");
  assert.match(ok(sup.cli(["task", "show", "t1"])), /review comments: 3 open \(3 not sent\), 0 resolved/);

  // A worker answers comments; it does not leave or send them.
  assert.match(sup.cli(["task", "comment", "t1", "src/a.js:1", "x"], worker).stderr, /review comments are the owner's/);
  assert.match(sup.cli(["task", "comments", "t1", "send"], worker).stderr, /a worker answers them/);

  assert.match(ok(sup.cli(["task", "comments", "t1", "send"])), /^t1: 3 comments \(#1, #2, #3\) sent as one message, on its queue/);
  const queued = outbox(sb);
  assert.equal(queued.length, 1, "one item on the delivery queue for all three");
  assert.equal(queued[0].kind, "notice");
  const text = queued[0].text;
  assert.match(text, /^\[rollcall\] 3 review comments from the owner on task t1's diff/);
  assert.match(text, /task comments t1 resolve <n> "<what you changed>"/);
  assert.match(text, /task comments t1 reply <n> "<your answer>"/);
  assert.match(text, /#1 src\/a\.js:2\n {5}1  a line 1\n>    2  a line 2\n {5}3  a line 3\n {5}4  a line 4\nThe owner: name this for what it holds/);
  assert.match(text, /#2 src\/a\.js:4-5\n[\s\S]*>    4  a line 4\n>    5  a line 5\n[\s\S]*The owner: these two lines repeat each other/);
  assert.match(text, /#3 src\/b\.js:3\n[\s\S]*>    3  b line 3\n[\s\S]*The owner, through the supervisor: why a string here\?/);
  all = json(sup.cli(["task", "comments", "t1", "--json"])).comments;
  assert.deepEqual(all.map((c) => [c.state, c.delivered]), [["sent", false], ["sent", false], ["sent", false]]);
  assert.match(sup.cli(["task", "comments", "t1", "send"]).stderr, /no comments waiting to be sent/, "a second send sends nothing twice");
  assert.equal(outbox(sb).length, 1);

  // The worker fixes two and answers the third.
  write(join(wt, "src/a.js"), lines(8, "a").replace("a line 2", "a total").replace("a line 5\n", ""));
  assert.match(ok(sup.cli(["task", "comments", "t1", "resolve", "1", "renamed it to total"], worker)), /^t1: comment #1 resolved \(fixed\); 2 still open/);
  ok(sup.cli(["task", "comments", "t1", "resolve", "2", "dropped the repeat"], worker));
  assert.match(ok(sup.cli(["task", "comments", "t1", "reply", "3", "the API sends it as a string"], worker)), /^t1: comment #3 resolved \(answered\); none open/);
  all = json(sup.cli(["task", "comments", "t1", "--json"])).comments;
  assert.deepEqual(all.map((c) => [c.n, c.state, c.resolved.how, c.resolved.by]), [[1, "resolved", "fixed", "worker"], [2, "resolved", "fixed", "worker"], [3, "resolved", "answered", "worker"]]);
  assert.equal(all[2].reply.text, "the API sends it as a string");
  assert.match(ok(sup.cli(["task", "show", "t1"])), /review comments: none open, 3 resolved/);
  const listed = ok(sup.cli(["task", "comments", "t1"]));
  assert.match(listed, /#1 resolved +src\/a\.js:2 +the owner: name this[\s\S]*resolved: renamed it to total/);
  assert.match(listed, /#3 resolved +src\/b\.js:3 .*\n +its worker replied: the API sends it as a string/);
  assert.equal(json(sup.cli(["task", "show", "t1", "--json"])).comments.length, 3);
  assert.equal(sup.cli(["task", "comments", "t1", "resolve", "9", "x"], worker).code, 1);
});

test("a comment whose lines moved finds them; one whose lines are gone says it went stale; reply --open stays for the owner", (t) => {
  const { sb, sup, wt } = setup(t);
  ok(sup.cli(["task", "comment", "t1", "src/a.js:6", "keep this one"]));
  ok(sup.cli(["task", "comment", "t1", "src/b.js:2-3", "these go"]));
  // Two lines added above a.js:6 move it to 8; b.js's lines 2-3 are deleted.
  write(join(wt, "src/a.js"), `new 1\nnew 2\n${lines(8, "a")}`);
  write(join(wt, "src/b.js"), "b line 1\nb line 4\nb line 5\n");
  const all = json(sup.cli(["task", "comments", "t1", "--json"])).comments;
  assert.deepEqual(all[0].now, { at: "moved", line: 8, end: 8 });
  assert.equal(all[1].now.at, "stale");
  const listed = ok(sup.cli(["task", "comments", "t1"]));
  assert.match(listed, /#1 pending +src\/a\.js:8 \(was line 6\)/);
  assert.match(listed, /#2 pending +src\/b\.js:2-3 \(stale: the lines are no longer in src\/b\.js\)/);
  assert.match(ok(sup.cli(["task", "show", "t1"])), /review comments: 2 open \(2 not sent, 1 stale\)/);

  ok(sup.cli(["task", "comments", "t1", "send"]));
  const text = outbox(sb)[0].text;
  assert.match(text, /#1 src\/a\.js:8 \(was line 6\)\n[\s\S]*>    8  a line 6/, "the batch points at where the lines are now");
  assert.match(text, /#2 src\/b\.js:2-3 \(stale: [^)]*\)\nThese lines changed since the owner wrote this[\s\S]*>    2  b line 2\n>    3  b line 3/, "and shows a stale comment's lines as written");

  // A question only the owner can answer stays open, and reaches the supervisor as a reply.
  assert.match(ok(sup.cli(["task", "comments", "t1", "reply", "2", "delete the whole file instead?", "--open"], worker)), /^t1: comment #2 answered, left open for the owner; 2 still open/);
  assert.equal(json(sup.cli(["task", "comments", "t1", "--json"])).comments[1].state, "answered");
  assert.ok(wakes(sb).some((w) => w.task === "t1" && w.kind === "reply"));
  assert.match(json(sup.cli(["task", "show", "t1", "--json"])).notes.at(-1).text, /^reply: on review comment #2 \(src\/b\.js:2-3, "these go"\): delete the whole file instead\?/);
  // The owner settles it.
  assert.match(ok(sup.cli(["task", "comments", "t1", "resolve", "2", "yes, delete it"])), /comment #2 resolved \(fixed\); 1 still open/);
});

test("a file or line that is not in the worktree is refused in plain words", (t) => {
  const { sup } = setup(t);
  const fails = (where, re) => { const r = sup.cli(["task", "comment", "t1", where, "x"]); assert.equal(r.code, 1); assert.match(r.stderr, re); };
  fails("src/nope.js:1", /src\/nope\.js does not exist in t1's worktree/);
  fails("src/a.js:9", /src\/a\.js has 8 lines: there is no line 9/);
  fails("src/a.js:0", /there is no line 0/);
  fails("src/a.js:3-2", /the range ends before it starts/);
  fails("src/a.js:7-12", /past the file's last line \(8\)/);
  fails("../outside.js:1", /is not inside t1's worktree/);
  fails("src/a.js", /<file>:<line>/);
  fails("src", /<file>:<line>/);
  assert.match(sup.cli(["task", "comment", "t1", "src/a.js:1"]).stderr, /usage: rollcall task comment/);
  assert.deepEqual(json(sup.cli(["task", "comments", "t1", "--json"])).comments, []);
});
