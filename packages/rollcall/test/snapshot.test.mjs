// Done when: each turn in a task worktree leaves a private snapshot (tracked and untracked files, gitignored
// ones left out) that shows what the turn changed, shell-written files included, and can put the worktree back;
// taking one changes nothing git shows the worker, a push never carries one, and gc prunes them with the worktree.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, sandbox, until, write } from "./helpers.mjs";

const ON = { ROLLCALL_SNAPSHOTS: "1" };
const snapOf = (sb, top) => join(sb.home, "_snapshots", `${createHash("sha1").update(top).digest("hex").slice(0, 16)}.git`);
const turnsOf = (s, cwd) => {
  const r = s.cli(["turns", "--json"], { cwd, env: ON });
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout).turns;
};

/** A worktree with an ignored folder, a session started in it, and its turn-0 baseline taken by SessionStart. */
async function started(t, name = "gen") {
  const sb = sandbox(t);
  write(join(sb.main, ".gitignore"), "node_modules/\n");
  git(sb.main, "add", ".gitignore");
  git(sb.main, "commit", "-qm", "ignore");
  const wt = sb.worktree(name);
  const s = sb.session(wt);
  s.env = { ...s.env, ...ON };
  s.start();
  await until(() => turnsOf(s, wt).length === 1);
  return { sb, wt, s };
}

test("a turn that runs a code generator shows its files; restoring the turn before removes them, and that is undoable", async (t) => {
  const { sb, wt, s } = await started(t);
  const [base] = turnsOf(s, wt);
  assert.equal(base.n, 0);
  assert.equal(base.kind, "baseline");

  // The turn: a shell "code generator" writes untracked files, an edit changes a tracked one, a build writes an ignored one.
  s.prompt("generate the client");
  for (const f of ["gen/client.js", "gen/types.d.ts", "gen/nested/deep.js"]) write(join(wt, f), `// generated ${f}\n`);
  write(join(wt, "src/a.js"), "src/a.js edited\n");
  write(join(wt, "node_modules/dep/index.js"), "ignored\n");
  s.stop(); // the Stop hook takes it in the background
  await until(() => turnsOf(s, wt).length === 2);

  const [, one] = turnsOf(s, wt);
  assert.equal(one.n, 1);
  assert.equal(one.session, s.id);
  assert.deepEqual(one.files.map((f) => `${f.status} ${f.path}`).sort(), ["A gen/client.js", "A gen/nested/deep.js", "A gen/types.d.ts", "M src/a.js"]);
  const diff = s.cli(["turns", "diff", "1"], { cwd: wt, env: ON });
  assert.equal(diff.code, 0, diff.stderr);
  assert.match(diff.stdout, /\+\/\/ generated gen\/client\.js/);
  assert.doesNotMatch(diff.stdout, /node_modules/, "gitignored files stay out");

  // A second turn changes nothing: no new turn is written.
  s.prompt("look around");
  s.stop();
  const again = s.cli(["turns", "take"], { cwd: wt, env: ON });
  assert.match(again.stdout, /no change since turn 1/);

  // Put it back to turn 0: the generated files go (their empty folders too), the edit is undone, ignored files stay.
  const head = git(wt, "rev-parse", "HEAD");
  const r = s.cli(["turns", "restore", "0"], { cwd: wt, env: ON });
  assert.equal(r.code, 0, r.stderr);
  // The state it replaced equals turn 1 (nothing changed since), so turn 1 is the undo.
  assert.match(r.stdout, /undo: .*turns restore 1\b/);
  assert.ok(!existsSync(join(wt, "gen")), "generated files and their folders are gone");
  assert.equal(readFileSync(join(wt, "src/a.js"), "utf8"), "src/a.js\n");
  assert.ok(existsSync(join(wt, "node_modules/dep/index.js")), "ignored files are left alone");
  assert.equal(git(wt, "status", "--porcelain"), "", "the worktree matches its commit again");
  assert.equal(git(wt, "rev-parse", "HEAD"), head);

  const turns = turnsOf(s, wt);
  assert.deepEqual(turns.map((x) => [x.n, x.kind, x.restored]), [[0, "baseline", null], [1, "turn", null], [2, "restored", 0]]);

  // Undo: restoring the turn the restore replaced brings the generated files back.
  const undo = s.cli(["turns", "restore", "1"], { cwd: wt, env: ON });
  assert.equal(undo.code, 0, undo.stderr);
  assert.equal(readFileSync(join(wt, "gen/nested/deep.js"), "utf8"), "// generated gen/nested/deep.js\n");
  assert.equal(readFileSync(join(wt, "src/a.js"), "utf8"), "src/a.js edited\n");

  // "since": turn 1 to now is nothing (the worktree is back to turn 1's files); turn 0 to now is the whole turn.
  assert.match(s.cli(["turns", "since", "1"], { cwd: wt, env: ON }).stdout, /no change since turn 1/);
  const since = JSON.parse(s.cli(["turns", "since", "0", "--json"], { cwd: wt, env: ON }).stdout);
  assert.equal(since.files.length, 4);
  assert.match(since.patch, /gen\/types\.d\.ts/);
});

test("taking a snapshot leaves the branch, HEAD, the index and the stash list as they were", async (t) => {
  const { sb, wt, s } = await started(t, "keep");
  write(join(wt, "src/a.js"), "stashed\n");
  git(wt, "stash", "push", "-q", "-m", "mine");
  write(join(wt, "src/b.js"), "staged\n");
  git(wt, "add", "src/b.js");
  write(join(wt, "src/a.js"), "unstaged\n");
  write(join(wt, "new.txt"), "untracked\n");
  const indexFile = join(git(wt, "rev-parse", "--absolute-git-dir"), "index");
  git(wt, "status", "--porcelain"); // a plain status refreshes the index: let it, before reading it
  const status = () => git(wt, "--no-optional-locks", "status", "--porcelain");
  const before = {
    branch: git(wt, "symbolic-ref", "HEAD"), head: git(wt, "rev-parse", "HEAD"), stash: git(wt, "stash", "list", "--format=%H %gs"),
    index: readFileSync(indexFile), status: status(), refs: git(sb.main, "for-each-ref", "--format=%(refname) %(objectname)"),
  };
  const r = s.cli(["turns", "take"], { cwd: wt, env: ON });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /turn 1 recorded/);
  assert.equal(git(wt, "symbolic-ref", "HEAD"), before.branch);
  assert.equal(git(wt, "rev-parse", "HEAD"), before.head);
  assert.equal(git(wt, "stash", "list", "--format=%H %gs"), before.stash);
  assert.ok(readFileSync(indexFile).equals(before.index), "the index file is byte for byte the same");
  assert.equal(status(), before.status);
  assert.equal(git(sb.main, "for-each-ref", "--format=%(refname) %(objectname)"), before.refs, "the repo gains no ref");
  // The snapshot holds the working files, staged or not, and the untracked one.
  const [, one] = turnsOf(s, wt);
  assert.deepEqual(one.files.map((f) => f.path).sort(), ["new.txt", "src/a.js", "src/b.js"]);
});

test("takes at once in one worktree queue on its lock and each lands; a dead holder's lock does not stop them", async (t) => {
  const { sb, wt, s } = await started(t, "busy");
  // A lock left by a process that is gone (a take killed mid-run).
  const lock = `${snapOf(sb, wt)}.lock`;
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), "999999 0 dead");
  // Five turns ending together, each with its own change.
  const runs = [];
  for (let i = 0; i < 5; i++) {
    write(join(wt, `burst/${i}.txt`), `turn ${i}\n`);
    runs.push(s.cliAsync(["turns", "take"], { cwd: wt, env: ON }).exited);
  }
  for (const r of await Promise.all(runs)) assert.equal(r.code, 0, r.stdout);
  const turns = turnsOf(s, wt);
  assert.deepEqual(turns.map((x) => x.n), turns.map((_, i) => i), "turn numbers run 0..n with no gap or clash");
  assert.ok(turns.length >= 2, "at least one take recorded the burst");
  const last = s.cli(["turns", "since", "0", "--json"], { cwd: wt, env: ON });
  assert.deepEqual(JSON.parse(last.stdout).files.map((f) => f.path).sort(), [0, 1, 2, 3, 4].map((i) => `burst/${i}.txt`));
  assert.equal(existsSync(lock), false, "the lock is gone once the takes are done");
});

test("files a new ignore rule covers leave the snapshots, as from a fresh copy of the index; a killed take's index lock does not stop the next", async (t) => {
  const { sb, wt, s } = await started(t, "ignore");
  write(join(wt, "build/out.js"), "built\n");
  assert.match(s.cli(["turns", "take"], { cwd: wt, env: ON }).stdout, /turn 1 recorded/);
  write(join(wt, ".gitignore"), "node_modules/\nbuild/\n");
  writeFileSync(join(snapOf(sb, wt), "index.lock"), "");
  const r = s.cli(["turns", "take"], { cwd: wt, env: ON });
  assert.equal(r.code, 0, r.stderr);
  const two = turnsOf(s, wt).at(-1);
  assert.deepEqual(two.files.map((f) => `${f.status} ${f.path}`).sort(), ["D build/out.js", "M .gitignore"]);
});

test("git push --mirror carries no snapshot refs", async (t) => {
  const { sb, wt, s } = await started(t, "mirror");
  write(join(wt, "made.js"), "x\n");
  assert.equal(s.cli(["turns", "take"], { cwd: wt, env: ON }).code, 0);
  assert.equal(turnsOf(s, wt).length, 2);
  const scratch = join(sb.root, "scratch.git");
  git(sb.root, "init", "-q", "--bare", scratch);
  git(sb.main, "push", "-q", "--mirror", scratch);
  const remote = git(sb.root, "ls-remote", scratch);
  assert.match(remote, /refs\/heads\/mirror/, "the push itself worked");
  assert.doesNotMatch(remote, /turns|snapshot|rollcall/);
  // The snapshot's objects never reached the repo's own store either.
  const made = git(wt, "hash-object", "made.js");
  assert.throws(() => git(sb.main, "cat-file", "-e", made));
});

test("restore refuses while another session is mid-turn in the worktree, and the worker may restore its own", async (t) => {
  const { sb, wt, s } = await started(t, "busy");
  write(join(wt, "x.js"), "x\n");
  s.cli(["turns", "take"], { cwd: wt, env: ON });
  s.prompt("keep going"); // mid-turn: no Stop yet
  const owner = sb.session(sb.main);
  owner.start();
  const r = owner.cli(["turns", "restore", "0"], { cwd: wt, env: ON });
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`session ${s.short} is mid-turn in this worktree.*--wait`));
  assert.ok(existsSync(join(wt, "x.js")), "nothing was restored");
  // The session in its own turn restores freely.
  const own = s.cli(["turns", "restore", "0"], { cwd: wt, env: ON });
  assert.equal(own.code, 0, own.stderr);
  assert.ok(!existsSync(join(wt, "x.js")));
});

test("gc prunes a worktree's snapshots with it, and those of worktrees removed by hand", async (t) => {
  const { sb, wt, s } = await started(t, "landed");
  write(join(wt, "src/landed.js"), "landed\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "landed");
  git(wt, "push", "-q", "origin", "HEAD:main");
  git(sb.main, "fetch", "-q", "origin");
  assert.equal(s.cli(["turns", "take"], { cwd: wt, env: ON }).code, 0);
  assert.ok(existsSync(snapOf(sb, wt)));
  s.end();

  const byHand = sb.worktree("by-hand");
  const h = sb.session(byHand);
  assert.equal(h.cli(["turns", "take", "--baseline"], { cwd: byHand, env: ON }).code, 0);
  assert.ok(existsSync(snapOf(sb, byHand)));
  git(sb.main, "worktree", "remove", "--force", byHand);

  const out = s.cli(["gc"], { cwd: sb.main });
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /removed 1 merged worktree.*landed/);
  assert.ok(!existsSync(wt));
  assert.ok(!existsSync(snapOf(sb, wt)), "gc removed the landed worktree's snapshots");
  assert.ok(!existsSync(snapOf(sb, byHand)), "and those of the worktree removed by hand");
  assert.deepEqual(readdirSync(join(sb.home, "_snapshots")), []);
});

test("turns take is for linked worktrees; the hooks take none in a main checkout", async (t) => {
  const sb = sandbox(t);
  const s = sb.session(sb.main);
  s.env = { ...s.env, ...ON };
  s.start();
  s.prompt("hi");
  write(join(sb.main, "x.js"), "x\n");
  s.stop();
  const r = s.cli(["turns", "take"], { cwd: sb.main, env: ON });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /linked worktree/);
  assert.equal(s.cli(["turns", "take", "--quiet"], { cwd: sb.main, env: ON }).code, 0, "quiet (the hooks' form) never fails");
  await new Promise((res) => setTimeout(res, 500));
  assert.ok(!existsSync(join(sb.home, "_snapshots")) || !readdirSync(join(sb.home, "_snapshots")).length);
  rmSync(join(sb.main, "x.js"));
});
