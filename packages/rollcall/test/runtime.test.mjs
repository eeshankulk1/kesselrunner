// Done when (plan A, the worktree runtime): two tasks on one web app run their dev servers at once, each on its own
// ports, and `serving` tells each task's check which server is its own; a new task's worktree has its env files
// copied and its setup run before the worker starts, and a broken setup shows on the task with a one-command rerun;
// a spotlit task runs from the main checkout, and turning it off leaves the main checkout byte-identical; an
// archived task frees its folder and ports, and restore brings back its uncommitted work; a task from an issue, a
// PR or a branch starts where that work is.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { git, sandbox, until, write } from "./helpers.mjs";

const json = (r) => { assert.equal(r.code, 0, r.stderr || r.stdout); return JSON.parse(r.stdout); };
// Each test file runs in its own process: a range of its own keeps parallel suites off each other's ports.
const PORT_MIN = 42000 + (process.pid % 300) * 20;
const portEnv = { ROLLCALL_PORT_MIN: String(PORT_MIN), ROLLCALL_PORT_MAX: String(PORT_MIN + 59), ROLLCALL_RUN_SETTLE_MS: "800" };
const workerEnv = (h, id) => ({ env: { ROLLCALL_TASK: `${h}:${id}` } });

/** A supervisor `alpha` over a sandbox whose repo has a test manifest (committed and pushed) and the extra files given. */
function project(t, manifest, files = {}) {
  const sb = sandbox(t);
  Object.assign(sb.env, portEnv);
  write(join(sb.main, ".claude/test-manifest.json"), JSON.stringify(manifest, null, 2));
  for (const [f, text] of Object.entries(files)) write(join(sb.main, f), text);
  git(sb.main, "add", ".");
  git(sb.main, "commit", "-qm", "manifest");
  git(sb.main, "push", "-q", "origin", "main");
  const sup = sb.session(sb.root);
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  return { sb, sup };
}

const SERVER = `require("http").createServer((q, s) => s.end("from " + process.cwd())).listen(Number(process.argv[2]), "127.0.0.1");\n`;

async function setupDone(sup, wt) {
  return until(() => {
    const s = JSON.parse(sup.cli(["setup", "--json"], { cwd: wt }).stdout || "null");
    return s && s.state !== "running" ? s : null;
  }, { timeout: 20_000 });
}

/** Every file under `dir` but .git, with its bytes: what "byte-identical" compares. */
function treeHash(dir) {
  const h = createHash("sha1");
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (n === ".git" || relative(dir, p) === join(".claude", "worktrees")) continue;
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(`${relative(dir, p)}\0${st.mode}\0`).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

test("two tasks on one web app run their dev servers at once on their own ports, and serving tells each check its own", async (t) => {
  const { sb, sup } = project(t, {
    run: { web: { command: "node server.js {port}", url: "http://127.0.0.1:{port}" }, api: { command: "node server.js {port+1}", url: "http://127.0.0.1:{port+1}/docs" } },
    devServer: { port: "{port}", baseUrl: "http://127.0.0.1:{port}" },
  }, { "server.js": SERVER });
  assert.equal(sup.cli(["task", "new", "one", "--repo", sb.main]).code, 0);
  assert.equal(sup.cli(["task", "new", "two", "--repo", sb.main]).code, 0);
  const one = json(sup.cli(["task", "show", "t1", "--json"]));
  const two = json(sup.cli(["task", "show", "t2", "--json"]));
  assert.ok(one.runtime.ports && two.runtime.ports, "each task got a block of ports at task new");
  assert.notEqual(one.runtime.ports.base, two.runtime.ports.base);
  assert.equal(two.runtime.ports.base - one.runtime.ports.base, 10, "blocks of 10, the lowest free first");

  // The manifest reads with each checkout's own ports filled in.
  const m1 = json(sup.cli(["manifest", "--json"], { cwd: one.worktree }));
  assert.equal(m1.devServer.baseUrl, `http://127.0.0.1:${one.runtime.ports.base}`);
  assert.equal(m1.run.api.url, `http://127.0.0.1:${one.runtime.ports.base + 1}/docs`);

  const started1 = sup.cli(["task", "run", "t1", "start", "web"]);
  assert.equal(started1.code, 0, started1.stdout + started1.stderr);
  assert.equal(sup.cli(["task", "run", "t2", "start", "web"]).code, 0);
  t.after(() => { sup.cli(["task", "run", "t1", "stop", "all"]); sup.cli(["task", "run", "t2", "stop", "all"]); });
  const p1 = one.runtime.ports.base;
  const p2 = two.runtime.ports.base;
  const body = async (p) => (await fetch(`http://127.0.0.1:${p}`)).text();
  assert.equal(await until(() => body(p1).catch(() => null)), `from ${one.worktree}`);
  assert.equal(await until(() => body(p2).catch(() => null)), `from ${two.worktree}`);

  // The check a tester runs before it trusts a result: its own server, not the other task's.
  const mine = sup.cli(["serving", String(p1)], { cwd: one.worktree });
  assert.equal(mine.code, 0, mine.stdout + mine.stderr);
  assert.match(mine.stdout, /this checkout/);
  const theirs = sup.cli(["serving", `http://127.0.0.1:${p2}/`], { cwd: one.worktree });
  assert.equal(theirs.code, 1);
  assert.match(theirs.stdout, /task t2 of alpha.*NOT this checkout/);
  assert.equal(sup.cli(["serving", String(p1 + 5)], { cwd: one.worktree }).code, 2, "nothing listens there");

  // Preview links in task show, and in its JSON for the front ends.
  const shown = json(sup.cli(["task", "show", "t1", "--json"])).runtime;
  assert.deepEqual(shown.previews, [`http://127.0.0.1:${p1}`]);
  assert.match(sup.cli(["task", "show", "t1"]).stdout, new RegExp(`run web: running at http://127.0.0.1:${p1}`));
  assert.match(sup.cli(["task", "run", "t1", "start", "web"]).stdout, /running already/);

  // Stop takes the whole group down, and a crash on start says so with its log.
  assert.match(sup.cli(["task", "run", "t1", "stop", "web"]).stdout, /web: stopped/);
  await until(() => body(p1).then(() => false, () => true));
  const crash = sup.cli(["run", "start", "web"], { cwd: two.worktree });
  assert.match(crash.stdout, /running already/);
  write(join(one.worktree, ".claude/test-manifest.json"), JSON.stringify({ run: { bad: { command: "echo boom; exit 3" } } }));
  const bad = sup.cli(["run", "start", "bad"], { cwd: one.worktree });
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /bad: exited at once; the end of its log[^\n]*\n.*boom/s);
});

test("a new task's worktree gets its .worktreeinclude files and setup before its worker starts; a broken setup is loud and reruns with one command", async (t) => {
  const { sb, sup } = project(t, {
    worktree: { setup: `test ! -f "$ROLLCALL_MAIN_CHECKOUT/fail-setup" && echo "port $ROLLCALL_PORT task $ROLLCALL_TASK_ID" > setup-ran.txt || { echo "no database for you" >&2; exit 4; }` },
    devServer: { baseUrl: "http://localhost:{port}" },
  }, { ".gitignore": ".env\n.env.*\nsetup-ran.txt\nbuild/\n", ".worktreeinclude": ".env\n.env.local\n" });
  write(join(sb.main, ".env"), "SECRET=1\n");
  write(join(sb.main, ".env.local"), "LOCAL=1\n");
  write(join(sb.main, ".env.prod"), "PROD=1\n");
  write(join(sb.main, "build/out.js"), "x\n");

  const made = sup.cli(["task", "new", "with setup", "--repo", sb.main]);
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, /ports \d+-\d+\n  setup running in the background: test ! -f/);
  const task = json(sup.cli(["task", "show", "t1", "--json"]));
  const s = await setupDone(sup, task.worktree);
  assert.equal(s.state, "done");
  assert.deepEqual(s.copied.sort(), [".env", ".env.local"], "only what .worktreeinclude names, and only gitignored files");
  assert.equal(readFileSync(join(task.worktree, ".env"), "utf8"), "SECRET=1\n");
  assert.ok(!existsSync(join(task.worktree, ".env.prod")) && !existsSync(join(task.worktree, "build")));
  assert.equal(readFileSync(join(task.worktree, "setup-ran.txt"), "utf8"), `port ${task.runtime.ports.base} task t1\n`, "setup gets the task's identity and ports");
  assert.match(sup.cli(["task", "show", "t1"]).stdout, /setup done: copied 2 files from \.worktreeinclude, then ran `test ! -f/);
  // The launch script waits on `setup --wait`, which returns at once now.
  assert.equal(sup.cli(["setup", "--wait", "--quiet"], { cwd: task.worktree }).code, 0);

  // A broken setup: on the task, a note, and news for the supervisor, once.
  write(join(sb.main, "fail-setup"), "");
  assert.equal(sup.cli(["task", "new", "broken setup", "--repo", sb.main]).code, 0);
  const t2 = json(sup.cli(["task", "show", "t2", "--json"]));
  const failed = await setupDone(sup, t2.worktree);
  assert.equal(failed.state, "failed");
  assert.equal(failed.exit, 4);
  const shown = sup.cli(["task", "show", "t2"]).stdout;
  assert.match(shown, /setup FAILED \(exit 4\): rollcall: setup failed \(exit 4\)|setup FAILED \(exit 4\): no database for you/);
  assert.match(shown, /rerun: rollcall task setup t2 --rerun/);
  assert.match(shown, /rollcall: setup failed: /);
  const wakes = readdirSync(join(sb.home, "_supervisors/alpha/wake")).filter((n) => n.startsWith("q-")).map((n) => JSON.parse(readFileSync(join(sb.home, "_supervisors/alpha/wake", n), "utf8")));
  assert.deepEqual(wakes.filter((w) => w.kind === "setup-failed").map((w) => w.task), ["t2"]);
  const said = sup.cli(["task", "setup", "t2"]);
  assert.equal(said.code, 1);
  assert.match(said.stdout, /the end of its log:[\s\S]*no database for you[\s\S]*rollcall setup --rerun/);

  rmSync(join(sb.main, "fail-setup"));
  assert.match(sup.cli(["task", "setup", "t2", "--rerun"]).stdout, /setup started again in the background/);
  assert.equal((await setupDone(sup, t2.worktree)).state, "done");
  assert.ok(existsSync(join(t2.worktree, "setup-ran.txt")));
});

test("spotlight runs a task's files from the main checkout, follows them, and off leaves the main checkout byte-identical", (t) => {
  const { sb, sup } = project(t, {}, { ".gitignore": ".claude/worktrees/\nnode_modules/\n" });
  write(join(sb.main, "notes.txt"), "the owner's own untracked notes\n");
  write(join(sb.main, "node_modules/x.js"), "ignored\n");
  assert.equal(sup.cli(["task", "new", "spot me", "--repo", sb.main]).code, 0);
  const wt = json(sup.cli(["task", "show", "t1", "--json"])).worktree;
  write(join(wt, "src/a.js"), "committed change\n");
  git(wt, "commit", "-qam", "work");
  write(join(wt, "src/b.js"), "uncommitted change\n");
  write(join(wt, "src/new.js"), "a new file, untracked\n");
  const before = treeHash(sb.main);
  const head = git(sb.main, "rev-parse", "HEAD");

  const refused = sup.cli(["task", "spotlight", "t1"], workerEnv("alpha", "t1"));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /the owner's or the supervisor's action, not a worker's/);
  write(join(sb.main, "README.md"), "edited in the main checkout\n");
  assert.match(sup.cli(["task", "spotlight", "t1"]).stderr, /the main checkout has uncommitted work of its own \(1 file: README\.md\)/);
  git(sb.main, "checkout", "--", "README.md");

  const on = sup.cli(["task", "spotlight", "t1"]);
  assert.equal(on.code, 0, on.stderr);
  assert.equal(readFileSync(join(sb.main, "src/a.js"), "utf8"), "committed change\n");
  assert.equal(readFileSync(join(sb.main, "src/b.js"), "utf8"), "uncommitted change\n");
  assert.equal(readFileSync(join(sb.main, "src/new.js"), "utf8"), "a new file, untracked\n");
  assert.equal(git(sb.main, "rev-parse", "main"), head, "no branch moved");
  assert.ok(json(sup.cli(["task", "show", "t1", "--json"])).runtime.spotlit);
  assert.equal(sup.cli(["task", "new", "another", "--repo", sb.main]).code, 0);
  assert.match(sup.cli(["task", "spotlight", "t2"]).stderr, /alpha:t1 holds the spotlight/);

  // It follows the task's changes.
  write(join(wt, "src/b.js"), "changed again\n");
  rmSync(join(wt, "src/new.js"));
  assert.match(sup.cli(["task", "spotlight", "t1", "--sync"]).stdout, /now has its latest files/);
  assert.equal(readFileSync(join(sb.main, "src/b.js"), "utf8"), "changed again\n");
  assert.ok(!existsSync(join(sb.main, "src/new.js")));

  const off = sup.cli(["task", "spotlight", "t1", "--off"]);
  assert.equal(off.code, 0, off.stderr);
  assert.match(off.stdout, /back on main, its files as they were/);
  assert.equal(git(sb.main, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(treeHash(sb.main), before, "byte-identical, untracked and ignored files included");
  assert.equal(readFileSync(join(wt, "src/b.js"), "utf8"), "changed again\n", "the task's own files are untouched");
});

test("archive frees a task's folder and ports and keeps its work; restore brings it back and says when origin moved", async (t) => {
  const { sb, sup } = project(t, { run: { web: { command: "node server.js {port}", url: "http://127.0.0.1:{port}" } } }, { "server.js": SERVER, ".gitignore": ".env\n" });
  assert.equal(sup.cli(["task", "new", "park me", "--repo", sb.main]).code, 0);
  const task = json(sup.cli(["task", "show", "t1", "--json"]));
  const wt = task.worktree;
  const port = task.runtime.ports.base;
  write(join(wt, "src/a.js"), "committed\n");
  git(wt, "commit", "-qam", "work");
  git(wt, "push", "-q", "-u", "origin", task.branch);
  write(join(wt, "src/b.js"), "modified, unstaged\n");
  write(join(wt, "src/staged.js"), "new, staged\n");
  git(wt, "add", "src/staged.js");
  write(join(wt, "notes/untracked.md"), "new, untracked\n");
  rmSync(join(wt, "README.md"));
  write(join(wt, ".env"), "ignored\n");
  assert.equal(sup.cli(["task", "run", "t1", "start", "web"]).code, 0);
  t.after(() => sup.cli(["task", "run", "t1", "stop", "all"]));
  await until(() => fetch(`http://127.0.0.1:${port}`).then(() => true, () => false));

  // First what goes and how much it frees; nothing is removed.
  const plan = sup.cli(["task", "archive", "t1"]);
  assert.equal(plan.code, 0, plan.stderr);
  assert.match(plan.stdout, /removes its worktree .*park-me \(\d+ MB freed\)/);
  assert.match(plan.stdout, /uncommitted: 4 files, saved to refs\/rollcall\/archive\/alpha\/t1/);
  assert.match(plan.stdout, /run actions stop: web/);
  assert.match(plan.stdout, new RegExp(`ports ${port}-${port + 9} go back to the pool`));
  assert.match(plan.stdout, /task archive t1 --yes/);
  assert.ok(existsSync(wt));
  assert.match(sup.cli(["task", "archive", "t1", "--yes"], workerEnv("alpha", "t1")).stderr, /not a worker's/);

  const done = sup.cli(["task", "archive", "t1", "--yes"]);
  assert.equal(done.code, 0, done.stderr);
  assert.ok(!existsSync(wt), "the folder is gone");
  await until(() => fetch(`http://127.0.0.1:${port}`).then(() => false, () => true));
  assert.ok(!readFileSync(join(sb.home, "_runtime/ports.json"), "utf8").includes(wt), "its ports went back");
  assert.ok(git(sb.main, "rev-parse", "refs/rollcall/archive/alpha/t1"));
  const archived = json(sup.cli(["task", "show", "t1", "--json"]));
  assert.equal(archived.state, "working", "the task stays as it was");
  assert.equal(archived.archived.files, 4);
  assert.match(sup.cli(["task", "show", "t1"]).stdout, /archived .*restore t1/);
  assert.match(sup.cli(["task", "list"]).stdout, /park me {2}\(archived\)/);
  assert.match(sup.cli(["task", "run", "t1", "list"]).stderr, /t1 is archived: rollcall task restore t1/);
  // Its port block is free for the next task.
  assert.equal(sup.cli(["task", "new", "next", "--repo", sb.main]).code, 0);
  assert.equal(json(sup.cli(["task", "show", "t2", "--json"])).runtime.ports.base, port);

  // Someone pushed to its branch meanwhile: restore says so and changes nothing about it.
  const other = sb.otherClone();
  git(other, "checkout", "-q", task.branch);
  write(join(other, "src/c.js"), "theirs\n");
  git(other, "add", ".");
  git(other, "commit", "-qm", "theirs");
  git(other, "push", "-q", "origin", task.branch);

  const back = sup.cli(["task", "restore", "t1"]);
  assert.equal(back.code, 0, back.stderr);
  assert.match(back.stdout, new RegExp(`origin/${task.branch.replace("/", "\\/")} moved on 1 commit while archived; nothing was merged or rebased`));
  assert.equal(readFileSync(join(wt, "src/a.js"), "utf8"), "committed\n");
  assert.equal(readFileSync(join(wt, "src/b.js"), "utf8"), "modified, unstaged\n");
  assert.equal(readFileSync(join(wt, "src/staged.js"), "utf8"), "new, staged\n");
  assert.equal(readFileSync(join(wt, "notes/untracked.md"), "utf8"), "new, untracked\n");
  assert.ok(!existsSync(join(wt, "README.md")), "a deletion comes back too");
  assert.ok(!existsSync(join(wt, ".env")), "gitignored files went with the folder");
  assert.equal(git(wt, "rev-parse", "HEAD"), git(sb.main, "rev-parse", task.branch));
  assert.ok(!existsSync(join(wt, "src/c.js")), "origin's new commit is not brought in");
  assert.equal(spawnSync("git", ["-C", sb.main, "rev-parse", "--verify", "--quiet", "refs/rollcall/archive/alpha/t1"]).status, 1, "the archive ref goes once the work is back");
  const restored = json(sup.cli(["task", "show", "t1", "--json"]));
  assert.equal(restored.archived, undefined);
  assert.ok(restored.runtime.ports, "it holds ports again");
});

test("a task starts from a GitHub issue (its words), an open PR (its branch) or an existing branch", (t) => {
  const { sb, sup } = project(t, {});
  // A branch on origin for the PR, and one only local.
  git(sb.main, "checkout", "-q", "-b", "feat/from-pr");
  write(join(sb.main, "src/pr.js"), "pr\n");
  git(sb.main, "add", ".");
  git(sb.main, "commit", "-qm", "pr work");
  git(sb.main, "push", "-q", "origin", "feat/from-pr");
  git(sb.main, "checkout", "-q", "main");
  git(sb.main, "branch", "-q", "-D", "feat/from-pr");
  git(sb.main, "branch", "-q", "spike/local", "main");
  const gh = join(sb.root, "fake-gh");
  write(gh, `#!/bin/sh
case "$*" in
  *"issue view 12"*) printf '%s\\n' '{"number":12,"title":"Header says main","body":"It should say Messages.\\nKeep the icon.","url":"https://github.com/o/r/issues/12","state":"OPEN"}';;
  *"issue view 13"*) printf '%s\\n' '{"number":13,"title":"Old","body":"","url":"https://github.com/o/r/issues/13","state":"CLOSED"}';;
  *"pr view 5"*) printf '%s\\n' '{"number":5,"title":"Half-done PR","url":"https://github.com/o/r/pull/5","headRefName":"feat/from-pr","isCrossRepository":false,"state":"OPEN"}';;
  *"pr view 6"*) printf '%s\\n' '{"number":6,"title":"Fork","url":"https://github.com/o/r/pull/6","headRefName":"x","isCrossRepository":true,"state":"OPEN"}';;
  *) echo "no such thing" >&2; exit 1;;
esac
`);
  spawnSync("chmod", ["+x", gh]);
  const env = { env: { ROLLCALL_GH: gh } };

  const issue = sup.cli(["task", "new", "--repo", sb.main, "--issue", "https://github.com/o/r/issues/12", "--words", "do this one next"], env);
  assert.equal(issue.code, 0, issue.stderr);
  const t1 = json(sup.cli(["task", "show", "t1", "--json"]));
  assert.equal(t1.title, "Header says main");
  assert.deepEqual(t1.from, { kind: "issue", number: 12, url: "https://github.com/o/r/issues/12" });
  assert.equal(t1.words[0].via, "issue");
  assert.equal(t1.words[0].text, "GitHub issue #12: Header says main\nhttps://github.com/o/r/issues/12\n\nIt should say Messages.\nKeep the icon.");
  assert.equal(t1.words[1].text, "do this one next");
  assert.match(t1.branch, /^feat\/header-says-main$/);
  assert.match(sup.cli(["task", "new", "--repo", sb.main, "--issue", "13"], env).stderr, /issue #13 is closed: nothing was created/);

  const pr = sup.cli(["task", "new", "--repo", sb.main, "--pr", "#5"], env);
  assert.equal(pr.code, 0, pr.stderr);
  const t2 = json(sup.cli(["task", "show", "t2", "--json"]));
  assert.equal(t2.branch, "feat/from-pr");
  assert.equal(t2.pr, "https://github.com/o/r/pull/5");
  assert.equal(readFileSync(join(t2.worktree, "src/pr.js"), "utf8"), "pr\n", "the PR's branch, checked out as it is");
  assert.equal(git(t2.worktree, "rev-parse", "HEAD"), git(sb.main, "rev-parse", "origin/feat/from-pr"));
  assert.match(t2.notes.at(-1).text, /carries on PR #5 .* push to it, no new PR/);
  assert.match(sup.cli(["task", "new", "--repo", sb.main, "--pr", "6"], env).stderr, /comes from a fork/);
  assert.match(sup.cli(["task", "new", "x", "--repo", sb.main, "--pr", "5", "--base", "main"], env).stderr, /take no --base/);

  const br = sup.cli(["task", "new", "carry the spike", "--repo", sb.main, "--branch", "spike/local"]);
  assert.equal(br.code, 0, br.stderr);
  const t3 = json(sup.cli(["task", "show", "t3", "--json"]));
  assert.equal(t3.branch, "spike/local");
  assert.ok(t3.worktree.endsWith("/.claude/worktrees/local"));
  assert.match(sup.cli(["task", "new", "x", "--repo", sb.main, "--branch", "nope/none"]).stderr, /no branch nope\/none here or on origin/);
  assert.match(sup.cli(["task", "new", "x", "--repo", sb.main, "--branch", "spike/local"]).stderr, /a worktree has it already: --worktree <that folder> takes it over/);
});

test("gc gives a merged worktree's ports back and stops its run actions", async (t) => {
  const { sb, sup } = project(t, { run: { web: { command: "node server.js {port}" } } }, { "server.js": SERVER });
  const wt = sb.worktree("feat/done");
  const ports = json(sup.cli(["ports", "--json"], { cwd: wt })).ports;
  assert.ok(ports.base >= PORT_MIN);
  assert.equal(sup.cli(["run", "start", "web"], { cwd: wt }).code, 0);
  await until(() => fetch(`http://127.0.0.1:${ports.base}`).then(() => true, () => false));
  write(join(wt, "src/done.js"), "done\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "done");
  git(sb.main, "merge", "-q", "feat/done");
  git(sb.main, "push", "-q", "origin", "main");
  const gc = sup.cli(["gc"], { cwd: sb.main });
  assert.match(gc.stdout, /removed 1 merged worktree/, gc.stdout + gc.stderr);
  assert.ok(!existsSync(wt));
  await until(() => fetch(`http://127.0.0.1:${ports.base}`).then(() => false, () => true));
  assert.ok(!readFileSync(join(sb.home, "_runtime/ports.json"), "utf8").includes(wt));
});
