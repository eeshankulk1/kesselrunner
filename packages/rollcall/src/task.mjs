// Tasks: work in flight that outlives any one session. A supervisor creates one for each piece of work the
// owner asks for; worker sessions come and go (a fresh one when a task outgrows a session), and the record
// keeps what the next one needs: the owner's words verbatim, notes (decisions, handoffs), state, branch, PR
// and the last worker's report. Each task lives in its supervisor's home (store.mjs) with an id from that
// home's own counter, and names its repo. The record is the only home of in-flight work: ideas stay in a
// backlog, committed future work in issues, and what shipped in the PR and worklog.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asksText, promptAuthor } from "./asked.mjs";
import { defaultBranch, fetchSync, gitSync, locate, mainCheckout, mainSha, repoKey } from "./git.mjs";
import { P, ago, cli, short } from "./session.mjs";
import { STATES, allowed, isOpen, transition } from "./state.mjs";
import * as store from "./store.mjs";
import { WAITABLE, openBlocker, openBlockers, waitLabel } from "./trouble.mjs";
import { EFFORTS, START, deliverWords, clearCap, closing, effortOk, ensureWatcher, homeOf, holderOf, idOf, label, modelOk, nameOf, startingMs, stopWorker, taskEnv, tell, workerState } from "./supervisor.mjs";

const TYPES = ["feat", "fix", "refactor", "test", "docs"];
/** build: a change that ships; discuss: research and a recommendation the owner talks through (start.mjs briefs each its own way). */
const KINDS = ["build", "discuss"];
/** A worker's report in these states is news: the watcher tells the owner, or hands it to the supervisor's model. */
const NEWS = new Set(["needs-you", "pr-open", "landed", "closed"]);
// A worker's "reply: on it" answers nothing: it stays on the record and wakes no one.
const BARE_REPLY = /^reply:\s*(on it|ok|okay|got it|will do|working on it|sure|ack|understood|noted|thanks)[.!]*$/i;

/** The supervisor skill that ships beside this rollcall (kesselrunner's skills/supervisor). */
export const SKILL = process.env.ROLLCALL_SUPERVISOR_SKILL || fileURLToPath(new URL("../../../skills/supervisor/SKILL.md", import.meta.url));

/** A stamp of the skill's text, or null where it is missing (rollcall without kesselrunner around it). */
export function skillStamp() {
  try { return createHash("sha1").update(readFileSync(SKILL)).digest("hex").slice(0, 12); } catch { return null; }
}
/** The owner's words are kept whole (a pasted brief can be long), within reason. */
const MAX_WORDS = 50_000;
const MAX_NOTE = 4000;

/** Text an agent wrote goes on the record whole or comes back with the limit: relayed questions once lost their ends without a word. */
const overLimit = (what, text, limit) => (text.length > limit ? `${what} is ${text.length} characters, over the limit of ${limit}` : null);

export const USAGE = `  rollcall task new "<title>" [--repo <dir>] [--words "<text>" | --words-file <f>] [--note "<text>"]...
                    [--slug <s>] [--type feat|fix|refactor|test|docs] [--kind build|discuss] [--base <ref|task>]
                    [--after <id>]... [--until landed] [--hold] [--ship] [--no-worktree | --no-repo | --worktree <dir>]
                    [--browser] [--model <m>] [--effort <e>]
                                         record a task in this supervisor's home and create its worktree
                                         (--after: rollcall starts it once those tasks have a PR, or with
                                         --until landed once they have landed; --hold: it stays unstarted
                                         until start.mjs runs, on the owner's word)
                                         (--ship: the owner already said to ship it: no ship question, unless
                                         the change is visible or goes beyond the ask)
                                         (--worktree: take over one that exists, on its branch; --no-repo: a
                                         job on the machine, in a plain folder, with no repo and no PR)
                                         (--browser: its worker gets the browser MCP servers even where the
                                         repo's test manifest shows nothing a browser could test; --model and
                                         --effort: its workers run on these instead of the harness's own)
  rollcall task list [--all] [--json]    this supervisor's open tasks (--all: finished ones too)
  rollcall task show <id|here> [--json]  one task: the owner's words, notes, sessions, output
  rollcall task set <id|here> [--state working|needs-you|pr-open|queued|landed|closed] [--question "<q>"]
                    [--pr <url>] [--title "<t>"] [--kind build|discuss]
                                         a worker's report; needs-you reaches its supervisor, the rest its owner
                                         (--kind: a discussion turned build, or back; its worker is re-briefed)
  rollcall task words <id|here> "<text>"    add the owner's words, verbatim (closes the task's open question)
  rollcall task note <id|here> "<text>"     add a note (a decision; "grew: ..." and "reply: ..." reach the supervisor);
                                         with --home <name>, a supervisor's note into another's task, which its worker hears
  rollcall task stage <id|here> "<stage>" | done   the ship's stage now, for its tab: minutes against the usual time
  rollcall task output <id|here> ["<text>" | --file <f>]   save the worker's final report
  rollcall task handoff <id|here> ["<text>" | --file <f>]  a worker's handoff: rollcall starts a fresh worker from it
  rollcall task wait-for <id|here> <disk|power|billing|"<check command>"> [--every <minutes>] [--why "<what it waits on>"]
                                         end your turn after this: your worker parks and comes back once the
                                         check exits 0 (it runs in your worktree, read-only by contract) or the
                                         blocker clears, which rollcall tells the owner of once
  rollcall task tell <id> "<text>" | -      the supervisor's message to the worker: its inbox, and a doorbell
  rollcall task relay <id> [-]              the owner's last line to the supervisor, typed into the worker word for
                                         word (their say-so, as an @ line carries it); with -, only the part of
                                         that line on stdin
  rollcall task close <id|here> ["<why>"]   finish a task that lands nothing
  rollcall task move <id> --to <home>       hand a task to another supervisor (its worker stops; resume it there)
  rollcall task decisions [add "<decision>" [--where "<how the owner answers>"] [--from <task>] | done <n> ["<answer>"]]
                                         what waits on the owner beyond any one task, one list for every
                                         supervisor: listed until answered
  Every task command takes --home <name>; a worker's own task and a supervisor's home need none.`;

const helpWanted = (args) => args.includes("--help") || args.includes("-h");

/** `ctx`: the CLI's { say, fail, flag, whoAmI }. */
export function taskCommand(args, ctx) {
  const [sub, ...rest] = args;
  const fn = COMMANDS[sub];
  // --help anywhere prints usage: `task set --help` once read "--help" as a task id.
  if (!fn || helpWanted(rest)) { ctx.say(`usage:\n${USAGE}`); return fn || [undefined, "help", "--help", "-h"].includes(sub) ? 0 : 1; }
  const [home] = ctx.flag(rest, "--home");
  if (home !== undefined && !store.HOME_NAME.test(home)) ctx.fail(`--home is a supervisor name: lowercase letters, digits and -, like alpha`);
  return fn(rest, { ...ctx, home });
}

// ---------------------------------------------------------------- lookups

/** The open task whose worktree holds `dir`, else the newest finished one there (any home). */
export function taskAt(dir) {
  const info = locate(dir);
  if (!info) return null;
  const here = store.listTasks().filter((t) => t.worktree === info.top).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return here.filter(isOpen).pop() ?? here.pop() ?? null;
}

/** The home a command means: --home, else the worker's own task's, else the one this session supervises. */
function homeFor(ctx) {
  if (ctx.home) return ctx.home;
  const env = taskEnv();
  if (env) return env.home;
  const g = ctx.whoAmI();
  return (g && homeOf(g.id)) || null;
}

function resolve(id, ctx) {
  if (!id) ctx.fail("which task? (a name like luke, an id like t3, or `here` inside a task's worktree)");
  if (id === "here") {
    const env = taskEnv();
    const t = env && !ctx.home ? store.readTask(env.home, env.id) : taskAt(process.cwd());
    if (!t) ctx.fail("this folder is not a task's worktree (rollcall task list)");
    return t;
  }
  const tid = idOf(id) ?? id.toLowerCase();
  const h = homeFor(ctx);
  if (h) {
    const t = store.readTask(h, tid);
    if (!t) ctx.fail(`no task ${tid} in supervisor ${h} (rollcall task list)`);
    return t;
  }
  const hits = store.listHomes().map((x) => store.readTask(x, tid)).filter(Boolean);
  if (hits.length === 1) return hits[0];
  ctx.fail(hits.length ? `${tid} is a task of ${hits.map((t) => t.home).join(" and ")}: pass --home <name>` : `no task ${tid} (rollcall task list)`);
}

/** Read-modify-write of one task under its home's lock. */
function update(t0, ctx, fn) {
  const r = store.withTasksLock(t0.home, () => {
    const t = store.readTask(t0.home, t0.id);
    if (!t) return null;
    fn(t);
    store.writeTask(t);
    return t;
  });
  if (!r) ctx.fail("the task store is busy; try again");
  if (!r.out) ctx.fail(`no task ${t0.id}`);
  return r.out;
}

/** Who is writing: the task's supervisor, one of its workers, or someone else. */
function author(t, g) {
  const env = taskEnv();
  if (env?.home === t.home && env.id === t.id) return "worker";
  if (!g) return "a shell";
  if (homeOf(g.id) === t.home) return "supervisor";
  return t.sessions.some((s) => s.id === g.id) ? `worker ${short(g.id)}` : `session ${short(g.id)}`;
}

/** Another supervisor never writes to a task that is not its own (one once guessed the next id). */
function mayWrite(t, g, ctx) {
  const mine = g && homeOf(g.id);
  if (mine && mine !== t.home) ctx.fail(`${t.id} is supervisor ${t.home}'s task, not this one's (${mine}): only ${t.home} and the task's workers write to it`);
}

// ---------------------------------------------------------------- new

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";

/**
 * What `--base` means: a task's id or name stands for its branch, which need not be on origin yet; anything
 * else is a git ref. A base that does not resolve stops `task new` before it writes a record.
 */
function baseRef(arg, main, h, ctx) {
  const id = idOf(arg);
  const parent = id && store.readTask(h, id);
  if (parent && !parent.branch) ctx.fail(`--base ${arg}: ${parent.id} works in the main checkout, so it has no branch to start from`);
  const ref = parent?.branch ?? arg;
  if (gitSync(main, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status !== 0) ctx.fail(`--base ${arg}: ${main} has no commit or branch ${ref}. A task that has not pushed goes by its id (--base t4); nothing was created`);
  return ref;
}

function create(args, ctx) {
  const json = take(args, "--json");
  const noWorktree = take(args, "--no-worktree");
  const browser = take(args, "--browser");
  const hold = take(args, "--hold");
  const ship = take(args, "--ship");
  const noRepo = take(args, "--no-repo");
  const [until] = ctx.flag(args, "--until");
  const [dir] = ctx.flag(args, "--repo");
  const [slugArg] = ctx.flag(args, "--slug");
  const [type = "feat"] = ctx.flag(args, "--type");
  const [kind = "build"] = ctx.flag(args, "--kind");
  const [baseArg] = ctx.flag(args, "--base");
  const [wordsArg] = ctx.flag(args, "--words");
  const [wordsFile] = ctx.flag(args, "--words-file");
  const notes = ctx.flag(args, "--note");
  const [model] = ctx.flag(args, "--model");
  const [effort] = ctx.flag(args, "--effort");
  const [adopt] = ctx.flag(args, "--worktree");
  const h = homeFor(ctx);
  if (!h) ctx.fail("this session supervises nothing: run `rollcall supervise <name>` first, or pass --home <name>");
  const mine = ctx.whoAmI() && homeOf(ctx.whoAmI().id);
  if (mine && mine !== h) ctx.fail(`this session is supervisor ${mine}: it creates tasks in its own home, not in ${h}'s`);
  const after = ctx.flag(args, "--after").map((a) => resolve(a, { ...ctx, home: h }).id);
  // A flag rollcall does not know would otherwise become the title (a `task new --help` once made a task "--help").
  if (args[0]?.startsWith("-")) ctx.fail(`task new: unknown flag "${args[0]}" (rollcall task new --help)`);
  const title = store.clip(store.oneLine(args.join(" ")), 80);
  if (!title) ctx.fail('usage: rollcall task new "<title>" [--repo <dir>] [--words "<text>"]');
  if (!TYPES.includes(type)) ctx.fail(`--type is one of ${TYPES.join(", ")}`);
  if (!KINDS.includes(kind)) ctx.fail(`--kind is one of ${KINDS.join(", ")}`);
  if (model !== undefined && !modelOk(model)) ctx.fail(`--model is a model alias or id, like opus, sonnet, opus[1m] or claude-opus-5-5`);
  if (effort !== undefined && !effortOk(effort)) ctx.fail(`--effort is one of ${EFFORTS.join(", ")}`);
  if (adopt !== undefined && noWorktree) ctx.fail("--worktree and --no-worktree: pick one");
  if (until !== undefined && until !== "landed") ctx.fail("--until takes one word: landed");
  if (until && !after.length) ctx.fail("--until landed goes with --after <task>");
  if (noRepo && (dir !== undefined || adopt !== undefined || noWorktree || baseArg !== undefined)) ctx.fail("--no-repo runs in a plain folder: it takes no --repo, --worktree, --no-worktree or --base");
  for (const x of notes) { const long = overLimit("a note", x.trim(), MAX_NOTE); if (long) ctx.fail(`${long}: shorten it, or put the detail in --words`); }
  const info = noRepo ? null : locate(dir ?? adopt ?? process.cwd());
  if (!info && !noRepo) ctx.fail(`${dir ?? adopt ?? "this folder"} is not inside a git checkout (pass --repo <dir>, or --no-repo for a job on the machine)`);
  const repo = noRepo ? { key: null, name: "no repo" } : repoKey(info);
  const main = noRepo ? store.machineFolder() : mainCheckout(info);
  // An existing worktree the owner wants carried on ("continue there"): the task takes it over, on its branch.
  const own = adopt !== undefined ? locate(adopt) : null;
  if (adopt !== undefined) {
    if (!own || own.top === main || mainCheckout(own) !== main) ctx.fail(`--worktree takes a worktree of ${repo.name} (not its main checkout): ${adopt}`);
    const taken = store.listTasks().find((x) => isOpen(x) && x.worktree === own.top);
    if (taken) ctx.fail(`${own.top} is already task ${taken.id}'s, of supervisor ${taken.home}`);
  }
  let words = wordsArg ?? null;
  if (wordsFile) { try { words = readFileSync(wordsFile, "utf8"); } catch { ctx.fail(`cannot read ${wordsFile}`); } }

  let worktree = main;
  let branchName = null;
  let base = null;
  if (own) {
    const b = defaultBranch(info);
    branchName = gitSync(own.top, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout?.trim() || null;
    if (!branchName) ctx.fail(`${own.top} is on no branch (a detached HEAD): check one out there first`);
    if (b && branchName === b) ctx.fail(`${own.top} is on ${b}, the default branch: a task works on a branch of its own`);
    worktree = own.top;
    base = baseArg ? baseRef(baseArg, main, h, ctx) : b ? `origin/${b}` : null;
  } else if (!noWorktree && !noRepo) {
    const b = defaultBranch(info);
    if (!b) ctx.fail(`${repo.name} has no origin default branch to start a worktree from (--no-worktree to work in the main checkout)`);
    fetchSync(main, b);
    base = baseArg ? baseRef(baseArg, main, h, ctx) : `origin/${b}`;
    if (!baseArg && !mainSha(info, b)) ctx.fail(`origin/${b} is unknown in ${repo.name}`);
    const stem = slugify(slugArg ?? title);
    let slug = stem;
    for (let i = 2; existsSync(join(main, ".claude", "worktrees", slug)) || gitSync(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${type}/${slug}`]).status === 0; i++) slug = `${stem}-${i}`;
    worktree = join(main, ".claude", "worktrees", slug);
    branchName = `${type}/${slug}`;
  }

  // The record exists before the worktree does, so a gc never meets the worktree without its task.
  const g = ctx.whoAmI();
  const now = Date.now();
  const made = store.withTasksLock(h, () => {
    const n = store.nextTaskNumber(h);
    const t = {
      id: `t${n}`, n, home: h, title, kind, state: "working", stateAt: now, question: null, ask: null, pr: null,
      repo: { key: repo.key, name: repo.name, main }, worktree, branch: branchName, base, baseSha: null,
      words: words?.trim() ? [{ at: now, text: words.slice(0, MAX_WORDS) }] : [],
      notes: notes.filter((x) => x.trim()).map((x) => ({ at: now, by: g ? "supervisor" : "a shell", text: x.trim() })), sessions: [],
      after, output: null, createdAt: now, ...(until ? { until } : {}), ...(ship ? { ship: true } : {}), ...(browser ? { browser: true } : {}), ...(hold ? { hold: true } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    };
    store.writeTask(t);
    return t;
  });
  if (!made) ctx.fail("the task store is busy; try again");
  const t = made.out;
  if (own) {
    // The base commit: where its branch left the default branch, so gc counts only what landed after it.
    const baseSha = (base && gitSync(own.top, ["merge-base", "HEAD", base]).stdout?.trim()) || null;
    Object.assign(t, update(t, ctx, (x) => { x.baseSha = baseSha; x.notes.push({ at: Date.now(), by: "rollcall", text: `took over the existing worktree ${own.top} (${branchName})` }); }));
  } else if (!noWorktree && !noRepo) {
    const r = gitSync(main, ["worktree", "add", worktree, "-b", branchName, base], { timeout: 300_000 });
    if (r.status !== 0) {
      update(t, ctx, (x) => { transition(x, "no-worktree"); x.notes.push({ at: Date.now(), by: "rollcall", text: `worktree add failed: ${r.stderr.trim()}` }); });
      ctx.fail(`git worktree add failed: ${r.stderr.trim()}`);
    }
    // The base commit: content on main counts as landed only once the branch has moved past it (gc).
    const top = locate(worktree)?.top ?? worktree;
    const baseSha = gitSync(top, ["rev-parse", "HEAD"]).stdout?.trim() || null;
    Object.assign(t, update(t, ctx, (x) => { x.worktree = top; x.baseSha = baseSha; }));
  }
  if (json) { ctx.say(JSON.stringify(t, null, 2)); return 0; }
  ctx.say(`${t.id}: "${t.title}" in ${repo.name}${kind === "discuss" ? " (a discussion)" : ""}, supervisor ${h}; its tag: ${label(t)}`);
  ctx.say(noRepo ? `  works in ${worktree}, on no repo` : noWorktree ? `  works in the main checkout: ${worktree} (read-only for agents)` : `  worktree: ${t.worktree} (${branchName}${own ? ", taken over as it was" : `, from ${base}`})`);
  if (after.length) ctx.say(`  after: ${after.join(", ")}${until ? ", once landed" : ""}`);
  return 0;
}

// ---------------------------------------------------------------- list / show

/** Open tasks, plus those finished in the last hour (so a landing still shows); `all` keeps every stored one. */
export function visibleTasks(h, { all = false, now = Date.now() } = {}) {
  return store.listTasks(h).filter((t) => all || isOpen(t) || now - (t.updatedAt ?? 0) < 3600_000);
}

/** 352000 as "352k", 1000000 as "1M". */
const kTokens = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

function workerLine(t, w, now) {
  if (!w) return "no worker";
  if (w.legacy) return `worker ${short(w.session)} (a v2 background session: \`start.mjs\` resumes it in tmux)`;
  if (w.parked) return `worker ${short(w.session)} parked (stopped while idle, to free memory): it comes back when written to, or on Enter in its tab`;
  if (!w.alive) return `worker ${short(w.session)} stopped${w.window ? "" : ", no window"}`;
  const doing = w.dialog ? `waiting on ${asksText(w.asks)} in its window` : w.busy ? "working" : `idle, its turn ended ${ago(w.since, now)}`;
  const ctx = w.context === null ? "" : `, context ${w.context}%${w.tokens ? ` (${kTokens(w.tokens)}${w.size ? ` of ${kTokens(w.size)}` : ""})` : ""}`;
  // What an idle worker waits on: the background work it left running (its shipper, a CI watch), or nothing.
  const bg = w.busy || w.dialog || !w.bg ? "" : w.bg.length ? `, waiting on ${w.bg.join("; ")}` : ", nothing running";
  // A finished task's window stays a while after its worker's last turn, so the owner can still ask it something.
  const gone = isOpen(t) || w.busy ? null : closing(t, w, now);
  const unread = store.unreadInbox(t.home, t.id);
  return `worker ${short(w.session)} ${doing}${ctx}${bg}${gone ? `, its window ${gone}` : ""}${unread.length ? `, ${unread.length} message${unread.length === 1 ? "" : "s"} unread, the oldest from ${ago(unread[0].at, now)}` : ""}`;
}

function list(args, ctx) {
  const json = take(args, "--json");
  const now = Date.now();
  const h = homeFor(ctx);
  const homes = h ? [h] : store.listHomes();
  const all = take(args, "--all");
  const tasks = homes.flatMap((x) => visibleTasks(x, { all, now })).map((t) => ({ ...t, worker: workerState(t, now) }));
  if (json) { ctx.say(JSON.stringify({ home: h, tasks, decisions: allDecisions() }, null, 2)); return 0; }
  if (!tasks.length) ctx.say(h ? `rollcall: no tasks in supervisor ${h}` : "rollcall: no tasks");
  for (const t of tasks) {
    ctx.say(`${(h ? t.id : `${t.home}:${t.id}`).padEnd(h ? 4 : 12)} ${t.state.padEnd(9)} ${t.repo.name}  ${label(t)}  ${workerLine(t, t.worker, now)}${t.pr ? `  ${t.pr}` : ""}  (${ago(t.updatedAt, now)})`);
    if (t.state === "needs-you" && t.question) ctx.say(`     ${store.clip(store.oneLine(t.question), 200)}`);
    else if (isOpen(t) && t.wait) ctx.say(`     ${waitLabel(t.wait, now)}`);
    else if (isOpen(t) && t.worker?.last && !t.worker.busy) ctx.say(`     its last words: "${t.worker.last}"`);
    if (t.after?.length && t.state === "working" && !t.sessions.length) ctx.say(`     after: ${t.after.join(", ")}`);
  }
  sayDecisions(h, ctx, now);
  return 0;
}

function show(args, ctx) {
  const json = take(args, "--json");
  const t = resolve(args[0], ctx);
  const now = Date.now();
  if (json) { ctx.say(JSON.stringify({ ...t, worker: workerState(t, now) }, null, 2)); return 0; }
  ctx.say(`${t.id}: "${t.title}" - ${t.state}${t.pr ? ` - ${t.pr}` : ""}`);
  ctx.say(`  supervisor ${t.home}, repo ${t.repo.name}, ${t.branch ? `worktree ${t.worktree} (${t.branch}, from ${t.base})` : `main checkout ${t.worktree}`}`);
  ctx.say(`  ${workerLine(t, workerState(t, now), now)}`);
  if (t.after?.length) ctx.say(`  after: ${t.after.join(", ")}`);
  if (t.question) ctx.say(`  open question: ${t.question}`);
  if (t.wait) ctx.say(`  ${waitLabel(t.wait, now)}, since ${ago(t.wait.at, now)}`);
  ctx.say("\nThe owner's words, verbatim (oldest first):");
  for (const w of t.words) ctx.say(`--- ${new Date(w.at).toISOString()}${w.via === "worker" ? " (typed in the worker's own window)" : ""}\n${w.text}`);
  if (!t.words.length) ctx.say("(none recorded)");
  if (t.notes.length) {
    ctx.say("\nNotes:");
    for (const n of t.notes) ctx.say(`- ${new Date(n.at).toISOString()} ${n.by}: ${n.text}`);
  }
  if (t.sessions.length) {
    ctx.say("\nWorker sessions:");
    for (const s of t.sessions) ctx.say(`- ${s.id}${s.name ? ` (${s.name})` : ""}, started ${ago(s.at, now)}${s.endedAt ? `, replaced ${ago(s.endedAt, now)}` : ""}`);
  }
  if (t.handoff) ctx.say(`\nLast handoff (${ago(t.handoff.at, now)}${t.handoff.context === null ? "" : `, at ${t.handoff.context}% context`}):\n${t.handoff.text}`);
  if (t.output) ctx.say(`\nLast report (${ago(t.output.at, now)}):\n${t.output.text}`);
  return 0;
}

// ---------------------------------------------------------------- set / words / note / output / close

/** A worker's AskUserQuestion questions (1-4, each with 2-4 options), checked for the record; askTooLong has the limits. */
export function cleanAsk(questions) {
  const ok = Array.isArray(questions) && questions.length >= 1 && questions.length <= 4
    && questions.every((x) => typeof x?.question === "string" && Array.isArray(x.options) && x.options.length >= 2 && x.options.length <= 4 && x.options.every((o) => typeof o?.label === "string" && o.label.trim()));
  if (!ok) return null;
  return questions.map((x) => safeFirst({
    question: x.question, header: store.clip(String(x.header ?? ""), 12), multiSelect: !!x.multiSelect,
    options: x.options.map((o) => ({ label: o.label.trim(), description: String(o.description ?? "") })),
  }));
}

// An option that merges, ships or goes out for good.
const GOES_OUT = /^\s*(?:yes[,:]?\s+)?(?:ship|merge|land|deploy|release|publish)\b/i;

/**
 * Enter in an open picker takes the first option, so a stray key must never merge: one that goes out moves behind
 * the first that does not. A question of nothing but such options stays as it is, and so does a multi-select, where
 * Enter picks nothing by itself.
 */
function safeFirst(x) {
  const i = x.options.findIndex((o) => !GOES_OUT.test(o.label));
  return x.multiSelect || i <= 0 ? x : { ...x, options: [x.options[i], ...x.options.filter((_, n) => n !== i)] };
}

/** What in cleaned questions the picker cannot show whole, or null. */
export function askTooLong(questions) {
  const parts = questions.flatMap((x) => [["a question", x.question, 1000], ...x.options.flatMap((o) => {
    const name = `option "${store.clip(o.label, 30)}"`;
    return [[`the label of ${name}`, o.label, 80], [`the description of ${name}`, o.description, 400]];
  })]);
  return parts.map(([what, text, limit]) => overLimit(what, text, limit)).find(Boolean) ?? null;
}

/**
 * A worker asked the owner (its AskUserQuestion, caught by its hook): the question goes on the task, the
 * task waits on the owner, and the supervisor is woken to open it in its own picker. Returns false for
 * malformed questions, { long } for ones over the limits and { finished } for a finished task's worker; none
 * of them reaches the task.
 */
export function recordAsk(t0, raw, now = Date.now()) {
  const questions = cleanAsk(raw);
  if (!questions) return false;
  const long = askTooLong(questions);
  if (long) return { long };
  const r = store.withTasksLock(t0.home, () => {
    const t = store.readTask(t0.home, t0.id);
    if (!t) return null;
    if (!allowed(t, "asked", "needs-you")) return t.state;
    transition(t, "asked", { now });
    Object.assign(t, { stateAt: now, ask: { at: now, questions }, question: questions.map((x) => x.question).join(" / ") });
    store.writeTask(t);
    return null;
  });
  if (r?.out) return { finished: r.out };
  store.enqueueWake(t0.home, { task: t0.id, kind: "ask" });
  return true;
}

function set(args, ctx) {
  const t0 = resolve(args.shift(), ctx);
  const [state] = ctx.flag(args, "--state");
  const [question] = ctx.flag(args, "--question");
  const [askJson] = ctx.flag(args, "--ask-json");
  const [pr] = ctx.flag(args, "--pr");
  const [title] = ctx.flag(args, "--title");
  const [kind] = ctx.flag(args, "--kind");
  if (args.length) ctx.fail(`task set: unknown argument "${args[0]}" (rollcall task set --help)`);
  if (state && !STATES.includes(state)) ctx.fail(`--state is one of ${STATES.join(", ")}`);
  if (kind !== undefined && !KINDS.includes(kind)) ctx.fail(`--kind is one of ${KINDS.join(", ")}`);
  let questions = null;
  if (askJson !== undefined) {
    let raw = null;
    try { raw = JSON.parse(askJson === "-" ? readFileSync(0, "utf8") : readFileSync(askJson, "utf8")); } catch { ctx.fail("--ask-json takes a file (or - for stdin) holding AskUserQuestion's questions array"); }
    questions = cleanAsk(Array.isArray(raw) ? raw : raw?.questions);
    if (!questions) ctx.fail("a picker question has 1-4 questions, each with 2-4 options that have a label");
    const long = askTooLong(questions);
    if (long) ctx.fail(`${long}: shorten it and ask again; detail that will not fit goes in a report (task output)`);
    if ((state ?? t0.state) !== "needs-you") ctx.fail("a picker question goes with --state needs-you");
  }
  // A wait on the owner names what it waits for: with none, the supervisor once wrote the question from a report.
  const asks = questions ?? (question !== undefined ? question.trim() : !state || state === t0.state ? t0.question : null);
  if ((state ?? t0.state) === "needs-you" && (state || question !== undefined) && !asks) ctx.fail('needs-you takes the question: --question "<what you need from the owner, one sentence>"');
  const g = ctx.whoAmI();
  mayWrite(t0, g, ctx);
  const now = Date.now();
  const by = author(t0, g);
  const event = reportEvent(by);
  if (state && !allowed(t0, event, state)) ctx.fail(finishedStays(t0));
  if (state && reportOwed(t0, by, state)) ctx.fail(reportFirst(t0, state));
  if (state === "closed" && t0.state !== "closed") prBlocksClose(t0, ctx);
  const before = t0.state;
  const t = update(t0, ctx, (t) => {
    if (state) transition(t, event, { to: state, now });
    if (question !== undefined) { t.question = question.trim() || null; t.ask = null; }
    if (questions) {
      t.ask = { at: now, questions };
      if (question === undefined) t.question = questions.map((x) => x.question).join(" / ");
    }
    if (pr) t.pr = pr.trim();
    if (title) t.title = store.clip(store.oneLine(title), 80);
    if (kind) t.kind = kind;
  });
  // A worker briefed for the other kind works to the wrong contract (a discussion turned build shipped a PR
  // nobody tracked): it hears what changed, unless it made the change itself.
  if (kind && kind !== (t0.kind ?? "build") && !/^worker\b/.test(by) && t.sessions.length) tell(t, rebrief(t));
  ctx.say(`${t.id}: ${t.state}${t.question ? ` - ${store.clip(store.oneLine(t.question), 120)}` : ""}${t.pr ? ` - ${t.pr}` : ""}`);
  // A worker's report is news for its supervisor; the supervisor's own changes are not.
  if (by !== "supervisor" && state && NEWS.has(state) && (state !== before || question !== undefined || questions)) {
    store.enqueueWake(t.home, { task: t.id, kind: questions ? "ask" : state });
    if (state === "needs-you") ctx.say(holderOf(t.home) ? `  supervisor ${t.home} hears this now` : `  no supervisor ${t.home} is running: the record holds it, and the next one reads it`);
    else ctx.say("  rollcall tells the owner");
  }
  return 0;
}

/**
 * `task wait-for`: the worker's wait moves out of its context. A check runs from the watcher while the worker parks; a
 * named blocker opens (or joins the open one), and every worker on it comes back when it closes.
 */
function waitFor(args, ctx) {
  const t0 = resolve(args.shift(), ctx);
  const [every] = ctx.flag(args, "--every");
  const [why] = ctx.flag(args, "--why");
  const what = args.join(" ").trim();
  if (!what) ctx.fail(`usage: rollcall task wait-for <id|here> <${WAITABLE.join("|")}|"<check command>"> [--every <minutes>] [--why "<what it waits on>"]`);
  if (every !== undefined && !(Number(every) > 0)) ctx.fail("--every takes minutes");
  if (!isOpen(t0)) ctx.fail(`${t0.id} is ${t0.state}: a finished task waits on nothing`);
  mayWrite(t0, ctx.whoAmI(), ctx);
  const on = WAITABLE.includes(what) ? what : null;
  const now = Date.now();
  // A billing blocker needs a run to try again, or only the owner can clear it.
  if (on === "billing" && !openBlockers().billing?.run) openBlocker("billing", refusedRun(t0), now);
  else if (on) openBlocker(on, { waited: true }, now);
  update(t0, ctx, (t) => {
    t.wait = { on, check: on ? null : what, why: why ? store.clip(store.oneLine(why), 80) : null, every: every ? Number(every) * 60_000 : null, at: now };
  });
  ctx.say(`${t0.id}: waits on ${on ?? `\`${store.clip(what, 80)}\``}. End your turn now: ${on ? "rollcall tells the owner once, and" : "rollcall runs the check while you are parked, and"} brings you back when it clears. Anything said to you meanwhile ends the wait: run this again if you still wait.`);
  return 0;
}

/** The latest failed run on the task's branch, the one GitHub refused, for rollcall to try again: { main, run }. */
function refusedRun(t) {
  if (!t.branch) return {};
  const r = spawnSync(process.env.ROLLCALL_GH || "gh", ["run", "list", "--branch", t.branch, "--status", "failure", "--limit", "1", "--json", "databaseId"], { cwd: t.worktree, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
  try { const [run] = JSON.parse(r.stdout); return run ? { main: t.repo.main, run: run.databaseId } : {}; } catch { return {}; }
}

/** What a worker hears when its task changes kind: its brief, as it now stands, is one command away. */
const rebrief = (t) =>
  `Task ${t.id} is now a ${t.kind === "build" ? "build: the owner wants the change made and shipped, with the build and ship phases as in any session" : "discussion: research and a recommendation, no change shipped unless the owner asks"}. ` +
  `Your contract changed with it: \`${START} ${t.id} --dry-run\` prints your brief as it now stands; work to its "Working with the owner" section from here on.`;

function addText(args, ctx, field) {
  const t0 = resolve(args.shift(), ctx);
  let text = args.join(" ");
  if (text === "-") text = readFileSync(0, "utf8");
  if (!text.trim()) ctx.fail(`usage: rollcall task ${field === "words" ? "words" : "note"} <id> "<text>"`);
  const long = field === "notes" && overLimit("a note", text.trim(), MAX_NOTE);
  if (long) ctx.fail(`${long}: shorten it, or save the whole text with \`${cli()} task output ${t0.id} --file <f>\``);
  const g = ctx.whoAmI();
  // A note named into another supervisor's task (--home): the one write across homes, and its worker hears it.
  const mine = g && homeOf(g.id);
  const across = field === "notes" && ctx.home && mine && mine !== t0.home ? mine : null;
  if (!across) mayWrite(t0, g, ctx);
  let closed = null;
  const by = across ? `supervisor ${across}` : author(t0, g);
  const at = Date.now();
  const t = update(t0, ctx, (t) => {
    if (field === "words") closed = ownerSaid(t, text, "supervisor");
    else t.notes.push({ at, by, text: text.trim() });
  });
  // A worker's handoff note (before `task handoff`) is rollcall's cue to start a fresh worker; "grew:", the
  // supervisor's to judge whether the new part runs as a task of its own; "reply:", its answer to a message from
  // the supervisor, unless it says no more than "on it". The wake names its note, so one wake carries every reply
  // since the first it names.
  if (field === "notes" && by !== "supervisor" && !across) {
    const kind = /^handoff:/i.test(text.trim()) ? "handoff" : /^grew:/i.test(text.trim()) ? "grew" : /^reply:/i.test(text.trim()) && !BARE_REPLY.test(text.trim()) ? "reply" : null;
    if (kind) store.enqueueWake(t.home, { task: t.id, kind, note: at });
  }
  if (across) tell(t, `From supervisor ${across}: ${text.trim()}`);
  ctx.say(`${t.id}: ${field === "words" ? `owner's words added${closed ? "; its open question is closed" : ""}` : "note added"}`);
  return 0;
}

/** How a report counts in the table of moves: a worker's stops at a finished task, anyone else's does not. */
const reportEvent = (by) => (/^worker\b/.test(by) ? "worker-report" : "report");

const finishedStays = (t) =>
  `${t.id} is ${t.state} and stays so: its worker answers with \`${cli()} task note ${t.id} "reply: <answer>"\` and reports nothing else. New work for it is a new task, or the supervisor reopens this one.`;

/** Whether the task's last worker, or the task if it never had one, saved a report (rollcall's own no-word report is not one). */
const reportSaved = (t) => !!t.output && t.output.by !== "rollcall" && t.output.at >= (t.sessions.at(-1)?.at ?? t.createdAt ?? 0);

/**
 * A worker that finishes its task (landed, closed) saves its report first, in the session that finishes it:
 * the news of the finish carries it to the owner. Seven of ten tasks in one supervisor finished without one,
 * and an open question, caveats and follow-ups never reached the owner. rollcall's own landing (a merge seen
 * after the worker left) and the supervisor's changes need none.
 */
function reportOwed(t, by, state) {
  if (!/^worker\b/.test(by) || isOpen({ state }) || t.state === state) return false;
  return !reportSaved(t);
}

/**
 * A task is not closed while its branch has an open PR: closed ends its tab and its news, and one such PR went
 * unseen for hours after a discussion turned into a build.
 */
function prBlocksClose(t, ctx) {
  const pr = openPr(t);
  if (pr) ctx.fail(`${t.id}'s branch has an open PR (${pr.url}): it is not closed while that PR is open. Set \`--state pr-open --pr ${pr.url}\`, or close the PR first.`);
}

const reportFirst = (t, state) =>
  `${t.id} is not ${state} yet: save your report first, then set ${state} again. \`${cli()} task output ${t.id} --file <f>\` with what the owner ` +
  "needs from this task: what now works and how they see it, what they must check, decide or do next, caveats and follow-ups. The supervisor gives it to them as written.";

function output(args, ctx) {
  const t0 = resolve(args.shift(), ctx);
  const [file] = ctx.flag(args, "--file");
  let text = args.join(" ");
  if (file) { try { text = readFileSync(file, "utf8"); } catch { ctx.fail(`cannot read ${file}`); } }
  if (text === "-") text = readFileSync(0, "utf8");
  if (!text.trim()) ctx.fail('usage: rollcall task output <id> ["<text>" | --file <f>]');
  const long = overLimit("a report", text, MAX_WORDS);
  if (long) ctx.fail(`${long}: shorten it`);
  const g = ctx.whoAmI();
  mayWrite(t0, g, ctx);
  const t = update(t0, ctx, (t) => { t.output = { at: Date.now(), by: author(t, g), text, ...linesMoved(t.output?.text, text) }; });
  ctx.say(`${t.id}: report saved`);
  return 0;
}

/** What a new report changed against the last: { added, removed } in lines, for a wake that says only that. */
function linesMoved(before, after) {
  if (before === undefined) return {};
  const was = new Set(before.split("\n"));
  const now = new Set(after.split("\n"));
  return { added: [...now].filter((l) => !was.has(l)).length, removed: [...was].filter((l) => !now.has(l)).length };
}

/**
 * `task handoff`: the worker's handoff, the prompt the owner would paste into a fresh session, kept on the
 * task for the next worker's brief. rollcall starts that worker from it, and lowers the cap flag.
 */
function handoff(args, ctx) {
  const t0 = resolve(args.shift(), ctx);
  const [file] = ctx.flag(args, "--file");
  let text = args.join(" ");
  if (file) { try { text = readFileSync(file, "utf8"); } catch { ctx.fail(`cannot read ${file}`); } }
  if (text === "-") text = readFileSync(0, "utf8");
  if (!text.trim()) ctx.fail('usage: rollcall task handoff <id> ["<text>" | --file <f>]');
  const long = overLimit("a handoff", text, MAX_WORDS);
  if (long) ctx.fail(`${long}: shorten it`);
  const g = ctx.whoAmI();
  mayWrite(t0, g, ctx);
  const by = author(t0, g);
  if (by === "supervisor") ctx.fail(`a handoff is the worker's to write: ask for one with rollcall task tell ${t0.id} "handoff please: <why>"`);
  if (!isOpen(t0)) ctx.fail(`${t0.id} is ${t0.state}: nothing to hand off`);
  const w = workerState(t0);
  const t = update(t0, ctx, (t) => {
    t.handoff = { at: Date.now(), by, session: t.sessions.at(-1)?.id ?? null, context: w?.context ?? null, text };
  });
  clearCap(t.home, t.id);
  store.enqueueWake(t.home, { task: t.id, kind: "handoff" });
  ensureWatcher(t.home);
  ctx.say(`${t.id}: handoff saved. rollcall starts a fresh worker from it; end your turn now.`);
  return 0;
}

function close(args, ctx) {
  const t0 = resolve(args.shift(), ctx);
  const why = store.oneLine(args.join(" "));
  const g = ctx.whoAmI();
  mayWrite(t0, g, ctx);
  const by = author(t0, g);
  const event = reportEvent(by);
  if (!allowed(t0, event, "closed")) ctx.fail(finishedStays(t0));
  if (reportOwed(t0, by, "closed")) ctx.fail(reportFirst(t0, "closed"));
  prBlocksClose(t0, ctx);
  const t = update(t0, ctx, (t) => {
    transition(t, event, { to: "closed" });
    if (why) t.notes.push({ at: Date.now(), by, text: `closed: ${why}` });
  });
  if (by !== "supervisor") store.enqueueWake(t.home, { task: t.id, kind: "closed" });
  ctx.say(`${t.id}: closed${t.branch ? `. Its worktree goes with the next gc once it is clean (${t.worktree})` : ""}`);
  return 0;
}

/**
 * Hands a task to another supervisor: it gets the next id there, its worker stops (its hooks name the old
 * home), and the new supervisor resumes it with its context (`start.mjs <new id> --resume`).
 */
function move(args, ctx) {
  const t0 = resolve(args.shift(), ctx);
  const [to] = ctx.flag(args, "--to");
  if (!to || !store.HOME_NAME.test(to)) ctx.fail("usage: rollcall task move <id> --to <home>");
  if (to === t0.home) ctx.fail(`${t0.id} is already supervisor ${to}'s`);
  // A home no session holds has no one to refuse it: its tasks are anyone's to move.
  if (holderOf(t0.home)) mayWrite(t0, ctx.whoAmI(), ctx);
  stopWorker(t0);
  const moved = store.withTasksLock(to, () => {
    const n = store.nextTaskNumber(to);
    const t = { ...store.readTask(t0.home, t0.id), id: `t${n}`, n, home: to };
    t.notes = [...t.notes, { at: Date.now(), by: "rollcall", text: `moved from supervisor ${t0.home}, where it was ${t0.id}` }];
    store.writeTask(t);
    return t;
  });
  if (!moved) ctx.fail("the task store is busy; try again");
  const t = moved.out;
  moveDecisions(t0, t);
  update(t0, ctx, (x) => { transition(x, "moved-away"); x.notes.push({ at: Date.now(), by: "rollcall", text: `moved to supervisor ${to} as ${t.id}` }); x.movedTo = `${to}:${t.id}`; });
  // The worker's log and unread messages go along; its launch files are written anew at its next start.
  for (const [a, b] of [["status", ".jsonl"], ["inbox", ""]]) {
    try { mkdirSync(join(store.homeDir(to), a), { recursive: true }); renameSync(join(store.homeDir(t0.home), a, `${t0.id}${b}`), join(store.homeDir(to), a, `${t.id}${b}`)); } catch {}
  }
  ctx.say(`${t0.home}:${t0.id} is now ${to}:${t.id} ("${t.title}").${t.sessions.length ? ` Its worker stopped; from supervisor ${to}: ${START} ${t.id} --resume "moved here"` : ""}`);
  return 0;
}

/** The decisions a moved task left open go with it: they keep their place on the owner's one list. */
function moveDecisions(t0, t) {
  store.updateDecisions((d) => {
    for (const x of d.items) if (x.home === t0.home && x.from === t0.id) Object.assign(x, { home: t.home, from: t.id });
  });
}

function tellCmd(args, ctx) {
  const t = resolve(args.shift(), ctx);
  let text = args.join(" ");
  if (text === "-") text = readFileSync(0, "utf8");
  if (!text.trim()) ctx.fail('usage: rollcall task tell <id> "<text>" (or - with the text on stdin)');
  mayWrite(t, ctx.whoAmI(), ctx);
  const rang = tell(t, text.trim());
  const w = rang ? null : workerState(t);
  const later = w?.alive ? "a prompt is open in its window: the doorbell rings once it closes"
    : !t.sessions.length ? `it has no worker yet: the doorbell rings once one starts (${START} ${t.id})`
    : `its worker is not running${isOpen(t) ? "" : ` (${t.id} is ${t.state})`}: the doorbell rings once it runs again (${START} ${t.id} --resume "<why>")`;
  ctx.say(`${t.id}: message left in its inbox; ${rang ? "the doorbell rang in its window" : later}`);
  return 0;
}

/** How long after the owner typed a line to the supervisor it can still relay it. */
const RELAY_MS = 30 * 60_000;

/**
 * `task relay <id> [-]`: the owner's last line to the supervisor, typed into the task's worker word for word, as
 * their `@` line would be, so it carries their say-so (ship it, merge it). With `-`, only the part of that line
 * on stdin goes, for a line meant for several tasks. Only the owner's own text goes, from rollcall's record of
 * what they typed (the supervisor's prompt hook, or their own words in a pick, which may be meant for another task),
 * within RELAY_MS.
 */
function relay(args, ctx) {
  const t = resolve(args.shift(), ctx);
  const g = ctx.whoAmI();
  if (taskEnv() || !g || homeOf(g.id) !== t.home) ctx.fail(`task relay is the supervisor's (${t.home}): it types the owner's last line to it into ${t.id}'s worker`);
  // The prompt hook cannot tell a scheduled wake-up or Claude Code's own continuation from the owner's line; by now
  // the transcript can.
  const lines = store.readHomeFile(t.home, "said");
  const said = (Array.isArray(lines) ? lines : []).findLast((x) => x.session === g.id && (x.pick || promptAuthor(g.transcript, x.text, x.at) !== "machine"));
  if (!said || Date.now() - said.at > RELAY_MS) {
    ctx.fail(`no line from the owner to this supervisor in the last ${RELAY_MS / 60_000} minutes: ask them to type \`@${nameOf(t.id)} <their words>\``);
  }
  const part = args[0] === "-" ? readFileSync(0, "utf8").trim() : null;
  if (part !== null && (!part || !said.text.includes(part))) ctx.fail(`task relay types the owner's own words only: that text is not part of their last line ("${store.clip(store.oneLine(said.text), 120)}")`);
  if (!isOpen(t) && !t.sessions.length) ctx.fail(`${t.id} is ${t.state} and never had a worker`);
  const text = part ?? said.text;
  const r = deliverWords(t, text, { record: (x) => recordWords(t, x, "supervisor"), mode: g.mode ?? null });
  ctx.say(r.ok ? `${t.id}: the owner's words ${r.how === "held" ? `wait for its worker (${r.why})` : r.how === "resumed" ? "resumed its stopped worker" : "were typed into its worker"}: "${store.clip(store.oneLine(text), 120)}"` : `${t.id}: the owner's words are recorded, but ${r.why}`);
  return r.ok ? 0 : 1;
}

// ---------------------------------------------------------------- what waits on the owner

/** Every open decision for the owner, whichever supervisor it came from, oldest first: [{ n, text, where, home, from, at }]. They outlive the task that raised them. */
export const allDecisions = () => store.readDecisions().items;
/** Those that came from home `h`. */
export const decisionsOf = (h) => allDecisions().filter((d) => d.home === h);

// Words too common to tell two decisions apart.
const COMMON = new Set("the and for from with this that when then than into onto your you are was were will should would could can not but have has had how what which who why its it's about before after set run get use new one two".split(" "));
const wordsOf = (text) => new Set(text.toLowerCase().match(/[a-z0-9_#]{3,}/g)?.filter((w) => !COMMON.has(w)) ?? []);

/** The open decision `text` reads like, or null: over the live list (73 items) this finds d43 and d44, one Railway variable written twice, and 2 false pairs in 7. */
function sameAs(text, items) {
  const a = wordsOf(text);
  return items.find((d) => {
    const b = wordsOf(d.text);
    const shared = [...a].filter((w) => b.has(w)).length;
    return shared >= 4 && shared / Math.min(a.size, b.size) >= 0.4;
  }) ?? null;
}

function sayDecisions(h, ctx, now) {
  const items = allDecisions();
  if (!items.length) return;
  ctx.say("\nWaiting on the owner, from every supervisor, until answered (rollcall task decisions done <n>):");
  items.forEach((d, i) => {
    // A decision whose task finished may be settled already (one landed with its decision still listed): say so.
    // A finished task's record goes after two days, so no record means it finished long ago.
    const from = d.from ? store.readTask(d.home, d.from) : null;
    const stale = !d.from || isOpen(from) ? "" : from ? `; ${nameOf(d.from)} is ${from.state}: check it still stands` : `; ${nameOf(d.from)} finished long ago: check it still stands`;
    const whose = d.home === h ? "" : `${d.home}${d.from ? "'s " : ", "}`;
    const twin = sameAs(d.text, items.slice(0, i));
    ctx.say(`  d${d.n}  ${d.text}${d.where ? ` - answer: ${d.where}` : ""} (${whose}${d.from ? `from ${nameOf(d.from)}, ` : ""}${ago(d.at, now)}${stale}${twin ? `; reads like d${twin.n}` : ""})`);
  });
}

function decisions(args, ctx) {
  const [sub, ...rest] = args;
  const h = homeFor(ctx);
  const now = Date.now();
  if (sub === undefined || sub === "list") {
    if (!allDecisions().length) ctx.say("rollcall: nothing waits on the owner");
    else sayDecisions(h, ctx, now);
    return 0;
  }
  const g = ctx.whoAmI();
  const edit = (fn) => {
    const r = store.updateDecisions(fn);
    if (!r) ctx.fail("the decisions list is busy; try again");
    return r.out;
  };
  if (sub === "add") {
    if (!h) ctx.fail("this session supervises nothing: run it in a supervisor or a worker, or pass --home <name>");
    const mine = g && homeOf(g.id);
    if (mine && mine !== h) ctx.fail(`this session is supervisor ${mine}: it adds decisions from its own home, not from ${h}`);
    const [where] = ctx.flag(rest, "--where");
    const [fromArg] = ctx.flag(rest, "--from");
    const text = store.oneLine(rest.join(" "));
    if (!text) ctx.fail('usage: rollcall task decisions add "<the decision>" [--where "<how the owner answers it>"] [--from <task>]');
    const long = overLimit("a decision", text, 300) ?? overLimit("--where", store.oneLine(where ?? ""), 200);
    if (long) ctx.fail(`${long}: shorten it`);
    const env = taskEnv();
    // Where it came from: the worker's own task, or the one the supervisor names (a closed task's open calls).
    const from = fromArg ? resolve(fromArg, { ...ctx, home: h }).id : env?.home === h ? env.id : null;
    const twin = sameAs(text, allDecisions());
    const n = edit((d) => { d.seq += 1; d.items.push({ n: d.seq, text, where: where ? store.oneLine(where) : null, home: h, from, at: now }); return d.seq; });
    // A worker's decision is news: the owner hears of it now, not at the next `task list`.
    if (env?.home === h) store.enqueueWake(h, { task: env.id, kind: "decision", n });
    ctx.say(`d${n}: listed for the owner until answered`);
    if (twin) ctx.say(`  it reads like d${twin.n}: "${store.clip(twin.text, 160)}". If it is the same one: rollcall task decisions done ${n} "same as d${twin.n}"`);
    return 0;
  }
  if (sub === "done") {
    const n = Number(String(rest.shift() ?? "").replace(/^d/i, ""));
    const answer = store.oneLine(rest.join(" "));
    const gone = edit((d) => { const i = d.items.findIndex((x) => x.n === n); return i < 0 ? null : d.items.splice(i, 1)[0]; });
    if (!gone) ctx.fail(`no open decision d${n || "?"} (rollcall task decisions)`);
    // The task it came from keeps the answer, so its next worker knows.
    const from = gone.from && store.readTask(gone.home, gone.from);
    if (from && answer) update(from, ctx, (t) => { t.notes.push({ at: now, by: author(t, g), text: store.clip(`decided: ${gone.text} - ${answer}`, 4000) }); });
    ctx.say(`d${n}: answered${answer ? `: ${answer}` : ""}`);
    return 0;
  }
  ctx.fail(`task decisions: unknown command "${sub}" (rollcall task decisions --help)`);
}

/**
 * `task stage`: the stage of a ship that starts now (the shipper's, step by step), so its tab shows minutes against
 * the usual time and "is it stuck?" takes no one a look at a log. A stage's time counts once the next one starts. A
 * ship outside any task notes nothing: the skill says this line whoever runs it.
 */
function stage(args, ctx) {
  const id = args.shift();
  if (id === "here" && !ctx.home && !taskEnv() && !taskAt(process.cwd())) return 0;
  const t0 = resolve(id, ctx);
  const name = store.clip(store.oneLine(args.join(" ")), 40);
  if (!name) ctx.fail('usage: rollcall task stage <id|here> "<stage>" | done');
  // The shipper's last line runs after the task may have landed: nothing to do then.
  if (!isOpen(t0)) { if (name === "done") return 0; ctx.fail(`${t0.id} is ${t0.state}: no stage on a finished task`); }
  mayWrite(t0, ctx.whoAmI(), ctx);
  const now = Date.now();
  const was = t0.stage;
  if (was?.name === name) return 0;
  update(t0, ctx, (t) => { t.stage = name === "done" ? null : { name, at: now }; });
  if (was) store.addStageTime(t0.repo.key, was.name, now - was.at);
  ctx.say(`${t0.id}: ${name === "done" ? "ship stages done" : `stage: ${name}`}`);
  return 0;
}

const COMMANDS = {
  new: create, list, show, set, close, move, tell: tellCmd, relay, output, handoff, decisions, stage, "wait-for": waitFor,
  words: (a, c) => addText(a, c, "words"),
  note: (a, c) => addText(a, c, "notes"),
};

/**
 * The merge queue's report on a task's PR, or the watcher's on its merge (`event`, in the table of moves):
 * `queued` while it waits its turn, `needs-you` (with the reason as its question, which wakes the supervisor)
 * when it parks, `working` again after a bounce its worker fixes. A question the queue did not ask stands.
 */
export function queueState(h, id, event, { question = null, note = null, pr = null, line = null } = {}) {
  let state = null;
  let changed = false;
  store.withTasksLock(h, () => {
    const t = store.readTask(h, id);
    if (!isOpen(t)) return;
    if (allowed(t, event)) {
      changed = transition(t, event) || !!(question && t.question !== question);
      t.question = question;
      t.ask = null;
      state = t.state;
    }
    t.queueLine = line;
    // The PR that joined the queue is the task's, whoever opened it.
    if (pr) t.pr = pr;
    if (note) t.notes.push({ at: Date.now(), by: "rollcall", text: note });
    store.writeTask(t);
  });
  if (changed && NEWS.has(state)) store.enqueueWake(h, { task: id, kind: state });
}

/**
 * `gh pr create` ran in the task's worktree (its worker, or a shipper the worker started): the PR goes on the
 * record and the task shows it, whoever was meant to report it (one shipper was told to leave task state alone,
 * and its PR stayed out of view 3.5 hours). A finished task opens again: a discussion that turned into a build,
 * or a second PR after a landing. A task waiting on the owner keeps waiting. Returns whether it woke the supervisor.
 */
export function prOpened(t0, url, now = Date.now()) {
  const r = store.withTasksLock(t0.home, () => {
    const t = store.readTask(t0.home, t0.id);
    // The task's own PR again is no news: gh prints it when one exists already ("a pull request ... already exists").
    if (!t || t.pr === url) return false;
    const was = t.state;
    t.pr = url;
    transition(t, "pr-opened", { now });
    t.notes.push({ at: now, by: "rollcall", text: `PR opened: ${url}${isOpen({ state: was }) ? "" : ` (the task was ${was}: open again)`}` });
    store.writeTask(t);
    return t.state === "pr-open";
  });
  if (r?.out) store.enqueueWake(t0.home, { task: t0.id, kind: "pr-open" });
  return !!r?.out;
}

/** The open PR on the task's branch, per gh ({ url }), or null (none, or gh could not say). */
export function openPr(t) {
  if (!t.branch) return null;
  const r = spawnSync(process.env.ROLLCALL_GH || "gh", ["pr", "list", "--head", t.branch, "--state", "open", "--json", "url", "--limit", "1"], {
    cwd: existsSync(t.worktree) ? t.worktree : t.repo.main, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000,
  });
  try { return r.status === 0 ? JSON.parse(r.stdout)[0] ?? null : null; } catch { return null; }
}

/** What names a merge on a task: the commit that landed, else its PR. */
const mergeKey = (t, head) => head ?? t.pr ?? "its work";

const COMES_BACK = "its worker comes back for its after-merge steps";

/**
 * Why an open task whose work rollcall saw on the default branch (`head`, the commit that landed) stays open,
 * or null when rollcall may mark it landed. A worker that still runs reports landed itself, once its after-merge
 * steps are done (a deploy watch, a TestFlight upload); so does one that handed off, through its successor, and
 * one that was parked or exited, which comes back once per merge. A task waiting on the owner waits on, and a
 * state the worker or supervisor set after rollcall first saw this merge stands. A worker stopped on purpose,
 * or one that went again after it came back, leaves the landing to rollcall.
 */
export function mergeHold(t, head, w = workerState(t), now = Date.now()) {
  const seen = t.merged?.key === mergeKey(t, head) ? t.merged : null;
  if (t.state === "needs-you") return "it waits on the owner";
  if (seen && (t.stateAt ?? 0) > seen.at) return `it was set ${t.state} after its merge`;
  if (w?.alive) return "its worker runs, and reports landed once its after-merge steps are done";
  if (t.handoff && t.handoff.session === t.sessions.at(-1)?.id) return "its worker handed off, and a fresh one carries on";
  if (!w || w.legacy || w.stopped) return null;
  if (!seen?.back) return COMES_BACK;
  return (w.up ?? 0) < seen.back || now - w.up < startingMs() ? "its worker is on its way back" : null;
}

/**
 * The report of a task rollcall landed with no word from a worker, so the owner can tell what nobody confirmed
 * (one could not tell whether a TestFlight build went out). A report the last worker saved stands; an older
 * worker's stays below this one.
 */
function noWordReport(t, why, w, now) {
  const who = !t.sessions.length ? "No worker ran it" : w?.stopped ? "Its worker was stopped" : "Its worker did not report";
  const text = `rollcall marked this task landed: ${why}${t.pr ? ` (${t.pr})` : ""}. ${who}, so nothing confirms its after-merge steps ran (a deploy watch, a release build). Check those before relying on them.`;
  return { at: now, by: "rollcall", text: t.output ? `${text}\n\nThe last report before that:\n\n${t.output.text}` : text };
}

/**
 * rollcall saw task `t0`'s work on the default branch (`why`: "its PR merged", "in origin/main", ...). The first
 * sighting of each merge goes on the record, and the task is marked landed unless mergeHold keeps it open; a
 * worker that left is called back here, once. Returns that reason, or null once it is landed (or no longer open).
 */
export function mergeSeen(t0, { why, head = null }, w = workerState(t0), now = Date.now()) {
  let landed = false;
  let back = false;
  const r = store.withTasksLock(t0.home, () => {
    const t = store.readTask(t0.home, t0.id);
    if (!isOpen(t)) return null;
    const key = mergeKey(t, head);
    const first = t.merged?.key !== key;
    if (first) t.merged = { key, at: now, pr: t.pr ?? null, why };
    const hold = mergeHold(t, head, w, now);
    if (!hold) {
      transition(t, "merged", { now });
      t.notes.push({ at: now, by: "rollcall", text: `landed: ${why}` });
      if (!reportSaved(t)) t.output = noWordReport(t, why, w, now);
      landed = true;
    } else if (first) t.notes.push({ at: now, by: "rollcall", text: `merge seen (${why}); the task stays ${t.state}: ${hold}` });
    if (hold === COMES_BACK) { t.merged.back = now; back = true; }
    if (first || landed || back) store.writeTask(t);
    return hold;
  });
  if (landed) store.enqueueWake(t0.home, { task: t0.id, kind: "landed" });
  if (back) { store.enqueueWake(t0.home, { task: t0.id, kind: "after-merge" }); ensureWatcher(t0.home); }
  return r ? r.out : "the task store is busy";
}

// ---------------------------------------------------------------- the owner's words

/** How the owner's words reached the task: through the supervisor (@tN, its picker, a relay), or typed in the worker's own window. */
const VIA = { supervisor: "through the supervisor", worker: "in the worker's own window" };

/**
 * Records the owner's words on `t` (call under the task lock). Every way of talking to a worker comes
 * through here, so the record, not any session's memory, says what is still open. The owner's words
 * settle whatever the task had open: its question closes and it is back to working; a worker that still
 * needs the owner asks again. Returns the question it closed, or null.
 */
export function ownerSaid(t, text, via, now = Date.now()) {
  const w = { at: now, text: text.slice(0, MAX_WORDS), via };
  if (t.question || t.ask || t.state === "needs-you") {
    if (t.question) {
      w.closed = store.clip(store.oneLine(t.question), 300);
      t.notes.push({ at: now, by: "rollcall", text: `question closed by the owner's words ${VIA[via]}: ${w.closed}` });
    }
    transition(t, "owner-said", { now });
    t.question = null;
    t.ask = null;
  }
  t.words.push(w);
  return w.closed ?? null;
}

/** Records the owner's words on a task, under its lock. Returns the question they closed, or null. */
export function recordWords(t0, text, via) {
  const r = store.withTasksLock(t0.home, () => {
    const t = store.readTask(t0.home, t0.id);
    if (!t) return null;
    const closed = ownerSaid(t, text, via);
    store.writeTask(t);
    return closed;
  });
  return r?.out ?? null;
}

/**
 * The transcript of task `t0`'s worker says the owner typed `text` in `session`, at `at`: when that is still its
 * current worker, those are the owner's words for the task. Returns the task, or null.
 */
export function ownerTypedInWorker(t0, session, text, at) {
  const isWorker = (t) => isOpen(t) && t.sessions.at(-1)?.id === session && !t.sessions.at(-1).endedAt;
  const r = store.withTasksLock(t0.home, () => {
    const t = store.readTask(t0.home, t0.id);
    if (!isWorker(t)) return null;
    ownerSaid(t, text, "worker", at);
    store.writeTask(t);
    return t;
  });
  return r?.out ?? null;
}

/**
 * For a supervisor: one line per task of its home whose worker the owner talked to in its own window
 * since it last heard. It never saw those words, and without this it would ask again about what they settled.
 */
export function ownerNews(h, now = Date.now()) {
  const fresh = (t) => t.words.filter((w) => w.via === "worker" && w.at > (t.toldAt ?? 0));
  if (!store.listTasks(h).some((t) => fresh(t).length)) return [];
  const r = store.withTasksLock(h, () => {
    const lines = [];
    for (const t of store.listTasks(h)) {
      const said = fresh(t);
      if (!said.length) continue;
      const last = said.at(-1);
      t.toldAt = last.at;
      store.writeTask(t);
      const closed = said.filter((w) => w.closed).map((w) => `"${w.closed}"`);
      lines.push(
        `${P} ${label(t)}: the owner talked to its worker in its own window, ${said.length} message${said.length === 1 ? "" : "s"}, the last ${ago(last.at, now)}: "${store.clip(store.oneLine(last.text), 160)}". ` +
          `Their words are on its record (\`${cli()} task show ${t.id}\`) and count like any they send through you.` +
          (closed.length ? ` They closed its open question (${closed.join("; ")}); ${t.id} asks again if it still needs them.` : "") +
          ` Ask the owner nothing about ${t.id} that came before these words.`,
      );
    }
    return lines;
  });
  return r?.out ?? [];
}

function take(args, name) {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}
