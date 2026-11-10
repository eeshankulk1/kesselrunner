// Done when: a front end can rely on `rollcall api`: version names what it offers; snapshot holds every panel's
// fields; a question answered from a front end lands once (first answer wins against the terminal Falcon, either
// order); changes() turns two snapshots into the events a front end acts on; a stream prints the snapshot, then
// changes and notices, registers its client while it runs and keeps rollcall's own notification quiet; every
// action runs as the owner and only as the owner (refused in an agent session, denied by the Bash hook), repeats
// safely by requestId, and refuses with a fixed code; attach names what it cannot show.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { changes } from "../src/api-stream.mjs";
import { BIN, denied, git, reason, sandbox, until, write } from "./helpers.mjs";

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
  assert.deepEqual(v.verbs, ["version", "snapshot", "stream", "do", "attach", "conversation"]);
  assert.deepEqual(Object.keys(v.actions).sort(), ["away.set", "blocker.clear", "chat.archive", "chat.new", "chat.rename", "chat.search", "chat.unarchive", "check.log", "decision.answer", "held.allowAll", "held.answer", "pr.timeline", "prompt.answer", "question.answer", "repo.items", "review.comment", "review.comments", "review.send", "supervisor.end", "supervisor.new", "task.archive", "task.close", "task.diff", "task.interrupt", "task.move", "task.restore", "task.resume", "task.run", "task.spotlight", "task.start", "task.stop", "task.tell", "turn.diff", "turn.restore", "turns.list", "worker.set"]);
  for (const cli of Object.values(v.actions)) assert.equal(typeof cli, "string");
  assert.deepEqual(v.coming, {}, "plans A and C landed: nothing is still coming");
  const bad = owner(sb, ["api", "frobnicate"]);
  assert.equal(bad.code, 2);
  assert.equal(parsed(bad).error.code, "bad-payload");
});

test("api snapshot holds every top-level section and a task's panel fields", (t) => {
  const { sb } = setup(t, { worktree: true });
  sb.session(sb.main).start();
  const s = snap(sb);
  assert.deepEqual(Object.keys(s).sort(), ["at", "away", "blockerLines", "blockers", "chatOptions", "clients", "decisions", "held", "interface", "queues", "rollcall", "sessions", "supervisors", "tasks", "tmux", "usage", "usageOffer"].sort());
  assert.deepEqual(s.away, { on: false, since: null, by: null, last: null }, "away mode, off");
  assert.deepEqual(s.held, []);
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

  // A crew started in the terminal (falcon, /supervisor) says so: no chat, its agents are terminals.
  assert.equal(s.supervisors.find((x) => x.name === "alpha")?.runtime, "terminal");
  assert.equal(s.supervisors.find((x) => x.name === "alpha")?.chat, null, "a terminal crew is no chat");
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

test("api do: bad JSON exits 2, unknown actions say so, and a requestId repeat returns the first result without running again", (t) => {
  const { sb } = setup(t);
  const bad = owner(sb, ["api", "do", "task.tell", "{nope"]);
  assert.equal(bad.code, 2);
  assert.equal(parsed(bad).error.code, "bad-payload");
  assert.equal(owner(sb, ["api", "do"]).code, 2);
  assert.equal(act(sb, "task.tell", []).error.code, "bad-payload", "a payload is an object");
  assert.equal(act(sb, "task.frob", {}).error.code, "unknown-action");
  // Every planned action has landed (COMING is empty): a coming one would answer not-available.
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
  assert.deepEqual(r.result, { answered: true, delivered: false, how: null }, "t1 has no worker to hear it");
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

test("plan C through the interface: review comments in the snapshot, review.comment and review.send as the owner, turn.diff of a turn", (t) => {
  const { sb, sup } = setup(t, { worktree: true });
  const wt = record(sb).worktree;
  write(join(wt, "src/a.js"), "one\ntwo\nthree\n");
  assert.equal(act(sb, "review.comment", { task: "alpha:t1", file: "src/a.js", line: 0, text: "x" }).error.code, "bad-payload");
  const one = act(sb, "review.comment", { task: "alpha:yoda", file: "src/a.js", line: 2, text: "name this for what it holds", client: "mac" });
  assert.equal(one.ok, true, JSON.stringify(one));
  assert.equal(one.result.comment, 1);
  assert.deepEqual(one.result.view.comments.map((c) => [c.n, c.state, c.file, c.line, c.text]), [[1, "pending", "src/a.js", 2, "name this for what it holds"]]);
  const sent = act(sb, "review.send", { task: "alpha:t1" });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.match(sent.result.message, /1 comment \(#1\) sent as one message/);
  assert.equal(snap(sb).tasks.find((x) => x.ref === "alpha:t1").comments[0].state, "sent");
  assert.equal(act(sb, "review.send", { task: "alpha:t1" }).error.code, "refused", "nothing left to send");
  assert.equal(act(sb, "review.comment", { task: "alpha:t1", file: "src/a.js", line: 1, text: "--help" }).error.code, "bad-payload");
  assert.equal(act(sb, "review.comment", { task: "alpha:t1", file: "src/a.js", line: 1, text: "x", send: "false" }).error.code, "bad-payload");

  // Turns: none yet, then two taken by hand (the hooks do it in a real worker).
  assert.equal(snap(sb).tasks.find((x) => x.ref === "alpha:t1").turns, null);
  const take = () => { const r = spawnSync(process.execPath, [BIN, "turns", "take"], { cwd: wt, encoding: "utf8", env: { ...sb.env, ROLLCALL_SNAPSHOTS: "1" } }); assert.equal(r.status, 0, r.stderr); };
  take();
  write(join(wt, "gen/out.js"), "generated\n");
  take();
  assert.deepEqual(snap(sb).tasks.find((x) => x.ref === "alpha:t1").turns, { count: 3, last: 2 });
  const d = act(sb, "turn.diff", { task: "alpha:t1", n: 2 });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(d.result.files, [{ status: "A", path: "gen/out.js", added: 1, removed: 0 }]);
  assert.match(d.result.patch, /\+generated/);
  assert.equal(d.result.truncated, false);
  // Read-only: a requestId repeat runs it again rather than replay a stored copy.
  assert.equal(act(sb, "turn.diff", { task: "alpha:t1", n: 2, requestId: "d1" }).repeated, undefined);
  assert.equal(act(sb, "turn.diff", { task: "alpha:t1", n: 2, requestId: "d1" }).repeated, undefined);
  assert.equal(act(sb, "turn.diff", { task: "alpha:t1", n: 9 }).error.code, "not-found");
});

test("plan A in the interface: a task's runtime in the snapshot; archive shows what goes before it removes anything, then restore and spotlight", (t) => {
  const { sb } = setup(t, { worktree: true });
  const view = () => snap(sb).tasks.find((x) => x.ref === "alpha:t1");
  const v = view();
  assert.equal(v.from, null);
  assert.deepEqual(v.runtime.actions, []);
  assert.equal(v.runtime.archived, null);
  write(join(v.worktree, "notes.md"), "uncommitted\n");

  const plan = act(sb, "task.archive", { task: "alpha:t1" });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.result.archived, false, "nothing goes without the owner's yes");
  assert.deepEqual(plan.result.plan.uncommitted, ["?? notes.md"]);
  assert.match(plan.result.plan.lines[0], /removes its worktree/);
  assert.deepEqual(plan.result.confirmWith, { task: "alpha:t1", confirm: true });
  assert.ok(existsSync(v.worktree));

  const gone = act(sb, "task.archive", { task: "alpha:t1", confirm: true });
  assert.equal(gone.ok, true, JSON.stringify(gone));
  assert.equal(gone.result.view.runtime.archived.files, 1);
  assert.ok(!existsSync(v.worktree));
  assert.equal(act(sb, "task.archive", { task: "alpha:t1", confirm: true }).result.already, true, "safe to repeat");
  assert.equal(act(sb, "task.run", { task: "alpha:t1", verb: "start", name: "web" }).error.code, "refused");

  const back = act(sb, "task.restore", { task: "alpha:t1" });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(readFileSync(join(v.worktree, "notes.md"), "utf8"), "uncommitted\n");
  assert.equal(back.result.view.runtime.archived, null);

  assert.equal(act(sb, "task.spotlight", { task: "alpha:t1" }).error.code, "bad-payload");
  const on = act(sb, "task.spotlight", { task: "alpha:t1", on: true });
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.ok(on.result.view.runtime.spotlit);
  assert.equal(readFileSync(join(sb.main, "notes.md"), "utf8"), "uncommitted\n", "the main checkout runs the task's files");
  const off = act(sb, "task.spotlight", { task: "alpha:t1", on: false });
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(off.result.view.runtime.spotlit, null);
  assert.ok(!existsSync(join(sb.main, "notes.md")));
});

// ---------------------------------------------------------------- review and ship reads (cockpit plan 2)

test("task.diff against main, committed and uncommitted: renames found, line counts, untracked files in, ignored ones out", (t) => {
  const { sb } = setup(t, { worktree: true });
  const wt = record(sb).worktree;
  write(join(wt, "src/c.js"), "c1\nc2\n");
  git(wt, "mv", "src/b.js", "src/renamed.js");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "committed work");
  write(join(wt, "src/a.js"), "src/a.js\nmore\n");
  write(join(wt, "new.txt"), "untracked\n");
  write(join(wt, ".gitignore"), "ignored.log\n");
  write(join(wt, "ignored.log"), "noise\n");
  const files = (r) => r.result.files.map((f) => [f.status, f.path, f.oldPath ?? null, f.added, f.removed]).sort((a, b) => a[1].localeCompare(b[1]));

  const base = act(sb, "task.diff", { task: "alpha:t1" });
  assert.equal(base.ok, true, JSON.stringify(base));
  assert.equal(base.result.against, "base");
  assert.equal(base.result.base, "main");
  assert.equal(base.result.from, git(sb.main, "rev-parse", "origin/main"));
  assert.equal(base.result.to, "worktree");
  assert.deepEqual(files(base), [
    ["A", ".gitignore", null, 1, 0], ["A", "new.txt", null, 1, 0], ["M", "src/a.js", null, 1, 0], ["A", "src/c.js", null, 2, 0], ["R", "src/renamed.js", "src/b.js", 0, 0],
  ]);
  assert.match(base.result.patch, /^\+more$/m);
  assert.doesNotMatch(base.result.patch, /noise/);
  assert.equal(base.result.truncated, false);

  const committed = act(sb, "task.diff", { task: "alpha:t1", against: "committed" });
  assert.equal(committed.result.to, git(wt, "rev-parse", "HEAD"));
  assert.deepEqual(files(committed), [["A", "src/c.js", null, 2, 0], ["R", "src/renamed.js", "src/b.js", 0, 0]]);

  const unc = act(sb, "task.diff", { task: "alpha:t1", against: "uncommitted" });
  assert.equal(unc.result.from, git(wt, "rev-parse", "HEAD"));
  assert.deepEqual(files(unc), [["A", ".gitignore", null, 1, 0], ["A", "new.txt", null, 1, 0], ["M", "src/a.js", null, 1, 0]]);
  assert.equal(git(wt, "status", "--porcelain").includes("?? new.txt"), true, "the worker's index is untouched");

  assert.equal(act(sb, "task.diff", { task: "alpha:t1", against: "theirs" }).error.code, "bad-payload");
  assert.equal(act(sb, "task.diff", { task: "alpha:t9" }).error.code, "not-found");
});

test("turns.list and turn.restore: the turns with their files, a restore puts files back, and its undo turn puts them back again", (t) => {
  const { sb } = setup(t, { worktree: true });
  const wt = record(sb).worktree;
  const take = () => { const r = spawnSync(process.execPath, [BIN, "turns", "take"], { cwd: wt, encoding: "utf8", env: { ...sb.env, ROLLCALL_SNAPSHOTS: "1" } }); assert.equal(r.status, 0, r.stderr); };
  assert.deepEqual(act(sb, "turns.list", { task: "alpha:t1" }).result.turns, []);
  write(join(wt, "src/a.js"), "first\n");
  take();
  write(join(wt, "src/a.js"), "second\n");
  take();
  const list = act(sb, "turns.list", { task: "alpha:t1" }).result.turns;
  assert.deepEqual(list.map((x) => [x.n, x.kind, x.files, x.restored]), [
    [0, "baseline", [], null], [1, "turn", [{ status: "M", path: "src/a.js" }], null], [2, "turn", [{ status: "M", path: "src/a.js" }], null],
  ]);
  assert.equal(typeof list[1].at, "number");

  // turn.diff now counts lines.
  assert.deepEqual(act(sb, "turn.diff", { task: "alpha:t1", n: 2 }).result.files, [{ status: "M", path: "src/a.js", added: 1, removed: 1 }]);

  const back = act(sb, "turn.restore", { task: "alpha:t1", n: 1 });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.result.restored, 1);
  assert.equal(readFileSync(join(wt, "src/a.js"), "utf8"), "first\n");
  assert.match(back.result.message, /^restored to turn 1: 1 file/);
  assert.equal(typeof back.result.view, "object");
  const undo = act(sb, "turn.restore", { task: "alpha:t1", n: back.result.undo });
  assert.equal(undo.ok, true, JSON.stringify(undo));
  assert.equal(readFileSync(join(wt, "src/a.js"), "utf8"), "second\n");
  // The state it replaced was turn 2 already, so no before-restore turn was needed: undo names turn 2.
  assert.equal(back.result.undo, 2);
  assert.deepEqual(act(sb, "turns.list", { task: "alpha:t1" }).result.turns.slice(3).map((x) => [x.n, x.kind, x.restored]), [[3, "restored", 1], [4, "restored", 2]]);
  assert.equal(act(sb, "turn.restore", { task: "alpha:t1", n: 99 }).error.code, "not-found");
  assert.equal(act(sb, "turn.restore", { task: "alpha:t1" }).error.code, "bad-payload");
});

test("review.comments: where each comment sits now, moved with its lines or null once they are gone", (t) => {
  const { sb } = setup(t, { worktree: true });
  const wt = record(sb).worktree;
  write(join(wt, "src/a.js"), "one\ntwo\nthree\n");
  assert.equal(act(sb, "review.comment", { task: "alpha:t1", file: "src/a.js", line: 2, text: "rename" }).ok, true);
  assert.equal(act(sb, "review.comment", { task: "alpha:t1", file: "src/a.js", line: 3, text: "drop" }).ok, true);
  let c = act(sb, "review.comments", { task: "alpha:t1" }).result.comments;
  assert.deepEqual(c.map((x) => [x.n, x.state, x.now]), [[1, "pending", { file: "src/a.js", line: 2, end: 2, moved: false }], [2, "pending", { file: "src/a.js", line: 3, end: 3, moved: false }]]);
  write(join(wt, "src/a.js"), "zero\none\ntwo\n");
  c = act(sb, "review.comments", { task: "alpha:t1" }).result.comments;
  assert.deepEqual(c[0].now, { file: "src/a.js", line: 3, end: 3, moved: true });
  assert.equal(c[1].now, null);
  assert.match(c[1].stale, /no longer in src\/a\.js/);
});

/** A fake gh for the ship reads: answers from FAKE_GH (JSON) and logs each call. */
function fakeGh(sb, state) {
  const file = join(sb.root, "gh-state.json");
  const bin = join(sb.root, "fake-gh.mjs");
  write(file, JSON.stringify(state));
  write(bin, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const s = JSON.parse(readFileSync(${JSON.stringify(file)}, "utf8"));
const a = process.argv.slice(2);
(s.calls ??= []).push(a);
writeFileSync(${JSON.stringify(file)}, JSON.stringify(s));
const out = (o) => { process.stdout.write(typeof o === "string" ? o : JSON.stringify(o)); process.exit(0); };
if (s.fail) { process.stderr.write(s.fail); process.exit(1); }
const q = a.find((x) => x.startsWith("query=")) ?? "";
if (a[0] === "api" && q.includes("reviewThreads")) out({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: s.threads ?? [] } } } } });
if (a[0] === "api" && q.includes("defaultBranchRef")) out({ data: { repository: s.repository } });
if (a[0] === "run" && a.includes("--log-failed")) out(s.failedLog ?? "");
if (a[0] === "run" && a.includes("--log")) out(s.wholeLog ?? "");
if (a[0] === "issue") out(s.issues ?? []);
if (a[0] === "pr" && a[1] === "list") out(s.prs ?? []);
process.stderr.write("fake gh: no answer for " + a.join(" "));
process.exit(1);
`);
  spawnSync("chmod", ["+x", bin]);
  return { env: { ROLLCALL_GH: bin }, calls: () => JSON.parse(readFileSync(file, "utf8")).calls ?? [], set: (more) => write(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...more })) };
}

const REPOSITORY = {
  pullRequest: {
    number: 7, url: "https://github.com/o/r/pull/7", title: "header polish", state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN",
    headRefOid: "abc123", baseRefName: "main", createdAt: "2026-11-06T10:00:00Z", mergedAt: null, closedAt: null,
    reviews: { nodes: [{ author: { login: "owner", __typename: "User" }, state: "CHANGES_REQUESTED", submittedAt: "2026-11-06T10:20:00Z", url: "https://github.com/o/r/pull/7#r1" }] },
    commits: { nodes: [{ commit: {
      statusCheckRollup: { contexts: { nodes: [
        { __typename: "CheckRun", databaseId: 555, name: "rollcall", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-06T10:01:00Z", completedAt: "2026-11-06T10:09:00Z", detailsUrl: "https://github.com/o/r/actions/runs/9/job/555", checkSuite: { workflowRun: { workflow: { name: "Check" } } } },
        { __typename: "CheckRun", databaseId: 556, name: "Scripts", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-11-06T10:01:00Z", completedAt: null, detailsUrl: "https://github.com/o/r/actions/runs/9/job/556", checkSuite: { workflowRun: { workflow: { name: "Check" } } } },
        { __typename: "StatusContext", context: "attest", state: "SUCCESS", targetUrl: "https://example.com/attest", createdAt: "2026-11-06T10:02:00Z" },
      ] } },
      deployments: { nodes: [{ environment: "Preview", createdAt: "2026-11-06T10:03:00Z", state: "ACTIVE", latestStatus: { state: "SUCCESS", environmentUrl: "https://preview.example.com", logUrl: "https://vercel.com/log", createdAt: "2026-11-06T10:05:00Z" } }] },
    } }] },
  },
  defaultBranchRef: { name: "main", target: { oid: "def456", statusCheckRollup: { contexts: { nodes: [
    { __typename: "CheckRun", databaseId: 1, name: "rollcall", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/o/r/actions/runs/8/job/1" },
  ] } } } },
};
const THREADS = [
  { id: "PRRT_1", isResolved: false, isOutdated: false, path: "src/a.js", line: 2, comments: { nodes: [
    { author: { login: "coderabbitai", __typename: "Bot" }, body: "Consider a name", url: "https://github.com/o/r/pull/7#d1", createdAt: "2026-11-06T10:10:00Z" },
    { author: { login: "worker", __typename: "User" }, body: "Renamed", url: "https://github.com/o/r/pull/7#d2", createdAt: "2026-11-06T10:15:00Z" },
  ] } },
];

test("pr.timeline and check.log through gh: checks with times and ids, deployments, threads, one event list, the queue and main's state", (t) => {
  const { sb, sup } = setup(t, { worktree: true });
  assert.equal(act(sb, "pr.timeline", { task: "alpha:t1" }).error.code, "not-found", "no PR yet");
  assert.equal(sup.cli(["task", "set", "t1", "--state", "pr-open", "--pr", "https://github.com/o/r/pull/7"]).code, 0);
  const gh = fakeGh(sb, { repository: REPOSITORY, threads: THREADS, failedLog: "", wholeLog: "step 1\nboom\n" });
  const r = act(sb, "pr.timeline", { task: "alpha:t1" }, gh);
  assert.equal(r.ok, true, JSON.stringify(r));
  const tl = r.result;
  assert.deepEqual(tl.pr, { url: "https://github.com/o/r/pull/7", number: 7, title: "header polish", state: "OPEN", draft: false, mergeState: "CLEAN", headSha: "abc123", baseBranch: "main", createdAt: Date.parse("2026-11-06T10:00:00Z"), mergedAt: null });
  assert.deepEqual(tl.checks.map((c) => [c.name, c.workflow, c.state, c.conclusion, c.id]), [["rollcall", "Check", "completed", "failure", 555], ["Scripts", "Check", "in_progress", null, 556], ["attest", null, "completed", "success", null]]);
  assert.equal(tl.checks[0].completedAt - tl.checks[0].startedAt, 8 * 60_000);
  assert.deepEqual(tl.deployments, [{ environment: "Preview", state: "success", url: "https://preview.example.com", logUrl: "https://vercel.com/log", at: Date.parse("2026-11-06T10:05:00Z") }]);
  assert.deepEqual(tl.threads.map((x) => [x.id, x.file, x.line, x.author, x.bot, x.body, x.resolved, x.replies]), [["PRRT_1", "src/a.js", 2, "coderabbitai", true, "Consider a name", false, 1]]);
  assert.deepEqual(tl.events.map((e) => e.kind), ["opened", "check", "deploy", "check", "thread", "review"]);
  assert.equal(tl.queue, null);
  assert.deepEqual(tl.main, { branch: "main", sha: "def456", state: "failing", failed: [{ name: "rollcall", link: "https://github.com/o/r/actions/runs/8/job/1" }] });

  // Its place in the merge queue, and the lander's news among the events.
  const key = record(sb).repo.key;
  node(sb, `import * as store from "${SRC}store.mjs"; store.updateQueue(${JSON.stringify(key)}, (q) => { q.entries["5"] = { pr: 5, branch: "x", state: "waiting", at: 1 }; q.entries["7"] = { pr: 7, branch: "y", state: "waiting", at: 2 }; q.outcomes.push({ pr: 7, branch: "y", kind: "conflict", at: Date.parse("2026-11-06T10:30:00Z"), text: "conflicts with main" }); });`);
  const queued = act(sb, "pr.timeline", { task: "alpha:t1" }, gh).result;
  assert.deepEqual(queued.queue, { position: 2, length: 2, state: "waiting", line: null });
  assert.deepEqual(queued.events.at(-1), { at: Date.parse("2026-11-06T10:30:00Z"), kind: "queue", text: "conflict: conflicts with main", url: null });

  // The failed steps' log, falling back to the whole job's when gh has none.
  const log = act(sb, "check.log", { task: "alpha:t1", id: 555 }, gh);
  assert.equal(log.ok, true, JSON.stringify(log));
  assert.deepEqual([log.result.name, log.result.log, log.result.truncated], ["rollcall", "step 1\nboom\n", false]);
  assert.ok(gh.calls().some((a) => a.join(" ") === "run view --job 555 --log-failed"));
  gh.set({ failedLog: "only the failed step\n" });
  assert.equal(act(sb, "check.log", { task: "alpha:t1", name: "rollcall" }, gh).result.log, "only the failed step\n");
  assert.equal(act(sb, "check.log", { task: "alpha:t1", name: "attest" }, gh).error.code, "refused", "a status has no run log");
  assert.equal(act(sb, "check.log", { task: "alpha:t1", id: 999 }, gh).error.code, "not-found");
  assert.equal(act(sb, "check.log", { task: "alpha:t1" }, gh).error.code, "bad-payload");

  gh.set({ fail: "To get started with GitHub CLI, please run:  gh auth login" });
  assert.equal(act(sb, "pr.timeline", { task: "alpha:t1" }, gh).error.code, "unavailable");
  assert.equal(act(sb, "pr.timeline", { task: "alpha:t1" }, { env: { ROLLCALL_GH: join(sb.root, "no-such-gh") } }).error.code, "unavailable");
});

test("repo.items: open issues and PRs newest first, and origin's branches without the default one", (t) => {
  const { sb } = setup(t);
  git(sb.main, "push", "-q", "origin", "main:feat/other");
  const gh = fakeGh(sb, {
    issues: [{ number: 3, title: "old", url: "u3", author: { login: "a" }, labels: [{ name: "bug" }], updatedAt: "2026-11-01T00:00:00Z" }, { number: 4, title: "new", url: "u4", author: { login: "b" }, labels: [], updatedAt: "2026-11-05T00:00:00Z" }],
    prs: [{ number: 9, title: "pr", url: "u9", headRefName: "feat/other", author: { login: "c" }, isDraft: true, updatedAt: "2026-11-04T00:00:00Z" }],
  });
  const r = act(sb, "repo.items", { repo: sb.main }, gh);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.repo.name, "origin");
  assert.deepEqual(r.result.issues.map((i) => [i.number, i.author, i.labels]), [[4, "b", []], [3, "a", ["bug"]]]);
  assert.deepEqual(r.result.prs.map((p) => [p.number, p.branch, p.draft]), [[9, "feat/other", true]]);
  assert.deepEqual(r.result.branches.map((b) => b.name), ["feat/other"]);
  assert.equal(typeof r.result.branches[0].at, "number");
  assert.equal(act(sb, "repo.items", { repo: sb.root }, gh).error.code, "bad-payload", "not a repo");
});

test("task.run log: the tail of a run action's log, then only what is new from the offset it returned", (t) => {
  const { sb } = setup(t, { worktree: true });
  const wt = record(sb).worktree;
  assert.equal(act(sb, "task.run", { task: "alpha:t1", verb: "log", name: "web" }).error.code, "not-found");
  const dir = node(sb, `import { actionsDir } from "${SRC}checkout.mjs"; process.stdout.write(actionsDir(${JSON.stringify(wt)}));`);
  write(join(dir, "web.log"), "x".repeat(70 * 1024));
  const first = act(sb, "task.run", { task: "alpha:t1", verb: "log", name: "web" });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.result.log.length, 64 * 1024);
  assert.equal(first.result.truncated, true);
  assert.equal(first.result.offset, 70 * 1024);
  writeFileSync(join(dir, "web.log"), "ready\n", { flag: "a" });
  const next = act(sb, "task.run", { task: "alpha:t1", verb: "log", name: "web", offset: first.result.offset });
  assert.deepEqual([next.result.log, next.result.truncated, next.result.size], ["ready\n", false, 70 * 1024 + 6]);
  assert.equal(act(sb, "task.run", { task: "alpha:t1", verb: "log", name: "../x" }).error.code, "bad-payload");
});

test("snapshot: a task's tokens, and the usage offer when one plan nears its limit and the other has room", (t) => {
  const { sb } = setup(t);
  const view = () => snap(sb).tasks.find((x) => x.ref === "alpha:t1");
  assert.equal(view().tokens, null);
  write(join(sb.home, "_supervisors", "alpha", "context-t1.json"), JSON.stringify({ pct: 12, tokens: 24000, size: 200000, total: 90000 }));
  assert.deepEqual(view().tokens, { context: 24000, size: 200000, total: 90000 });

  assert.equal(snap(sb).usageOffer, null);
  const now = Date.now();
  write(join(sb.home, "usage-claude.json"), JSON.stringify({ fiveHour: { pct: 95, resetsAt: now + 3600_000 }, weekly: { pct: 40, resetsAt: now + 86400_000 }, at: now }));
  write(join(sb.home, "usage-codex.json"), JSON.stringify({ primary: { pct: 10, resetsAt: now + 3600_000, windowMins: 300 }, secondary: null, plan: "plus", at: now }));
  const offer = snap(sb).usageOffer;
  assert.ok(offer, "an offer");
  assert.deepEqual([offer.from, offer.to, offer.pct, offer.tasks], ["claude", "codex", 95, ["alpha:t1"]]);
  assert.match(offer.text, /Claude/);
  assert.match(offer.text, /Codex/);
});
