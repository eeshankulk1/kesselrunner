// Input-keyed results. Done when: a check's key changes only when a file its
// inputs name changes; a recorded pass reaches origin, where another clone (or
// CI, running the same file directly) finds it and skips the check; and a pass
// is never recorded for code other than the code that ran.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BIN, git, sandbox, write } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../src/results.mjs", import.meta.url));

const MANIFEST = {
  stacks: [
    { name: "api", dir: "backend", testCommand: "test -f app.py", inputs: ["backend/**", "!backend/docs/**"] },
    { name: "web", dir: ".", testCommand: "true", inputs: ["{frontend,shared}/**"] },
    { name: "all", testCommand: "true" },
  ],
  ci: { prePush: [{ name: "ios", when: ["ios/**"], command: "make ios-check SUITES=\"<suites>\"" }] },
};

function repo(t) {
  const sb = sandbox(t);
  write(join(sb.main, ".claude/test-manifest.json"), JSON.stringify(MANIFEST));
  for (const f of ["backend/app.py", "backend/docs/notes.md", "frontend/page.ts", "shared/x.ts", "ios/App.swift"]) write(join(sb.main, f), `${f}\n`);
  git(sb.main, "add", "-A");
  git(sb.main, "commit", "-qm", "setup");
  git(sb.main, "push", "-q", "origin", "main");
  const run = (args, cwd = sb.main, env = {}) => {
    const r = spawnSync(process.execPath, [BIN, "results", ...args], { cwd, encoding: "utf8", env: { ...sb.env, ...env } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const key = (name, cwd = sb.main) => run(["key", name], cwd).stdout.trim();
  const commit = (cwd, file, text) => { write(join(cwd, file), text); git(cwd, "add", "-A"); git(cwd, "commit", "-qm", `edit ${file}`); };
  return { ...sb, run, key, commit };
}

test("the key changes only when an input changes", (t) => {
  const r = repo(t);
  const api = r.key("api");
  const web = r.key("web");
  assert.match(api, /^[0-9a-f]{40}$/);
  r.commit(r.main, "frontend/page.ts", "changed\n");
  assert.equal(r.key("api"), api, "a file outside api's inputs");
  assert.notEqual(r.key("web"), web, "{frontend,shared}/** covers frontend/");
  r.commit(r.main, "backend/docs/notes.md", "changed\n");
  assert.equal(r.key("api"), api, "an excluded path");
  r.commit(r.main, "backend/app.py", "changed\n");
  assert.notEqual(r.key("api"), api);
  // A file's mode is part of what it is.
  const before = r.key("api");
  git(r.main, "update-index", "--chmod=+x", "backend/app.py");
  git(r.main, "commit", "-qm", "chmod");
  assert.notEqual(r.key("api"), before);
});

test("the same inputs give the same key in another clone, at another commit, and from the file run directly", (t) => {
  const r = repo(t);
  const api = r.key("api");
  const other = r.otherClone();
  r.commit(other, "frontend/page.ts", "elsewhere\n");
  assert.equal(r.key("api", other), api);
  const direct = spawnSync(process.execPath, [SCRIPT, "key", "api"], { cwd: other, encoding: "utf8", env: r.env });
  assert.equal(direct.stdout.trim(), api);
  // --rev reads the inputs at that commit.
  r.commit(r.main, "backend/app.py", "new\n");
  assert.equal(r.run(["key", "api", "--rev", "HEAD~1"]).stdout.trim(), api);
});

test("a pre-push entry keys on its when globs; an unknown name is a usage error", (t) => {
  const r = repo(t);
  const ios = r.key("ios");
  r.commit(r.main, "backend/app.py", "x\n");
  assert.equal(r.key("ios"), ios);
  r.commit(r.main, "ios/App.swift", "x\n");
  assert.notEqual(r.key("ios"), ios);
  const bad = r.run(["key", "nope"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /no stack or ci\.prePush entry named "nope"/);
  assert.equal(r.run(["frob", "api"]).code, 2);
});

test("record pushes the pass to origin, where another clone's check finds it", (t) => {
  const r = repo(t);
  const miss = r.run(["check", "api"]);
  assert.equal(miss.code, 1);
  assert.match(miss.stdout, /^api: not passed/);
  const rec = r.run(["record", "api"]);
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stdout, /^api: pass recorded for [0-9a-f]{12} \(key [0-9a-f]{12}\) on this machine and on origin/);
  const head = git(r.main, "rev-parse", "HEAD");
  assert.equal(git(r.origin, "rev-parse", `refs/passed/api/${r.key("api")}`), head);

  // Another clone, at a commit that changed only other files: the check passes, naming the commit that did.
  const other = r.otherClone();
  r.commit(other, "frontend/page.ts", "elsewhere\n");
  const hit = r.run(["check", "api", "--json"], other);
  assert.equal(hit.code, 0);
  assert.deepEqual({ ...JSON.parse(hit.stdout), key: null, ref: null, commit: null, files: null }, { name: "api", key: null, ref: null, commit: null, files: null, passed: head, where: "origin" });
  assert.equal(r.run(["check", "web"], other).code, 1);

  // Recording again changes nothing on origin.
  const again = r.run(["record", "api"], other);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /on origin, which already had it/);
  assert.equal(git(r.origin, "rev-parse", `refs/passed/api/${r.key("api")}`), head);
});

test("check --github-output writes the step's outputs and exits 0 either way", (t) => {
  const r = repo(t);
  const out = join(r.root, "gh-output");
  write(out, "");
  const miss = spawnSync(process.execPath, [SCRIPT, "check", "web", "--github-output"], { cwd: r.main, encoding: "utf8", env: { ...r.env, GITHUB_OUTPUT: out } });
  assert.equal(miss.status, 0);
  assert.match(readFileSync(out, "utf8"), /^passed=false\nkey=[0-9a-f]{40}\ncommit=\n$/);
  r.run(["record", "web"]);
  write(out, "");
  spawnSync(process.execPath, [SCRIPT, "check", "web", "--github-output"], { cwd: r.otherClone(), encoding: "utf8", env: { ...r.env, GITHUB_OUTPUT: out } });
  assert.match(readFileSync(out, "utf8"), new RegExp(`^passed=true\\nkey=${r.key("web")}\\ncommit=${git(r.main, "rev-parse", "HEAD")}\\n$`));
});

test("record refuses inputs with uncommitted changes; changes elsewhere do not matter", (t) => {
  const r = repo(t);
  write(join(r.main, "frontend/page.ts"), "uncommitted\n");
  assert.equal(r.run(["record", "api"]).code, 0);
  write(join(r.main, "backend/new.py"), "untracked\n");
  const refused = r.run(["record", "api"]);
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /api's inputs have uncommitted changes \(backend\/new\.py\)/);
});

test("origin refusing the push leaves the pass on this machine and says so", (t) => {
  const r = repo(t);
  git(r.main, "remote", "set-url", "--push", "origin", join(r.root, "nowhere.git"));
  const rec = r.run(["record", "api"]);
  assert.equal(rec.code, 1);
  assert.match(rec.stdout, /pass recorded on this machine only - origin refused it/);
  // The local ref answers a check here, though origin has none.
  assert.equal(r.run(["check", "api"]).code, 0);
  assert.equal(r.run(["check", "api"], r.otherClone()).code, 1);
});

test("run: runs and records once, skips when the inputs passed, and records nothing for a failure or moved inputs", (t) => {
  const r = repo(t);
  const first = r.run(["run", "api"]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /^api: pass recorded/);
  assert.match(r.run(["run", "api"]).stdout, /^api: passed - these inputs already passed on [0-9a-f]{12}; not run/);

  assert.equal(r.run(["run", "web", "--", "exit 4"]).code, 4);
  assert.equal(r.run(["check", "web"]).code, 1);

  const moved = r.run(["run", "web", "--", "echo changed > frontend/page.ts"]);
  assert.equal(moved.code, 3);
  assert.match(moved.stderr, /inputs changed while it ran; nothing recorded/);
  assert.equal(r.run(["check", "web"]).code, 1);

  const placeholder = r.run(["run", "ios"]);
  assert.equal(placeholder.code, 2);
  assert.match(placeholder.stderr, /placeholder to fill in/);
  assert.equal(r.run(["run", "ios", "--", "true"]).code, 0);
});
