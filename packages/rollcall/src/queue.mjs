// The merge queue: PRs that are ready to land, in the order they became ready. A session joins with
// `rollcall queue add` once its PR is open, pushed and green; the lander (lander.mjs, one per repo)
// lands them in trains and tells each entry's session what happened: landed, a conflict to resolve,
// a check that failed, a review thread opened after it joined, or parked for the owner. An agent never decides order and never merges.
//   q.entries[<pr>] = { pr, branch, head, session, who, checkout, task, at, state: waiting|parked, why, solo, files, carries, threadsOk }
//     threadsOk: { ids, words, at }, the open review threads the owner said to land with (queue add --owner-ok); any
//     other open thread sends it back (kind "review"; threads.mjs)
//     carries: [{ pr, branch, head }], other PRs whose unlanded commits this head holds; it lands only with or after them
//     pushed: { head, at }, the lander's own push of a merge of main (its checks count from then, even in a later train)
//     stuck: { since, where, why, told }, what has kept it from moving for a while; it stays and the lander keeps trying
//   q.bounced[<pr>] = { head, count }    what the lander sent back, for the guard and the bounce limit
//   q.joined[<pr>] = at                  when the PR first joined, bounces and re-adds included, until it lands or leaves
//   q.train = { n, prs, stage, base, at, pr, suite, log, started }    the train being landed (suite..started: its running pre-push suite)
//   q.outcomes = [{ pr, branch, session, kind: landed|conflict|failed|parked|left, at, text, sha, joined, shipIt }]
//     joined, shipIt (landed only): when it first joined, and when the owner said "ship it" on its task
//   q.times[<suite>] = [ms]              the last 5 passing runs of a pre-push suite in the lander, for its usual time
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { defaultBranch, dirtyPaths, fetchSync, gitSync, locate, mainCheckout, repoKey, resolveRef, safeName } from "./git.mjs";
import { matchScope } from "./glob.mjs";
import { pidAlive, sameProcess, spawnDetached } from "./proc.mjs";
import { BIN, P, ago, fileList, isAlive, msgLine, short, who } from "./session.mjs";
import * as store from "./store.mjs";
import { queueState, taskAt } from "./task.mjs";
import { prThreads, threadLine } from "./threads.mjs";

export const USAGE = `  rollcall queue add [--owner-ok "<their words>"]
                                         join the merge queue with this branch's PR, once it is open, pushed, green
                                         and has no open review thread; the lander lands it in turn (never gh pr
                                         merge it yourself). --owner-ok: the owner said to land it with the threads
                                         open now (their words, recorded on the task)
  rollcall queue wait [--timeout <min>]  block until this branch's entry has news (landed, a conflict to resolve, a
                                         failed check, a new review thread, parked) and print the next step; run it
                                         in the background
  rollcall queue status [--json]         the line: the train landing now (its suite's time against its usual time,
                                         its log's last line, what else runs tests on this machine), who waits, who
                                         is parked, their files, recent landings with "joined to landed" and "ship it
                                         to landed". Outside a checkout: every repo with a queue
  rollcall queue leave ["<why>"]         leave the queue without landing`;

const out = (top, args) => { const r = gitSync(top, args); return r.status === 0 ? r.stdout : ""; };
const list = (s, sep = "\n") => s.split(sep).filter(Boolean);
const poll = () => Number(process.env.ROLLCALL_WAIT_POLL_MS) || 1000;

// ---------------------------------------------------------------- GitHub (gh)

/** gh in `cwd`: { ok, out, err }. ROLLCALL_GH names another binary (the tests' fake). */
export function gh(cwd, args, { timeout = 60_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  const r = spawnSync(process.env.ROLLCALL_GH || "gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer });
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() || (r.error ? String(r.error.message) : "") };
}
const ghJson = (cwd, args) => { const r = gh(cwd, args); try { return r.ok ? JSON.parse(r.out) : null; } catch { return null; } };

const PR_FIELDS = "number,state,isDraft,headRefName,headRefOid,baseRefName,url,title,body,statusCheckRollup,mergeStateStatus";
/** A commit status (an attest's, a deploy's) rather than a workflow's check run. */
export const isStatus = (c) => c.__typename === "StatusContext" || (c.state && !c.status);

/** A PR by number, URL or branch: { pr }, or { err } saying why not. */
export function prLook(cwd, ref) {
  const r = gh(cwd, ["pr", "view", String(ref), "--json", PR_FIELDS]);
  try { return r.ok ? { pr: JSON.parse(r.out) } : { err: r.err }; } catch { return { err: `gh printed no JSON: ${store.clip(r.out, 120)}` }; }
}

/** A PR by number, URL or branch, or null. */
export const prView = (cwd, ref) => prLook(cwd, ref).pr ?? null;

/**
 * A status rollup sorted out: { pending, failed, passed } (names; failed carries { name, link }).
 * A check run counts once complete; success, neutral and skipped pass. A commit status passes on success.
 */
export function checksOf(rollup) {
  const r = { pending: [], failed: [], passed: [] };
  for (const c of Array.isArray(rollup) ? rollup : []) {
    const name = c.name ?? c.context ?? "?";
    const link = c.detailsUrl ?? c.targetUrl ?? null;
    if (isStatus(c)) {
      if (c.state === "SUCCESS") r.passed.push(name);
      else if (["FAILURE", "ERROR"].includes(c.state)) r.failed.push({ name, link });
      else r.pending.push(name);
    } else if (c.status !== "COMPLETED") r.pending.push(name);
    else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion)) r.passed.push(name);
    else r.failed.push({ name, link });
  }
  return r;
}

// ---------------------------------------------------------------- repo facts

/** The test manifest at `rev` ({} when none). */
export function manifestAt(top, rev) {
  try { return JSON.parse(out(top, ["show", `${rev}:.claude/test-manifest.json`]) || "{}") ?? {}; } catch { return {}; }
}

/** How PRs land: the manifest's release.merge, else what main's recent history shows. */
export function mergeMethod(top, m, main) {
  if (typeof m.release?.merge === "string") return m.release.merge;
  return list(out(top, ["log", "--first-parent", "-8", "--format=%s", main])).some((s) => s.startsWith("Merge pull request")) ? "merge" : "squash";
}

/** Paths `head` changed since it forked from `base`; with `specs`, only those inside them. */
export const changedFiles = (top, base, head, specs = []) => list(out(top, ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--", ...specs]), "\0");

export const isAncestor = (top, a, b) => gitSync(top, ["merge-base", "--is-ancestor", a, b]).status === 0;

/** The other open PRs whose heads `head` carries and the default branch does not: landing it lands them too. */
function carried(top, b, pr, head) {
  const open = ghJson(top, ["pr", "list", "--state", "open", "--json", "number,headRefName,headRefOid", "--limit", "200"]) ?? [];
  return open
    .filter((o) => o.number !== pr && o.headRefOid && o.headRefOid !== head && isAncestor(top, o.headRefOid, head) && !isAncestor(top, o.headRefOid, `origin/${b}`))
    .map((o) => ({ pr: o.number, branch: o.headRefName, head: o.headRefOid }));
}

/** The manifest's serial groups (`land.serial`) that a set of paths touches, by index. */
export function serialGroups(m, files) {
  const groups = Array.isArray(m.land?.serial) ? m.land.serial : [];
  return groups.map((g, i) => (Array.isArray(g?.paths) && files.some((f) => matchScope(g.paths, f)) ? i : -1)).filter((i) => i >= 0);
}

// ---------------------------------------------------------------- the guard

const SKIP = /pytest\.mark\.skip|@unittest\.skip|XCTSkip|\b(?:it|test|describe|context)\.(?:skip|todo)\(|\bx(?:it|describe|test)\(|\.only\(|\bt\.skip\(|@Disabled\b|\.skip\(\s*\)/;
const TEST_LINE = /^\s*(?:(?:async\s+)?def test_|func test|(?:it|test|describe)\(|@Test\b|assert\b|self\.assert|XCTAssert|#expect\(|expect\(|assert\.)/;
const BASELINE = ["**/__snapshots__/**", "**/__Snapshots__/**", "**/*.snap", "**/ReferenceImages*/**", "**/baselines/**"];

/** The manifest fields that decide what a check runs: changing them changes what passing means. */
const testShape = (m) => JSON.stringify({
  stacks: (Array.isArray(m.stacks) ? m.stacks : []).map((s) => [s?.name, s?.testCommand, s?.inputs, s?.check]),
  prePush: (Array.isArray(m.ci?.prePush) ? m.ci.prePush : []).map((p) => [p?.name, p?.command, p?.ship, p?.when, p?.inputs, p?.flakes, p?.rerun]),
});

/** Per file, the lines `rev` adds and removes against `base` (deleted files keep their old name). */
function patchLines(top, base, rev) {
  const files = {};
  let file = null, was = null, header = false;
  for (const l of out(top, ["diff", "-U0", "--no-renames", "--no-color", base, rev]).split("\n")) {
    if (l.startsWith("diff --git ")) { header = true; file = null; continue; }
    if (header && l.startsWith("--- ")) { was = l.slice(6); continue; }
    if (header && l.startsWith("+++ ")) { file = l === "+++ /dev/null" ? was : l.slice(6); continue; }
    if (l.startsWith("@@")) { header = false; continue; }
    if (header || !file) continue;
    const f = (files[file] ??= { added: [], removed: [] });
    if (l.startsWith("+")) f.added.push(l.slice(1));
    else if (l.startsWith("-")) f.removed.push(l.slice(1));
  }
  return files;
}

/** The items of `a` that `b` does not hold, counting repeats. */
function minus(a = [], b = []) {
  const n = new Map();
  for (const x of b) n.set(x, (n.get(x) ?? 0) + 1);
  return a.filter((x) => { const c = n.get(x) ?? 0; if (c) n.set(x, c - 1); return !c; });
}

/**
 * What a fix after a bounce did to the tests (head `from` before, `to` after): removed test lines or assertions,
 * added skips, edited workflows, changed test commands in the manifest, changed baselines, an edited known-flake list
 * (a pre-push entry's `flakes`), and the manifest's own `queue.guard` patterns ({ paths, lines }). Each hit is one
 * line; any hit parks the entry for the owner.
 * It compares the PR's own change against `main` before and after, so what main brought in with a merge of it
 * (main's own workflow edits, baselines or removed tests) is not the fix's.
 */
export function guard(top, from, to, main) {
  const base = (rev) => out(top, ["merge-base", rev, main]).trim();
  const b0 = main ? base(from) : "", b1 = main ? base(to) : "";
  const net = Boolean(b0 && b1);
  const since = net ? b1 : from; // without a common base with main, the fix is everything from..to
  const before = net ? patchLines(top, b0, from) : {}, after = patchLines(top, since, to);
  const m = manifestAt(top, to);
  const custom = [m.queue?.guard].flat().filter((g) => g && typeof g === "object");
  const flakeLists = new Set([m, manifestAt(top, from)].flatMap((x) => (Array.isArray(x.ci?.prePush) ? x.ci.prePush : []).map((p) => p?.flakes)).filter((f) => typeof f === "string"));
  const hits = [];
  // A file the PR's change touches, that changed since `from`, and whose own lines are not what they were.
  const own = new Set(list(out(top, ["diff", "--name-only", "--no-renames", since, to])));
  const same = (f) => net && after[f] && !minus(after[f].added, before[f]?.added).length && !minus(after[f].removed, before[f]?.removed).length
    && !minus(before[f]?.added, after[f].added).length && !minus(before[f]?.removed, after[f].removed).length;
  for (const f of list(out(top, ["diff", "--name-only", "--no-renames", from, to]))) {
    if (!own.has(f) || same(f)) continue;
    if (matchScope([".github/workflows/**"], f)) hits.push(`edits the CI workflow ${safeName(f)}`);
    else if (matchScope(BASELINE, f)) hits.push(`changes the baseline ${safeName(f)}`);
    else if (flakeLists.has(f)) hits.push(`changes the known-flake list ${safeName(f)}`);
    else if (custom.some((g) => Array.isArray(g.paths) && matchScope(g.paths, f))) hits.push(`changes ${safeName(f)} (queue.guard)`);
  }
  const shape = testShape(m);
  if (shape !== testShape(manifestAt(top, from)) && shape !== testShape(manifestAt(top, since))) hits.push("changes a test command or inputs in .claude/test-manifest.json");
  const lines = custom.flatMap((g) => (Array.isArray(g.lines) ? g.lines : [])).map((s) => { try { return new RegExp(s); } catch { return null; } }).filter(Boolean);
  const isTest = (s) => TEST_LINE.test(s);
  for (const [file, a] of Object.entries(after)) {
    const p = before[file] ?? { added: [], removed: [] };
    for (const text of minus(a.added, p.added)) {
      if (SKIP.test(text)) hits.push(`adds a skip in ${safeName(file)}: ${store.clip(text.trim(), 120)}`);
      else if (lines.some((re) => re.test(text))) hits.push(`adds a line queue.guard flags in ${safeName(file)}: ${store.clip(text.trim(), 120)}`);
    }
    // Test lines lost: new removals, and additions the PR made before and no longer makes.
    const lost = [...minus(a.removed, p.removed), ...minus(p.added, a.added)].filter(isTest);
    const gained = [...minus(a.added, p.added), ...minus(p.removed, a.removed)].filter(isTest).length;
    if (lost.length > gained) hits.push(`removes ${lost.length - gained} test or assertion line${lost.length - gained === 1 ? "" : "s"} in ${safeName(file)}: ${store.clip(lost[0].trim(), 120)}`);
  }
  // A test file the PR's change no longer touches, after it once added test lines there.
  for (const [file, p] of Object.entries(before)) {
    if (after[file]) continue;
    const lost = p.added.filter(isTest);
    const gained = p.removed.filter(isTest).length;
    if (lost.length > gained) hits.push(`removes ${lost.length - gained} test or assertion line${lost.length - gained === 1 ? "" : "s"} in ${safeName(file)}: ${store.clip(lost[0].trim(), 120)}`);
  }
  return hits.slice(0, 10);
}

// ---------------------------------------------------------------- outcomes

/**
 * Ends an entry's turn: `kind` is landed, conflict, failed, parked or left; `text` is what its session reads,
 * next step included. The entry leaves the queue, except a parked one, which stays for the owner to see.
 * Its session hears it (queue wait, and a [rollcall] line on its next tool call), and its task follows.
 */
export function finishEntry(key, e, kind, text, extra = {}) {
  const now = Date.now();
  const shipIt = kind === "landed" ? shipItAt(e.task, now) : null;
  store.updateQueue(key, (q) => {
    if (kind === "parked") q.entries[e.pr] = { ...(q.entries[e.pr] ?? e), state: "parked", why: text, solo: false };
    else delete q.entries[e.pr];
    if (kind === "conflict" || kind === "failed") q.bounced[e.pr] = { head: e.head, count: (q.bounced[e.pr]?.count ?? 0) + 1 };
    const times = kind === "landed" ? { joined: q.joined[e.pr] ?? e.at ?? null, shipIt } : {};
    if (kind === "landed" || kind === "left") { delete q.bounced[e.pr]; delete q.joined[e.pr]; }
    for (const [pr, at] of Object.entries(q.joined)) if (now - at > 14 * 86400_000) delete q.joined[pr]; // one that never came back
    q.outcomes.push({ pr: e.pr, branch: e.branch, session: e.session ?? null, kind, at: now, text, ...extra, ...times });
  });
  store.appendEvent(key, { type: "queue", kind, session: "merge-queue", to: e.session ?? "", pr: e.pr, branch: e.branch, text: store.oneLine(text) });
  if (kind === "landed") store.appendEvent(key, { type: "landed", session: e.session ?? "", who: e.who ?? `#${e.pr}`, branch: e.branch, pr: e.pr, sha: extra.sha ?? null });
  if (e.task) {
    const [h, id] = e.task.split(":");
    if (kind === "parked") queueState(h, id, "queue-parked", { question: `merge queue parked #${e.pr}: ${store.clip(store.oneLine(text), 300)}` });
    else if (kind === "conflict" || kind === "failed" || kind === "left" || kind === "review") queueState(h, id, "queue-sent-back", { note: `merge queue: ${kind} - ${store.clip(store.oneLine(text), 300)}` });
  }
}

/**
 * News about an entry that stays in the queue (`kind`: stuck, moving, again): its session hears it, and its task follows.
 * `line`: what the tab adds.
 */
export function entryNews(key, e, kind, text, { line = null } = {}) {
  store.appendEvent(key, { type: "queue", kind, session: "merge-queue", to: e.session ?? "", pr: e.pr, branch: e.branch, text: store.oneLine(text) });
  if (!e.task) return;
  const [h, id] = e.task.split(":");
  if (kind === "stuck") { queueState(h, id, "queue-stuck", { question: `merge queue: ${store.clip(store.oneLine(text), 300)}` }); return; }
  queueState(h, id, "queue-moving", { note: `merge queue: ${store.clip(store.oneLine(text), 300)}`, line });
}

/** When the owner last said "ship it" on task `ref` ("<home>:<id>"), before `now`: the start of "ship it to landed". */
function shipItAt(ref, now) {
  if (!ref) return null;
  const [h, id] = ref.split(":");
  const said = (store.readTask(h, id)?.words ?? []).filter((w) => w.at <= now && /\bship it\b/i.test(w.text ?? ""));
  return said.at(-1)?.at ?? null;
}

// ---------------------------------------------------------------- the lander

/** Starts the repo's lander when none runs (it exits on its own once the queue stays empty). */
export function ensureLander(key, main) {
  const l = store.readLander(key);
  if (l?.pid && sameProcess(l.pid, l.start)) return false;
  if (process.env.ROLLCALL_QUEUE_LANDER === "0") return false;
  spawnDetached(process.execPath, [BIN, "-C", main, "queue", "lander"], { cwd: main });
  return true;
}

// ---------------------------------------------------------------- CLI

/** The branch this checkout would queue, and where. */
function here(ctx) {
  const info = locate(process.cwd());
  if (!info) ctx.fail("not inside a git checkout (cd into the repo, or pass -C <dir>)");
  const repo = repoKey(info);
  const b = defaultBranch(info);
  if (!b) ctx.fail("this repo has no origin default branch to land on");
  const branch = gitSync(info.top, ["symbolic-ref", "-q", "--short", "HEAD"]).stdout?.trim();
  return { info, top: info.top, key: repo.key, name: repo.name, b, branch: branch && branch !== b ? branch : null };
}

const entryOf = (q, branch) => Object.values(q.entries).find((e) => e.branch === branch) ?? null;

export async function queueCommand(args, ctx) {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add": return add(rest, ctx);
    case "wait": return await wait(rest, ctx);
    case "status": return status(rest, ctx);
    case "leave": return leave(rest, ctx);
    case "lander": { const h = here(ctx); return await (await import("./lander.mjs")).lander(h, { once: rest.includes("--once") }); }
    case undefined: case "-h": case "--help": case "help": ctx.say(USAGE); return 0;
    default: ctx.fail(`queue: unknown command "${sub}"\n${USAGE}`);
  }
  return 1;
}

function add(args, ctx) {
  const [ownerOk] = ctx.flag(args, "--owner-ok");
  if (args.length) ctx.fail(`queue add: unknown argument "${args[0]}"`);
  if (ownerOk !== undefined && !store.oneLine(ownerOk)) ctx.fail('queue add: --owner-ok takes the owner\'s words: --owner-ok "<what they said>"');
  const h = here(ctx);
  const { top, key, b, branch } = h;
  if (!branch) ctx.fail("nothing to queue from the default branch or a detached HEAD: run it in the task worktree, on its branch");
  const dirty = dirtyPaths(top);
  if (dirty === null) ctx.fail("git status failed");
  if (dirty.length) ctx.fail(`uncommitted work (${fileList(dirty.map(safeName), 4)}): what lands is what you pushed, so commit and push it, or drop it, first`);
  fetchSync(top, b);
  gitSync(top, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeout: 30_000 });
  const head = resolveRef(h.info, "HEAD");
  const pushed = resolveRef(h.info, `refs/remotes/origin/${branch}`);
  if (pushed !== head) ctx.fail(pushed ? `HEAD (${short(head)}) is not what origin has for ${branch} (${short(pushed)}): push first` : `${branch} is not on origin: push it and open its PR first`);
  const pr = prView(top, branch);
  if (!pr) ctx.fail(`no PR for ${branch} (gh pr view found none): open one first`);
  if (pr.state !== "OPEN") ctx.fail(`#${pr.number} is ${pr.state.toLowerCase()}, not open`);
  if (pr.isDraft) ctx.fail(`#${pr.number} is a draft: mark it ready first (gh pr ready ${pr.number})`);
  if (pr.headRefOid !== head) ctx.fail(`#${pr.number}'s head is ${short(pr.headRefOid)}, not HEAD (${short(head)}): GitHub has not seen your last push yet; try again in a moment`);
  if (pr.baseRefName !== b) ctx.fail(`#${pr.number} targets ${pr.baseRefName}, not ${b}: the queue lands on ${b}. Once ${pr.baseRefName} has landed, retarget it (gh pr edit ${pr.number} --base ${b}), then queue add`);
  const c = checksOf(pr.statusCheckRollup);
  if (c.failed.length) ctx.fail(`#${pr.number} has red checks: ${c.failed.map((x) => x.name).join(", ")}. The queue takes green PRs: fix them first (/pr-create Step 5)`);
  if (c.pending.length) ctx.fail(`#${pr.number}'s checks are still running (${fileList(c.pending, 4)}): wait for them (gh pr checks ${pr.number} --watch), then queue add`);
  // Review threads: an open one lands only on the owner's word, given for exactly the threads open now.
  const th = prThreads(top, pr.number);
  if (th.err) ctx.fail(`could not read #${pr.number}'s review threads (${th.err}): try again in a moment`);
  if (th.open.length && ownerOk === undefined) {
    ctx.fail(`#${pr.number} has ${th.open.length} open review thread${th.open.length === 1 ? "" : "s"}:\n${th.open.slice(0, 10).map((x) => `  - ${threadLine(x)}`).join("\n")}\nTwo ways forward: fix or answer each and resolve the fixed ones (rollcall pr threads, rollcall pr reply, rollcall pr resolve), push, then queue add; or, if the owner says to land it as it is, rollcall queue add --owner-ok "<their words>"`);
  }
  const threadsOk = th.open.length ? { ids: th.open.map((x) => x.id), words: store.oneLine(ownerOk), at: Date.now() } : null;

  const g = ctx.whoAmI();
  const t = taskAt(top);
  const prev = store.readQueue(key);
  const was = prev.entries[pr.number];
  if (was?.state === "parked" && was.head === head) ctx.fail(`#${pr.number} is parked for the owner (${was.why}); rollcall queue leave first`);
  const carries = carried(top, b, pr.number, head);
  const behind = carries.find((x) => prev.entries[x.pr]?.state !== "waiting");
  if (behind) ctx.fail(`#${pr.number} carries #${behind.pr} (${behind.branch})'s commits, and #${behind.pr} has not landed: landing #${pr.number} would land them too. Once #${behind.pr} has landed or joined the queue (rollcall queue status shows it), run rollcall queue add again`);
  const bounced = prev.bounced[pr.number];
  const hits = bounced && bounced.head !== head ? guard(top, bounced.head, head, `origin/${b}`) : [];
  const files = changedFiles(top, `origin/${b}`, head).map(safeName);
  const now = Date.now();
  const entry = {
    pr: pr.number, branch, head, session: g?.id ?? null, who: g ? who({ id: g.id, branch, checkout: top, main: mainCheckout(h.info) }) : `#${pr.number}`,
    checkout: top, task: t ? `${t.home}:${t.id}` : null, at: now, state: "waiting", why: null, solo: false, files: files.slice(0, 50), carries, threadsOk,
  };
  if (hits.length) {
    finishEntry(key, entry, "parked", `#${pr.number} changed what its tests check after it was sent back: ${hits.join("; ")}. The owner decides whether that stands (rollcall queue leave, or fix and queue add).`);
    ctx.say(`${P} queue: #${pr.number} parked for the owner. Since it was sent back it ${hits.join("; ")}.`);
    ctx.say(`${P} queue: report it to the owner; if they accept the change, they say so and you run rollcall queue add again after a rollcall queue leave.`);
    return 2;
  }
  const res = store.updateQueue(key, (q) => {
    const was = q.entries[pr.number];
    if (was?.state === "parked" && was.head === head) return { parked: was };
    // A place is held from when the PR became ready; re-adding the same head keeps it.
    q.entries[pr.number] = { ...entry, at: was && was.head === head ? was.at : now, solo: was?.solo ?? false };
    q.joined[pr.number] ??= now;
    const order = Object.values(q.entries).filter((e) => e.state === "waiting").sort((a, x) => a.at - x.at);
    return { place: order.findIndex((e) => e.pr === pr.number) + 1, size: order.length, train: q.train };
  });
  if (!res) ctx.fail("the queue's state is busy; try again");
  if (res.out.parked) ctx.fail(`#${pr.number} is parked for the owner (${res.out.parked.why}); rollcall queue leave first`);
  const okNote = threadsOk ? ` with ${threadsOk.ids.length} open review thread${threadsOk.ids.length === 1 ? "" : "s"} on the owner's word: "${store.clip(threadsOk.words, 300)}"` : "";
  if (t) queueState(t.home, t.id, "queue-joined", { note: `merge queue: #${pr.number} joined${okNote}`, pr: pr.url ?? null });
  store.appendEvent(key, { type: "queue", kind: "added", session: g?.id ?? "user", pr: pr.number, branch, text: `#${pr.number} joined the merge queue` });
  ensureLander(key, mainCheckout(h.info));
  const { place, size, train } = res.out;
  ctx.say(`${P} queue: #${pr.number} (${branch}) joined: place ${place} of ${size}${train ? `, train ${train.n} is landing ${train.prs.map((n) => `#${n}`).join(", ")}` : ""}.`);
  ctx.say(`${P} queue: now run \`rollcall queue wait\` in the background; it exits with the next step (landed, a conflict, a failed check, or parked). Push nothing to ${branch} meanwhile: a new head takes it out of the queue.`);
  return 0;
}

async function wait(args, ctx) {
  const [mins] = ctx.flag(args, "--timeout");
  if (args.length) ctx.fail(`queue wait: unknown argument "${args[0]}"`);
  const h = here(ctx);
  if (!h.branch) ctx.fail("run it in the worktree of the branch you queued");
  const g = ctx.whoAmI();
  const start = store.readQueue(h.key);
  const mine = entryOf(start, h.branch);
  const since = mine?.at ?? 0;
  const latest = (q) => q.outcomes.filter((o) => o.branch === h.branch && o.at >= since).pop();
  if (!mine && !latest(start)) ctx.fail(`${h.branch} is not in the merge queue: rollcall queue add`);
  if (mine?.state === "parked") { ctx.say(`${P} queue: parked - ${mine.why}`); return 0; }
  const deadline = Number(mins) > 0 ? Date.now() + Number(mins) * 60_000 : Infinity;
  let cursor = store.logEnd(h.key);
  for (let tick = 0; ; tick++) {
    const q = store.readQueue(h.key);
    const o = latest(q);
    if (o) { ctx.say(`${P} queue: ${o.kind} - ${o.text}`); return 0; }
    const now = entryOf(q, h.branch);
    if (now?.state === "parked") { ctx.say(`${P} queue: parked - ${now.why}`); return 0; }
    const r = store.readEventsSince(h.key, cursor);
    cursor = r.cursor;
    const msg = g && r.events.find((e) => e.type === "msg" && e.to === g.id && e.session !== g.id);
    if (msg) { ctx.say(msgLine(msg, " while you waited")); ctx.say(`${P} still in the merge queue: run rollcall queue wait again to keep waiting.`); return 0; }
    // The wait doubles as the lander's watchdog: a lander that died with entries waiting is started again.
    if (tick % 30 === 0 && Object.values(q.entries).some((e) => e.state === "waiting")) ensureLander(h.key, mainCheckout(h.info));
    if (g?.pid && !pidAlive(g.pid, g.pidStart)) return 3;
    if (Date.now() > deadline) { ctx.say(`${P} stopped waiting after ${mins} min; ${h.branch} is still in the queue.`); return 124; }
    await sleep(poll());
  }
}

/** A repo known only by its store key (no checkout: no branch, so no "touches your files"). */
const byKey = (key) => ({ key, name: key.replace(/-[0-9a-f]{12}$/, ""), top: null, b: null, branch: null });

/** Every repo whose queue has anything to show: entries, a train, a lander, or a landing in the last day. */
function queuedRepos(now) {
  return store.listRepoKeys().map(byKey).filter(({ key }) => {
    const q = store.readQueue(key);
    const l = store.readLander(key);
    return Object.keys(q.entries).length || q.train || (l?.pid && sameProcess(l.pid, l.start)) || q.outcomes.some((o) => now - o.at < 86400_000);
  });
}

const median = (xs) => (xs?.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
export const span = (ms) => { const m = Math.round(ms / 60_000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`; };

/** The last line of a log and when it was written, or null. */
function lastLine(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const { size, mtimeMs } = fstatSync(fd);
    const buf = Buffer.alloc(Math.min(size, 4096));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    const text = buf.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "").split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).pop();
    return text ? { text: safeName(text), at: mtimeMs } : null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

/** A pre-push command as ps shows it running: its words up to the first placeholder, quote or variable (two at least). */
function commandWords(cmd) {
  const w = [];
  for (const x of String(cmd ?? "").trim().split(/\s+/)) { if (/[<>=|&;"'$`(]/.test(x)) break; w.push(x); }
  return w.length >= 2 ? w.join(" ") : null;
}

const etime = (s) => { const [d, hms] = s.includes("-") ? s.split("-") : [0, s]; return Number(d) * 86400 + hms.split(":").reduce((a, x) => a * 60 + Number(x), 0); };

/**
 * What else runs tests on this machine, from one ps: GitHub Actions runner jobs, and each repo's pre-push
 * commands that its lander did not start, with the session that started each. Null when ps fails.
 * ROLLCALL_PS names another ps (tests).
 */
function otherRuns(repos) {
  const r = spawnSync(process.env.ROLLCALL_PS || "ps", ["-Ao", "pid=,ppid=,etime=,command="], { encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) return null;
  const procs = (r.stdout ?? "").split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+([\d:-]+)\s+(.+)$/.exec(l)).filter(Boolean)
    .map(([, pid, ppid, t, cmd]) => ({ pid: Number(pid), ppid: Number(ppid), secs: etime(t), cmd: cmd.replace(/^\S*\//, "") }));
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const above = (p) => { const up = []; for (let pid = p.ppid; pid > 1 && up.length < 40; pid = byPid.get(pid)?.ppid ?? 0) up.push(pid); return up; };
  const runs = procs.filter((p) => /^Runner\.Worker\b/.test(p.cmd)).map((p) => ({ what: "a GitHub Actions runner job", secs: p.secs }));
  for (const repo of repos) {
    const m = repo.top ? manifestAt(repo.top, `origin/${repo.b}`) : manifestAt(store.queueTree(repo.key), "HEAD");
    const cmds = (Array.isArray(m.ci?.prePush) ? m.ci.prePush : []).map((x) => commandWords(x?.command)).filter(Boolean);
    if (!cmds.length) continue;
    const is = (p) => p && cmds.find((c) => p.cmd === c || p.cmd.startsWith(`${c} `));
    const lander = store.readLander(repo.key)?.pid;
    const sessions = store.listRecords(repo.key).filter(isAlive);
    for (const p of procs) {
      const c = is(p);
      const up = c ? above(p) : [];
      if (!c || up.some((pid) => pid === lander || is(byPid.get(pid)))) continue; // the train's own run, or the inside of one
      const s = sessions.find((x) => up.includes(x.pid));
      runs.push({ what: `${repo.name}'s ${c}`, by: s ? `${short(s.id)}, ${s.branch ?? "detached"}` : null, secs: p.secs });
    }
  }
  return runs;
}

/** One repo's queue as status shows it. */
function view(r) {
  const q = store.readQueue(r.key);
  const lander = store.readLander(r.key);
  const waiting = Object.values(q.entries).filter((e) => e.state === "waiting").sort((a, b) => a.at - b.at);
  // Who touches what this checkout changes: a ship reads it to expect a conflict.
  const mine = r.branch ? changedFiles(r.top, `origin/${r.b}`, "HEAD") : [];
  const shared = (e) => (e.branch === r.branch ? [] : (e.files ?? []).filter((f) => mine.includes(f)));
  const t = q.train;
  return {
    repo: r.name, lander: lander?.pid && sameProcess(lander.pid, lander.start) ? lander : null,
    train: t && { ...t, ...(t.started ? { usual: median(q.times[t.suite]), last: lastLine(t.log) } : {}) },
    waiting: waiting.map((e) => ({ ...e, shared: shared(e) })), parked: Object.values(q.entries).filter((e) => e.state === "parked"),
    recent: q.outcomes.slice(-10),
  };
}

function status(args, ctx) {
  const json = args.includes("--json");
  const extra = args.find((a) => a !== "--json");
  if (extra) ctx.fail(`queue status: unknown argument "${extra}" (another repo's queue: rollcall -C <dir> queue status)`);
  const now = Date.now();
  const repos = locate(process.cwd()) ? [here(ctx)] : queuedRepos(now);
  const views = repos.map(view);
  // Only beside a train's running suite does it matter what else runs (one ps costs seconds on a loaded Mac).
  const others = views.some((v) => v.train?.started) ? otherRuns(repos) : undefined;
  if (json) {
    ctx.say(JSON.stringify(views.length === 1 ? { ...views[0], others } : { repos: views, others }, null, 2));
    return 0;
  }
  if (!views.length) ctx.say(`${P} no repo has a merge queue now (nothing waiting, landing or landed in the last day)`);
  for (const v of views) {
    const t = v.train;
    ctx.say(`${P} merge queue for ${v.repo}: ${v.waiting.length} waiting${v.parked.length ? `, ${v.parked.length} parked` : ""}${t ? `, train ${t.n} landing` : ""}; ${v.lander ? `lander running (pid ${v.lander.pid}, since ${ago(v.lander.at, now)})` : "no lander running"}`);
    if (t) {
      const suite = t.started ? `, ${span(now - t.started)} so far${t.usual ? ` (usual ${span(t.usual)})` : ""}${t.last ? `; its log, ${ago(t.last.at, now)}: ${t.last.text}` : ""}` : "";
      ctx.say(`  train ${t.n}: ${t.prs.map((n) => `#${n}`).join(", ")} - ${t.stage}${suite} (train started ${ago(t.at, now)})`);
    }
    v.waiting.forEach((e, i) => {
      ctx.say(`  ${i + 1}. #${e.pr} ${e.branch}${e.solo ? " (alone)" : ""}, ready ${ago(e.at, now)}: ${e.files?.length ? fileList(e.files, 5) : "no files"}${e.shared.length ? `  <- touches your files: ${fileList(e.shared, 4)}` : ""}${e.stuck ? `  <- stuck since ${ago(e.stuck.since, now)}: ${store.clip(e.stuck.why, 120)}` : ""}${e.blocked ? `  <- sits out until GitHub ${e.blocked} clears` : ""}`);
    });
    for (const e of v.parked) ctx.say(`  parked: #${e.pr} ${e.branch} - ${store.clip(e.why ?? "", 300)}`);
    for (const o of v.recent.slice(-5)) {
      const took = o.kind === "landed" ? [o.joined && `${span(o.at - o.joined)} after it joined`, o.shipIt && `${span(o.at - o.shipIt)} after "ship it"`].filter(Boolean) : [];
      ctx.say(`  ${ago(o.at, now)}: #${o.pr} ${o.kind}${o.sha ? ` (${short(o.sha)})` : ""}${took.length ? `, ${took.join(", ")}` : ""}`);
    }
  }
  if (others === null) ctx.say(`${P} ps failed, so what else runs on this machine is unknown`);
  else if (others) {
    const runs = others.map((x) => `${x.what} for ${span(x.secs * 1000)}${x.by ? ` (${x.by})` : ""}`);
    ctx.say(`${P} beside the train's suite on this machine: ${runs.length ? runs.join(", ") : "no other pre-push suite and no Actions runner job"}`);
  }
  return 0;
}

function leave(args, ctx) {
  const h = here(ctx);
  if (!h.branch) ctx.fail("run it in the worktree of the branch you queued");
  const why = store.oneLine(args.join(" ")) || "its session left the queue";
  const e = entryOf(store.readQueue(h.key), h.branch);
  if (!e) { ctx.say(`${P} queue: ${h.branch} is not in the merge queue`); return 0; }
  finishEntry(h.key, e, "left", `#${e.pr} left the merge queue: ${why}`);
  ctx.say(`${P} queue: #${e.pr} left the merge queue${store.readQueue(h.key).train?.prs.includes(e.pr) ? "; the train it was in forms again without it" : ""}`);
  return 0;
}
