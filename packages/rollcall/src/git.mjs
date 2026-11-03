// Git facts read straight from the filesystem, so the hook hot path never
// spawns git. Only diffNames, mergeConflicts and dirtyPaths (used by hooks
// when origin/main actually moved onto files the session edited), the fetches,
// and gitSync (CLI, landing queue and background gc) run the git binary;
// child_process loads only for them.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnDetached } from "./proc.mjs";

const childProcess = () => createRequire(import.meta.url)("node:child_process");

const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };

/**
 * The checkout holding `path` (a file or directory; it need not exist yet).
 * Returns { top, gitDir, commonDir, rel } with symlinks resolved, or null
 * outside a git checkout. `rel` is the path relative to `top`.
 */
export function locate(path) {
  let dir = resolve(path);
  let rest = "";
  for (;;) {
    let st = null;
    try { st = statSync(dir); } catch {}
    if (st?.isDirectory()) break;
    const up = dirname(dir);
    if (up === dir) return null;
    rest = rest ? join(basename(dir), rest) : basename(dir);
    dir = up;
  }
  try { dir = realpathSync(dir); } catch {}
  const target = rest ? join(dir, rest) : dir;
  for (let cur = dir; ; cur = dirname(cur)) {
    const dotgit = join(cur, ".git");
    let st = null;
    try { st = statSync(dotgit); } catch {}
    if (st) {
      let gitDir = dotgit;
      if (!st.isDirectory()) {
        const m = /^gitdir:\s*(.+)$/m.exec(read(dotgit) ?? "");
        if (!m) return null;
        gitDir = resolve(cur, m[1].trim());
      }
      const common = read(join(gitDir, "commondir"));
      const commonDir = common ? resolve(gitDir, common.trim()) : gitDir;
      return { top: cur, gitDir, commonDir, rel: relative(cur, target) };
    }
    if (dirname(cur) === cur) return null;
  }
}

/** Resolves a ref name (e.g. refs/remotes/origin/main) to a sha: loose ref, then packed-refs. */
export function resolveRef(info, ref) {
  for (let i = 0; i < 5; i++) {
    const loose = read(join(info.gitDir, ref)) ?? read(join(info.commonDir, ref));
    if (loose !== null) {
      const v = loose.trim();
      if (!v.startsWith("ref: ")) return v || null;
      ref = v.slice(5);
      continue;
    }
    const packed = read(join(info.commonDir, "packed-refs"));
    const line = packed?.split("\n").find((l) => l.endsWith(` ${ref}`));
    return line ? line.split(" ")[0] : null;
  }
  return null;
}

/** Current branch name, or a short sha when HEAD is detached. */
export function branch(info) {
  const head = (read(join(info.gitDir, "HEAD")) ?? "").trim();
  if (head.startsWith("ref: refs/heads/")) return head.slice(16);
  return head ? head.slice(0, 8) : null;
}

/** A key from the repo's shared config: `section` is the bracket content, e.g. `remote "origin"` or `rollcall`. */
export function configValue(info, section, key) {
  const cfg = read(join(info.commonDir, "config"));
  if (!cfg) return null;
  const header = `[${section.replace(/\s+/g, " ").toLowerCase()}]`;
  let inSection = false;
  for (const raw of cfg.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) { inSection = line.replace(/\s+/g, " ").toLowerCase() === header; continue; }
    const m = inSection && /^([a-z0-9-]+)\s*=\s*(.+)$/i.exec(line);
    if (m && m[1].toLowerCase() === key.toLowerCase()) return m[2].trim();
  }
  return null;
}

export const remoteUrl = (info, name = "origin") => configValue(info, `remote "${name}"`, "url");

/** The repo's main working tree, as opposed to a linked worktree (whose git dir points at a shared common dir). */
export const isMainCheckout = (info) => info.gitDir === info.commonDir;

/** origin's default branch (origin/HEAD, else main, else master). */
export function defaultBranch(info) {
  const head = (read(join(info.commonDir, "refs/remotes/origin/HEAD")) ?? "").trim();
  if (head.startsWith("ref: refs/remotes/origin/")) return head.slice(25);
  if (resolveRef(info, "refs/remotes/origin/main")) return "main";
  if (resolveRef(info, "refs/remotes/origin/master")) return "master";
  return null;
}

export function mainSha(info, b = defaultBranch(info)) {
  return b ? resolveRef(info, `refs/remotes/origin/${b}`) : null;
}

/** scp form and URL schemes collapse to host/path; userinfo, trailing slashes and .git dropped; lowercased. */
export function normalizeRemote(url) {
  let u = url.trim().toLowerCase();
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  u = u.replace(/^[^@/]+@/, "");
  if (!url.includes("://")) u = u.replace(/^([^/:]+):(?!\d+\/)/, "$1/");
  u = u.replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return u;
}

/** 53-bit string hash (cyrb53): enough to keep store keys apart, without loading node:crypto on every hook. */
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0").slice(-12);
}

/**
 * The repo's store key. Every worktree of a repo gets the same key: the
 * normalized origin URL, or (no origin) the real path of the git common dir.
 */
export function repoKey(info) {
  const remote = remoteUrl(info);
  const id = remote ? normalizeRemote(remote) : `local:${info.commonDir}`;
  const name = remote
    ? id.split("/").pop()
    : (basename(info.commonDir) === ".git" ? basename(dirname(info.commonDir)) : basename(info.commonDir).replace(/\.git$/, ""));
  const slug = (name || "repo").replace(/[^a-z0-9._-]+/gi, "-").toLowerCase();
  return { key: `${slug}-${hash(id)}`, name: name || "repo" };
}

/** The main worktree of this repo (where `git worktree add` is best run from). */
export function mainCheckout(info) {
  return basename(info.commonDir) === ".git" ? dirname(info.commonDir) : info.top;
}

/** Files that differ between two commits (spawns git; only called when main moved). */
export function diffNames(top, from, to, paths = []) {
  try {
    const out = childProcess().execFileSync("git", ["--literal-pathspecs", "-C", top, "diff", "--name-only", "--no-renames", from, to, "--", ...paths], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
    });
    return new Set(out.split("\n").filter(Boolean));
  } catch { return null; }
}

const FETCH = ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin"];
function fetchEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return env;
}

/** Fire-and-forget fetch of origin's default branch; never prompts, never waits. */
export function fetchDetached(top, defaultBranchName) {
  spawnDetached("git", ["-C", top, ...FETCH, defaultBranchName], { env: fetchEnv() });
}

/** The same fetch, waited for (the CLI's landing check, never a hook). True when origin answered. */
export function fetchSync(top, defaultBranchName) {
  return gitSync(top, [...FETCH, defaultBranchName], { env: fetchEnv(), timeout: 20_000 }).status === 0;
}

/** A file name as shown to an agent: one line, capped (names come from git and can carry newlines, or text meant for a reader). */
export const safeName = (f) => { const s = String(f).replace(/\s+/g, " ").trim(); return s.length > 120 ? `${s.slice(0, 117)}...` : s; };

/**
 * Files that would conflict if commits `a` and `b` were merged, worked out in
 * memory (no checkout is touched): [] when they merge cleanly, null when git
 * cannot say (older than 2.38, unrelated histories).
 */
export function mergeConflicts(top, a, b, timeout = 5000) {
  const r = gitSync(top, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", a, b], { timeout });
  if (r.status === 0) return [];
  if (r.status !== 1) return null;
  return [...new Set(r.stdout.split("\0").slice(1).filter(Boolean))];
}

/** Paths with uncommitted changes in a checkout, untracked files included, read without taking its index lock. Null when git fails. */
export function dirtyPaths(top, paths = [], timeout = 5000) {
  const r = gitSync(top, ["--no-optional-locks", "--literal-pathspecs", "status", "--porcelain", "-z", "--untracked-files=all", "--", ...paths], { timeout });
  if (r.status !== 0) return null;
  const out = [];
  const entries = r.stdout.split("\0");
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].length < 4) continue;
    out.push(entries[i].slice(3));
    if (/[RC]/.test(entries[i].slice(0, 2))) i++; // a rename or copy is followed by its source path
  }
  return out;
}

/** git in `dir`, synchronously: { status, stdout, stderr }. For the CLI and the background gc, never a hook. */
export function gitSync(dir, args, opts = {}) {
  return childProcess().spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, ...opts });
}
