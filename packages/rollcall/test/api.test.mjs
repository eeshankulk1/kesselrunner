// Done when: a front end can rely on `rollcall api`: version names what it offers; snapshot holds every panel's
// fields; a question answered from a front end lands once (first answer wins against the terminal Falcon, either
// order); changes() turns two snapshots into the events a front end acts on; a stream prints the snapshot, then
// changes and notices, registers its client while it runs and keeps rollcall's own notification quiet; every
// action runs as the owner and only as the owner (refused in an agent session, denied by the Bash hook), repeats
// safely by requestId, and refuses with a fixed code; attach names what it cannot show.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { changes } from "../src/api-stream.mjs";
import { BIN, denied, reason, sandbox, until, write } from "./helpers.mjs";

const SRC = new URL("../src/", import.meta.url).href;
const WORKER = { env: { ROLLCALL_TASK: "alpha:t1" } };

/** `rollcall <args>` as the owner's front end: no agent session, no task in its environment. */
function owner(sb, args, { env = {}, input } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: sb.root, encoding: "utf8", input, env: { ...sb.env, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const parsed = (r) => { try { return JSON.parse(r.stdout); } catch { assert.fail(`not JSON (exit ${r.code}): ${r.stdout}${r.stderr}`); } };
/** `rollcall api do <name> <payload>` as the owner: the JSON it printed, with its exit code. */
const act = (sb, name, payload, opts) => { const r = owner(sb, ["api", "do", name, JSON.stringify(payload)], opts); return { exit: r.code, ...parsed(r) }; };
const snap = (sb) => { const r = owner(sb, ["api", "snapshot"]); assert.equal(r.code, 0, r.stderr); return parsed(r); };
const record = (sb, id = "t1", h = "alpha") => JSON.parse(readFileSync(join(sb.home, "_supervisors", h, "tasks", `${id}.json`), "utf8"));
/** Runs `code` (an ES module body) with rollcall's sources at SRC and the sandbox's environment. */
function node(sb, code, env = {}) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...sb.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** A sandbox with supervisor alpha (a live session) and its task t1 (yoda), no worker. */
function setup(t, { worktree = false } = {}) {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  const made = sup.cli(["task", "new", "header polish", "--repo", sb.main, "--words", "make the header bold", ...(worktree ? [] : ["--no-worktree"])]);
  assert.equal(made.code, 0, made.stderr);
  return { sb, sup };
}

const QUESTIONS = [{ question: "Bold title or a subtitle?", header: "yoda Style", multiSelect: false, options: [{ label: "Bold", description: "heavier title" }, { label: "Subtitle", description: "a line under it" }] }];
/** Worker t1 asks the owner a picker question; returns the open question as the snapshot shows it. */
function ask(sb, sup, questions = QUESTIONS) {
  const file = join(sb.root, `ask-${randomUUID()}.json`);
  write(file, JSON.stringify(questions));
  const r = sup.cli(["task", "set", "t1", "--state", "needs-you", "--ask-json", file], WORKER);
  assert.equal(r.code, 0, r.stderr);
  const q = snap(sb).tasks.find((x) => x.ref === "alpha:t1").question;
  assert.ok(q, "the snapshot shows the open question");
  return q;
}
/** The owner's pick in the supervisor's picker (PostToolUse AskUserQuestion), as the terminal Falcon makes it. */
function falconPick(sup, questions, answers) {
  return sup.hook("post-tool-use", "PostToolUse", { tool_name: "AskUserQuestion", tool_input: { questions }, tool_response: { questions, answers }, tool_use_id: randomUUID() });
}

// ---------------------------------------------------------------- version, snapshot

test("api version names the interface, its verbs, every action and the ones coming", (t) => {
  const sb = sandbox(t);
  const r = owner(sb, ["api", "version"]);
  assert.equal(r.code, 0, r.stderr);
  const v = parsed(r);
  assert.equal(v.ok, true);
  assert.equal(v.interface, 1);
  assert.match(String(v.rollcall), /^\d+\.\d+\.\d+/);
  assert.deepEqual(v.verbs, ["version", "snapshot", "stream", "do", "attach"]);
  assert.deepEqual(Object.keys(v.actions).sort(), ["blocker.clear", "decision.answer", "question.answer", "task.close", "task.interrupt", "task.move", "task.resume", "task.start", "task.stop", "task.tell"]);
  for (const cli of Object.values(v.actions)) assert.equal(typeof cli, "string");
  assert.ok(v.coming["task.archive"] && v.coming["review.comment"]);
  const bad = owner(sb, ["api", "frobnicate"]);
  assert.equal(bad.code, 2);
  assert.equal(parsed(bad).error.code, "bad-payload");
});

test("api snapshot holds every top-level section and a task's panel fields", (t) => {
  const { sb } = setup(t, { worktree: true });
  sb.session(sb.main).start();
  const s = snap(sb);
  assert.deepEqual(Object.keys(s).sort(), ["at", "blockerLines", "blockers", "clients", "decisions", "interface", "queues", "rollcall", "sessions", "supervisors", "tasks", "tmux", "usage"].sort());
  assert.equal(s.interface, 1);
  assert.equal(typeof s.tmux.available, "boolean");
  assert.equal(s.tmux.socket, sb.env.ROLLCALL_TMUX_SOCKET);
  assert.deepEqual(s.clients, []);
  assert.deepEqual(s.usage, { claude: null, codex: null }, "the usage meter, with no reading yet");
  const sup = s.supervisors.find((x) => x.name === "alpha");
  assert.equal(sup.running, true, "its session holds it");
  assert.equal(sup.openTasks, 1);
  assert.equal(s.sessions.length, 1, "the live session in the repo");
  assert.equal(s.sessions[0].mainCheckout, true);
  assert.equal(s.sessions[0].state, "working");

  const task = s.tasks.find((x) => x.ref === "alpha:t1");
  assert.ok(task);
  assert.equal(task.name, "yoda");
  assert.equal(task.home, "alpha");
  assert.equal(task.title, "header polish");
  assert.equal(typeof task.state, "string");
  assert.equal(typeof task.status, "string");
  assert.deepEqual(task.words.map((w) => [w.text, w.via]), [["make the header bold", "supervisor"]]);
  assert.equal(task.question, null);
  assert.equal(task.worker, null, "no worker started");
  assert.equal(task.pr, null);
  assert.equal(task.report, null);
  assert.deepEqual(task.terminal, { window: false, alive: false });
  assert.equal(typeof task.files, "string");
  assert.match(task.worktree, /\.claude\/worktrees\/header-polish$/);
  assert.match(task.branch, /header-polish$/);
  // --home keeps it to one supervisor.
  assert.deepEqual(parsed(owner(sb, ["api", "snapshot", "--home", "nobody"])).tasks, []);
});

// ---------------------------------------------------------------- questions

test("question.answer: the right id records the owner's words from the front end and closes the question; a second answer, a stale id or no answer is refused", (t) => {
  const { sb, sup } = setup(t);
  const q = ask(sb, sup);
  assert.equal(q.picker, true);
  assert.deepEqual(q.questions.map((x) => x.question), ["Bold title or a subtitle?"]);
  assert.match(q.id, /^alpha:t1:\d+$/);

  assert.equal(act(sb, "question.answer", { task: "alpha:t1", question: q.id }).error.code, "bad-payload", "no answer");
  assert.equal(act(sb, "question.answer", { task: "alpha:t1", question: `${q.id}0`, answer: "Bold" }).error.code, "stale-question");
  assert.equal(act(sb, "question.answer", { task: "alpha:t9", question: q.id, answer: "Bold" }).error.code, "not-found");
  assert.equal(record(sb).words.length, 1, "no refused answer reached the record");

  const r = act(sb, "question.answer", { task: "alpha:yoda", question: q.id, answers: { "Bold title or a subtitle?": "Bold" }, client: "ios" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.exit, 0);
  assert.equal(r.result.delivered, true);
  assert.equal(r.result.how, "held", "no worker yet: the words wait on the record");
  assert.equal(r.result.view.question, null);

  const t1 = record(sb);
  assert.notEqual(t1.state, "needs-you");
  assert.equal(t1.ask, null);
  assert.deepEqual({ ...t1.words.at(-1), at: 0 }, { at: 0, text: "Style: Bold", via: "app", client: "ios", closed: "Bold title or a subtitle?" });
  assert.equal(t1.answered.qid, q.id);
  assert.equal(t1.answered.by, "ios");
  assert.deepEqual(t1.answered.questions, ["Bold title or a subtitle?"]);
  assert.equal(snap(sb).tasks[0].answered.qid, q.id);

  const again = act(sb, "question.answer", { task: "alpha:t1", question: q.id, answer: "Subtitle" });
  assert.equal(again.exit, 1);
  assert.equal(again.error.code, "already-answered");
  assert.equal(again.error.answered.by, "ios");
  assert.equal(record(sb).words.length, 2, "the second answer was not recorded");
});

test("first answer wins: a Falcon pick after a front end's answer is dropped, and a front end's answer after a Falcon pick is refused", (t) => {
  const { sb, sup } = setup(t);
  const q = ask(sb, sup);
  assert.equal(act(sb, "question.answer", { task: "alpha:t1", question: q.id, answer: "Subtitle", client: "mac" }).ok, true);
  const words = record(sb).words.length;
  const pick = falconPick(sup, QUESTIONS, { "Bold title or a subtitle?": "Bold" });
  assert.equal(pick.code, 0, pick.stderr);
  assert.match(pick.stdout, /answered already from mac/);
  assert.match(pick.stdout, /did not go to yoda's worker/);
  assert.equal(record(sb).words.length, words, "the worker was not sent a second answer");
  assert.equal(record(sb).answered.by, "mac");

  // The other way round: the terminal Falcon answers the next question first.
  const q2 = ask(sb, sup, [{ ...QUESTIONS[0], question: "Which font?", options: [{ label: "Inter" }, { label: "SF Pro" }] }]);
  assert.notEqual(q2.id, q.id);
  const picked = falconPick(sup, [{ ...QUESTIONS[0], question: "Which font?", options: [{ label: "Inter" }, { label: "SF Pro" }] }], { "Which font?": "Inter" });
  assert.equal(picked.code, 0, picked.stderr);
  assert.doesNotMatch(picked.stdout, /answered already/);
  const after = record(sb);
  assert.equal(after.words.at(-1).text, "Style: Inter");
  assert.equal(after.answered.by, "the terminal Falcon");
  assert.equal(after.answered.qid, q2.id, "the Falcon's pick names the question it answered");
  const late = act(sb, "question.answer", { task: "alpha:t1", question: q2.id, answer: "SF Pro", client: "mac" });
  assert.equal(late.error?.code, "already-answered", JSON.stringify(late));
  assert.equal(late.error.answered.by, "the terminal Falcon");
  assert.equal(record(sb).words.length, after.words.length);
});

test("two question.answer calls at once settle to one winner", async (t) => {
  const { sb, sup } = setup(t);
  const q = ask(sb, sup);
  const run = (answer, client) => new Promise((res) => {
    const c = spawn(process.execPath, [BIN, "api", "do", "question.answer", JSON.stringify({ task: "alpha:t1", question: q.id, answer, client })], { cwd: sb.root, env: sb.env });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.on("close", () => res(JSON.parse(out)));
  });
  const results = await Promise.all([run("Bold", "mac"), run("Subtitle", "ios")]);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.error.code), ["already-answered"]);
  assert.equal(record(sb).words.length, 2, "the task's words and one answer");
});

// ---------------------------------------------------------------- changes()

const SEC = { sessions: [], queues: [], blockers: [], decisions: [], usage: null, clients: [] };
const tv = (over = {}) => ({ ref: "alpha:t1", state: "working", question: null, answered: null, worker: { alive: true, busy: true, dialog: null, lastWords: null, background: null }, pr: null, words: [], report: null, ...over });
const sv = (feed = []) => ({ name: "alpha", feed });
const sn = (tasks, over = {}) => ({ tasks, supervisors: [sv()], ...SEC, ...over });
const types = (list) => list.map((c) => c.type);

test("changes() turns two snapshots into the events a front end acts on", () => {
  assert.deepEqual(changes(sn([tv()]), sn([tv()])), [], "nothing changed, nothing to say");

  const question = { id: "alpha:t1:5", questions: [{ question: "A?" }] };
  const asked = changes(sn([tv()]), sn([tv({ state: "needs-you", question })]));
  assert.deepEqual(types(asked), ["task.changed", "task.state", "question.asked"]);
  assert.deepEqual(asked[0].fields.sort(), ["question", "state"]);
  assert.deepEqual([asked[1].from, asked[1].to], ["working", "needs-you"]);
  assert.equal(asked[2].question.id, "alpha:t1:5");

  const answered = { qid: "alpha:t1:5", by: "ios", questions: ["A?"] };
  const closed = changes(sn([tv({ state: "needs-you", question })]), sn([tv({ answered })]));
  assert.deepEqual(closed.find((c) => c.type === "question.closed"), { type: "question.closed", ref: "alpha:t1", question: "alpha:t1:5", answered });
  const dropped = changes(sn([tv({ state: "needs-you", question })]), sn([tv()]));
  assert.equal(dropped.find((c) => c.type === "question.closed").answered, null, "closed with no answer (the worker moved on)");
  const replaced = changes(sn([tv({ state: "needs-you", question })]), sn([tv({ state: "needs-you", question: { id: "alpha:t1:9", questions: [{ question: "B?" }] } })]));
  assert.deepEqual(types(replaced).filter((x) => x.startsWith("question.")), ["question.closed", "question.asked"]);

  const ended = changes(sn([tv()]), sn([tv({ worker: { alive: true, busy: false, dialog: null, lastWords: "done", background: 0 } })]));
  assert.deepEqual(ended.find((c) => c.type === "worker.turn-ended"), { type: "worker.turn-ended", ref: "alpha:t1", lastWords: "done", background: 0 });
  const died = changes(sn([tv()]), sn([tv({ worker: { alive: false, busy: false, dialog: null } })]));
  assert.ok(!types(died).includes("worker.turn-ended"), "a worker that died did not end a turn");
  const dialog = changes(sn([tv()]), sn([tv({ worker: { alive: true, busy: true, dialog: { since: 1, asks: [], text: "trust?" } } })]));
  assert.ok(types(dialog).includes("worker.dialog"));

  const pr = { url: "https://github.com/o/r/pull/7", number: 7, state: "OPEN" };
  assert.deepEqual(changes(sn([tv()]), sn([tv({ pr })])).find((c) => c.type === "pr.changed").pr, pr);
  const w1 = { at: 1, text: "one", via: "app" };
  const w2 = { at: 2, text: "two", via: "supervisor" };
  assert.deepEqual(changes(sn([tv({ words: [w1] })]), sn([tv({ words: [w1, w2] })])).find((c) => c.type === "words").words, [w2], "only the new words");
  const report = { at: 3, by: "worker", text: "done" };
  assert.deepEqual(changes(sn([tv()]), sn([tv({ report })])).find((c) => c.type === "report").report, report);

  const added = changes(sn([]), sn([tv({ state: "needs-you", question })]));
  assert.deepEqual(types(added), ["task.added", "question.asked"]);
  assert.deepEqual(changes(sn([tv()]), sn([])), [{ type: "task.removed", ref: "alpha:t1" }]);

  const news = changes(sn([], { supervisors: [sv([{ at: 1, task: null, text: "old" }])] }), sn([], { supervisors: [sv([{ at: 1, task: null, text: "old" }, { at: 2, task: "alpha:t1", text: "yoda opened a PR" }])] }));
  assert.deepEqual(types(news), ["supervisor.changed", "news"]);
  assert.deepEqual(news[1], { type: "news", home: "alpha", at: 2, task: "alpha:t1", text: "yoda opened a PR" });
  assert.deepEqual(types(changes(sn([], { supervisors: [] }), sn([], { supervisors: [sv([{ at: 2, text: "x" }])] }))), ["supervisor.changed"], "a new supervisor's feed is in its snapshot, not news");
  assert.deepEqual(changes(sn([]), sn([], { supervisors: [] })), [{ type: "supervisor.removed", name: "alpha" }]);

  for (const k of ["tmux", "sessions", "queues", "blockers", "blockerLines", "decisions", "clients"]) {
    const c = changes(sn([]), sn([], { [k]: [{ x: 1 }] }));
    assert.deepEqual(c, [{ type: `${k}.changed`, [k]: [{ x: 1 }] }]);
  }
  assert.deepEqual(changes(sn([]), sn([], { usage: { pct: 5 } })), [{ type: "usage.changed", usage: { pct: 5 } }]);
});

// ---------------------------------------------------------------- the stream

test("api stream: the snapshot first, then changes and notices; its client is registered while it runs and keeps rollcall's notification quiet", async (t) => {
  const { sb, sup } = setup(t);
  const log = join(sb.root, "notify.log");
  const env = { ...sb.env, ROLLCALL_API_BEAT_MS: "100", ROLLCALL_NOTIFY_LOG: log };
  const p = sb.track(spawn(process.execPath, [BIN, "api", "stream", "--client", "test", "--notifies"], { cwd: sb.root, env, stdio: ["pipe", "pipe", "pipe"] }));
  let buf = "";
  let err = "";
  p.stdout.on("data", (d) => { buf += d; });
  p.stderr.on("data", (d) => { err += d; });
  const exited = new Promise((res) => p.on("exit", (code, signal) => res({ code, signal })));
  const lines = () => buf.split("\n").filter(Boolean).map((l) => JSON.parse(l));

  await until(() => lines().length >= 1);
  const first = lines()[0];
  assert.equal(first.type, "snapshot", err);
  assert.equal(first.v, 1);
  assert.equal(first.seq, 1);
  assert.ok(first.snapshot.tasks.some((x) => x.ref === "alpha:t1"));

  // Its client shows while it runs.
  const clients = snap(sb).clients;
  assert.equal(clients.length, 1);
  assert.equal(clients[0].client, "test");
  assert.equal(clients[0].notifies, true);
  assert.equal(clients[0].pid, p.pid);

  assert.equal(sup.cli(["task", "note", "t1", "the font moved"], WORKER).code, 0);
  const changed = await until(() => lines().find((l) => l.type === "task.changed" && l.ref === "alpha:t1"));
  assert.ok(changed.fields.includes("notes"), JSON.stringify(changed.fields));
  assert.equal(changed.task.notes.at(-1).text, "the font moved");
  ask(sb, sup);
  await until(() => lines().find((l) => l.type === "question.asked" && l.ref === "alpha:t1"));
  await until(() => lines().find((l) => l.type === "task.state" && l.to === "needs-you"));
  const seqs = lines().map((l) => l.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), "seq counts every line");

  // A notice while a notifying client runs: on its stream, not rollcall's own notification.
  node(sb, `import { notify } from "${SRC}trouble.mjs"; notify("rollcall: test", "disk is low");`, { ROLLCALL_NOTIFY_LOG: log });
  const notice = await until(() => lines().find((l) => l.type === "notice"));
  assert.equal(notice.title, "rollcall: test");
  assert.equal(notice.text, "disk is low");
  assert.equal(existsSync(log), false, "rollcall's own notification stayed quiet");

  const t0 = Date.now();
  p.kill("SIGTERM");
  // A loaded machine (the whole suite at once) can take seconds to finish the snapshot it is building.
  const end = await Promise.race([exited, new Promise((res) => setTimeout(() => res("still running"), 20_000))]);
  assert.notEqual(end, "still running", "the stream ends on SIGTERM");
  t.diagnostic(`stream exited ${Date.now() - t0}ms after SIGTERM`);
  assert.deepEqual(snap(sb).clients, [], "its client is gone");

  node(sb, `import { notify } from "${SRC}trouble.mjs"; notify("rollcall: test", "disk is still low");`, { ROLLCALL_NOTIFY_LOG: log });
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)), [{ title: "rollcall: test", text: "disk is still low" }], "with no front end, rollcall notifies itself");
});

test("api stream: --notifies alone registers a front end, and the stream ends when its stdout closes", async (t) => {
  const sb = sandbox(t);
  const env = { ...sb.env, ROLLCALL_API_BEAT_MS: "100", ROLLCALL_API_HEARTBEAT_MS: "100" };
  const p = sb.track(spawn(process.execPath, [BIN, "api", "stream", "--notifies"], { cwd: sb.root, env, stdio: ["ignore", "pipe", "pipe"] }));
  let buf = "";
  p.stdout.on("data", (d) => { buf += d; });
  const exited = new Promise((res) => p.on("exit", (code) => res(code)));
  await until(() => buf.includes("\n"));
  assert.deepEqual(snap(sb).clients.map((c) => [c.client, c.notifies]), [["frontend", true]]);
  await until(() => buf.includes('"heartbeat"'), { timeout: 15_000 });
  p.stdout.destroy();
  const code = await Promise.race([exited, new Promise((res) => setTimeout(() => res("still running"), 10_000))]);
  assert.notEqual(code, "still running", "a front end that goes away ends its stream");
  assert.deepEqual(snap(sb).clients, []);
});

// ---------------------------------------------------------------- api do: who may, and its refusals

test("api do acts as the owner only: refused with a task in the environment or from an agent session, and the Bash hook denies it", (t) => {
  const { sb, sup } = setup(t);
  const payload = JSON.stringify({ task: "alpha:t1", text: "hi" });
  const inTask = owner(sb, ["api", "do", "task.tell", payload], WORKER);
  assert.equal(inTask.code, 1);
  assert.equal(parsed(inTask).error.code, "refused");
  const inSession = sup.cli(["api", "do", "task.tell", payload]);
  assert.equal(inSession.code, 1);
  assert.equal(JSON.parse(inSession.stdout).error.code, "refused");
  assert.equal(record(sb).words.length, 1, "neither reached the task");
  // A session's own reads are fine.
  assert.equal(sup.cli(["api", "snapshot"]).code, 0);

  const hook = sup.bashPre(`rollcall api do task.tell '${payload}'`);
  assert.ok(denied(hook), hook.stdout);
  assert.match(reason(hook), /rollcall api do/);
  assert.ok(denied(sup.bashPre(`rollcall api "do" task.tell '${payload}'`)), "quoting the verb does not get around it");
  assert.ok(!denied(sup.bashPre("rollcall api snapshot")));
  assert.ok(!denied(sup.bashPre("rollcall api stream --client x")));
});

test("api do: bad JSON exits 2, unknown and coming actions say so, and a requestId repeat returns the first result without running again", (t) => {
  const { sb } = setup(t);
  const bad = owner(sb, ["api", "do", "task.tell", "{nope"]);
  assert.equal(bad.code, 2);
  assert.equal(parsed(bad).error.code, "bad-payload");
  assert.equal(owner(sb, ["api", "do"]).code, 2);
  assert.equal(act(sb, "task.tell", []).error.code, "bad-payload", "a payload is an object");
  assert.equal(act(sb, "task.frob", {}).error.code, "unknown-action");
  const coming = act(sb, "task.archive", { task: "alpha:t1" });
  assert.equal(coming.error.code, "not-available");
  assert.match(coming.error.message, /plan A/);
  assert.equal(act(sb, "task.tell", { task: "t1", text: "x" }).error.code, "bad-payload", "a task is <home>:<task>");

  // The payload on stdin works too.
  const stdin = owner(sb, ["api", "do", "task.tell", "-"], { input: JSON.stringify({ task: "alpha:t1", text: "from stdin" }) });
  assert.equal(stdin.code, 0, stdin.stdout);

  const once = { task: "alpha:t1", text: "also the footer", requestId: "req-1", client: "ios" };
  const first = act(sb, "task.tell", once);
  assert.equal(first.ok, true);
  assert.equal(first.repeated, undefined);
  const second = act(sb, "task.tell", once);
  assert.equal(second.repeated, true);
  assert.deepEqual({ ...second, repeated: undefined, exit: 0 }, { ...first, repeated: undefined, exit: 0 });
  assert.equal(record(sb).words.filter((w) => w.text === "also the footer").length, 1, "the action ran once");
  // The same id on another action is another request.
  const other = act(sb, "task.interrupt", { task: "alpha:t1", requestId: "req-1" });
  assert.equal(other.repeated, undefined);
  assert.equal(other.result.interrupted, false);
  // A refusal is not kept: the same request may go through once what refused it is gone.
  const r1 = act(sb, "task.tell", { task: "alpha:t9", text: "x", requestId: "req-2" });
  assert.equal(r1.error.code, "not-found");
  const r2 = act(sb, "task.tell", { task: "alpha:t9", text: "x", requestId: "req-2" });
  assert.equal(r2.error.code, "not-found");
  assert.equal(r2.repeated, undefined);
});

// ---------------------------------------------------------------- the actions

test("task.tell, task.interrupt, task.close and task.move from a front end", (t) => {
  const { sb, sup } = setup(t);
  const told = act(sb, "task.tell", { task: "alpha:yoda", text: "  keep the icon  ", client: "ios" });
  assert.equal(told.ok, true);
  assert.equal(told.result.delivered, false);
  assert.match(told.result.why, /no worker yet/);
  assert.deepEqual({ ...record(sb).words.at(-1), at: 0 }, { at: 0, text: "keep the icon", via: "app", client: "ios" });
  assert.deepEqual(told.result.view.words.at(-1).via, "app");
  // The supervisor hears the owner talked to the worker from a front end.
  assert.match(sup.prompt("what's new?").context ?? "", /from ios/);
  assert.equal(act(sb, "task.tell", { task: "alpha:t1", text: "   " }).error.code, "bad-payload", "blank words are no words");
  assert.equal(record(sb).words.at(-1).text, "keep the icon");

  const stopped = act(sb, "task.interrupt", { task: "alpha:t1" });
  assert.deepEqual(stopped.result, { interrupted: false, why: "its worker is not running" });

  assert.equal(sup.cli(["task", "new", "footer", "--repo", sb.main, "--no-worktree"]).code, 0);
  const moved = act(sb, "task.move", { task: "alpha:t2", to: "beta" });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.result.task, "beta:t1");
  assert.equal(record(sb, "t1", "beta").title, "footer");
  assert.equal(act(sb, "task.move", { task: "alpha:t2", to: "beta" }).result.already, true);
  // To the other harness (plan B): the task's own harness is no move, and a harness with no adapter is refused.
  assert.deepEqual(act(sb, "task.move", { task: "alpha:t1", harness: "claude" }).result.already, true);
  assert.equal(act(sb, "task.move", { task: "alpha:t1", harness: "gemini" }).error.code, "bad-payload");

  const closed = act(sb, "task.close", { task: "alpha:t1", why: "not needed", client: "mac" });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.result.view.state, "closed");
  const t1 = record(sb);
  assert.equal(t1.state, "closed");
  assert.match(t1.notes.at(-1).text, /closed: from mac: not needed/);
  assert.equal(act(sb, "task.close", { task: "alpha:t1" }).result.already, true);
});

test("decision.answer and blocker.clear from a front end", (t) => {
  const { sb, sup } = setup(t);
  assert.equal(sup.cli(["task", "decisions", "add", "ship on friday?", "--from", "t1"]).code, 0);
  const d = snap(sb).decisions;
  assert.equal(d.length, 1);
  assert.equal(d[0].from, "alpha:t1");
  assert.equal(act(sb, "decision.answer", { n: "x" }).error.code, "bad-payload");
  const r = act(sb, "decision.answer", { n: `d${d[0].n}`, answer: "yes, friday" });
  assert.deepEqual(r.result, { answered: true });
  assert.deepEqual(snap(sb).decisions, []);
  assert.match(record(sb).notes.at(-1).text, /decided: ship on friday\? - yes, friday/);
  assert.deepEqual(act(sb, "decision.answer", { n: d[0].n, answer: "again" }).result, { answered: true, already: true });

  node(sb, `import { openBlocker } from "${SRC}trouble.mjs"; openBlocker("disk", { gb: 3 });`);
  assert.equal(snap(sb).blockers.length, 1);
  assert.equal(act(sb, "blocker.clear", { kind: "nope" }).error.code, "bad-payload");
  assert.deepEqual(act(sb, "blocker.clear", { kind: "disk" }).result, { cleared: true });
  assert.deepEqual(snap(sb).blockers, []);
  assert.deepEqual(act(sb, "blocker.clear", { kind: "disk" }).result, { cleared: false });
});

test("task.start makes the task and runs kesselrunner's launcher; a held task waits; a missing or failing launcher says so", (t) => {
  const { sb } = setup(t);
  const args = join(sb.root, "start-args.json");
  const fake = join(sb.root, "start.mjs");
  write(fake, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2)));\nconsole.log("started");\nprocess.exit(Number(process.env.FAKE_START_EXIT || 0));\n`);
  const env = { ROLLCALL_START_FILE: fake };

  assert.equal(act(sb, "task.start", { home: "alpha", title: "x", words: "y", repo: sb.main, harness: "gemini" }, { env }).error.code, "bad-payload", "a harness rollcall has no adapter for");
  assert.equal(act(sb, "task.start", { home: "alpha", title: "x", repo: sb.main }, { env }).error.code, "bad-payload", "words are required");
  assert.equal(act(sb, "task.start", { home: "Bad Home", title: "x", words: "y", noRepo: true }, { env }).error.code, "bad-payload");

  const r = act(sb, "task.start", { home: "alpha", title: "research caching", words: "look into\nthe CDN", noRepo: true, client: "ios" }, { env });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.task, "alpha:t2");
  assert.equal(r.result.started, true);
  assert.equal(r.result.message, "started");
  assert.deepEqual(JSON.parse(readFileSync(args, "utf8")).slice(0, 3), ["t2", "--home", "alpha"]);
  assert.equal(record(sb, "t2").words[0].text, "look into\nthe CDN", "the owner's words verbatim");

  const held = act(sb, "task.start", { home: "alpha", title: "later", words: "after the first", noRepo: true, hold: true }, { env });
  assert.equal(held.result.started, false);
  assert.equal(record(sb, "t3").hold, true);

  const failed = act(sb, "task.start", { home: "alpha", title: "fails", words: "z", noRepo: true }, { env: { ...env, FAKE_START_EXIT: "1" } });
  assert.equal(failed.ok, true);
  assert.equal(failed.result.started, false);

  const missing = act(sb, "task.start", { home: "alpha", title: "no launcher", words: "z", noRepo: true }, { env: { ROLLCALL_START_FILE: join(sb.root, "nowhere.mjs") } });
  assert.equal(missing.error.code, "unavailable");
});

// ---------------------------------------------------------------- attach

test("api attach: unknown supervisors and tasks are not found, and a task with no window says so", (t) => {
  const { sb } = setup(t);
  assert.equal(owner(sb, ["api", "attach"]).code, 2);
  assert.equal(parsed(owner(sb, ["api", "attach", "Not A Ref!"])).error.code, "bad-payload");
  assert.equal(parsed(owner(sb, ["api", "attach", "nobody:t1"])).error.code, "not-found");
  assert.equal(parsed(owner(sb, ["api", "attach", "alpha:t9"])).error.code, "not-found");
  const tmux = spawnSync("tmux", ["-V"]).status === 0;
  for (const ref of ["alpha:t1", "alpha:yoda", "alpha"]) {
    const r = owner(sb, ["api", "attach", ref]);
    assert.equal(r.code, 1);
    assert.equal(parsed(r).error.code, tmux ? "no-window" : "unavailable", ref);
  }
});
