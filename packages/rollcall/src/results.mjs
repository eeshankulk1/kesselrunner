// Results keyed by inputs: a check that passed on one tree is skipped on any
// other tree whose input files are the same. A check is a manifest stack, or a
// `ci.prePush` entry, by name; its inputs are the manifest's `inputs` globs
// (a pre-push entry falls back to its `when` globs, anything else to the whole
// repo). The key is a hash of the (mode, blob, path) list of the files they
// name at a commit, read by git alone, so it comes out the same on any machine.
// A pass is a ref, refs/passed/<name>/<hash>, pointing at the commit that
// passed and pushed to origin, where the next machine (the lander, a CI job)
// finds it with one ls-remote.
//
// Self-contained (node built-ins and git only): CI runs this same file,
// copied into the project (`node .github/rollcall-results.mjs check api
// --github-output`), so the two can never disagree about a key.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** In every hash: a change to how keys are made changes every key, so an old pass never answers for a new key. */
const VERSION = "rollcall-results v1";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const USAGE = `  rollcall results key|check|record <name> [--rev <commit>] [--json]
                                         input-keyed results for a manifest stack or ci.prePush entry: its key (a
                                         hash of the files its \`inputs\` name, at a commit; default HEAD), whether
                                         that key already passed anywhere (check: exit 0 yes, 1 no), and recording
                                         a pass (record: refs/passed/<name>/<hash>, pushed to origin). check
                                         --github-output writes passed/key/commit for a workflow step
  rollcall results run <name> [-- <command>]
                                         check; when the key has not passed, run the command (default: the
                                         manifest's) on HEAD and record the pass`;

class Exit extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const gitRun = (top, args, opts = {}) => spawnSync("git", ["-C", top, ...args], {
  encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000, maxBuffer: 256 * 1024 * 1024, ...opts,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
});
const gitOut = (top, args, opts) => { const r = gitRun(top, args, opts); return r.status === 0 ? r.stdout.trim() : null; };

/** The repo root holding `dir`, or null. */
export const topOf = (dir) => gitOut(dir, ["rev-parse", "--show-toplevel"]);

/** The test manifest at `rev`: {} when it has none or it does not parse. */
export function manifestAt(top, rev) {
  const text = gitOut(top, ["show", `${rev}:.claude/test-manifest.json`]);
  try { return (text && JSON.parse(text)) ?? {}; } catch { return {}; }
}

/**
 * The check called `name` in a manifest: { name, kind, inputs, command, dir }, or null when the manifest has none.
 * A stack's command is its testCommand (run in its dir); a pre-push entry's is its command (run at the root).
 */
export function checkOf(m, name) {
  const globs = (v) => (Array.isArray(v) ? v.filter((g) => typeof g === "string" && g.trim()) : null);
  const stack = (Array.isArray(m.stacks) ? m.stacks : []).find((s) => s?.name === name);
  if (stack) return { name, kind: "stack", inputs: globs(stack.inputs) ?? ["**"], command: stack.testCommand ?? null, dir: stack.dir ?? "." };
  const pre = (Array.isArray(m.ci?.prePush) ? m.ci.prePush : []).find((p) => p?.name === name);
  if (pre) return { name, kind: "prePush", inputs: globs(pre.inputs) ?? globs(pre.when) ?? ["**"], command: pre.command ?? null, dir: "." };
  return null;
}

/** {a,b} alternatives, which git's glob pathspecs lack. */
function expandBraces(g) {
  const m = /\{([^{}]*)\}/.exec(g);
  if (!m) return [g];
  return m[1].split(",").flatMap((alt) => expandBraces(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length)));
}

/** Input globs as git pathspecs: `**` spans folders, `*` stays within one, a plain path is that file or folder, `!` excludes. */
export function pathspecs(inputs) {
  return inputs.flatMap((raw) => {
    const neg = raw.startsWith("!");
    const g = raw.slice(neg ? 1 : 0).trim().replace(/^\.\//, "").replace(/^\/+/, "");
    return expandBraces(g).map((p) => `:(${neg ? "exclude," : ""}glob)${p || "**"}`);
  });
}

/** The commit `rev` names, or null. */
export const commitOf = (top, rev) => gitOut(top, ["rev-parse", "--verify", "-q", `${rev}^{commit}`]);

/** The (mode, blob, path) list of the files `inputs` name at `commit`, read through a scratch index: no checkout or index is touched. */
function inputFiles(top, commit, inputs) {
  const index = join(tmpdir(), `rollcall-results-${process.pid}-${randomBytes(4).toString("hex")}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const read = gitRun(top, ["read-tree", commit], { env });
    if (read.status !== 0) throw new Exit(2, `rollcall results: git read-tree ${commit} failed: ${read.stderr.trim()}`);
    const r = gitRun(top, ["ls-files", "-s", "-z", "--", ...pathspecs(inputs)], { env });
    if (r.status !== 0) throw new Exit(2, `rollcall results: git ls-files failed: ${r.stderr.trim()}`);
    return r.stdout;
  } finally { rmSync(index, { force: true }); }
}

/** The key of check `name` at `rev`, its inputs read from that commit's own manifest. */
export function keyOf(top, name, rev = "HEAD") {
  // The name is a ref component: git refuses "..", a trailing "." and a ".lock" suffix.
  if (!NAME.test(name) || name.includes("..") || name.endsWith(".") || name.endsWith(".lock")) throw new Exit(2, `rollcall results: "${name}" is not a check name (letters, digits, . _ -)`);
  const commit = commitOf(top, rev);
  if (!commit) throw new Exit(2, `rollcall results: no commit "${rev}"`);
  const check = checkOf(manifestAt(top, commit), name);
  if (!check) throw new Exit(2, `rollcall results: ${commit.slice(0, 12)}'s .claude/test-manifest.json has no stack or ci.prePush entry named "${name}"`);
  const listing = inputFiles(top, commit, check.inputs);
  const hash = createHash("sha256").update(`${VERSION}\n${name}\n`).update(listing).digest("hex").slice(0, 40);
  return { name, hash, ref: `refs/passed/${name}/${hash}`, commit, inputs: check.inputs, files: listing.split("\0").filter(Boolean).length, check };
}

/** Where `key` already passed: { commit, where: "local" | "origin" }, or null. */
export function passOf(top, key, { remote = true } = {}) {
  const local = gitOut(top, ["rev-parse", "--verify", "-q", key.ref]);
  if (local) return { commit: local, where: "local" };
  if (!remote) return null;
  const r = gitRun(top, ["ls-remote", "origin", key.ref], { timeout: 30_000 });
  const sha = r.status === 0 ? r.stdout.split("\t")[0].trim() : "";
  return sha ? { commit: sha, where: "origin" } : null;
}

/** Input files that differ from HEAD in the checkout (uncommitted, untracked included). Null when git fails. */
function dirtyInputs(top, inputs) {
  const r = gitRun(top, ["--no-optional-locks", "status", "--porcelain", "-z", "--", ...pathspecs(inputs)]);
  if (r.status !== 0) return null;
  return r.stdout.split("\0").filter((e) => e.length > 3).map((e) => e.slice(3));
}

/**
 * Records that `key` passed: the local ref, then the same ref on origin. A pass already on origin
 * stays as it is. Returns { pushed, already, error }.
 */
export function recordPass(top, key) {
  const local = gitRun(top, ["update-ref", key.ref, key.commit]);
  if (local.status !== 0) return { pushed: false, error: `git update-ref failed: ${local.stderr.trim()}` };
  const onOrigin = () => { const r = gitRun(top, ["ls-remote", "origin", key.ref], { timeout: 30_000 }); return r.status === 0 ? r.stdout.split("\t")[0].trim() : ""; };
  const already = onOrigin();
  if (already) return { pushed: false, already };
  // --no-verify: a project's pre-push hook guards branches, not this ref.
  const r = gitRun(top, ["push", "--quiet", "--no-verify", "origin", `${key.commit}:${key.ref}`], { timeout: 120_000 });
  if (r.status === 0) return { pushed: true };
  // Another machine recorded the same key between the look and the push.
  const raced = onOrigin();
  if (raced) return { pushed: false, already: raced };
  return { pushed: false, error: (r.stderr.trim().split("\n").pop() || `git push exited ${r.status}`) };
}

const short = (sha) => sha.slice(0, 12);

/** `results <sub> <name> ...`. `say` prints a line; returns the exit code. */
export async function results(args, { say = (s) => process.stdout.write(`${s}\n`), cwd = process.cwd() } = {}) {
  try {
    return await run(args, say, cwd);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    if (e.message) process.stderr.write(`${e.message}\n`);
    return e.code;
  }
}

async function run(argv, say, cwd) {
  const dash = argv.indexOf("--");
  const args = dash >= 0 ? argv.slice(0, dash) : [...argv];
  // One argument is a shell line as written; several are one command, each quoted so it reaches the program whole.
  const tail = dash >= 0 ? argv.slice(dash + 1) : [];
  const command = (tail.length === 1 ? tail[0] : tail.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ")).trim() || null;
  const take = (f) => { const i = args.indexOf(f); if (i >= 0) args.splice(i, 1); return i >= 0; };
  const value = (f) => {
    const i = args.indexOf(f);
    if (i < 0) return null;
    if (i + 1 >= args.length) throw new Exit(2, `rollcall results: ${f} needs a value`);
    return args.splice(i, 2)[1];
  };
  if (take("-h") || take("--help")) { say(USAGE); return 0; }
  const json = take("--json");
  const gh = take("--github-output");
  const rev = value("--rev") ?? "HEAD";
  const [sub, name, ...extra] = args;
  if (!["key", "check", "record", "run"].includes(sub) || !name || extra.length) throw new Exit(2, `usage:\n${USAGE}`);
  if (sub === "run" && rev !== "HEAD") throw new Exit(2, "rollcall results: run tests the checkout, so it takes no --rev");
  const top = topOf(cwd);
  if (!top) throw new Exit(2, "rollcall results: not inside a git checkout");
  const key = keyOf(top, name, rev);
  const out = (v, line) => say(json ? JSON.stringify(v) : line);
  const base = { name, key: key.hash, ref: key.ref, commit: key.commit, files: key.files };

  if (sub === "key") { out(base, key.hash); return 0; }

  if (sub === "check") {
    const pass = passOf(top, key);
    if (gh && process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `passed=${pass ? "true" : "false"}\nkey=${key.hash}\ncommit=${pass?.commit ?? ""}\n`);
    }
    out({ ...base, passed: pass?.commit ?? null, where: pass?.where ?? null },
      pass ? `${name}: passed - these inputs already passed on ${short(pass.commit)} (${key.files} files, key ${short(key.hash)}); skip it`
        : `${name}: not passed - no pass for these inputs yet (${key.files} files, key ${short(key.hash)}); run it`);
    return pass || gh ? 0 : 1;
  }

  // record and run test the checkout: its inputs must be what the commit holds, or the pass would name other code.
  const head = commitOf(top, "HEAD");
  const checkoutIs = (c) => c === head;
  const dirty = () => (checkoutIs(key.commit) ? dirtyInputs(top, key.inputs) : []);
  if (sub === "record") {
    const d = dirty();
    if (d === null) throw new Exit(2, "rollcall results: git status failed");
    if (d.length) throw new Exit(3, `rollcall results: ${name}'s inputs have uncommitted changes (${d.slice(0, 5).join(", ")}${d.length > 5 ? ", ..." : ""}): the pass would name code that is not in ${short(key.commit)}. Commit, run it again, then record.`);
    return report(say, json, base, recordPass(top, key));
  }

  // run
  const prior = passOf(top, key);
  if (prior) { out({ ...base, passed: prior.commit, ran: false }, `${name}: passed - these inputs already passed on ${short(prior.commit)}; not run`); return 0; }
  const cmd = command || key.check.command;
  if (!cmd) throw new Exit(2, `rollcall results: the manifest gives ${name} no command: rollcall results run ${name} -- <command>`);
  if (!command && /<[a-z][\w-]*>/i.test(cmd)) throw new Exit(2, `rollcall results: ${name}'s command has a placeholder to fill in (${cmd}): rollcall results run ${name} -- <command>`);
  const before = dirty();
  if (before?.length) throw new Exit(3, `rollcall results: ${name}'s inputs have uncommitted changes (${before.slice(0, 5).join(", ")}): commit first, so the pass names the code that ran.`);
  // The manifest's command runs where the manifest says (a stack's dir); one given here runs at the root.
  const r = spawnSync("/bin/sh", ["-c", cmd], { cwd: command ? top : join(top, key.check.dir), stdio: "inherit" });
  if (r.status !== 0) { process.stderr.write(`rollcall results: ${name} failed (exit ${r.status ?? r.signal}); nothing recorded\n`); return r.status || 1; }
  // The pass counts only for the code that ran: HEAD and the checkout's inputs as they were at the start.
  const after = keyOf(top, name, "HEAD");
  const changed = dirty();
  if (after.hash !== key.hash || changed?.length) {
    process.stderr.write(`rollcall results: ${name} passed, but its inputs changed while it ran; nothing recorded. Run it again on the final code.\n`);
    return 3;
  }
  return report(say, json, { ...base, ran: true }, recordPass(top, key));
}

function report(say, json, base, rec) {
  const pushed = rec.pushed ? "and on origin" : rec.already ? `and on origin, which already had it (${short(rec.already)})` : null;
  if (json) say(JSON.stringify({ ...base, recorded: true, origin: rec.pushed || !!rec.already, error: rec.error ?? null }));
  else if (pushed) say(`${base.name}: pass recorded for ${short(base.commit)} (key ${short(base.key)}) on this machine ${pushed}`);
  else say(`${base.name}: pass recorded on this machine only - origin refused it (${rec.error}). Other machines and CI run ${base.name} themselves for these inputs.`);
  return rec.error ? 1 : 0;
}

// Run directly (CI's copy): node rollcall-results.mjs check <name> --github-output
const direct = () => { try { return !!process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]); } catch { return false; } };
if (direct()) {
  process.exitCode = await results(process.argv.slice(2));
}
