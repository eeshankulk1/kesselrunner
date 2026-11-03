// What falcon needs on this machine before it starts, and how to get each missing piece.
// Fast on purpose: programs are found by walking PATH (no process starts), and the one process
// it does start is `gh auth token`, which reads gh's own config and never touches the network
// (`gh auth status` calls GitHub and takes a few hundred milliseconds).
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_NODE = 20;
const INSTALL = "curl -fsSL https://raw.githubusercontent.com/eeshankulk1/kesselrunner/main/install.sh | bash";
// falcon's workers start through kesselrunner's launcher, beside this package in the kesselrunner checkout.
// rollcall installed alone from npm has its hooks, tasks and merge queue, but no launcher.
const LAUNCHER = fileURLToPath(new URL("../../../scripts/supervisor/start.mjs", import.meta.url));

/** The path of a program on PATH, or null. */
export function which(name, path = process.env.PATH ?? "") {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try { if (statSync(p).isFile()) { accessSync(p, constants.X_OK); return p; } } catch {}
  }
  return null;
}

function runnable(p) {
  try { accessSync(p, constants.X_OK); return p; } catch { return null; }
}

const howTo = (mac, other) => (platform) => (platform === "darwin" ? mac : other);
const PIECES = [
  { name: "git", hard: true, why: "worktrees and branches", get: howTo("xcode-select --install", "https://git-scm.com/downloads") },
  { name: "tmux", hard: true, why: "falcon's tabs and the workers' windows", get: howTo("brew install tmux", "https://github.com/tmux/tmux/wiki/Installing") },
  { name: "claude", label: "Claude Code", hard: true, why: "every worker is a Claude Code session", get: howTo("brew install --cask claude-code", "https://code.claude.com/docs/en/setup") },
  { name: "gh", label: "GitHub CLI (gh)", hard: false, why: "opening PRs and the merge queue", get: howTo("brew install gh", "https://cli.github.com") },
];

/**
 * Checks each piece. Returns { missing: [{ name, hard, line }] }; an empty list means all is there.
 * Tests pass their own PATH, platform, Node version, Claude Code path and `gh auth token` stand-in.
 */
export function check({
  path = process.env.PATH ?? "",
  platform = process.platform,
  node = process.versions.node,
  claudeBin = process.env.KESSELRUNNER_CLAUDE_BIN || process.env.DOTCLAUDE_CLAUDE_BIN,
  launcher = LAUNCHER,
  ghAuthed,
} = {}) {
  const missing = [];
  const add = (name, hard, line) => missing.push({ name, hard, line });
  if (!existsSync(launcher)) add("kesselrunner", true, `falcon comes with kesselrunner (rollcall alone has no worker launcher): ${INSTALL}`);
  const major = Number(String(node).split(".")[0]);
  if (!(major >= MIN_NODE)) {
    add("node", true, `Node ${MIN_NODE} or newer is needed (found ${node}): ${platform === "darwin" ? "brew install node" : "https://nodejs.org"}`);
  }
  let gh = null;
  for (const p of PIECES) {
    const at = p.name === "claude" && claudeBin ? (claudeBin.includes("/") ? runnable(claudeBin) : which(claudeBin, path)) : which(p.name, path);
    if (p.name === "gh") gh = at;
    if (!at) add(p.name, p.hard, `${p.label ?? p.name} is missing (${p.why}): ${p.get(platform)}`);
  }
  if (gh && !(ghAuthed ?? authed)(gh)) add("gh-auth", false, "gh is not logged in (opening PRs and the merge queue): gh auth login");
  return { missing };
}

function authed(gh) {
  // The token goes nowhere: stdout is dropped.
  return spawnSync(gh, ["auth", "token"], { stdio: "ignore", timeout: 3000 }).status === 0;
}

/** The lines to print: hard misses first. */
export const lines = ({ missing }) => [...missing.filter((m) => m.hard), ...missing.filter((m) => !m.hard)].map((m) => m.line);
export const blocked = ({ missing }) => missing.some((m) => m.hard);
