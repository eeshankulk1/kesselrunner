// Done when: a PR merged to main that collides with this session's work
// produces one notice in this session - main no longer merges into its branch,
// or changed a file it has uncommitted edits in - and one that merges cleanly
// with committed work produces none. The fetch is the hook's own detached
// fetch; the test only waits for it to land.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { git, sandbox, until, write } from "./helpers.mjs";

const originMain = (dir) => git(dir, "rev-parse", "refs/remotes/origin/main");

function merge(sb, file, text) {
  const other = sb.otherClone();
  write(join(other, file), text);
  git(other, "commit", "-qam", `change ${file}`);
  git(other, "push", "-q", "origin", "main");
  return git(other, "rev-parse", "HEAD");
}

test("a merge to origin/main touching an edited file produces exactly one notice", async (t) => {
  const sb = sandbox(t);
  const wt = sb.worktree("feature");
  const s = sb.session(wt);
  s.env.ROLLCALL_FETCH_MINUTES = "0"; // fetch on every hook, so the test does not wait on the throttle
  s.start();
  s.edit(join(wt, "src/a.js"), "my change\n");

  const unrelated = merge(sb, "README.md", "docs\n");
  s.bash(); // kicks off the detached fetch
  await until(() => originMain(wt) === unrelated);
  assert.equal(s.bash().stdout, "", "main moved, but not on a file this session edited");

  const sha = merge(sb, "src/a.js", "their change\n");
  s.bash();
  await until(() => originMain(wt) === sha);
  const notice = s.bash();
  assert.match(notice.context, /^\[rollcall\] origin\/main changed files you have uncommitted edits in: src\/a\.js\. Commit them, then git merge origin\/main, before building further on them\.$/);
  assert.equal(notice.context.split("\n").length, 1);
  assert.equal(s.bash().stdout, "", "one notice, not one per hook");
  assert.equal(s.prompt("next").stdout, "", "nor on the next prompt");
});

test("a file edited after main already moved is reported on the next hook", async (t) => {
  const sb = sandbox(t);
  const wt = sb.worktree("late");
  const s = sb.session(wt);
  s.env.ROLLCALL_FETCH_MINUTES = "0";
  s.start();
  const sha = merge(sb, "src/b.js", "upstream\n");
  s.bash();
  await until(() => originMain(wt) === sha);
  assert.equal(s.bash().stdout, "");
  const { post } = s.edit(join(wt, "src/b.js"), "mine\n");
  assert.match(post.context, /changed files you have uncommitted edits in: src\/b\.js/);
});

test("each newly-touched file after main moved is checked against its own history, not a stale earlier one", async (t) => {
  const sb = sandbox(t);
  const wt = sb.worktree("late2");
  const s = sb.session(wt);
  s.env.ROLLCALL_FETCH_MINUTES = "0";
  s.start();
  const sha1 = merge(sb, "src/b.js", "upstream b\n");
  s.bash();
  await until(() => originMain(wt) === sha1);
  assert.equal(s.bash().stdout, "");

  const editB = s.edit(join(wt, "src/b.js"), "mine b\n");
  assert.match(editB.post.context, /changed files you have uncommitted edits in: src\/b\.js/);

  // A second, unrelated main move, then a brand-new file is touched: it was
  // never changed upstream, so it must stay quiet (not swept up by the
  // per-touch check still running against the whole baseMain..cur range).
  const sha2 = merge(sb, "README.md", "more docs\n");
  s.bash();
  await until(() => originMain(wt) === sha2);
  assert.equal(s.bash().stdout, "");
  const editA = s.edit(join(wt, "src/a.js"), "mine a\n");
  assert.equal(editA.post.stdout, "", "src/a.js was never touched by any upstream commit");
});

test("this session's own merge is not reported back to it", async (t) => {
  const sb = sandbox(t);
  const wt = sb.worktree("mine");
  const s = sb.session(wt);
  s.env.ROLLCALL_FETCH_MINUTES = "0";
  s.start();
  s.edit(join(wt, "src/a.js"), "shipped\n");
  git(wt, "commit", "-qam", "ship");
  git(wt, "push", "-q", "origin", "HEAD:main"); // "the PR merged"
  const sha = git(wt, "rev-parse", "HEAD");
  s.bash();
  await until(() => originMain(wt) === sha);
  assert.equal(s.bash().stdout, "");
});

test("committed work that main no longer merges into hears which files conflict", async (t) => {
  const sb = sandbox(t);
  const wt = sb.worktree("conflict");
  const s = sb.session(wt);
  s.env.ROLLCALL_FETCH_MINUTES = "0";
  s.start();
  s.edit(join(wt, "src/a.js"), "my change\n");
  git(wt, "commit", "-qam", "mine");
  const sha = merge(sb, "src/a.js", "their change\n");
  s.bash();
  await until(() => originMain(wt) === sha);
  const notice = s.bash();
  assert.match(notice.context, /^\[rollcall\] origin\/main no longer merges into your branch\. It conflicts in: src\/a\.js\. Merge it in before building further on those files: git merge origin\/main$/);
  assert.equal(s.bash().stdout, "", "one notice");
});

test("committed work that main still merges into cleanly hears nothing", async (t) => {
  const sb = sandbox(t);
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  write(join(sb.main, "src/long.js"), `${lines.join("\n")}\n`);
  git(sb.main, "add", "-A");
  git(sb.main, "commit", "-qm", "a longer file");
  git(sb.main, "push", "-q", "origin", "main");
  const wt = sb.worktree("clean");
  const s = sb.session(wt);
  s.env.ROLLCALL_FETCH_MINUTES = "0";
  s.start();
  s.edit(join(wt, "src/long.js"), `${["mine", ...lines.slice(1)].join("\n")}\n`);
  git(wt, "commit", "-qam", "top of the file");
  const sha = merge(sb, "src/long.js", `${[...lines.slice(0, 11), "theirs"].join("\n")}\n`);
  s.bash();
  await until(() => originMain(wt) === sha);
  assert.equal(s.bash().stdout, "", "same file, but the two changes merge");
  assert.equal(s.prompt("next").stdout, "");
});
