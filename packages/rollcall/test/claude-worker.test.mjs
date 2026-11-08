// Done when: `rollcall claude-worker` runs Claude Code in stream mode (here test/fixtures/fake-claude.mjs) and other
// rollcall processes reach it through its socket: words go in as sent or queued, a turn's end lands in turns.jsonl
// and the context file, permission prompts and questions open on the record and close once answered (a second
// answer is `already`), an interrupt reaches the stream, set changes the model and mode and the launch file keeps
// them, a switch moves between the stream and the real CLI at a quiet point keeping the session, the API actions
// (prompt.answer, worker.set, task.switch, task.tell to the supervisor) drive it, and SIGTERM removes its record and
// socket.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { request } from "../src/claude/send.mjs";
import { BIN, FIXTURES, sandbox, until, write } from "./helpers.mjs";

const FAKE = join(FIXTURES, "fake-claude.mjs");
chmodSync(FAKE, 0o755);

const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const lines = (f) => { try { return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

/** Starts `rollcall claude-worker <h> [<task>]` on the fake, with a launch file as harness/claude.mjs writes it. */
async function startWorker(t, sb, { h = "alpha", task = "t1", view = "chat", env = {}, launch = {} } = {}) {
  const dir = join(sb.home, "_supervisors", h, "workers", task ?? h);
  mkdirSync(dir, { recursive: true });
  const settings = join(sb.root, "settings.json");
  if (!existsSync(settings)) writeFileSync(settings, "{}");
  const session = randomUUID();
  writeFileSync(join(dir, "claude-launch.json"), JSON.stringify({
    home: h, task, session, resume: false, settings, cwd: sb.main, bin: FAKE, prompt: null,
    mode: null, model: null, effort: null, addDir: [], name: null, view, ...launch,
  }));
  const log = join(sb.root, `fake-${randomUUID()}.jsonl`);
  // Output goes to a file, not a pipe: a real CLI the worker started inherits it, and a pipe would hold the test open.
  const errFile = join(sb.root, `worker-${randomUUID()}.err`);
  const fd = openSync(errFile, "w");
  const proc = spawn(process.execPath, [BIN, "claude-worker", h, ...(task ? [task] : [])], {
    cwd: sb.main, env: { ...sb.env, FAKE_CLAUDE_LOG: log, ...env }, stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  const exited = new Promise((res) => proc.on("exit", (code, signal) => res({ code, signal })));
  const stderr = () => { try { return readFileSync(errFile, "utf8").slice(-2000); } catch { return ""; } };
  // Stops the worker (it stops its Claude Code), then any fake still running.
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) { proc.kill("SIGTERM"); await Promise.race([exited, new Promise((r) => setTimeout(r, 2000).unref())]); }
    try { proc.kill("SIGKILL"); } catch {}
    for (const x of lines(log)) if (x.argv) { try { process.kill(x.pid, "SIGKILL"); } catch {} }
  });
  const w = {
    proc, exited, session, dir, log,
    stderr,
    rec: () => readJson(join(dir, "claude.json")),
    live: () => readJson(join(dir, "stream.live.json")),
    turns: () => lines(join(dir, "turns.jsonl")),
    launch: () => readJson(join(dir, "claude-launch.json")),
    fake: () => lines(log),
    /** What the worker wrote to the fake's stdin. */
    inputs: () => lines(log).filter((x) => x.in).map((x) => x.in),
    send: (req) => request(w.rec().sock, req),
    /** The argv of the Claude Code the record names now, once it logged it. */
    argvNow: () => until(() => { const c = w.rec()?.child; return c && w.fake().find((x) => x.argv && x.pid === c)?.argv; }),
    idle: () => until(() => w.rec()?.busy === false && w.rec()?.child, { timeout: 8000 }),
  };
  await until(() => w.rec()?.sock && w.rec()?.child && w.fake().some((x) => x.argv), { timeout: 8000 }).catch(() => assert.fail(`the worker did not start: ${stderr()}`));
  return w;
}

/** A sandbox where home alpha exists (its folder), for workers that need no task record. */
function bare(t) {
  const sb = sandbox(t);
  mkdirSync(join(sb.home, "_supervisors", "alpha", "tasks"), { recursive: true });
  return sb;
}

// ---------------------------------------------------------------- words in

test("say while idle is sent: busy for the turn, then a turns.jsonl line and the task's context file", async (t) => {
  const sb = bare(t);
  const w = await startWorker(t, sb);
  assert.equal(w.rec().view, "chat");
  assert.equal(w.rec().busy, false);
  const argv = await w.argvNow();
  for (const f of ["-p", "--input-format", "--output-format", "--include-partial-messages", "--verbose", "--replay-user-messages", "--permission-prompt-tool"]) assert.ok(argv.includes(f), f);
  assert.equal(argv[argv.indexOf("--session-id") + 1], w.session, "a new session starts on its id");

  const r = await w.send({ op: "say", text: "hello there", uuid: "u-1", from: "owner" });
  assert.deepEqual(r, { ok: true, how: "sent", uuid: "u-1" });
  assert.equal(w.rec().busy, true, "busy from the moment it took the words");
  await w.idle();

  const sent = w.inputs().find((x) => x.type === "user");
  assert.equal(sent.uuid, "u-1");
  assert.equal(sent.session_id, w.session);
  assert.equal(sent.message.content, "hello there");
  const turns = w.turns();
  assert.equal(turns.length, 1);
  assert.equal(typeof turns[0].ms, "number");
  assert.deepEqual(turns[0].tokens, { input: 20000, output: 42, context: 50000 });
  assert.equal(turns[0].error, null);
  assert.equal(turns[0].session, w.session);
  const ctx = readJson(join(sb.home, "_supervisors", "alpha", "context-t1.json"));
  assert.equal(ctx.pct, 25);
  assert.equal(ctx.tokens, 50000);
  assert.equal(ctx.size, 200000);
  assert.equal(ctx.session, w.session);
  assert.deepEqual(w.live().queued, []);

  // An attached picture goes in as an image block, the text names it.
  const png = join(sb.root, "shot.png");
  writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
  const r2 = await w.send({ op: "say", text: "look", attachments: [png] });
  assert.equal(r2.how, "sent");
  await until(() => w.turns().length === 2);
  const withPic = w.inputs().filter((x) => x.type === "user")[1];
  assert.equal(withPic.uuid, r2.uuid);
  assert.equal(withPic.message.content[0].type, "image");
  assert.equal(withPic.message.content[0].source.media_type, "image/png");
  assert.equal(withPic.message.content[1].text, `look\n\n[Attached: ${png}]`);
  assert.deepEqual(await w.send({ op: "say", text: "  " }), { ok: false, err: "nothing to say" });
});

test("say while busy is queued: the live file holds it until its replay, then it empties", async (t) => {
  const sb = bare(t);
  const w = await startWorker(t, sb);
  assert.equal((await w.send({ op: "say", text: "SLOW work" })).how, "sent");
  const r = await w.send({ op: "say", text: "and this too", uuid: "u-2", from: "owner" });
  assert.deepEqual(r, { ok: true, how: "queued", uuid: "u-2" });
  const q = w.live().queued;
  assert.deepEqual(q.map((x) => [x.uuid, x.text, x.from]), [["u-2", "and this too", "owner"]]);
  await until(() => w.live()?.queued.length === 0, { timeout: 5000 });
  assert.ok(w.fake().some((x) => x.replayed === "u-2"), "it left the queue on its replay");
  await w.idle();
  assert.equal(w.turns().length, 1, "taken into the running turn: one result");
});

// ---------------------------------------------------------------- prompts

test("a permission prompt opens on the record; allow, a second answer, an unknown id, deny with why", async (t) => {
  const sb = bare(t);
  const w = await startWorker(t, sb);
  await w.send({ op: "say", text: "TOOL run it" });
  const p = await until(() => w.rec()?.prompt);
  assert.equal(p.kind, "permission");
  assert.equal(p.tool, "Bash");
  assert.equal(p.summary, "ls -la");
  assert.equal(p.reason, "List the files");
  assert.equal(p.questions, null);
  assert.ok(Array.isArray(p.suggestions));

  assert.deepEqual(await w.send({ op: "answer", prompt: p.id, allow: true, by: "test" }), { ok: true, answered: true });
  assert.equal(w.rec().prompt, null, "the prompt clears");
  const resp = await until(() => w.inputs().find((x) => x.type === "control_response" && x.response.request_id === p.id));
  assert.equal(resp.response.subtype, "success");
  assert.deepEqual(resp.response.response, { behavior: "allow", updatedInput: { command: "ls -la", description: "List the files" } });
  assert.deepEqual(await w.send({ op: "answer", prompt: p.id, allow: false }), { ok: true, already: true });
  const unknown = await w.send({ op: "answer", prompt: "nope", allow: true });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "not-found");
  await w.idle();

  await w.send({ op: "say", text: "TOOL again" });
  const p2 = await until(() => w.rec()?.prompt);
  assert.notEqual(p2.id, p.id);
  await w.send({ op: "answer", prompt: p2.id, allow: false, why: "too risky" });
  const deny = await until(() => w.inputs().find((x) => x.type === "control_response" && x.response.request_id === p2.id));
  assert.equal(deny.response.response.behavior, "deny");
  assert.match(deny.response.response.message, /too risky/);
  await w.idle();
});

test("the supervisor's question is a `question` prompt; answers go back as updatedInput.answers; relays names the task's question", async (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  assert.equal(sup.cli(["task", "new", "header polish", "--repo", sb.main, "--words", "make it bold", "--no-worktree"]).code, 0);
  const questions = [{ question: "Bold title or a subtitle?", header: "yoda Style", multiSelect: false, options: [{ label: "Bold", description: "heavier" }, { label: "Subtitle", description: "a line" }] }];
  const file = join(sb.root, "ask.json");
  write(file, JSON.stringify(questions));
  assert.equal(sup.cli(["task", "set", "t1", "--state", "needs-you", "--ask-json", file], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  const t1 = readJson(join(sb.home, "_supervisors", "alpha", "tasks", "t1.json"));
  const qid = `alpha:t1:${t1.ask?.at ?? t1.stateAt ?? t1.updatedAt}`;

  const w = await startWorker(t, sb, { task: null, env: { FAKE_CLAUDE_QUESTIONS: JSON.stringify(questions) } });
  // A question naming no task relays nothing.
  await w.send({ op: "say", text: "ASK me" });
  const plain = await until(() => w.rec()?.prompt);
  assert.equal(plain.kind, "question");
  assert.equal(plain.relays, null);
  assert.deepEqual(plain.questions, [{ question: "Ship it?", header: "Ship", multiSelect: false, options: [{ label: "Yes", description: "ship" }, { label: "No", description: "wait" }] }]);
  const bad = await w.send({ op: "answer", prompt: plain.id, allow: true });
  assert.equal(bad.code, "bad-payload", "a question takes answers");
  assert.deepEqual(await w.send({ op: "answer", prompt: plain.id, answers: { "Ship it?": "Yes" } }), { ok: true, answered: true });
  const resp = await until(() => w.inputs().find((x) => x.type === "control_response" && x.response.request_id === plain.id));
  assert.equal(resp.response.response.behavior, "allow");
  assert.deepEqual(resp.response.response.updatedInput.answers, { "Ship it?": "Yes" });
  assert.deepEqual(resp.response.response.updatedInput.questions[0].question, "Ship it?");
  await w.idle();

  // One that names yoda, whose task asks now: relays its question.
  await w.send({ op: "say", text: "ASKTAGGED" });
  const tagged = await until(() => w.rec()?.prompt);
  assert.deepEqual(tagged.relays, { ref: "alpha:t1", question: qid });
  assert.equal(tagged.questions[0].header, "yoda Style");
  await w.send({ op: "answer", prompt: tagged.id, answers: { "Bold title or a subtitle?": "Bold" } });
  const r2 = await until(() => w.inputs().find((x) => x.type === "control_response" && x.response.request_id === tagged.id));
  assert.deepEqual(r2.response.response.updatedInput.answers, { "Bold title or a subtitle?": "Bold" });
  await w.idle();
  // No context file for a task: the supervisor's own.
  assert.equal(readJson(join(sb.home, "_supervisors", "alpha", "context.json"))?.pct, 25);
});

// ---------------------------------------------------------------- interrupt, set

test("interrupt during a SLOW turn reaches the stream and the turn ends as an error", async (t) => {
  const sb = bare(t);
  const w = await startWorker(t, sb);
  assert.deepEqual(await w.send({ op: "interrupt" }), { ok: true, interrupted: false }, "nothing runs");
  await w.send({ op: "say", text: "SLOW please" });
  await until(() => w.live()?.items?.some((x) => x.text.startsWith("slow")));
  assert.deepEqual(await w.send({ op: "interrupt" }), { ok: true, interrupted: true });
  assert.ok(w.inputs().some((x) => x.type === "control_request" && x.request.subtype === "interrupt"));
  await w.idle();
  const turns = w.turns();
  assert.equal(turns.length, 1);
  assert.match(turns[0].error, /Interrupted/);
  assert.ok(turns[0].ms < 1900, `ended early (${turns[0].ms} ms)`);
});

test("set sends set_model and set_permission_mode, and the launch file remembers them", async (t) => {
  const sb = bare(t);
  const w = await startWorker(t, sb);
  assert.deepEqual(await w.send({ op: "set", model: "opus", mode: "acceptEdits" }), { ok: true, set: { model: "opus", mode: "acceptEdits" } });
  const reqs = w.inputs().filter((x) => x.type === "control_request").map((x) => x.request);
  assert.deepEqual(reqs, [{ subtype: "set_model", model: "opus" }, { subtype: "set_permission_mode", mode: "acceptEdits" }]);
  const l = w.launch();
  assert.equal(l.model, "opus");
  assert.equal(l.mode, "acceptEdits");
});

// ---------------------------------------------------------------- the switch

test("switch: chat -> terminal while idle resumes the session in the real CLI, and back restarts the stream", async (t) => {
  const sb = bare(t);
  const w = await startWorker(t, sb);
  const streamPid = w.rec().child;
  assert.deepEqual(await w.send({ op: "switch", to: "chat" }), { ok: true, already: true, view: "chat" });

  const r = await w.send({ op: "switch", to: "terminal" });
  assert.deepEqual(r, { ok: true, switched: true, pending: false, view: "chat" });
  await until(() => w.rec()?.view === "terminal" && w.rec()?.child && w.rec().child !== streamPid);
  assert.equal(w.rec().switching, null);
  assert.equal(w.launch().view, "terminal");
  const cli = await w.argvNow();
  assert.ok(!cli.includes("-p"), "the real CLI, not stream mode");
  assert.equal(cli[cli.indexOf("--resume") + 1], w.session);
  assert.ok(!cli.includes("--session-id"));
  const say = await w.send({ op: "say", text: "hi" });
  assert.equal(say.ok, false, "no words through the stream in the terminal view");
  assert.equal(say.view, "terminal");

  const termPid = w.rec().child;
  const back = await w.send({ op: "switch", to: "chat" });
  assert.equal(back.switched, true);
  await until(() => w.rec()?.view === "chat" && w.rec()?.child && w.rec().child !== termPid);
  assert.ok(w.fake().some((x) => x.sigterm && x.pid === termPid), "the CLI was stopped by SIGTERM");
  const again = await w.argvNow();
  assert.ok(again.includes("-p"));
  assert.equal(again[again.indexOf("--resume") + 1], w.session);
  assert.equal(w.launch().view, "chat");
  assert.equal((await w.send({ op: "say", text: "back" })).how, "sent");
  await w.idle();
});

test("switch while a turn runs is pending, and happens when the turn ends", async (t) => {
  const sb = bare(t);
  const w = await startWorker(t, sb);
  await w.send({ op: "say", text: "SLOW then switch" });
  const r = await w.send({ op: "switch", to: "terminal" });
  assert.deepEqual(r, { ok: true, switched: false, pending: true, view: "chat" });
  assert.equal(w.rec().switching.to, "terminal");
  assert.equal(w.rec().view, "chat");
  await until(() => w.rec()?.view === "terminal", { timeout: 6000 });
  assert.equal(w.turns().length, 1, "the turn finished first");
  assert.equal(w.rec().switching, null);
});

// ---------------------------------------------------------------- through the API

function owner(sb, args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: sb.root, encoding: "utf8", env: sb.env });
  try { return { exit: r.status, ...JSON.parse(r.stdout) }; } catch { return assert.fail(`not JSON (exit ${r.status}): ${r.stdout}${r.stderr}`); }
}
const act = (sb, name, payload) => owner(sb, ["api", "do", name, JSON.stringify(payload)]);
const snap = (sb) => owner(sb, ["api", "snapshot"]);

test("api: prompt.answer, worker.set and task.switch drive a task's chat worker; the snapshot shows view, switching and prompt", async (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  assert.equal(sup.cli(["task", "new", "header polish", "--repo", sb.main, "--words", "make it bold", "--no-worktree"]).code, 0);

  // No worker in the chat: refused.
  assert.equal(act(sb, "prompt.answer", { task: "alpha:t1", prompt: "x", allow: true }).error.code, "refused");
  assert.equal(act(sb, "worker.set", { task: "alpha:t1", model: "opus" }).error.code, "refused");

  // The task's worker session, as its SessionStart would record it (no tmux window here: the snapshot shows a
  // worker without one).
  const tf = join(sb.home, "_supervisors", "alpha", "tasks", "t1.json");
  const w = await startWorker(t, sb);
  const task = readJson(tf);
  writeFileSync(tf, JSON.stringify({ ...task, sessions: [...(task.sessions ?? []), { id: w.session, at: Date.now() }] }));
  const worker = () => snap(sb).tasks.find((x) => x.ref === "alpha:t1").worker;
  assert.deepEqual([worker().view, worker().switching, worker().prompt], ["chat", null, null]);

  await w.send({ op: "say", text: "TOOL go" });
  const p = await until(() => worker()?.prompt);
  assert.equal(p.kind, "permission");
  assert.equal(p.tool, "Bash");
  assert.equal(act(sb, "prompt.answer", { task: "alpha:t1", prompt: "nope", allow: true }).error.code, "not-found");
  assert.equal(act(sb, "prompt.answer", { task: "alpha:t1", prompt: p.id, allow: "yes" }).error.code, "bad-payload");
  const a = act(sb, "prompt.answer", { task: "alpha:yoda", prompt: p.id, allow: true });
  assert.equal(a.exit, 0, JSON.stringify(a));
  assert.equal(a.result.answered, true);
  assert.equal(a.result.view.worker.prompt, null);
  assert.equal(act(sb, "prompt.answer", { task: "alpha:t1", prompt: p.id, allow: true }).result.already, true);
  await w.idle();

  const s = act(sb, "worker.set", { task: "alpha:t1", model: "sonnet", mode: "plan" });
  assert.deepEqual(s.result.set, { model: "sonnet", mode: "plan" });
  assert.equal(w.launch().model, "sonnet");
  assert.equal(act(sb, "worker.set", { task: "alpha:t1", mode: "yolo" }).error.code, "bad-payload");

  // A switch during a turn waits for it; the snapshot shows it waiting.
  assert.equal(act(sb, "task.switch", { task: "alpha:t1", to: "sideways" }).error.code, "bad-payload");
  await w.send({ op: "say", text: "SLOW" });
  const sw = act(sb, "task.switch", { task: "alpha:t1", to: "terminal" });
  assert.equal(sw.result.pending, true);
  assert.equal(worker().switching.to, "terminal");
  await until(() => worker()?.view === "terminal", { timeout: 6000 });
  assert.equal(worker().switching, null);
  assert.equal(act(sb, "prompt.answer", { task: "alpha:t1", prompt: "x", allow: true }).error.code, "refused", "refused in the terminal view");
  assert.equal(act(sb, "task.switch", { task: "alpha:t1", to: "chat" }).result.switched, true);
  await until(() => worker()?.view === "chat");
});

test("api: task.tell to the supervisor goes into its chat stream; its snapshot shows the view and prompt", async (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  assert.equal(act(sb, "task.tell", { task: "alpha", text: "hi" }).error.code, "refused", "no chat worker yet");
  const w = await startWorker(t, sb, { task: null });
  const r = act(sb, "task.tell", { task: "alpha", text: "ASK something" });
  assert.equal(r.exit, 0, JSON.stringify(r));
  assert.equal(r.result.how, "sent");
  const said = await until(() => w.inputs().find((x) => x.type === "user"));
  assert.equal(said.message.content, "ASK something");
  const supView = () => snap(sb).supervisors.find((x) => x.name === "alpha");
  const p = await until(() => supView()?.prompt);
  assert.equal(supView().view, "chat");
  assert.equal(p.kind, "question");
  const a = act(sb, "prompt.answer", { task: "alpha", prompt: p.id, answers: { "Ship it?": "No" } });
  assert.equal(a.result.answered, true);
  const resp = await until(() => w.inputs().find((x) => x.type === "control_response" && x.response.request_id === p.id));
  assert.deepEqual(resp.response.response.updatedInput.answers, { "Ship it?": "No" });
  await w.idle();
});

// ---------------------------------------------------------------- the end

test("SIGTERM removes the worker's record and socket and stops Claude Code", async (t) => {
  const sb = bare(t);
  const w = await startWorker(t, sb);
  const { sock, child } = w.rec();
  assert.ok(existsSync(sock));
  w.proc.kill("SIGTERM");
  const ended = await w.exited;
  assert.equal(ended.code, 0);
  assert.equal(existsSync(join(w.dir, "claude.json")), false);
  assert.equal(existsSync(sock), false);
  await until(() => { try { process.kill(child, 0); return false; } catch { return true; } }, { timeout: 3000 });
});

test("words that arrive while the stream closes for a switch are refused or reach Claude Code, never lost", async (t) => {
  const sb = bare(t);
  const w = await startWorker(t, sb);
  const [sw, say] = await Promise.all([w.send({ op: "switch", to: "terminal" }), w.send({ op: "say", text: "do not lose me", uuid: "u-lost" })]);
  assert.equal(sw.switched, true);
  await until(() => w.rec()?.view === "terminal");
  await new Promise((r) => setTimeout(r, 300));
  const reached = w.inputs().some((x) => x.type === "user" && x.uuid === "u-lost");
  assert.ok(say.ok === false || reached, `the worker answered ${JSON.stringify(say)} and Claude Code never got the words`);
});
