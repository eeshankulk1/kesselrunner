// scripts/release.sh in a throwaway copy of the repo's release files: bump, then tag on main against a local origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
const git = (cwd, ...args) => { const r = run("git", args, cwd); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };

function repo(t) {
  const sb = mkdtempSync(join(tmpdir(), "release-"));
  t.after(() => rmSync(sb, { recursive: true, force: true }));
  const dir = join(sb, "repo");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const f of ["CHANGELOG.md", "package.json", "LICENSE", "scripts/release.sh"]) cpSync(join(ROOT, f), join(dir, f));
  cpSync(join(ROOT, "packages/rollcall"), join(dir, "packages/rollcall"), { recursive: true, filter: (p) => !p.includes("/test") && !p.includes("node_modules") });
  git(sb, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  git(dir, "remote", "add", "origin", join(sb, "origin.git"));
  git(dir, "push", "-q", "origin", "main");
  return dir;
}

test("bump sets both versions and opens the entry under [Unreleased]; tag checks, tags locally and prints the rest", (t) => {
  const dir = repo(t);
  const sh = (...a) => run("bash", ["scripts/release.sh", ...a], dir);
  assert.equal(sh("bump", "nope").status, 1);
  assert.equal(sh("bump", "0.1.0").status, 1, "an entry that exists already");
  const b = sh("bump", "0.2.0");
  assert.equal(b.status, 0, b.stderr);
  for (const f of ["package.json", "packages/rollcall/package.json"]) assert.equal(JSON.parse(readFileSync(join(dir, f))).version, "0.2.0");
  const log = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  assert.match(log, /## \[Unreleased\]\n\n## \[0\.2\.0\] - \d{4}-\d{2}-\d{2}\n\n## \[0\.1\.0\]/);
  assert.match(log, /^\[Unreleased\]: .*compare\/v0\.2\.0\.\.\.HEAD$/m);

  assert.match(sh("tag").stderr, /uncommitted changes/);
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "bump");
  assert.match(sh("tag").stderr, /not at origin\/main/);
  git(dir, "push", "-q", "origin", "main");
  assert.match(sh("tag").stderr, /no entry text under ## \[0\.2\.0\]/, "an empty entry is refused");

  git(dir, "reset", "-q", "--hard", "HEAD~1");
  git(dir, "push", "-q", "-f", "origin", "main");
  const tag = sh("tag");
  assert.equal(tag.status, 0, tag.stderr);
  assert.equal(git(dir, "tag", "--list"), "v0.1.0");
  assert.match(tag.stdout, /push origin v0\.1\.0/);
  assert.match(tag.stdout, /gh release create v0\.1\.0 --repo eeshankulk1\/kesselrunner/);
  assert.match(tag.stdout, /npm publish/);
  const notes = tag.stdout.match(/release notes in (\S+)\./)[1];
  t.after(() => rmSync(notes, { force: true }));
  assert.match(readFileSync(notes, "utf8"), /First public release/);
  assert.equal(git(dir, "ls-remote", "--tags", "origin"), "", "nothing pushed");
  assert.match(sh("tag").stderr, /tag v0\.1\.0 already exists/);
});
