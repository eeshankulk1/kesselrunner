// The front-end interface's actions (`rollcall api do <action> <json>`): everything the terminal Falcon can do for
// the owner, as named actions with a JSON payload and a JSON result. Each runs the same code as the command the
// supervisor runs for it (ACTIONS[name].cli), so neither front end can do what the other cannot. Each is safe to
// repeat: a payload with a `requestId` seen in the last day returns the first result again, and races between two
// front ends settle here (the first answer to a question wins), not in each front end.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { answerFromFrontEnd } from "./answer.mjs";
import { allowAll, answerHeld, setAway } from "./away.mjs";
import { parseRef, refOf, taskView } from "./api.mjs";
import { isOpen } from "./state.mjs";
import * as store from "./store.mjs";
import { deliverWords, holderOf, hostedTask, label, workerState } from "./supervisor.mjs";
import { callSync, hostedHome } from "./host/client.mjs";
import { endCrew, newCrew } from "./host/crew.mjs";
import { CLAUDE_MODES, chatView, isChat, newChat, searchChats, setTitle, unarchiveChat } from "./host/chat.mjs";
import { SET_MODES } from "./claude/stream.mjs";
import * as live from "./claude/live.mjs";
import { modelOk } from "./harness/claude.mjs";
import { models as codexModels } from "./harness/codex.mjs";
import { turnDiff, turnsCommand, worktreeOf } from "./snapshot.mjs";
import { PATCH_MAX, checkLog, commentsNow, prTimeline, repoItems, runLog, taskDiff, turnsOf } from "./api-reads.mjs";
import { answerDecision, recordWords, taskCommand } from "./task.mjs";
import * as tmux from "./tmux.mjs";
import { closeBlocker } from "./trouble.mjs";
import { NAMES as HARNESS_NAMES, harnessName, harnessOf } from "./harness/index.mjs";

/** kesselrunner's launcher, beside this package (the watcher runs the same file). */
const START_FILE = process.env.ROLLCALL_START_FILE || fileURLToPath(new URL("../../../scripts/supervisor/start.mjs", import.meta.url));

export class ApiError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}
const refuse = (code, message, extra) => { throw new ApiError(code, message, extra); };

// ---------------------------------------------------------------- the commands the Falcon runs, as code

function flag(args, name) {
  const values = [];
  for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) {
    if (i + 1 >= args.length) refuse("bad-payload", `${name} needs a value`);
    values.push(args[i + 1]);
    args.splice(i, 2);
  }
  return values;
}

/**
 * Runs `rollcall task <argv>` as the owner from a front end: the same code the supervisor's command runs. A
 * refusal (ctx.fail) is an ApiError "refused" with the command's own words. Returns what it printed.
 */
function task(argv) {
  const out = [];
  const ctx = { say: (s) => out.push(String(s)), fail: (m) => refuse("refused", String(m).replace(/^rollcall:\s*/, "")), flag, whoAmI: () => null };
  const code = taskCommand([...argv], ctx);
  // A command that finishes later (task new and plan A's) goes through taskLater: a promise here is truthy.
  if (typeof code?.then === "function") throw new Error(`rollcall task ${argv[0]} finishes later: call it through taskLater`);
  if (code) refuse("refused", out.join("\n") || `rollcall task ${argv[0]} exited ${code}`);
  return out.join("\n");
}

/** The ctx a shared command's code takes from a front end: a refusal is an ApiError "refused". */
const CTX = { say: () => {}, fail: (m) => refuse("refused", String(m).replace(/^rollcall:\s*/, "")), flag, whoAmI: () => null };

/** `task(argv)` for a command that finishes later (the worktree runtime's, which load their code when run). */
async function taskLater(argv) {
  const out = [];
  const ctx = { say: (s) => out.push(String(s)), fail: (m) => refuse("refused", String(m).replace(/^rollcall:\s*/, "")), flag, whoAmI: () => null };
  const code = await taskCommand([...argv], ctx);
  if (code) refuse("refused", out.join("\n") || `rollcall task ${argv[0]} exited ${code}`);
  return out.join("\n");
}

/** kesselrunner's launcher for task `t`: { code, out }. Exit 4: the worker waits on Claude Code's trust prompt for its repo. */
function start(t, args) {
  if (!existsSync(START_FILE)) refuse("unavailable", `kesselrunner's launcher is not at ${START_FILE}`);
  // A worker runs in its supervisor's permission mode, as when the supervisor starts it (start.mjs reads its own
  // session's otherwise, and a front end is none).
  const mode = holderOf(t.home)?.mode;
  const r = spawnSync(process.execPath, [START_FILE, t.id, "--home", t.home, ...(mode ? ["--mode", mode] : []), ...args], { encoding: "utf8", timeout: 120_000 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

// ---------------------------------------------------------------- payloads

const str = (p, k, { required = true, max = 50_000 } = {}) => {
  const v = p[k];
  if (v === undefined || v === null || v === "") { if (required) refuse("bad-payload", `${k} is required`); return null; }
  if (typeof v !== "string") refuse("bad-payload", `${k} is a string`);
  if (v.length > max) refuse("bad-payload", `${k} is ${v.length} characters, over the limit of ${max}`);
  return v;
};

/** The task a payload names (`task`: "falcon:t3" or "falcon:luke"), read now. */
function taskOf(p) {
  const r = parseRef(str(p, "task"));
  if (!r?.id) refuse("bad-payload", `task is "<supervisor>:<task>", like falcon:t3: ${p.task}`);
  const t = store.readTask(r.home, r.id);
  if (!t) refuse("not-found", `no task ${r.id} in supervisor ${r.home}`);
  return t;
}
const homeOf = (p) => {
  const h = str(p, "home");
  if (!store.HOME_NAME.test(h)) refuse("bad-payload", `home is a supervisor name, like falcon: ${h}`);
  return h;
};
const fresh = (t) => taskView(store.readTask(t.home, t.id) ?? t);

/** What a payload's `task` names: a task (`falcon:t3`), or with a bare home (`falcon`) the supervisor itself. */
function targetOf(p) {
  const ref = str(p, "task");
  if (!ref.includes(":") && store.HOME_NAME.test(ref) && store.listHomes().includes(ref)) return { h: ref, id: null, t: null };
  const t = taskOf(p);
  return { h: t.home, id: t.id, t };
}
/** The target's view after an action: the task's, or null for the supervisor itself. */
const viewAfter = (x) => (x.t ? fresh(x.t) : null);

/** Files a front end attached: absolute paths that exist, ten at most. */
function attachmentsOf(p) {
  if (p.attachments === undefined || p.attachments === null) return [];
  if (!Array.isArray(p.attachments) || p.attachments.some((a) => typeof a !== "string" || !a.startsWith("/"))) refuse("bad-payload", "attachments are absolute paths");
  // The path goes into the worker's text as "[Attached: a, b]": a newline or a ", /" would forge a second file or line.
  if (p.attachments.some((a) => /[\x00-\x1f\x7f]|, \//.test(a))) refuse("bad-payload", "an attachment path has a control character or \", /\"");
  if (p.attachments.length > 10) refuse("bad-payload", "attachments: ten at most");
  const missing = p.attachments.filter((a) => !existsSync(a));
  if (missing.length) refuse("bad-payload", `no such file: ${missing.join(", ")}`);
  return p.attachments;
}

/** The chat a payload's `home` names. */
function chatHome(p) {
  const h = homeOf(p);
  if (!isChat(h)) refuse("not-found", `no chat ${h}`);
  return h;
}

/** A hosted crew's running agent, for an action only the agent host serves: refused for a terminal crew's. */
function hostedAgent(x, what) {
  const who = x.t ? label(x.t) : `supervisor ${x.h}`;
  if (!hostedHome(x.h)) refuse("refused", `${who} runs in a terminal (tmux), not the agent host: ${what} there`);
  const rec = live.record(x.h, x.id);
  if (!rec) refuse("refused", `${who} has no agent running in the host: ${what} needs one`);
  return rec;
}

// ---------------------------------------------------------------- the actions

/**
 * name -> { cli: the command the Falcon runs for it, run(payload, client) -> result }. Plans add theirs here as they
 * land (archive, restore, spotlight and run actions; review comments).
 */
export const ACTIONS = {
  "task.start": {
    cli: "rollcall task new + start.mjs",
    async run(p) {
      const h = homeOf(p);
      // Checked before the task exists: a front end retrying a refusal must not make a second task.
      if (!existsSync(START_FILE)) refuse("unavailable", `kesselrunner's launcher is not at ${START_FILE}`);
      // A task from an issue or a PR takes its title (and an issue its words) from GitHub; one from a branch, its name.
      const from = p.issue ?? p.pr ?? null;
      const title = str(p, "title", { max: 200, required: !from });
      const words = str(p, "words", { required: !from && !p.branch });
      const repo = str(p, "repo", { required: !p.noRepo });
      if (p.harness !== undefined && !harnessName(p.harness)) refuse("bad-payload", `harness is one of ${HARNESS_NAMES.join(", ")}`);
      const tmp = join(store.homeDir(h), "api");
      mkdirSync(tmp, { recursive: true });
      const file = join(tmp, `words-${process.pid}-${Date.now()}.txt`);
      if (words) writeFileSync(file, words);
      const argv = ["new", ...(title ? [title] : []), "--home", h, ...(words ? ["--words-file", file] : []), "--json"];
      for (const k of ["issue", "pr", "branch"]) if (p[k] !== undefined && p[k] !== null) argv.push(`--${k}`, String(p[k]));
      if (p.noRepo) argv.push("--no-repo"); else argv.push("--repo", repo);
      for (const [k, f] of [["type", "--type"], ["kind", "--kind"], ["model", "--model"], ["effort", "--effort"], ["base", "--base"], ["slug", "--slug"], ["harness", "--harness"]]) if (p[k]) argv.push(f, String(p[k]));
      for (const a of p.after ?? []) argv.push("--after", String(a));
      for (const n of p.notes ?? []) argv.push("--note", String(n));
      if (p.until) argv.push("--until", String(p.until));
      for (const [k, f] of [["ship", "--ship"], ["browser", "--browser"], ["hold", "--hold"]]) if (p[k]) argv.push(f);
      let made;
      try { made = JSON.parse(await taskLater(argv)); } finally { rmSync(file, { force: true }); }
      // A task that waits on others (or is held) starts later, by rollcall or on the owner's word.
      if (made.after?.length || made.hold) return { task: refOf(made), started: false, view: fresh(made) };
      const s = start(made, []);
      return { task: refOf(made), started: s.code === 0, trustPrompt: s.code === 4, message: s.out || null, view: fresh(made) };
    },
  },

  // The owner's words for a worker, as their `@luke <text>` line in the Falcon would send them: typed in, on the record.
  "task.tell": {
    cli: "@<task> <text> in the Falcon",
    run(p, client) {
      const x = targetOf(p);
      const said = str(p, "text").trim();
      if (!said) refuse("bad-payload", "text is required");
      const files = attachmentsOf(p);
      if (files.length && !hostedHome(x.h)) refuse("refused", "attachments go to a hosted crew's agents only");
      const text = live.withAttachments(said, files);
      // The owner's line to a hosted supervisor itself (its chat's composer): through the host, as a line they typed.
      if (!x.t) {
        if (!hostedHome(x.h)) refuse("refused", `supervisor ${x.h} runs in a terminal: the owner types to it there`);
        const { body, attachments } = live.attachmentsIn(text);
        const r = callSync("say", { ref: x.h, text: body, attachments, from: "owner" });
        if (!r.ok) refuse("failed", r.error?.message ?? "the supervisor did not take the words");
        return { delivered: true, how: r.how ?? null, why: null, view: null };
      }
      const t = x.t;
      if (!isOpen(t) && !t.sessions?.length) refuse("refused", `${label(t)} is ${t.state} and never had a worker`);
      const r = deliverWords(t, text, {
        record: (x) => recordWords(t, x, "app", (rec) => { rec.words.at(-1).client = client; }),
        mode: holderOf(t.home)?.mode ?? null,
      });
      return { delivered: r.ok, how: r.how ?? null, why: r.why ?? null, view: fresh(t) };
    },
  },

  // A pick in the Falcon's picker, from a front end: the first answer wins (answer.mjs).
  "question.answer": {
    cli: "a pick in the Falcon's picker",
    run(p, client) {
      const t = taskOf(p);
      const r = answerFromFrontEnd(t.home, t.id, { qid: str(p, "question"), answers: p.answers ?? null, answer: p.answer ?? null, client });
      if (!r.ok) refuse(r.code, r.message, { answered: r.answered ?? null, current: r.current ?? null });
      return { delivered: true, how: r.how, why: r.why, pickerClosed: r.pickerClosed, view: fresh(t) };
    },
  },

  // Esc in the worker's window: its turn stops, as the owner's Esc would.
  "task.interrupt": {
    cli: "start.mjs <task> --interrupt",
    run(p) {
      const x = targetOf(p);
      // A hosted crew's agent (a task's or the supervisor's own) has no window: the host stops its turn.
      if (hostedHome(x.h)) {
        const r = callSync("interrupt", { ref: x.t ? `${x.h}:${x.id}` : x.h });
        return r.ok ? { interrupted: r.interrupted === true } : { interrupted: false, why: r.error?.message };
      }
      if (!x.t) refuse("bad-payload", "task is a task ref like falcon:t3");
      const t = x.t;
      const w = tmux.windowOf(t.home, t.id);
      if (!w?.alive) return { interrupted: false, why: "its worker is not running" };
      return { interrupted: tmux.interrupt(t.home, t.id) };
    },
  },

  // An answer to a hosted agent's open request: a permission prompt, a plan to approve, a question (host/server.mjs).
  "prompt.answer": {
    cli: "the prompt in the worker's window",
    run(p, client) {
      const x = targetOf(p);
      const id = str(p, "prompt", { max: 200 });
      hostedAgent(x, "answer its prompt");
      for (const k of ["allow", "always"]) if (p[k] !== undefined && typeof p[k] !== "boolean") refuse("bad-payload", `${k} is true or false`);
      if (p.answers !== undefined && (typeof p.answers !== "object" || p.answers === null || Array.isArray(p.answers))) refuse("bad-payload", "answers maps each question to its answer");
      if (p.mode !== undefined && !["acceptEdits", "default"].includes(p.mode)) refuse("bad-payload", "mode is acceptEdits or default");
      const why = str(p, "why", { required: false, max: 2000 });
      const r = live.send(x.h, x.id, { op: "answer", prompt: id, allow: typeof p.allow === "boolean" ? p.allow : null, why, always: p.always === true, mode: p.mode ?? null, answers: p.answers ?? null, by: client });
      if (r.code === "not-found") refuse("not-found", `no prompt ${id} in that agent`);
      if (r.code === "bad-payload") refuse("bad-payload", r.err);
      if (!r.ok) refuse("failed", r.err ?? "the agent did not take the answer");
      return { answered: !!r.answered, already: !!r.already, view: viewAfter(x) };
    },
  },

  // The model or permission mode of a hosted agent, changed in its running session (as /model or Shift-Tab would).
  "worker.set": {
    cli: "/model or Shift-Tab in the worker's window",
    run(p) {
      const x = targetOf(p);
      const model = str(p, "model", { required: false, max: 100 });
      const mode = str(p, "mode", { required: false, max: 40 });
      if (!model && !mode) refuse("bad-payload", "model or mode is required");
      const codex = !!x.t && harnessOf(x.t) === "codex";
      if (codex && mode) refuse("bad-payload", "a Codex worker keeps the permission mode it started with: set its model only");
      if (codex && !codexModels.ok(model)) refuse("bad-payload", `model is one of Codex's own, like gpt-5.6-terra: ${model}`);
      if (!codex && model && !modelOk(model)) refuse("bad-payload", `model is an alias or an id, like opus or claude-opus-5-5: ${model}`);
      if (mode && !SET_MODES.has(mode)) refuse("bad-payload", `mode is one of ${[...SET_MODES].join(", ")}`);
      hostedAgent(x, "change its model or mode");
      const r = live.send(x.h, x.id, { op: "set", model, mode });
      if (!r.ok) refuse("failed", r.err ?? "the agent refused");
      return { set: r.set ?? {}, view: viewAfter(x) };
    },
  },

  // A new hosted crew: a supervisor in the agent host, working in `cwd` (host/crew.mjs). Its tasks run there too.
  "supervisor.new": {
    cli: "rollcall host new [--cwd <dir>] [--name <h>]",
    run(p) {
      const cwd = str(p, "cwd", { max: 4096 });
      if (!cwd.startsWith("/")) refuse("bad-payload", "cwd is an absolute path");
      const name = str(p, "name", { required: false, max: 24 });
      const r = newCrew({ cwd, name: name ?? null });
      if (!r.ok) refuse(r.code, r.err);
      return { home: r.home, session: r.session, runtime: r.runtime };
    },
  },

  // A new chat (host/chat.mjs): an ordinary session in the agent host, in its own worktree and branch, started on the
  // owner's words. It answers once the agent is started, never waiting on the first turn.
  "chat.new": {
    cli: "a new chat in cockpit",
    async run(p) {
      const cwd = str(p, "cwd", { max: 4096 });
      if (!cwd.startsWith("/")) refuse("bad-payload", "cwd is an absolute path");
      let dir = false;
      try { dir = statSync(cwd).isDirectory(); } catch {}
      if (!dir) refuse("bad-payload", `no such folder: ${cwd}`);
      const text = str(p, "text");
      if (!text.trim()) refuse("bad-payload", "text is required");
      const attachments = attachmentsOf(p);
      const model = str(p, "model", { required: false, max: 100 }) ?? "opus";
      if (codexModels.ok(model)) refuse("not-available", "a chat on Codex is not built yet: pick a Claude model");
      if (!modelOk(model)) refuse("bad-payload", `model is an alias or an id, like opus or claude-opus-5-5: ${model}`);
      const mode = str(p, "mode", { required: false, max: 40 }) ?? "default";
      if (!CLAUDE_MODES.some((m) => m.id === mode)) refuse("bad-payload", `mode is one of ${CLAUDE_MODES.map((m) => m.id).join(", ")}`);
      const title = str(p, "title", { required: false, max: 200 });
      if (title !== null && !title.trim()) refuse("bad-payload", "title is empty");
      const r = await newChat({ folder: cwd, text, attachments, model, mode, title: title?.trim() ?? null });
      if (!r.ok) refuse(r.code, r.err, r.home ? { home: r.home } : undefined);
      return { home: r.home, ref: r.home, chat: r.chat, session: r.session };
    },
  },

  "chat.rename": {
    cli: "rename in cockpit's sidebar",
    run(p) {
      const h = chatHome(p);
      const title = str(p, "title", { max: 200 }).trim().replace(/\s+/g, " ");
      if (!title) refuse("bad-payload", "title is empty");
      if (!setTitle(h, title, "owner")) refuse("not-found", `no chat ${h}`);
      return { chat: chatView(h) };
    },
  },

  // Archived: its process ends (its session is saved), and the owner's words bring it back. Refused with open tasks.
  "chat.archive": {
    cli: "archive in cockpit's sidebar",
    run(p) {
      const h = chatHome(p);
      const r = callSync("chat-archive", { ref: h, by: "owner" });
      if (!r.ok) refuse(r.error?.code ?? "failed", r.error?.message ?? "the agent host did not archive it");
      return { chat: chatView(h) };
    },
  },

  "chat.unarchive": {
    cli: "unarchive in cockpit's sidebar",
    run(p) {
      const h = chatHome(p);
      unarchiveChat(h);
      return { chat: chatView(h) };
    },
  },

  // Every chat's title and history (the owner's words and the replies), archived ones included. Read-only.
  "chat.search": {
    cli: "search in cockpit's sidebar",
    repeatable: true,
    run(p) {
      const query = str(p, "query", { max: 200 });
      if (!query.trim()) refuse("bad-payload", "query is required");
      if (p.limit !== undefined && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 200)) refuse("bad-payload", "limit is a whole number from 1 to 200");
      return { results: searchChats(query, { limit: p.limit ?? 30 }) };
    },
  },

  // Ends a hosted crew: its workers and its supervisor stop, their sessions saved.
  "supervisor.end": {
    cli: "rollcall host end <h>",
    run(p) {
      const h = str(p, "home", { max: 24 });
      const r = endCrew(h);
      if (!r.ok) refuse(r.code, r.err);
      return { stopped: r.stopped };
    },
  },

  "task.stop": {
    cli: "start.mjs <task> --stop",
    run(p) {
      const t = taskOf(p);
      if (!hostedTask(t) && !tmux.windowOf(t.home, t.id)) return { stopped: false, why: "it has no worker window", view: fresh(t) };
      const s = start(t, ["--stop"]);
      if (s.code) refuse("failed", s.out);
      return { stopped: true, view: fresh(t) };
    },
  },

  "task.resume": {
    cli: 'start.mjs <task> --resume "<why>"',
    run(p, client) {
      const t = taskOf(p);
      if (hostedTask(t) ? workerState(t)?.alive : tmux.windowOf(t.home, t.id)?.alive) return { resumed: false, why: "its worker runs already", view: fresh(t) };
      const s = start(t, ["--resume", str(p, "why", { required: false, max: 300 }) ?? `the owner brought it back from ${client}`]);
      if (s.code && s.code !== 4) refuse("failed", s.out);
      return { resumed: s.code === 0, trustPrompt: s.code === 4, message: s.out || null, view: fresh(t) };
    },
  },

  "task.close": {
    cli: 'rollcall task close <task> "<why>"',
    run(p, client) {
      const t = taskOf(p);
      if (t.state === "closed") return { closed: true, already: true, view: fresh(t) };
      const why = str(p, "why", { required: false, max: 300 });
      task(["close", t.id, "--home", t.home, `from ${client}${why ? `: ${why}` : ""}`]);
      return { closed: true, view: fresh(t) };
    },
  },

  "task.move": {
    cli: "rollcall task move <task> --to <supervisor> | --harness <claude|codex>",
    run(p) {
      const t = taskOf(p);
      // To the other harness: a fresh worker there carries on from the task's record (task.mjs moveHarness).
      if (p.harness !== undefined) {
        const on = harnessName(p.harness);
        if (!on) refuse("bad-payload", `harness is one of ${HARNESS_NAMES.join(", ")}`);
        if (harnessOf(t) === on) return { moved: true, already: true, harness: on, view: fresh(t) };
        task(["move", t.id, "--home", t.home, "--harness", on]);
        return { moved: true, harness: on, view: fresh(t) };
      }
      const to = str(p, "to");
      if (t.movedTo?.startsWith(`${to}:`)) return { moved: true, already: true, task: t.movedTo };
      task(["move", t.id, "--home", t.home, "--to", to]);
      const now = store.readTask(t.home, t.id);
      return { moved: true, task: now?.movedTo ?? null };
    },
  },

  "decision.answer": {
    cli: 'rollcall task decisions done <n> "<answer>"',
    run(p) {
      const n = Number(String(p.n ?? "").replace(/^d/i, ""));
      if (!Number.isInteger(n) || n < 1) refuse("bad-payload", "n is the decision's number");
      if (!store.readDecisions().items.some((d) => d.n === n)) return { answered: true, already: true };
      // The same code as `rollcall task decisions done`: the deciding task's worker hears the answer, which wakes it.
      const r = answerDecision(n, str(p, "answer", { required: false, max: 2000 }) ?? "", null, CTX);
      if (!r) return { answered: true, already: true };
      return { answered: true, delivered: r.delivered, how: r.how };
    },
  },

  // Away mode (away.mjs): the machine's switch, and the owner's answers to what it held.
  "away.set": {
    cli: "rollcall away on|off",
    run(p, client) {
      if (typeof p.on !== "boolean") refuse("bad-payload", "on is true (away) or false (back)");
      const r = setAway(p.on, client);
      if (!r) refuse("busy", "the away record stayed locked; try again");
      return r;
    },
  },

  "held.answer": {
    cli: "rollcall away allow|deny <id> [\"<why>\"]",
    run(p, client) {
      const id = str(p, "id", { max: 100 });
      if (typeof p.allow !== "boolean") refuse("bad-payload", "allow is true (approve) or false (deny)");
      const why = str(p, "why", { required: false, max: 2000 });
      const r = answerHeld(id, { allow: p.allow, why, by: client });
      if (r.code === "not-found") refuse("not-found", `no held request ${id}`);
      if (r.code === "busy") refuse("busy", "the held list stayed locked; try again");
      const { home, id: tid } = parseRef(r.item.ref) ?? {};
      const t = tid ? store.readTask(home, tid) : null;
      const view = t ? fresh(t) : null;
      // A repeat of the same answer is harmless; the other answer, given first elsewhere, is refused with it.
      if (r.already) {
        if (r.item.answer?.allow !== p.allow) refuse("already-answered", `held request ${id} was ${r.item.state} already, from ${r.item.answer?.by}`, { answer: r.item.answer });
        return { answered: true, already: true, delivered: false, how: null, view };
      }
      return { answered: true, already: false, delivered: r.delivered, how: r.how, view };
    },
  },

  "held.allowAll": {
    cli: "rollcall away allow-all",
    run(p, client) {
      const home = p.home === undefined || p.home === null ? null : homeOf(p);
      const r = allowAll({ home, by: client });
      if (!r) refuse("busy", "the held list stayed locked; try again");
      return r;
    },
  },

  // A line comment on a task's diff, as `rollcall task comment` leaves one; `send: true` sends every pending one too.
  "review.comment": {
    cli: 'rollcall task comment <task> <file>:<line>[-<end>] "<text>"',
    run(p) {
      const t = taskOf(p);
      const file = str(p, "file", { max: 1000 });
      const line = p.line;
      const end = p.end ?? null;
      if (!Number.isInteger(line) || line < 1 || (end !== null && (!Number.isInteger(end) || end < line))) refuse("bad-payload", "line is a number from 1, and end (optional) one at or after it");
      const text = str(p, "text");
      // What the command would read as stdin or a help flag rather than as the comment.
      if (["-", "-h", "--help"].includes(text.trim())) refuse("bad-payload", "text is the comment itself");
      if (p.send !== undefined && typeof p.send !== "boolean") refuse("bad-payload", "send is true or false");
      const out = task(["comment", t.id, "--home", t.home, `${file}:${line}${end !== null && end !== line ? `-${end}` : ""}`, text]);
      // Its own number, as the command printed it: another front end may have added one since.
      const n = Number(/comment #(\d+)/.exec(out)?.[1]);
      if (!n) refuse("failed", `the comment command printed no number: ${out}`);
      if (!p.send) return { comment: n, sent: false, message: null, view: fresh(t) };
      // The comment is saved either way: a send that fails comes back as sent: false, so a retry never adds it twice.
      try { return { comment: n, sent: true, message: task(["comments", t.id, "--home", t.home, "send"]), view: fresh(t) }; }
      catch (e) { if (!(e instanceof ApiError)) throw e; return { comment: n, sent: false, message: e.message, view: fresh(t) }; }
    },
  },

  // Every pending comment to the worker as one message, as `rollcall task comments <task> send` does.
  "review.send": {
    cli: "rollcall task comments <task> send",
    run(p) {
      const t = taskOf(p);
      return { message: task(["comments", t.id, "--home", t.home, "send"]), view: fresh(t) };
    },
  },

  // What turn n of a task's worktree changed (turn n-1 to turn n): { from, to, files, patch }.
  // Read-only and safe to repeat, so a requestId keeps no copy of it (a patch can be large).
  "turn.diff": {
    cli: "rollcall turns diff <n> <task> --json",
    repeatable: true,
    run(p) {
      const t = taskOf(p);
      if (!Number.isInteger(p.n) || p.n < 0) refuse("bad-payload", "n is a turn number from 0");
      const wt = t.worktree ? worktreeOf(t.worktree) : null;
      if (!wt) refuse("refused", `${label(t)} has no linked worktree with turns`);
      let d;
      try { d = turnDiff(wt, p.n, { rich: true }); } catch (e) { refuse(/^no turn /.test(e.message) ? "not-found" : "failed", e.message); }
      // Every file is named; the patch stops at 1 MB (the CLI's `rollcall turns diff` prints all of it).
      const cut = d.patch.length > PATCH_MAX;
      return { ...d, patch: cut ? d.patch.slice(0, PATCH_MAX) : d.patch, truncated: cut };
    },
  },

  // Review and ship reads (cockpit's review and ship panels, api-reads.mjs). Read-only and safe to repeat, so a
  // requestId keeps no copy of them; those that ask GitHub call gh and answer `unavailable` without it.
  "task.diff": {
    cli: "git diff <merge-base with main | HEAD> [worktree] in its worktree",
    repeatable: true,
    run(p) {
      const t = taskOf(p);
      const against = str(p, "against", { required: false }) ?? "base";
      if (!["base", "committed", "uncommitted"].includes(against)) refuse("bad-payload", "against is base, committed or uncommitted");
      return taskDiff(t, against, refuse);
    },
  },

  "turns.list": {
    cli: "rollcall turns <task> --json",
    repeatable: true,
    run(p) { return { turns: turnsOf(taskOf(p), refuse) }; },
  },

  // Puts the worktree's files back to turn n, as `rollcall turns restore` does; refused while its worker is mid-turn.
  "turn.restore": {
    cli: "rollcall turns restore <n> <task>",
    async run(p) {
      const t = taskOf(p);
      if (!Number.isInteger(p.n) || p.n < 0) refuse("bad-payload", "n is a turn number from 0");
      if (!turnsOf(t, refuse).some((x) => x.n === p.n)) refuse("not-found", `no turn ${p.n} in ${label(t)}'s worktree`);
      const out = [];
      const ctx = { say: (s) => out.push(String(s)), fail: (m) => refuse("refused", String(m).replace(/^rollcall:\s*/, "")), flag, whoAmI: () => null };
      const code = await turnsCommand(["restore", String(p.n), t.id, "--home", t.home, "--json"], ctx);
      if (code) refuse("refused", out.join("\n") || `rollcall turns restore exited ${code}`);
      const r = JSON.parse(out.join("\n"));
      const message = r.files.length
        ? `restored to turn ${p.n}: ${r.files.length} file${r.files.length === 1 ? "" : "s"} written or removed (HEAD, branch and index unchanged)`
        : `the worktree already matched turn ${p.n}; nothing changed`;
      return { restored: p.n, undo: r.before, files: r.files, message, view: fresh(t) };
    },
  },

  "review.comments": {
    cli: "rollcall task comments <task> --json",
    repeatable: true,
    run(p) { return { comments: commentsNow(taskOf(p)) }; },
  },

  "pr.timeline": {
    cli: "gh: the PR, its checks, deployments, reviews and threads, and main's checks",
    repeatable: true,
    run(p) { return prTimeline(taskOf(p), refuse); },
  },

  "check.log": {
    cli: "gh run view --job <id> --log-failed (else --log)",
    repeatable: true,
    run(p) {
      const t = taskOf(p);
      const id = p.id ?? null;
      const name = str(p, "name", { required: false, max: 300 });
      if (id !== null && (!Number.isInteger(id) || id < 1)) refuse("bad-payload", "id is a check's id from pr.timeline");
      if (id === null && !name) refuse("bad-payload", "id or name is required");
      return checkLog(t, { id, name }, refuse);
    },
  },

  "repo.items": {
    cli: "gh issue list + gh pr list + origin's branches",
    repeatable: true,
    run(p) { return repoItems(str(p, "repo", { max: 4096 }), refuse); },
  },

  // The worktree runtime (plan A). Archive shows what goes first, as the Falcon does: the owner says yes with confirm.
  "task.archive": {
    cli: "rollcall task archive <task> [--yes]",
    async run(p) {
      const t = taskOf(p);
      if (t.archived) return { archived: true, already: true, view: fresh(t) };
      if (p.confirm !== true) {
        const { archivePlan, planLines } = await import("./archive.mjs");
        const plan = archivePlan(t);
        if (plan.err) refuse("refused", plan.err);
        return { archived: false, plan: { ...plan, lines: planLines(t, plan) }, confirmWith: { task: refOf(t), confirm: true } };
      }
      const said = await taskLater(["archive", t.id, "--home", t.home, "--yes"]);
      return { archived: true, message: said, view: fresh(t) };
    },
  },

  "task.restore": {
    cli: "rollcall task restore <task>",
    async run(p) {
      const t = taskOf(p);
      if (!t.archived) return { restored: true, already: true, view: fresh(t) };
      const said = await taskLater(["restore", t.id, "--home", t.home]);
      return { restored: true, message: said, view: fresh(t) };
    },
  },

  "task.spotlight": {
    cli: "rollcall task spotlight <task> [--off [--force]]",
    async run(p) {
      const t = taskOf(p);
      if (typeof p.on !== "boolean") refuse("bad-payload", "on is true (spotlight it) or false (put the main checkout back)");
      const said = await taskLater(["spotlight", t.id, "--home", t.home, ...(p.on ? [] : ["--off", ...(p.force === true ? ["--force"] : [])])]);
      return { spotlit: p.on, message: said, view: fresh(t) };
    },
  },

  "task.run": {
    cli: "rollcall task run <task> [list | start|stop|restart <name|all>]; log: its log file from an offset",
    async run(p) {
      const t = taskOf(p);
      const verb = str(p, "verb", { required: false }) ?? "list";
      if (!["list", "start", "stop", "restart", "log"].includes(verb)) refuse("bad-payload", "verb is list, start, stop, restart or log");
      if (verb === "log") {
        const name = str(p, "name", { max: 32 });
        if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) refuse("bad-payload", `name is a run action's name: ${name}`);
        const offset = p.offset ?? null;
        if (offset !== null && (!Number.isInteger(offset) || offset < 0)) refuse("bad-payload", "offset is a byte count from 0");
        return runLog(t, name, offset, refuse);
      }
      if (verb !== "list") await taskLater(["run", t.id, "--home", t.home, verb, str(p, "name", { max: 32 })]);
      return { view: fresh(t) };
    },
  },

  "blocker.clear": {
    cli: "rollcall blockers clear <kind>",
    run(p) {
      const kind = str(p, "kind");
      if (!["usage", "billing", "disk", "power", "memory"].includes(kind)) refuse("bad-payload", "kind is one of usage, billing, disk, power, memory");
      return { cleared: closeBlocker(kind) };
    },
  },
};

/** Actions the plans in flight add; a front end that asks for one now hears `not-available`, not `unknown-action`. */
export const COMING = {
};

// ---------------------------------------------------------------- repeats

const requestsPath = () => join(store.home(), "_machine", "api-requests.json");
const KEEP_MS = 86400_000;

function seen(requestId, action) {
  try { return (JSON.parse(readFileSync(requestsPath(), "utf8")) ?? []).find((x) => x.id === requestId && x.action === action) ?? null; } catch { return null; }
}

function remember(requestId, action, result, now = Date.now()) {
  try {
    let all = [];
    try { all = JSON.parse(readFileSync(requestsPath(), "utf8")) ?? []; } catch {}
    all = all.filter((x) => now - x.at < KEEP_MS && x.id !== requestId);
    all.push({ id: requestId, action, at: now, result });
    mkdirSync(join(store.home(), "_machine"), { recursive: true });
    writeFileSync(requestsPath(), JSON.stringify(all.slice(-500)));
  } catch {}
}

/**
 * Runs action `name` with `payload` for front end `client`: { ok: true, result } or { ok: false, error: { code,
 * message, ... } }, or a promise of it for an action that finishes later (plan A's). A `requestId` the last day saw returns that first answer again, with `repeated: true`.
 */
export function runAction(name, payload, { client = "frontend" } = {}) {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  if (!p) return { ok: false, error: { code: "bad-payload", message: "the payload is a JSON object" } };
  const a = ACTIONS[name];
  if (!a) {
    return COMING[name]
      ? { ok: false, error: { code: "not-available", message: `${name} comes with ${COMING[name]}` } }
      : { ok: false, error: { code: "unknown-action", message: `no action ${name}: ${Object.keys(ACTIONS).join(", ")}` } };
  }
  const rid = typeof p.requestId === "string" && p.requestId ? p.requestId.slice(0, 100) : null;
  const was = rid && !a.repeatable ? seen(rid, name) : null;
  if (was) return { ...was.result, repeated: true };
  const by = typeof p.client === "string" && p.client.trim() ? p.client.trim().slice(0, 40) : client;
  const failed = (e) => (e instanceof ApiError
    ? { ok: false, error: { code: e.code, message: e.message, ...e.extra } }
    : { ok: false, error: { code: "failed", message: String(e?.message ?? e) } });
  // A refusal is not kept: the same request may go through once what refused it is gone (a busy store).
  const done = (out) => { if (rid && out.ok && !a.repeatable) remember(rid, name, out); return out; };
  let result;
  try { result = a.run(p, by); } catch (e) { return failed(e); }
  // An action that finishes later (the worktree runtime's) answers with a promise of the same shape.
  if (typeof result?.then === "function") return result.then((r) => done({ ok: true, result: r }), (e) => failed(e));
  return done({ ok: true, result });
}
