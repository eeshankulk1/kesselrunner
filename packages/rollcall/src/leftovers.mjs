// What ended work leaves behind on this Mac, outside any repo. gc removes what surely belongs to nothing any more:
// Xcode's DerivedData for a project that is gone (a removed worktree's), the temp folders of sessions over for a day,
// the folders an App Store upload leaves in the temp directory once a day old, and test browsers whose session ended,
// with their profiles. On a low disk, and when `rollcall clean` runs, what is only rebuildable goes without asking
// (DerivedData still in reach of a checkout, Xcode's shared cache, a recent session's temp folder, package managers'
// download caches); what is not rebuildable is listed and goes only on the owner's word. It never reaches into a checkout, and what an open task or a running session uses stays. Only the
// machine's own store reaches the machine's folders: any other (a test's, a sandbox's) knows none of the sessions out
// there, so every one would read as over.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, sep } from "node:path";
import { dropWorktree, sizesKb } from "./gc.mjs";
import { isAlive } from "./session.mjs";
import { isOpen } from "./state.mjs";
import * as store from "./store.mjs";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// A temp folder of an ended session is listed for the owner's yes only after this long quiet: a task can run for hours,
// and a helper session rollcall has no record of may still be writing to it. Past a day, gc's sweep takes it.
const TEMP_QUIET = 6 * HOUR;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A browser younger than this may still be finding its feet: its parent can be between processes.
const BROWSER_MIN_AGE_S = 600;
const TEST_BROWSER = /Chrome for Testing|chrome-headless-shell|Chromium\.app|\/ms-playwright\//;
const TEST_PROFILE = /^(playwright[_-]|puppeteer_dev|.*-browser-tests-)/;
// A profile a test tool made. One anywhere else may be a browser someone opened by hand.
// What an App Store upload (xcodebuild -exportArchive, altool) leaves in the temp directory, a few hundred MB each.
const UPLOAD = /^XcodeDistPipeline\./;
const TEST_DATA_DIR = / --user-data-dir=\S*(\/tmp\/|\/var\/folders\/|\/ms-playwright\/|playwright|puppeteer|-browser-tests-)/;
const BUILDING = /\b(xcodebuild|swift-build|swift-frontend|XCBBuildService)\b/;
// A package install under way reads its cache: none is cleared while one runs.
const INSTALLING = /\b(npm|pnpm|yarn|bun) (install|i|ci|add|update)\b|\bpip3? install\b|\buv (sync|add|pip|lock|run)\b|\bpod install\b/;

const ls = (dir) => { try { return readdirSync(dir); } catch { return []; } };
const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const ownStore = () => store.home() === join(userInfo().homedir, ".rollcall");
const machine = (fake, path) => process.env[fake] || (ownStore() ? path : null);
const derivedRoot = () => machine("ROLLCALL_DERIVED_DATA", join(homedir(), "Library", "Developer", "Xcode", "DerivedData"));
const tempRoot = () => real(machine("ROLLCALL_CLAUDE_TMP", `/tmp/claude-${process.getuid?.() ?? 0}`));
const profileRoot = () => real(machine("ROLLCALL_BROWSER_TMP", tmpdir()));
/** Package managers' download caches: each fills again on the next install. ROLLCALL_PACKAGE_CACHES (":"-separated) stands in. */
const packageCaches = () => {
  if (process.env.ROLLCALL_PACKAGE_CACHES) return process.env.ROLLCALL_PACKAGE_CACHES.split(":").filter(Boolean);
  if (!ownStore()) return [];
  const h = homedir();
  return [join(h, ".npm", "_cacache"), join(h, "Library", "Caches", "pnpm"), join(h, "Library", "Caches", "Yarn"), join(h, "Library", "Caches", "pip"), join(h, ".cache", "uv"), join(h, "Library", "Caches", "CocoaPods")];
};
/** Every process, or null when ps failed: then what runs is unknown, which is not the same as nothing running. */
function psOutput() {
  if (process.env.ROLLCALL_PS_FILE) return readFileSync(process.env.ROLLCALL_PS_FILE, "utf8").trim() || null;
  if (!ownStore()) return null;
  const r = spawnSync("ps", ["-axo", "pid=,ppid=,etime=,command="], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 && r.stdout?.trim() ? r.stdout : null;
}

/** What open tasks and running sessions use: their folders, and the session ids they may come back to. */
function inUse() {
  const tasks = store.listTasks().filter(isOpen);
  const homes = store.listHomes();
  const alive = store.listRepoKeys().flatMap((k) => store.listRecords(k)).filter(isAlive);
  return {
    folders: [...tasks.map((t) => t.worktree), ...alive.map((r) => r.checkout)].filter(Boolean).map(real),
    sessions: new Set([
      ...tasks.flatMap((t) => (t.sessions ?? []).map((s) => s.id)),
      ...store.listGlobals().filter(isAlive).map((g) => g.id),
      // A parked supervisor resumes its session, and `falcon continue` a closed one's.
      ...homes.flatMap((h) => ["parked", "lock", "falcon"].map((f) => store.readHomeFile(h, f)?.session)).filter(Boolean),
    ]),
  };
}

const within = (p, dir) => p === dir || p.startsWith(dir + sep);

/** DerivedData's project folders: [{ path, workspace (the project it builds, or null), touched }]; its shared caches have no project. */
function derivedFolders() {
  return ls(derivedRoot()).map((name) => {
    const path = join(derivedRoot(), name);
    const plist = join(path, "info.plist");
    let text = "";
    try { text = readFileSync(plist, "utf8"); } catch { return null; }
    const workspace = /<key>WorkspacePath<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1]?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") ?? null;
    return { path, workspace, touched: mtime(plist) };
  }).filter(Boolean);
}

const missing = (p) => { try { statSync(p); return false; } catch (e) { return e.code === "ENOENT"; } };

/** Whether a build folder's project is gone. An external volume that is not mounted is not gone, and nor is a path stat may not read. */
const projectGone = (d) => !!d.workspace && missing(d.workspace) && !d.workspace.startsWith("/Volumes/");

/** Temp folders of sessions no one can come back to: [{ path, touched }]. Its newest direct entry dates a folder. */
function endedTemp(used) {
  const out = [];
  for (const project of ls(tempRoot())) {
    const dir = join(tempRoot(), project);
    for (const id of ls(dir)) {
      if (!UUID.test(id) || used.sessions.has(id)) continue;
      const path = join(dir, id);
      out.push({ path, touched: Math.max(mtime(path), ...ls(path).map((n) => mtime(join(path, n)))) });
    }
  }
  return out;
}

/** The pids of test browsers whose session ended: a main browser process launchd adopted, long enough ago. */
function orphanBrowsers(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || m[2] !== "1" || !TEST_BROWSER.test(m[4]) || / --type=/.test(m[4]) || !TEST_DATA_DIR.test(m[4])) continue;
    if (seconds(m[3]) >= BROWSER_MIN_AGE_S) out.push(Number(m[1]));
  }
  return out;
}

/** ps's etime ("[[dd-]hh:]mm:ss") in seconds. */
function seconds(etime) {
  const [d, rest] = etime.includes("-") ? etime.split("-") : ["0", etime];
  return rest.split(":").map(Number).reduce((s, x) => s * 60 + x, 0) + Number(d) * 86400;
}

/** Test browser profile folders over a day old that no running process names. */
function deadProfiles(now, text) {
  // By name: ps prints /var/folders where the real path says /private/var/folders.
  return ls(profileRoot()).filter((n) => TEST_PROFILE.test(n) && now - mtime(join(profileRoot(), n)) > DAY && !text.includes(n)).map((n) => join(profileRoot(), n));
}

const remove = (p) => { try { rmSync(p, { recursive: true, force: true }); return true; } catch { return false; } };

/** Upload folders over a day old: an upload takes minutes, so one that old is over. */
const oldUploads = (now) => ls(profileRoot()).filter((n) => UPLOAD.test(n) && now - mtime(join(profileRoot(), n)) > DAY).map((n) => join(profileRoot(), n));

/** Everything the sweep would take now: { derived, temp, uploads, profiles (paths), browsers (pids) }. */
function sweepList(now) {
  const used = inUse();
  const ps = psOutput();
  return {
    derived: derivedFolders().filter(projectGone).map((d) => d.path),
    temp: endedTemp(used).filter((t) => now - t.touched > DAY).map((t) => t.path),
    uploads: oldUploads(now),
    profiles: ps ? deadProfiles(now, ps) : [],
    browsers: ps ? orphanBrowsers(ps) : [],
  };
}

const gb = (kb) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(kb / 1024))} MB`);

/**
 * Removes what ended work left behind. Returns { kb, line }: what it freed, and one line for the report, null when
 * it took nothing. `dryRun` takes nothing and says what it would.
 */
export function sweepLeftovers({ dryRun = false, now = Date.now() } = {}) {
  const l = sweepList(now);
  const paths = [...l.derived, ...l.temp, ...l.uploads, ...l.profiles];
  // Before the sizes, which can take a while: these pids are only as good as the ps they came from.
  if (!dryRun) for (const pid of l.browsers) { try { process.kill(pid, "SIGTERM"); } catch {} }
  const sizes = sizesKb(paths);
  const kb = [...sizes.values()].reduce((s, x) => s + x, 0);
  if (!dryRun) {
    for (const p of paths) remove(p);
    for (const project of ls(tempRoot())) {
      const dir = join(tempRoot(), project);
      if (statSafe(dir)?.isDirectory() && !ls(dir).length && now - mtime(dir) > DAY) { try { rmdirSync(dir); } catch {} }
    }
  }
  const says = [
    [l.derived.length, "DerivedData folder"], [l.temp.length, "temp folder"], [l.uploads.length, "upload folder"], [l.profiles.length, "browser profile"], [l.browsers.length, "test browser"],
  ].filter(([n]) => n).map(([n, what]) => `${n} ${what}${n === 1 ? "" : "s"}`);
  if (!says.length) return { kb: 0, line: null };
  return { kb, line: `${dryRun ? "would remove" : "removed"} leftovers of ended work: ${says.join(", ")}${kb ? ` (${gb(kb)})` : ""}` };
}

const statSafe = (p) => { try { return statSync(p); } catch { return null; } };

/**
 * What only rebuilds itself and goes without asking, on a low disk and when `rollcall clean` runs: [{ path, kb, why }],
 * biggest first. While no build runs (a failed ps may hide one): build folders of projects that still exist (not those
 * of open work or a running session, one built in the last hour, or the lander's own) and Xcode's shared caches. While
 * no package install runs: package managers' download caches. A recent session's temp folder is not here: it holds
 * scratch files and task output, so it waits for the owner's yes (deleteList).
 */
export function rebuildableList(now = Date.now()) {
  const used = inUse();
  const mine = real(store.home());
  const ps = psOutput();
  const rows = [];
  if (ps && !BUILDING.test(ps)) {
    for (const d of derivedFolders()) {
      if (!d.workspace || projectGone(d) || now - d.touched < HOUR) continue;
      const w = real(d.workspace);
      if (within(w, mine) || used.folders.some((f) => within(w, f))) continue;
      rows.push({ path: d.path, why: `Xcode build folder of ${d.workspace}: the next build there makes it again` });
    }
    for (const n of ls(derivedRoot()).filter((x) => x.endsWith(".noindex"))) rows.push({ path: join(derivedRoot(), n), why: "Xcode's shared build cache: the next build makes it again" });
  }
  if (ps && !INSTALLING.test(ps)) for (const p of packageCaches().filter((x) => statSafe(x))) rows.push({ path: p, why: "a package manager's download cache: the next install fills it again" });
  const sizes = sizesKb(rows.map((r) => r.path));
  return rows.map((r) => ({ ...r, kb: sizes.get(r.path) ?? 0 })).sort((a, b) => b.kb - a.kb);
}

/** Temp folders of sessions over for less than a day and quiet for TEMP_QUIET: [{ path, touched }]. */
const recentTemp = (now) => endedTemp(inUse()).filter((t) => now - t.touched <= DAY && now - t.touched > TEMP_QUIET);

/** Clears what rebuildableList names. Returns { kb, items } of what went (with `dryRun`, what would). */
export function clearRebuildable({ dryRun = false, now = Date.now() } = {}) {
  const items = rebuildableList(now).filter((x) => dryRun || remove(x.path));
  return { kb: items.reduce((s, x) => s + x.kb, 0), items };
}

/**
 * What goes only on the owner's word: [{ path, kb, why, main (a worktree's repo) }], biggest first. `worktrees`:
 * worktrees whose work never landed and that no one touched for two weeks (gc.mjs unlandedWorktrees, for every repo);
 * removing one loses its uncommitted changes, and its branch stays. Then temp folders of sessions over for less than a
 * day and quiet for six hours (scratch files, task output); past a day gc's sweep takes them.
 */
export function deleteList(worktrees = [], now = Date.now()) {
  const rows = [
    ...worktrees.map((w) => ({
      path: w.path, main: w.main,
      why: `worktree${w.branch ? ` of ${w.branch}` : ""} whose work never landed, untouched ${Math.floor((now - w.touched) / DAY)} days: ${w.lost}; its branch stays`,
    })),
    ...recentTemp(now).map((t) => ({ path: t.path, why: `temp folder of a session that ended, quiet ${Math.floor((now - t.touched) / HOUR)} hours: its scratch files and task output` })),
  ];
  const sizes = sizesKb(rows.map((r) => r.path));
  return rows.map((r) => ({ ...r, kb: sizes.get(r.path) ?? 0 })).sort((a, b) => b.kb - a.kb);
}

const listText = (items) => {
  const total = items.reduce((s, x) => s + x.kb, 0);
  return [
    `rollcall clean --yes deletes these ${items.length} (${gb(total)}). None comes back by itself: a worktree loses what is not committed (its branch stays), a temp folder its session's files. Nothing goes until you say so.`,
    "", ...items.map((x) => `${gb(x.kb).padStart(9)}  ${x.path}\n           ${x.why}`), "",
  ].join("\n");
};

/**
 * Builds and saves the delete list; `shown`: the caller prints it to the owner. A list the watcher builds keeps the
 * owner's last sight of the list before it when it names nothing that one did not (the watcher's run can end after the
 * owner looked). Returns { items, total (its size in words) }.
 */
export function saveDeleteList({ shown = false, now = Date.now(), worktrees = [] } = {}) {
  const items = deleteList(worktrees, now);
  const before = store.readCleanList();
  const seenBefore = !shown && now - before.shown < DAY && items.every((x) => before.items.some((b) => b.path === x.path));
  store.writeCleanList(items, listText(items), shown ? now : seenBefore ? before.shown : 0);
  return { items, total: gb(items.reduce((s, x) => s + x.kb, 0)) };
}

/** Whether the owner saw the saved list in the last day. A list the watcher wrote and only counted to them is not seen. */
export const deleteListSeen = (now = Date.now()) => now - store.readCleanList().shown < DAY;

/** Deletes what the saved list names and is still free to go (the list may be old; `worktrees` is now's). Returns what went. */
export function deleteListed(worktrees = [], now = Date.now()) {
  const safe = new Map(worktrees.map((w) => [w.path, w.main]));
  const temps = new Set(recentTemp(now).map((t) => t.path));
  return store.readCleanList().items.filter((x) => (safe.has(x.path) ? !dropWorktree(safe.get(x.path), x.path) : temps.has(x.path) && remove(x.path)));
}

/** The size of `kb` in words. */
export const sizeOf = gb;
