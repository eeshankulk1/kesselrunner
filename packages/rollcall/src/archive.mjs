// Archive, restore and spotlight: moving a task's work out of its worktree and back, and running it from the main
// checkout for a while.
//
// Archive frees a task's worktree folder and ports without losing anything: its run actions stop, every uncommitted
// change (untracked files too, gitignored ones not) is saved as a commit under refs/rollcall/archive/ (a ref no push
// sends), and the task record and the worker's conversation stay. Restore brings the worktree back at its old path
// with that work in place. Spotlight is for what can only run from one place (an iOS app with a fixed bundle, an
// OAuth callback on one URL): the main checkout moves to a snapshot of the task's files, kept in step while it lasts,
// and turning it off puts the main checkout back on the branch and commit it was on. Both are the owner's or the
// supervisor's actions, never a worker's: the main-checkout rule still holds for agents.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultBranch, fetchSync, gitSync, locate } from "./git.mjs";
import {
  allSpotlights, checkoutFacts, forgetCheckout, inside, listActions, snapshot, spotlightOf, startSetup, stopAllActions, writeSpotlight,
} from "./runtime.mjs";
import * as store from "./store.mjs";

const lines = (s) => String(s ?? "").split("\n").filter(Boolean);
const lastLine = (s) => String(s ?? "").trim().split("\n").pop();

/** The ref that holds task `t`'s uncommitted work while it is archived. */
export const archiveRef = (t) => `refs/rollcall/archive/${t.home}/${t.id}`;

function sizeKb(path) {
  const m = /^(\d+)/.exec(spawnSync("du", ["-sk", path], { encoding: "utf8", timeout: 120_000 }).stdout ?? "");
  return m ? Number(m[1]) : 0;
}
export const sizeText = (kb) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(kb / 1024))} MB`);

/** The manifest's worktree.teardown for the checkout at `top`, or null. */
function teardownOf(top) {
  try {
    const cmd = JSON.parse(readFileSync(join(top, ".claude", "test-manifest.json"), "utf8"))?.worktree?.teardown;
    return typeof cmd === "string" && cmd.trim() ? cmd.trim() : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- archive

/**
 * What archiving task `t` would do, for the owner to see first: { worktree, kb, uncommitted: [porcelain lines],
 * unpushed, actions: [names running], ports, spotlit, teardown } or { err }.
 */
export function archivePlan(t) {
  if (t.archived) return { err: `${t.id} is archived already (rollcall task restore ${t.id} brings it back)` };
  if (!t.branch) return { err: `${t.id} has no worktree of its own to archive` };
  if (!existsSync(t.worktree)) return { err: `${t.id}'s worktree is gone already (${t.worktree})` };
  const top = t.worktree;
  const f = checkoutFacts(top, { allocate: false });
  const status = gitSync(top, ["status", "--porcelain"]);
  if (status.status !== 0) return { err: `git status failed in ${top}: ${lastLine(status.stderr)}` };
  const up = gitSync(top, ["rev-list", "--count", `origin/${t.branch}..HEAD`]);
  const ahead = up.status === 0 ? Number(up.stdout.trim()) : Number(gitSync(top, ["rev-list", "--count", `${t.base ?? "HEAD"}..HEAD`]).stdout?.trim() || 0);
  const spot = spotlightOf(t.repo.main);
  return {
    worktree: top, kb: sizeKb(top), uncommitted: lines(status.stdout), unpushed: ahead, onOrigin: up.status === 0,
    actions: f ? listActions(f).filter((a) => a.running).map((a) => a.name) : [], ports: f?.ports ?? null,
    spotlit: !!(spot && spot.task?.home === t.home && spot.task?.id === t.id), teardown: teardownOf(top),
  };
}

/** The plan as the lines the owner reads before saying yes. */
export function planLines(t, p) {
  return [
    `Archiving ${t.id} removes its worktree ${p.worktree} (${sizeText(p.kb)} freed) and keeps everything else:`,
    `  - uncommitted: ${p.uncommitted.length ? `${p.uncommitted.length} file${p.uncommitted.length === 1 ? "" : "s"}, saved to ${archiveRef(t)} (a local ref, never pushed)` : "nothing"}`,
    `  - branch ${t.branch} stays, with its commits${p.unpushed ? ` (${p.unpushed} not on origin${p.onOrigin ? "" : ": the branch was never pushed"})` : ""}`,
    `  - the task record and the worker's conversation stay; the worker stops`,
    ...(p.actions.length ? [`  - run actions stop: ${p.actions.join(", ")}`] : []),
    ...(p.ports ? [`  - ports ${p.ports.base}-${p.ports.last} go back to the pool`] : []),
    ...(p.spotlit ? ["  - its spotlight ends: the main checkout goes back to where it was"] : []),
    ...(p.teardown ? [`  - the manifest's teardown runs first: ${p.teardown}`] : []),
    "Gitignored files in it (env files, dependencies, build output) go with the folder; restore copies and sets them up again.",
  ];
}

/**
 * Archives task `t` (archivePlan first; the caller has stopped its worker). Returns { ok, archived, warnings } or
 * { ok: false, err }, with nothing removed when it fails.
 */
export function archiveTask(t) {
  const p = archivePlan(t);
  if (p.err) return { ok: false, err: p.err };
  const warnings = [];
  if (p.spotlit) {
    const off = spotlightOff(spotlightOf(t.repo.main));
    if (!off.ok) return { ok: false, err: `its spotlight could not end: ${off.err}` };
  }
  stopAllActions(p.worktree);
  const snap = snapshot(p.worktree, `rollcall archive of ${t.home}:${t.id}`);
  if (!snap) return { ok: false, err: `could not save the uncommitted work in ${p.worktree}; nothing was removed` };
  const ref = archiveRef(t);
  if (gitSync(t.repo.main, ["update-ref", ref, snap.commit]).status !== 0) return { ok: false, err: `could not write ${ref}; nothing was removed` };
  if (p.teardown) {
    const r = spawnSync("sh", ["-c", p.teardown], { cwd: p.worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
    if (r.status !== 0) warnings.push(`teardown failed (${lastLine(r.stderr || r.stdout) || `exit ${r.status}`}): what it cleans up outside the worktree is still there`);
  }
  const rm = gitSync(t.repo.main, ["worktree", "remove", "--force", p.worktree], { timeout: 300_000 });
  if (rm.status !== 0) return { ok: false, err: `git worktree remove failed: ${lastLine(rm.stderr)} (the work is saved in ${ref})` };
  forgetCheckout(p.worktree);
  const archived = { at: Date.now(), ref, head: snap.head, branch: t.branch, files: p.uncommitted.length, kb: p.kb };
  return { ok: true, archived, warnings };
}

// ---------------------------------------------------------------- restore

/**
 * Brings archived task `t`'s worktree back at its old path, on its branch, with its saved work in place, then starts
 * its setup again. Says when the branch moved on origin while it was archived, and changes nothing about that.
 * Returns { ok, notes: [lines] } or { ok: false, err }.
 */
export function restoreTask(t, { bin }) {
  const a = t.archived;
  if (!a) return { ok: false, err: `${t.id} is not archived` };
  if (existsSync(t.worktree)) return { ok: false, err: `${t.worktree} exists already: move it away first` };
  const main = t.repo.main;
  const info = locate(main);
  const notes = [];
  const b = info && defaultBranch(info);
  if (b) fetchSync(main, b);
  gitSync(main, ["fetch", "--quiet", "origin", `+refs/heads/${a.branch}:refs/remotes/origin/${a.branch}`], { timeout: 120_000 });
  gitSync(main, ["worktree", "prune"]);
  const has = gitSync(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${a.branch}`]).status === 0;
  const add = gitSync(main, ["worktree", "add", ...(has ? [t.worktree, a.branch] : ["-b", a.branch, t.worktree, a.head])], { timeout: 300_000 });
  if (add.status !== 0) return { ok: false, err: `git worktree add failed: ${lastLine(add.stderr)}` };
  const head = gitSync(t.worktree, ["rev-parse", "HEAD"]).stdout?.trim();
  if (head !== a.head) notes.push(`${a.branch} is at ${head?.slice(0, 8)} now, not ${a.head.slice(0, 8)} as when it was archived`);
  const remote = gitSync(main, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${a.branch}`]).stdout?.trim();
  if (remote && remote !== head && gitSync(main, ["merge-base", "--is-ancestor", remote, head]).status !== 0) {
    const n = gitSync(main, ["rev-list", "--count", `${head}..${remote}`]).stdout?.trim();
    notes.push(`origin/${a.branch} moved on ${n} commit${n === "1" ? "" : "s"} while archived; nothing was merged or rebased: bring them in yourself (git merge origin/${a.branch})`);
  }
  // The saved work goes back as uncommitted changes: whatever was staged comes back unstaged.
  const diff = gitSync(main, ["diff", "--binary", a.head, a.ref], { maxBuffer: 512 * 1024 * 1024 });
  if (diff.stdout?.trim()) {
    const ap = gitSync(t.worktree, ["apply", "--whitespace=nowarn"], { input: diff.stdout, stdio: ["pipe", "pipe", "pipe"] });
    if (ap.status !== 0) return { ok: false, err: `the worktree is back, but its saved work did not apply: ${lastLine(ap.stderr)}. It is still in ${a.ref} (git diff ${a.head.slice(0, 8)} ${a.ref} shows it)` };
  }
  gitSync(main, ["update-ref", "-d", a.ref]);
  checkoutFacts(t.worktree);
  startSetup(t.worktree, { bin, skipCommand: t.kind === "discuss" });
  return { ok: true, notes };
}

// ---------------------------------------------------------------- spotlight

/** Tracked changes in checkout `top` (porcelain lines), or null when git status fails. */
function trackedChanges(top) {
  const r = gitSync(top, ["status", "--porcelain", "--untracked-files=no"]);
  return r.status === 0 ? lines(r.stdout) : null;
}

/**
 * Puts task `t` in the spotlight: the main checkout moves to a snapshot of the task's files (tracked and untracked,
 * not gitignored), detached, so its branch never moves. Refuses while the main checkout has changes of its own or
 * another task holds the spotlight. Returns { ok, err }.
 */
export function spotlightOn(t) {
  if (t.archived) return { ok: false, err: `${t.id} is archived: restore it first` };
  if (!t.branch || !existsSync(t.worktree)) return { ok: false, err: `${t.id} has no worktree of its own` };
  const main = t.repo.main;
  const held = (now) => (now.task?.home === t.home && now.task?.id === t.id ? { ok: true, already: true } : { ok: false, err: `${now.task?.home}:${now.task?.id} holds the spotlight in ${t.repo.name}: turn it off first (rollcall task spotlight ${now.task?.id} --off)` });
  if (spotlightOf(main)) return held(spotlightOf(main));
  // The snapshot can take a while in a big repo: taken before the lock, which a long holder would lose.
  const snap = snapshot(t.worktree, `rollcall spotlight of ${t.home}:${t.id}`);
  if (!snap) return { ok: false, err: `could not take a snapshot of ${t.worktree}` };
  const r = store.withRuntimeLock(() => {
    const now = spotlightOf(main);
    if (now) return held(now);
    const own = trackedChanges(main);
    if (own === null) return { ok: false, err: `git status failed in ${main}` };
    if (own.length) return { ok: false, err: `the main checkout has uncommitted work of its own (${own.length} file${own.length === 1 ? "" : "s"}: ${own.slice(0, 3).map((l) => l.slice(3)).join(", ")}): commit or move it first` };
    const branch = gitSync(main, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout?.trim() || null;
    const head = gitSync(main, ["rev-parse", "HEAD"]).stdout?.trim();
    const co = gitSync(main, ["checkout", "--quiet", "--detach", snap.commit], { timeout: 300_000 });
    if (co.status !== 0) return { ok: false, err: `the main checkout could not move: ${lastLine(co.stderr)}` };
    const at = Date.now();
    writeSpotlight(main, { main, repo: t.repo.name, worktree: t.worktree, task: { home: t.home, id: t.id }, before: { branch, head }, mirrored: { tree: snap.tree, commit: snap.commit, at }, at });
    return { ok: true };
  });
  return r?.out ?? { ok: false, err: "the runtime store is busy; try again" };
}

/**
 * Brings the main checkout in step with its spotlit task's files, when they changed. Stops (and says so) when someone
 * changed the main checkout itself. Returns { ok, changed, err }.
 */
export function spotlightSync(spot) {
  if (!spot || !existsSync(spot.worktree)) return { ok: false, err: "its task's worktree is gone" };
  const snap = snapshot(spot.worktree, `rollcall spotlight of ${spot.task.home}:${spot.task.id}`);
  if (!snap) return { ok: false, err: `could not take a snapshot of ${spot.worktree}` };
  if (snap.tree === spot.mirrored.tree) return { ok: true, changed: false };
  const r = store.withRuntimeLock(() => {
    // Ended, or moved on, while the snapshot was taken: nothing to follow now.
    const now = spotlightOf(spot.main);
    if (!now || now.worktree !== spot.worktree || now.at !== spot.at || snap.tree === now.mirrored.tree) return { ok: true, changed: false };
    const own = trackedChanges(now.main);
    if (own === null || own.length) return { ok: false, err: `the main checkout was changed during the spotlight (${own?.slice(0, 3).map((l) => l.slice(3)).join(", ") ?? "git status failed"}): it no longer follows the task` };
    const co = gitSync(now.main, ["checkout", "--quiet", "--detach", snap.commit], { timeout: 300_000 });
    if (co.status !== 0) return { ok: false, err: `the main checkout could not move: ${lastLine(co.stderr)}` };
    writeSpotlight(now.main, { ...now, mirrored: { tree: snap.tree, commit: snap.commit, at: Date.now() } });
    return { ok: true, changed: true };
  });
  return r?.out ?? { ok: false, err: "the runtime store is busy" };
}

/**
 * Ends a spotlight: the main checkout goes back to the branch (or commit) it was on, its files exactly as they were.
 * Refuses when someone changed the main checkout during the spotlight, unless `force` (those changes are lost).
 * Returns { ok, identical, err }.
 */
export function spotlightOff(spot, { force = false } = {}) {
  if (!spot) return { ok: true, identical: true };
  const r = store.withRuntimeLock(() => {
    const main = spot.main;
    const own = trackedChanges(main);
    if (own === null) return { ok: false, err: `git status failed in ${main}` };
    if (own.length && !force) return { ok: false, err: `the main checkout was changed during the spotlight (${own.length} file${own.length === 1 ? "" : "s"}: ${own.slice(0, 3).map((l) => l.slice(3)).join(", ")}); make those changes in the task's worktree, or pass --force to drop them` };
    const target = spot.before.branch ?? spot.before.head;
    const co = gitSync(main, ["checkout", "--quiet", ...(force ? ["-f"] : []), ...(spot.before.branch ? [target] : ["--detach", target])], { timeout: 300_000 });
    if (co.status !== 0) return { ok: false, err: `the main checkout could not go back to ${target}: ${lastLine(co.stderr)}` };
    writeSpotlight(main, null);
    const head = gitSync(main, ["rev-parse", "HEAD"]).stdout?.trim();
    const after = trackedChanges(main);
    return { ok: true, identical: head === spot.before.head && after?.length === 0, head };
  });
  return r?.out ?? { ok: false, err: "the runtime store is busy; try again" };
}

/** Every spotlight whose task belongs to home `h` brought in step (the watcher's tick). Returns [{ spot, result }] for those that changed or failed. */
export function syncSpotlights(h) {
  return allSpotlights().filter((s) => s.task?.home === h).map((spot) => ({ spot, result: spotlightSync(spot) })).filter((x) => !x.result.ok || x.result.changed);
}

/** The spotlight that names checkout `top` (gc ends it before it removes the worktree), or null. */
export const spotlightNaming = (main, top) => { const s = spotlightOf(main); return s && inside(top, s.worktree) && inside(s.worktree, top) ? s : null; };
