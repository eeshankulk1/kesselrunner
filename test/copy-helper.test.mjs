// copy.sh, the part of kesselrunner Copy.app that does the work: which links it
// takes, and what it puts on the clipboard. A fake pbcopy in a throwaway
// folder stands for the clipboard; the real one is never touched.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "copy-helper", "copy.sh");

function world() {
  const dir = mkdtempSync(join(tmpdir(), "copy-helper-"));
  const bin = join(dir, "bin");
  const store = join(dir, "store");
  mkdirSync(bin);
  mkdirSync(store);
  writeFileSync(join(bin, "pbcopy"), `#!/bin/sh\ncat > "${join(dir, "clipboard")}"\n`);
  chmodSync(join(bin, "pbcopy"), 0o755);
  const run = (url) => spawnSync("/bin/sh", [SCRIPT, url], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, CLICKABLE_STORE: store } });
  const clipboard = () => { try { return readFileSync(join(dir, "clipboard"), "utf8"); } catch { return null; } };
  return { store, run, clipboard };
}

test("a saved block is copied exactly, and its first line printed", () => {
  const w = world();
  writeFileSync(join(w.store, "abc123.txt"), 'echo "a path with spaces: /Users/me/Personal Projects"');
  const r = w.run("kesselrunner-copy://abc123");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.clipboard(), 'echo "a path with spaces: /Users/me/Personal Projects"');
  assert.equal(r.stdout.trim(), 'echo "a path with spaces: /Users/me/Personal Projects"');
});

test("a block of several lines says how many more", () => {
  const w = world();
  writeFileSync(join(w.store, "z9.txt"), "line one\nline two\nline three");
  const r = w.run("kesselrunner-copy://z9/");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.clipboard(), "line one\nline two\nline three");
  assert.equal(r.stdout.trim(), "line one (+2 more lines)");
});

test("links that could name something outside the store are refused", () => {
  const w = world();
  for (const url of ["kesselrunner-copy://../secret", "kesselrunner-copy://a.b", "kesselrunner-copy://", "kesselrunner-copy://ABC", "https://x", `kesselrunner-copy://${"a".repeat(65)}`]) {
    const r = w.run(url);
    assert.equal(r.status, 2, url);
    assert.match(r.stderr, /not a copy link/);
  }
  assert.equal(w.clipboard(), null);
});

test("an id with no saved block says the link expired", () => {
  const w = world();
  const r = w.run("kesselrunner-copy://gone");
  assert.equal(r.status, 3);
  assert.match(r.stderr, /expired/);
  assert.equal(w.clipboard(), null);
});

test("a link with the scheme from before the rename still copies", () => {
  const w = world();
  writeFileSync(join(w.store, "old1.txt"), "echo old");
  const r = w.run("dotclaude-copy://old1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.clipboard(), "echo old");
  assert.equal(w.run("dotclaude-copy://../x").status, 2);
});
