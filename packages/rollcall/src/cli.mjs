// The CLI agents (and people) run: status, claim, done, send, wait, queue, results, allow-shared, allow-main,
// gc, clean, blockers, task, supervise, inbox and attach.
// It finds its own session by walking up its process ancestry to a harness pid
// the hooks recorded, so no session id is passed around.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gcRepo, gcRuntime, pruneRefs, summary } from "./gc.mjs";
import { gitSync, locate, mainCheckout, repoKey } from "./git.mjs";
import { matchScope } from "./glob.mjs";
import { ancestry, pidAlive } from "./proc.mjs";
import { parkAll, parkedLines } from "./park.mjs";
import { deleteListed, deleteListSeen, saveDeleteList, sizeOf, sweepLeftovers } from "./leftovers.mjs";
import { reminders, watchHome } from "./watch.mjs";
import { backText, comeBack, unparkHome, writeWindow } from "./window.mjs";
import { USAGE as QUEUE_USAGE, queueCommand } from "./queue.mjs";
import { USAGE as RESULTS_USAGE, results } from "./results.mjs";
import { USAGE as RUNTIME_USAGE, runtimeCommand } from "./runtime-cli.mjs";
import {
  P, ago, autoSummary, claimLabel, cli, doneLine, fileList, intentOf, isAlive, isDone, isLive, joinRepo, markDone,
  msgLine, peersOf, settle, short, who, whereOf,
} from "./session.mjs";
import * as store from "./store.mjs";
import { ensureWatcher, holderOf, homeOf, idOf, label, pickName, releaseHome, takeHome, taskEnv, workerState } from "./supervisor.mjs";
import { isOpen } from "./state.mjs";
import { closeBlocker, diskRunEnded, lines as troubleLines } from "./trouble.mjs";
import { USAGE as TASK_USAGE, mergeHold, mergeSeen, skillStamp, taskAt, taskCommand, visibleTasks } from "./task.mjs";
import { pickPictures } from "./pictures.mjs";
import * as tmux from "./tmux.mjs";

const USAGE = `rollcall - awareness for parallel agent sessions on one machine

  rollcall status [--json] [--all]       live sessions in this repo (--all: every repo); --json also lists tasks
  rollcall claim "<intent>" [--scope <glob>]...
                                         say what this session is working on
  rollcall done ["<summary>"]            release the claim; wakes sessions waiting on you
  rollcall send <session|all> "<msg>"    message another session (delivered on its next tool call or prompt)
  rollcall wait <session|claim> [--timeout <minutes>]
                                         block until that session runs done (run it in the background)
${QUEUE_USAGE}
${RESULTS_USAGE}
  rollcall allow-shared [--off]          let this session edit a checkout another session is using
  rollcall allow-main [--off]            let agents edit this repo's main checkout (default: worktrees only)
  rollcall gc [--dry-run] [--all]        remove merged, clean, unused worktrees under .claude/worktrees/
                                         (--all: every repo rollcall has seen), and what ended work left
                                         on the machine: DerivedData of projects that are gone, temp folders of
                                         sessions over for a day, test browsers whose session ended
  rollcall clean [--yes]                 the delete list for a low disk: folders only rebuildable, with sizes.
                                         It deletes nothing until --yes, which takes what the list shows
  rollcall remind "<text>" --in <30m|2h|1d>   a line for the owner later, for a step only they can take; bare: what is set
  rollcall blockers [clear <kind>]       what stops work on this Mac or account now (usage, billing, disk, power,
                                         memory), told to the owner once; clear: it is fixed, so what waits goes on
  rollcall park [--dry-run]              stop the sessions nothing needs, to free memory: a worker idle 15m whose
                                         task waits on a PR or the owner, and a falcon supervisor quiet 1h between
                                         turns (Enter in its tab resumes either; a supervisor's tasks' news brings
                                         it back too). Its watcher or a sweep at session start runs it;
                                         ROLLCALL_PARK=0 turns parking off
  rollcall supervise [<name>] [--off]    make this session supervisor <name> (default: the next free ship,
                                         falcon, venator, ...): its own tasks, workers in tmux, chips in the
                                         status line; it edits no project files. One live session per name.
                                         \`falcon\` (its own command) opens one with its tasks as tabs.
${TASK_USAGE}
${RUNTIME_USAGE}
  rollcall inbox                         in a task's worker: print the supervisor's unread messages
  rollcall attach <task> [--print]       show the task's worker (by name or id: luke, t3): its tab, inside
                                         falcon; else a new terminal tab on it (--print: the command only)
  rollcall api version | snapshot | stream | do <action> <json> | attach <home>[:<task>]
                                         the front-end interface, for apps over rollcall (JSON; see API.md)
  rollcall usage [--json] [--refresh]    each plan's room: Claude's five-hour and weekly limits, Codex's limits
  rollcall hook <event>                  hook entry point (stdin: the hook payload)

  -C <dir> runs any command as if started in <dir>.
  ROLLCALL_DISABLE=1 turns every hook into a no-op.`;

class Exit extends Error { constructor(code, msg) { super(msg); this.code = code; } }
// The rollcall-band protocol this rollcall expects (BAND_PROTOCOL in mods/rollcall-band/hooks/register.tsx, which the
// band reports with every `status --json --band <n>`): a band that reports less loaded before a sync and says so.
// 4: the band does no supervisor work (v3 moved it to hooks and the status line).
const BAND_PROTOCOL = 4;
const fail = (msg) => { throw new Exit(1, `rollcall: ${msg}`); };
const say = (s) => process.stdout.write(`${s}\n`);

export async function main(argv) {
  const args = [...argv];
  if (args[0] === "-C") { const dir = args[1]; args.splice(0, 2); try { process.chdir(dir); } catch { return usageError(`cannot cd to ${dir}`); } }
  const [cmd, ...rest] = args;
  try {
    switch (cmd) {
      case "status": return status(rest);
      case "claim": return claim(rest);
      case "done": return done(rest);
      case "send": return send(rest);
      case "wait": return await wait(rest);
      case "queue": return await queueCommand(rest, { say, fail, flag, whoAmI });
      case "land": return landGone(rest);
      case "results": return await results(rest, { say });
      case "allow-shared": return allowShared(rest);
      case "allow-main": return allowMain(rest);
      case "gc": return await gc(rest);
      case "clean": return await clean(rest);
      case "blockers": return blockers(rest);
      case "remind": return remind(rest);
      case "_pick-pictures": return await pickPictures(rest);
      case "codex-worker": return await (await import("./codex/worker.mjs")).codexWorker(rest);
      case "_codex-send": return await (await import("./codex/send.mjs")).codexSend(rest);
      case "usage": return await usage(rest);
      case "park": return parkCommand(rest);
      case "back": return back(rest);
      case "watch": return store.listHomes().includes(rest[0]) ? await watchHome(rest[0], { once: rest[1] === "--once" }) : usageError("usage: rollcall watch <supervisor> [--once]");
      case "task": return await taskCommand(rest, { say, fail, flag, whoAmI });
      case "ports": case "manifest": case "setup": case "run": case "serving": case "_setup": return await runtimeCommand(cmd, rest, { say, fail, flag });
      case "supervise": return supervise(rest);
      case "inbox": return inbox(rest);
      case "attach": return attach(rest);
      // The front-end interface (api.mjs), loaded only when asked for.
      case "api": return await (await import("./api-cli.mjs")).apiCommand(rest, { say, whoAmI });
      case undefined: case "help": case "-h": case "--help": say(USAGE); return 0;
      default: return usageError(`unknown command "${cmd}"`);
    }
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    if (e.message) process.stderr.write(`${e.message}\n`);
    return e.code;
  }
}

/**
 * `rollcall usage [--json] [--refresh]`: each plan's room before a turn fails on it (usage.mjs): Claude's five-hour and
 * weekly windows, from the last status line that had them, and Codex's limits (--refresh reads them now).
 */
async function usage(args) {
  const u = await import("./usage.mjs");
  if (args.includes("--refresh")) { const r = u.refreshCodex(Date.now(), { force: true }); if (r) await r; }
  if (args.includes("--json")) { say(JSON.stringify(u.usageOf(), null, 2)); return 0; }
  say(u.usageLine() || "no usage known yet: Claude's shows once a Claude Code session on a Pro or Max plan has answered; Codex's with --refresh");
  return 0;
}

/**
 * `rollcall back <name>`: what Enter runs in a parked supervisor's tab: takes it out of parking and writes the
 * script that brings it back there (window.mjs), which the tab then runs. Exit 1 when it was not parked (news
 * from its tasks brought it back first).
 */
function back(args) {
  const [h] = args;
  if (!h || args.length > 1) return usageError("usage: rollcall back <supervisor>");
  if (!store.listHomes().includes(h)) fail(`no supervisor named ${h}`);
  if (!unparkHome(h)) fail(`${h} is not parked`);
  writeWindow(h, comeBack(h), { prompt: backText(h) });
  return 0;
}

/** `rollcall park [--dry-run] [--quiet]`: parks what is due (park.mjs) and says what it parked. */
function parkCommand(args) {
  const dryRun = args.includes("--dry-run");
  const quiet = args.includes("--quiet");
  const rows = parkAll(Date.now(), { dryRun });
  if (!quiet) say(rows.length ? parkedLines(rows, { dryRun }).join("\n") : "nothing to park");
  return 0;
}

function usageError(msg) { process.stderr.write(`rollcall: ${msg}\n\n${USAGE}\n`); return 1; }

function flag(args, name) {
  const values = [];
  for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) {
    if (i + 1 >= args.length) fail(`${name} needs a value`);
    values.push(args[i + 1]);
    args.splice(i, 2);
  }
  return values;
}

// ---------------------------------------------------------------- identity

/** This process's agent session: ROLLCALL_SESSION, else the nearest ancestor pid a hook registered. */
function whoAmI() {
  const globals = store.listGlobals().filter((g) => !g.endedAt);
  const forced = process.env.ROLLCALL_SESSION;
  if (forced) return globals.find((g) => g.id === forced) ?? globals.find((g) => g.id.startsWith(forced)) ?? null;
  if (!globals.length) return null;
  for (const { pid } of ancestry(process.ppid)) {
    // Several ids on one pid (after /clear or /resume): the one most recently (re)started there.
    const hits = globals.filter((g) => g.pid === pid);
    if (hits.length) return hits.sort((a, b) => (b.detectedAt ?? b.startedAt) - (a.detectedAt ?? a.startedAt))[0];
  }
  return null;
}

function repoHere() {
  const info = locate(process.cwd());
  if (!info) fail("not inside a git checkout (cd into the repo, or pass -C <dir>)");
  return { info, repo: repoKey(info) };
}

/** Runs `fn(rec)` on this session's record under its lock (waiting up to ~1 s for a hook), then saves it. */
function withRecord(g, info, repo, fn) {
  const done = store.withLock(repo.key, g.id, () => {
    const rec = joinRepo(g, info, repo, Date.now(), "cwd");
    const out = fn(rec);
    store.writeRecord(repo.key, rec);
    return { out };
  }, { retries: 40 });
  if (!done) fail("session record is busy; try again");
  return done.out;
}

function requireSelf() {
  const g = whoAmI();
  if (!g) fail("can't tell which agent session this is. Run it from the agent's own shell (its Bash tool), or set ROLLCALL_SESSION=<session id>.");
  return g;
}

function resolveTarget(key, query, selfId) {
  const recs = store.listRecords(key).filter((r) => r.id !== selfId);
  const q = query.toLowerCase();
  let hits = recs.filter((r) => r.id.toLowerCase().startsWith(q));
  if (!hits.length) hits = recs.filter((r) => [r.lastIntent, r.firstPrompt, r.branch].some((s) => s?.toLowerCase().includes(q)));
  if (hits.length > 1) {
    const alive = hits.filter(isAlive);
    if (alive.length) hits = alive;
  }
  if (!hits.length) fail(`no session matches "${query}" (see rollcall status)`);
  if (hits.length > 1) fail(`"${query}" matches ${hits.length} sessions (${hits.map((r) => short(r.id)).join(", ")}); use a session id from rollcall status`);
  return hits[0];
}

// ---------------------------------------------------------------- status

function state(r, now) {
  if (r.endedAt) return `ended ${ago(r.endedAt, now)}`;
  if (!isLive(r, now)) return `stale, last active ${ago(r.seen, now)}`;
  return r.idle ? `idle, turn ended ${ago(r.idle, now)}` : `working, active ${ago(r.seen, now)}`;
}

function status(args) {
  // --context <pct>: the caller's context use (the band passes its session's), kept on its global record for `task list`.
  // --band <n>: the protocol of the rollcall-band running in the caller's session, which `supervise` checks.
  const [pct] = flag(args, "--context");
  const [band] = flag(args, "--band");
  const info = locate(process.cwd());
  const keys = args.includes("--all") || !info ? store.listRepoKeys() : [repoKey(info).key];
  const g = whoAmI();
  const me = g?.id;
  const now = Date.now();
  const report = {
    ...(pct !== undefined && Number.isFinite(Number(pct)) ? { context: { pct: Math.round(Number(pct)), at: now } } : {}),
    ...(band !== undefined && Number.isInteger(Number(band)) ? { band: { v: Number(band), at: now } } : {}),
  };
  if (g && Object.keys(report).length) store.writeGlobal({ ...g, ...report });
  const repos = keys.map((key) => {
    const recs = store.listRecords(key);
    const sessions = recs.filter(isAlive).sort((a, b) => (b.id === me) - (a.id === me) || a.since - b.since).map((r) => ({
      id: r.id, you: r.id === me, harness: r.harness, pid: r.pid, checkout: r.checkout, main: r.main,
      branch: r.branch, live: isLive(r, now), idle: r.idle, since: r.since, seen: r.seen, endedAt: r.endedAt,
      intent: intentOf(r), claim: r.claim, firstPrompt: r.firstPrompt, touched: store.readTouched(key, r.id), waits: r.waits,
    }));
    const done = store.readAllEvents(key).filter((e) => e.type === "done" && now - e.ts < 2 * 3600_000).slice(-5);
    return { key, name: recs.find((r) => r.repoName)?.repoName ?? key, sessions, done };
  }).filter((r) => r.sessions.length || r.done.length);

  if (args.includes("--json")) {
    // The task this session works on (its worker's environment, or its checkout is a task's worktree), and a supervisor's tasks.
    const env = taskEnv();
    const mine = env ? store.readTask(env.home, env.id) : info ? taskAt(info.top) : null;
    const home = g ? homeOf(g.id) : null;
    const tasks = home ? visibleTasks(home, { now }).map((t) => ({
      id: t.id, title: t.title, kind: t.kind ?? "build", state: t.state, stateAt: t.stateAt ?? t.updatedAt, question: t.question,
      pr: t.pr, repo: t.repo.name, branch: t.branch, worker: workerState(t, now), updatedAt: t.updatedAt,
    })) : [];
    const bandNow = report.band?.v ?? g?.band?.v ?? null;
    // bandProtocol: what this rollcall expects of a band, so a band that loaded before a sync can see it is older.
    // `supervisor` stays false: a v2 band that sees true routes @t3 lines and opens pickers the v2 way.
    say(JSON.stringify({ me: g ? { id: g.id, supervisor: false, home, mode: g.mode ?? null, task: mine?.id ?? null, band: bandNow } : null, bandProtocol: BAND_PROTOCOL, repos, tasks }, null, 2));
    return 0;
  }
  if (!repos.length) { say(info ? "rollcall: no live sessions in this repo" : "rollcall: no live sessions"); return 0; }
  for (const { name, sessions, done } of repos) {
    say(`${name} - ${sessions.length} session${sessions.length === 1 ? "" : "s"}`);
    for (const s of sessions) {
      say(`${s.you ? "*" : " "} ${short(s.id)}  ${s.branch ?? "?"}  ${whereOf(s)}  ${state(s, now)}${s.harness === "codex" ? "  [codex]" : ""}${s.you ? "  <- you" : ""}`);
      say(`    ${s.claim ? `claim: ${claimLabel(s.claim.intent, s.claim.scope)}` : s.intent}`);
      if (s.touched.length) say(`    edited: ${fileList(s.touched, 5)}`);
      if (s.waits?.length) say(`    waiting on: ${s.waits.map(short).join(", ")}`);
    }
    for (const e of done) say(`  done ${ago(e.ts, now)}: ${e.who} - ${e.summary}`);
  }
  return 0;
}

// ---------------------------------------------------------------- claim / done

function claim(args) {
  // Commas separate scopes, except inside {a,b} braces.
  const scope = flag(args, "--scope").flatMap((s) => s.split(/,(?![^{]*\})/)).map((s) => s.trim()).filter(Boolean);
  // Capped here too: the intent also lives on the record, which every peer reads.
  const intent = store.clip(store.oneLine(args.join(" ")));
  if (!intent) fail('usage: rollcall claim "<intent>" [--scope <glob>]...');
  const g = requireSelf();
  const { info, repo } = repoHere();
  withRecord(g, info, repo, (rec) => {
    rec.claim = { intent, scope, at: Date.now() };
    rec.lastIntent = intent;
    store.appendEvent(repo.key, { type: "claim", session: g.id, who: who(rec), intent, scope });
  });
  say(`claimed: ${claimLabel(intent, scope)}`);
  if (!scope.length) return 0;
  for (const r of peersOf(repo.key, g, { alive: true })) {
    const hits = store.readTouched(repo.key, r.id).filter((f) => matchScope(scope, f));
    if (hits.length) say(`heads-up: ${who(r)} ("${intentOf(r)}") already edited ${fileList(hits)} inside that scope`);
  }
  return 0;
}

function done(args) {
  const g = requireSelf();
  const { info, repo } = repoHere();
  const summary = withRecord(g, info, repo, (rec) => {
    const s = store.oneLine(args.join(" ")) || autoSummary(rec, store.readTouched(repo.key, g.id));
    markDone(repo.key, rec, s, { doneAt: Date.now() });
    return s;
  });
  say(`done: ${summary}`);
  return 0;
}

// ---------------------------------------------------------------- send / wait

function send(args) {
  const [target, ...words] = args;
  const text = words.join(" ").trim();
  if (!target || !text) fail('usage: rollcall send <session|all> "<message>"');
  const { info, repo } = repoHere();
  const g = whoAmI();
  const from = g ? withRecord(g, info, repo, (rec) => who(rec)) : "a shell outside any agent session";
  const to = target === "all" ? null : resolveTarget(repo.key, target, g?.id);
  store.appendEvent(repo.key, { type: "msg", session: g?.id ?? "user", who: from, to: to ? to.id : "all", text });
  if (!to) { say("sent to every session in this repo"); return 0; }
  say(`sent to ${who(to)}`);
  if (!isLive(to) || to.idle) say("it is idle: it sees the message on its next tool call or prompt (or now, if it is running rollcall wait)");
  return 0;
}

async function wait(args) {
  const timeout = Number(flag(args, "--timeout")[0] ?? 0);
  const query = args.join(" ").trim();
  if (!query) fail("usage: rollcall wait <session|claim> [--timeout <minutes>]");
  const { info, repo } = repoHere();
  const g = whoAmI();
  const target = resolveTarget(repo.key, query, g?.id);
  if (isDone(target)) {
    const last = store.readAllEvents(repo.key).filter((e) => e.type === "done" && e.session === target.id).pop();
    say(`${P} ${who(target)} is already done: ${last?.summary ?? intentOf(target)}`);
    return 0;
  }
  let cursor = store.logEnd(repo.key);
  if (g) {
    withRecord(g, info, repo, (rec) => {
      if (!rec.waits.includes(target.id)) rec.waits.push(target.id);
      store.appendEvent(repo.key, { type: "wait", session: g.id, who: who(rec), target: target.id, intent: intentOf(target) });
    });
  }
  // Once the target is finished (or gone) this session no longer depends on it, and its hooks never repeat
  // the done just printed. Best effort: a busy record must not turn a successful wait into a failure.
  const release = (code, e) => {
    try {
      if (g) withRecord(g, info, repo, (rec) => { if (e) settle(rec, e); else rec.waits = rec.waits.filter((id) => id !== target.id); });
    } catch {}
    return code;
  };
  const poll = Number(process.env.ROLLCALL_WAIT_POLL_MS) || 1000;
  const deadline = timeout > 0 ? Date.now() + timeout * 60_000 : Infinity;
  for (;;) {
    const r = store.readEventsSince(repo.key, cursor);
    cursor = r.cursor;
    for (const e of r.events) {
      if (e.type === "done" && e.session === target.id) { say(doneLine(e)); return release(0, e); }
      if (g && e.type === "msg" && e.to === g.id && e.session !== g.id) {
        say(msgLine(e, " while you waited"));
        say(`${P} still waiting on ${short(target.id)}: run rollcall wait ${short(target.id)} again to keep waiting.`);
        return 0;
      }
    }
    const cur = store.readRecord(repo.key, target.id);
    if (!cur || cur.endedAt || (cur.pid && !pidAlive(cur.pid, cur.pidStart))) {
      say(`${P} ${who(target)} ended without running rollcall done (its process is gone).`);
      return release(2);
    }
    if (g?.pid && !pidAlive(g.pid, g.pidStart)) return 3; // our own session is gone: nobody left to wake
    if (Date.now() > deadline) { say(`${P} stopped waiting for ${who(target)} after ${timeout} min.`); return 124; }
    await sleep(poll);
  }
}

// ---------------------------------------------------------------- land (gone)

/**
 * The landing queue gave way to the merge queue; for one release the old command says where to go. A ship
 * that started on the old /pr-create reads this mid-ship, so it says what each old step becomes.
 */
function landGone(args) {
  if (args.includes("--abort")) {
    process.stdout.write(`${P} land: nothing to leave: the landing queue is gone. A PR in the merge queue leaves with rollcall queue leave "<why>".\n`);
    return 0;
  }
  process.stderr.write([
    "rollcall: `rollcall land` is gone; ships land through the merge queue now. If this ship started on the old /pr-create, carry on from where you are:",
    "  - Nothing waits on another ship: run your gates now, on this branch as it is, and merge no other branch in ahead of time.",
    "  - Before a push: git fetch origin && git merge-tree --write-tree --name-only HEAD origin/<default>. Exit 1 lists conflicts: merge origin/<default> first. Exit 0: push as it is.",
    "  - To merge: never gh pr merge. Once the PR is open, pushed and green, rollcall queue add, then rollcall queue wait in the background, and do what its line says (landed, conflict, failed, left, parked).",
    "  - The new steps in full: /pr-create Steps 1, 4 and 6 (~/.claude/kesselrunner/skills/pr-create/SKILL.md, which changed). rollcall queue --help lists the commands.",
  ].join("\n") + "\n");
  return 1;
}

// ---------------------------------------------------------------- allow-shared

function allowShared(args) {
  const off = args.includes("--off");
  const g = requireSelf();
  const { info, repo } = repoHere();
  withRecord(g, info, repo, (rec) => {
    rec.allowShared = off ? rec.allowShared.filter((p) => p !== info.top) : [...new Set([...rec.allowShared, info.top])];
  });
  say(off
    ? `rollcall: edits in ${info.top} are blocked again while another session works there.`
    : `rollcall: this session may now edit ${info.top} alongside other sessions (undo: rollcall allow-shared --off).`);
  return 0;
}

// ---------------------------------------------------------------- allow-main

/** Agents edit a repo's main checkout only when its shared git config says so (every worktree reads the same value). */
function allowMain(args) {
  const { info, repo } = repoHere();
  const off = args.includes("--off");
  const r = gitSync(info.top, ["config", ...(off ? ["--unset", "rollcall.mainEdits"] : ["rollcall.mainEdits", "allow"])]);
  if (r.status !== 0 && !(off && r.status === 5)) fail(`git config failed: ${r.stderr.trim()}`); // 5: already unset
  say(off
    ? `rollcall: agents edit ${repo.name} in worktrees again; the main checkout is blocked for them.`
    : `rollcall: agents may now edit the main checkout of ${repo.name} (undo: rollcall allow-main --off).`);
  return 0;
}

// ---------------------------------------------------------------- supervise

/**
 * Supervisor mode for this session: it holds the named home (one live session per name), its edit tools are
 * denied inside any git checkout (the hooks read the flag), its home's watcher hands it its tasks' news, and
 * its status line draws their chips. A second session asking for a name already held is refused.
 */
function supervise(args) {
  if (args.includes("--help") || args.includes("-h")) { say(USAGE); return 0; }
  const off = args.includes("--off");
  const [named] = flag(args, "--name");
  const name = named ?? args.find((a) => !a.startsWith("-"));
  const g = requireSelf();
  if (off) {
    releaseHome(g);
    store.writeGlobal({ ...g, supervisor: null });
    say("rollcall: supervisor mode off; edits are allowed again (subject to the usual worktree rules). The tasks and their workers stay.");
    return 0;
  }
  const h = name ?? homeOf(g.id) ?? pickName();
  if (!store.HOME_NAME.test(h)) fail(`a supervisor name is lowercase letters, digits and -, starting with a letter (like alpha): "${h}"`);
  const took = takeHome(g, h);
  if (!took.ok) {
    if (!took.holder) fail(`supervisor ${h}'s lock is busy; try again`);
    fail(`supervisor ${h} is running in session ${short(took.holder.id)}, so this session stays a plain one. It can read ${h}'s tasks (rollcall task list --home ${h}); another name starts another supervisor (rollcall supervise <name>).`);
  }
  store.writeGlobal({ ...g, supervisor: { home: h, at: g.supervisor?.home === h ? g.supervisor.at : Date.now(), skill: skillStamp() ?? undefined } });
  ensureWatcher(h);
  say(`rollcall: this session (${short(g.id)}) is supervisor ${h}: no edits inside git checkouts; its workers run in tmux (session ${tmux.sessionName(h)}), its chips in the status line.`);
  if (!tmux.available()) say("  tmux is not installed, so no worker can start: the owner runs `brew install tmux` once.");
  else if (tmux.inside() && tmux.windowOf(h, h)) say(`  Tabs: each task gets a tab in the bar at the bottom of this terminal. The owner clicks one to switch to that worker and clicks ${h} to come back; /attach t3 switches too.`);
  else say(`  Tabs: this supervisor runs outside falcon, so /attach t3 opens a terminal tab per task, and news reaches it with the owner's next line, since nothing can type into this terminal. For tabs in one terminal, the owner quits this session (/exit) and runs \`falcon resume ${h}\` in a terminal tab.`);
  const open = store.listTasks(h).filter(isOpen);
  const legacy = open.filter((t) => workerState(t)?.legacy);
  say(open.length ? `  ${open.length} open task${open.length === 1 ? "" : "s"}: rollcall task list` : "  no open tasks");
  if (legacy.length) say(`  ${legacy.map((t) => t.id).join(", ")} still ${legacy.length === 1 ? "has a v2 worker" : "have v2 workers"} (claude --bg): \`start.mjs <id> --resume "<why>"\` moves one into tmux with its context, when there is work for it.`);
  // Other supervisors running, and those with open work, so a list split across tabs is not lost.
  const count = (n, what) => `${n} ${what}${n === 1 ? "" : "s"}`;
  const others = store.listHomes().filter((x) => x !== h)
    .map((x) => ({ x, running: !!holderOf(x), open: store.listTasks(x).filter(isOpen).length }))
    .filter((o) => o.running || o.open);
  if (others.length) {
    const what = (o) => [o.running && "running", o.open && count(o.open, "open task")].filter(Boolean).join(", ");
    say(`  other supervisors: ${others.map((o) => `${o.x} (${what(o)})`).join("; ")}. Each keeps its own; \`rollcall task list --home <name>\` shows one.`);
  }
  return 0;
}

// ---------------------------------------------------------------- inbox / attach

/** In a worker: the supervisor's unread messages, oldest first; each is marked read once printed. */
function inbox() {
  const env = taskEnv();
  const t = env ? store.readTask(env.home, env.id) : taskAt(process.cwd());
  if (!t) fail("this is not a task's worker (no task in its environment or worktree)");
  const unread = store.unreadInbox(t.home, t.id);
  if (!unread.length) { say(`${P} no unread messages for ${t.id}.`); return 0; }
  for (const m of unread) {
    say(`--- from supervisor ${t.home}, ${ago(m.at)} (the supervisor's words, not the owner's)\n${m.text.trim()}`);
    store.markRead(t.home, t.id, m.name);
  }
  say(`${P} To answer the supervisor: ${cli()} task note ${t.id} "reply: <answer>" (the supervisor hears it). What you write in this window reaches no one.`);
  return 0;
}

/**
 * Opens a terminal tab on a task's worker: a tmux view of its window that goes away when the tab closes.
 * Warp (a tab config), iTerm and Terminal are opened directly; elsewhere the command is printed to run.
 */
function attach(args) {
  const print = args.includes("--print");
  const word = args.find((a) => !a.startsWith("-"));
  const id = word && (idOf(word) ?? word.toLowerCase());
  if (!id) fail("usage: rollcall attach <task, e.g. luke or t3>");
  const g = whoAmI();
  const env = taskEnv();
  const h = (g && homeOf(g.id)) || env?.home || store.listHomes().find((x) => store.readTask(x, id));
  const t = h ? store.readTask(h, id) : null;
  if (!t) fail(`no task ${id}${h ? ` in supervisor ${h}` : ""}`);
  if (!tmux.windowOf(h, t.id)) fail(`${label(t)} has no worker window: start or resume its worker first (start.mjs ${t.id} --resume "<why>").`);
  const command = tmux.attachCommand(h, t.id);
  if (print) { say(command); return 0; }
  // Inside falcon a terminal already shows this home's session: switch its tab, as a click would.
  if (tmux.clients(h).length && tmux.select(h, t.id)) { say(`Switched to ${label(t)}. Click ${h} in the tab bar to come back.`); return 0; }
  const term = process.env.TERM_PROGRAM ?? "";
  const osa = (...lines) => spawnSync("osascript", lines.flatMap((l) => ["-e", l]), { stdio: "ignore", timeout: 10_000 }).status === 0;
  const apple = (x) => `"${x.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  let opened = false;
  if (term === "WarpTerminal") {
    // A Warp Tab Config runs its commands when the tab opens; warp://tab_config/<name> opens it in this window.
    const dir = join(homedir(), ".warp", "tab_configs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollcall_attach.toml"), `name = "rollcall attach"\n\n[[panes]]\nid = "main"\ntype = "terminal"\ndirectory = ${JSON.stringify(t.worktree)}\ncommands = [${JSON.stringify(command)}]\n`);
    opened = spawnSync("open", ["warp://tab_config/rollcall_attach"], { stdio: "ignore", timeout: 10_000 }).status === 0;
  } else if (term === "iTerm.app") {
    opened = osa(`tell application "iTerm2" to tell current window to create tab with default profile command ${apple(`/bin/zsh -lc ${JSON.stringify(command)}`)}`);
  } else if (term === "Apple_Terminal") {
    opened = osa(`tell application "Terminal" to do script ${apple(command)}`, 'tell application "Terminal" to activate');
  }
  say(opened
    ? `Opened ${label(t)} in a new tab. Answer it there, then close the tab (Cmd+W) to come back; the worker keeps running.`
    : `Run this in a new terminal tab to reach ${label(t)} (closing the tab leaves the worker running):\n${command}`);
  return 0;
}

// ---------------------------------------------------------------- gc

/**
 * Removes worktrees whose work already landed (see gc.mjs for the rules).
 * `--report` is the hooks' background mode: quiet, and the summary is saved for
 * the repo's next SessionStart instead of printed. `--after-pid` waits (up to
 * 10 min) for that process to exit first: SessionEnd passes the harness's.
 */
async function gc(args) {
  const dryRun = args.includes("--dry-run");
  const report = args.includes("--report");
  const afterPid = Number(flag(args, "--after-pid")[0]);
  for (const end = Date.now() + 10 * 60_000; afterPid > 1 && pidAlive(afterPid) && Date.now() < end;) await sleep(1000);
  const here = args.includes("--all") ? null : repoHere();
  const out = [];
  for (const key of here ? [here.repo.key] : store.listRepoKeys()) {
    const recs = store.listRecords(key);
    const main = here ? mainCheckout(here.info) : recs.map((r) => r.main).find((m) => m && existsSync(m));
    if (!main) continue;
    const name = here?.repo.name ?? recs.find((r) => r.repoName)?.repoName ?? key;
    const release = store.lockGc(key);
    if (!release) { if (!report) out.push(`${name}: another gc is running here; skipped`); continue; }
    // Any session whose process still runs keeps its checkout, however long it has been idle.
    const live = recs.filter(isAlive).map((r) => r.checkout);
    // An open task keeps its worktree whatever else holds; one whose work is on main is marked landed and collected,
    // unless its worker still runs or it waits on the owner.
    const tasks = store.listTasks().filter((t) => isOpen(t) && t.repo?.key === key);
    const task = (path) => {
      const t = tasks.find((x) => x.worktree === path);
      return t ? { id: t.id, state: t.state, baseSha: t.baseSha ?? null, land: (why, head) => mergeSeen(t, { why, head }), hold: (head) => mergeHold(t, head) } : null;
    };
    let res;
    let refs = 0;
    try {
      res = gcRepo(main, { dryRun, occupied: (path) => live.includes(path), task, runtime: await gcRuntime() });
      if (!dryRun && store.claimRefsSlot(key)) refs = pruneRefs(main, { queued: Object.keys(store.readQueue(key).entries) });
    } finally { release(); }
    const line = summary(name, res, { dryRun });
    if (refs && !report) out.push(`${name}: pruned ${refs} old ref${refs === 1 ? "" : "s"}`);
    if (report) { if (line) store.appendGcReport(key, line); continue; }
    if (line) out.push(line);
    for (const k of res.kept) out.push(`  kept ${k.name}${k.branch ? ` (${k.branch})` : ""}: ${k.why}`);
  }
  // Once an hour on this machine from the background; a gc by hand always looks.
  if (!report || store.claimLeftoversSlot()) {
    const { line } = sweepLeftovers({ dryRun });
    if (line && report && here) store.appendGcReport(here.repo.key, line);
    if (line && !report) out.push(line);
  }
  if (!report) say(out.length ? out.join("\n") : "rollcall: no worktrees to collect");
  return 0;
}

// ---------------------------------------------------------------- clean / blockers

/**
 * `rollcall clean`: prints what could go on a low disk, and with --yes deletes what it showed in the last day (a --yes
 * on a list the owner has not seen prints it instead, so nothing goes unseen). The watcher
 * starts `--low-disk` when the disk runs low (every repo's gc, the leftovers, then the list and the owner's one
 * notice) and `--sweep` when memory does (the leftovers alone: test browsers nothing uses).
 */
async function clean(args) {
  if (args.includes("--sweep")) { sweepLeftovers(); return 0; }
  if (args.includes("--low-disk")) {
    const swept = sweepLeftovers();
    await gc(["--all", "--report"]);
    const { items, total } = saveDeleteList();
    diskRunEnded({ freed: swept.kb ? sizeOf(swept.kb) : null, found: items.length ? total : null });
    return 0;
  }
  const yes = args.includes("--yes");
  if (!yes || !deleteListSeen()) {
    const { items } = saveDeleteList({ shown: true });
    say(items.length ? readFileSync(store.cleanListPath(), "utf8").trimEnd() : "rollcall: nothing on the delete list");
    if (yes && items.length) say("rollcall: nothing deleted yet, as this list had not been shown. rollcall clean --yes again deletes it.");
    return 0;
  }
  const gone = deleteListed();
  say(gone.length ? [`rollcall: deleted ${gone.length} folder${gone.length === 1 ? "" : "s"} (${sizeOf(gone.reduce((s, x) => s + x.kb, 0))})`, ...gone.map((x) => `  ${x.path}`)].join("\n") : "rollcall: nothing deleted: run rollcall clean first to see the list");
  return 0;
}

const UNITS = { m: 60_000, h: 3600_000, d: 86400_000 };

/** `rollcall remind "<text>" --in <30m|2h|1d>`: a line for the owner later, for a step only they can take. Bare: what is set. */
function remind(args) {
  const g = whoAmI();
  const h = taskEnv()?.home ?? (g && homeOf(g.id));
  if (!h) fail("this session supervises nothing: run it in a supervisor or a worker");
  const [wait] = flag(args, "--in");
  const text = store.oneLine(args.join(" "));
  if (!text) {
    const set = reminders(h);
    say(set.length ? set.map((r) => `${new Date(r.at).toLocaleString()}: ${r.text}`).join("\n") : "rollcall: no reminders set");
    return 0;
  }
  const m = /^(\d+(?:\.\d+)?)([mhd])$/.exec(wait ?? "");
  if (!m) fail('usage: rollcall remind "<text>" --in <30m|2h|1d>');
  const at = Date.now() + Number(m[1]) * UNITS[m[2]];
  if (!store.withHomeLock(h, () => store.writeHomeFile(h, "reminders", [...reminders(h), { at, text: store.clip(text, 300) }]))) fail("the supervisor's files are busy; try again");
  ensureWatcher(h);
  say(`rollcall: the owner hears this ${new Date(at).toLocaleString()}: ${store.clip(text, 120)}`);
  return 0;
}

/** `rollcall blockers`: what stops work now. `clear <kind>`: the owner says it is fixed, so what waits on it goes on. */
function blockers(args) {
  if (args[0] === "clear") {
    const kind = args[1];
    if (!kind) fail("usage: rollcall blockers clear <usage|billing|disk|power|memory>");
    say(closeBlocker(kind) ? `rollcall: ${kind} cleared; what waited on it goes on. If the cause is still there, the blocker opens again.` : `rollcall: nothing open for ${kind}`);
    return 0;
  }
  if (args.length) return usageError(`blockers: unknown argument "${args[0]}"`);
  const open = troubleLines();
  say(open.length ? open.join("\n") : "rollcall: nothing is blocking work");
  return 0;
}
