// Done when: agents edit in task worktrees, never a repo's main checkout (unless
// the repo opted out), and `rollcall gc` removes exactly the worktrees whose work
// landed: clean, unused, merged - running the manifest's teardown first.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pruneRefs } from "../src/gc.mjs";
import { BIN, denied, git, reason, sandbox, write } from "./helpers.mjs";

const guardOn = { ROLLCALL_MAIN_EDITS: "" };

test("the main checkout is read-only for agents; a task worktree is not", (t) => {
  const sb = sandbox(t);
  const s = sb.session();
  s.env = { ...s.env, ...guardOn };
  assert.match(s.start().context, /main checkout of origin: read freely, but edits happen in a task worktree/);

  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) assert.ok(denied(s.pre(join(sb.main, "src/a.js"), tool)), `${tool} is denied`);
  const why = reason(s.pre(join(sb.main, "src/a.js")));
  assert.match(why, /never in the main checkout/);
  assert.match(why, /cd into it/);
  assert.match(why, /allow-main/);

  // The command in the message works once the placeholders are filled in, and edits there pass.
  const cmd = why.match(/(git -C .*? origin\/main)/)[1].replaceAll("<slug>", "login-fix").replaceAll("<type>", "fix");
  const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const wt = join(sb.main, ".claude/worktrees/login-fix");
  assert.equal(git(wt, "branch", "--show-current"), "fix/login-fix");
  s.cwd = wt;
  assert.ok(!denied(s.pre(join(wt, "src/a.js"))), "edits in the worktree are allowed");

  // Outside any checkout, and in a repo without an origin, nothing is blocked.
  assert.equal(s.pre(join(sb.root, "notes.txt")).stdout, "");
  const scratch = join(sb.root, "scratch");
  git(sb.root, "init", "-q", "-b", "main", scratch);
  assert.ok(!denied(s.pre(join(scratch, "x.js"))), "no origin: exempt");
});

test("a session already editing the main checkout (before the rule) finishes there; new sessions go to worktrees", (t) => {
  const sb = sandbox(t);
  const old = sb.session();
  old.start();
  old.edit(join(sb.main, "src/a.js")); // guard off: the pre-rule world
  old.env = { ...old.env, ...guardOn };
  assert.ok(!denied(old.pre(join(sb.main, "src/b.js"))), "grandfathered");
  const fresh = sb.session();
  fresh.env = { ...fresh.env, ...guardOn, ROLLCALL_MAIN_EDITS: "" };
  fresh.start();
  assert.ok(denied(fresh.pre(join(sb.main, "src/b.js"))));
});

test("allow-main opts a repo out (shared by its worktrees), --off opts back in; ROLLCALL_MAIN_EDITS overrides", (t) => {
  const sb = sandbox(t);
  const s = sb.session();
  s.env = { ...s.env, ...guardOn };
  s.start();
  const file = join(sb.main, "src/a.js");
  assert.ok(denied(s.pre(file)));

  const on = s.cli(["allow-main"]);
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /may now edit the main checkout of origin/);
  assert.ok(!denied(s.pre(file)));
  assert.doesNotMatch(s.start().context ?? "", /read freely/, "no main-checkout notice once allowed");

  assert.equal(s.cli(["allow-main", "--off"]).code, 0);
  assert.equal(s.cli(["allow-main", "--off"]).code, 0, "unsetting twice is fine");
  assert.ok(!denied(s.pre(file)), "a session that edited here while allowed finishes there");
  const next = sb.session();
  next.env = { ...next.env, ...guardOn };
  next.start();
  assert.ok(denied(next.pre(file)), "a new session is back to worktrees");
  const lifted = next.pre(file, "Edit", { ROLLCALL_MAIN_EDITS: "allow" });
  assert.match(reason(lifted), /already working in this checkout/, "the env lifts the main-checkout rule; the shared-checkout rule still holds");
});

test("an allow-main repo's main checkout is shared: a second session's edits and commits pass", (t) => {
  const sb = sandbox(t);
  const a = sb.session();
  const b = sb.session();
  a.start();
  a.edit(join(sb.main, "src/a.js"));
  b.start();
  assert.ok(denied(b.pre(join(sb.main, "src/b.js"))), "without the opt-in, the senior session owns the checkout");
  assert.equal(b.cli(["allow-main"]).code, 0);
  assert.ok(!denied(b.pre(join(sb.main, "src/b.js"))));
  assert.ok(!denied(b.bashPre(`git -C "${sb.main}" commit -qm notes`)));
});

/** A worktree under .claude/worktrees with one commit, optionally merged into origin/main. */
function landed(sb, name, { merge = true } = {}) {
  const wt = join(sb.main, ".claude", "worktrees", name);
  git(sb.main, "fetch", "-q", "origin");
  git(sb.main, "worktree", "add", "-q", wt, "-b", name, "origin/main");
  write(join(wt, `src/${name}.js`), `${name}\n`);
  git(wt, "add", ".");
  git(wt, "commit", "-qm", name);
  if (merge) {
    git(wt, "push", "-q", "origin", `HEAD:main`);
    git(sb.main, "fetch", "-q", "origin");
  }
  return wt;
}

test("gc removes merged, clean, unused worktrees and their branches; keeps everything else", (t) => {
  const sb = sandbox(t);
  const merged = landed(sb, "merged");
  const fresh = sb.worktree("fresh"); // just made, nothing committed yet: its session may not have cd'd in
  const abandoned = join(sb.main, ".claude", "worktrees", "abandoned"); // made two days ago and never used
  execFileSync("git", ["worktree", "add", "-q", abandoned, "-b", "abandoned"], {
    cwd: sb.main, stdio: "ignore", env: { ...sb.env, GIT_COMMITTER_DATE: new Date(Date.now() - 2 * 86400_000).toISOString() },
  });
  const dirty = landed(sb, "dirty");
  write(join(dirty, "src/wip.js"), "wip\n");
  const unmerged = landed(sb, "unmerged", { merge: false });
  const busy = landed(sb, "busy");
  const outside = join(sb.root, "sibling");
  git(sb.main, "worktree", "add", "-q", outside, "-b", "sibling"); // not under .claude/worktrees

  const s = sb.session(busy); // a live session sits in "busy"
  s.start();

  const dry = s.cli(["gc", "--dry-run"], { cwd: sb.main });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /would remove 2 merged worktrees/);
  assert.match(dry.stdout, /kept fresh \(fresh\): new, nothing committed yet/);
  assert.ok(existsSync(merged), "dry run removes nothing");

  const out = s.cli(["gc"], { cwd: sb.main });
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /origin: removed 2 merged worktrees .*: (merged, abandoned|abandoned, merged)/);
  assert.match(out.stdout, /kept fresh \(fresh\): new, nothing committed yet/);
  assert.match(out.stdout, /kept dirty \(dirty\): uncommitted changes/);
  assert.match(out.stdout, /kept unmerged \(unmerged\): not merged/);
  assert.match(out.stdout, /kept busy \(busy\): in use/);
  assert.ok(!existsSync(merged) && !existsSync(abandoned));
  assert.ok(existsSync(fresh) && existsSync(dirty) && existsSync(unmerged) && existsSync(busy) && existsSync(outside));
  const branches = git(sb.main, "branch", "--format=%(refname:short)").split("\n");
  assert.ok(!branches.includes("merged") && !branches.includes("abandoned"), "their branches are gone");
  assert.ok(branches.includes("unmerged") && branches.includes("sibling"));

  // Once the session ends, its worktree is free to go.
  s.end();
  assert.match(s.cli(["gc"], { cwd: sb.main }).stdout, /removed 1 merged worktree .*: busy/);
});

test("gc runs the manifest's worktree.teardown first, and keeps the worktree when it fails", (t) => {
  const sb = sandbox(t);
  const marker = join(sb.root, "torn-down");
  write(join(sb.main, ".claude/test-manifest.json"), JSON.stringify({ worktree: { teardown: `basename "$PWD" >> "${marker}"` } }));
  git(sb.main, "add", "-f", ".claude/test-manifest.json");
  git(sb.main, "commit", "-qm", "manifest");
  git(sb.main, "push", "-q", "origin", "main");
  const ok = landed(sb, "ok");
  const s = sb.session();
  assert.match(s.cli(["gc"], { cwd: sb.main }).stdout, /removed 1 merged worktree/);
  assert.equal(readFileSync(marker, "utf8"), "ok\n", "teardown ran inside the worktree");
  assert.ok(!existsSync(ok));

  const bad = landed(sb, "bad");
  write(join(bad, ".claude/test-manifest.json"), JSON.stringify({ worktree: { teardown: "echo neon is down >&2; exit 3" } }));
  git(bad, "add", "-f", ".claude/test-manifest.json");
  git(bad, "commit", "-qm", "bad teardown");
  git(bad, "push", "-q", "origin", "HEAD:main");
  git(sb.main, "fetch", "-q", "origin");
  const out = s.cli(["gc"], { cwd: sb.main }).stdout;
  assert.match(out, /kept bad \(bad\): teardown failed: neon is down/);
  assert.ok(existsSync(bad));
});

test("background gc: --report saves the summary, the next SessionStart shows it once", (t) => {
  const sb = sandbox(t);
  landed(sb, "shipped");
  const s = sb.session();
  const r = s.cli(["gc", "--report"], { cwd: sb.main });
  assert.equal(r.stdout, "", "report mode prints nothing");
  assert.match(s.start().context, /\[rollcall\] worktree gc: origin: removed 1 merged worktree .*: shipped/);
  assert.doesNotMatch(s.start().context ?? "", /worktree gc/, "shown once");
});

test("gc's sweep drops the lander's refs of PRs gone from the queue and passes over a week old, but never the pass that answers for main", (t) => {
  const sb = sandbox(t);
  write(join(sb.main, ".claude/test-manifest.json"), JSON.stringify({ stacks: [{ name: "api", inputs: ["src/**"], testCommand: "true" }] }));
  git(sb.main, "add", ".");
  git(sb.main, "commit", "-qm", "manifest");
  git(sb.main, "push", "-q", "origin", "main");
  const head = git(sb.main, "rev-parse", "HEAD");
  const results = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: sb.main, env: sb.env, encoding: "utf8" });
  assert.equal(results("results", "record", "api").status, 0);
  const current = results("results", "key", "api", "--json");
  const currentRef = JSON.parse(current.stdout).ref;

  // A pass on an old commit, and one on a commit made today.
  git(sb.main, "checkout", "-qb", "side");
  const commit = (at) => {
    write(join(sb.main, "src/a.js"), `${at}\n`);
    git(sb.main, "add", ".");
    execFileSync("git", ["-C", sb.main, "commit", "-qm", "side"], { env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000` } });
    return git(sb.main, "rev-parse", "HEAD");
  };
  const oldAt = Math.floor(Date.now() / 1000) - 8 * 86400;
  const oldSha = commit(oldAt);
  const newSha = commit(Math.floor(Date.now() / 1000) - 3600);
  git(sb.main, "checkout", "-q", "main");
  const stale = "refs/passed/api/aaaa";
  const fresh = "refs/passed/api/bbbb";
  git(sb.main, "update-ref", stale, oldSha);
  git(sb.main, "update-ref", fresh, newSha);
  git(sb.main, "push", "-q", "origin", stale, fresh);
  git(sb.main, "update-ref", "-d", stale); // Passes other machines recorded: the sweep fetches them first.
  const gone = "refs/passed/api/cccc"; // Old, and already deleted from origin by another machine: it must not fail the push.
  git(sb.main, "update-ref", gone, oldSha);
  git(sb.main, "update-ref", "refs/rollcall/queue/7", head);
  git(sb.main, "update-ref", "refs/rollcall/queue/8", head);

  assert.equal(pruneRefs(sb.main, { queued: ["8"] }), 3);
  const onOrigin = git(sb.main, "ls-remote", "origin", "refs/passed/*");
  assert.ok(!onOrigin.includes(stale), "over a week old");
  assert.ok(onOrigin.includes(fresh), "this week's");
  assert.ok(onOrigin.includes(currentRef), "main's own pass, however old its commit");
  const local = git(sb.main, "for-each-ref", "--format=%(refname)");
  assert.ok(!local.includes(stale));
  assert.ok(!local.includes(gone));
  assert.ok(!local.includes("refs/rollcall/queue/7"));
  assert.ok(local.includes("refs/rollcall/queue/8"), "still in the queue");

  // Main with no manifest: nothing says which passes it needs, so none goes.
  git(sb.main, "update-ref", stale, oldSha);
  git(sb.main, "push", "-q", "origin", stale);
  git(sb.main, "rm", "-q", ".claude/test-manifest.json");
  git(sb.main, "commit", "-qm", "no manifest");
  git(sb.main, "push", "-q", "origin", "main");
  assert.equal(pruneRefs(sb.main), 1, "only the queue ref left");
  assert.ok(git(sb.main, "ls-remote", "origin", "refs/passed/*").includes(stale));
});

