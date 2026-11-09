// Done when: `rollcall host` runs task agents as its children (here test/fixtures/fake-claude.mjs and fake-codex.mjs)
// and its socket drives them: start, words sent and queued, a request answered from two clients with the first
// winning, interrupt, an idle agent parking and a message waking it, one history across a session change, earlier
// sessions backfilled from their transcripts, a restart keeping requests and history (an answer to a request whose
// process is gone goes in as the owner's words), the push subscription's lines, and the stream worker's control socket
// (claude/live.mjs) reaching a hosted agent unchanged.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { request } from "../src/claude/send.mjs";
import { connect, socketFor } from "../src/host/client.mjs";
import { BIN, until } from "./helpers.mjs";
import { FAKE, lines, readJson, setup } from "./host-helpers.mjs";

const ref = "alpha:t1";

test("host: start, say, the history and the push lines", async (t) => {
  const x = setup(t);
  x.launch();
  await x.startHost();
  const events = [];
  const sub = await x.client((e) => events.push(e));
  const s = await sub.call("subscribe", { refs: [ref] });
  assert.equal(s.ok, true);
  const c = await x.client();
  const r = await c.call("start", { ref });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.agent.state, "idle");
  assert.equal(r.agent.send, "start");
  const said = await c.call("say", { ref, text: "hello there" });
  assert.equal(said.how, "sent");
  await until(() => x.agent()?.state === "idle" && x.history().some((e) => e.ev === "item" && e.item.kind === "turn" && e.item.phase === "end"));
  const page = await c.call("history", { ref });
  assert.equal(page.ok, true);
  const kinds = page.items.map((i) => i.kind);
  assert.deepEqual(kinds, ["turn", "user", "assistant", "turn"]);
  assert.equal(page.items[1].text, "hello there");
  assert.equal(page.items[1].id, said.uuid, "the words keep the id they were sent with");
  assert.equal(page.items[2].text, "done: hello there");
  assert.equal(page.items[3].tokens.output, 42);
  // The push connection saw the same, live: state changes, the queued words, streamed text, the items.
  const evs = events.map((e) => e.ev);
  for (const ev of ["state", "session", "item", "text"]) assert.ok(evs.includes(ev), `a ${ev} event: ${evs.join(",")}`);
  assert.ok(events.some((e) => e.ev === "item" && e.item.queued && e.item.id === said.uuid));
  assert.equal(events.filter((e) => e.ev === "text").map((e) => e.append).join(""), "done: hello there");
  assert.ok(events.every((e) => e.ref === ref && e.v === 1 && Number.isFinite(e.seq)));
  // The compat record points the stream worker's seam at the host.
  const rec = x.compat();
  assert.equal(rec.view, "chat");
  assert.equal(rec.hosted, true);
  const viaSeam = await request(rec.sock, { op: "say", text: "through the seam", from: "rollcall" });
  assert.equal(viaSeam.ok, true);
  await until(() => x.inputs().some((m) => m.type === "user" && m.message?.content === "through the seam"));
});

test("host: words while a turn runs join it; interrupt stops the turn", async (t) => {
  const x = setup(t);
  x.launch();
  await x.startHost();
  const c = await x.client();
  await c.call("start", { ref });
  assert.equal((await c.call("say", { ref, text: "SLOW work" })).how, "sent");
  await until(() => x.fake().some((l) => l.replayed));
  const q = await c.call("say", { ref, text: "and also this" });
  assert.equal(q.how, "queued");
  assert.equal((await c.call("state", { ref })).agent.send, "join");
  const i = await c.call("interrupt", { ref });
  assert.equal(i.interrupted, true);
  await until(() => x.agent()?.state === "idle");
  const items = (await c.call("history", { ref })).items;
  const taken = items.find((it) => it.id === q.uuid);
  assert.equal(taken?.kind, "user", "the queued words were taken into the turn");
  assert.equal(taken.queued, false);
  assert.equal(items.filter((it) => it.kind === "turn" && it.phase === "start").length, 1, "one turn, not two");
  assert.ok(items.find((it) => it.kind === "turn" && it.phase === "end")?.error, "an interrupted turn ends with an error");
});

test("host: a request answered from two clients: the first wins, the other hears already-answered", async (t) => {
  const x = setup(t);
  x.launch();
  await x.startHost();
  const events = [];
  const a = await x.client((e) => events.push(e));
  await a.call("subscribe", {});
  const b = await x.client();
  await a.call("start", { ref });
  await a.call("say", { ref, text: "TOOL please" });
  await until(() => events.some((e) => e.ev === "request"));
  const req = events.find((e) => e.ev === "request").request;
  assert.match(req.id, /^rq-/);
  assert.equal(req.kind, "permission");
  assert.equal(req.tool, "Bash");
  assert.equal(x.compat().prompt?.id, req.id, "the compat record shows the open request as its prompt");
  const [r1, r2] = await Promise.all([a.call("answer", { request: req.id, allow: true, by: "mac" }), b.call("answer", { request: req.id, allow: false, by: "phone" })]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, "already-answered");
  await until(() => x.agent()?.state === "idle");
  const items = (await a.call("history", { ref })).items;
  assert.match(items.find((it) => it.kind === "assistant")?.text ?? "", /^allowed/);
  assert.ok(events.some((e) => e.ev === "closed" && e.id === req.id && e.by === "mac"));
  assert.equal(x.compat().prompt, null);
  // The seam's answer op on a closed request is `already`, as the stream worker's was.
  const again = await request(x.compat().sock, { op: "answer", prompt: req.id, allow: true });
  assert.deepEqual(again, { ok: true, already: true });
});

test("host: an idle agent parks; a message wakes it on its session", async (t) => {
  const x = setup(t, { env: { ROLLCALL_HOST_PARK_MS: "400" } });
  const cfg = x.launch();
  await x.startHost();
  const c = await x.client();
  await c.call("start", { ref });
  await c.call("say", { ref, text: "first" });
  await until(() => x.agent()?.state === "parked", { timeout: 15_000 });
  assert.equal(x.agent().pid, null);
  assert.equal(x.compat()?.hosted, true, "a parked agent keeps its record: a say wakes it");
  const st = await c.call("state", { ref });
  assert.equal(st.agent.send, "wake");
  const w = await c.call("say", { ref, text: "second" });
  assert.equal(w.how, "resumed");
  await until(() => x.history().filter((e) => e.ev === "item" && e.item.kind === "assistant").length === 2);
  const argvs = x.fake().filter((l) => l.argv).map((l) => l.argv);
  assert.equal(argvs.length, 2);
  assert.equal(argvs[1][argvs[1].indexOf("--resume") + 1], cfg.session);
  const page = await c.call("history", { ref });
  assert.deepEqual(page.items.filter((i) => i.kind === "user").map((i) => i.text), ["first", "second"]);
});

test("host: one history across a session change, with earlier sessions backfilled", async (t) => {
  const x = setup(t);
  // An earlier session that ran in tmux: its transcript is all there is.
  const old = randomUUID();
  const tdir = join(x.claudeDir, "projects", x.sb.main.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(tdir, { recursive: true });
  const ts = (n) => new Date(Date.now() - 60_000 + n * 1000).toISOString();
  writeFileSync(join(tdir, `${old}.jsonl`), [
    { type: "user", uuid: "u-old", timestamp: ts(0), sessionId: old, message: { role: "user", content: "old words" } },
    { type: "assistant", uuid: "a-old", timestamp: ts(1), sessionId: old, message: { id: "msg_old", role: "assistant", content: [{ type: "text", text: "old reply" }] } },
    { type: "system", subtype: "stop_hook_summary", uuid: "s-old", timestamp: ts(2), sessionId: old },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  x.task({ sessions: [{ id: old, at: Date.now() - 60_000, endedAt: Date.now() - 30_000, tmux: true }] });
  x.launch();
  await x.startHost();
  const c = await x.client();
  // A read before any start backfills.
  const first = await c.call("history", { ref });
  assert.deepEqual(first.items.map((i) => i.text).filter(Boolean), ["old words", "old reply"]);
  await c.call("start", { ref });
  await c.call("say", { ref, text: "new words" });
  await until(() => x.agent()?.state === "idle" && x.history().filter((e) => e.ev === "item" && e.item.kind === "assistant").length === 2);
  // A handoff: a new session in the same task. The history carries on.
  await c.call("stop", { ref });
  await until(() => x.agent()?.state === "stopped");
  x.launch();
  await c.call("start", { ref });
  await c.call("say", { ref, text: "after the handoff" });
  await until(() => x.agent()?.state === "idle" && x.history().filter((e) => e.ev === "item" && e.item.kind === "assistant").length === 3);
  const page = await c.call("history", { ref });
  assert.deepEqual(page.items.filter((i) => i.kind === "user").map((i) => i.text), ["old words", "new words", "after the handoff"]);
  const sessions = x.history().filter((e) => e.ev === "session");
  assert.deepEqual(sessions.map((e) => e.how), ["backfill", "new", "new"]);
  // Pages: a stable cursor.
  const small = await c.call("history", { ref, limit: 2 });
  assert.equal(small.more, true);
  const before = await c.call("history", { ref, limit: 100, before: small.cursor });
  assert.equal(before.items.at(-1).id, page.items[page.items.length - 3].id);
});

test("host: a restart keeps history and requests; an answer to a request whose process is gone goes in as words", async (t) => {
  const x = setup(t);
  const cfg = x.launch();
  const h1 = await x.startHost();
  let c = await x.client();
  await c.call("start", { ref });
  await c.call("say", { ref, text: "ASK me" });
  await until(() => x.history().some((e) => e.ev === "request"));
  const req = x.history().find((e) => e.ev === "request").request;
  assert.equal(req.kind, "question");
  h1.kill("SIGKILL");
  await h1.exited;
  await x.startHost();
  c = await x.client();
  const st = (await c.call("state", { ref })).agent;
  assert.equal(st.state, "parked");
  assert.deepEqual(st.requests.map((r) => r.id), [req.id], "the request survived the restart");
  const page = await c.call("history", { ref });
  assert.ok(page.items.some((i) => i.text === "ASK me"));
  assert.ok(page.items.some((i) => i.kind === "system" && /host restarted/.test(i.text)));
  const r = await c.call("answer", { request: req.id, answers: { "Ship it?": "Yes" } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.how, "words");
  await until(() => x.inputs().some((m) => m.type === "user" && /Ship it\? Yes/.test(m.message?.content ?? "")));
  const argvs = x.fake().filter((l) => l.argv).map((l) => l.argv);
  assert.equal(argvs.at(-1)[argvs.at(-1).indexOf("--resume") + 1], cfg.session);
  const again = await c.call("answer", { request: req.id, answers: { "Ship it?": "No" } });
  assert.equal(again.error?.code, "already-answered");
});

test("host: only one runs per store", async (t) => {
  const x = setup(t);
  await x.startHost();
  const second = spawn(process.execPath, [BIN, "host"], { env: { ...x.sb.env }, stdio: "ignore" });
  const code = await new Promise((r) => second.on("exit", r));
  assert.equal(code, 0);
  const c = await x.client();
  assert.equal((await c.call("hello")).ok, true);
});

test("host: a hosted crew's task worker starts in the host, and the seam drives it", async (t) => {
  const x = setup(t);
  const saved = { ...process.env };
  Object.assign(process.env, x.sb.env, { KESSELRUNNER_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: x.log, CLAUDE_CONFIG_DIR: x.claudeDir });
  t.after(async () => {
    const { call } = await import("../src/host/client.mjs");
    await call("shutdown", {}, { start: false });
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const store = await import("../src/store.mjs");
  const { launch, workerState, stopWorker } = await import("../src/supervisor.mjs");
  const { adapter } = await import("../src/harness/index.mjs");
  const r = launch(store.readTask("alpha", "t1"), { prompt: "the brief" });
  assert.equal(r.ok, true, r.err);
  let task = store.readTask("alpha", "t1");
  assert.equal(task.sessions.at(-1).hosted, true);
  assert.equal(task.sessions.at(-1).tmux, false);
  await until(() => x.history().some((e) => e.ev === "item" && e.item.kind === "assistant"));
  await until(() => x.agent()?.state === "idle");
  const w = workerState(task);
  assert.equal(w.hosted, true);
  assert.equal(w.alive, true);
  // rollcall's words go through the agent's seam (claude/live.mjs).
  const typed = adapter("claude").type(task, "more words");
  assert.equal(typed.ok, true, typed.err);
  await until(() => x.history().filter((e) => e.ev === "item" && e.item.kind === "assistant").length === 2);
  // `api conversation` reads the host's history.
  const { spawnSync } = await import("node:child_process");
  const out = spawnSync(process.execPath, [BIN, "api", "conversation", ref], { env: process.env, encoding: "utf8" });
  const page = JSON.parse(out.stdout);
  assert.equal(page.ok, true, out.stdout + out.stderr);
  assert.equal(page.view, "chat");
  assert.deepEqual(page.items.filter((i) => i.kind === "user").map((i) => i.text), ["the brief", "more words"]);
  assert.equal(stopWorker(task), true);
  await until(() => x.agent()?.state === "stopped");
  task = store.readTask("alpha", "t1");
  assert.equal(workerState(task).stopped, true);
  assert.equal(x.compat(), null, "a stopped agent has no record: nothing reaches it");
});

test("host: api conversation --follow prints the host's push events as the conversation's lines", async (t) => {
  const x = setup(t);
  const cfg = x.launch();
  x.task({ sessions: [{ id: cfg.session, at: Date.now(), endedAt: null, tmux: false, hosted: true }] });
  await x.startHost();
  const c = await x.client();
  await c.call("start", { ref });
  const out = [];
  const f = spawn(process.execPath, [BIN, "api", "conversation", ref, "--follow"], { env: x.sb.env, stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { try { f.kill("SIGKILL"); } catch {} });
  let buf = "";
  f.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  await until(() => out.some((l) => l.type === "page"));
  assert.equal(out[0].type, "page");
  assert.equal(out[0].view, "chat");
  const said = await c.call("say", { ref, text: "TOOL go" });
  await until(() => out.some((l) => l.type === "prompt" && l.prompt));
  const p = out.find((l) => l.type === "prompt" && l.prompt).prompt;
  await c.call("answer", { request: p.id, allow: true });
  await until(() => out.some((l) => l.type === "item" && l.item.kind === "turn" && l.item.phase === "end"));
  assert.ok(out.some((l) => l.type === "item" && l.item.id === said.uuid && l.item.queued === false), "the words, taken");
  assert.ok(out.some((l) => l.type === "prompt" && l.prompt === null), "the prompt closed");
  assert.ok(out.some((l) => l.type === "item" && l.item.streaming === true), "streamed text opens as a streaming item");
  assert.ok(out.some((l) => l.type === "text"), "and grows by text lines");
  assert.ok(out.every((l, i) => l.v === 1 && l.seq === i + 1));
});

// ---------------------------------------------------------------- Codex

test("host codex: start, words, the history with session-prefixed ids, the seam, the hooks, and stop", async (t) => {
  const x = setup(t);
  const cfg = x.codexLaunch();
  await x.startHost();
  const events = [];
  const sub = await x.client((e) => events.push(e));
  await sub.call("subscribe", { refs: [ref] });
  const c = await x.client();
  const r = await c.call("start", { ref, harness: "codex" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.agent.harness, "codex");
  assert.equal(r.agent.state, "idle");
  const said = await c.call("say", { ref, text: "STREAM hello" });
  assert.equal(said.how, "sent");
  await until(() => x.agent()?.state === "idle" && x.history().some((e) => e.ev === "item" && e.item.kind === "turn" && e.item.phase === "end"));
  const page = await c.call("history", { ref });
  assert.equal(page.harness, "codex");
  const user = page.items.find((i) => i.kind === "user");
  assert.equal(user.id, said.uuid, "the owner's words keep the id they were sent with");
  assert.equal(user.from, "owner");
  const reply = page.items.find((i) => i.kind === "assistant");
  assert.ok(reply.id.startsWith(`${cfg.session.slice(0, 8)}:`), reply.id);
  // Streamed text went to subscribers under the item's own id, and the history logged the item once, finished.
  const streamed = events.filter((e) => e.ev === "text");
  assert.ok(streamed.length > 1 && streamed.every((e) => e.id === reply.id), JSON.stringify(streamed.slice(0, 2)));
  assert.equal(streamed.map((e) => e.append).join(""), reply.text);
  // The thread is remembered for a resume: on the launch file and on the task's session.
  const thread = readJson(join(x.dir, "codex-launch.json")).thread;
  assert.ok(thread);
  assert.equal(readJson(join(x.sb.home, "_supervisors", "alpha", "tasks", "t1.json")).sessions[0].thread, thread);
  // The hooks ran as for a tmux Codex worker: the prompt and the turn's end are on the task's status log.
  const status = lines(join(x.sb.home, "_supervisors", "alpha", "status", "t1.jsonl"));
  assert.ok(status.some((e) => e.ev === "busy") && status.some((e) => e.ev === "idle"), JSON.stringify(status.map((e) => e.ev)));
  // The compat record points the Codex seam at the host: a delivery keeps rollcall's client id.
  const rec = x.codexCompat();
  assert.equal(rec.hosted, true);
  assert.equal(rec.thread, thread);
  assert.equal(rec.ctl, rec.sock);
  const viaSeam = await request(rec.ctl, { op: "say", text: "through the seam", from: "rollcall" });
  assert.equal(viaSeam.ok, true, JSON.stringify(viaSeam));
  assert.ok(viaSeam.uuid.startsWith("rollcall-d-"));
  await until(() => x.history().some((e) => e.ev === "item" && e.item.id === viaSeam.uuid));
  await until(() => x.agent()?.state === "idle");
  // Stop: the app server ends and the compat record goes.
  assert.equal((await c.call("stop", { ref })).ok, true);
  await until(() => x.agent()?.state === "stopped");
  assert.equal(x.codexCompat(), null);
  assert.ok(!x.agent().pid);
});

test("host codex: an approval is a saved request; the first answer wins; a mode change is refused", async (t) => {
  const x = setup(t);
  x.codexLaunch();
  await x.startHost();
  const c1 = await x.client();
  const c2 = await x.client();
  assert.equal((await c1.call("start", { ref, harness: "codex" })).ok, true);
  await c1.call("say", { ref, text: "HOLD on" });
  await until(() => x.agent() && x.history().some((e) => e.ev === "request"));
  const req = x.history().find((e) => e.ev === "request").request;
  assert.equal(req.kind, "permission");
  assert.equal(req.tool, "Bash");
  assert.match(req.id, /^rq-/);
  const [a, b] = await Promise.all([c1.call("answer", { request: req.id, allow: true, by: "one" }), c2.call("answer", { request: req.id, allow: false, by: "two" })]);
  const won = [a, b].filter((r) => r.ok);
  assert.equal(won.length, 1, JSON.stringify([a, b]));
  assert.equal([a, b].find((r) => !r.ok).error.code, "already-answered");
  await until(() => x.codexFake().some((l) => l.in && l.in.result?.decision));
  await until(() => x.agent()?.state === "idle");
  const set = await c1.call("set", { ref, mode: "plan" });
  assert.equal(set.ok, false);
  assert.equal(set.error.code, "bad-payload");
});

test("host codex: park ends the app server; a message resumes the same thread", async (t) => {
  const x = setup(t);
  x.codexLaunch();
  await x.startHost();
  const c = await x.client();
  assert.equal((await c.call("start", { ref, harness: "codex" })).ok, true);
  await c.call("say", { ref, text: "first" });
  await until(() => x.agent()?.state === "idle" && x.history().some((e) => e.ev === "item" && e.item.kind === "assistant"));
  const thread = x.codexCompat().thread;
  assert.equal((await c.call("park", { ref })).parked, true);
  await until(() => x.agent()?.state === "parked");
  assert.equal(x.codexCompat().thread, thread, "the seam stays while parked");
  const woke = await c.call("say", { ref, text: "second" });
  assert.equal(woke.how, "resumed");
  await until(() => x.history().filter((e) => e.ev === "item" && e.item.kind === "assistant").length === 2);
  assert.ok(x.codexFake().some((l) => l.in?.method === "thread/resume" && l.in.params.threadId === thread), "resumed its own thread");
  const sessions = x.history().filter((e) => e.ev === "session").map((e) => e.how);
  assert.deepEqual(sessions, ["new", "resume"]);
});
