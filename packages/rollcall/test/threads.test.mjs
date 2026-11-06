// PR review threads in the ship loop. Done when: the worker can list a PR's open threads (people and bots),
// answer and resolve them; a bot's repeat of an answered thread never blocks; the merge queue takes no PR with
// open threads unless the owner said so; and a thread opened after a PR joined sends it back to its worker.
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { BIN, FIXTURES, git, sandbox, write } from "./helpers.mjs";
import { sortThreads } from "../src/threads.mjs";

const GH = join(FIXTURES, "gh");
chmodSync(GH, 0o755);

/** A sandbox with a fake GitHub (CI on PRs, one check that passes). */
function repo(t) {
  const sb = sandbox(t);
  write(join(sb.main, ".claude/test-manifest.json"), JSON.stringify({ release: { merge: "merge" } }));
  write(join(sb.main, ".github/workflows/ci.yml"), "on: pull_request\n");
  git(sb.main, "add", "-A");
  git(sb.main, "commit", "-qm", "setup");
  git(sb.main, "push", "-q", "origin", "main");
  const state = join(sb.root, "gh.json");
  writeFileSync(state, JSON.stringify({ next: 1, prs: [], ci: [{ name: "test" }] }));
  sb.env = {
    ...sb.env, PATH: `${join(FIXTURES, "mergiraf-off")}:${sb.env.PATH}`, ROLLCALL_GH: GH, FAKE_GH_STATE: state, FAKE_GH_ORIGIN: sb.origin,
    ROLLCALL_QUEUE_LANDER: "0", ROLLCALL_QUEUE_POLL_MS: "50", ROLLCALL_QUEUE_NO_CHECKS_MS: "200",
  };
  const gh = () => JSON.parse(readFileSync(state, "utf8"));
  const setGh = (fn) => { const s = gh(); fn(s); writeFileSync(state, JSON.stringify(s)); };
  const lander = () => {
    const r = spawnSync(process.execPath, [BIN, "-C", sb.main, "queue", "lander", "--once"], { encoding: "utf8", env: sb.env });
    assert.equal(r.status, 0, r.stderr);
  };
  const outcomes = () => JSON.parse(spawnSync(process.execPath, [BIN, "-C", sb.main, "queue", "status", "--json"], { encoding: "utf8", env: sb.env }).stdout).recent;
  return { ...sb, gh, setGh, lander, outcomes };
}

/** A session on branch `name`, its change pushed and a PR open. */
function shipper(sb, name) {
  const wt = sb.worktree(name);
  const s = sb.session(wt);
  s.start();
  write(join(wt, `src/${name}.js`), `${name}\n`);
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", name);
  git(wt, "push", "-q", "-u", "origin", "HEAD");
  const r = spawnSync(GH, ["pr", "create", "--base", "main", "--head", name, "--title", name, "--body", name], { encoding: "utf8", env: sb.env });
  return Object.assign(s, { wt, pr: Number(/\/pull\/(\d+)/.exec(r.stdout)[1]) });
}

const comment = (login, body, bot = false) => ({ author: { login, __typename: bot ? "Bot" : "User" }, body, url: `https://github.com/t/repo/pull/1#c-${login}`, createdAt: "2026-11-06T10:00:00Z" });
const thread = (id, path, comments, extra = {}) => ({ id, isResolved: false, isOutdated: false, path, line: 3, comments, ...extra });
const addThreads = (sb, pr, ...ts) => sb.setGh((s) => { const p = s.prs.find((x) => x.number === pr); p.threads = [...(p.threads ?? []), ...ts]; });

test("sortThreads: a bot's repeat of an answered or resolved thread counts as answered; anything else stays open", () => {
  const shape = (id, by, bot, path, body, { resolved = false, replies = [] } = {}) => ({
    id, resolved, outdated: false, path, line: 1, by, bot, url: null,
    comments: [{ by, bot, body, url: null, at: null }, ...replies.map((r) => ({ by: r, bot: false, body: "done", url: null, at: null }))],
  });
  const r = sortThreads([
    shape("A", "lint-bot", true, "src/a.js", "Unused variable  x", { resolved: true }),
    shape("B", "lint-bot", true, "src/a.js", "Unused variable x\n"), // repeat of a resolved one (whitespace differs)
    shape("C", "lint-bot", true, "src/b.js", "Missing await", { replies: ["me"] }), // answered, not resolved: still open
    shape("D", "lint-bot", true, "src/b.js", "Missing await"), // repeat of an answered one
    shape("E", "other-bot", true, "src/a.js", "Unused variable x"), // another bot: its own point
    shape("F", "lint-bot", true, "src/c.js", "Unused variable x"), // another file
    shape("G", "owner", false, "src/a.js", "Unused variable x"), // a person is never a repeat
    shape("H", "lint-bot", true, "src/d.js", "Same twice"),
    shape("I", "lint-bot", true, "src/d.js", "Same twice"), // twice, neither answered: both open
  ]);
  assert.deepEqual(r.open.map((t) => t.id), ["C", "E", "F", "G", "H", "I"]);
  assert.deepEqual(r.repeats.map((t) => t.id), ["B", "D"]);
  assert.deepEqual(r.resolved.map((t) => t.id), ["A"]);
});

test("pr threads lists this branch's open threads, people and bots, and leaves out bot repeats", (t) => {
  const sb = repo(t);
  const a = shipper(sb, "feat-a");
  addThreads(sb, a.pr,
    thread("PRRT_1", "src/feat-a.js", [comment("owner", "Rename this to something clearer")]),
    thread("PRRT_2", "src/feat-a.js", [comment("review-bot", "Possible null dereference", true), comment("me", "Guarded on line 2")]),
    thread("PRRT_3", "src/feat-a.js", [comment("review-bot", "Possible  null dereference", true)]),
    thread("PRRT_4", "README.md", [comment("owner", "typo")], { isResolved: true }),
  );
  const r = a.cli(["pr", "threads"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /#1: 2 open review threads, 1 bot repeat of answered ones, 1 resolved/);
  assert.match(r.stdout, /1\. src\/feat-a\.js:3, owner: "Rename this to something clearer" \[PRRT_1\]/);
  assert.match(r.stdout, /2\. src\/feat-a\.js:3, review-bot \(bot\): "Possible null dereference" \(1 reply, last by me\) \[PRRT_2\]/);
  assert.doesNotMatch(r.stdout, /PRRT_3|PRRT_4/);
  assert.match(r.stdout, /rollcall pr reply <thread-id>/);
  const j = JSON.parse(a.cli(["pr", "threads", "--json"]).stdout);
  assert.deepEqual(j.open.map((x) => x.id), ["PRRT_1", "PRRT_2"]);
  assert.equal(j.open[1].comments[0].bot, true);
  assert.equal(j.repeats, 1);
  // gh's placeholders name the repo: the query never guesses owner and name.
  const call = sb.gh().calls.find((c) => c[0] === "api" && c[1] === "graphql");
  assert.ok(call.includes("owner={owner}") && call.includes("name={repo}") && call.includes("number=1"), call.join(" "));
  // A PR by number, from anywhere in the repo.
  assert.match(sb.session().cli(["pr", "threads", "1", "--all"]).stdout, /repeat: .*\[PRRT_3\][\s\S]*resolved: .*\[PRRT_4\]/);
});

test("pr reply and pr resolve send GitHub's thread mutations", (t) => {
  const sb = repo(t);
  const a = shipper(sb, "feat-a");
  addThreads(sb, a.pr, thread("PRRT_1", "src/feat-a.js", [comment("owner", "why?")]), thread("PRRT_2", "src/feat-a.js", [comment("owner", "fix")]));
  const r = a.cli(["pr", "reply", "PRRT_1", "@mention-free answer: it keeps the old name", "--resolve"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /answered PRRT_1: https:\/\/github\.com\/t\/repo\/pull\/1#discussion_r\d+\n.*resolved PRRT_1/);
  assert.equal(a.cli(["pr", "resolve", "PRRT_2"]).code, 0);
  const s = sb.gh();
  const gql = s.calls.filter((c) => c[1] === "graphql").map((c) => Object.fromEntries(c.slice(2).filter((_, i) => i % 2).map((x) => [x.split("=")[0], x.slice(x.indexOf("=") + 1)])));
  const reply = gql.find((f) => /addPullRequestReviewThreadReply\(input: \{ pullRequestReviewThreadId: \$id, body: \$body \}\)/.test(f.query));
  assert.deepEqual([reply.id, reply.body], ["PRRT_1", "@mention-free answer: it keeps the old name"]);
  // The body goes as text (-f), never through -F, which would read a leading @ as a file.
  const replyCall = s.calls.find((c) => c.some((x) => x.startsWith("body=")));
  assert.equal(replyCall[replyCall.findIndex((x) => x.startsWith("body=")) - 1], "-f");
  assert.deepEqual(gql.filter((f) => /resolveReviewThread\(input: \{ threadId: \$id \}\)/.test(f.query)).map((f) => f.id), ["PRRT_1", "PRRT_2"]);
  const threads = s.prs[0].threads;
  assert.ok(threads.every((x) => x.isResolved));
  assert.equal(threads[0].comments.at(-1).body, "@mention-free answer: it keeps the old name");
  assert.match(a.cli(["pr", "resolve", "PRRT_9"]).stderr, /could not resolve PRRT_9: GraphQL: Could not resolve/);
});

test("queue add refuses open review threads, names them and both ways forward; the owner's word lets it in", (t) => {
  const sb = repo(t);
  const a = shipper(sb, "feat-a");
  addThreads(sb, a.pr,
    thread("PRRT_1", "src/feat-a.js", [comment("owner", "Please add a test")]),
    thread("PRRT_2", "src/feat-a.js", [comment("lint-bot", "nit", true), comment("me", "fixed")], { isResolved: true }),
    thread("PRRT_3", "src/feat-a.js", [comment("lint-bot", "nit", true)]), // a bot repeat: never blocks
  );
  const no = a.cli(["queue", "add"]);
  assert.equal(no.code, 1);
  assert.match(no.stderr, /#1 has 1 open review thread:\n  - src\/feat-a\.js:3, owner: "Please add a test" \[PRRT_1\]\n/);
  assert.match(no.stderr, /Two ways forward: fix or answer each and resolve the fixed ones \(rollcall pr threads, rollcall pr reply, rollcall pr resolve\), push, then queue add; or, if the owner says to land it as it is, rollcall queue add --owner-ok "<their words>"/);
  assert.doesNotMatch(no.stderr, /PRRT_3/);
  assert.match(a.cli(["queue", "add", "--owner-ok", "  "]).stderr, /--owner-ok takes the owner's words/);

  const ok = a.cli(["queue", "add", "--owner-ok", "land it, the test comes in the next PR"]);
  assert.equal(ok.code, 0, ok.stderr);
  const q = JSON.parse(a.cli(["queue", "status", "--json"]).stdout);
  assert.deepEqual(q.waiting[0].threadsOk.ids, ["PRRT_1"]);
  assert.equal(q.waiting[0].threadsOk.words, "land it, the test comes in the next PR");

  // gh cannot say: no join on a guess.
  a.cli(["queue", "leave"]);
  sb.setGh((s) => { s.failGraphql = "HTTP 502"; });
  assert.match(a.cli(["queue", "add"]).stderr, /could not read #1's review threads \(HTTP 502\): try again/);
});

test("a thread opened after a PR joined sends it back to its worker; the threads the owner accepted and bot repeats do not", async (t) => {
  const sb = repo(t);
  const a = shipper(sb, "feat-a");
  const b = shipper(sb, "feat-b");
  addThreads(sb, a.pr, thread("PRRT_A1", "src/feat-a.js", [comment("owner", "fine for now")]));
  addThreads(sb, b.pr, thread("PRRT_B1", "src/feat-b.js", [comment("lint-bot", "nit", true), comment("me", "kept on purpose")], { isResolved: true }));
  assert.equal(a.cli(["queue", "add", "--owner-ok", "ship it with that thread open"]).code, 0);
  assert.equal(b.cli(["queue", "add"]).code, 0);
  // After both joined: a new thread on A from the phone, and the bot saying again what B answered.
  addThreads(sb, a.pr, thread("PRRT_A2", "src/feat-a.js", [comment("owner", "Actually, rename this")]));
  addThreads(sb, b.pr, thread("PRRT_B2", "src/feat-b.js", [comment("lint-bot", "nit", true)]));
  const w = a.cliAsync(["queue", "wait"]);
  sb.lander();
  const { stdout } = await w.exited;
  assert.match(stdout, /queue: review - #1 got 1 review thread after it joined, so it left the merge queue: src\/feat-a\.js:3, owner: "Actually, rename this" \[PRRT_A2\]\. Next: rollcall pr threads, fix or answer each/);
  assert.doesNotMatch(stdout, /PRRT_A1/);
  assert.deepEqual(sb.outcomes().map((o) => [o.pr, o.kind]), [[1, "review"], [2, "landed"]]);
  assert.equal(sb.gh().prs.find((p) => p.number === 1).state, "OPEN");
  // Its session hears it on its next tool call, like any other queue news.
  assert.match(a.bash().context, /\[rollcall\] merge queue: #1 got 1 review thread after it joined/);
  // Not a bounce: nothing counts it toward parking.
  const qfile = JSON.parse(spawnSync(process.execPath, [BIN, "-C", sb.main, "queue", "status", "--json"], { encoding: "utf8", env: sb.env }).stdout);
  assert.equal(qfile.parked.length, 0);
});
