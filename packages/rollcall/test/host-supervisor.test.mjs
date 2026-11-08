// Done when: a supervisor runs in the agent host like a task worker (its own history, ref the bare home), a question it
// asks that relays a task's question is answered once from either side, the supervisor's tools (start, tell, wait,
// interrupt, read the chat) reach a hosted worker with no tmux call at all, and the terminal escape hatch shows the
// agent as `terminal`, holds words sent meanwhile, and picks up the terminal's turns into the history once it closes.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BIN, until } from "./helpers.mjs";
import { FAKE, lines, readJson, setup } from "./host-helpers.mjs";

const QUESTIONS = [{ question: "Bold title or a subtitle?", header: "yoda Style", multiSelect: false, options: [{ label: "Bold", description: "heavier" }, { label: "Subtitle", description: "a line" }] }];

/** Home alpha's task t1 (yoda) asking QUESTIONS, and a launch file for the supervisor's own session. */
function supervisorSetup(t, opts = {}) {
  const x = setup(t, { env: { FAKE_CLAUDE_QUESTIONS: JSON.stringify(QUESTIONS), ...(opts.env ?? {}) } });
  const at = Date.now() - 1000;
  x.task({ state: "needs-you", stateAt: at, ask: { at, questions: QUESTIONS }, words: [], notes: [] });
  x.qid = `alpha:t1:${at}`;
  x.supDir = join(x.sb.home, "_supervisors", "alpha", "workers", "alpha");
  mkdirSync(x.supDir, { recursive: true });
  x.supLaunch = (patch = {}) => {
    const cfg = { home: "alpha", task: null, session: randomUUID(), resume: false, settings: join(x.sb.root, "settings.json"), cwd: x.sb.main, bin: FAKE, prompt: null, mode: null, model: null, effort: null, addDir: [], name: "alpha", view: "chat", ...patch };
    writeFileSync(join(x.supDir, "claude-launch.json"), JSON.stringify(cfg));
    return cfg;
  };
  x.supAgent = () => readJson(join(x.supDir, "agent.json"));
  x.supCompat = () => readJson(join(x.supDir, "claude.json"));
  x.supHistory = () => lines(join(x.supDir, "history.jsonl"));
  x.readTask = () => readJson(join(x.sb.home, "_supervisors", "alpha", "tasks", "t1.json"));
  return x;
}

/** The supervisor asks its tagged question; resolves to the open request. */
async function askTagged(x, c) {
  assert.equal((await c.call("start", { ref: "alpha" })).ok, true);
  await c.call("say", { ref: "alpha", text: "ASKTAGGED" });
  return until(async () => (await c.call("state", { ref: "alpha" })).agent.requests[0]);
}

test("host supervisor: its own agent and history; a relayed question answered from the supervisor's side goes to the task once", async (t) => {
  const x = supervisorSetup(t);
  x.supLaunch();
  await x.startHost();
  const c = await x.client();
  const req = await askTagged(x, c);
  assert.deepEqual(req.relays, { ref: "alpha:t1", question: x.qid }, "the supervisor's question names the task's");
  assert.equal(req.ref, "alpha");
  const st = (await c.call("state", { ref: "alpha" })).agent;
  assert.equal(st.supervisor, true);
  assert.equal(st.task, null);
  assert.equal(x.supCompat().view, "chat", "the seam's record, where answer.mjs looks for a chat-view supervisor");
  // Answered on the supervisor's request: the task hears it as a front end's answer, and the request closes.
  const r = await c.call("answer", { request: req.id, answers: { [QUESTIONS[0].question]: "Bold" }, by: "the phone" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.how, "relayed");
  const task = x.readTask();
  assert.equal(task.answered.by, "the phone");
  assert.match(task.words.at(-1).text, /Bold/);
  await until(() => x.supHistory().some((e) => e.ev === "closed" && e.id === req.id));
  // Claude Code heard it was answered elsewhere, so it does not ask again.
  const resp = await until(() => x.inputs().find((i) => i.type === "control_response" && i.response?.response?.behavior === "deny"));
  assert.match(resp.response.response.message, /answered this from the phone/);
  // The second answer, from either side, hears already-answered.
  const again = await c.call("answer", { request: req.id, answers: { [QUESTIONS[0].question]: "Subtitle" } });
  assert.equal(again.error?.code, "already-answered");
  const api = spawnSync(process.execPath, [BIN, "api", "do", "question.answer", JSON.stringify({ task: "alpha:t1", question: x.qid, answer: "Subtitle" })], { env: x.sb.env, encoding: "utf8" });
  assert.equal(JSON.parse(api.stdout).error?.code, "already-answered");
  // The supervisor's own history, apart from the task's.
  const page = await c.call("history", { ref: "alpha" });
  assert.equal(page.ok, true);
  assert.ok(page.items.some((i) => i.kind === "user" && i.text === "ASKTAGGED"));
  assert.equal(x.history().length, 0, "nothing in the task's history");
});

test("host supervisor: a relayed question answered from the task's side closes the supervisor's request", async (t) => {
  const x = supervisorSetup(t);
  x.supLaunch();
  await x.startHost();
  const c = await x.client();
  const req = await askTagged(x, c);
  // A front end answers the task's question (answer.mjs): closeFalconPicker reaches the hosted supervisor's seam.
  const api = spawnSync(process.execPath, [BIN, "api", "do", "question.answer", JSON.stringify({ task: "alpha:t1", question: x.qid, answer: "Subtitle", client: "the Mac" })], { env: x.sb.env, encoding: "utf8" });
  const out = JSON.parse(api.stdout);
  assert.equal(out.ok, true, api.stdout + api.stderr);
  assert.equal(out.result.pickerClosed, true);
  await until(() => x.supHistory().some((e) => e.ev === "closed" && e.id === req.id));
  const again = await c.call("answer", { request: req.id, answers: { [QUESTIONS[0].question]: "Bold" } });
  assert.equal(again.error?.code, "already-answered");
  assert.equal(x.readTask().answered.by, "the Mac");
});

test("host escape hatch: terminal state, words held, the terminal's turns join the history", async (t) => {
  const x = supervisorSetup(t, { env: { FAKE_CLAUDE_TERMINAL_TURN: "from the terminal", FAKE_CLAUDE_TERMINAL_MS: "1500" } });
  const cfg = x.launch();
  await x.startHost();
  const c = await x.client();
  assert.equal((await c.call("start", { ref: "alpha:t1" })).ok, true);
  await c.call("say", { ref: "alpha:t1", text: "before" });
  await until(() => x.agent()?.state === "idle" && x.history().some((e) => e.ev === "item" && e.item.text === "done: before"));
  // A front end asks for the argv: rollcall's own command, which holds the terminal state while the CLI runs.
  const o = await c.call("open", { ref: "alpha:t1" });
  assert.deepEqual(o.argv.slice(1), [BIN, "open", "alpha:t1"]);
  const term = spawn(process.execPath, [BIN, "open", "alpha:t1"], { env: { ...x.sb.env, FAKE_CLAUDE_LOG: x.log, CLAUDE_CONFIG_DIR: x.claudeDir, FAKE_CLAUDE_TERMINAL_TURN: "from the terminal", FAKE_CLAUDE_TERMINAL_MS: "1500" }, stdio: "ignore" });
  const exited = new Promise((r) => term.on("exit", r));
  t.after(() => { try { term.kill("SIGKILL"); } catch {} });
  await until(() => x.agent()?.state === "terminal");
  const st = (await c.call("state", { ref: "alpha:t1" })).agent;
  assert.equal(st.pid, null, "the host holds no process for it");
  assert.equal(st.send, "hold");
  const cli = await until(() => x.fake().find((l) => l.argv && !l.argv.includes("-p")));
  assert.deepEqual(cli.argv.slice(0, 2), ["--resume", cfg.session], "the real CLI on the agent's own session");
  assert.ok(cli.argv.includes("--settings"));
  // Words sent meanwhile wait, and interrupt and park are refused.
  const held = await c.call("say", { ref: "alpha:t1", text: "while open" });
  assert.equal(held.how, "held");
  assert.equal((await c.call("interrupt", { ref: "alpha:t1" })).error?.code, "refused");
  assert.equal((await c.call("park", { ref: "alpha:t1" })).parked, false);
  assert.equal(await exited, 0);
  // Closed: the terminal's turn is in the history, and the held words woke the agent.
  await until(() => x.history().some((e) => e.ev === "item" && e.item.text === "terminal: from the terminal"));
  await until(() => x.history().some((e) => e.ev === "item" && e.item.text === "done: while open"));
  const page = await c.call("history", { ref: "alpha:t1" });
  assert.deepEqual(page.items.filter((i) => i.kind === "user").map((i) => i.text), ["before", "from the terminal", "while open"]);
  await until(() => x.agent()?.state === "idle");
});

test("host supervisor tools: start, tell, wait, interrupt and chat reach a hosted worker with no tmux call", async (t) => {
  const x = setup(t);
  // A tmux that only notes its calls: none may come.
  const bin = join(x.sb.root, "fake-bin");
  mkdirSync(bin, { recursive: true });
  const tmuxLog = join(x.sb.root, "tmux-calls.log");
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\necho "$@" >> '${tmuxLog}'\nexit 1\n`, { mode: 0o755 });
  const env = { ROLLCALL_HOST: "1", PATH: `${bin}:${process.env.PATH}`, KESSELRUNNER_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: x.log, CLAUDE_CONFIG_DIR: x.claudeDir };
  const saved = { ...process.env };
  Object.assign(process.env, x.sb.env, env);
  t.after(async () => {
    const { call } = await import("../src/host/client.mjs");
    await call("shutdown", {}, { start: false });
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const sup = x.sb.session(x.sb.root);
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"], { env }).code, 0);
  const cli = (args) => sup.cli(["task", ...args], { env });
  // Start: what start.mjs runs (supervisor.mjs launch) goes to the host.
  const store = await import("../src/store.mjs");
  const { launch } = await import("../src/supervisor.mjs");
  assert.equal(launch(store.readTask("alpha", "t1"), { prompt: "the brief" }).ok, true);
  await until(() => x.agent()?.state === "idle" && x.history().some((e) => e.ev === "item" && e.item.kind === "assistant"));
  // The hooks a real Claude Code runs say it is up and between turns (the fake runs none).
  store.appendStatus("alpha", "t1", { ev: "session" });
  store.appendStatus("alpha", "t1", { ev: "idle" });
  // Tell: the message waits in the worker's inbox, and the doorbell goes in through the host.
  const told = cli(["tell", "t1", "more words"]);
  assert.equal(told.code, 0, told.stderr);
  await until(() => x.history().some((e) => e.ev === "item" && e.item.kind === "assistant" && e.item.text.includes("rollcall inbox")));
  // Wait with no turn running says so at once; interrupt stops a SLOW turn; wait then hears its end.
  await until(() => x.agent()?.state === "idle");
  const idle = cli(["wait", "t1"]);
  assert.equal(idle.code, 0, idle.stderr);
  assert.match(idle.stdout, /no turn runs/);
  const c = await x.client();
  assert.equal((await c.call("say", { ref: "alpha:t1", text: "SLOW please" })).ok, true);
  await until(() => x.agent()?.state === "running");
  const stop = cli(["interrupt", "t1"]);
  assert.equal(stop.code, 0, stop.stderr);
  assert.match(stop.stdout, /its turn stopped/);
  const ended = cli(["wait", "t1", "--timeout", "1"]);
  assert.match(ended.stdout, /turn ended|no turn runs/);
  // Read the chat: a page of its history.
  const chat = cli(["chat", "t1", "--limit", "50"]);
  assert.equal(chat.code, 0, chat.stderr);
  assert.match(chat.stdout, /> \(rollcall\) .*rollcall inbox/);
  assert.match(chat.stdout, /turn ended/);
  const json = JSON.parse(cli(["chat", "t1", "--json"]).stdout);
  assert.equal(json.ok, true);
  assert.equal(json.view, "chat");
  // Not one tmux call on the way.
  let calls = "";
  try { calls = readFileSync(tmuxLog, "utf8"); } catch {}
  assert.equal(calls, "", `tmux calls for a hosted worker:\n${calls}`);
});

test("host supervisor: under the gate it starts and parks through the host, with no window", async (t) => {
  const x = supervisorSetup(t);
  const bin = join(x.sb.root, "fake-bin");
  mkdirSync(bin, { recursive: true });
  const tmuxLog = join(x.sb.root, "tmux-calls.log");
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\necho "$@" >> '${tmuxLog}'\nexit 1\n`, { mode: 0o755 });
  const saved = { ...process.env };
  Object.assign(process.env, x.sb.env, { ROLLCALL_HOST: "1", PATH: `${bin}:${process.env.PATH}`, KESSELRUNNER_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: x.log, CLAUDE_CONFIG_DIR: x.claudeDir });
  t.after(async () => {
    const { call } = await import("../src/host/client.mjs");
    await call("shutdown", {}, { start: false });
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const { startWindow, parkWindow } = await import("../src/window.mjs");
  const session = randomUUID();
  assert.equal(startWindow("alpha", { session, cwd: x.sb.main, resume: false }).ok, true);
  await until(() => x.supHistory().some((e) => e.ev === "item" && e.item.kind === "assistant"));
  assert.equal(x.supHistory().find((e) => e.ev === "item" && e.item.kind === "user").item.text, "/supervisor alpha");
  await until(() => x.supAgent()?.state === "idle");
  assert.equal(x.supAgent().session, session);
  assert.equal(parkWindow("alpha", { idle: 60_000, open: 1 }).ok, true);
  await until(() => x.supAgent()?.state === "parked");
  let calls = "";
  try { calls = readFileSync(tmuxLog, "utf8"); } catch {}
  assert.equal(calls, "", `tmux calls for a hosted supervisor:\n${calls}`);
});
