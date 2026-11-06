// Per-turn snapshots of a task worktree: after each turn of a session in a linked worktree, the worktree's whole
// state (tracked and untracked files, gitignored ones left out) is recorded as a commit, so the owner (or the
// worker) can see what each turn changed, files written by shell commands included, and put the worktree back.
//
// Where they live: never under the repo's own refs/ (`git push --mirror` pushes every ref there). Each linked
// worktree gets a private bare repo, <ROLLCALL_HOME>/_snapshots/<hash of its path>.git, whose
// objects/info/alternates points at the repo's own objects: blobs the repo already has are shared, and only new
// objects (files no commit or index holds yet) are written there. Turn n is refs/turns/<n> in that repo; each
// turn's parent is the turn before it.
//
// Taking one never changes what git shows the worker: it runs `git add -A`, `write-tree` and `commit-tree` against
// the snapshot repo's own index (seeded once from the worktree's, kept between turns so its stat data spares
// rehashing files that did not change, untracked ones included) with GIT_OBJECT_DIRECTORY pointed at the snapshot
// repo, so the branch, HEAD, the real index and the stash list stay as they were.
//
// The Stop hook (hooks.mjs) takes one in the background after each turn, and SessionStart the turn-0 baseline; a
// Codex worker (codex/worker.mjs) does both from its protocol. Another harness runs `rollcall turns take` on its turn end.
//
// Known limit: blobs the repo already had are borrowed, not copied. One that only the repo's index or a commit
// later dropped (a staged-only file, a commit gone by rebase, amend or reset) is unreachable there, and the repo's
// `git gc` may prune it two weeks on; a snapshot older than that can then miss it. Snapshots go with their
// worktree (gc), so this only bites a worktree kept for weeks. A file force-added to the worktree's index while a
// .gitignore rule matches it, after the snapshot index was seeded, is left out of the snapshots.
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gitSync, isMainCheckout, locate, repoKey } from "./git.mjs";
import { pidAlive } from "./proc.mjs";
import { P, ago, cli, isLive, short } from "./session.mjs";
import * as store from "./store.mjs";
import { taskEnv, workerState } from "./supervisor.mjs";
import { resolve as resolveTask, take, taskAt } from "./task.mjs";

export const USAGE = `  rollcall turns [<task>] [--json]       a task worktree's turns: when, which session, the files each changed
                                         (<task>: a name or id like luke or t3; default: this folder's worktree)
  rollcall turns diff <n> [<task>] [--json]    what turn n changed (turn n-1 to turn n)
  rollcall turns since <n> [<task>] [--json]   what changed since turn n (turn n to the worktree now)
  rollcall turns restore <n> [<task>] [--wait]
                                         put the worktree's files back to turn n (branch, HEAD and index stay);
                                         the state it replaces is taken as a turn first, so it can be undone.
                                         Refuses while the task's worker is mid-turn (--wait: wait up to 10m)
  rollcall turns take [--session <id>] [--baseline] [--quiet]
                                         record this worktree's state as the next turn (the Stop hook runs it;
                                         another harness runs it from its own turn-end event)`;

const PATH_KEY = (top) => createHash("sha1").update(top).digest("hex").slice(0, 16);
/** The snapshot repo of the worktree at `top` (it need not exist). */
export const snapshotPath = (top) => join(store.snapshotsDir(), `${PATH_KEY(top)}.git`);
const META = "rollcall.json";
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

// A git run from a hook or a git hook can carry these; any one of them would point the snapshot at the wrong place.
const GIT_PLACES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE"];
function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of GIT_PLACES) delete env[k];
  return { ...env, GIT_TERMINAL_PROMPT: "0", ...extra };
}

/** git against the snapshot repo itself. */
const snapGit = (snap, args, opts = {}) => gitSync(snap, args, { env: baseEnv(), ...opts });

/** The worktree `dir` sits in, as { info, top, snap }; null when it is not a linked worktree. */
export function worktreeOf(dir) {
  const info = locate(dir);
  if (!info || isMainCheckout(info)) return null;
  return { info, top: info.top, snap: snapshotPath(info.top) };
}

/**
 * Creates the snapshot repo if needed; one left by an earlier worktree at the same path (another repo) starts over.
 * Runs under the lock, so two first takes never init at once. Temp files a killed run left are swept here.
 */
function ensureRepo({ info, top, snap }) {
  const meta = readJson(join(snap, META));
  if (meta && meta.commonDir === info.commonDir && existsSync(join(snap, "HEAD"))) {
    try {
      for (const f of readdirSync(snap)) if (f.endsWith(".tmp") && Date.now() - statSync(join(snap, f)).mtimeMs > 3600_000) unlinkSync(join(snap, f));
    } catch {}
    return;
  }
  if (meta) rmSync(snap, { recursive: true, force: true });
  if (!existsSync(join(snap, "HEAD"))) {
    const r = gitSync(dirname(snap), ["init", "--bare", "-q", snap], { env: baseEnv() });
    if (r.status !== 0) throw new Error(`git init failed: ${r.stderr.trim()}`);
  }
  mkdirSync(join(snap, "objects", "info"), { recursive: true });
  writeFileSync(join(snap, "objects", "info", "alternates"), `${join(info.commonDir, "objects")}\n`);
  writeFileSync(join(snap, META), JSON.stringify({ worktree: top, commonDir: info.commonDir, createdAt: Date.now() }));
}

/** Past this a lock is stale even with its holder's id alive (ids get reused): longer than any take can run. */
const LOCK_STALE_MS = 45 * 60_000;

/**
 * One take or restore at a time per worktree: a folder beside the snapshot repo (so the repo can be created
 * under it) holding its holder's pid. It is stale when that process is gone, or past LOCK_STALE_MS; a waiter
 * moves a stale one aside with one rename, so two waiters never both take it, and puts back one it moved by
 * mistake (a fresh holder's). The holder removes the lock only while it is still its own.
 */
async function withSnapLock(snap, fn) {
  const lock = `${snap}.lock`;
  const owner = join(lock, "owner");
  const me = `${process.pid} ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dirname(snap), { recursive: true });
  for (const end = Date.now() + 60_000; ;) {
    try { mkdirSync(lock); writeFileSync(owner, me); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = 0;
      let held = null;
      try { age = Date.now() - statSync(lock).mtimeMs; held = readFileSync(owner, "utf8"); } catch {}
      const pid = Number(held?.split(" ")[0]);
      // No owner yet: a holder between its mkdir and its write, unless that was long ago (it died there).
      const stale = held ? !pidAlive(pid) || age > LOCK_STALE_MS : age > 10_000;
      if (stale) {
        const aside = `${lock}.${process.pid}.${Date.now()}.stale`;
        try { renameSync(lock, aside); } catch { continue; }
        let moved = null;
        try { moved = readFileSync(join(aside, "owner"), "utf8"); } catch {}
        // A fresh holder's lock moved by mistake goes back; if it cannot (another waiter took the name meanwhile),
        // it stays aside rather than be deleted under its holder (ensureRepo-style sweeps leave it to pruneSnapshots).
        if (moved !== held) { try { renameSync(aside, lock); } catch {} continue; }
        rmSync(aside, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > end) throw new Error("another snapshot of this worktree is running");
      await sleep(100);
    }
  }
  try { return await fn(); } finally {
    try { if (readFileSync(owner, "utf8") === me) rmSync(lock, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------- reading turns

/**
 * How many turns the worktree at `top` has and the last one's number, from the snapshot repo's ref files alone (no
 * git, so a front end's snapshot can ask every second): { count, last }, or null with none recorded.
 */
export function turnsSummary(top) {
  const snap = snapshotPath(top);
  const ns = new Set();
  try { for (const f of readdirSync(join(snap, "refs", "turns"))) if (/^\d+$/.test(f)) ns.add(Number(f)); } catch {}
  try {
    for (const l of readFileSync(join(snap, "packed-refs"), "utf8").split("\n")) {
      const m = / refs\/turns\/(\d+)$/.exec(l);
      if (m) ns.add(Number(m[1]));
    }
  } catch {}
  return ns.size ? { count: ns.size, last: Math.max(...ns) } : null;
}

/** Turns as [{ n, sha, tree, kind, at, session, restored }], oldest first. */
function refsOf(snap) {
  if (!existsSync(join(snap, "HEAD"))) return [];
  const r = snapGit(snap, ["for-each-ref", "--format=%(refname)%1f%(objectname)%1f%(tree)%1f%(contents)%1e", "refs/turns/"]);
  if (r.status !== 0) return [];
  return r.stdout.split("\x1e").map((s) => s.replace(/^\n/, "")).filter(Boolean).map((rec) => {
    const [ref, sha, tree, body = ""] = rec.split("\x1f");
    const fields = Object.fromEntries(body.split("\n").map((l) => /^([a-z-]+): (.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
    return {
      n: Number(ref.slice("refs/turns/".length)), sha, tree, kind: fields.kind ?? "turn", at: Number(fields.at) || null,
      session: fields.session || null, restored: fields.restored !== undefined ? Number(fields.restored) : null,
    };
  }).filter((t) => Number.isInteger(t.n)).sort((a, b) => a.n - b.n);
}

/** [{ status, path }] between two trees or commits, from `diff-tree --raw` (gitlinks included, marked). */
function changes(snap, a, b) {
  const r = snapGit(snap, ["diff-tree", "-r", "-z", "--no-renames", "--raw", a, b], { maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git diff-tree failed: ${r.stderr.trim()}`);
  const parts = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d+) (\d+) \S+ \S+ (\w)/.exec(parts[i]);
    if (m) out.push({ status: m[3], path: parts[i + 1], gitlink: m[1] === "160000" || m[2] === "160000" });
  }
  return out;
}

const EMPTY_TREE = (snap) => snapGit(snap, ["hash-object", "-t", "tree", "--stdin"], { input: "", stdio: ["pipe", "pipe", "pipe"] }).stdout.trim();

/** Each turn with the files it changed (turn 0, the baseline, changes none). */
export function listTurns(top) {
  const snap = snapshotPath(top);
  const turns = refsOf(snap);
  if (!turns.length) return [];
  // One git for every turn: diff-tree --stdin prints each commit's id, then its changes against its parent.
  const r = snapGit(snap, ["diff-tree", "--stdin", "-r", "-z", "--no-renames", "--name-status"], {
    input: turns.map((t) => t.sha).join("\n") + "\n", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024,
  });
  const files = new Map(turns.map((t) => [t.sha, []]));
  let cur = null;
  const parts = (r.stdout ?? "").split("\0");
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i].trim();
    if (files.has(tok)) { cur = files.get(tok); continue; }
    if (cur && /^[ACDMRTUX]$/.test(tok) && i + 1 < parts.length) cur.push({ status: tok, path: parts[++i] });
  }
  return turns.map((t) => ({ ...t, files: files.get(t.sha) ?? [] }));
}

// ---------------------------------------------------------------- taking one

/**
 * The tree of the worktree as it stands, written into the snapshot repo. Nothing the worker sees changes. Runs
 * under the lock: the snapshot index is the repo's own.
 */
function worktreeTree({ info, top, snap }) {
  const idx = join(snap, "index");
  const env = baseEnv({ GIT_INDEX_FILE: idx, GIT_OBJECT_DIRECTORY: join(snap, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(info.commonDir, "objects") });
  const run = (args, input) => gitSync(top, args, { env, timeout: 600_000, maxBuffer: 64 * 1024 * 1024, ...(input !== undefined ? { input, stdio: ["pipe", "pipe", "pipe"] } : {}) });
  // The worktree's index seeds the first one: its stat data spares hashing the files that did not change, and its
  // entries keep tracked files that a .gitignore rule now matches. `add -A` makes it match the files.
  // Under the lock nothing else uses this index: a lock file there is a killed run's, and would fail every take.
  try { unlinkSync(`${idx}.lock`); } catch {}
  let seeded = existsSync(idx);
  if (!seeded) { try { copyFileSync(join(info.gitDir, "index"), idx); seeded = true; } catch {} }
  else forgetIgnored(top, run);
  let add = run(["add", "-A", "--ignore-errors", "."]);
  if (add.status !== 0 && seeded) {
    // An index git cannot read on its own (a copied split index, a torn write): start from HEAD's tree instead.
    try { unlinkSync(idx); } catch {}
    run(["read-tree", "HEAD"]);
    add = run(["add", "-A", "--ignore-errors", "."]);
  }
  if (add.status !== 0 && !/error: (unable to index|open\(|short read)/.test(add.stderr)) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const w = run(["write-tree"]);
  if (w.status !== 0) throw new Error(`git write-tree failed: ${w.stderr.trim()}`);
  return w.stdout.trim();
}

/**
 * Drops from the snapshot index what a .gitignore rule now matches and the worktree's own index does not track
 * (a folder indexed before its ignore rule existed, a file `git rm --cached` took out), so the kept index never
 * holds more than a fresh copy of the worktree's would. One git call when there is nothing to drop.
 */
function forgetIgnored(top, run) {
  const ignored = run(["ls-files", "-z", "-c", "-i", "--exclude-standard"]).stdout?.split("\0").filter(Boolean) ?? [];
  if (!ignored.length) return;
  const r = gitSync(top, ["ls-files", "-z"], { env: baseEnv(), maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) return; // no read of the real index: drop nothing rather than everything
  const real = new Set(r.stdout.split("\0"));
  const drop = ignored.filter((p) => !real.has(p));
  if (drop.length) run(["update-index", "-z", "--force-remove", "--stdin"], drop.join("\0"));
}

function commitTurn(snap, n, tree, parent, fields, now) {
  const at = Math.floor(now / 1000);
  const body = [`rollcall turn ${n}`, "", ...Object.entries({ ...fields, at: now }).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}: ${v}`)].join("\n");
  const who = { GIT_AUTHOR_NAME: "rollcall", GIT_AUTHOR_EMAIL: "rollcall@localhost", GIT_COMMITTER_NAME: "rollcall", GIT_COMMITTER_EMAIL: "rollcall@localhost", GIT_AUTHOR_DATE: `${at} +0000`, GIT_COMMITTER_DATE: `${at} +0000` };
  const c = snapGit(snap, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"], { env: baseEnv(who), input: `${body}\n`, stdio: ["pipe", "pipe", "pipe"] });
  if (c.status !== 0) throw new Error(`git commit-tree failed: ${c.stderr.trim()}`);
  const sha = c.stdout.trim();
  const u = snapGit(snap, ["update-ref", `refs/turns/${n}`, sha, ""]);
  if (u.status !== 0) throw new Error(`git update-ref failed: ${u.stderr.trim()}`);
  return sha;
}

/** HEAD's tree, as the baseline when no session-start snapshot came first. */
function headTree(wt) {
  const r = gitSync(wt.top, ["rev-parse", "--verify", "-q", "HEAD^{tree}"], { env: baseEnv() });
  return r.status === 0 ? r.stdout.trim() : EMPTY_TREE(wt.snap);
}

/**
 * Records the worktree as the next turn. `kind`: "turn" (after a turn), "baseline" (turn 0, once: a session's
 * start), "before-restore" / "restored" (around a restore). A turn whose files equal the last turn's is not
 * written, so every turn in the list changed something; the answer is then the last turn's number. With no turn
 * yet, a "turn" first records HEAD's tree as turn 0, so turn 1 has something to diff against.
 * Returns { n, created, tree }.
 */
export async function takeTurn(wt, opts = {}) {
  const r = await withSnapLock(wt.snap, () => { ensureRepo(wt); return takeLocked(wt, opts); });
  // Loose objects pile up one per changed file per turn: git packs them once there are enough to matter. Outside
  // the lock, so a repack never holds up the next take (git keeps one gc at a time itself).
  if (r.created) snapGit(wt.snap, ["-c", "gc.autoDetach=false", "gc", "--auto", "--quiet"], { timeout: 600_000 });
  return r;
}

/** takeTurn's work, for a caller that holds the lock. */
function takeLocked(wt, { kind = "turn", session = null, restored = null, now = Date.now() } = {}) {
  const turns = refsOf(wt.snap);
  let last = turns.at(-1) ?? null;
  if (kind === "baseline" && last) return { n: last.n, created: false, tree: null };
  if (!last && kind !== "baseline") {
    commitTurn(wt.snap, 0, headTree(wt), null, { kind: "baseline", from: "HEAD", worktree: wt.top }, now);
    last = refsOf(wt.snap).at(-1);
  }
  const tree = worktreeTree(wt);
  if (last && last.tree === tree) return { n: last.n, created: false, tree };
  const n = last ? last.n + 1 : 0;
  commitTurn(wt.snap, n, tree, last?.sha ?? null, { kind, session, restored, worktree: wt.top }, now);
  return { n, created: true, tree };
}

// ---------------------------------------------------------------- showing and restoring

const turnOf = (wt, n) => {
  const t = refsOf(wt.snap).find((x) => x.n === n);
  if (!t) throw new Error(`no turn ${n} in this worktree (${cli()} turns)`);
  return t;
};

function patch(snap, a, b) {
  const r = snapGit(snap, ["diff", "--no-color", "--no-renames", a, b], { maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git diff failed: ${r.stderr.trim()}`);
  return r.stdout;
}

/** What turn n changed: { from, to, files, patch }. Turn 0 is the baseline and changed nothing. */
export function turnDiff(wt, n) {
  const t = turnOf(wt, n);
  const parent = snapGit(wt.snap, ["rev-parse", "-q", "--verify", `${t.sha}^`]).stdout?.trim() || null;
  if (!parent) return { from: null, to: n, files: [], patch: "" };
  return { from: n - 1, to: n, files: changes(wt.snap, parent, t.sha).map(({ status, path }) => ({ status, path })), patch: patch(wt.snap, parent, t.sha) };
}

/** What changed from turn n to the worktree now (nothing is recorded). */
export async function sinceTurn(wt, n) {
  const t = turnOf(wt, n);
  const now = await withSnapLock(wt.snap, () => worktreeTree(wt));
  return { from: n, to: "now", files: changes(wt.snap, t.sha, now).map(({ status, path }) => ({ status, path })), patch: patch(wt.snap, t.sha, now) };
}

/** Removes `path` and then each parent folder it leaves empty, up to the worktree's top. */
function removeFile(top, rel) {
  const abs = join(top, rel);
  try { rmSync(abs, { force: true }); } catch {}
  for (let dir = dirname(abs); dir.startsWith(top + sep); dir = dirname(dir)) {
    try { if (readdirSync(dir).length) break; rmdirSync(dir); } catch { break; }
  }
}

/**
 * Puts the worktree's files back to turn n: writes the files that differ, deletes the non-ignored files turn n
 * did not have. HEAD, the branch and the real index stay as they are (git status then shows the difference).
 * The state it replaces is recorded first ("before-restore"), and the result after ("restored").
 * Returns { before, after, files }: `before` is the turn that undoes it.
 */
export async function restoreTurn(wt, n, { session = null, now = Date.now() } = {}) {
  const target = turnOf(wt, n);
  // One lock span from the before-restore turn to the restored one, so no take lands between them unrecorded.
  return withSnapLock(wt.snap, () => {
    ensureRepo(wt);
    const before = takeLocked(wt, { kind: "before-restore", session, restored: n, now });
    const cur = before.tree ?? refsOf(wt.snap).find((t) => t.n === before.n).tree;
    const diff = changes(wt.snap, cur, target.sha).filter((c) => !c.gitlink);
    if (!diff.length) return { before: before.n, after: before.n, files: [] };
    for (const c of diff) if (c.status === "D") removeFile(wt.top, c.path);
    const write = diff.filter((c) => c.status !== "D").map((c) => c.path);
    if (write.length) {
      const tmp = join(wt.snap, `restore.${process.pid}.${Date.now()}.tmp`);
      const env = baseEnv({ GIT_INDEX_FILE: tmp, GIT_OBJECT_DIRECTORY: join(wt.snap, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(wt.info.commonDir, "objects") });
      try {
        const rt = gitSync(wt.top, ["read-tree", target.sha], { env });
        if (rt.status !== 0) throw new Error(`git read-tree failed: ${rt.stderr.trim()}`);
        // A path that is a folder now and a file in turn n (or the other way) goes first, so the write can land.
        for (const p of write) { try { if (statSync(join(wt.top, p)).isDirectory()) rmSync(join(wt.top, p), { recursive: true, force: true }); } catch {} }
        const co = gitSync(wt.top, ["checkout-index", "-f", "-z", "--stdin"], { env, input: write.join("\0"), stdio: ["pipe", "pipe", "pipe"], timeout: 600_000 });
        if (co.status !== 0) throw new Error(`git checkout-index failed: ${co.stderr.trim()}`);
      } finally { try { unlinkSync(tmp); } catch {} }
    }
    const after = takeLocked(wt, { kind: "restored", session, restored: n, now });
    return { before: before.n, after: after.n, files: diff.map(({ status, path }) => ({ status, path })) };
  });
}

// ---------------------------------------------------------------- pruning

/** Deletes the snapshot repo of the worktree that was at `top` (gc, once it removed that worktree). */
export function dropSnapshots(top) {
  for (const p of [snapshotPath(top), `${snapshotPath(top)}.lock`]) { try { rmSync(p, { recursive: true, force: true }); } catch {} }
}

/** Deletes snapshot repos whose worktree is gone (or is now another repo's). Returns how many went. */
export function pruneSnapshots() {
  let names = [];
  try { names = readdirSync(store.snapshotsDir()); } catch { return 0; }
  let gone = 0;
  for (const name of names) {
    // A lock folder goes with its repo, or by the day-old rule below once nothing holds it.
    if (name.endsWith(".lock") && names.includes(name.slice(0, -".lock".length))) continue;
    const snap = join(store.snapshotsDir(), name);
    const meta = readJson(join(snap, META));
    // A repo with no record yet may be one a take is creating right now: leave it a day.
    if (!meta) {
      let age = 0;
      try { age = Date.now() - statSync(snap).mtimeMs; } catch {}
      if (age < 86400_000) continue;
    } else {
      const info = existsSync(meta.worktree) ? locate(meta.worktree) : null;
      if (info && info.top === meta.worktree && !isMainCheckout(info) && info.commonDir === meta.commonDir) continue;
    }
    rmSync(snap, { recursive: true, force: true });
    gone++;
  }
  return gone;
}

// ---------------------------------------------------------------- CLI

/**
 * Is anyone else mid-turn in this worktree? The task's worker (by its window's state), or any other rollcall
 * session working here in the last two minutes that has not ended its turn. The worker itself may restore.
 */
function busyHere(wt, task, me, now = Date.now()) {
  const env = taskEnv();
  const own = task && env && env.home === task.home && env.id === task.id;
  if (task && !own) {
    const w = workerState(task, now);
    if (w?.busy) return `task ${task.id}'s worker is mid-turn`;
  }
  const key = repoKey(wt.info).key;
  const other = store.listRecords(key).find((r) => r.checkout === wt.top && r.id !== me && !r.idle && isLive(r, now) && now - (r.seen ?? 0) < 120_000
    && !(own && task.sessions?.some((s) => s.id === r.id)));
  return other ? `session ${short(other.id)} is mid-turn in this worktree` : null;
}

const STATUS = { A: "+", M: "~", D: "-", T: "~" };
function turnLine(t, now) {
  const when = t.at ? `${new Date(t.at).toISOString().slice(0, 16).replace("T", " ")} (${ago(t.at, now)})` : "";
  const who = t.session ? short(t.session) : "";
  if (t.kind === "baseline") return `  ${t.n}  ${when}  baseline`;
  const what = t.kind === "before-restore" ? `before restoring turn ${t.restored}: ` : t.kind === "restored" ? `restored to turn ${t.restored}: ` : "";
  const names = t.files.slice(0, 6).map((f) => `${STATUS[f.status] ?? f.status}${f.path}`).join(" ");
  const more = t.files.length > 6 ? ` (+${t.files.length - 6} more)` : "";
  return ["", t.n, when, who, `${what}${t.files.length} file${t.files.length === 1 ? "" : "s"}: ${names}${more}`].filter((x) => x !== "").join("  ").replace(/^/, "  ");
}

/** `rollcall turns ...`; `ctx`: the CLI's { say, fail, flag, whoAmI }. */
export async function turnsCommand(args, ctx) {
  if (args.includes("--help") || args.includes("-h")) { ctx.say(`usage:\n${USAGE}`); return 0; }
  const rest = [...args];
  const json = take(rest, "--json");
  const quiet = take(rest, "--quiet");
  const [home] = ctx.flag(rest, "--home");
  const c = { ...ctx, home };
  const sub = ["take", "diff", "since", "restore", "list"].includes(rest[0]) ? rest.shift() : "list";

  if (sub === "take") {
    const [session] = ctx.flag(rest, "--session");
    const baseline = take(rest, "--baseline");
    const wt = worktreeOf(process.cwd());
    if (!wt) { if (quiet) return 0; ctx.fail("turn snapshots are for a linked worktree (a task's), not a main checkout or a folder outside git"); }
    if (store.envFlag("ROLLCALL_SNAPSHOTS") === false) return 0;
    const r = await takeTurn(wt, { kind: baseline ? "baseline" : "turn", session: session ?? ctx.whoAmI()?.id ?? null });
    if (json) ctx.say(JSON.stringify(r));
    else if (!quiet) ctx.say(r.created ? `turn ${r.n} recorded` : `no change since turn ${r.n}`);
    return 0;
  }

  const needsN = sub !== "list";
  const n = needsN ? Number(rest.shift()) : null;
  if (needsN && !Number.isInteger(n)) ctx.fail(`usage: rollcall turns ${sub} <n> [<task>]`);
  const waitIdle = take(rest, "--wait");
  const taskArg = rest.shift();
  if (rest.length) ctx.fail(`unexpected "${rest[0]}" (rollcall turns --help)`);
  const task = taskArg ? resolveTask(taskArg, c) : null;
  if (task && !task.worktree) ctx.fail(`task ${task.id} has no worktree`);
  const wt = worktreeOf(task ? task.worktree : process.cwd());
  if (!wt) ctx.fail(task ? `task ${task.id} has no linked worktree to snapshot (${task.worktree})` : "this folder is not a linked worktree: pass a task (rollcall turns <task>)");
  const owner = task ?? taskAt(wt.top);
  const now = Date.now();

  try {
    if (sub === "list") {
      const turns = listTurns(wt.top);
      if (json) { ctx.say(JSON.stringify({ worktree: wt.top, task: owner?.id ?? null, home: owner?.home ?? null, turns }, null, 2)); return 0; }
      if (!turns.length) { ctx.say(`${P} no turns recorded yet in ${wt.top}`); return 0; }
      ctx.say([`turns of ${wt.top}${owner ? ` (task ${owner.id})` : ""}:`, ...turns.map((t) => turnLine(t, now))].join("\n"));
      return 0;
    }
    if (sub === "diff" || sub === "since") {
      const d = sub === "diff" ? turnDiff(wt, n) : await sinceTurn(wt, n);
      if (json) { ctx.say(JSON.stringify({ worktree: wt.top, task: owner?.id ?? null, ...d }, null, 2)); return 0; }
      if (!d.files.length) { ctx.say(sub === "diff" ? (n === 0 ? `turn 0 is the baseline` : `turn ${n} changed nothing`) : `no change since turn ${n}`); return 0; }
      process.stdout.write(d.patch);
      // A diff shows file contents only: a new empty file or a removed one with no lines would otherwise be silent.
      ctx.say(d.files.map((f) => `${STATUS[f.status] ?? f.status} ${f.path}`).join("\n"));
      return 0;
    }
    // restore
    const me = ctx.whoAmI()?.id ?? null;
    let busy = busyHere(wt, owner, me);
    for (const end = Date.now() + 10 * 60_000; busy && waitIdle && Date.now() < end;) { await sleep(2000); busy = busyHere(wt, owner, me); }
    if (busy) ctx.fail(`${busy}: restoring now would race its edits. Wait until its turn ends (or pass --wait).`);
    const r = await restoreTurn(wt, n, { session: me });
    if (json) { ctx.say(JSON.stringify({ worktree: wt.top, restored: n, ...r }, null, 2)); return 0; }
    if (!r.files.length) { ctx.say(`the worktree already matches turn ${n}; nothing changed`); return 0; }
    ctx.say([
      `restored ${wt.top} to turn ${n}: ${r.files.length} file${r.files.length === 1 ? "" : "s"} written or removed (HEAD, branch and index unchanged).`,
      `undo: ${cli()} turns restore ${r.before}${owner ? ` ${owner.id}` : ""}`,
    ].join("\n"));
    return 0;
  } catch (e) {
    // The CLI's own exits pass through; a git failure becomes one line.
    if (e?.constructor !== Error) throw e;
    ctx.fail(e.message);
  }
}

