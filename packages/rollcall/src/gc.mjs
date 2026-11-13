// Worktree gc: removes agent worktrees (<main>/.claude/worktrees/*) whose work
// already landed. A worktree goes only when all of these hold: no open task
// names it (one whose own commits landed is marked landed first, unless its worker
// still runs), its work is on origin's default branch (its HEAD is there, it is
// the head of a merged PR, or merging it into main changes nothing: squash
// merges), it is not a branch made in the last day that has no commit yet,
// git holds no lock on it, no process (agent session, shell, dev server) has
// its cwd inside it, and `git status` is clean (or shows only tracked files
// missing: a removal that stopped partway, whose files are all on main). Checks
// run cheapest first. The test manifest's worktree.teardown runs next (e.g.
// deleting a per-worktree database branch); then the worktree moves in one step
// into the repo's git dir (rollcall-trash), git forgets it, its branch goes, and
// its files are deleted with no time limit. A move either happens or leaves the
// worktree whole, so a slow delete can never strand one half-removed (git's own
// `worktree remove` deletes in place, and a 30 s limit used to kill it partway).
// Nothing outside .claude/worktrees/ is touched.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { defaultBranch, fetchSync, gitSync, locate, mainSha } from "./git.mjs";
import { keyOf, manifestAt } from "./results.mjs";
import { dropSnapshots } from "./snapshot.mjs";

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, ...opts });
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const lastLine = (s) => String(s ?? "").trim().split("\n").pop();

/** `git worktree list --porcelain` as [{ path, head, branch, locked }]. */
function listWorktrees(main) {
  const r = gitSync(main, ["worktree", "list", "--porcelain"]);
  if (r.status !== 0) return [];
  return r.stdout.trim().split("\n\n").map((block) => {
    const wt = { path: null, head: null, branch: null, locked: false };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) wt.path = line.slice(9);
      else if (line.startsWith("HEAD ")) wt.head = line.slice(5);
      else if (line.startsWith("branch refs/heads/")) wt.branch = line.slice(18);
      else if (line === "locked" || line.startsWith("locked ")) wt.locked = true;
    }
    return wt;
  }).filter((w) => w.path);
}

/** Directories some process is running in (one lsof call; null when lsof is unavailable). */
function processCwds() {
  const r = run("lsof", ["-a", "-d", "cwd", "-F", "n"], { timeout: 10_000 });
  if (r.error || !r.stdout) return null;
  return r.stdout.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
}

/** branch -> head shas of its merged PRs (gh; empty when gh is missing or offline). */
function mergedPrHeads(main) {
  const r = run("gh", ["pr", "list", "--state", "merged", "--limit", "200", "--json", "headRefName,headRefOid"], { cwd: main });
  const heads = new Map();
  if (r.status !== 0) return heads;
  try {
    for (const pr of JSON.parse(r.stdout)) heads.set(pr.headRefName, [...(heads.get(pr.headRefName) ?? []), pr.headRefOid]);
  } catch {}
  return heads;
}

/** True when merging `head` into `base` would change nothing: its content is already there (a squash merge). */
function contentIn(main, base, head) {
  const r = gitSync(main, ["merge-tree", "--write-tree", base, head]);
  if (r.status !== 0) return false;
  const tree = r.stdout.split("\n")[0].trim();
  return !!tree && tree === gitSync(main, ["rev-parse", `${base}^{tree}`]).stdout?.trim();
}

/**
 * What a task's worktree holds that origin's default branch lacks, once the PR the task recorded merged:
 * "uncommitted changes", "commits not on origin/main", or null when all of it is there (its HEAD, or its
 * content after a squash merge) or the worktree is gone. A task with a second PR on the way stays open.
 */
export function unlanded(path) {
  const info = existsSync(path) ? locate(path) : null;
  const b = info && defaultBranch(info);
  if (!b) return null;
  fetchSync(info.top, b);
  const base = `origin/${b}`;
  const status = gitSync(info.top, ["status", "--porcelain"]);
  if (status.status === 0 && status.stdout.trim()) return "uncommitted changes";
  const head = gitSync(info.top, ["rev-parse", "HEAD"]).stdout?.trim();
  if (!head || gitSync(info.top, ["merge-base", "--is-ancestor", head, base]).status === 0 || contentIn(info.top, base, head)) return null;
  return `commits not on ${base}`;
}

/** The commit a worktree sits on, or null when it is gone. */
export const headOf = (path) => (existsSync(path) && gitSync(path, ["rev-parse", "HEAD"]).stdout?.trim()) || null;

/**
 * True when the branch has work of its own since `since` (the commit its task started from): a non-merge
 * commit on its first-parent line that is not on main's. A branch that only caught up with main (a
 * fast-forward, or a merge of main and nothing else) has none, though its HEAD or content sits on main.
 */
function ownWork(main, base, head, since) {
  const mine = gitSync(main, ["rev-list", "--first-parent", "--no-merges", head, `^${since}`, "--"]);
  if (mine.status !== 0) return false;
  const ids = mine.stdout.split("\n").filter(Boolean);
  if (!ids.length) return false;
  const theirs = new Set(base ? gitSync(main, ["rev-list", "--first-parent", base, `^${since}`, "--"]).stdout?.split("\n").filter(Boolean) : []);
  return ids.some((c) => !theirs.has(c));
}

const DAY = 24 * 3600_000;

/**
 * A branch made in the last day that has never moved: its reflog holds only its creation. It sits on
 * main because nothing was committed yet, not because its work landed, so the session that just made
 * it keeps it (it may not have cd'd in yet). False when the reflog is missing (logAllRefUpdates off).
 */
function untouchedNew(main, branch, now = Date.now()) {
  // %gd with --date=unix is the entry's own time (refs/heads/x@{1760000000}); %ct would be its commit's.
  const r = gitSync(main, ["reflog", "show", "--date=unix", "--format=%gd", `refs/heads/${branch}`, "--"]);
  const times = r.status === 0 ? r.stdout.split("\n").filter(Boolean).map((l) => Number(/@\{(\d+)\}$/.exec(l)?.[1])) : [];
  return times.length === 1 && now - times[0] * 1000 < DAY;
}

/** A manifest's worktree.teardown command, or null. */
function teardownIn(manifest) {
  try {
    const cmd = JSON.parse(manifest)?.worktree?.teardown;
    return typeof cmd === "string" && cmd.trim() ? cmd : null;
  } catch { return null; }
}

/** path -> size in KB, one `du` for all of them. */
export function sizesKb(paths) {
  const sizes = new Map();
  if (!paths.length) return sizes;
  for (const line of run("du", ["-sk", ...paths], { timeout: 120_000 }).stdout?.split("\n") ?? []) {
    const m = /^(\d+)\s+(.+)$/.exec(line);
    if (m) sizes.set(m[2], Number(m[1]));
  }
  return sizes;
}

/** Where gc moves a worktree before deleting its files: the repo's git dir, on the same disk as its worktrees. */
const trashOf = (commonDir) => join(commonDir, "rollcall-trash");

/**
 * Removes worktree `path` in a step that either happens or leaves it whole: a rename into the trash, then git forgets
 * it. A rename across disks (a worktrees folder linked elsewhere) cannot be one step: git removes it in place, with no
 * time limit. Returns null, or why it failed.
 */
function removeWorktree(info, path) {
  const trash = trashOf(info.commonDir);
  try {
    mkdirSync(trash, { recursive: true });
    renameSync(path, join(trash, `${basename(path)}-${Date.now()}`));
  } catch (e) {
    if (e.code !== "EXDEV") return e.code ? `${e.code}: ${e.message}` : String(e);
    const rm = gitSync(info.top, ["worktree", "remove", "--force", path], { timeout: 0 });
    return rm.status === 0 ? null : lastLine(rm.stderr) || "git worktree remove failed";
  }
  gitSync(info.top, ["worktree", "prune"]);
  return null;
}

/** Deletes what gc moved to the trash, this run's and any an earlier run left when it was stopped. Returns what stayed. */
export function emptyTrash(commonDir) {
  const trash = trashOf(commonDir);
  let names;
  try { names = readdirSync(trash); } catch { return []; }
  const stuck = [];
  for (const n of names) { try { rmSync(join(trash, n), { recursive: true, force: true, maxRetries: 2 }); } catch (e) { stuck.push(`${join(trash, n)}: ${e.code ?? e.message}`); } }
  return stuck;
}

/** gc with no word on checkouts' runtime (a caller that loads none): it removes worktrees and touches nothing else. */
const NO_RUNTIME = { stopAllActions: () => [], endSpotlight: () => null, forgetCheckout: () => {} };

/**
 * What gc does to a checkout's runtime (runtime.mjs, archive.mjs), loaded only by a gc that runs: a worktree it removes
 * has its run actions stopped, its spotlight ended ({ ok, err }, or null with none) and its ports given back.
 */
export async function gcRuntime() {
  const [{ forgetCheckout, stopAllActions }, { spotlightNaming, spotlightOff }] = await Promise.all([import("./runtime.mjs"), import("./archive.mjs")]);
  return { stopAllActions, forgetCheckout, endSpotlight: (main, path) => { const spot = spotlightNaming(main, path); return spot ? spotlightOff(spot) : null; } };
}

/**
 * Collects one repo. `occupied(path)` adds session knowledge (rollcall records)
 * on top of the process check. `task(path)` is the open task that names a worktree
 * ({ id, state, baseSha, land(why, head), hold(head) }) or null: an open task keeps its worktree, unless
 * its branch has commits of its own since its base and that work has landed, which marks it landed
 * (`land`; it returns what keeps the task open instead, and `hold` says it without writing) and lets the
 * other checks decide. `chat(path)` says why a chat keeps a worktree (one not archived), else null; it keeps it until the
 * chat's own work landed. `runtime` (gcRuntime) cleans up after a worktree it removes. Returns { removed: [{ name,
 * branch, kb, why }], kept: [{ name, branch, why, failed (a teardown or removal that failed) }], stuck: [trash folders
 * it could not delete] }.
 */
export function gcRepo(mainPath, { dryRun = false, occupied = () => false, task = () => null, chat = () => null, runtime = NO_RUNTIME } = {}) {
  const out = { removed: [], kept: [], stuck: [] };
  const info = locate(mainPath);
  if (!info) return out;
  const main = info.top;
  const root = join(main, ".claude", "worktrees") + sep;
  const candidates = listWorktrees(main).filter((w) => real(w.path).startsWith(root));
  if (!candidates.length) { if (!dryRun) out.stuck = emptyTrash(info.commonDir); return out; }

  const b = defaultBranch(info);
  const base = b && mainSha(info, b) ? `origin/${b}` : null;
  const merged = new Set(base ? gitSync(main, ["for-each-ref", `--merged=${base}`, "--format=%(refname:short)", "refs/heads"]).stdout?.split("\n").filter(Boolean) : []);
  let prHeads = null;
  let cwds;
  let missing = false;
  const keep = (w, why, failed = false) => out.kept.push({ name: basename(w.path), path: real(w.path), branch: w.branch, why, ...(failed ? { failed } : {}) });
  const prMerged = (w) => { if (!w.branch) return false; prHeads ??= mergedPrHeads(main); return !!prHeads.get(w.branch)?.includes(w.head); };
  const doomed = [];

  for (const w of candidates) {
    const path = real(w.path);
    if (!existsSync(path)) { missing = true; continue; }
    if (w.locked) { keep(w, "locked by a running agent"); continue; }
    let why = null;
    const onMain = w.branch ? merged.has(w.branch) : base && w.head && gitSync(main, ["merge-base", "--is-ancestor", w.head, base]).status === 0;
    if (onMain) why = `in ${base}`;
    if (!why && prMerged(w)) why = "PR merged";
    if (!why && base && w.head && contentIn(main, base, w.head)) why = `content in ${base}`;
    // Content on main counts as landed whatever the task's state (a worker that merged and never said so),
    // once its branch has commits of its own since the one it started from (a branch that only caught up
    // with main sits on main too); a task from before that was recorded must be pr-open. A task whose worker
    // still runs (its after-merge steps), or that waits on the owner, stays open and keeps its worktree.
    const t = task(path);
    if (t) {
      const moved = t.baseSha ? !!why && !!w.head && ownWork(main, base, w.head, t.baseSha) : t.state === "pr-open";
      if (!why || !moved) { keep(w, `task ${t.id} is open (${t.state})`); continue; }
      const held = dryRun ? t.hold(w.head) : t.land(why, w.head);
      if (held) { keep(w, `task ${t.id} is open (${t.state}): ${held}`); continue; }
    }
    // A chat not archived keeps its worktree until its own work landed: commits of its own whose content is on main,
    // or a merged PR at its HEAD. A fresh one has no commits and sits on main, so it reads as merged and stays.
    const kept = chat(path);
    if (kept && !(why && (!onMain || prMerged(w)))) { keep(w, kept); continue; }
    if (!why) { keep(w, "not merged"); continue; }
    if (onMain && w.branch && untouchedNew(main, w.branch)) { keep(w, "new, nothing committed yet"); continue; }
    // A session in it, or work not committed, keeps it before anything of its runtime is touched.
    if (occupied(path)) { keep(w, "in use"); continue; }
    // Without the index refresh, which would make a worktree no one works in look touched (unlandedWorktrees).
    const status = gitSync(path, ["--no-optional-locks", "status", "--porcelain"]);
    if (status.status !== 0) { keep(w, "git status failed"); continue; }
    const changes = status.stdout.split("\n").filter(Boolean);
    // Only tracked files missing: a removal that stopped partway. Their content is on main (why), so nothing is lost.
    if (changes.length && !changes.every((l) => l.startsWith(" D "))) { keep(w, "uncommitted changes"); continue; }
    if (changes.length) why = `${why}; finishing a removal that stopped partway`;
    // Its own run actions (a dev server rollcall started) stop with it, so they do not keep it "in use"; a spotlight on it ends.
    if (!dryRun) {
      runtime.stopAllActions(path);
      const off = runtime.endSpotlight(main, path);
      if (off && !off.ok) { keep(w, `its spotlight could not end: ${off.err}`); continue; }
    }
    if (cwds === undefined) cwds = processCwds();
    if (cwds?.some((c) => c === path || c.startsWith(path + sep))) { keep(w, "in use"); continue; }
    doomed.push({ w, path, why });
  }

  if (dryRun) {
    for (const d of doomed) out.removed.push({ name: basename(d.path), branch: d.w.branch, kb: 0, why: d.why });
    return out;
  }
  // The worktree's own manifest wins; else the default branch's (the main checkout may sit on an old branch).
  let baseManifest;
  const ready = [];
  for (const d of doomed) {
    const teardown = teardownIn(read(join(d.path, ".claude", "test-manifest.json")))
      ?? (base ? teardownIn(baseManifest ??= gitSync(main, ["show", `${base}:.claude/test-manifest.json`]).stdout ?? "") : null);
    if (teardown) {
      const t = run("sh", ["-c", teardown], { cwd: d.path, timeout: 180_000 });
      if (t.status !== 0) { keep(d.w, `teardown failed: ${lastLine(t.stderr || t.stdout || t.error)}`, true); continue; }
    }
    ready.push(d);
  }
  const sizes = sizesKb(ready.map((d) => d.path));
  for (const d of ready) {
    const failed = removeWorktree(info, d.path);
    if (failed) { keep(d.w, `remove failed: ${failed}`, true); continue; }
    if (d.w.branch) gitSync(main, ["branch", "-D", d.w.branch]);
    dropSnapshots(d.path);
    runtime.forgetCheckout(d.path);
    out.removed.push({ name: basename(d.path), branch: d.w.branch, kb: sizes.get(d.path) ?? 0, why: d.why });
  }
  if (missing) gitSync(main, ["worktree", "prune"]);
  out.stuck = emptyTrash(info.commonDir);
  return out;
}

const statMs = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };

/** When anyone last worked in a worktree: its folder, or git's index, HEAD or reflog for it (a commit, a checkout, an add). */
function lastTouched(path) {
  const info = locate(path);
  const g = info?.gitDir;
  return Math.max(statMs(path), ...(g ? [join(g, "index"), join(g, "HEAD"), join(g, "logs", "HEAD")].map(statMs) : []));
}

/**
 * Worktrees whose work never landed and that no one has touched for `days`: what `rollcall clean` lists for the
 * owner's yes. Only those gc keeps as "not merged" or "uncommitted changes" (an open task's, an open chat's, a locked
 * one stay out), with no session or process in them. [{ path, main, branch, touched, lost }]: `lost` says what removing
 * it loses (its uncommitted changes; its branch stays, so its commits do not).
 */
export function unlandedWorktrees(mainPath, { occupied = () => false, task = () => null, chat = () => null, now = Date.now(), days = 14 } = {}) {
  const info = locate(mainPath);
  if (!info) return [];
  const res = gcRepo(mainPath, { dryRun: true, occupied, task, chat });
  const old = res.kept.filter((k) => (k.why === "not merged" || k.why === "uncommitted changes") && !occupied(k.path) && now - lastTouched(k.path) > days * DAY);
  if (!old.length) return [];
  const cwds = processCwds();
  const out = [];
  for (const k of old.filter((k) => !cwds?.some((c) => c === k.path || c.startsWith(k.path + sep)))) {
    // -z: paths unquoted; a rename's old path follows as its own entry. A folder's own mtime misses an edit deeper in
    // it, and an IDE's git calls may leave the index alone, so a changed file's mtime also counts as a touch.
    const st = gitSync(k.path, ["--no-optional-locks", "status", "--porcelain", "-z"]);
    if (st.status !== 0) continue;
    const entries = st.stdout.split("\0").filter(Boolean);
    // A loop, not Math.max(...spread): a half-deleted tree can have 100k entries. A missing file stats as 0.
    let touched = lastTouched(k.path), count = 0;
    for (let i = 0; i < entries.length; i++, count++) {
      touched = Math.max(touched, statMs(join(k.path, entries[i].slice(3))));
      if (/[RC]/.test(entries[i].slice(0, 2))) i++;
    }
    if (now - touched <= days * DAY) continue;
    const lost = count ? `${count} uncommitted change${count === 1 ? "" : "s"} lost` : "nothing uncommitted";
    out.push({ path: k.path, main: info.top, branch: k.branch, touched, lost });
  }
  return out;
}

/**
 * Removes a worktree whose work did not land, on the owner's word (`rollcall clean --yes`): moved out in one step and
 * deleted, as gc removes one, uncommitted changes and all. Its branch stays. Returns null, or why it failed.
 */
export function dropWorktree(mainPath, path) {
  const info = locate(mainPath);
  if (!info) return "not a git checkout";
  const failed = removeWorktree(info, path);
  if (!failed) { dropSnapshots(path); emptyTrash(info.commonDir); }
  return failed;
}

/**
 * Refs nothing reads any more; returns how many went. refs/rollcall/queue/<pr> is the lander's copy of a PR's
 * head, needed while `queued` (the queue's PR numbers) holds the PR. refs/passed/* on origin go a week after
 * their commit, except the passes that answer for main as it stands: a PR that leaves a suite's inputs alone
 * keeps reusing that pass however old it is. A pass that goes wrongly costs one re-run of its suite.
 */
export function pruneRefs(mainPath, { queued = [], now = Date.now() } = {}) {
  const info = locate(mainPath);
  if (!info) return 0;
  const main = info.top;
  const refs = (format, prefix) => gitSync(main, ["for-each-ref", `--format=${format}`, prefix]).stdout?.split("\n").filter(Boolean) ?? [];
  const drop = (names) => gitSync(main, ["update-ref", "--stdin"], { input: names.map((r) => `delete ${r}\n`).join(""), stdio: ["pipe", "pipe", "pipe"] });
  const landed = refs("%(refname)", "refs/rollcall/queue").filter((r) => !queued.includes(r.split("/").pop()));
  if (landed.length) drop(landed);

  const b = defaultBranch(info);
  if (!b || !mainSha(info, b)) return landed.length;
  // Background and unattended: never ask for a password.
  // GIT_SSH_COMMAND would override the user's own core.sshCommand or GIT_SSH (a chosen key), so it is set only when none is.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH && !gitSync(main, ["config", "core.sshCommand"]).stdout?.trim()) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  if (gitSync(main, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", "+refs/passed/*:refs/passed/*"], { env, timeout: 120_000 }).status !== 0) return landed.length;
  // What origin holds now: a pass another machine already deleted would fail the whole push, every day.
  const ls = gitSync(main, ["ls-remote", "origin", "refs/passed/*"], { env, timeout: 60_000 });
  if (ls.status !== 0) return landed.length;
  const onOrigin = new Set(ls.stdout.split("\n").map((l) => l.split("\t")[1]).filter(Boolean));
  const m = manifestAt(main, `origin/${b}`);
  const checks = [...(Array.isArray(m.stacks) ? m.stacks : []), ...(Array.isArray(m.ci?.prePush) ? m.ci.prePush : [])].map((c) => c?.name).filter(Boolean);
  // Without main's keys nothing says which passes it still needs: delete none.
  if (!checks.length) return landed.length;
  let current;
  try { current = new Set(checks.map((name) => keyOf(main, name, `origin/${b}`).ref)); } catch { return landed.length; }
  // A ref with no commit date (a pass that is not a commit) is left alone.
  const old = refs("%(committerdate:unix) %(refname)", "refs/passed")
    .map((l) => l.split(" ")).filter(([at, ref]) => Number(at) > 0 && now - Number(at) * 1000 > 7 * 86400_000 && !current.has(ref)).map(([, ref]) => ref);
  const local = old.filter((r) => !onOrigin.has(r));
  if (local.length) drop(local);
  const remote = old.filter((r) => onOrigin.has(r));
  let gone = local.length;
  for (let i = 0; i < remote.length; i += 500) {
    const batch = remote.slice(i, i + 500);
    if (gitSync(main, ["push", "--quiet", "--no-verify", "origin", ...batch.map((r) => `:${r}`)], { env, timeout: 120_000 }).status !== 0) break;
    drop(batch);
    gone += batch.length;
  }
  return landed.length + gone;
}

const gb = (kb) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(kb / 1024))} MB`);

/** One summary line for a repo's gc, or null when nothing was removed. */
export function summary(name, res, { dryRun = false } = {}) {
  if (!res.removed.length) return null;
  const n = res.removed.length;
  const kb = res.removed.reduce((s, r) => s + r.kb, 0);
  const verb = dryRun ? "would remove" : "removed";
  return `${name}: ${verb} ${n} merged worktree${n === 1 ? "" : "s"}${kb ? ` (${gb(kb)} freed)` : ""}: ${res.removed.map((r) => r.name).join(", ")}`;
}
