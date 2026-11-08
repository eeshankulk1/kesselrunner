// The lander: one per repo, a script and never an agent. A waiting entry green on its own head that merges
// cleanly lands as it is (greenWay); the default branch's own checks after the merge are the safety net. The
// rest, and every entry where the manifest sets land.retest, land in trains: up to 4 PRs merged onto origin's
// default branch in the order they became ready, checked once as one tree, and merged as that tree, so what
// lands is what passed. A train of one merges the entry's
// own PR. A conflict, a red check, a guard hit or a new review thread goes back to the entry's session (queue.mjs finishEntry).
// What may clear by itself (GitHub down, git's sign-in) never ends an entry: it stays and retries, and past
// ROLLCALL_QUEUE_STUCK_MS its task hears why, once.
// `queue add` starts it; it exits once the queue has stayed empty for a while (ROLLCALL_LANDER_IDLE_MS).
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fetchSync, gitSync, mainCheckout, mergeConflicts, resolveRef, safeName } from "./git.mjs";
import { matchScope } from "./glob.mjs";
import { checkOf, keyOf, passOf, pathspecs, recordPass } from "./results.mjs";
import { changedFiles, checksOf, entryNews, finishEntry, gh, isAncestor, isStatus, manifestAt, mergeMethod, prLook, prView, serialGroups, span } from "./queue.mjs";
import { fileList, short } from "./session.mjs";
import * as store from "./store.mjs";
import { prThreads, threadLine } from "./threads.mjs";
import { look, openBlocker, openBlockers } from "./trouble.mjs";

const ms = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : dflt; };
const IDLE_MS = () => ms("ROLLCALL_LANDER_IDLE_MS", 120_000);
const POLL_MS = () => ms("ROLLCALL_QUEUE_POLL_MS", 20_000);
const CI_MS = () => ms("ROLLCALL_QUEUE_CI_MINUTES", 60) * 60_000;
/** With no check run at all this long after a push, the PR has no checks to wait for. */
const NO_CHECKS_MS = () => ms("ROLLCALL_QUEUE_NO_CHECKS_MS", 180_000);
/** How long after a push GitHub may still be making the workflows' check runs (60 s by default). */
const SETTLE_MS = () => NO_CHECKS_MS() / 3;
const MAX_TRAIN = () => ms("ROLLCALL_TRAIN_MAX", 4);
/**
 * How long the settle loop trusts its last look at a waiting PR's review threads. Rounds that land nothing come
 * every few seconds; a GraphQL call per entry each time would spend GitHub's hourly budget beside gh pr view's.
 * The look right before a merge is always fresh.
 */
const THREADS_MS = () => ms("ROLLCALL_QUEUE_THREADS_MS", 60_000);
/** How long an entry may fail to move, the same way each round, before its task hears. */
const STUCK_MS = () => ms("ROLLCALL_QUEUE_STUCK_MS", 10 * 60_000);
/** No command runs longer than this. */
const RUN_MS = 3 * 3600_000;
/**
 * A pre-push suite with nothing written this long, to its log or anywhere in the tree, is dead. A log alone cannot
 * say: one iOS project's holds one line for a whole 40-minute demo run. A healthy run there left 17 minutes between writes to its results.
 */
const QUIET_MS = () => ms("ROLLCALL_QUEUE_QUIET_MS", 30 * 60_000);
/**
 * The least a suite gets before its time counts against it. Times swing with the load and with how many suites a
 * run skips: over 48 runs of one project, twice the median of the last 5 would have ended 7 runs that passed, twice their longest 2.
 */
const SUITE_MIN_MS = () => ms("ROLLCALL_QUEUE_SUITE_MIN_MS", 90 * 60_000);
const suiteLimit = (times = []) => Math.min(RUN_MS, Math.max(SUITE_MIN_MS(), 2 * Math.max(0, ...times)));
/** A third bounce parks the entry for the owner instead. */
const MAX_BOUNCES = 2;

const list = (s, sep = "\n") => s.split(sep).filter(Boolean);
const prs = (es) => es.map((e) => `#${e.pr}`).join(", ");
const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

let mergirafOk;
/** Mergiraf's syntax-aware resolution of one conflicted file, in place. True when it left no conflict. */
function mergiraf(dir, file) {
  mergirafOk ??= spawnSync("mergiraf", ["--version"], { stdio: "ignore" }).status === 0;
  return mergirafOk && spawnSync("mergiraf", ["solve", "--keep-backup=false", file], { cwd: dir, stdio: "ignore", timeout: 60_000 }).status === 0;
}

/** Runs the lander for repo `h` (queue.mjs `here`) until the queue stays empty; `once`: until a round does nothing. */
export async function lander(h, { once = false } = {}) {
  const { key } = h;
  if (!store.claimLander(key, process.pid)) return 0;
  const c = { ...h, main: mainCheckout(h.info), log: (s) => store.appendLanderLog(key, s) };
  c.log(`lander ${process.pid} started`);
  store.updateQueue(key, (q) => { q.train = null; }); // a lander that died mid-train left it behind
  let idle = Date.now();
  try {
    for (;;) {
      store.claimLander(key, process.pid);
      let did = false;
      try { did = await round(c); } catch (e) { c.log(`round failed: ${e?.stack ?? e}`); }
      if (did) idle = Date.now();
      // Rounds that do nothing with entries waiting are a failure to get through, not an empty queue.
      else if (once || (Date.now() - idle > IDLE_MS() && !Object.values(store.readQueue(key).entries).some((e) => e.state === "waiting"))) break;
      else await sleep(Math.min(POLL_MS(), 5000));
    }
  } finally {
    store.updateQueue(key, (q) => { q.train = null; });
    store.releaseLander(key, process.pid);
    c.log(`lander ${process.pid} stopped`);
  }
  return 0;
}

/** One train, start to end. True when anything changed (an entry settled, bounced, parked or landed). */
async function round(c) {
  const { key, main, b } = c;
  unblock(c);
  const inLine = Object.values(store.readQueue(key).entries).filter((e) => e.state === "waiting").sort((a, x) => a.at - x.at);
  // An entry GitHub refused over billing keeps its place and sits out until the blocker closes.
  const waiting = inLine.filter((e) => !e.blocked);
  if (!waiting.length) return false;
  fetchSync(main, b);
  const base = resolveRef(c.info, `refs/remotes/origin/${b}`);
  if (!base) { trouble(c, waiting, `there is no origin/${b} to land on`); return false; }
  const m = manifestAt(main, base);
  const method = mergeMethod(main, m, base);

  // Settle: entries merged or closed by hand, or pushed to since they joined, leave.
  let settled = false;
  const ready = [];
  for (const e of waiting) {
    const { pr, err } = prLook(main, e.pr);
    if (!pr) { trouble(c, [e], `gh pr view failed: ${err}`, "settle"); continue; }
    if (pr.state !== "OPEN" || pr.headRefOid !== e.head) clear(c, [e]);
    if (pr.state === "MERGED") { finishEntry(key, e, "landed", `#${e.pr} was merged outside the queue.`); settled = true; continue; }
    if (pr.state === "CLOSED") { finishEntry(key, e, "left", `#${e.pr} was closed, so it left the merge queue.`); settled = true; continue; }
    if (pr.headRefOid !== e.head) {
      finishEntry(key, e, "left", `#${e.pr} gained a new head (${short(pr.headRefOid)}) after it joined, so it left the merge queue: once its checks are green, run rollcall queue add again.`);
      settled = true;
      continue;
    }
    const got = gitSync(main, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${e.branch}:refs/rollcall/queue/${e.pr}`], { timeout: 60_000 });
    if (resolveRef(c.info, `refs/rollcall/queue/${e.pr}`) !== e.head) { trouble(c, [e], `git could not fetch ${short(e.head)}: ${(got.stderr ?? "").trim()}`, "settle"); continue; }
    // A review thread opened since it joined sends it back to its worker.
    const rv = reviewBack(c, e, { maxAge: THREADS_MS() });
    if (rv.err) { trouble(c, [e], `could not read #${e.pr}'s review threads: ${rv.err}`, "settle"); continue; }
    if (rv.back) { settled = true; continue; }
    clear(c, [e], "settle");
    // Another PR whose commits it carries: landed (in main, or merged by squash), still waiting ahead, or gone.
    const need = (e.carries ?? []).filter((x) => !isAncestor(main, x.head, base) && prView(main, x.pr)?.state !== "MERGED");
    const gone = need.find((x) => !inLine.some((w) => w.pr === x.pr) || store.readQueue(key).entries[x.pr]?.state !== "waiting");
    if (gone) {
      finishEntry(key, e, "left", `#${e.pr} carries #${gone.pr} (${gone.branch})'s commits, and #${gone.pr} left the merge queue without landing, so #${e.pr} left too. Once #${gone.pr} has landed or joined again, run rollcall queue add.`);
      settled = true;
      continue;
    }
    ready.push({ ...e, body: pr.body ?? "", need: need.map((x) => x.pr), rollup: pr.statusCheckRollup, mergeState: pr.mergeStateStatus });
  }
  if (!ready.length) return settled;

  // Green lands now: an entry green on its own head that merges cleanly lands as it is, one per round, with no
  // tree built or tested here. The default branch's own checks after the merge test it with everything else.
  // Only what may clash although git merges it (land.serial), what GitHub will not merge as it is, and a
  // project that asks for it (land.retest) go through a train.
  if (!m.land?.retest) {
    const trains = [];
    for (const e of ready) {
      const how = greenWay(c, m, base, e);
      if (how === "land") return (await landGreen(c, e, method, base)) || settled;
      if (how === "train") trains.push(e);
    }
    ready.splice(0, ready.length, ...trains);
    if (!ready.length) return settled;
  }

  // Form the train: oldest first; a solo entry alone; two entries in one land.serial group never together;
  // one that carries another PR's commits only behind it.
  const max = method === "merge" ? MAX_TRAIN() : 1;
  const train = [];
  const groups = new Set();
  for (const e of ready) {
    if (train.length >= max || (e.solo && train.length)) continue;
    if (e.need.some((p) => !train.some((x) => x.pr === p))) continue;
    const gs = serialGroups(m, changedFiles(main, base, e.head));
    if (gs.some((g) => groups.has(g))) continue;
    train.push(e);
    gs.forEach((g) => groups.add(g));
    if (e.solo) break;
  }
  if (!train.length) return settled;
  const n = store.updateQueue(key, (q) => {
    q.seq += 1;
    q.train = { n: q.seq, prs: train.map((e) => e.pr), stage: "building", base, at: Date.now() };
    return q.seq;
  })?.out;
  if (!n) return settled;
  // A running pre-push suite adds { suite, log, started } (queue status shows how far it has got); any other stage clears them.
  const stage = (s, extra = {}) => store.updateQueue(key, (q) => { if (q.train?.n === n) Object.assign(q.train, { stage: s, suite: null, log: null, started: null, ...extra }); });
  c.log(`train ${n}: ${prs(train)} on ${short(base)}`);
  try {
    return await land(c, { n, base, m, method, train, stage });
  } finally {
    store.updateQueue(key, (q) => { if (q.train?.n === n) q.train = null; });
  }
}

/**
 * How a waiting entry lands: "land" (green on its own head, merges cleanly, nothing serial changed on both sides),
 * "wait" (its checks run again, or a PR it carries is still ahead) or "train" (built and tested with main first).
 */
function greenWay(c, m, base, e) {
  if (e.retest) return "train";
  if (e.need.length) return "wait";
  const k = checksOf(e.rollup);
  if (k.failed.length) return "train";
  if (k.pending.length) { trouble(c, [e], `its checks are running again (${k.pending.slice(0, 4).join(", ")})`, "checks"); return "wait"; }
  // Branch protection wants something the head lacks (an up-to-date branch, a check), or GitHub sees a conflict.
  if (["BEHIND", "BLOCKED", "DIRTY"].includes(e.mergeState)) return "train";
  const conflicts = mergeConflicts(c.main, base, e.head);
  if (!conflicts || conflicts.length) return "train";
  const mine = serialGroups(m, changedFiles(c.main, base, e.head));
  if (mine.length && serialGroups(m, changedFiles(c.main, e.head, base)).some((g) => mine.includes(g))) return "train";
  return "land";
}

/** Merges a green entry's own PR as it is. True when anything changed. A refusal sends it through a train from now on. */
async function landGreen(c, e, method, base) {
  const { key, main, b } = c;
  const rv = reviewBack(c, e);
  if (rv.err) { trouble(c, [e], `could not read #${e.pr}'s review threads before merging (${rv.err})`, "settle"); return false; }
  if (rv.back) return true;
  const n = store.updateQueue(key, (q) => {
    q.seq += 1;
    q.train = { n: q.seq, prs: [e.pr], stage: "merging (green)", base, at: Date.now() };
    return q.seq;
  })?.out;
  try {
    const r = gh(main, ["pr", "merge", String(e.pr), `--${method}`, "--match-head-commit", e.head]);
    fetchSync(main, b);
    const sha = resolveRef(c.info, `refs/remotes/origin/${b}`);
    if (!r.ok && !isAncestor(main, e.head, `refs/remotes/origin/${b}`) && prView(main, e.pr)?.state !== "MERGED") {
      c.log(`#${e.pr}: gh pr merge refused it as it is (${store.clip(r.err, 200)}); it goes through a train`);
      store.updateQueue(key, (q) => { if (q.entries[e.pr]) q.entries[e.pr].retest = true; });
      return true;
    }
    clear(c, [e]);
    finishEntry(key, e, "landed", `#${e.pr} landed on ${b} as ${short(sha ?? "")}: its own checks were green, so it went straight in, and ${b}'s checks after the merge test it with everything else. Next: the release steps (/pr-create Step 7), then the report.`, { sha, train: n ?? null });
    c.log(`#${e.pr}: green, landed as it is as ${short(sha ?? "")}${n ? ` (round ${n})` : ""}`);
    return true;
  } finally {
    store.updateQueue(key, (q) => { if (q.train?.n === n) q.train = null; });
  }
}

const BILLING_LINE = "waits on GitHub billing";

/**
 * GitHub refused a train's jobs: nothing about its members failed and no one asks the owner per PR. One blocker
 * says so once (trouble.mjs), they keep their place, and their task's tab says why.
 */
function blockOnBilling(c, members, { billing, link }) {
  openBlocker("billing", { text: billing, main: c.main, run: /\/actions\/runs\/(\d+)/.exec(link ?? "")?.[1] ?? null });
  store.updateQueue(c.key, (q) => { for (const e of members) if (q.entries[e.pr]) q.entries[e.pr].blocked = "billing"; });
  for (const e of members) entryNews(c.key, e, "moving", `#${e.pr} ${BILLING_LINE}: nothing about it failed, and rollcall told the owner. It keeps its place and goes on once GitHub starts jobs again.`, { line: BILLING_LINE });
}

/** The billing blocker closed: what sat out goes back to the line. A refusal that comes back blocks it again. */
function unblock(c) {
  const held = Object.values(store.readQueue(c.key).entries).filter((e) => e.blocked);
  if (!held.length) return;
  try { look(); } catch {}
  if (openBlockers().billing) return;
  store.updateQueue(c.key, (q) => { for (const e of held) if (q.entries[e.pr]) q.entries[e.pr].blocked = null; });
  for (const e of held) entryNews(c.key, e, "moving", `#${e.pr} is back in line: GitHub starts jobs again.`);
}

/** What gets an owner past a failure the lander cannot clear itself, when it is one we know. */
function nextStep(why) {
  if (/could not read Username|terminal prompts disabled/.test(why)) return " Next: run gh auth setup-git, so git signs in with gh's login.";
  if (/HTTP 401|gh auth login/.test(why)) return " Next: run gh auth login.";
  return "";
}

/**
 * An entry that cannot move this round, for a reason that may clear (`where`: "settle", before a train; "train", in
 * one). It stays in the queue and the lander keeps trying; past STUCK_MS its session and task hear why, once.
 */
function trouble(c, entries, why, where = "train") {
  const now = Date.now();
  for (const e of entries) {
    const r = store.updateQueue(c.key, (q) => {
      const x = q.entries[e.pr];
      if (!x) return {};
      const first = x.stuck?.where !== where;
      if (first) x.stuck = { since: now, where, told: false };
      x.stuck.why = why;
      if (x.stuck.told || now - x.stuck.since < STUCK_MS()) return { first };
      x.stuck.told = true;
      return { first, since: x.stuck.since };
    })?.out;
    if (r?.first) c.log(`#${e.pr}: ${why}; it stays in the queue, and the lander keeps trying`);
    if (!r?.since) continue;
    c.log(`#${e.pr}: stuck for ${span(now - r.since)}: told its task`);
    entryNews(c.key, e, "stuck", `#${e.pr} has not moved for ${span(now - r.since)}: ${store.clip(why, 200)}.${nextStep(why)} The lander keeps trying and goes on by itself once that clears.`);
  }
}

/** What trouble() recorded is over (`where`: only that kind). A task it told hears that too. */
function clear(c, entries, where = null) {
  for (const e of entries) {
    const s = store.readQueue(c.key).entries[e.pr]?.stuck;
    if (!s || (where && s.where !== where)) continue;
    store.updateQueue(c.key, (q) => { if (q.entries[e.pr]) q.entries[e.pr].stuck = null; });
    c.log(`#${e.pr}: moving again`);
    if (s.told) entryNews(c.key, e, "moving", `#${e.pr} is moving again in the merge queue (it was stuck: ${store.clip(s.why, 120)}).`);
  }
}

/**
 * Sends an entry back to its worker when its PR has an open review thread the owner did not say to land with
 * (queue add --owner-ok): { back }, or { err } when gh could not say. A bot's repeat of an answered thread does not count.
 * Not a bounce: a reviewer's new point is no failure of the fix, so it counts toward no limit.
 */
function reviewBack(c, e, { maxAge = 0 } = {}) {
  c.threadsSeen ??= new Map();
  const seen = c.threadsSeen.get(e.pr);
  if (maxAge && seen?.head === e.head && Date.now() - seen.at < maxAge) return { back: false };
  const r = prThreads(c.main, e.pr);
  if (r.err) { c.threadsSeen.delete(e.pr); return { err: r.err }; }
  const ok = new Set(e.threadsOk?.ids ?? []);
  const fresh = r.open.filter((t) => !ok.has(t.id));
  if (!fresh.length) { c.threadsSeen.set(e.pr, { head: e.head, at: Date.now() }); return { back: false }; }
  c.threadsSeen.delete(e.pr);
  const lines = fresh.slice(0, 6).map((t) => threadLine(t, 160)).join("; ");
  c.log(`#${e.pr}: ${fresh.length} new review thread${fresh.length === 1 ? "" : "s"}; back to its worker`);
  finishEntry(c.key, e, "review", `#${e.pr} got ${fresh.length} review thread${fresh.length === 1 ? "" : "s"} after it joined, so it left the merge queue: ${lines}${fresh.length > 6 ? `; and ${fresh.length - 6} more` : ""}. Next: rollcall pr threads, fix or answer each and resolve the fixed ones (rollcall pr reply, rollcall pr resolve), push, wait for green checks, then rollcall queue add.`);
  return { back: true };
}

/** Sends an entry back to its session (or parks it, past the bounce limit). */
function bounce(c, e, kind, text) {
  const count = store.readQueue(c.key).bounced[e.pr]?.count ?? 0;
  if (count >= MAX_BOUNCES) finishEntry(c.key, e, "parked", `${text} It was sent back ${count} times before, so this time it is parked for the owner.`);
  else finishEntry(c.key, e, kind, text);
}

async function land(c, t) {
  const { key, main, b } = c;
  const { n, base, m, train, stage } = t;
  const dir = scratchTree(c, base);
  if (!dir) { trouble(c, train, "the lander has no scratch worktree (git worktree add failed)"); return false; }

  // Build: each head merged onto the default branch in order (Mergiraf on conflicted files).
  const built = build(c, dir, base, train, n);
  for (const { e, files } of built.conflicts) {
    bounce(c, e, "conflict", `#${e.pr} conflicts with ${b} in: ${fileList(files.map(safeName), 8)}. Next: git fetch origin && git merge origin/${b}, resolve with your change on top, run the quick checks, push, wait for green checks, then rollcall queue add.`);
  }
  for (const { e, with: x } of built.deferred) c.log(`train ${n}: #${e.pr} conflicts with #${x?.pr ?? "?"}, which lands first; it waits for a later train`);
  const members = built.members;
  if (!members.length) return true;
  const commit = built.commit;

  // Pre-push suites, on this machine, for what nobody has tested yet: a train of one whose head already
  // holds the default branch was tested as it is (its own checks, attestation included), except what its
  // ship left to the train: an entry with a `ship` command ran only the suites its diff names.
  const headM = built.fresh ? m : manifestAt(main, commit);
  const shipOf = (p) => [m, headM].some((x) => (Array.isArray(x.ci?.prePush) ? x.ci.prePush : []).some((y) => y?.name === p.name && typeof y.ship === "string" && y.ship));
  const entries = (Array.isArray(m.ci?.prePush) ? m.ci.prePush : []).filter((p) => p?.name && (built.fresh || shipOf(p)));
  const files = entries.length ? list(gitSync(dir, ["diff", "--name-only", "--no-renames", "-z", base, commit]).stdout ?? "", "\0") : [];
  const prePush = entries.filter((p) => files.some((f) => matchScope(Array.isArray(p.when) ? p.when : ["**"], f)));
  const ran = [];
  let setup = false;
  const flaked = []; // { suite, list, tests }: known flakes that failed here and passed alone, named in the PRs
  for (const p of prePush) {
    stage(`pre-push ${p.name}`);
    let k;
    try { k = keyOf(dir, p.name, commit); } catch (err) { c.log(`train ${n}: ${err.message}`); continue; }
    if (passOf(dir, k)) { c.log(`train ${n}: ${p.name} already passed for these inputs`); continue; }
    // build() leaves the scratch tree where the last train left it when the head is the train's tree.
    if (!built.fresh && !ran.length) {
      const co = gitSync(dir, ["checkout", "--quiet", "--detach", "--force", commit], { timeout: 120_000 });
      if (co.status !== 0) { trouble(c, train, `git checkout of ${short(commit)} failed: ${(co.stderr ?? "").trim()}`); return false; }
      gitSync(dir, ["clean", "-fdq"]);
    }
    ran.push(p);
    if (!setup && typeof m.worktree?.setup === "string") { await run(c, dir, m.worktree.setup, `train-${n}-setup`); setup = true; }
    const cmd = String(p.command ?? "").replace(/<[a-z][\w-]*>/gi, "");
    const failures = join(dirname(dir), `train-${n}-${p.name}.failures`);
    writeFileSync(failures, "");
    const started = Date.now();
    stage(`pre-push ${p.name}`, { suite: p.name, log: logOf(dir, `train-${n}-${p.name}`), started });
    const known = knownFlakes(dir, base, p);
    const limit = suiteLimit(store.readQueue(key).times[p.name]);
    const r = await run(c, dir, cmd, `train-${n}-${p.name}`, { ROLLCALL_FAILURES: failures }, { limit, quiet: QUIET_MS(), failures, known });
    const took = Date.now() - started;
    // Killed (a limit, a signal) or stopped at a failure: the suite never finished, whatever it wrote.
    const f = r.status === 0 || r.signal || r.stopped ? {} : await rerunFlakes(c, dir, base, p, n, failures, known);
    if (r.hung || f.hung) {
      c.log(`train ${n}: ${p.name} stopped: ${r.hung ?? f.hung}`);
      parkAll(c, members, `The lander stopped ${p.name} on merge train ${n}: ${r.hung ?? f.hung}. Its log: ${r.log}. Nothing says ${prs(members)} caused it. Next: rollcall queue leave, then rollcall queue add, to try again.`);
      return true;
    }
    if (r.status !== 0 || r.failed) {
      const rest = shipOf(p) ? `The ship's own run (the entry's \`ship\`) left part of ${p.name} to the train; its \`command\` runs that part.` : null;
      const stopped = r.failed ? `The lander stopped the suite at ${fileList(r.failed, 3)} rather than let a train that cannot land run on.` : null;
      const note = [f.note, stopped, rest].filter(Boolean).join(" ") || undefined;
      if (!f.passed) return await red(c, t, members, [{ name: p.name, link: f.log ?? r.log, note, inputs: checkOf(m, p.name)?.inputs ?? ["**"] }], { commit, prn: null, pushed: false });
      flaked.push({ suite: p.name, list: p.flakes, tests: f.passed });
    }
    // The suite's usual time, for queue status: its last 5 full runs that passed.
    store.updateQueue(key, (q) => { q.times[p.name] = [...(q.times[p.name] ?? []), took].slice(-5); });
    const rec = recordPass(dir, k);
    c.log(`train ${n}: ${p.name} passed in ${Math.round(took / 60_000)} min${rec.error ? ` (origin refused the pass: ${rec.error})` : ""}`);
  }
  // Never silently: each member's PR, the train PR and the landed lines name the flakes.
  const flakeLines = flaked.map(flakeLine);
  if (flakeLines.length) {
    store.updateQueue(key, (q) => { for (const e of members) if (q.entries[e.pr]) q.entries[e.pr].flakes = [...(q.entries[e.pr].flakes ?? []), ...flakeLines]; });
    for (const e of members) {
      const r = gh(main, ["pr", "comment", String(e.pr), "--body", `Merge queue train ${n}: ${flakeLines.join("; ")}, so the train went on.`]);
      if (!r.ok) c.log(`train ${n}: gh pr comment #${e.pr} failed: ${r.err}`);
    }
  }

  // Up to GitHub: a train of one goes on its own branch (a fast-forward: the train commit has its head
  // as a parent), a longer one as mq/<n> with its own PR.
  let prn = members[0].pr;
  let pushed = false;
  // A head the lander pushed, its checks counted from that push: an earlier train's push that never got to
  // merge (stopped, or its lander died) has not been seen green by anyone. One PR merged on one, unchecked.
  let since = members.length === 1 && members[0].pushed?.head === commit ? members[0].pushed.at : 0;
  let was = null;
  if (members.length === 1 && commit !== members[0].head) {
    const e = members[0];
    since = Date.now();
    store.updateQueue(key, (q) => { if (q.entries[e.pr]) Object.assign(q.entries[e.pr], { head: commit, pushed: { head: commit, at: since } }); });
    const r = gitSync(main, ["push", "--quiet", "--no-verify", `--force-with-lease=refs/heads/${e.branch}:${e.head}`, "origin", `${commit}:refs/heads/${e.branch}`], { timeout: 120_000 });
    if (r.status !== 0) {
      store.updateQueue(key, (q) => { if (q.entries[e.pr]) Object.assign(q.entries[e.pr], { head: e.head, pushed: e.pushed ?? null }); });
      trouble(c, members, `git push to ${e.branch} failed: ${r.stderr.trim()}`);
      return false;
    }
    was = e.head;
    e.head = commit;
    pushed = true;
  } else if (members.length > 1) {
    const branch = `mq/${n}`;
    const r = gitSync(main, ["push", "--quiet", "--no-verify", "--force", "origin", `${commit}:refs/heads/${branch}`], { timeout: 120_000 });
    if (r.status !== 0) { trouble(c, members, `git push of ${branch} failed: ${r.stderr.trim()}`); return false; }
    const skips = [...new Set(members.flatMap((e) => list(e.body).filter((l) => /^Docs-skip:/.test(l.trim())).map((l) => l.trim())))];
    const body = [
      `Merge queue train ${n}: lands ${members.map((e) => `#${e.pr} (${e.branch})`).join(", ")} on ${b} as one tree, tested once.`,
      "", ...flakeLines.map((l) => `Known flake: ${l}.`), ...(flakeLines.length ? [""] : []),
      "Opened by rollcall's lander. Do not push to this branch; it goes once the train lands.", "", ...skips,
    ].join("\n");
    const pr = gh(main, ["pr", "create", "--base", b, "--head", branch, "--title", `Merge queue train ${n}: ${prs(members)}`, "--body", body]);
    const num = Number(/\/pull\/(\d+)/.exec(pr.out)?.[1]);
    if (!pr.ok || !num) { trouble(c, members, `gh pr create failed: ${pr.err}`); gitSync(main, ["push", "--quiet", "origin", `:refs/heads/${branch}`]); return false; }
    prn = num;
    since = Date.now();
  }
  clear(c, members);
  await attest(c, dir, built.fresh ? prePush : ran, n, flaked);

  // CI, where the tree has workflows that run on PRs: green, or blame. A head its session pushed joined green
  // (queue add), so one look: no check still running and branch protection satisfied.
  const hasCI = list(gitSync(dir, ["grep", "-l", "-E", "pull_request", commit, "--", ".github/workflows"]).stdout ?? "").length > 0;
  if (hasCI) {
    stage(`CI on #${prn}`, { pr: prn });
    const blame = (failed) => suspects(c, m, base, members, failed);
    let res = await waitChecks(c, prn, commit, members, { since, was, blame });
    // A failed check runs once more before anyone is blamed: one flaky backend test once cost a PR its place and a
    // second hour of iPhone tests. The re-run repeats only the failed jobs, and the pre-push passes stay recorded.
    if (res.failed && rerun(c, res.failed)) { await sleep(Math.min(POLL_MS(), 10_000)); res = await waitChecks(c, prn, commit, members, { blame }); res.rerun = true; }
    if (res.billing) {
      closeTrain(c, members, prn);
      c.log(`train ${n}: GitHub refused its jobs: ${res.billing}`);
      blockOnBilling(c, members, res);
      return true;
    }
    if (res.failed) return await red(c, t, members, res.failed, { commit, prn, pushed, rerun: !!res.rerun });
    if (res.stop) { closeTrain(c, members, prn); c.log(`train ${n}: ${res.stop}`); if (res.timeout) parkAll(c, members, `merge train ${n}'s checks were still not done after ${Math.round(CI_MS() / 60_000)} min (a self-hosted runner asleep?).`); return true; }
  }

  // Land: only on the base it was built on, and only with every member still in the queue.
  stage("merging");
  fetchSync(main, b);
  const now = resolveRef(c.info, `refs/remotes/origin/${b}`);
  // A thread left while CI ran: that member goes back, and the train forms again without it.
  // A thread nobody could read is not a clear one: after one retry the train forms again, and the settle loop
  // holds the entry (and tells its task, past STUCK_MS) until GitHub answers.
  let unread = null;
  for (const e of members) {
    let rv = reviewBack(c, e);
    if (rv.err) { await sleep(Math.min(POLL_MS(), 5000)); rv = reviewBack(c, e); }
    if (rv.err) { unread = `could not read #${e.pr}'s review threads before merging (${rv.err})`; break; }
  }
  const still = store.readQueue(key).entries;
  if (unread || now !== base || members.some((e) => still[e.pr]?.state !== "waiting")) {
    c.log(`train ${n}: ${unread ?? (now !== base ? `${b} moved to ${short(now)}` : "a member left")}; it forms again`);
    closeTrain(c, members, prn);
    return true;
  }
  const one = members.length === 1;
  const merge = () => gh(main, ["pr", "merge", String(prn), `--${one ? t.method : "merge"}`, "--match-head-commit", commit, ...(one ? [] : ["--delete-branch"])]);
  let r = merge();
  // Seconds after a push GitHub may still refuse the merge for the head it has not caught up with.
  for (let i = 0; !r.ok && i < 3; i++) { await sleep(Math.min(POLL_MS(), 5000)); r = merge(); }
  if (!r.ok) fetchSync(main, b);
  // Someone merged it by hand seconds ago, and GitHub showed it open until now.
  if (!r.ok && !isAncestor(main, commit, `refs/remotes/origin/${b}`) && prView(main, prn)?.state !== "MERGED") {
    c.log(`train ${n}: gh pr merge #${prn} failed: ${r.err}`);
    parkAll(c, members, `the lander could not merge ${one ? `#${prn}` : `train PR #${prn}`}: ${store.clip(r.err, 300)}`);
    return true;
  }
  fetchSync(main, b);
  const sha = resolveRef(c.info, `refs/remotes/origin/${b}`);
  for (const e of members) {
    const others = members.filter((x) => x !== e);
    const fl = still[e.pr]?.flakes ?? [];
    const named = fl.length ? ` Known flake: ${fl.join("; ")}. Name it in the report.` : "";
    finishEntry(key, e, "landed", `#${e.pr} landed on ${b} as ${short(sha ?? "")}${others.length ? ` in merge train ${n} (PR #${prn}, with ${prs(others)})` : ""}.${named} Next: the release steps (/pr-create Step 7), then the report.`, { sha, train: n, ...(fl.length ? { flakes: fl } : {}) });
  }
  c.log(`train ${n}: landed ${prs(members)} as ${short(sha ?? "")}`);
  return true;
}

/** The train's tree: { commit, members, conflicts: [{ e, files }], deferred: [{ e, with }], fresh }. */
function build(c, dir, base, train, n) {
  if (train.length === 1 && isAncestor(dir, base, train[0].head)) return { commit: train[0].head, members: train, conflicts: [], deferred: [], fresh: false };
  const git = (args, opts) => gitSync(dir, args, { timeout: 120_000, ...opts });
  git(["checkout", "--quiet", "--detach", "--force", base]);
  git(["clean", "-fdq"]);
  const members = [], conflicts = [], deferred = [];
  for (const e of train) {
    // What it carries went back: merging it would bring those commits in anyway.
    const without = e.need?.find((p) => !members.some((x) => x.pr === p));
    if (without) { deferred.push({ e, with: train.find((x) => x.pr === without) }); continue; }
    const msg = `Merge #${e.pr} (${e.branch}) into merge train ${n}`;
    if (git(["-c", "merge.conflictStyle=diff3", "merge", "--no-ff", "--no-edit", "-m", msg, e.head]).status === 0) { members.push(e); continue; }
    const files = list(git(["diff", "--name-only", "--diff-filter=U", "-z"]).stdout ?? "", "\0");
    const left = files.filter((f) => !mergiraf(dir, f));
    if (files.length && !left.length && git(["add", "--", ...files]).status === 0 && git(["commit", "--quiet", "--no-edit"]).status === 0) {
      c.log(`train ${n}: mergiraf resolved ${fileList(files, 6)} for #${e.pr}`);
      members.push(e);
      continue;
    }
    git(["merge", "--abort"]);
    git(["reset", "--quiet", "--hard"]);
    git(["clean", "-fdq"]);
    const withMain = mergeConflicts(dir, base, e.head) ?? left;
    if (withMain.length) conflicts.push({ e, files: withMain });
    else deferred.push({ e, with: members.find((x) => (mergeConflicts(dir, x.head, e.head) ?? []).length) });
  }
  return { commit: git(["rev-parse", "HEAD"]).stdout.trim(), members, conflicts, deferred, fresh: true };
}

/** The lander's own worktree, outside .claude/worktrees (gc leaves it), at `base`. */
function scratchTree(c, base) {
  const dir = store.queueTree(c.key);
  if (!existsSync(join(dir, ".git"))) {
    rmSync(dir, { recursive: true, force: true });
    gitSync(c.main, ["worktree", "prune"]);
    const r = gitSync(c.main, ["worktree", "add", "--quiet", "--detach", "--force", dir, base], { timeout: 300_000 });
    if (r.status !== 0) { c.log(`git worktree add failed: ${r.stderr.trim()}`); return null; }
  }
  return dir;
}

const logOf = (dir, name) => join(dirname(dir), `${name}.log`);

/** Anything written in `dir` since `stamp`. A find that fails says yes: a doubt never ends a suite. */
function wroteIn(dir, stamp) {
  const r = spawnSync("find", [dir, "-path", join(dir, ".git"), "-prune", "-o", "-type", "f", "-newer", stamp, "-print", "-quit"], { encoding: "utf8", timeout: 30_000 });
  return r.status !== 0 || !!r.stdout;
}

/** The failures a suite has written so far that are not known flakes: such a run cannot end green. A line still being written does not count. */
function realFailures(failures, known) {
  try {
    const text = readFileSync(failures, "utf8");
    return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").map((l) => l.trim()).filter((l) => l && !known.has(l));
  } catch { return []; }
}

/**
 * A command in the scratch tree, in a process group of its own, its output in a log file beside it:
 * { status, log, signal, stopped, hung, failed }. It runs at most `limit`. With `quiet`, it ends as hung once nothing
 * was written to its log or the tree for that long; with `failures`, at its first line there that `known` does not hold.
 */
async function run(c, dir, cmd, name, env = {}, { limit = RUN_MS, quiet = 0, failures = null, known = new Set() } = {}) {
  const log = logOf(dir, name);
  const fd = openSync(log, "w");
  c.log(`run ${name}: ${cmd}`);
  const child = spawn("/bin/sh", ["-c", cmd], { cwd: dir, stdio: ["ignore", fd, fd], detached: true, env: { ...process.env, ...env } });
  closeSync(fd);
  const end = new Promise((done) => {
    child.once("error", () => done({ status: 127, signal: null }));
    child.once("exit", (status, signal) => done({ status: status ?? 1, signal }));
  });
  const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { /* gone */ } };
  const stamp = `${log}.stamp`;
  writeFileSync(stamp, "");
  const started = Date.now();
  const tick = Math.max(20, Math.min(15_000, (quiet || limit) / 10));
  let size = 0, alive = started, why = null;
  for (;;) {
    const done = await Promise.race([end, sleep(tick, null, { ref: false })]);
    if (done) { rmSync(stamp, { force: true }); return { ...done, log, ...why, stopped: !!why }; }
    if (why) continue;
    const now = Date.now();
    const failed = failures ? realFailures(failures, known) : [];
    if (failed.length) why = { failed };
    else if (now - started > limit) why = { hung: `it ran past its ${span(limit)} limit` };
    else if (quiet) {
      const grew = statSync(log, { throwIfNoEntry: false })?.size ?? 0;
      if (grew !== size || wroteIn(dir, stamp)) { size = grew; alive = now; utimesSync(stamp, new Date(now - 1000), new Date(now - 1000)); }
      else if (now - alive > quiet) why = { hung: `it wrote nothing for ${span(now - alive)}, ${span(now - started)} in` };
    }
    if (!why) continue;
    kill("SIGTERM");
    setTimeout(() => kill("SIGKILL"), 10_000).unref();
  }
}

/** The tests a pre-push entry's `flakes` file lists on the default branch (so a PR cannot list its own failure). */
function knownFlakes(dir, base, p) {
  if (typeof p.flakes !== "string" || !p.flakes || typeof p.rerun !== "string" || !p.rerun) return new Set();
  const shown = gitSync(dir, ["show", `${base}:${p.flakes}`]);
  return new Set(shown.status === 0 ? shown.stdout.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean) : []);
}

/**
 * A pre-push suite that failed only on known flakes: every line its command wrote to ROLLCALL_FAILURES is one, and
 * each runs once more alone with `rerun`. { passed: [tests] } when each passed; else {}, { log, note } for red(), or { hung }.
 */
async function rerunFlakes(c, dir, base, p, n, failures, known) {
  if (!known.size) return {};
  let failed;
  try { failed = [...new Set(readFileSync(failures, "utf8").split("\n").map((l) => l.trim()).filter(Boolean))]; } catch { return {}; }
  if (!failed.length) return {};
  const other = failed.filter((x) => !known.has(x));
  if (other.length) { c.log(`train ${n}: ${p.name} failed on ${fileList(other, 6)}, not a known flake`); return {}; }
  for (const [i, test] of failed.entries()) {
    const r = await run(c, dir, p.rerun.replaceAll("<test>", () => sq(test)), `train-${n}-${p.name}-rerun-${i + 1}`, {}, { limit: SUITE_MIN_MS(), quiet: QUIET_MS() });
    if (r.hung) return { hung: `its re-run of ${test} stopped: ${r.hung}` };
    if (r.status !== 0) return { log: r.log, note: `It failed only on ${test}, a known flake (${p.flakes}), and failed again when run alone.` };
    c.log(`train ${n}: ${p.name}: known flake ${test} passed alone`);
  }
  return { passed: failed };
}

/** One suite's re-run flakes, as the PRs and the landed line name them. */
function flakeLine({ suite, list, tests }) {
  return `${suite} failed only on ${tests.join(", ")}, ${tests.length > 1 ? "known flakes" : "a known flake"} (${list}), and passed when run once more alone`;
}

/** After the push: each pre-push entry's attest (it tells CI the tree passed here). A refusal only costs CI its own run. */
async function attest(c, dir, prePush, n, flaked = []) {
  for (const p of prePush) {
    if (typeof p.attest !== "string" || !p.attest) continue;
    const tests = flaked.filter((f) => f.suite === p.name).flatMap((f) => f.tests);
    const r = await run(c, dir, p.attest, `train-${n}-${p.name}-attest`, tests.length ? { ROLLCALL_FLAKES: tests.join(" ") } : {});
    c.log(`train ${n}: ${p.name} attest exited ${r.status}`);
  }
}

/**
 * What GitHub says when it refused to start a job over billing: such a job fails in seconds with no steps, and only
 * its check run's annotation tells why. Each job is asked once (`seen`). Null when none says so.
 */
function billingRefusal(c, failed, seen) {
  for (const { link } of failed) {
    const job = /\/job\/(\d+)/.exec(link ?? "")?.[1];
    if (!job || seen.has(job)) continue;
    seen.add(job);
    const r = gh(c.main, ["api", `repos/{owner}/{repo}/check-runs/${job}/annotations`]);
    let notes = [];
    try { notes = r.ok ? JSON.parse(r.out) : []; } catch { /* no annotations to read */ }
    const hit = (Array.isArray(notes) ? notes : []).find((a) => /not started because[\s\S]*(billing|payment|spending limit)/i.test(a?.message ?? ""));
    if (hit) return { billing: hit.message, link };
  }
  return null;
}

/**
 * Waits for a PR's checks on `commit`, which reached GitHub at `since` (0: long ago; the default: just now):
 * { ok } | { failed: [{ name, link }] } | { billing, link } | { stop, timeout? }. `was`: the head the lander's push replaced.
 * A failure with checks still running ends the wait once `blame` names a member: the train cannot land.
 */
async function waitChecks(c, prn, commit, members, { since = Date.now(), was = null, blame = () => [] } = {}) {
  const start = Date.now();
  const seen = new Set();
  for (;;) {
    const pr = prView(c.main, prn);
    // For a few seconds after a push GitHub may still show the head it replaced (one PR's first train gave up on it).
    const caught = pr && !(was && pr.headRefOid === was);
    if (caught && pr.headRefOid !== commit) return { stop: `#${prn} gained another head (${short(pr.headRefOid)})` };
    const q = store.readQueue(c.key).entries;
    if (members.some((e) => q[e.pr]?.state !== "waiting")) return { stop: "a member left the queue" };
    if (caught) {
      const k = checksOf(pr.statusCheckRollup);
      if (k.failed.length) {
        const refused = billingRefusal(c, k.failed, seen);
        if (refused) return refused;
        if (!k.pending.length || blame(k.failed).length) return { failed: k.failed };
      }
      // Just after the push the rollup may hold only commit statuses (the attest's own) while GitHub still makes the
      // workflows' runs: done takes a check run and the settle time, or no run at all after NO_CHECKS_MS, and never
      // while branch protection blocks the merge (a required check not reported yet). Train 5 merged 3 s in, on statuses.
      const waited = Date.now() - since;
      const runs = (pr.statusCheckRollup ?? []).some((x) => !isStatus(x));
      if (!k.pending.length && pr.mergeStateStatus !== "BLOCKED" && (waited > NO_CHECKS_MS() || (runs && waited > SETTLE_MS()))) return { ok: true };
    }
    if (Date.now() - start > CI_MS()) return { stop: `#${prn}'s checks timed out`, timeout: true };
    await sleep(POLL_MS());
  }
}

/** `*` matches any run of characters in a check name; anything else is literal. */
const matchCheck = (pattern, name) => new RegExp(`^${String(pattern).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name);

/**
 * The members a failure points at: those whose changed files fall in the inputs of the stacks the failing
 * checks belong to (manifest `stacks[].check`; a pre-push failure carries its own inputs). A failing check
 * no stack claims suspects every member.
 */
function suspects(c, m, base, members, failed) {
  const stacks = Array.isArray(m.stacks) ? m.stacks : [];
  const out = new Set();
  for (const f of failed) {
    const owners = stacks.filter((s) => [s?.check].flat().filter(Boolean).some((p) => matchCheck(p, f.name)));
    if (!f.inputs && !owners.length) { members.forEach((e) => out.add(e.pr)); continue; }
    const inputs = f.inputs ?? owners.flatMap((s) => (Array.isArray(s.inputs) && s.inputs.length ? s.inputs : ["**"]));
    for (const e of members) if (changedFiles(c.main, base, e.head, pathspecs(inputs)).length) out.add(e.pr);
  }
  return members.filter((e) => out.has(e.pr));
}

/** Re-runs the failed jobs of the runs behind `failed` (their links name them). True when one started. */
function rerun(c, failed) {
  const ids = [...new Set(failed.map((f) => /\/actions\/runs\/(\d+)/.exec(f.link ?? "")?.[1]).filter(Boolean))];
  return ids.map((id) => gh(c.main, ["run", "rerun", id, "--failed"]).ok).some(Boolean);
}

/** A red train: one suspect goes back, several go solo, none parks the train. Always true (something changed). */
async function red(c, t, members, failed, { commit, prn, pushed, rerun: reran = false }) {
  const { n, base, m } = t;
  closeTrain(c, members, prn);
  const what = failed.map((f) => `${f.name}${f.link ? ` (${f.link})` : ""}`).join(", ");
  const note = failed.map((f) => f.note).filter(Boolean).map((s) => ` ${s}`).join("");
  const sus = suspects(c, m, base, members, failed);
  c.log(`train ${n}: red on ${what}; suspects ${prs(sus) || "none"}`);
  if (sus.length === 1) {
    const e = sus[0];
    const alone = members.length === 1;
    const where = alone ? `#${e.pr} with origin/${c.b} merged in` : `merge train ${n} (${prs(members)}), and only your change touches what it tests`;
    bounce(c, e, "failed", `#${e.pr}: ${what} failed on ${where}.${note} Fix it on your branch${pushed ? ` (git pull --ff-only first: the lander merged origin/${c.b} into it as ${short(commit)})` : ""}, push, wait for green checks, then rollcall queue add.`);
    for (const x of members) if (x !== e) goesAgain(c, x, `#${e.pr} failed train ${n}, going again`);
    return true;
  }
  if (sus.length > 1) {
    store.updateQueue(c.key, (q) => { for (const e of sus) if (q.entries[e.pr]) q.entries[e.pr].solo = true; });
    for (const x of members) goesAgain(c, x, sus.includes(x) ? `train ${n} failed, going alone` : `train ${n} failed, going again`);
    return true;
  }
  parkAll(c, members, `${what} failed on merge train ${n}${reran ? " twice" : ""}, and none of ${prs(members)} touches what it tests.${note}`);
  return true;
}

/** A member a red train leaves in the queue: the next round takes it, and its session and tab say so. */
function goesAgain(c, e, why) {
  entryNews(c.key, e, "again", `#${e.pr}: ${why}.`, { line: why });
}

function parkAll(c, members, why) {
  for (const e of members) finishEntry(c.key, e, "parked", why);
}

/** A train PR that will not land is closed and its branch deleted; a train of one keeps its own PR. */
function closeTrain(c, members, prn) {
  if (members.length > 1 && prn) gh(c.main, ["pr", "close", String(prn), "--delete-branch"]);
}
