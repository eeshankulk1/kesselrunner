// The ship script. Done when: once a PR is open, `rollcall ship start` hands everything after it to scripts: the
// lander watches its checks, a red check comes back with the failing part of its log (after one re-run), a review
// thread comes back, green joins the merge queue (or ends a PR-only ship), and after a landing the after-merge
// runner watches what the merge started and runs the release commands from merged main, then lands the task. News
// that needs a model goes into the task's worker as a notice; a session with no task hears it through `ship wait`.
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { BIN, FIXTURES, git, sandbox, write } from "./helpers.mjs";

const GH = join(FIXTURES, "gh");
chmodSync(GH, 0o755);

/** A sandbox with a fake GitHub (`ci` decides the PR's checks) and a manifest. */
function repo(t, { manifest = { release: { merge: "squash" } }, ci = [{ name: "test" }] } = {}) {
  const sb = sandbox(t);
  write(join(sb.main, ".claude/test-manifest.json"), JSON.stringify(manifest));
  if (ci.length) write(join(sb.main, ".github/workflows/ci.yml"), "on: pull_request\n");
  git(sb.main, "add", "-A");
  git(sb.main, "commit", "-qm", "setup");
  git(sb.main, "push", "-q", "origin", "main");
  const state = join(sb.root, "gh.json");
  writeFileSync(state, JSON.stringify({ next: 1, prs: [], ci }));
  sb.env = {
    ...sb.env, PATH: `${join(FIXTURES, "mergiraf-off")}:${sb.env.PATH}`, ROLLCALL_GH: GH, FAKE_GH_STATE: state, FAKE_GH_ORIGIN: sb.origin,
    ROLLCALL_QUEUE_LANDER: "0", ROLLCALL_SHIP_AFTER: "0", ROLLCALL_QUEUE_POLL_MS: "20", ROLLCALL_QUEUE_NO_CHECKS_MS: "30",
    ROLLCALL_SHIP_POLL_MS: "20", ROLLCALL_SHIP_NONE_MS: "100",
  };
  const gh = () => JSON.parse(readFileSync(state, "utf8"));
  const setGh = (fn) => { const s = gh(); fn(s); writeFileSync(state, JSON.stringify(s)); };
  const run = (...args) => spawnSync(process.execPath, [BIN, "-C", sb.main, ...args], { encoding: "utf8", env: sb.env });
  /** Lander rounds until one changes nothing. */
  const lander = () => { const r = run("queue", "lander", "--once"); assert.equal(r.status, 0, r.stderr); };
  const after = (pr) => run("ship", "after", String(pr));
  const queue = () => JSON.parse(readFileSync(join(sb.home, readdirKey(sb), "queue", "state.json"), "utf8"));
  return { ...sb, gh, setGh, lander, after, queue, run };
}

const readdirKey = (sb) => spawnSync("ls", [sb.home], { encoding: "utf8" }).stdout.split("\n").find((d) => d.startsWith("main-") || /-[0-9a-f]{12}$/.test(d));

/** A session on branch `name`, its change committed and pushed, a PR open (body with a CI line, as /pr-create writes). */
function shipper(sb, name, changes, { wt = sb.worktree(name), pr = true } = {}) {
  const s = sb.session(wt);
  s.start();
  s.prompt(`ship ${name}`);
  for (const [f, text] of Object.entries(changes)) write(join(wt, f), text);
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", `${name}: ${Object.keys(changes).join(", ")}`);
  git(wt, "push", "-q", "-u", "origin", "HEAD");
  let number = null;
  if (pr) {
    const r = spawnSync(GH, ["pr", "create", "--base", "main", "--head", git(wt, "branch", "--show-current"), "--title", name, "--body", `${name}\n\n## Quality pass\n- CI: pending (rollcall watches it)\n`], { encoding: "utf8", env: sb.env });
    number = Number(/\/pull\/(\d+)/.exec(r.stdout)[1]);
  }
  return Object.assign(s, { wt, pr: number, ship: (...args) => s.cli(["ship", ...args]) });
}

const outcomes = (sb) => sb.queue().outcomes.map((o) => [o.pr, o.kind]);
const last = (sb) => sb.queue().outcomes.at(-1);

/** A supervisor with task t1 whose worktree is `.claude/worktrees/<slug>`. */
function withTask(sb, slug) {
  const sup = sb.session(sb.root);
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  assert.equal(sup.cli(["task", "new", slug, "--repo", sb.main, "--slug", slug]).code, 0);
  const task = () => JSON.parse(sup.cli(["task", "show", "t1", "--json"]).stdout);
  const outbox = () => { try { return JSON.parse(readFileSync(join(sb.home, "_supervisors/alpha/outbox-t1.json"), "utf8")); } catch { return []; } };
  return { sup, task, outbox, wt: join(sb.main, `.claude/worktrees/${slug}`) };
}

test("ship start takes an open, pushed PR whose checks still run, and refuses what cannot ship", (t) => {
  const sb = repo(t, { ci: [{ name: "test", pending: true }] });
  const a = shipper(sb, "feat-a", { "src/a.js": "a\n" }, { pr: false });
  assert.match(a.ship("start").stderr, /no PR for feat-a/);
  spawnSync(GH, ["pr", "create", "--base", "main", "--head", "feat-a", "--title", "a", "--draft"], { env: sb.env });
  assert.match(a.ship("start", "--land").stderr, /#1 is a draft/);
  sb.setGh((s) => { s.prs[0].isDraft = false; });
  write(join(a.wt, "src/a.js"), "dirty\n");
  assert.match(a.ship("start").stderr, /uncommitted work \(src\/a\.js\)/);
  git(a.wt, "checkout", "-q", "--", "src/a.js");
  const ok = a.ship("start", "--land");
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /rollcall watches #1's checks now; once they are green .* joins the merge queue/);
  assert.match(ok.stdout, /run `rollcall ship wait` in the background/, "a session with no task waits through ship wait");
  sb.lander();
  assert.equal(sb.queue().entries[1].state, "checking", "still running: it stays watched");
  assert.match(sb.run("queue", "status").stdout, /checks running: #1 feat-a, watched since .*, joins once green/);
});

test("green joins the line and lands; the after-merge runner watches the deploys, runs the release command from merged main, and lands the task", (t) => {
  const sb = repo(t, {
    manifest: { release: { merge: "squash", afterMerge: [{ name: "upload", when: ["src/**"], command: "git rev-parse HEAD > \"$ROLLCALL_RELEASED\"" }, { name: "never", when: ["ios/**"], command: "exit 1" }] } },
  });
  const released = join(sb.root, "released");
  sb.env.ROLLCALL_RELEASED = released;
  const { task, wt } = withTask(sb, "feat");
  const a = shipper(sb, "feat", { "src/a.js": "a\n" }, { wt });
  assert.equal(a.ship("start", "--land").code, 0);
  assert.match(a.ship("start", "--land").stdout, /nothing to wait on/, "in a task: nothing to wait on");
  sb.lander();
  assert.deepEqual(outcomes(sb), [[1, "landed"]]);
  assert.match(last(sb).text, /rollcall now watches what the merge started and runs the release commands/);
  const sha = sb.gh().prs[0].mergeCommit;
  assert.equal(sb.queue().after[1].stage, "deploys");
  assert.equal(task().state, "queued", "the merge alone does not land a task whose after-merge runner is on its way");
  sb.setGh((s) => { s.merged = { checkRuns: [{ name: "build", status: "completed", conclusion: "success" }], deployments: [{ id: 7, environment: "Production", state: "success", url: "https://app.example" }] }; });
  const r = sb.after(1);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(released, "utf8").trim(), sha, "the release command ran at the merge commit");
  const o = last(sb);
  assert.equal(o.kind, "shipped");
  assert.match(o.text, /^#1 landed as [0-9a-f]{8}; 2 checks and deploys green \(deployed: Production \(https:\/\/app\.example\)\); release steps done: upload\.$/);
  const t1 = task();
  assert.equal(t1.state, "landed");
  assert.match(t1.output.text, /rollcall's ship script: #1 landed/);
  assert.match(sb.gh().prs[0].body, /^- CI: green; landed as [0-9a-f]{8}$/m);
  assert.match(a.ship("wait", "--timeout", "1").stdout, /ship: shipped - #1 landed/);
});

test("a red check is re-run once, then goes back to the task's worker with the failing part of its log", (t) => {
  const sb = repo(t, { ci: [{ name: "test", failIfGrep: "broken" }] });
  const { task, outbox, wt } = withTask(sb, "red");
  const a = shipper(sb, "red", { "src/a.js": "broken\n" }, { wt });
  sb.setGh((s) => { s.logs = { 100: "setup\nok 1 - fine\nnot ok 2 - adds\n  Error: expected 3, got 4\ncleanup\n" }; });
  assert.equal(a.ship("start", "--land").code, 0);
  sb.lander();
  assert.equal(sb.gh().reruns[100], 1, "the failed jobs ran once more");
  assert.deepEqual(outcomes(sb), [[1, "red"]]);
  const o = last(sb);
  assert.match(o.text, /^#1: test \(https:\/\/github\.com\/t\/repo\/actions\/runs\/100\/job\/1\) failed on its head [0-9a-f]{8}, and again when re-run once\. The failing part of its log: (\S+)\.log\./);
  assert.match(o.text, /then rollcall ship start --land again/);
  const log = /The failing part of its log: (\S+\.log)\./.exec(o.text)[1];
  assert.match(readFileSync(log, "utf8"), /Error: expected 3, got 4/);
  assert.equal(task().state, "working");
  assert.ok(outbox().some((x) => x.kind === "notice" && /^\[rollcall\] ship: #1: test .* failed/.test(x.text)), "the worker hears it as a notice");
  assert.equal(sb.queue().bounced[1], undefined, "a ship's own red check is no bounce");
  // The fix, pushed, and the ship again.
  write(join(a.wt, "src/a.js"), "fixed\n");
  git(a.wt, "commit", "-qam", "fix");
  git(a.wt, "push", "-q");
  assert.equal(a.ship("start", "--land").code, 0);
  sb.lander();
  assert.deepEqual(outcomes(sb), [[1, "red"], [1, "landed"]]);
});

test("a push while its checks are watched is followed; a PR-only ship ends green and says so on the PR", (t) => {
  const sb = repo(t, { ci: [{ name: "test", failIfGrep: "broken" }] });
  const a = shipper(sb, "feat-a", { "src/a.js": "broken\n" });
  sb.setGh((s) => { s.ci = [{ name: "test", pending: true }]; });
  assert.equal(a.ship("start").code, 0);
  sb.lander();
  write(join(a.wt, "src/a.js"), "fine\n");
  git(a.wt, "commit", "-qam", "fix");
  git(a.wt, "push", "-q");
  sb.setGh((s) => { s.ci = [{ name: "test", failIfGrep: "broken" }]; });
  sb.lander();
  assert.deepEqual(outcomes(sb), [[1, "green"]]);
  assert.match(last(sb).text, /checks are green and it has no open review thread\. It stays open/);
  assert.equal(sb.gh().prs[0].state, "OPEN");
  assert.match(sb.gh().prs[0].body, /^- CI: green$/m);
  assert.match(a.ship("wait", "--timeout", "1").stdout, /ship: green - #1/);
});

test("an open review thread comes back once the checks are green; the owner's word lands it with the threads open then", (t) => {
  const sb = repo(t);
  const a = shipper(sb, "feat-a", { "src/a.js": "a\n" });
  sb.setGh((s) => { s.prs[0].threads = [{ id: "T1", isResolved: false, isOutdated: false, path: "src/a.js", line: 1, comments: [{ author: { login: "rev", __typename: "User" }, body: "rename this", url: "u", createdAt: "2026-11-12T00:00:00Z" }] }]; });
  assert.equal(a.ship("start", "--land").code, 0);
  sb.lander();
  assert.deepEqual(outcomes(sb), [[1, "review"]]);
  assert.match(last(sb).text, /it has 1 open review thread: src\/a\.js:1, rev: "rename this"/);
  assert.equal(a.ship("start", "--land", "--owner-ok", "land it, I will rename later").code, 0);
  sb.lander();
  assert.deepEqual(outcomes(sb), [[1, "review"], [1, "landed"]]);
});

test("a release step that is a skill wakes the worker for the rest; a failed deploy stops before any release step", (t) => {
  const sb = repo(t, { manifest: { release: { merge: "squash", afterMerge: [{ name: "first", command: "true" }, { name: "testflight", skill: "ship-build", args: "post-merge" }, { name: "last", command: "true" }] } } });
  const { task, outbox, wt } = withTask(sb, "skill");
  const a = shipper(sb, "skill", { "src/a.js": "a\n" }, { wt });
  assert.equal(a.ship("start", "--land").code, 0);
  sb.lander();
  assert.equal(sb.after(1).status, 0);
  const o = last(sb);
  assert.equal(o.kind, "release-step");
  assert.match(o.text, /the merge started nothing on GitHub\. Release steps done: first\. Next, from merged main, in order: \/ship-build post-merge, then `true`\. Then save your report and set the task landed\./);
  assert.equal(task().state, "working");
  assert.ok(outbox().some((x) => /ship: #1 landed/.test(x.text)));

  // Another PR whose merge started a deploy that failed: no release step runs.
  const b = shipper(sb, "feat-b", { "src/b.js": "b\n" });
  assert.equal(b.ship("start", "--land").code, 0);
  sb.lander();
  sb.setGh((s) => { s.merged = { checkRuns: [{ name: "deploy", status: "completed", conclusion: "failure", details_url: "https://ci/run/9" }] }; });
  assert.equal(sb.after(2).status, 1);
  assert.equal(last(sb).kind, "after-failed");
  assert.match(last(sb).text, /what the merge started failed: deploy \(https:\/\/ci\/run\/9\)\. No release step ran\./);
});

test("after the merge, the wait covers the deployments and required checks; a long run beside them is named, not waited on", (t) => {
  const sb = repo(t, { manifest: { release: { merge: "squash", afterMerge: [{ name: "upload", command: "true" }] } }, ci: [{ name: "test", required: true }] });
  const a = shipper(sb, "feat", { "src/a.js": "a\n" });
  assert.equal(a.ship("start", "--land").code, 0);
  sb.lander();
  sb.setGh((s) => {
    s.merged = {
      checkRuns: [{ name: "test", status: "completed", conclusion: "success", check_suite: { id: 1 } }, { name: "Unit + UI tests", status: "in_progress", conclusion: null, check_suite: { id: 2 } }],
      deployments: [{ id: 7, environment: "staging", state: "success" }],
    };
  });
  const r = sb.after(1);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(last(sb).kind, "shipped");
  assert.match(last(sb).text, /2 checks and deploys green \(deployed: staging\); still running, not waited on: Unit \+ UI tests; release steps done: upload\./);
});

test("a missing required check holds its workflow run; release.waitFor names more to wait for, and only a run it names can time the wait out", (t) => {
  const sb = repo(t, { manifest: { release: { merge: "squash", waitFor: ["deployments", "required", "Unit*"] } }, ci: [{ name: "test", required: true }, { name: "lint", required: true }] });
  sb.env.ROLLCALL_SHIP_DEPLOY_MINUTES = "0.01";
  const a = shipper(sb, "feat", { "src/a.js": "a\n" });
  assert.equal(a.ship("start", "--land").code, 0);
  sb.lander();
  // lint has not started (a job waiting on another): its workflow run (suite 1) is waited on, though build is not required.
  sb.setGh((s) => { s.merged = { checkRuns: [{ name: "test", status: "completed", conclusion: "success", check_suite: { id: 1 } }, { name: "build", status: "in_progress", check_suite: { id: 1 } }, { name: "Nightly", status: "in_progress", check_suite: { id: 3 } }] }; });
  assert.equal(sb.after(1).status, 1);
  assert.equal(last(sb).kind, "after-failed");
  assert.match(last(sb).text, /what the release waits for \(release\.waitFor\) was still running after \d+m: build\./);

  // A run release.waitFor names by pattern is waited on; Nightly, named by nothing, is not.
  const b = shipper(sb, "feat-b", { "src/b.js": "b\n" });
  assert.equal(b.ship("start", "--land").code, 0);
  sb.lander();
  sb.setGh((s) => { s.merged = { checkRuns: [{ name: "test", status: "completed", conclusion: "success" }, { name: "lint", status: "completed", conclusion: "success" }, { name: "Unit + UI tests", status: "in_progress" }, { name: "Nightly", status: "in_progress" }] }; });
  assert.equal(sb.after(2).status, 1);
  assert.match(last(sb).text, /was still running after \d+m: Unit \+ UI tests\./);
});

test("ship workflow starts a workflow, finds its run, waits for it, and exits by its result", (t) => {
  const sb = repo(t);
  sb.setGh((s) => { s.dispatch = { "build.yml": { conclusion: "success", polls: 2 }, "old.yml": { conclusion: "success", noLink: true }, "red.yml": { conclusion: "failure" } }; s.logs = { 5002: "setup\nError: signing failed\nmore" }; });
  const ok = sb.run("ship", "workflow", "build.yml", "--ref", "main", "-f", "build=staging", "-f", "ref=abc123");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /started build\.yml on main, run 5000; waiting for it to end[\s\S]*build\.yml passed: https:\/\/github\.com\/t\/repo\/actions\/runs\/5000/);
  assert.deepEqual(sb.gh().runs[0].fields, ["build=staging", "ref=abc123"]);
  const old = sb.run("ship", "workflow", "old.yml");
  assert.equal(old.status, 0, old.stderr);
  assert.match(old.stdout, /run 5001;[\s\S]*old\.yml passed/, "with no link from gh, the new run is the one that was not there before");
  const red = sb.run("ship", "workflow", "red.yml");
  assert.equal(red.status, 1);
  assert.match(red.stdout, /red\.yml ended failure: \S+\/runs\/5002[\s\S]*the failing part of its log:\nsetup\nError: signing failed/);
  assert.match(sb.run("ship", "workflow", "build.yml", "--bogus").stderr, /unexpected "--bogus"/);
});
