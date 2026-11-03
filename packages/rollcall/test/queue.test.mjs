// The merge queue. Done when: a PR joins only when it is open, pushed and green; the lander lands
// ready PRs in trains, each train checked once as one tree and merged as that tree; a conflict, a red
// check or a fix that weakens the tests goes back to the right entry's session (or parks it for the
// owner); and each session hears its own news through `queue wait` and its hooks.
import assert from "node:assert/strict";
import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { BIN, FIXTURES, git, sandbox, until, write } from "./helpers.mjs";

const GH = join(FIXTURES, "gh");
chmodSync(GH, 0o755);

/** A sandbox with a fake GitHub: `ci` decides the checks, `manifest` the project's queue settings. */
function repo(t, { manifest = { release: { merge: "merge" } }, ci = [{ name: "test" }], files = {} } = {}) {
  const sb = sandbox(t);
  write(join(sb.main, ".claude/test-manifest.json"), JSON.stringify(manifest));
  for (const [f, text] of Object.entries(files)) write(join(sb.main, f), text);
  // The lander waits on CI only where a workflow runs on PRs.
  if (ci.length) write(join(sb.main, ".github/workflows/ci.yml"), "on: pull_request\n");
  git(sb.main, "add", "-A");
  git(sb.main, "commit", "-qm", "setup");
  git(sb.main, "push", "-q", "origin", "main");
  const state = join(sb.root, "gh.json");
  writeFileSync(state, JSON.stringify({ next: 1, prs: [], ci }));
  sb.env = {
    // No mergiraf unless a test asks for one: a developer's own install must not resolve conflicts a test expects to bounce.
    ...sb.env, PATH: `${join(FIXTURES, "mergiraf-off")}:${sb.env.PATH}`, ROLLCALL_GH: GH, FAKE_GH_STATE: state, FAKE_GH_ORIGIN: sb.origin, ROLLCALL_QUEUE_LANDER: "0",
    ROLLCALL_QUEUE_POLL_MS: "50", ROLLCALL_QUEUE_NO_CHECKS_MS: "200",
  };
  const gh = () => JSON.parse(readFileSync(state, "utf8"));
  const setGh = (fn) => { const s = gh(); fn(s); writeFileSync(state, JSON.stringify(s)); };
  /** One lander run until a round changes nothing. */
  const lander = () => {
    const r = spawnSync(process.execPath, [BIN, "-C", sb.main, "queue", "lander", "--once"], { encoding: "utf8", env: sb.env });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  const originHas = (path) => spawnSync("git", ["-C", sb.origin, "cat-file", "-e", `main:${path}`]).status === 0;
  return { ...sb, gh, setGh, lander, originHas };
}

/** A session on branch `name` in its own worktree, its change committed, pushed and (by default) a PR open. */
function shipper(sb, name, changes, { pr = true, from = null, base = "main", wt = sb.worktree(name) } = {}) {
  if (from) git(wt, "reset", "-q", "--hard", `origin/${from}`);
  const s = sb.session(wt);
  s.start();
  s.prompt(`ship ${name}`);
  for (const [f, text] of Object.entries(changes)) write(join(wt, f), text);
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", `${name}: ${Object.keys(changes).join(", ")}`);
  git(wt, "push", "-q", "-u", "origin", "HEAD");
  let number = null;
  if (pr) {
    const r = spawnSync(GH, ["pr", "create", "--base", base, "--head", git(wt, "branch", "--show-current"), "--title", name, "--body", `${name}\n\nDocs-skip: docs/x.md - nothing here changes behavior`], { encoding: "utf8", env: sb.env });
    number = Number(/\/pull\/(\d+)/.exec(r.stdout)[1]);
  }
  return Object.assign(s, { wt, pr: number, q: (...args) => s.cli(["queue", ...args]) });
}

const prOf = (sb, n) => sb.gh().prs.find((p) => p.number === n);
const landerLog = (sb) => readdirSync(sb.home).map((d) => { try { return readFileSync(join(sb.home, d, "queue", "lander.log"), "utf8"); } catch { return ""; } }).join("");
const outcomes = (sb, key) => JSON.parse(spawnSync(process.execPath, [BIN, "-C", sb.main, "queue", "status", "--json"], { encoding: "utf8", env: sb.env }).stdout).recent;

test("add takes only a PR that is open, pushed, green and clean", (t) => {
  const sb = repo(t);
  const a = shipper(sb, "feat-a", { "src/a.js": "a\n" }, { pr: false });
  assert.match(a.q("add").stderr, /no PR for feat-a/);
  spawnSync(GH, ["pr", "create", "--base", "main", "--head", "feat-a", "--title", "a"], { env: sb.env });
  write(join(a.wt, "src/a.js"), "dirty\n");
  assert.match(a.q("add").stderr, /uncommitted work \(src\/a\.js\)/);
  git(a.wt, "commit", "-qam", "more");
  assert.match(a.q("add").stderr, /HEAD \([0-9a-f]{8}\) is not what origin has for feat-a/);
  git(a.wt, "push", "-q");
  sb.setGh((s) => { s.ci = [{ name: "test", pending: true }]; });
  assert.match(a.q("add").stderr, /checks are still running \(test\)/);
  sb.setGh((s) => { s.ci = [{ name: "test", failIfGrep: "dirty" }]; });
  assert.match(a.q("add").stderr, /has red checks: test/);
  sb.setGh((s) => { s.ci = [{ name: "test" }]; });
  const ok = a.q("add");
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /#1 \(feat-a\) joined: place 1 of 1\./);
  assert.match(a.q("status").stdout, /1\. #1 feat-a, ready just now: src\/a\.js/);
  // On the default branch there is nothing to queue.
  const s = sb.session();
  s.start();
  assert.match(s.cli(["queue", "add"]).stderr, /nothing to queue from the default branch/);
});

test("two PRs that do not collide land as one train: one tree, one train PR, both marked merged", async (t) => {
  const sb = repo(t);
  const a = shipper(sb, "feat-a", { "src/a.js": "from a\n" });
  const b = shipper(sb, "feat-b", { "src/b.js": "from b\n" });
  assert.equal(a.q("add").code, 0);
  assert.equal(b.q("add").code, 0);
  assert.match(b.q("status").stdout, /2\. #2 feat-b/);
  const w = a.cliAsync(["queue", "wait"]);
  sb.lander();
  const { code, stdout } = await w.exited;
  assert.equal(code, 0);
  assert.match(stdout, /^\[rollcall\] queue: landed - #1 landed on main as [0-9a-f]{8} in merge train 1 \(PR #3, with #2\)\./);

  const s = sb.gh();
  const train = s.prs.find((p) => p.headRefName === "mq/1");
  assert.equal(train.state, "MERGED");
  assert.match(train.body, /lands #1 \(feat-a\), #2 \(feat-b\)/);
  assert.match(train.body, /^Docs-skip: docs\/x\.md - nothing here changes behavior$/m, "the entries' waivers ride along");
  assert.deepEqual([prOf(sb, 1).state, prOf(sb, 2).state], ["MERGED", "MERGED"], "GitHub marks a PR merged once its head is in main");
  assert.ok(sb.originHas("src/a.js") && sb.originHas("src/b.js"));
  assert.equal(spawnSync("git", ["-C", sb.origin, "rev-parse", "--verify", "-q", "refs/heads/mq/1"]).status, 1, "the train branch is gone");
  assert.equal(git(sb.origin, "rev-parse", "main^2"), train.lastHead, "main's merge brings in exactly the train's tree");

  // B hears it on its next tool call; A heard it from the wait.
  assert.match(b.bash().context, /\[rollcall\] merge queue: #2 landed on main as [0-9a-f]{8} in merge train 1 \(PR #3, with #1\).* If you started a shipper and its report has not come, it has this from its queue wait and acts on it: leave it to the shipper\./);
  assert.match(b.q("wait").stdout, /queue: landed - #2 landed/);
  assert.match(b.q("status").stdout, /0 waiting; no lander running/);
});

test("a train of one whose head holds main merges its own PR; a squash repo lands one at a time", (t) => {
  const sb = repo(t, { manifest: { release: { merge: "squash" } } });
  const a = shipper(sb, "feat-a", { "src/a.js": "from a\n" });
  const b = shipper(sb, "feat-b", { "src/b.js": "from b\n" });
  a.q("add");
  b.q("add");
  const bHead = git(b.wt, "rev-parse", "HEAD");
  sb.lander();
  const s = sb.gh();
  assert.ok(!s.prs.some((p) => p.headRefName.startsWith("mq/")), "no train PRs");
  assert.deepEqual([prOf(sb, 1).state, prOf(sb, 2).state], ["MERGED", "MERGED"]);
  assert.match(git(sb.origin, "log", "-2", "--format=%s", "main"), /^feat-b \(#2\)\nfeat-a \(#1\)$/);
  // B was cut before A landed: the lander merged main into its branch first, so its checks ran on the tree that landed.
  const pushed = prOf(sb, 2).lastHead;
  assert.notEqual(pushed, bHead);
  assert.equal(git(sb.origin, "rev-parse", `${pushed}^2`), bHead);
  assert.ok(s.calls.some((c) => c.join(" ") === `pr merge 2 --squash --match-head-commit ${pushed}`));
});

test("a conflict with main goes back to its session with the files; one with an earlier entry waits for it", (t) => {
  const sb = repo(t);
  const a = shipper(sb, "feat-a", { "src/a.js": "from a\n" });
  const b = shipper(sb, "feat-b", { "src/a.js": "from b\n" });
  const c = shipper(sb, "feat-c", { "src/b.js": "from c\n" });
  a.q("add");
  b.q("add");
  c.q("add");
  sb.lander();
  const recent = outcomes(sb);
  assert.deepEqual(recent.map((o) => [o.pr, o.kind]), [[1, "landed"], [3, "landed"], [2, "conflict"]]);
  assert.match(recent[2].text, /^#2 conflicts with main in: src\/a\.js\. Next: git fetch origin && git merge origin\/main/);
  assert.match(b.q("wait").stdout, /queue: conflict - #2 conflicts with main in: src\/a\.js/);
  // B resolves, pushes, and joins again; it lands.
  git(b.wt, "fetch", "-q", "origin");
  spawnSync("git", ["-C", b.wt, "merge", "-q", "origin/main"], { env: sb.env });
  write(join(b.wt, "src/a.js"), "from a and b\n");
  git(b.wt, "commit", "-qam", "resolve");
  git(b.wt, "push", "-q");
  assert.equal(b.q("add").code, 0);
  sb.lander();
  assert.equal(prOf(sb, 2).state, "MERGED");
});

test("a red train sends back the one entry whose files the failing stack reads; the others land", (t) => {
  const sb = repo(t, {
    manifest: { release: { merge: "merge" }, stacks: [{ name: "api", check: "api*", inputs: ["backend/**"] }, { name: "web", check: "web", inputs: ["web/**"] }] },
    ci: [{ name: "api (sqlite)", failIfFiles: ["backend/b.py", "web/a.ts"] }, { name: "web" }],
  });
  const a = shipper(sb, "feat-a", { "web/a.ts": "a\n" });
  const b = shipper(sb, "feat-b", { "backend/b.py": "b\n" });
  a.q("add");
  b.q("add");
  sb.lander();
  const recent = outcomes(sb);
  assert.deepEqual(recent.map((o) => [o.pr, o.kind]), [[2, "failed"], [1, "landed"]]);
  assert.match(recent[0].text, /^#2: api \(sqlite\) \(https:\/\/github\.com\/t\/repo\/actions\/runs\/100\/job\/1\) failed on merge train 1 \(#1, #2\), and only your change touches what it tests\./);
  assert.equal(sb.gh().prs.find((p) => p.headRefName === "mq/1").state, "CLOSED", "the red train's PR is closed");
});

test("after pushing a merge of main, the lander waits for the workflows' runs and branch protection, not just the attest's status", (t) => {
  // Train 5 on 10-18: 3 s after the push the attest's commit status was the whole rollup, so the lander merged, GitHub
  // refused (a required check had not reported) and the PR parked for the owner after a 20-minute iOS run.
  const sb = repo(t, { ci: [{ name: "ios/unit-demo", status: true }, { name: "Docs gate" }, { name: "Backend", late: 2500, required: true }] });
  sb.env.ROLLCALL_QUEUE_NO_CHECKS_MS = "6000"; // a 2 s settle, which Backend's run comes after
  const a = shipper(sb, "feat-a", { "src/p.js": "p\n" });
  const other = sb.otherClone(); // main moves, so the lander pushes a merge of it that GitHub has not seen
  write(join(other, "src/m.js"), "m\n");
  git(other, "add", "-A");
  git(other, "commit", "-qm", "main moves");
  git(other, "push", "-q", "origin", "main");
  assert.equal(a.q("add").code, 0);
  sb.lander();
  assert.deepEqual(outcomes(sb).map((o) => [o.pr, o.kind]), [[1, "landed"]]);
  assert.ok(sb.originHas("src/m.js") && sb.originHas("src/p.js"));
});

/** A sandbox whose PR #1 the lander must bring up to date: main moved after it was cut. */
function behindMain(t, ci, gh = {}) {
  const sb = repo(t, { ci });
  sb.env.ROLLCALL_QUEUE_NO_CHECKS_MS = "6000"; // a 2 s settle
  const a = shipper(sb, "feat-a", { "src/p.js": "p\n" });
  const other = sb.otherClone();
  write(join(other, "src/m.js"), "m\n");
  git(other, "add", "-A");
  git(other, "commit", "-qm", "main moves");
  git(other, "push", "-q", "origin", "main");
  assert.equal(a.q("add").code, 0);
  sb.setGh((s) => Object.assign(s, gh));
  sb.q1 = a;
  return sb;
}

test("a head the lander pushed waits for its checks, even when a later lander finds it already holding main", async (t) => {
  // A real PR on 10-19: the lander pushed a merge of main, its train stopped, and the next train found the head
  // holding main, skipped the checks it never saw run and merged; GitHub refused (a required check had not reported).
  const sb = behindMain(t, [{ name: "Backend", late: 4000, required: true }]);
  const first = sb.track(spawn(process.execPath, [BIN, "-C", sb.main, "queue", "lander"], { env: sb.env, stdio: "ignore" }));
  await until(() => /^CI on/.test(JSON.parse(spawnSync(process.execPath, [BIN, "-C", sb.main, "queue", "status", "--json"], { encoding: "utf8", env: sb.env }).stdout).train?.stage ?? ""));
  first.kill("SIGKILL");
  await new Promise((r) => first.once("exit", r));
  sb.lander();
  assert.deepEqual(outcomes(sb).map((o) => [o.pr, o.kind]), [[1, "landed"]]);
  assert.doesNotMatch(landerLog(sb), /gh pr merge #1 failed/);
  assert.ok(sb.originHas("src/m.js") && sb.originHas("src/p.js"));
});

test("just after its push GitHub may still show the old head: the lander waits it out instead of giving up the train", (t) => {
  // That PR's first train: 3 s after the push gh pr view still named the head before it, so the train stopped.
  const sb = behindMain(t, [{ name: "Backend", late: 1000, required: true }], { lag: 1500 });
  sb.lander();
  assert.deepEqual(outcomes(sb).map((o) => [o.pr, o.kind]), [[1, "landed"]]);
  assert.doesNotMatch(landerLog(sb), /gained another head|left the merge queue/);
});

test("a red check that several entries could cause sends each alone; one no entry explains is re-run once, then parks", (t) => {
  const sb = repo(t, {
    manifest: { release: { merge: "merge" }, stacks: [{ name: "lint", check: "lint", inputs: ["docs/**"] }] },
    ci: [{ name: "lint", failIfFiles: ["src/x.js", "src/y.js"] }, { name: "e2e", failIfFiles: ["src/p.js", "src/q.js"] }],
  });
  // e2e belongs to no stack: both entries are suspects, so each goes alone.
  const a = shipper(sb, "feat-a", { "src/p.js": "p\n" });
  const b = shipper(sb, "feat-b", { "src/q.js": "q\n" });
  for (const s of [a, b]) { const r = s.q("add"); assert.equal(r.code, 0, r.stderr); }
  sb.lander();
  assert.deepEqual(outcomes(sb).map((o) => [o.pr, o.kind]), [[1, "landed"], [2, "failed"]], "alone, A lands; B alone on top of A is red: B's own");

  // lint reads docs/, which neither touches: a re-run, then both park for the owner.
  const x = shipper(sb, "feat-x", { "src/x.js": "x\n" });
  const y = shipper(sb, "feat-y", { "src/y.js": "y\n" });
  x.q("add");
  y.q("add");
  sb.lander();
  const parked = outcomes(sb).slice(-2);
  assert.deepEqual(parked.map((o) => o.kind), ["parked", "parked"]);
  assert.match(parked[0].text, /lint \(.*\) failed on merge train \d+ twice, and none of #\d+, #\d+ touches what it tests/);
  assert.equal(sb.gh().reruns["100"], 1);
  assert.match(x.q("status").stdout, /parked: #\d+ feat-x - lint/);
  assert.match(x.q("wait").stdout, /queue: parked - lint/);
});

test("after a bounce, a fix that weakens the tests parks the entry for the owner", (t) => {
  const sb = repo(t, { files: { "test/a.test.js": "test('a', () => {\n  assert.equal(a(), 1);\n});\n" } });
  const a = shipper(sb, "feat-a", { "src/a.js": "from a\n" });
  a.q("add");
  // main moves under it: a conflict, so A goes back.
  const other = sb.otherClone();
  write(join(other, "src/a.js"), "from main\n");
  git(other, "commit", "-qam", "main edits a.js");
  git(other, "push", "-q", "origin", "main");
  sb.lander();
  assert.equal(outcomes(sb).at(-1).kind, "conflict");
  // The "fix" takes main's side and skips the test instead.
  git(a.wt, "fetch", "-q", "origin");
  spawnSync("git", ["-C", a.wt, "merge", "-q", "-X", "theirs", "origin/main"], { env: sb.env });
  write(join(a.wt, "test/a.test.js"), "test.skip('a', () => {\n});\n");
  git(a.wt, "commit", "-qam", "skip it");
  git(a.wt, "push", "-q");
  const r = a.q("add");
  assert.equal(r.code, 2);
  assert.match(r.stdout, /#1 parked for the owner\. Since it was sent back it adds a skip in test\/a\.test\.js: test\.skip\('a'.*; removes 2 test or assertion lines in test\/a\.test\.js: test\('a'/);
  assert.match(a.q("add").stderr, /#1 is parked for the owner/);
  assert.equal(a.q("leave", "the owner accepted the skip").code, 0);
  assert.equal(a.q("add").code, 0, "after leave, the owner's call: it joins");
});

test("after a bounce, what a merge of main brings in is main's, not the fix's: the entry joins again", (t) => {
  const sb = repo(t, { files: { "test/b.test.js": "test('b', () => {\n  assert.equal(b(), 1);\n});\n", "__snapshots__/b.snap": "one\n" } });
  const a = shipper(sb, "feat-a", { "src/a.js": "from a\n" });
  a.q("add");
  // main conflicts with A, and on its own drops a test, edits the workflow and re-records a baseline.
  const other = sb.otherClone();
  write(join(other, "src/a.js"), "from main\n");
  write(join(other, "test/b.test.js"), "// b moved\n");
  write(join(other, ".github/workflows/ci.yml"), "on: [pull_request, push]\n");
  write(join(other, "__snapshots__/b.snap"), "two\n");
  git(other, "commit", "-qam", "main moves on");
  git(other, "push", "-q", "origin", "main");
  sb.lander();
  assert.equal(outcomes(sb).at(-1).kind, "conflict");
  // An honest fix: merge main, keep both sides of a.js.
  git(a.wt, "fetch", "-q", "origin");
  spawnSync("git", ["-C", a.wt, "merge", "-q", "origin/main"], { env: sb.env });
  write(join(a.wt, "src/a.js"), "from main and a\n");
  git(a.wt, "commit", "-qam", "resolve");
  git(a.wt, "push", "-q");
  const r = a.q("add");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  sb.lander();
  assert.equal(prOf(sb, 1).state, "MERGED");
});

test("two entries in one land.serial group never share a train", (t) => {
  const sb = repo(t, { manifest: { release: { merge: "merge" }, land: { serial: [{ paths: ["migrations/**"], why: "one head" }] } } });
  const a = shipper(sb, "feat-a", { "migrations/001.sql": "a\n" });
  const b = shipper(sb, "feat-b", { "migrations/002.sql": "b\n" });
  const c = shipper(sb, "feat-c", { "src/c.js": "c\n" });
  for (const s of [a, b, c]) s.q("add");
  sb.lander();
  const recent = outcomes(sb);
  const trainOf = (pr) => recent.find((o) => o.pr === pr).train;
  assert.equal(trainOf(1), trainOf(3), "A and C share a train");
  assert.notEqual(trainOf(1), trainOf(2), "B waits for the next one");
  assert.ok(recent.every((o) => o.kind === "landed"));
});

test("a PR pushed to after it joined leaves; leave takes an entry out", (t) => {
  const sb = repo(t);
  const a = shipper(sb, "feat-a", { "src/a.js": "a\n" });
  const b = shipper(sb, "feat-b", { "src/b.js": "b\n" });
  a.q("add");
  b.q("add");
  write(join(a.wt, "src/a.js"), "a2\n");
  git(a.wt, "commit", "-qam", "more");
  git(a.wt, "push", "-q");
  assert.match(b.q("leave", "not today").stdout, /#2 left the merge queue/);
  sb.lander();
  const recent = outcomes(sb);
  assert.deepEqual(recent.map((o) => [o.pr, o.kind]), [[2, "left"], [1, "left"]]);
  assert.match(recent[1].text, /gained a new head \([0-9a-f]{8}\) after it joined/);
  assert.equal(prOf(sb, 1).state, "OPEN");
});

test("a PR that carries another's commits lands only with or after it, and leaves when that one leaves", (t) => {
  const sb = repo(t);
  const a = shipper(sb, "feat-a", { "src/p.js": "p\n" });
  const stacked = shipper(sb, "feat-s", { "src/s.js": "s\n" }, { from: "feat-a", base: "feat-a" });
  assert.match(stacked.q("add").stderr, /#2 targets feat-a, not main: the queue lands on main/);
  const b = shipper(sb, "feat-b", { "src/q.js": "q\n" }, { from: "feat-a" });
  assert.match(b.q("add").stderr, /#3 carries #1 \(feat-a\)'s commits, and #1 has not landed/);
  assert.equal(a.q("add").code, 0);
  assert.equal(b.q("add").code, 0, "behind #1 in the queue, it may join");
  // A leaves before the lander runs: B would land A's commits, so it leaves too.
  a.q("leave", "not today");
  sb.lander();
  assert.match(outcomes(sb).at(-1).text, /^#3 carries #1 \(feat-a\)'s commits, and #1 left the merge queue without landing/);
  assert.equal(prOf(sb, 3).state, "OPEN");
  // B cannot join ahead of A; once A is back, one train takes A, then B.
  assert.match(b.q("add").stderr, /#1 has not landed/);
  assert.equal(a.q("add").code, 0);
  assert.equal(b.q("add").code, 0);
  sb.lander();
  const recent = outcomes(sb).slice(-2);
  assert.deepEqual(recent.map((o) => [o.pr, o.kind]), [[1, "landed"], [3, "landed"]]);
  assert.equal(recent[0].train, recent[1].train);
});

test("a pre-push suite runs once in the lander for a tree nobody tested, and its pass is recorded on origin", (t) => {
  const sb = repo(t, {
    manifest: { release: { merge: "merge" }, ci: { prePush: [{ name: "ios", when: ["ios/**"], command: "echo ran >> \"$MARK\" && test ! -f ios/broken" }] } },
  });
  const mark = join(sb.root, "ran.txt");
  sb.env.MARK = mark;
  const a = shipper(sb, "feat-a", { "ios/a.swift": "a\n" });
  const b = shipper(sb, "feat-b", { "src/b.js": "b\n" });
  a.q("add");
  b.q("add");
  sb.lander();
  assert.deepEqual(outcomes(sb).map((o) => o.kind), ["landed", "landed"]);
  assert.equal(readFileSync(mark, "utf8"), "ran\n");
  assert.match(git(sb.origin, "for-each-ref", "--format=%(refname)", "refs/passed/ios"), /^refs\/passed\/ios\/[0-9a-f]{40}$/);
  // A suite that fails blames the entry that touches its inputs.
  const c = shipper(sb, "feat-c", { "ios/broken": "x\n" });
  const d = shipper(sb, "feat-d", { "src/d.js": "d\n" });
  c.q("add");
  d.q("add");
  sb.lander();
  const recent = outcomes(sb).slice(-2);
  assert.deepEqual(recent.map((o) => [o.pr, o.kind]), [[4, "failed"], [5, "landed"]]);
  assert.match(recent[0].text, /^#4: ios \(.*train-\d+-ios\.log\) failed on merge train \d+ \(#4, #5\), and only your change touches what it tests/);
});

test("an entry with a ship command: the train runs the rest even on a head that holds main, unless the whole entry passed", (t) => {
  const count = (f) => { try { return readFileSync(f, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
  // Without `ship`, the ship ran all of it: a train of one whose head holds main runs nothing.
  const plain = repo(t, { manifest: { release: { merge: "merge" }, ci: { prePush: [{ name: "ios", when: ["ios/**"], command: "echo ran >> \"$MARK\"" }] } } });
  plain.env.MARK = join(plain.root, "ran.txt");
  shipper(plain, "feat-a", { "ios/a.swift": "a\n" }).q("add");
  plain.lander();
  assert.deepEqual(outcomes(plain).map((o) => o.kind), ["landed"]);
  assert.equal(count(plain.env.MARK), 0);

  const sb = repo(t, {
    manifest: { release: { merge: "merge" }, ci: { prePush: [{
      name: "ios", when: ["ios/**"], ship: "true the suites the diff names",
      command: "echo ran >> \"$MARK\" && test ! -f ios/broken", attest: "echo attested >> \"$ATTEST\"",
    }] } },
  });
  Object.assign(sb.env, { MARK: join(sb.root, "ran.txt"), ATTEST: join(sb.root, "attest.txt") });
  // A's ship ran only part: the train runs the rest on A's own head, records it and attests.
  shipper(sb, "feat-a", { "ios/a.swift": "a\n" }).q("add");
  sb.lander();
  assert.deepEqual(outcomes(sb).map((o) => o.kind), ["landed"]);
  assert.equal(count(sb.env.MARK), 1);
  assert.equal(count(sb.env.ATTEST), 1);
  assert.match(git(sb.origin, "for-each-ref", "--format=%(refname)", "refs/passed/ios"), /^refs\/passed\/ios\/[0-9a-f]{40}$/m);
  // B's ship covered all of it and recorded the entry's pass: nothing runs.
  const b = shipper(sb, "feat-b", { "ios/b.swift": "b\n" }, { from: "main" });
  assert.equal(b.cli(["results", "record", "ios"]).code, 0);
  b.q("add");
  sb.lander();
  assert.equal(outcomes(sb).at(-1).kind, "landed");
  assert.equal(count(sb.env.MARK), 1);
  assert.match(landerLog(sb), /ios already passed for these inputs/);
  // The rest failing says the ship left it to the train.
  shipper(sb, "feat-c", { "ios/broken": "x\n" }, { from: "main" }).q("add");
  sb.lander();
  const last = outcomes(sb).at(-1);
  assert.equal(last.kind, "failed");
  assert.match(last.text, /left part of ios to the train/);
});

/** A pre-push suite whose failures are the lines of ios/fails, and whose re-run of one test fails when ios/still-broken lists it. */
function flakyRepo(t) {
  const sb = repo(t, {
    manifest: { release: { merge: "merge" }, ci: { prePush: [{
      name: "ios", when: ["ios/**"], flakes: "ios/flaky.txt",
      command: "test ! -s ios/fails || { cat ios/fails >> \"$ROLLCALL_FAILURES\"; exit 1; }",
      rerun: "echo <test> >> \"$RERUNS\" && ! grep -qx <test> ios/still-broken 2>/dev/null",
      attest: "echo \"$ROLLCALL_FLAKES\" > \"$ATTEST\"",
    }] } },
    files: { "ios/flaky.txt": "# Tests that fail when the Mac is busy.\nCard/testA\nChat/testB  # since 10-15\n" },
  });
  Object.assign(sb.env, { RERUNS: join(sb.root, "reruns.txt"), ATTEST: join(sb.root, "attest.txt") });
  sb.reruns = () => { try { return readFileSync(sb.env.RERUNS, "utf8"); } catch { return ""; } };
  return sb;
}

test("a pre-push suite that fails only on a known flake re-runs that test once alone, names it in the PRs and lands", (t) => {
  const sb = flakyRepo(t);
  const a = shipper(sb, "feat-a", { "ios/a.swift": "a\n", "ios/fails": "Card/testA\n" });
  const b = shipper(sb, "feat-b", { "src/b.js": "b\n" });
  a.q("add");
  b.q("add");
  sb.lander();
  const recent = outcomes(sb);
  assert.deepEqual(recent.map((o) => [o.pr, o.kind]), [[1, "landed"], [2, "landed"]]);
  assert.equal(sb.reruns(), "Card/testA\n", "the flake ran once more, alone");
  const said = "ios failed only on Card/testA, a known flake (ios/flaky.txt), and passed when run once more alone";
  for (const n of [1, 2]) assert.deepEqual(prOf(sb, n).comments, [`Merge queue train 1: ${said}, so the train went on.`]);
  assert.match(sb.gh().prs.find((p) => p.headRefName === "mq/1").body, new RegExp(`Known flake: ${said.replace(/[()/.]/g, "\\$&")}\\.`));
  assert.match(recent[0].text, /\. Known flake: ios failed only on Card\/testA, .* Name it in the report\. Next: /);
  assert.deepEqual(recent[0].flakes, [said]);
  assert.equal(readFileSync(sb.env.ATTEST, "utf8"), "Card/testA\n", "attest hears which flakes it passed with");
  assert.match(git(sb.origin, "for-each-ref", "--format=%(refname)", "refs/passed/ios"), /^refs\/passed\/ios\/[0-9a-f]{40}$/);
  assert.match(landerLog(sb), /train 1: ios: known flake Card\/testA passed alone/);
});

test("a failure that is not only listed flakes, a flake that fails again alone, or a test the PR itself lists still goes back", (t) => {
  const sb = flakyRepo(t);
  const pair = (name, changes) => {
    const x = shipper(sb, name, changes);
    const y = shipper(sb, `${name}-other`, { [`src/${name}.js`]: "y\n" });
    x.q("add");
    y.q("add");
    sb.lander();
    const recent = outcomes(sb).slice(-2);
    assert.deepEqual(recent.map((o) => [o.pr, o.kind]), [[x.pr, "failed"], [y.pr, "landed"]]);
    assert.equal(prOf(sb, x.pr).comments, undefined, "nothing named as a flake");
    return Object.assign(x, { text: recent[0].text });
  };
  // A known flake beside a failure that is not one test: no re-run.
  const build = pair("build", { "ios/c.swift": "c\n", "ios/fails": "Card/testA\nbuild: no result bundle\n" });
  assert.equal(sb.reruns(), "");
  // A "fix" that lists the failing test as a known flake parks for the owner.
  write(join(build.wt, "ios/flaky.txt"), "Card/testA\nChat/testB\nBuild/testC\n");
  git(build.wt, "commit", "-qam", "it is flaky");
  git(build.wt, "push", "-q");
  const r = build.q("add");
  assert.equal(r.code, 2);
  assert.match(r.stdout, /parked for the owner\. Since it was sent back it changes the known-flake list ios\/flaky\.txt/);
  // A known flake that fails again when run alone: one re-run, then it goes back, saying so.
  const { text: again } = pair("again", { "ios/e.swift": "e\n", "ios/fails": "Chat/testB\n", "ios/still-broken": "Chat/testB\n" });
  assert.equal(sb.reruns(), "Chat/testB\n");
  assert.match(again, /^#\d+: ios \(.*train-\d+-ios-rerun-1\.log\) failed on merge train \d+ \(#\d+, #\d+\), and only your change touches what it tests\. It failed only on Chat\/testB, a known flake \(ios\/flaky\.txt\), and failed again when run alone\. Fix it/);
  // The flake list is main's: a PR that adds its own failing test to it gains nothing.
  pair("self", { "ios/g.swift": "g\n", "ios/fails": "New/testC\n", "ios/flaky.txt": "Card/testA\nNew/testC\n" });
  assert.equal(sb.reruns(), "Chat/testB\n");
  assert.match(landerLog(sb), /ios failed on New\/testC, not a known flake/);
});

test("the queue reports through the task: queued at add, working after a bounce, needs-you once the third bounce parks it", (t) => {
  const sb = repo(t);
  const sup = sb.session(sb.root);
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  assert.equal(sup.cli(["task", "new", "list", "--repo", sb.main, "--slug", "list"]).code, 0);
  const task = () => JSON.parse(sup.cli(["task", "show", "t1", "--json"]).stdout);
  const a = shipper(sb, "list", { "src/a.js": "from a\n" }, { wt: join(sb.main, ".claude/worktrees/list") });
  assert.equal(a.q("add").code, 0);
  assert.equal(task().state, "queued");
  for (let round = 1; round <= 3; round++) {
    // main changes the same line under it each time: a conflict
    const other = sb.otherClone();
    write(join(other, "src/a.js"), `main ${round}\n`);
    git(other, "commit", "-qam", `main ${round}`);
    git(other, "push", "-q", "origin", "main");
    sb.lander();
    if (round === 3) break;
    assert.equal(outcomes(sb).at(-1).kind, "conflict");
    assert.equal(task().state, "working");
    git(a.wt, "fetch", "-q", "origin");
    spawnSync("git", ["-C", a.wt, "merge", "-q", "origin/main"], { env: sb.env });
    write(join(a.wt, "src/a.js"), `from a, on main ${round}\n`);
    git(a.wt, "commit", "-qam", `resolve ${round}`);
    git(a.wt, "push", "-q");
    assert.equal(a.q("add").code, 0);
    assert.equal(task().state, "queued");
  }
  const last = outcomes(sb).at(-1);
  assert.equal(last.kind, "parked");
  assert.match(last.text, /conflicts with main in: src\/a\.js\..* It was sent back 2 times before, so this time it is parked for the owner\./);
  const t1 = task();
  assert.equal(t1.state, "needs-you");
  assert.match(t1.question, /^merge queue parked #1: #1 conflicts with main/);
  assert.match(a.q("status").stdout, /parked: #1 feat\/list - #1 conflicts with main/);
  const wakes = readdirSync(join(sb.home, "_supervisors/alpha/wake")).filter((n) => n.startsWith("q-")).map((n) => JSON.parse(readFileSync(join(sb.home, "_supervisors/alpha/wake", n), "utf8")));
  assert.ok(wakes.some((w) => w.task === "t1" && w.kind === "needs-you"), "parking wakes the supervisor");
});


test("a bounce leaves the owner's question standing: its task waits on them, and the bounce goes on the record", (t) => {
  const sb = repo(t);
  const sup = sb.session(sb.root);
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  assert.equal(sup.cli(["task", "new", "list", "--repo", sb.main, "--slug", "list"]).code, 0);
  const task = () => JSON.parse(sup.cli(["task", "show", "t1", "--json"]).stdout);
  const a = shipper(sb, "list", { "src/a.js": "from a\n" }, { wt: join(sb.main, ".claude/worktrees/list") });
  assert.equal(a.q("add").code, 0);
  assert.equal(sup.cli(["task", "set", "t1", "--state", "needs-you", "--question", "deploy staging?"]).code, 0);
  const other = sb.otherClone();
  write(join(other, "src/a.js"), "main\n");
  git(other, "commit", "-qam", "main");
  git(other, "push", "-q", "origin", "main");
  sb.lander();
  assert.equal(outcomes(sb).at(-1).kind, "conflict");
  const t1 = task();
  assert.equal(t1.state, "needs-you");
  assert.equal(t1.question, "deploy staging?");
  assert.match(t1.notes.at(-1).text, /^merge queue: conflict - /);
});

test("queue add starts a lander when none runs, and queue wait starts one for an entry left waiting", async (t) => {
  const sb = repo(t);
  const on = { env: { ROLLCALL_QUEUE_LANDER: "1", ROLLCALL_LANDER_IDLE_MS: "300" } };
  const a = shipper(sb, "feat-a", { "src/p.js": "p\n" });
  const b = shipper(sb, "feat-b", { "src/q.js": "q\n" });
  // A joins with no lander allowed; its wait finds it waiting with none running and starts one.
  assert.equal(a.q("add").code, 0);
  assert.match(a.q("status").stdout, /1 waiting; no lander running/);
  const w = await a.cliAsync(["queue", "wait", "--timeout", "1"], on).exited;
  assert.equal(w.code, 0);
  assert.match(w.stdout, /queue: landed - #1 landed on main/);
  // That lander stops once the queue has stayed empty; then B's own add starts one.
  await until(() => /no lander running/.test(a.q("status").stdout));
  assert.equal(b.cli(["queue", "add"], on).code, 0);
  const v = await b.cliAsync(["queue", "wait", "--timeout", "1"]).exited;
  assert.match(v.stdout, /queue: landed - #2 landed on main/);
  // Each lander stops once the queue has stayed empty.
  await until(() => /no lander running/.test(a.q("status").stdout));
  assert.equal((landerLog(sb).match(/ started$/gm) ?? []).length, 2);
});

test("Mergiraf resolves a conflict it can, and both entries land in one train", (t) => {
  const sb = repo(t, { files: { "src/list.txt": "one\n" } });
  sb.env.PATH = `${join(FIXTURES, "mergiraf-bin")}:${sb.env.PATH}`; // ahead of mergiraf-off
  const a = shipper(sb, "feat-a", { "src/list.txt": "one\ntwo\n" });
  const b = shipper(sb, "feat-b", { "src/list.txt": "one\nthree\n" });
  a.q("add");
  b.q("add");
  sb.lander();
  const recent = outcomes(sb);
  assert.deepEqual(recent.map((o) => [o.pr, o.kind]), [[1, "landed"], [2, "landed"]]);
  assert.equal(recent[0].train, recent[1].train);
  assert.equal(git(sb.origin, "show", "main:src/list.txt"), "one\ntwo\nthree");
  assert.match(landerLog(sb), /mergiraf resolved src\/list\.txt for #2/);
});

test("a ship that started on the old /pr-create hears what each rollcall land step became", (t) => {
  const sb = repo(t);
  const a = shipper(sb, "feat-a", { "src/p.js": "p\n" });
  for (const args of [["land"], ["land", "--check"], ["land", "--wait"]]) {
    const r = a.cli(args);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^rollcall: `rollcall land` is gone; ships land through the merge queue now\./);
    assert.match(r.stderr, /merge-tree --write-tree --name-only HEAD origin\/<default>/);
    assert.match(r.stderr, /never gh pr merge\. Once the PR is open, pushed and green, rollcall queue add, then rollcall queue wait in the background/);
  }
  const abort = a.cli(["land", "--abort", "stopped"]);
  assert.equal(abort.code, 0, "nothing to leave is not a failure");
  assert.match(abort.stdout, /nothing to leave: the landing queue is gone/);
  // Following the pointer lands it.
  assert.equal(a.q("add").code, 0);
  sb.lander();
  assert.equal(prOf(sb, 1).state, "MERGED");
});

test("status shows a train's suite against its usual time, what else runs beside it, and each landing's times; outside a checkout, every repo", (t) => {
  // `true` stands in for the suite: it passes whatever follows, and ps shows it as the manifest writes it.
  const sb = repo(t, { manifest: { release: { merge: "merge" }, ci: { prePush: [{ name: "ios", when: ["ios/**"], command: "true ios-check SUITES=\"<suites>\"" }] } } });
  const sup = sb.session(sb.root);
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  assert.equal(sup.cli(["task", "new", "ios", "--repo", sb.main, "--slug", "ios"]).code, 0);
  assert.equal(sup.cli(["task", "words", "t1", "Ship it (Recommended)"]).code, 0);
  const a = shipper(sb, "ios", { "ios/a.swift": "a\n" }, { wt: join(sb.main, ".claude/worktrees/ios") });
  const b = shipper(sb, "feat-b", { "src/b.js": "b\n" }); // a train of two is a tree nobody tested: the suite runs
  assert.equal(a.q("add").code, 0);
  assert.equal(b.q("add").code, 0);
  sb.lander();
  const [landed] = outcomes(sb);
  assert.equal(landed.kind, "landed");
  const said = JSON.parse(sup.cli(["task", "show", "t1", "--json"]).stdout).words.at(-1).at;
  assert.equal(landed.shipIt, said, "ship it: the owner's words on the task");
  assert.ok(landed.joined <= landed.at && landed.joined > said);
  assert.match(landerLog(sb), /train 1: ios passed in 0 min/);
  const key = readdirSync(sb.home).find((d) => !d.startsWith("_"));
  const stateFile = join(sb.home, key, "queue", "state.json");
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).times.ios.length, 1, "the lander keeps the suite's time");

  // A train 20 minutes into its suite, which usually takes 10-30; a ship's own run and an Actions job beside it.
  const now = Date.now();
  const log = join(sb.root, "train-9-ios.log");
  write(log, "ui-tests: building\n\x1b[32mui-tests: running demo\x1b[0m\n\n");
  const q = JSON.parse(readFileSync(stateFile, "utf8"));
  q.train = { n: 9, prs: [7], stage: "pre-push ios", base: "x", at: now - 30 * 60_000, suite: "ios", log, started: now - 20 * 60_000 };
  q.times.ios = [10, 30, 20].map((m) => m * 60_000);
  writeFileSync(stateFile, JSON.stringify(q));
  const lander = sb.session(sb.root).harness.pid;
  writeFileSync(join(sb.home, key, "queue", "lander.json"), JSON.stringify({ pid: lander, at: now, seen: now }));
  const h = a.harness.pid;
  write(join(sb.root, "ps.txt"), [
    `${h} 1 31:00 sleep 600`,
    `4001 ${h} 21:00 /bin/zsh -c true ios-check SUITES="Chat"`,
    `4002 4001 20:59 /usr/bin/true ios-check SUITES=Chat`,
    `4003 4002 20:58 true ios-check inner`,
    `5001 1 1-02:00:00 /Users/x/actions-runner/bin/Runner.Worker spawnclient 110 113`,
    `6001 ${lander} 19:00 true ios-check SUITES=`,
  ].join("\n") + "\n");
  write(join(sb.root, "ps"), `#!/bin/sh\ncat "${join(sb.root, "ps.txt")}"\n`);
  chmodSync(join(sb.root, "ps"), 0o755);
  const env = { ROLLCALL_PS: join(sb.root, "ps") };
  // Outside a checkout it shows every repo with a queue; inside one, or with rollcall -C, that repo's.
  for (const [cwd, args] of [[sb.root, []], [a.wt, []], [sb.root, ["-C", sb.main]]]) {
    const out = sup.cli([...args, "queue", "status"], { cwd, env }).stdout;
    assert.match(out, /train 9: #7 - pre-push ios, 20m so far \(usual 20m\); its log, just now: ui-tests: running demo \(train started 30m ago\)/, cwd);
    assert.match(out, /just now: #1 landed \([0-9a-f]{8}\), 0m after it joined, 0m after "ship it"/);
    assert.match(out, new RegExp(`beside the train's suite on this machine: a GitHub Actions runner job for 26h00m, \\S+'s true ios-check for 21m \\(${a.short}, feat\/ios\\)\\n`));
  }
  const json = JSON.parse(sup.cli(["queue", "status", "--json"], { cwd: a.wt, env }).stdout);
  assert.equal(json.train.usual, 20 * 60_000);
  assert.equal(json.others.length, 2, "the lander's own run and the inside of the ship's run are not others");
  // A -C after the subcommand once showed the wrong repo's queue without a word.
  assert.match(a.q("status", "-C", sb.root).stderr, /unknown argument "-C" \(another repo's queue: rollcall -C <dir> queue status\)/);
  // No train in a suite: no ps, no line about it.
  q.train = null;
  writeFileSync(stateFile, JSON.stringify(q));
  assert.doesNotMatch(a.q("status").stdout, /this machine|ps failed/);
});

/** A supervisor's task with a ship in its worktree, on branch feat/list: `task()` and `wakes()` read what the queue told it. */
function tasked(sb, changes) {
  const sup = sb.session(sb.root);
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  assert.equal(sup.cli(["task", "new", "list", "--repo", sb.main, "--slug", "list"]).code, 0);
  const a = shipper(sb, "list", changes, { wt: join(sb.main, ".claude/worktrees/list") });
  const dir = join(sb.home, "_supervisors/alpha/wake");
  const wakes = () => readdirSync(dir).filter((n) => n.startsWith("q-")).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
  return Object.assign(a, { task: () => JSON.parse(sup.cli(["task", "show", "t1", "--json"]).stdout), wakes });
}

const parked = (sb) => outcomes(sb).filter((o) => o.kind === "parked");

test("a PR the lander cannot read stays in line: past a while its task hears why, once, and it goes on when that clears", (t) => {
  // Oct 19: 743 "it waits" lines, about 4 hours with nothing landed, and no one told.
  const sb = repo(t);
  const a = tasked(sb, { "src/a.js": "a\n" });
  assert.equal(a.q("add").code, 0);
  sb.env.ROLLCALL_QUEUE_STUCK_MS = "1";
  sb.setGh((s) => { s.failView = "HTTP 401: Bad credentials"; });
  sb.lander();
  assert.equal(a.task().state, "queued", "one failed round is no news");
  sb.lander();
  sb.lander();
  const t1 = a.task();
  assert.equal(t1.state, "needs-you");
  assert.match(t1.question, /^merge queue: #1 has not moved for .*HTTP 401: Bad credentials\. Next: run gh auth login\. The lander keeps trying/);
  assert.equal(a.wakes().filter((w) => w.kind === "needs-you").length, 1, "told once");
  assert.equal(landerLog(sb).match(/gh pr view failed/g).length, 1, "and logged once, however many rounds");
  assert.match(a.bash().context, /\[rollcall\] merge queue: #1 has not moved/);
  assert.match(a.q("status").stdout, /1\. #1 feat\/list.*<- stuck since .*HTTP 401/, "it keeps its place, and status says why");
  sb.setGh((s) => { delete s.failView; });
  sb.lander();
  assert.deepEqual(outcomes(sb).map((o) => o.kind), ["landed"]);
  assert.equal(a.task().state, "queued");
  assert.equal(a.task().question, null);
});

test("a push git refuses gets the same news, with the sign-in fix, and the train lands once it clears", (t) => {
  const sb = behindMain(t, [{ name: "test" }]);
  sb.env.ROLLCALL_QUEUE_STUCK_MS = "1";
  const hook = join(sb.origin, "hooks/pre-receive");
  write(hook, "#!/bin/sh\necho \"fatal: could not read Username for 'https://github.com': Device not configured\" >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  sb.lander();
  sb.lander();
  assert.equal(outcomes(sb).length, 0, "the push failing ends nothing");
  assert.match(sb.q1.bash().context, /#1 has not moved .*git push to feat-a failed.*could not read Username.*Next: run gh auth setup-git/);
  rmSync(hook);
  sb.lander();
  assert.deepEqual(outcomes(sb).map((o) => o.kind), ["landed"]);
});

test("a lander does not stop with an entry it cannot land", async (t) => {
  const sb = repo(t);
  const a = shipper(sb, "feat-a", { "src/a.js": "a\n" });
  assert.equal(a.q("add").code, 0);
  sb.setGh((s) => { s.failView = "HTTP 502: Bad Gateway"; });
  const l = sb.track(spawn(process.execPath, [BIN, "-C", sb.main, "queue", "lander"], { env: { ...sb.env, ROLLCALL_LANDER_IDLE_MS: "100" }, stdio: "ignore" }));
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(l.exitCode, null, "still there, well past its idle time");
  await until(() => { sb.setGh((s) => { delete s.failView; }); return l.exitCode !== null; });
  assert.deepEqual(outcomes(sb).map((o) => o.kind), ["landed"]);
});

/** One pre-push suite for ios/**, `command`, in a repo where two PRs under src/ never share a train. Its `ship` makes a train of one run it too. */
const suite = (command, extra = {}) => ({
  release: { merge: "merge" }, land: { serial: [{ paths: ["src/**"], why: "they clash" }] }, ci: { prePush: [{ name: "ios", when: ["ios/**"], command, ship: "true", ...extra }] },
});

test("a suite that stops writing ends as hung with its whole process group, its train parks and the next one goes", (t) => {
  // Lands on nothing: the child would hold the queue for 3 hours, and a timeout on the shell alone would leave it running.
  const sb = repo(t, { manifest: suite("sleep 300 & echo $! > \"$MARK\"; wait") });
  sb.env.MARK = join(sb.root, "pid");
  sb.env.ROLLCALL_QUEUE_QUIET_MS = "500";
  const a = shipper(sb, "feat-a", { "ios/a.swift": "a\n", "src/a.js": "a\n" });
  const b = shipper(sb, "feat-b", { "src/b.js": "b\n" });
  a.q("add");
  b.q("add");
  sb.lander();
  const [p] = parked(sb);
  assert.equal(p.pr, 1);
  assert.match(p.text, /^The lander stopped ios on merge train 1: it wrote nothing for .*Its log: .*train-1-ios\.log\. Nothing says #1 caused it\. Next: rollcall queue leave, then rollcall queue add/);
  assert.deepEqual(outcomes(sb).filter((o) => o.kind === "landed").map((o) => o.pr), [2], "the queue behind it goes on");
  assert.throws(() => process.kill(Number(readFileSync(sb.env.MARK, "utf8")), 0), "its child died with it");
});

test("writing anywhere in the tree counts: a suite whose own log stays silent is not hung", (t) => {
  // One iOS project's log holds one line for a whole demo run; the tests write under ios/build.
  const sb = repo(t, { manifest: suite("for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do sleep .1; date > ios/out; done") });
  sb.env.ROLLCALL_QUEUE_QUIET_MS = "1200";
  const a = shipper(sb, "feat-a", { "ios/a.swift": "a\n" });
  a.q("add");
  sb.lander();
  assert.deepEqual(outcomes(sb).map((o) => o.kind), ["landed"]);
});

test("a suite past twice its longest recent pass ends as hung, however much it writes; a slower pass within that stands", (t) => {
  const sb = repo(t, { manifest: suite("test -f ios/forever && while :; do echo tick; sleep .05; done; sleep 1") });
  const a = shipper(sb, "feat-a", { "ios/a.swift": "a\n" });
  a.q("add");
  sb.lander();
  assert.deepEqual(outcomes(sb).map((o) => o.kind), ["landed"], "with no history, the least time stands");
  sb.env.ROLLCALL_QUEUE_SUITE_MIN_MS = "100"; // from here only twice the 1 s pass holds
  const b = shipper(sb, "feat-b", { "ios/b.swift": "b\n" });
  b.q("add");
  sb.lander();
  assert.deepEqual(outcomes(sb).map((o) => o.kind), ["landed", "landed"]);
  const c = shipper(sb, "feat-c", { "ios/forever": "x\n" });
  c.q("add");
  sb.lander();
  assert.match(outcomes(sb).at(-1).text, /The lander stopped ios on merge train \d+: it ran past its .* limit/);
});

test("a suite stops at its first failure that is not a known flake, and the member left behind goes again at once", (t) => {
  // Train 102 failed a test in its first phase and held the queue to 2h45m; #462 sat behind a red train for 70 minutes.
  const sb = repo(t, { manifest: suite("if test -f ios/bad.swift; then echo Tests/testBad >> \"$ROLLCALL_FAILURES\"; sleep 300; exit 1; fi", { flakes: "ios/flakes.txt", rerun: "true" }), files: { "ios/flakes.txt": "Tests/testFlaky\n" } });
  sb.env.ROLLCALL_QUEUE_QUIET_MS = "2000"; // how often the lander looks is a tenth of this
  const bad = shipper(sb, "feat-bad", { "ios/bad.swift": "x\n" });
  const d = tasked(sb, { "docs/d.md": "d\n" });
  bad.q("add");
  d.q("add");
  const start = Date.now();
  sb.lander();
  assert.ok(Date.now() - start < 60_000, "it did not sit out the sleep");
  const o = outcomes(sb);
  assert.deepEqual(o.map((x) => [x.pr, x.kind]), [[1, "failed"], [2, "landed"]]);
  assert.match(o[0].text, /The lander stopped the suite at Tests\/testBad rather than let a train that cannot land run on\./);
  assert.match(d.bash().context, /merge queue: #2: #1 failed train 1, going again\./);
  assert.equal(d.task().queueLine, "#1 failed train 1, going again");
});

test("GitHub refusing jobs over billing is one blocker: the train's members keep their place, and go on once it closes", (t) => {
  // Oct 19: hosted jobs failed in 2 s with no steps, the self-hosted one ran on, and after 60 minutes the lander blamed a sleeping runner.
  const sb = repo(t);
  sb.env.ROLLCALL_QUEUE_CI_MINUTES = "0.1";
  const a = shipper(sb, "feat-a", { "src/a.js": "a\n" });
  const b = shipper(sb, "feat-b", { "src/b.js": "b\n" });
  a.q("add");
  b.q("add");
  sb.setGh((s) => {
    s.ci = [{ name: "Backend", failIfGrep: "." }, { name: "ios", pending: true }];
    s.annotations = { 1: [{ message: "The job was not started because recent account payments have failed or your spending limit needs to be increased." }] };
  });
  sb.lander();
  const status = () => JSON.parse(spawnSync(process.execPath, [BIN, "-C", sb.main, "queue", "status", "--json"], { encoding: "utf8", env: sb.env }).stdout);
  assert.deepEqual(outcomes(sb), [], "nothing about either failed");
  assert.deepEqual(status().waiting.map((e) => [e.pr, e.blocked]), [[1, "billing"], [2, "billing"]]);
  const blocker = () => JSON.parse(readFileSync(join(sb.home, "_machine/trouble.json"), "utf8")).open.billing;
  assert.match(blocker().text, /spending limit/);
  assert.equal(sb.gh().reruns?.[100], undefined, "no re-run of a job GitHub will not start");
  // A lander that looks again still holds them, and starts no train.
  const prs = sb.gh().prs.length;
  sb.lander();
  assert.deepEqual(status().waiting.map((e) => e.blocked), ["billing", "billing"]);
  assert.equal(sb.gh().prs.length, prs);

  sb.setGh((s) => { s.ci = [{ name: "test" }]; s.annotations = {}; });
  assert.match(a.cli(["blockers", "clear", "billing"]).stdout, /billing cleared/);
  sb.lander();
  assert.deepEqual(outcomes(sb).map((o) => [o.pr, o.kind]).sort(), [[1, "landed"], [2, "landed"]]);
});

test("a real failure with other checks still running goes back at once when it names a member", (t) => {
  const sb = repo(t, { manifest: { release: { merge: "merge" }, stacks: [{ name: "api", check: "api", inputs: ["src/**"] }] } });
  sb.env.ROLLCALL_QUEUE_CI_MINUTES = "0.1";
  const a = shipper(sb, "feat-a", { "src/a.js": "a\n" });
  a.q("add");
  sb.setGh((s) => { s.ci = [{ name: "api", failIfGrep: "." }, { name: "ios", pending: true }]; });
  sb.lander();
  assert.deepEqual(outcomes(sb).map((o) => [o.pr, o.kind]), [[1, "failed"]]);
});

test("GitHub showing every change late changes nothing: the lander lands what it would have landed", async (t) => {
  // Fixed twice one case at a time (a0f1cca, 67486bc). `lag` delays heads, checks, states, new PRs and what a merge will take.
  await t.test("a train of one the lander brings up to date", (t) => {
    const sb = behindMain(t, [{ name: "Backend", late: 600, required: true }], { lag: 800 });
    sb.lander();
    assert.deepEqual(outcomes(sb).map((o) => [o.pr, o.kind]), [[1, "landed"]]);
  });
  await t.test("a train of two, whose PR is not there yet", (t) => {
    const sb = repo(t);
    const a = shipper(sb, "feat-a", { "src/a.js": "a\n" });
    const b = shipper(sb, "feat-b", { "docs/b.md": "b\n" });
    a.q("add");
    b.q("add");
    sb.setGh((s) => { s.lag = 800; });
    sb.env.ROLLCALL_QUEUE_NO_CHECKS_MS = "3000";
    sb.lander();
    assert.deepEqual(outcomes(sb).map((o) => o.kind), ["landed", "landed"]);
  });
  await t.test("no CI to wait for, so the merge comes right after the push", (t) => {
    const sb = repo(t, { ci: [] });
    const a = shipper(sb, "feat-a", { "src/a.js": "a\n" });
    const other = sb.otherClone();
    write(join(other, "src/m.js"), "m\n");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "main moves");
    git(other, "push", "-q", "origin", "main");
    a.q("add");
    sb.setGh((s) => { s.lag = 100; });
    sb.lander();
    assert.deepEqual(outcomes(sb).map((o) => o.kind), ["landed"]);
  });
  await t.test("a PR merged by hand that still shows open", (t) => {
    const sb = repo(t);
    const a = shipper(sb, "feat-a", { "src/a.js": "a\n" });
    a.q("add");
    sb.setGh((s) => { s.lag = 300; });
    spawnSync(GH, ["pr", "merge", "1", "--merge"], { env: sb.env });
    sb.lander();
    assert.deepEqual(outcomes(sb).map((o) => o.kind), ["landed"]);
    assert.match(outcomes(sb)[0].text, /landed on main/);
  });
});
