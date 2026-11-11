#!/usr/bin/env node
// Starts a task's worker: an ordinary interactive Claude Code session in a tmux window of its supervisor's
// tmux session, in the task's worktree, with a session id fixed at launch, so the owner's whole setup loads
// there and a dead worker resumes with its context. The first prompt is built here from the task record,
// never typed by the supervisor: the owner's words verbatim, then the fixed contract for how a worker
// reports. --fresh replaces a worker that outgrew its session: the new one also gets the notes, the last
// report and the branch's state, so nobody writes a handoff. --resume brings the last session back in its
// window (a crash, a Mac restart, a v2 background worker moving into tmux), or with --session an earlier
// one; it also brings back the worker of a finished task, for the owner to ask it something.
//
//   node start.mjs <task> [--fresh "<why>"] [--dry-run] [--home <name>] [--mode <permission mode>]
//   node start.mjs <task> --resume "<why>" [--session <id>]
//   node start.mjs <task> --stop | --interrupt
//
// --dry-run only prints the brief, first of all: a running worker reads its own that way.
//
// Exit codes: 0 started (or --dry-run printed the brief); 1 usage or a refusal (a worker is already
// running, the task is finished and was not resumed, no worker to resume); 4 the worker waits on Claude Code's trust prompt
// for the repo (the message says what the owner does, once per repo).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROLLCALL = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "rollcall", "bin", "rollcall.mjs");
const src = (m) => import(join(dirname(ROLLCALL), "..", "src", m));
const [{ HANDOFF, HANDOFF_HOLDS, closeAfterMs, launch, nameOf, stopWorker, workerState }, { isOpen }, store, tmux, { adapter, harnessOf, workerAdapter }] = await Promise.all([src("supervisor.mjs"), src("state.mjs"), src("store.mjs"), src("tmux.mjs"), src("harness/index.mjs")]);
const { hostedHome } = await src("host/client.mjs");

const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, ...opts });
const rollcall = (argv) => run(process.execPath, [ROLLCALL, ...argv]);
const die = (msg, code = 1) => { process.stderr.write(`start: ${msg}\n`); process.exit(code); };

/** How the brief tells the worker to run rollcall: `rollcall` when PATH's is this one, else this one by path. */
function rollcallCommand() {
  const onPath = run("sh", ["-c", "command -v rollcall"]).stdout.trim();
  try { if (onPath && realpathSync(onPath) === realpathSync(ROLLCALL)) return "rollcall"; } catch {}
  return `node "${ROLLCALL}"`;
}

/**
 * The model and effort a worker runs on: its task's own (`task new --model/--effort`), else the harness's
 * (kesselrunner's core settings, then the owner's overlay, as `kesselrunner sync` merges them), never what `/model`
 * last saved to the owner's settings. Null leaves the choice to Claude Code.
 */
function workerModel(t) {
  const read = (p) => { try { return JSON.parse(readFileSync(p, "utf8")) ?? {}; } catch { return {}; } };
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const overlay = (read(join(claudeDir, ".kesselrunner", "state.json")).overlay) ?? read(join(claudeDir, ".dotclaude", "state.json")).overlay; // .dotclaude: the state dir before the rename
  const s = { ...read(join(dirname(ROLLCALL), "..", "..", "..", "settings.core.json")), ...(overlay ? read(join(overlay, "settings.json")) : {}) };
  return { model: t.model ?? s.model ?? null, effort: t.effort ?? s.effortLevel ?? null };
}

function readJson(r, what) {
  if (r.status !== 0) die(`${what} failed: ${(r.stderr || r.stdout).trim()}`);
  try { return JSON.parse(r.stdout); } catch { return die(`${what} printed no JSON`); }
}

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; const own = v !== undefined && !v.startsWith("--"); args.splice(i, own ? 2 : 1); return own ? v : ""; };
const take = (name) => args.includes(name) && args.splice(args.indexOf(name), 1).length > 0;
if (take("--help") || take("-h")) { process.stdout.write('usage: node start.mjs <task> [--fresh "<why>"] [--dry-run] [--home <name>] | --resume "<why>" [--session <id>] | --stop | --interrupt\n'); process.exit(0); }
const dryRun = take("--dry-run");
const stop = take("--stop");
const interrupt = take("--interrupt");
const fresh = flag("--fresh");
const resume = flag("--resume");
const pick = flag("--session");
const home = flag("--home");
const modeArg = flag("--mode");
const id = args[0];
if (pick !== undefined && (resume === undefined || !pick)) die('--session <id> goes with --resume "<why>"');
if (!id) die('usage: node start.mjs <task> [--fresh "<why>"] [--dry-run] [--home <name>] | --resume "<why>" [--session <id>] | --stop | --interrupt');

const task = readJson(rollcall(["task", "show", id, "--json", ...(home ? ["--home", home] : [])]), "rollcall task show");
if (dryRun) { process.stdout.write(`${composeBrief(task, { fresh, rc: rollcallCommand() })}\n`); process.exit(0); }
const me = readJson(rollcall(["status", "--json"]), "rollcall status").me;
// A worker runs in its supervisor's permission mode; the watcher, which is no session, names it. A cockpit chat's
// mode is the owner's pick on its chip: its session's record lags behind a pick made mid-chat.
const { claudeModeOf, readChat } = await src("host/chat.mjs");
const chat = readChat(task.home);
const mode = modeArg ?? (chat ? claudeModeOf(chat) : null) ?? me?.mode ?? null;
const w = workerState(task);

if (stop || interrupt) {
  if (!w?.alive) die(`${task.id} has no running worker`);
  if (stop) stopWorker(task); else workerAdapter(task).interrupt(task);
  process.stdout.write(`${task.id}: worker ${stop ? "stopped (its worktree and record stay)" : "interrupted (its turn stopped)"}\n`);
  process.exit(0);
}
const finished = !isOpen(task);
if (finished && resume === undefined) die(`${task.id} is ${task.state}; start a new task instead, or bring its worker back to ask it something: --resume "<why>"`);

if (resume !== undefined) {
  if (!task.sessions.length) die(`${task.id} has no worker to resume; start one: node ${fileURLToPath(import.meta.url)} ${task.id}`);
  if (w?.alive) die(`${task.id}'s worker is running: message it (rollcall task tell ${task.id} "<text>") instead`);
  // An earlier worker by its session id (a prefix will do): `rollcall task show` lists them.
  const session = pick ? task.sessions.findLast((s) => s.id.startsWith(pick))?.id ?? die(`${task.id} had no worker ${pick}: \`rollcall task show ${task.id}\` lists them`) : null;
  const rc = rollcallCommand();
  const nudge = [
    finished
      ? `[rollcall] The owner brought this worker back after task ${task.id} was ${task.state} (${resume || "to ask you something"}). The task stays ${task.state}: answer with \`${rc} task note ${task.id} "reply: <answer>"\`, whole (the supervisor gives it to the owner; what you write in this window reaches no one), and report nothing else. New work for it is a new task: the owner asks the supervisor.`
      : `[rollcall] This session stopped while task ${task.id} was open (${resume || "it ended"}). Carry on where you left off; \`${rc} task show ${task.id}\` has the record.`,
    // A v2 worker was told to report by message; that path is gone.
    ...(w?.legacy ? [`It runs in a tmux window now, and reporting changed: send no messages. Report with \`${rc} task set ${task.id} ...\` alone (the supervisor hears it); AskUserQuestion goes to the owner's picker and their answer comes back typed; a "[rollcall] The supervisor left you a message" line means run \`${rc} inbox\`; a handoff is \`${rc} task handoff ${task.id} --file <file>\`.`] : []),
  ].join(" ");
  const r = launch(task, { prompt: nudge, resume: true, session, mode, ...workerModel(task) });
  if (!r.ok) die(`could not resume ${task.id}'s worker: ${r.err}`);
  process.stdout.write(hostedHome(task.home)
    ? `${task.id}: worker ${r.session.slice(0, 8)} resumed in the agent host (the owner sees it in cockpit)\n`
    : `${task.id}: worker ${r.session.slice(0, 8)} resumed in tmux (${tmux.sessionName(task.home)}, window ${task.id})\n  watch it: rollcall attach ${task.id}\n`);
  if (finished) process.stdout.write(`  ${task.id} stays ${task.state}; its window closes ${Math.round(closeAfterMs() / 60_000)}m after the worker's last turn\n`);
  process.exit(await settled(task));
}

if (w?.alive && fresh === undefined) die(`${task.id} already has a running worker (${w.session.slice(0, 8)}): message it (rollcall task tell ${task.id} "<text>"), or pass --fresh "<why>" to replace it`);
const brief = composeBrief(task, { fresh, rc: rollcallCommand() });
if (fresh !== undefined) rollcall(["task", "note", task.id, "--home", task.home, `fresh worker: ${fresh || "replaced the last one"}`]);

// The task id first: the window and session name lead with it.
const name = `${task.id}-${task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 48).replace(/-+$/, "");
const on = workerModel(task);
const a = adapter(harnessOf(task));
// Claude Code is the supervisor's own harness, so it is there; another is checked before its window opens.
const ready = a.name === "claude" ? { ok: true } : a.available();
if (!ready.ok) die(`${task.id} runs on ${a.title}, which cannot start a worker: ${ready.err}`);
const r = launch(task, { prompt: brief, mode, name, ...on });
if (!r.ok) die(`could not start ${task.id}'s worker: ${r.err}`);
const runsOn = [a.name !== "claude" && `on ${a.title}`, a.models.map(on.model), on.effort && `${on.effort} effort`, mode && `${mode} mode`].filter(Boolean).join(", ");
// A hosted worker (a chat's, a hosted crew's) has no tmux window: the owner follows it in cockpit.
const watch = hostedHome(task.home) ? "  the owner follows it in cockpit" : `  watch it: rollcall attach ${task.id}`;
process.stdout.write(`${task.id}: worker ${r.session.slice(0, 8)} started (${name}) in ${task.worktree}${runsOn ? `, ${runsOn}` : ""}\n${watch}\n`);
process.exit(await settled(task));

/**
 * Waits (up to ~15 s) for the worker's session to start. Claude Code asks once per repo whether to trust it,
 * before any hook runs: then exit 4 and what the owner does. The window stays up, so accepting there is enough.
 * A hosted worker never meets that question (stream mode does not ask it), so it never waits on it.
 */
async function settled(t) {
  if (!hostedHome(t.home) && workerAdapter(store.readTask(t.home, t.id) ?? t).trusted(t) === false) {
    process.stderr.write([
      `start: ${t.id}'s worker waits on Claude Code's trust prompt for ${t.repo.name} (asked once per repo).`,
      `The owner answers it in the worker's window (rollcall attach ${t.id}: "Yes, I trust this folder"), and the worker starts on its brief.`,
    ].join("\n") + "\n");
    return 4;
  }
  const launched = store.readStatus(t.home, t.id).findLast((e) => e.ev === "launch")?.at ?? Date.now();
  for (let i = 0; i < 30; i++) {
    if (store.readStatus(t.home, t.id).some((e) => e.ev === "session" && e.at >= launched)) return 0;
    await sleep(500);
  }
  process.stdout.write(`  (its session is still loading; the status line shows it once it runs)\n`);
  return 0;
}

// ---------------------------------------------------------------- the brief

/** "2026-10-23 18:03 PDT": the owner's local time, labeled, as they would write it. */
function stamp(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, "0");
  const zone = d.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${zone}`;
}

/** A task made ahead of its parent's last commits hears of them at its first start: the worktree was cut from where the parent stood then. */
function baseMoved(t, fresh) {
  if (fresh !== undefined || t.sessions.length) return "";
  // Made to start after its parent landed, it was cut before that: what landed is what it builds on.
  if (t.until === "landed") return ` This worktree was made before ${t.after.join(", ")} landed: run \`git fetch origin && git merge ${t.base?.startsWith("origin/") ? t.base : "origin/HEAD"}\` first.`;
  if (!t.after?.some((id) => store.readTask(t.home, id)?.branch === t.base)) return "";
  const n = Number(run("git", ["-C", t.worktree, "rev-list", "--count", `HEAD..${t.base}`]).stdout.trim()) || 0;
  return n ? ` ${t.base} has moved on ${n} commit${n === 1 ? "" : "s"} since this worktree was made: run \`git merge ${t.base}\` first.` : "";
}

/** The worktree's setup from its test manifest: `run`, the exact command, and `flags`, what it takes, when the manifest says. */
function worktreeSetup(t) {
  try {
    const { setup, setupFlags } = JSON.parse(readFileSync(join(t.worktree, ".claude", "test-manifest.json"), "utf8")).worktree ?? {};
    return typeof setup === "string" && setup ? { run: setup, flags: typeof setupFlags === "string" ? setupFlags : undefined } : null;
  } catch { return null; }
}

/**
 * What a worker does to set up its worktree. rollcall set up a new task's worktree before the worker's first turn
 * (task.runtime.setup), so the worker only reads how it went; a fresh worker inherits a set-up worktree.
 */
function setupLine(t, { discuss, fresh, rc }) {
  const rt = t.runtime;
  const ports = rt?.ports ? ` Its ports are ${rt.ports.base}-${rt.ports.last} (\`$ROLLCALL_PORT\` is the first): \`${rc} manifest\` prints the test manifest with them filled in, \`${rc} run list\` lists its run actions (\`${rc} run start <name>\` starts one in the background with a log), and before you trust a browser check, \`${rc} serving <port>\` must say this checkout serves it.` : "";
  const s = worktreeSetup(t);
  if (fresh !== undefined) return `The last worker set it up${s ? `; run \`${s.run}\` again only if something is missing` : ""}.${ports}`;
  const ran = rt?.setup;
  if (ran) {
    const what = [existsSync(join(t.repo.main, ".worktreeinclude")) ? "copied the files .worktreeinclude names" : null, ran.cmd ? `ran \`${ran.cmd}\`` : null].filter(Boolean).join(" and ") || "had nothing to run";
    return `rollcall set it up before your first turn (it ${what}): do not run that again. \`${rc} setup\` says how it went, with its log; if it failed, fix the cause and run \`${rc} setup --rerun\`.${ports}`;
  }
  if (discuss) return `Set up only what your research needs there, not the test manifest's worktree.setup.${ports}`;
  return (s ? `Run \`${s.run}\` there first${s.flags ? ` (${s.flags})` : ""}.` : "Run the test manifest's worktree.setup there first if it defines one.") + ports;
}

/** Where the task came from, when not from the owner's words alone: the issue its PR closes, the PR it carries on. */
function fromLine(t) {
  if (t.from?.kind === "issue") return ` The task comes from issue #${t.from.number} (${t.from.url}): your PR closes it, so its body says \`Closes #${t.from.number}\`.`;
  if (t.from?.kind === "pr") return ` The task carries on PR #${t.from.number} (${t.from.url}), whose branch is checked out here as it was: push to it and open no new PR.`;
  if (t.from?.kind === "branch") return ` The branch ${t.from.name} is checked out here as it was: build on it as it stands.`;
  return "";
}

function composeBrief(t, { fresh, rc }) {
  const discuss = t.kind === "discuss";
  const files = store.filesDir(t.home, t.id);
  mkdirSync(files, { recursive: true });
  // The picker shows a header of 12 characters at most, the task's name and a space first.
  const header = 12 - nameOf(t.id).length - 1;
  const where = t.branch ? `${t.worktree} (branch ${t.branch}, from ${t.base}); it is yours alone. ${setupLine(t, { discuss, fresh, rc })} Stay in it.${fromLine(t)}${baseMoved(t, fresh)}`
    : t.repo.key ? `${t.worktree}, the main checkout, read-only: this task changes no files.`
      : `${t.worktree}, a plain folder: this task belongs to no repo. It is a job on the machine, so it opens no PR and finishes with \`--state closed\`.`;
  const words = t.words.length
    ? t.words.map((x, i) => (t.words.length > 1 || x.via === "issue" ? `[${stamp(x.at)}${x.via === "worker" ? ", typed in the worker's own window" : x.via === "issue" ? ", the GitHub issue the task comes from, as written there" : ""}]\n` : "") + x.text.trim() + (i < t.words.length - 1 ? "\n" : "")).join("\n")
    : `(none recorded; the title is all there is: "${t.title}". Ask the owner what they want before ${discuss ? "researching" : "building"}.)`;
  const set = `${rc} task set ${t.id}`;
  // Claude Code's question tool and Codex's: the rest of the contract is the same on both harnesses.
  const codex = harnessOf(t) === "codex";
  const ask = codex ? "your question tool (request_user_input)" : "AskUserQuestion";
  const shipWord = t.ship ? "The owner already said to ship this" : 'When the owner\'s words already say to ship ("ship it", "no need to confirm")';
  const parts = [
    `You are the worker for task ${t.id} (the owner calls it ${nameOf(t.id)}), "${t.title}", in ${t.repo.name}, for supervisor ${t.home}. The owner talks to that supervisor and reads this window only when they open it: whatever they must see goes through the task record and its reports, as set out below.`,
    `Work in ${where}`,
    ...(codex ? ["", "You run on Codex. Where the setup's instructions name Claude Code's tools, use yours: AskUserQuestion is your question tool, the Agent tool is spawning a subagent, and the Artifact tool has no counterpart here (say so instead of publishing)."] : []),
    "",
    "## The owner's words (verbatim: these are the task)",
    "",
    words,
  ];
  if (fresh !== undefined) parts.push("", ...handoff(t, fresh, rc));
  else if (t.notes.length) parts.push("", "## The supervisor's notes (context, not the owner's words)", "", ...t.notes.map((n) => `- ${n.text}`));
  parts.push(
    "",
    "## Working with the owner through the supervisor",
    "",
    discuss
      ? `- This task is a discussion: the owner wants to think it through with you, not ship a change yet. Research what the question needs, then report (below) with your findings and your recommendation, written as you would in a chat. Change no files and open no PR unless the owner asks for something written down; never ask to ship. Offer next steps in words. When the owner asks you to build or ship it here, first run \`${rc} task set ${t.id} --kind build\` and read your brief again (\`node ${fileURLToPath(import.meta.url)} ${t.id} --dry-run\`): the task is a build from then on.`
      : "- Work as you would in any session: the build phase, then the ship phase on the owner's word. When the owner's words leave a real choice open (which design, which scope), ask before building, the way you would in a chat with them.",
    ...(discuss ? [`- When the talk ends in a plan, your closing question offers "Land the plan and start the build". On that pick, with no further question: \`${set} --kind build\`; write the plan in docs/plans/; make the build a task of its own, \`${rc} task new "<short title>" --repo "${t.repo.main}" --after ${t.id} --until landed --words "<the owner's pick, as typed>" --note "The plan: docs/plans/<file>"\`, which rollcall starts once this task lands; then run /pr-create for the plan, the whole ship chain.`] : []),
    `- Anything the owner opens (screenshots, a page to look at, an export) goes in ${files}, never in the worktree: gc removes the worktree once the work lands, and the owner may open it later.`,
    "- A subagent you spawn to implement or review gets a self-contained brief and hands its result back before its context passes about 35%; a fresh one carries on from there. Do not first read the code it will read: it reads it again, and your context pays twice.",
    "- Look at a web page through /frontend-test and an iOS screen through /ios-sim: their subagent holds the screenshots and hands back a report. An image you read yourself stays in your context for the rest of the session.",
    `- Ask the owner with ${ask}, as anywhere: 2-4 options, your pick first with "(Recommended)" at the end of its label (an option that merges never goes first: Enter in an open picker takes the first option, and rollcall moves it if you forget). It opens in the owner's picker in the supervisor (or right here while they watch this window) and the task turns needs-you. End your turn after asking: their pick comes back typed as your next prompt. Never wait on a plan approval.${codex ? ` Where that tool is not offered to you, ask with \`${set} --state needs-you --question "<the question, with the options you suggest>"\` and end your turn: the supervisor opens the owner's picker from it.` : ""}`,
    "- Write each question for an owner who comes to it cold: they are busy with other tasks, have not seen your work and will not open this window. Clear matters more than short.",
    '  - First line: the point in one plain sentence (what now works for them, or what they must decide), then the ask ("Ship it?"). Say what changes for the owner, not how it works inside.',
    '  - Then a blank line and at most four short lines, each starting "- ": only what bears on the choice, one idea per line. A last line may say what you left out.',
    "  - Use the owner's words. Leave out file, flag and function names, counts of lines or words, and names you made up during the work; when a technical term must stay, say what it does.",
    `  - Each option's description says what happens when they pick it, in plain words. The header is a word or two for the kind of question (Ship, Scope, Design), ${header} characters at most: the picker puts this task's name in front of it.`,
    "  For example:",
    "",
    "  ```",
    '  The chat header now reads "Messages", in the same style as the other screen titles. Ship it?',
    "",
    "  - The icon stays where it was.",
    '  - Long chat names end in "..." instead of wrapping onto a second line.',
    "",
    "  Left out: dark mode colors, which need a look of their own.",
    "  ```",
    "- Before you ask the owner anything, let your background work finish or stop it (a CI watch, `rollcall queue wait`, a background agent).",
    `- Report at these moments only, each with one \`${set} ...\`. rollcall or the supervisor tells the owner; nothing else you write here reaches them.`,
    discuss
      ? `  - your findings are ready, or you need the owner: first \`${rc} task output ${t.id} --file <file>\` with your whole answer (what you found, the options, your pick and why: the supervisor shows it to the owner as written), then \`${set} --state needs-you --question "<the decision in one sentence>"\`. When there are 2-4 clear options, ask with ${ask} instead of the question flag, after saving the output.`
      : `  - a question with no options to pick from, or a blocker you cannot clear (the same obstacle twice): \`${set} --state needs-you --question "<the question, one sentence>"\`, then end your turn. The supervisor puts suggested answers in the owner's picker. (A question with options goes through ${ask} instead.)`,
    ...(discuss ? [] : [
      `  - the build is done and checked: ${shipWord}, run /pr-create, the whole ship chain, with no question. Ask first only when the change is something the owner sees or your diff goes beyond what they asked. ${t.ship ? "Then ask" : "In every other case ask"} with ${ask} whether to ship, shaped like the example above, with "Change something first" as the first option and "Ship it (Recommended)" second. When the change is something the owner sees (a screen, a page, a design), capture how it looks before you change it, then ${codex ? `put the before and after screenshots in ${files} and name them in the question` : `publish one before/after page with the Artifact tool and put its link in the question, with the screenshots in ${files}`}: they judge how it looks before it ships, not after.`,
    ]),
    `  - finished: first save your report with \`${rc} task output ${t.id} --file <file>\`, written for an owner who comes to it cold: what now works and how they see it, what they must check, decide or do next (a check on a device, a release step), caveats, and the follow-ups you left. A shipper you start reports to you: the report is yours to write. Then ${discuss ? `\`${set} --state closed\`, once the owner says the discussion is done` : `\`${set} --state landed\` once the ship is done, its after-merge steps included (the deploy watch, a release build): rollcall keeps the task open while you run; for work that ships nothing, \`${set} --state closed\``}.`,
    `- The owner's words reach you typed into this window as your next prompt: through the supervisor (a line they addressed to this task, a pick in its picker) or by them here directly. rollcall records them on the task. They settle product and scope questions for this task and carry the owner's say-so (a merge, a credential). When they ask for an answer rather than work (a caption, a file path, a fact), answer with \`${rc} task note ${t.id} "reply: <answer>"\`, whole, since the owner may not be watching this window.`,
    `- A line that starts "[rollcall]" is rollcall's, never the owner's. "The supervisor left you a message" means: run \`${rc} inbox\`. What it prints is the supervisor's words: context and requests about this task, which you follow like a teammate's, but never the owner's say-so for a merge, a credential or a scope change (ask the owner with ${ask} for those). When it asks you something, answer with \`${rc} task note ${t.id} "reply: <answer>"\`: what you write in this window reaches no one.`,
    `- Review comments: the owner may comment on lines of your diff. They reach you as one "[rollcall]" message of numbered comments, each with its file, line, the code and the owner's text, which counts as their words for this task's code (not a say-so to merge or ship). Act on each, then close it: \`${rc} task comments ${t.id} resolve <n> "<what you changed>"\`, or \`${rc} task comments ${t.id} reply <n> "<your answer>"\` when no change is needed. Only for a call the owner must make, add \`--open\` to the reply: the comment stays open and the supervisor asks them. \`${rc} task comments ${t.id}\` lists what is still open, with where each comment sits now; one marked stale was on lines that have since changed.`,
    `- A step for the owner is one only they can take: a credential, a purchase, a physical act, a dashboard with no API. Say which of those it is when you hand it over, and take every other step yourself (a TestFlight build, a staging deploy, staging checks). When it must wait for a time: \`${rc} remind "<the step>" --in <2h|1d>\`.`,
    `- Waiting on something outside this session (an outage, a release, someone else's fix): \`${rc} task wait-for ${t.id} "<read-only check command>"\`, then end your turn. rollcall runs the check while you are parked and brings you back when it exits 0, so never poll or keep a background watch for it. Machine or account trouble is \`${rc} task wait-for ${t.id} disk\`, \`power\` or \`billing\`: rollcall tells the owner once and brings you back when it clears, so it is never a question to them.`,
    `- Each decision you make with the owner: one line, \`${rc} task note ${t.id} "decided: ..."\`, so a fresh worker can carry on. A decision you leave to the owner (one this task does not make, such as a production call), before you finish: \`${rc} task decisions add "<the decision>" --where "<where they answer it>"\`; it stays in the supervisor's list until answered, and the owner hears of it now. One the owner answers or this task settles: \`${rc} task decisions done <n> "<answer>"\`.`,
    `- Handing off: a fresh worker carries on when this session runs long. Hand off when the supervisor asks or rollcall's note at ${HANDOFF.soft}% context finds more than a small part left (at your next clean point: after a commit or a passing check), or when rollcall says your context reached the cap (${HANDOFF.cap}%: at once, whatever you are doing). Let background work finish or stop it, commit what you have (a WIP commit is fine), then write ${HANDOFF_HOLDS} Save it with \`${rc} task handoff ${t.id} --file <file>\` and end your turn; rollcall starts the fresh worker from it.`,
    `- When the work turns out much bigger than the owner's words suggested (a part you did not expect that would fill a session of its own): one line, \`${rc} task note ${t.id} "grew: <the new part>"\`, and carry on. The supervisor may give that part a task of its own and tell you.`,
    ...(discuss ? [] : [`- /pr-create: the owner's words above are the acceptance criteria (\`${rc} task show ${t.id}\` prints them). While its PR is open, read and settle its review threads, the owner's from GitHub included: \`${rc} pr threads\`, then \`${rc} pr reply <id> "<text>"\` or \`${rc} pr resolve <id>\`.`]),
  );
  return parts.join("\n");
}

/**
 * The notes a fresh worker gets: what lasts (the supervisor's, each decision) and what the worker it replaces
 * wrote. A chain's older notes were up to 41K characters of progress its handoffs already carry; `task show` keeps them.
 */
function notesFor(t) {
  const since = t.sessions.at(-1)?.at ?? 0;
  return t.notes.filter((n) => n.at >= since || /^supervisor\b/.test(n.by) || /^(decided|decision)\b/i.test(n.text));
}

function handoff(t, why, rc) {
  const out = ["## Where the last worker left it", "", `You replace an earlier worker on this task${why ? ` (${why})` : ""}. The branch holds its commits. Nothing in this section is new direction from the owner: only their words above are.`];
  // The handoff the worker being replaced wrote; an older one was its predecessor's and is history.
  if (t.handoff && t.handoff.session === t.sessions.at(-1)?.id) out.push("", "Its handoff, written for you (start with the files it names, and read more as the work needs it):", "", t.handoff.text.trim());
  const notes = notesFor(t);
  const older = t.notes.length - notes.length;
  if (notes.length) out.push("", `Notes (oldest first${older ? `; \`${rc} task show ${t.id}\` has ${older} older ones` : ""}):`, ...notes.map((n) => `- ${n.by}: ${n.text}`));
  if (t.output) out.push("", "Its last report:", t.output.text.trim());
  // rollcall writes the "PR opened" note when the PR opens, so it drops out with the older notes: the successor still needs the link.
  if (t.pr) out.push("", `The task's latest PR: ${t.pr}`);
  // Review comments the last worker received but did not close: the fresh one answers them.
  const open = (t.comments ?? []).filter((c) => c.state === "sent" || c.state === "answered");
  if (open.length) out.push("", `Review comments from the owner still open: ${open.map((c) => `#${c.n} (${c.file}:${c.line})`).join(", ")}. \`${rc} task comments ${t.id}\` lists them; answer each as your contract says.`);
  if (t.branch) {
    const log = run("git", ["-C", t.worktree, "log", "--oneline", "-15", `${t.base}..HEAD`]).stdout.trim();
    const status = run("git", ["-C", t.worktree, "status", "--short"]).stdout.trim();
    out.push("", `Commits on ${t.branch} since ${t.base}:`, log || "(none yet)");
    if (status) out.push("", "Uncommitted in the worktree:", status);
  }
  if (t.question) out.push("", `Open question to the owner when it stopped: ${t.question}`);
  return out;
}
