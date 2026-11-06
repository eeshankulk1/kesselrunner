// The front-end interface's actions (`rollcall api do <action> <json>`): everything the terminal Falcon can do for
// the owner, as named actions with a JSON payload and a JSON result. Each runs the same code as the command the
// supervisor runs for it (ACTIONS[name].cli), so neither front end can do what the other cannot. Each is safe to
// repeat: a payload with a `requestId` seen in the last day returns the first result again, and races between two
// front ends settle here (the first answer to a question wins), not in each front end.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { answerFromFrontEnd } from "./answer.mjs";
import { parseRef, refOf, taskView } from "./api.mjs";
import { isOpen } from "./state.mjs";
import * as store from "./store.mjs";
import { deliverWords, holderOf, label } from "./supervisor.mjs";
import { recordWords, taskCommand } from "./task.mjs";
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

// ---------------------------------------------------------------- the actions

/**
 * name -> { cli: the command the Falcon runs for it, run(payload, client) -> result }. Plans add theirs here as they
 * land (archive, restore, spotlight and run actions; review comments).
 */
export const ACTIONS = {
  "task.start": {
    cli: "rollcall task new + start.mjs",
    run(p) {
      const h = homeOf(p);
      // Checked before the task exists: a front end retrying a refusal must not make a second task.
      if (!existsSync(START_FILE)) refuse("unavailable", `kesselrunner's launcher is not at ${START_FILE}`);
      const title = str(p, "title", { max: 200 });
      const words = str(p, "words");
      const repo = str(p, "repo", { required: !p.noRepo });
      if (p.harness !== undefined && !harnessName(p.harness)) refuse("bad-payload", `harness is one of ${HARNESS_NAMES.join(", ")}`);
      const tmp = join(store.homeDir(h), "api");
      mkdirSync(tmp, { recursive: true });
      const file = join(tmp, `words-${process.pid}-${Date.now()}.txt`);
      writeFileSync(file, words);
      const argv = ["new", title, "--home", h, "--words-file", file, "--json"];
      if (p.noRepo) argv.push("--no-repo"); else argv.push("--repo", repo);
      for (const [k, f] of [["type", "--type"], ["kind", "--kind"], ["model", "--model"], ["effort", "--effort"], ["base", "--base"], ["slug", "--slug"], ["harness", "--harness"]]) if (p[k]) argv.push(f, String(p[k]));
      for (const a of p.after ?? []) argv.push("--after", String(a));
      for (const n of p.notes ?? []) argv.push("--note", String(n));
      if (p.until) argv.push("--until", String(p.until));
      for (const [k, f] of [["ship", "--ship"], ["browser", "--browser"], ["hold", "--hold"]]) if (p[k]) argv.push(f);
      let made;
      try { made = JSON.parse(task(argv)); } finally { rmSync(file, { force: true }); }
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
      const t = taskOf(p);
      const text = str(p, "text").trim();
      if (!text) refuse("bad-payload", "text is required");
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
      const t = taskOf(p);
      const w = tmux.windowOf(t.home, t.id);
      if (!w?.alive) return { interrupted: false, why: "its worker is not running" };
      return { interrupted: tmux.interrupt(t.home, t.id) };
    },
  },

  "task.stop": {
    cli: "start.mjs <task> --stop",
    run(p) {
      const t = taskOf(p);
      if (!tmux.windowOf(t.home, t.id)) return { stopped: false, why: "it has no worker window", view: fresh(t) };
      const s = start(t, ["--stop"]);
      if (s.code) refuse("failed", s.out);
      return { stopped: true, view: fresh(t) };
    },
  },

  "task.resume": {
    cli: 'start.mjs <task> --resume "<why>"',
    run(p, client) {
      const t = taskOf(p);
      if (tmux.windowOf(t.home, t.id)?.alive) return { resumed: false, why: "its worker runs already", view: fresh(t) };
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
      task(["decisions", "done", String(n), str(p, "answer", { required: false, max: 2000 }) ?? ""]);
      return { answered: true };
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
  "task.archive": "plan A (worktree runtime)", "task.restore": "plan A (worktree runtime)", "task.spotlight": "plan A (worktree runtime)",
  "task.run": "plan A (worktree runtime)", "review.comment": "plan C (review loop)",
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
 * message, ... } }. A `requestId` the last day saw returns that first answer again, with `repeated: true`.
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
  const was = rid ? seen(rid, name) : null;
  if (was) return { ...was.result, repeated: true };
  const by = typeof p.client === "string" && p.client.trim() ? p.client.trim().slice(0, 40) : client;
  let out;
  try {
    out = { ok: true, result: a.run(p, by) };
  } catch (e) {
    out = e instanceof ApiError
      ? { ok: false, error: { code: e.code, message: e.message, ...e.extra } }
      : { ok: false, error: { code: "failed", message: String(e?.message ?? e) } };
  }
  // A refusal is not kept: the same request may go through once what refused it is gone (a busy store).
  if (rid && out.ok) remember(rid, name, out);
  return out;
}
