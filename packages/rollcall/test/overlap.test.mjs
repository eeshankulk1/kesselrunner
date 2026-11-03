// Done when: two sessions in separate worktrees editing the same file - the
// second is warned with the first session's intent. Warnings never block,
// and each (peer, file) is mentioned once.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { denied, sandbox } from "./helpers.mjs";

test("editing a file another worktree's session edited warns with that session's intent, once", (t) => {
  const sb = sandbox(t);
  const w1 = sb.worktree("part-a");
  const w2 = sb.worktree("part-b");
  const a = sb.session(w1);
  const b = sb.session(w2);
  a.start();
  a.prompt("build the importer");
  assert.equal(a.cli(["claim", "part A: the importer"]).code, 0);
  a.edit(join(w1, "src/a.js"));
  b.start();
  b.prompt("build the exporter");

  const warn = b.pre(join(w2, "src/a.js"));
  assert.ok(!denied(warn), "overlap across worktrees warns, never denies");
  assert.match(warn.context, new RegExp(`^\\[rollcall\\] src/a.js was also edited by session ${a.short} \\(part-a, \\.claude/worktrees/part-a\\): "part A: the importer"`));
  assert.match(warn.context, /send [0-9a-f]{8} "<message>"/);
  assert.equal(warn.context.split("\n").length, 1, "one line per fact");

  const again = b.pre(join(w2, "src/a.js"));
  assert.equal(again.stdout, "", "the same overlap is not repeated");
  assert.equal(b.pre(join(w2, "src/b.js")).stdout, "", "files the peer never touched are quiet");
});

test("a claim's scope warns before the peer has touched the file; a later claim over my files is delivered", (t) => {
  const sb = sandbox(t);
  const w1 = sb.worktree("api");
  const w2 = sb.worktree("ui");
  const a = sb.session(w1);
  const b = sb.session(w2);
  a.start();
  b.start();
  const out = a.cli(["claim", "rework the API layer", "--scope", "src/api/**,src/a.js"]);
  assert.match(out.stdout, /claimed: "rework the API layer" \[src\/api\/\*\*, src\/a.js\]/);

  const warn = b.pre(join(w2, "src/api/routes.js"));
  assert.match(warn.context, /src\/api\/routes.js is inside the claim of session .*: "rework the API layer"/);

  // B edits src/b.js, then A widens its claim over it: B hears about it at its next tool call.
  b.edit(join(w2, "src/b.js"));
  a.cli(["claim", "API plus shared helpers", "--scope", "src/b.js"]);
  const delta = b.bash();
  assert.match(delta.context, /claimed "API plus shared helpers" \[src\/b.js\], which covers files you edited: src\/b.js/);
  assert.equal(b.bash().stdout, "", "delivered once");
});

test("claim prints a heads-up when a live peer already edited files inside the new scope", (t) => {
  const sb = sandbox(t);
  const w1 = sb.worktree("one");
  const w2 = sb.worktree("two");
  const a = sb.session(w1);
  const b = sb.session(w2);
  a.start();
  b.start();
  b.prompt("tidy the helpers");
  b.edit(join(w2, "src/b.js"));
  const out = a.cli(["claim", "helpers", "--scope", "src/**"]);
  assert.match(out.stdout, /heads-up: .*"tidy the helpers".* already edited src\/b.js/);
});
