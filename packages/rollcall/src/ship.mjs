// The ship script: everything after a PR opens, run by scripts and never by a waiting agent. `rollcall ship start`
// puts the PR in the merge queue's state as "checking"; the lander (lander.mjs, one per repo) watches its checks and,
// once they are green and no review thread is open, puts it in line (`--land`) or tells its session it is green
// (PR only). After a landing, `rollcall ship after` (detached, one per landed PR) watches what the merge started on
// GitHub (check runs, commit statuses, deployments) and then runs the manifest's release.afterMerge commands from
// merged main. A model wakes only when something needs judgment: a red check (with the failing part of its log),
// a review thread, a conflict, a failed deploy or release command, or a release step that is a skill. That news
// goes into the task's worker as a notice, and to a session with no task through `rollcall ship wait`.
//   q.entries[<pr>] (queue.mjs) with state "checking": { ..., ship: true, land, since, rerun: { head, at }, ownerOk }
//   q.after[<pr>] = { pr, branch, sha, task, session, who, checkout, stage: deploys|release|done, step, at, pid, start, lines }
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { defaultBranch, dirtyPaths, fetchSync, gitSync, locate, mainCheckout, repoKey, resolveRef, safeName } from "./git.mjs";
import { matchScope } from "./glob.mjs";
import { AGAIN, ENDS, SHIP_USAGE, shipNews } from "./ship-news.mjs";
import { blockOnBilling, billingRefusal, clear, ensureTree, rerun, runIn, trouble } from "./lander.mjs";
import { pidAlive, sameProcess, startOf } from "./proc.mjs";
import { changedFiles, checksOf, ensureLander, entryNews, finishEntry, gh, guard, isStatus, manifestAt, prLook, span } from "./queue.mjs";
import { P, ago, fileList, msgLine, short, who } from "./session.mjs";
import { isOpen, transition } from "./state.mjs";
import * as store from "./store.mjs";
import { queueState, shipStage, taskAt } from "./task.mjs";
import { prThreads, threadLine } from "./threads.mjs";


const ms = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : dflt; };
const POLL_MS = () => ms("ROLLCALL_QUEUE_POLL_MS", 20_000);
/** With no check run at all this long after the push, the PR has no checks to wait for. */
const NO_CHECKS_MS = () => ms("ROLLCALL_QUEUE_NO_CHECKS_MS", 180_000);
const SETTLE_MS = () => NO_CHECKS_MS() / 3;
/** Checks still running this long after the push: someone hears (a self-hosted runner asleep or offline). */
const CI_MS = () => ms("ROLLCALL_QUEUE_CI_MINUTES", 60) * 60_000;
/** How often the after-merge runner looks at what the merge started, and for how long at most. */
const AFTER_POLL_MS = () => ms("ROLLCALL_SHIP_POLL_MS", 30_000);
const DEPLOY_MS = () => ms("ROLLCALL_SHIP_DEPLOY_MINUTES", 30) * 60_000;
/** Nothing at all on the merge commit this long after the merge: the merge starts nothing here. */
const NONE_MS = () => ms("ROLLCALL_SHIP_NONE_MS", 120_000);
/** A release command runs at most this long. */
const RELEASE_MS = 3 * 3600_000;


// ---------------------------------------------------------------- news

/** Records an after-merge outcome: the queue's outcomes (ship wait reads them), an event, the task. */
function afterOutcome(key, a, kind, text) {
  store.updateQueue(key, (q) => {
    q.outcomes.push({ pr: a.pr, branch: a.branch, session: a.session ?? null, kind, at: Date.now(), text, sha: a.sha });
    if (q.after?.[a.pr]) Object.assign(q.after[a.pr], { stage: "done", step: null, outcome: kind });
  });
  store.appendEvent(key, { type: "queue", kind, session: "merge-queue", to: a.task ? "" : a.session ?? "", pr: a.pr, branch: a.branch, text: store.oneLine(text), ship: true });
  if (!a.task) return;
  const [h, id] = a.task.split(":");
  shipStage(a.task, "done");
  if (kind === "shipped") {
    // The ship is over: the task lands with what the script saw below the worker's own report. A task that waits on
    // the owner keeps waiting (merged moves only working, pr-open and queued).
    const now = Date.now();
    const r = store.withTasksLock(h, () => {
      const x = store.readTask(h, id);
      if (!isOpen(x)) return false;
      const body = `rollcall's ship script: ${text}`;
      x.output = { at: now, by: x.output?.by ?? "rollcall", text: x.output ? `${x.output.text}\n\n${body}` : body };
      x.merged = { key: a.sha ?? x.pr ?? "its work", at: now, pr: x.pr ?? null, why: "its ship finished" };
      const moved = transition(x, "merged", { now });
      x.notes.push({ at: now, by: "rollcall", text: moved ? `landed: ${store.clip(text, 300)}` : `ship finished (${store.clip(text, 200)}); the task stays ${x.state}` });
      store.writeTask(x);
      return moved;
    });
    if (r?.out) store.enqueueWake(h, { task: id, kind: "landed" });
    return;
  }
  queueState(h, id, "queue-sent-back", { note: `ship: ${kind} - ${store.clip(store.oneLine(text), 300)}` });
  shipNews(a, kind, text);
}

// ---------------------------------------------------------------- the lander's look at checking entries

/**
 * One look at each "checking" entry whose turn has come (every POLL_MS): a new head is followed, a red check gets one
 * re-run and then goes back with the failing part of its log, and green moves it into line (or ends a PR-only ship).
 * True when anything changed.
 */
export function checkShips(c) {
  c.looked ??= new Map();
  const now = Date.now();
  let did = false;
  for (const e of Object.values(store.readQueue(c.key).entries)) {
    if (e.state !== "checking" || e.blocked || now - (c.looked.get(e.pr) ?? 0) < POLL_MS()) continue;
    c.looked.set(e.pr, now);
    try { if (lookShip(c, e, now)) did = true; } catch (err) { c.log(`#${e.pr}: ship look failed: ${err?.stack ?? err}`); }
  }
  return did;
}

function lookShip(c, e, now) {
  const { key, main } = c;
  const { pr, err } = prLook(main, e.pr);
  if (!pr) { trouble(c, [e], `gh pr view failed: ${err}`, "checks"); return false; }
  if (pr.state === "MERGED") { finishEntry(key, e, "landed", `#${e.pr} was merged outside the queue.`); return true; }
  if (pr.state === "CLOSED") { finishEntry(key, e, "left", `#${e.pr} was closed, so rollcall stopped watching it.`); return true; }
  if (pr.headRefOid !== e.head) {
    // A push while it is watched (a fix): the watch follows the new head from now.
    store.updateQueue(key, (q) => { if (q.entries[e.pr]?.state === "checking") Object.assign(q.entries[e.pr], { head: pr.headRefOid, since: now, rerun: null }); });
    c.log(`#${e.pr}: new head ${short(pr.headRefOid)}; watching its checks`);
    return true;
  }
  const k = checksOf(pr.statusCheckRollup);
  const waited = now - (e.since ?? e.at);
  if (k.failed.length) {
    c.billingSeen ??= new Set();
    const refused = billingRefusal(c, k.failed, c.billingSeen);
    if (refused) { blockOnBilling(c, [e], refused); return true; }
    // All of it at once: one wake for every failure, not one per check.
    if (k.pending.length) return false;
    if (e.rerun?.head !== e.head && rerun(c, k.failed)) {
      store.updateQueue(key, (q) => { if (q.entries[e.pr]) q.entries[e.pr].rerun = { head: e.head, at: now }; });
      c.log(`#${e.pr}: ${k.failed.map((f) => f.name).join(", ")} failed; re-ran the failed jobs once`);
      return true;
    }
    const what = k.failed.map((f) => `${f.name}${f.link ? ` (${f.link})` : ""}`).join(", ");
    const log = failedLog(c, e, k.failed);
    clear(c, [e]);
    finishEntry(key, e, "red", `#${e.pr}: ${what} failed on its head ${short(e.head)}${e.rerun?.head === e.head ? ", and again when re-run once" : ""}.${log ? ` The failing part of its log: ${log}.` : ""} First ask whether it is this PR's (a test in code it does not touch, red on main too, is not). Then fix it on the branch, run the quick checks, push once, ${AGAIN}.`);
    return true;
  }
  if (k.pending.length) {
    if (waited > CI_MS()) trouble(c, [e], `its checks still run ${span(waited)} after its push (${fileList(k.pending, 4)}): a self-hosted runner asleep or offline?`, "checks");
    return false;
  }
  const runs = (pr.statusCheckRollup ?? []).some((x) => !isStatus(x));
  if (!(waited > NO_CHECKS_MS() || (runs && waited > SETTLE_MS()))) return false;
  clear(c, [e], "checks");
  const th = prThreads(main, e.pr);
  if (th.err) { trouble(c, [e], `could not read #${e.pr}'s review threads: ${th.err}`, "checks"); return false; }
  const ok = new Set(e.ownerOk?.ids ?? []);
  const open = th.open.filter((x) => !ok.has(x.id));
  if (open.length) {
    const lines = open.slice(0, 6).map((x) => threadLine(x, 160)).join("; ");
    finishEntry(key, e, "review", `#${e.pr}'s checks are green, and it has ${open.length} open review thread${open.length === 1 ? "" : "s"}: ${lines}${open.length > 6 ? `; and ${open.length - 6} more` : ""}. Next: rollcall pr threads, fix or answer each and resolve the fixed ones (rollcall pr reply, rollcall pr resolve), push once, ${AGAIN}.`);
    return true;
  }
  if (!e.land) {
    ciLine(main, e.pr, "green");
    finishEntry(key, e, "green", `#${e.pr}'s checks are green and it has no open review thread. It stays open: "ship it" lands it (rollcall ship start --land).`);
    return true;
  }
  return toLine(c, e, now);
}

/** A green ship entry joins the line: the guard after a bounce, then a place from now. */
function toLine(c, e, now) {
  const { key, main, b } = c;
  const q = store.readQueue(key);
  const bounced = q.bounced[e.pr];
  const hits = bounced && bounced.head !== e.head ? guard(main, bounced.head, e.head, `origin/${b}`) : [];
  if (hits.length) {
    finishEntry(key, e, "parked", `#${e.pr} changed what its tests check after it was sent back: ${hits.join("; ")}. The owner decides whether that stands (rollcall queue leave, or fix and ship start --land).`);
    return true;
  }
  const files = changedFiles(main, `origin/${b}`, e.head).map(safeName);
  const threadsOk = e.ownerOk ? { ids: e.ownerOk.ids, words: e.ownerOk.words, at: e.ownerOk.at } : null;
  const r = store.updateQueue(key, (x) => {
    const cur = x.entries[e.pr];
    if (cur?.state !== "checking" || cur.head !== e.head) return null;
    x.entries[e.pr] = { ...cur, state: "waiting", at: now, files: files.slice(0, 50), threadsOk, carries: cur.carries ?? [] };
    x.joined[e.pr] ??= now;
    const order = Object.values(x.entries).filter((y) => y.state === "waiting").sort((a, y) => a.at - y.at);
    return { place: order.findIndex((y) => y.pr === e.pr) + 1, size: order.length };
  })?.out;
  if (!r) return false;
  c.log(`#${e.pr}: green; joined the line at ${r.place} of ${r.size}`);
  shipStage(e.task, "merge queue");
  entryNews(key, e, "moving", `#${e.pr}'s checks are green: it joined the merge queue, place ${r.place} of ${r.size}.`, { line: `green, in line ${r.place} of ${r.size}` });
  return true;
}

/** The failing part of a red check's log, saved beside the queue's state for the worker: its path, or null. */
function failedLog(c, e, failed) {
  const ids = [...new Set(failed.map((f) => /\/actions\/runs\/(\d+)/.exec(f.link ?? "")?.[1]).filter(Boolean))];
  const parts = [];
  for (const id of ids.slice(0, 3)) {
    const r = gh(c.main, ["run", "view", id, "--log-failed"], { timeout: 120_000 });
    if (!r.ok) continue;
    // The tail is mostly the job's cleanup: keep the error lines and what leads to them.
    const lines = r.out.split("\n");
    const hit = lines.findIndex((l) => /FAIL|Error|error:|failed|✘|AssertionError|not ok/.test(l));
    const from = hit >= 0 ? Math.max(0, hit - 10) : Math.max(0, lines.length - 150);
    parts.push(`== run ${id}\n${lines.slice(from, from + 150).join("\n")}`);
  }
  if (!parts.length) return null;
  const path = join(dirname(store.queueTree(c.key)), `red-${e.pr}-${short(e.head)}.log`);
  try { writeFileSync(path, `${parts.join("\n\n")}\n`); return path; } catch { return null; }
}

/** Sets the PR body's "- CI: ..." line (the quality pass /pr-create writes), when it has one. */
export function ciLine(cwd, pr, text) {
  const r = gh(cwd, ["pr", "view", String(pr), "--json", "body"]);
  let body;
  try { body = JSON.parse(r.out).body ?? ""; } catch { return false; }
  if (!/^- CI: .*$/m.test(body)) return false;
  const next = body.replace(/^- CI: .*$/m, `- CI: ${text}`);
  return next === body || gh(cwd, ["pr", "edit", String(pr), "--body", next]).ok;
}

// ---------------------------------------------------------------- after the merge

/** gh api in `cwd` as JSON, or null. */
const api = (cwd, path) => { const r = gh(cwd, ["api", path]); try { return r.ok ? JSON.parse(r.out) : null; } catch { return null; } };

/**
 * What the merge started on GitHub, as it stands: { items: [{ name, kind, state: pending|ok|failed, link, env }] },
 * or null when GitHub could not say. Check runs (Actions jobs, Vercel and Railway apps), commit statuses, and
 * deployments with their latest status.
 */
function merged(cwd, sha) {
  const runs = api(cwd, `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`);
  const status = api(cwd, `repos/{owner}/{repo}/commits/${sha}/status`);
  const deploys = api(cwd, `repos/{owner}/{repo}/deployments?sha=${sha}&per_page=50`);
  if (!runs || !status || !deploys) return null;
  const items = [];
  for (const r of runs.check_runs ?? []) {
    const ok = ["success", "neutral", "skipped"].includes(r.conclusion);
    items.push({ name: r.name, kind: "check", state: r.status !== "completed" ? "pending" : ok ? "ok" : "failed", link: r.details_url ?? r.html_url ?? null });
  }
  for (const s of status.statuses ?? []) items.push({ name: s.context, kind: "status", state: s.state === "success" ? "ok" : s.state === "pending" ? "pending" : "failed", link: s.target_url ?? null });
  for (const d of Array.isArray(deploys) ? deploys : []) {
    const st = api(cwd, `repos/{owner}/{repo}/deployments/${d.id}/statuses?per_page=1`);
    const s = Array.isArray(st) ? st[0]?.state : null;
    const state = !s || ["pending", "queued", "in_progress"].includes(s) ? "pending" : ["success", "inactive"].includes(s) ? "ok" : "failed";
    items.push({ name: `deploy to ${d.environment}`, kind: "deployment", env: d.environment, state, link: (Array.isArray(st) && (st[0]?.log_url || st[0]?.environment_url)) || null, url: Array.isArray(st) ? st[0]?.environment_url ?? null : null });
  }
  return { items };
}

/** Waits on what the merge started: { ok, items } | { failed, items } | { timeout, items } | { none }. */
async function watchMerge(c, sha) {
  const start = Date.now();
  let last = null;
  for (;;) {
    const m = merged(c.main, sha);
    if (m) {
      last = m.items;
      const settled = m.items.every((x) => x.state !== "pending");
      if (!m.items.length && Date.now() - start > NONE_MS()) return { none: true, items: [] };
      // Something may still be about to start: a settled set counts once the merge is a minute old.
      if (m.items.length && settled && Date.now() - start > Math.min(NONE_MS(), 60_000)) {
        const failed = m.items.filter((x) => x.state === "failed");
        return failed.length ? { failed, items: m.items } : { ok: true, items: m.items };
      }
    } else c.log(`after: GitHub could not say what ${short(sha)} started; trying again`);
    if (Date.now() - start > DEPLOY_MS()) return { timeout: true, items: last ?? [] };
    await sleep(AFTER_POLL_MS());
  }
}

const itemLine = (x) => `${x.name}${x.link ? ` (${x.link})` : ""}`;

/**
 * The after-merge runner for landed PR `prn` in repo `h` (queue.mjs `here`): what the merge started, then the
 * release commands. Exits when done; a failure or a skill step goes to the task's worker.
 */
export async function after(h, prn) {
  const { key } = h;
  const main = mainCheckout(h.info);
  const c = { ...h, main, log: (s) => store.appendLanderLog(key, `ship #${prn}: ${s}`) };
  const claimed = store.updateQueue(key, (q) => {
    const a = q.after?.[prn];
    if (!a || a.stage === "done" || (a.pid && a.pid !== process.pid && sameProcess(a.pid, a.start))) return null;
    Object.assign(a, { pid: process.pid, start: startOf(process.pid) });
    return { ...a };
  })?.out;
  if (!claimed) return 0;
  const a = claimed;
  const stage = (s, step = null) => store.updateQueue(key, (q) => { if (q.after?.[prn]) Object.assign(q.after[prn], { stage: s, step, at: Date.now() }); });
  fetchSync(main, h.b);
  if (!a.sha) a.sha = JSON.parse(gh(main, ["pr", "view", String(prn), "--json", "mergeCommit"]).out || "{}")?.mergeCommit?.oid ?? null;
  if (!a.sha) { afterOutcome(key, a, "after-failed", `#${prn} landed, but rollcall could not find its merge commit, so it watched no deploy and ran no release step. Next: check the deploys and run the release steps by hand (/pr-create's release reference).`); return 1; }
  c.log(`watching what ${short(a.sha)} started`);
  shipStage(a.task, "deploys");

  // 1. What the merge started on GitHub.
  const w = await watchMerge(c, a.sha);
  const m = manifestAt(main, a.sha);
  const prod = m.release?.production;
  const deployed = (w.items ?? []).filter((x) => x.kind === "deployment" && x.state === "ok").map((x) => `${x.env}${x.url ? ` (${x.url})` : ""}`);
  if (w.failed) {
    afterOutcome(key, a, "after-failed", `#${prn} landed as ${short(a.sha)}, and what the merge started failed: ${w.failed.map(itemLine).join(", ")}. No release step ran. Next: read the failure (gh run view <run> --log-failed for a workflow), fix it in a new PR from main, and report it; the release steps wait for a green main.`);
    return 1;
  }
  if (w.timeout) {
    const pending = w.items.filter((x) => x.state === "pending");
    afterOutcome(key, a, "after-failed", `#${prn} landed as ${short(a.sha)}, and what the merge started was still running after ${span(DEPLOY_MS())}: ${pending.map(itemLine).join(", ") || "nothing GitHub could name"}. No release step ran. Next: look at those runs, then run the release steps by hand once they are green.`);
    return 1;
  }
  const deployLine = w.none ? "the merge started nothing on GitHub" : `${w.items.length} check${w.items.length === 1 ? "" : "s"} and deploy${w.items.length === 1 ? "" : "s"} green${deployed.length ? ` (deployed: ${deployed.join(", ")})` : ""}`;
  c.log(deployLine);

  // 2. The release steps: commands run here, from merged main; a skill needs a model, which takes it from there.
  const files = changedFiles(main, `${a.sha}^1`, a.sha);
  const steps = (Array.isArray(m.release?.afterMerge) ? m.release.afterMerge : []).filter((s) => s && (!Array.isArray(s.when) || !s.when.length || files.some((f) => matchScope(s.when, f))));
  const done = [];
  for (const [i, s] of steps.entries()) {
    const name = s.name ?? s.skill ?? s.command;
    if (s.skill || typeof s.command !== "string") {
      const rest = steps.slice(i).map((x) => (x.skill ? `/${x.skill}${x.args ? ` ${x.args}` : ""}` : `\`${x.command}\``));
      afterOutcome(key, a, "release-step", `#${prn} landed as ${short(a.sha)}; ${deployLine}.${done.length ? ` Release steps done: ${done.join(", ")}.` : ""} Next, from merged main, in order: ${rest.join(", then ")}. Then save your report and set the task landed.`);
      return 0;
    }
    await waitTurn(c, prn);
    stage("release", name);
    shipStage(a.task, "release");
    const dir = ensureTree(c, a.sha, "release");
    if (!dir) { afterOutcome(key, a, "after-failed", `#${prn} landed as ${short(a.sha)}; ${deployLine}. rollcall could not make a checkout of merged main to run ${name} in. Next: run it by hand from the main checkout.`); return 1; }
    if (typeof m.worktree?.setup === "string" && !done.length) await runIn(c, dir, m.worktree.setup, `release-${prn}-setup`);
    const r = await runIn(c, dir, s.command, `release-${prn}-${safeName(name).replace(/[^\w.-]+/g, "-")}`, {}, { limit: RELEASE_MS });
    if (r.status !== 0) {
      afterOutcome(key, a, "after-failed", `#${prn} landed as ${short(a.sha)}; ${deployLine}. Its release step ${name} (\`${s.command}\`) failed${r.signal ? ` (${r.signal})` : ""}; its log: ${r.log}.${done.length ? ` Done before it: ${done.join(", ")}.` : ""} Next: read the log, fix what failed, and run that step and the ones after it again.`);
      return 1;
    }
    done.push(name);
    c.log(`release step ${name} passed`);
  }

  // 3. Done: the PR body says so, and the task lands.
  ciLine(main, prn, `green; landed as ${short(a.sha)}`);
  const prodLine = prod ? ` Production is unchanged: ${[prod.words].flat()[0] ?? "the production step"} releases it.` : "";
  afterOutcome(key, a, "shipped", `#${prn} landed as ${short(a.sha)}; ${deployLine}${done.length ? `; release steps done: ${done.join(", ")}` : steps.length ? "" : "; no release step for this change"}.${prodLine}`);
  c.log("shipped");
  return 0;
}

/** Waits while another landed PR's release commands run in this repo's release checkout: one at a time. */
async function waitTurn(c, prn) {
  for (;;) {
    const busy = Object.values(store.readQueue(c.key).after ?? {}).find((x) => x.pr !== prn && x.stage === "release" && x.pid && sameProcess(x.pid, x.start));
    if (!busy) return;
    await sleep(Math.min(AFTER_POLL_MS(), 10_000));
  }
}

// ---------------------------------------------------------------- CLI

function here(ctx) {
  const info = locate(process.cwd());
  if (!info) ctx.fail("not inside a git checkout (cd into the repo, or pass -C <dir>)");
  const repo = repoKey(info);
  const b = defaultBranch(info);
  if (!b) ctx.fail("this repo has no origin default branch to land on");
  const branch = gitSync(info.top, ["symbolic-ref", "-q", "--short", "HEAD"]).stdout?.trim();
  return { info, top: info.top, key: repo.key, name: repo.name, b, branch: branch && branch !== b ? branch : null };
}

export async function shipCommand(args, ctx) {
  const [sub, ...rest] = args;
  switch (sub) {
    case "start": return start(rest, ctx);
    case "wait": return await wait(rest, ctx);
    case "status": return status(rest, ctx);
    case "after": { const n = Number(rest[0]); if (!n) ctx.fail("ship after <pr>"); return await after(here(ctx), n); }
    case undefined: case "-h": case "--help": case "help": ctx.say(SHIP_USAGE); return 0;
    default: ctx.fail(`ship: unknown command "${sub}"\n${SHIP_USAGE}`);
  }
  return 1;
}

function start(args, ctx) {
  const land = args.includes("--land");
  const rest = args.filter((a) => a !== "--land");
  const [ownerOk] = ctx.flag(rest, "--owner-ok");
  if (rest.length) ctx.fail(`ship start: unknown argument "${rest[0]}"`);
  if (ownerOk !== undefined && !store.oneLine(ownerOk)) ctx.fail('ship start: --owner-ok takes the owner\'s words: --owner-ok "<what they said>"');
  const h = here(ctx);
  const { top, key, b, branch } = h;
  if (!branch) ctx.fail("nothing to ship from the default branch or a detached HEAD: run it in the task worktree, on its branch");
  const dirty = dirtyPaths(top);
  if (dirty === null) ctx.fail("git status failed");
  if (dirty.length) ctx.fail(`uncommitted work (${fileList(dirty.map(safeName), 4)}): what ships is what you pushed, so commit and push it, or drop it, first`);
  gitSync(top, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeout: 30_000 });
  const head = resolveRef(h.info, "HEAD");
  const pushed = resolveRef(h.info, `refs/remotes/origin/${branch}`);
  if (pushed !== head) ctx.fail(pushed ? `HEAD (${short(head)}) is not what origin has for ${branch} (${short(pushed)}): push first` : `${branch} is not on origin: push it and open its PR first`);
  const { pr, err } = prLook(top, branch);
  if (!pr) ctx.fail(`no PR for ${branch} (${store.clip(err || "gh pr view found none", 200)}): open one first`);
  if (pr.state !== "OPEN") ctx.fail(`#${pr.number} is ${pr.state.toLowerCase()}, not open`);
  if (pr.isDraft) ctx.fail(`#${pr.number} is a draft: mark it ready first (gh pr ready ${pr.number})`);
  if (pr.headRefOid !== head) ctx.fail(`#${pr.number}'s head is ${short(pr.headRefOid)}, not HEAD (${short(head)}): GitHub has not seen your last push yet; try again in a moment`);
  if (land && pr.baseRefName !== b) ctx.fail(`#${pr.number} targets ${pr.baseRefName}, not ${b}: the queue lands on ${b}. Once ${pr.baseRefName} has landed, retarget it (gh pr edit ${pr.number} --base ${b}), then ship start --land`);
  let ok = null;
  if (ownerOk !== undefined) {
    const th = prThreads(top, pr.number);
    if (th.err) ctx.fail(`could not read #${pr.number}'s review threads (${th.err}): try again in a moment`);
    ok = { ids: th.open.map((x) => x.id), words: store.oneLine(ownerOk), at: Date.now() };
  }
  const g = ctx.whoAmI();
  const t = taskAt(top);
  const now = Date.now();
  const entry = {
    pr: pr.number, branch, head, session: g?.id ?? null, who: g ? who({ id: g.id, branch, checkout: top, main: mainCheckout(h.info) }) : `#${pr.number}`,
    checkout: top, task: t && isOpen(t) ? `${t.home}:${t.id}` : null, at: now, since: now, state: "checking", why: null, solo: false, files: [], carries: [],
    ship: true, land, rerun: null, ownerOk: ok,
  };
  const res = store.updateQueue(key, (q) => {
    const was = q.entries[pr.number];
    if (was?.state === "parked" && was.head === head) return { parked: was };
    if (was?.state === "waiting" && was.head === head) return { waiting: true };
    q.entries[pr.number] = entry;
    return {};
  });
  if (!res) ctx.fail("the queue's state is busy; try again");
  if (res.out.parked) ctx.fail(`#${pr.number} is parked for the owner (${res.out.parked.why}); rollcall queue leave first`);
  if (res.out.waiting) { ctx.say(`${P} ship: #${pr.number} is already in the merge queue with this head; nothing to do.`); return 0; }
  if (entry.task) {
    const [th, id] = entry.task.split(":");
    queueState(th, id, "ship-started", { note: `ship: rollcall watches #${pr.number}'s checks${land ? " and lands it once green" : ""}${ok ? `, with ${ok.ids.length} open review thread(s) on the owner's word: "${store.clip(ok.words, 300)}"` : ""}`, pr: pr.url ?? null });
  }
  store.appendEvent(key, { type: "queue", kind: "added", session: g?.id ?? "user", pr: pr.number, branch, text: `#${pr.number}: rollcall watches its checks`, ship: true });
  shipStage(entry.task, "CI");
  ensureLander(key, mainCheckout(h.info));
  ctx.say(`${P} ship: rollcall watches #${pr.number}'s checks now${land ? "; once they are green with no open review thread it joins the merge queue, lands, and rollcall watches the deploys and runs the release commands" : "; once they are green it tells you, and the PR stays open"}.`);
  ctx.say(t && isOpen(t)
    ? `${P} ship: nothing to wait on. A red check, a review thread, a conflict or a failed release step comes back to this task's worker with what failed; the rest needs no one.`
    : `${P} ship: run \`rollcall ship wait\` in the background and end your turn; it exits when the ship needs you or is done.`);
  return 0;
}

async function wait(args, ctx) {
  const [mins] = ctx.flag(args, "--timeout");
  if (args.length) ctx.fail(`ship wait: unknown argument "${args[0]}"`);
  const h = here(ctx);
  if (!h.branch) ctx.fail("run it in the worktree of the branch you shipped");
  const g = ctx.whoAmI();
  const q0 = store.readQueue(h.key);
  const mine = Object.values(q0.entries).find((e) => e.branch === h.branch) ?? null;
  const since = mine?.since ?? mine?.at ?? 0;
  const latest = (q) => q.outcomes.filter((o) => o.branch === h.branch && o.at >= since && ENDS.has(o.kind)).pop();
  const landedNoAfter = (q) => q.outcomes.filter((o) => o.branch === h.branch && o.at >= since && o.kind === "landed").pop() && !Object.values(q.after ?? {}).some((a) => a.branch === h.branch && a.at >= since);
  if (!mine && !latest(q0) && !Object.values(q0.after ?? {}).some((a) => a.branch === h.branch && a.stage !== "done")) ctx.fail(`${h.branch} has no ship: rollcall ship start`);
  const deadline = Number(mins) > 0 ? Date.now() + Number(mins) * 60_000 : Infinity;
  let cursor = store.logEnd(h.key);
  for (let tick = 0; ; tick++) {
    const q = store.readQueue(h.key);
    const o = latest(q);
    if (o) { ctx.say(`${P} ship: ${o.kind} - ${o.text}`); return 0; }
    if (landedNoAfter(q)) { const l = q.outcomes.filter((x) => x.branch === h.branch && x.kind === "landed").pop(); ctx.say(`${P} ship: landed - ${l.text}`); return 0; }
    const now = Object.values(q.entries).find((e) => e.branch === h.branch);
    if (now?.state === "parked") { ctx.say(`${P} ship: parked - ${now.why}`); return 0; }
    const r = store.readEventsSince(h.key, cursor);
    cursor = r.cursor;
    const msg = g && r.events.find((e) => e.type === "msg" && e.to === g.id && e.session !== g.id);
    if (msg) { ctx.say(msgLine(msg, " while you waited")); ctx.say(`${P} the ship goes on: run rollcall ship wait again to keep waiting.`); return 0; }
    if (tick % 30 === 0 && Object.values(q.entries).some((e) => e.state === "waiting" || e.state === "checking")) ensureLander(h.key, mainCheckout(h.info));
    if (g?.pid && !pidAlive(g.pid, g.pidStart)) return 3;
    if (Date.now() > deadline) { ctx.say(`${P} stopped waiting after ${mins} min; the ship goes on.`); return 124; }
    await sleep(Number(process.env.ROLLCALL_WAIT_POLL_MS) || 1000);
  }
}

function status(args, ctx) {
  const json = args.includes("--json");
  const h = here(ctx);
  if (!h.branch) ctx.fail("run it in the worktree of the branch you shipped");
  const q = store.readQueue(h.key);
  const entry = Object.values(q.entries).find((e) => e.branch === h.branch) ?? null;
  const a = Object.values(q.after ?? {}).filter((x) => x.branch === h.branch).sort((x, y) => x.at - y.at).pop() ?? null;
  const last = q.outcomes.filter((o) => o.branch === h.branch).pop() ?? null;
  if (json) { ctx.say(JSON.stringify({ entry, after: a, last }, null, 2)); return 0; }
  const now = Date.now();
  if (entry) ctx.say(`${P} ship: #${entry.pr} ${entry.state === "checking" ? `checks running, watched for ${ago(entry.since ?? entry.at, now).replace(/ ago$/, "")}${entry.land ? " (lands once green)" : " (PR only)"}` : entry.state === "waiting" ? "in the merge queue (rollcall queue status shows its place)" : `parked: ${entry.why}`}`);
  if (a && a.stage !== "done") ctx.say(`${P} ship: #${a.pr} landed as ${short(a.sha ?? "")}; ${a.stage === "deploys" ? "watching what the merge started" : `running the release step ${a.step}`} (since ${ago(a.at, now)})`);
  if (last) ctx.say(`${P} ship: last news ${ago(last.at, now)}: ${last.kind} - ${store.clip(last.text, 400)}`);
  if (!entry && !last && !a) ctx.say(`${P} ship: ${h.branch} has no ship`);
  return 0;
}
