// falcon's first-run check (src/needs.mjs): what counts as missing, what it prints, and falcon refusing to start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blocked, check, lines, which } from "../src/needs.mjs";

const FALCON = fileURLToPath(new URL("../bin/falcon.mjs", import.meta.url));

/** A folder of stand-in programs: each exits 0. */
function bin(t, names) {
  const dir = mkdtempSync(join(tmpdir(), "needs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const n of names) { writeFileSync(join(dir, n), "#!/bin/sh\nexit 0\n"); chmodSync(join(dir, n), 0o755); }
  return dir;
}

const yes = () => true;

test("everything there: nothing missing, nothing printed", (t) => {
  const r = check({ path: bin(t, ["git", "tmux", "claude", "gh"]), platform: "darwin", node: "22.1.0", claudeBin: "", ghAuthed: yes });
  assert.deepEqual(r.missing, []);
  assert.equal(blocked(r), false);
});

test("an empty PATH on macOS: one line per piece with its brew command, hard ones first", () => {
  const r = check({ path: "", platform: "darwin", node: "22.1.0", claudeBin: "", ghAuthed: yes });
  assert.deepEqual(lines(r), [
    "git is missing (worktrees and branches): xcode-select --install",
    "tmux is missing (falcon's tabs and the workers' windows): brew install tmux",
    "Claude Code is missing (every worker is a Claude Code session): brew install --cask claude-code",
    "GitHub CLI (gh) is missing (opening PRs and the merge queue): brew install gh",
  ]);
  assert.equal(blocked(r), true);
});

test("elsewhere the lines give a URL instead of brew", () => {
  const out = lines(check({ path: "", platform: "linux", node: "22.1.0", claudeBin: "", ghAuthed: yes }));
  assert.equal(out.length, 4);
  for (const l of out) assert.match(l, /https:\/\//);
  assert.ok(!out.some((l) => l.includes("brew")));
});

test("gh missing or logged out only warns", (t) => {
  const noGh = check({ path: bin(t, ["git", "tmux", "claude"]), platform: "darwin", node: "22.1.0", claudeBin: "", ghAuthed: yes });
  assert.deepEqual(noGh.missing.map((m) => m.name), ["gh"]);
  assert.equal(blocked(noGh), false);
  const out = check({ path: bin(t, ["git", "tmux", "claude", "gh"]), platform: "darwin", node: "22.1.0", claudeBin: "", ghAuthed: () => false });
  assert.deepEqual(lines(out), ["gh is not logged in (opening PRs and the merge queue): gh auth login"]);
  assert.equal(blocked(out), false);
});

test("an old Node blocks", (t) => {
  const r = check({ path: bin(t, ["git", "tmux", "claude", "gh"]), platform: "linux", node: "18.19.0", claudeBin: "", ghAuthed: yes });
  assert.deepEqual(lines(r), ["Node 20 or newer is needed (found 18.19.0): https://nodejs.org"]);
  assert.equal(blocked(r), true);
});

test("KESSELRUNNER_CLAUDE_BIN stands in for claude on PATH", (t) => {
  const tools = bin(t, ["git", "tmux", "gh"]);
  const other = bin(t, ["my-claude"]);
  const base = { path: tools, platform: "darwin", node: "22.1.0", ghAuthed: yes };
  assert.deepEqual(check({ ...base, claudeBin: join(other, "my-claude") }).missing, []);
  assert.deepEqual(check({ ...base, claudeBin: join(other, "nope") }).missing.map((m) => m.name), ["claude"]);
});

test("rollcall installed on its own (no kesselrunner launcher beside it) blocks falcon and says how to get it", (t) => {
  const r = check({ path: bin(t, ["git", "tmux", "claude", "gh"]), platform: "darwin", node: "22.1.0", claudeBin: "", launcher: "/nonexistent/start.mjs", ghAuthed: yes });
  assert.deepEqual(r.missing.map((m) => m.name), ["kesselrunner"]);
  assert.match(lines(r)[0], /^falcon comes with kesselrunner .*: curl -fsSL https:\/\/raw\.githubusercontent\.com\/.*\/install\.sh \| bash$/);
  assert.equal(blocked(r), true);
});

test("which skips folders and files that do not run", (t) => {
  const dir = bin(t, ["ok"]);
  mkdirSync(join(dir, "adir"));
  writeFileSync(join(dir, "plain"), "x");
  assert.equal(which("ok", `:${dir}`), join(dir, "ok"));
  assert.equal(which("adir", dir), null);
  assert.equal(which("plain", dir), null);
});

test("falcon without tmux prints why and how, and starts nothing", (t) => {
  const path = bin(t, ["git", "claude", "gh"]);
  const home = mkdtempSync(join(tmpdir(), "needs-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [FALCON], { encoding: "utf8", env: { PATH: path, HOME: home }, timeout: 10_000 });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  const want = process.platform === "darwin" ? "brew install tmux" : "https://github.com/tmux/tmux/wiki/Installing";
  assert.equal(r.stderr, `falcon: tmux is missing (falcon's tabs and the workers' windows): ${want}\n`);
  // help still works on a machine that has nothing
  const help = spawnSync(process.execPath, [FALCON, "help"], { encoding: "utf8", env: { PATH: "", HOME: home }, timeout: 10_000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /falcon continue/);
});
