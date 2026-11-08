// Done when: a Codex worker runs in the chat view (here on test/fixtures/fake-codex.mjs): it journals its thread's
// items as the chat's items (the owner's and rollcall's words, reasoning, commands with their output, edits with a
// patch, the plan as todos, replies, turn ends with time and tokens), `api conversation` reads them and follows text
// as it streams, its control socket takes words (sent, or queued into a running turn), an approval opens a prompt
// that `prompt.answer` settles (`always` for the session), `worker.set` changes the model for the next turn (its mode
// is refused), `task.switch` starts and stops Codex's own screen at a quiet point, an interrupt stops a turn, a
// resumed worker with no journal writes it from the thread's saved history, and SIGTERM removes its record.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { request } from "../src/claude/send.mjs";
import { createJournalFolder, historyItems, itemOf, patchOfChanges, todosOf, turnEnd } from "../src/codex/items.mjs";
import { approvalAnswer, inputOf } from "../src/codex/worker.mjs";
import { BIN, FIXTURES, sandbox, until } from "./helpers.mjs";

const FAKE = join(FIXTURES, "fake-codex.mjs");
chmodSync(FAKE, 0o755);

const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const lines = (f) => { try { return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

function owner(sb, args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: sb.root, encoding: "utf8", env: sb.env });
  try { return { exit: r.status, ...JSON.parse(r.stdout) }; } catch { return assert.fail(`not JSON (exit ${r.status}): ${r.stdout}${r.stderr}`); }
}
const act = (sb, name, payload) => owner(sb, ["api", "do", name, JSON.stringify(payload)]);
const snap = (sb) => owner(sb, ["api", "snapshot"]);
const page = (sb, ref = "alpha:t1") => owner(sb, ["api", "conversation", ref]);

/** A sandbox with supervisor alpha and its Codex task t1 (no worktree, no worker yet). */
function codexTask(t) {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  const made = sup.cli(["task", "new", "codex job", "--repo", sb.main, "--words", "do it", "--no-worktree", "--harness", "codex"]);
  assert.equal(made.code, 0, made.stderr ?? made.out);
  return sb;
}

/** Starts `rollcall codex-worker alpha t1` on the fake, with a launch file as harness/codex.mjs writes it. */
async function startWorker(t, sb, { view = "chat", prompt = null, thread = null, session = randomUUID(), env = {} } = {}) {
  const dir = join(sb.home, "_supervisors", "alpha", "workers", "t1");
  mkdirSync(dir, { recursive: true });
  const tf = join(sb.home, "_supervisors", "alpha", "tasks", "t1.json");
  const task = readJson(tf);
  if (!task.sessions?.some((s) => s.id === session)) writeFileSync(tf, JSON.stringify({ ...task, sessions: [...(task.sessions ?? []), { id: session, at: Date.now(), harness: "codex", thread }] }));
  let promptFile = null;
  if (prompt) { promptFile = join(sb.root, `prompt-${randomUUID()}.txt`); writeFileSync(promptFile, prompt); }
  writeFileSync(join(dir, "codex-launch.json"), JSON.stringify({
    home: "alpha", task: "t1", session, thread, name: null, cwd: sb.main, prompt: promptFile, model: null, effort: null, mode: "auto",
    view, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", writableRoots: [], bin: FAKE, questions: true,
  }));
  const log = join(sb.root, `fake-${randomUUID()}.jsonl`);
  const errFile = join(sb.root, `worker-${randomUUID()}.err`);
  const fd = openSync(errFile, "w");
  const proc = spawn(process.execPath, [BIN, "codex-worker", "alpha", "t1"], { cwd: sb.main, env: { ...sb.env, ROLLCALL_CODEX_BIN: FAKE, FAKE_CODEX_LOG: log, ...env }, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  const exited = new Promise((res) => proc.on("exit", (code, signal) => res({ code, signal })));
  const stderr = () => { try { return readFileSync(errFile, "utf8").slice(-2000); } catch { return ""; } };
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) { proc.kill("SIGTERM"); await Promise.race([exited, new Promise((r) => setTimeout(r, 2000).unref())]); }
    try { proc.kill("SIGKILL"); } catch {}
  });
  const w = {
    proc, exited, session, dir, stderr,
    rec: () => readJson(join(dir, "codex.json")),
    live: () => readJson(join(dir, "stream.live.json")),
    journal: () => lines(join(dir, `codex-${session}.jsonl`)),
    launch: () => readJson(join(dir, "codex-launch.json")),
    fake: () => lines(log),
    sent: (method) => lines(log).filter((x) => x.in?.method === method).map((x) => x.in.params),
    send: (req) => request(w.rec().ctl, req),
    idle: () => until(() => w.rec()?.ctl && !w.rec()?.turn, { timeout: 10_000 }),
    ended: (n) => until(() => w.journal().filter((x) => x.kind === "turn" && x.phase === "end").length >= n, { timeout: 10_000 }),
  };
  await until(() => w.rec()?.ctl, { timeout: 8000 }).catch(() => assert.fail(`the worker did not start: ${stderr()}`));
  return w;
}

// ---------------------------------------------------------------- the items

test("itemOf maps Codex's thread items onto the chat's items", () => {
  const cwd = "/repo";
  const u = itemOf({ type: "userMessage", id: "u1", clientId: "rollcall-d-abc", content: [{ type: "text", text: "hi" }, { type: "localImage", path: "/a.png" }] });
  assert.deepEqual([u.id, u.kind, u.text, u.images, u.from], ["rollcall-d-abc", "user", "hi", ["/a.png"], "owner"], "a delivery is the owner's words, under its client id");
  assert.equal(itemOf({ type: "userMessage", id: "u2", clientId: "rollcall-l-abc", content: [{ type: "text", text: "the brief" }] }).from, "rollcall");
  assert.equal(itemOf({ type: "userMessage", id: "u3", clientId: null, content: [{ type: "text", text: "typed" }] }).id, "u3");
  const c = itemOf({ type: "commandExecution", id: "c1", command: "npm test", cwd, status: "completed", exitCode: 1, aggregatedOutput: "1 failed" }, { cwd });
  assert.deepEqual([c.kind, c.tool, c.summary, c.state, c.result.text], ["tool", "Bash", "npm test", "error", "1 failed"]);
  assert.equal(itemOf({ type: "commandExecution", id: "c2", command: "ls", status: "inProgress" }).result, null, "a running command has no result yet");
  assert.equal(itemOf({ type: "commandExecution", id: "c3", command: "rm x", status: "declined" }).state, "denied");
  const e = itemOf({ type: "fileChange", id: "f1", status: "completed", changes: [{ path: "/repo/src/a.js", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b" }, { path: "/repo/new.txt", kind: { type: "add" }, diff: "hello\n" }] }, { cwd });
  assert.equal(e.summary, "Edit src/a.js and 1 more");
  assert.match(e.patch, /^--- a\/src\/a.js\n\+\+\+ b\/src\/a.js\n@@ -1 \+1 @@/);
  assert.match(e.patch, /--- \/dev\/null\n\+\+\+ b\/new.txt\n@@ -0,0 \+1,1 @@\n\+hello/);
  const m = itemOf({ type: "mcpToolCall", id: "m1", server: "gh", tool: "pr_view", arguments: { n: 3 }, status: "completed", result: { content: [{ type: "text", text: "PR 3" }] } });
  assert.deepEqual([m.tool, m.result.text], ["mcp__gh__pr_view", "PR 3"]);
  assert.equal(itemOf({ type: "reasoning", id: "r1", summary: [], content: [] }), null, "an empty reasoning block shows nothing");
  assert.equal(itemOf({ type: "reasoning", id: "r2", summary: ["One", "Two"] }).text, "One\n\nTwo");
  assert.equal(itemOf({ type: "agentMessage", id: "a1", text: "Done." }).kind, "assistant");
  assert.equal(itemOf({ type: "collabAgentToolCall", id: "s1", tool: "spawnAgent", prompt: "look", status: "inProgress", receiverThreadIds: [], senderThreadId: "x", agentsStates: {} }).kind, "subagent");
  assert.equal(itemOf({ type: "contextCompaction", id: "k1" }).kind, "compaction");
  assert.equal(itemOf({ type: "somethingNew", id: "z" }), null, "an item type the chat does not know is left out");
  assert.deepEqual(todosOf("tu", [{ step: "a", status: "inProgress" }, { step: "b", status: "pending" }]).todos.map((x) => x.status), ["in_progress", "pending"]);
  assert.equal(turnEnd({ id: "tu", status: "interrupted" }, { at: 10, startedAt: 4 }).error, "Stopped");
  assert.deepEqual([turnEnd({ id: "tu", status: "failed", error: { message: "boom" }, durationMs: 7 }).ms, turnEnd({ id: "tu", status: "failed", error: { message: "boom" } }).error], [7, "boom"]);
  assert.equal(patchOfChanges([]), null);
});

test("history items carry their turn's id, and a journal folder replaces by id and remembers skipped ids", () => {
  const h = historyItems([{ id: "tu1", status: "completed", startedAt: 100, completedAt: 101, durationMs: 900, items: [{ type: "userMessage", id: "item-1", content: [{ type: "text", text: "hi" }] }, { type: "agentMessage", id: "item-2", text: "hello" }] }, { id: "tu2", status: "inProgress", startedAt: 102, items: [] }]);
  assert.deepEqual(h.map((x) => x.id), ["turn-start:tu1", "tu1:item-1", "tu1:item-2", "turn-end:tu1", "turn-start:tu2"], "a running turn has no end yet");
  assert.equal(h[3].ms, 900);
  const f = createJournalFolder({ session: "s" });
  f.add({ id: "c1", at: 1, kind: "tool", state: "running" });
  f.add({ id: "a1", at: 2, kind: "assistant", text: "x" });
  f.add({ id: "c1", at: 1, kind: "tool", state: "done" });
  f.add({ id: "r1", skip: true });
  assert.deepEqual(f.items.map((x) => [x.id, x.state ?? null]), [["c1", "done"], ["a1", null]]);
  assert.ok(f.has("r1") && !f.items.some((x) => x.id === "r1"));
  assert.deepEqual(f.takeDirty().map((x) => x.id), ["c1", "a1"]);
  assert.deepEqual(f.takeDirty(), []);
});

test("approvals: always is the session's acceptance where Codex has one; a message's images go in as images", () => {
  assert.deepEqual(approvalAnswer("item/commandExecution/requestApproval", {}, true, null, true), { decision: "acceptForSession" });
  assert.deepEqual(approvalAnswer("item/fileChange/requestApproval", {}, false, "no", true), { decision: "decline" });
  assert.deepEqual(approvalAnswer("item/permissions/requestApproval", { permissions: { network: {} } }, true, null, true), { permissions: { network: {} }, scope: "session" });
  const input = inputOf("look", [join(FIXTURES, "fake-codex.mjs"), "/nope/a.png"]);
  assert.equal(input[0].text, `look\n\n[Attached: ${join(FIXTURES, "fake-codex.mjs")}, /nope/a.png]`);
  assert.equal(input.length, 1, "only images that exist go in as images");
});

// ---------------------------------------------------------------- the worker

test("a Codex worker in the chat view journals its thread; api conversation reads it, follows streamed text, and the snapshot shows the view", async (t) => {
  const sb = codexTask(t);
  const w = await startWorker(t, sb, { prompt: "the brief THINK TOOL EDIT PLAN TOKENS=300" });
  await w.ended(1);
  assert.equal(w.rec().view, "chat");
  assert.equal(w.fake().some((x) => x.ui), false, "no Codex screen runs in the chat view");

  const p = page(sb);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.deepEqual([p.harness, p.view, p.session, p.prompt], ["codex", "chat", w.session, null]);
  const kinds = p.items.map((x) => x.kind);
  assert.deepEqual(kinds, ["turn", "user", "todos", "thinking", "tool", "tool", "assistant", "turn"]);
  const [start, user, todos, thinking, ls, edit, reply, end] = p.items;
  assert.equal(start.phase, "start");
  assert.deepEqual([user.from, user.text], ["rollcall", "the brief THINK TOOL EDIT PLAN TOKENS=300"]);
  assert.equal(w.journal().filter((x) => x.id === user.id).length, 1, "a message heard as it started and as it completed is one line");
  assert.equal(todos.todos.length, 3);
  assert.equal(thinking.text, "Looking at it");
  assert.deepEqual([ls.tool, ls.summary, ls.state, ls.result.text], ["Bash", "ls", "done", "a.txt\n"]);
  assert.deepEqual([edit.tool, edit.summary], ["Edit", "Edit src/a.js"]);
  assert.match(edit.patch, /\+src\/a.js changed/);
  assert.equal(reply.text, "done: the brief THINK TOOL EDIT PLAN TOKENS=300");
  assert.equal(end.phase, "end");
  assert.equal(end.tokens.context, 300);
  const worker = () => snap(sb).tasks.find((x) => x.ref === "alpha:t1").worker;
  assert.deepEqual([worker().view, worker().switching, worker().prompt], ["chat", null, null]);

  // A follow sees the words arrive, the reply stream in pieces, then the finished reply.
  const follow = spawn(process.execPath, [BIN, "api", "conversation", "alpha:t1", "--follow"], { cwd: sb.root, env: { ...sb.env, ROLLCALL_CONVERSATION_BEAT_MS: "50" } });
  t.after(() => follow.kill("SIGTERM"));
  const got = [];
  let buf = "";
  follow.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  await until(() => got.some((x) => x.type === "page"));
  const r = await w.send({ op: "say", text: "STREAM it please" });
  assert.equal(r.how, "sent");
  await until(() => got.some((x) => x.type === "item" && x.item.kind === "assistant" && !x.item.streaming && x.item.text === "done: STREAM it please"), { timeout: 10_000 });
  const user2 = got.find((x) => x.type === "item" && x.item.kind === "user" && x.item.text === "STREAM it please");
  assert.ok(user2, "the words");
  assert.equal(user2.item.id, r.uuid, "under the id the chat showed them with while they waited");
  assert.ok(got.some((x) => x.type === "text" && x.id === "a-tu-2"), "streamed text came as appends");
  assert.equal(got.some((x) => x.type === "reset"), false, "nothing started over");
});

test("words, prompts, model and the switch through the api drive a Codex chat worker", async (t) => {
  const sb = codexTask(t);
  const w = await startWorker(t, sb);
  const worker = () => snap(sb).tasks.find((x) => x.ref === "alpha:t1").worker;

  // Words while a turn runs are queued into it: the live file shows them until Codex takes them.
  assert.equal((await w.send({ op: "say", text: "SLOW one" })).how, "sent");
  await until(() => w.rec().turn);
  const q = await w.send({ op: "say", text: "and this" });
  assert.equal(q.how, "queued");
  assert.ok(w.sent("turn/steer").some((x) => x.clientUserMessageId === q.uuid));
  await w.ended(1);

  // An approval opens a prompt on the record; the answer goes back as Codex's, and the prompt closes.
  await w.send({ op: "say", text: "HOLD now" });
  const p = await until(() => worker()?.prompt);
  assert.deepEqual([p.kind, p.tool, p.summary, p.reason], ["permission", "Bash", "rm -rf build", "clean the build"]);
  assert.equal(act(sb, "prompt.answer", { task: "alpha:t1", prompt: "nope", allow: true }).error.code, "not-found");
  const a = act(sb, "prompt.answer", { task: "alpha:t1", prompt: p.id, allow: true, always: true });
  assert.equal(a.result.answered, true, JSON.stringify(a));
  assert.equal(a.result.view.worker.prompt, null);
  await until(() => w.fake().some((x) => x.in?.result?.decision === "acceptForSession"));
  assert.equal(act(sb, "prompt.answer", { task: "alpha:t1", prompt: p.id, allow: true }).result.already, true);
  await w.ended(2);
  assert.equal(existsSync(join(w.dir, "dialog")), false, "the dialog flag is down");

  // The model is set for the next turn; the mode stays the launch's.
  const s = act(sb, "worker.set", { task: "alpha:t1", model: "gpt-5.6-terra" });
  assert.deepEqual(s.result.set, { model: "gpt-5.6-terra" });
  assert.equal(w.launch().model, "gpt-5.6-terra");
  assert.equal(act(sb, "worker.set", { task: "alpha:t1", mode: "plan" }).error.code, "bad-payload");
  assert.equal(act(sb, "worker.set", { task: "alpha:t1", model: "opus" }).error.code, "bad-payload");
  await w.send({ op: "say", text: "next" });
  await w.ended(3);
  assert.equal(w.sent("turn/start").at(-1).model, "gpt-5.6-terra");

  // An interrupt stops the running turn, which ends as stopped.
  await w.send({ op: "say", text: "SLOW again" });
  await until(() => w.rec().turn);
  assert.deepEqual(await w.send({ op: "interrupt" }), { ok: true, interrupted: true });
  await w.ended(4);
  assert.equal(w.journal().findLast((x) => x.phase === "end").error, "Stopped");

  // A switch while a turn runs waits for its end; then Codex's own screen runs, and back.
  await w.send({ op: "say", text: "SLOW three" });
  await until(() => w.rec().turn);
  const sw = act(sb, "task.switch", { task: "alpha:t1", to: "terminal" });
  assert.equal(sw.result.pending, true, JSON.stringify(sw));
  assert.equal(worker().switching.to, "terminal");
  await until(() => w.rec().view === "terminal", { timeout: 8000 });
  await until(() => w.fake().some((x) => x.ui?.includes("--remote") && x.ui.includes("th-1")));
  assert.equal(w.launch().view, "terminal", "a resume keeps the view");
  assert.equal(act(sb, "prompt.answer", { task: "alpha:t1", prompt: "x", allow: true }).error.code, "refused");
  // The thread goes on in the terminal view: words still reach it, and the journal still records them.
  await w.send({ op: "say", text: "in the terminal" });
  await w.ended(6);
  const back = act(sb, "task.switch", { task: "alpha:t1", to: "chat" });
  assert.equal(back.result.switched, true, JSON.stringify(back));
  await until(() => w.rec().view === "chat");
  assert.equal(page(sb).items.filter((x) => x.kind === "user").at(-1).text, "in the terminal");
});

test("a resumed Codex worker with no journal writes it from the thread's saved history, then carries on", async (t) => {
  const sb = codexTask(t);
  const history = join(sb.root, "history.json");
  writeFileSync(history, JSON.stringify([{ id: "tu-old", status: "completed", startedAt: 1_700_000_000, completedAt: 1_700_000_005, durationMs: 5000, items: [
    { type: "userMessage", id: "item-1", clientId: null, content: [{ type: "text", text: "what was asked" }] },
    { type: "commandExecution", id: "item-2", command: "ls", cwd: "/", status: "completed", exitCode: 0, aggregatedOutput: "x" },
    { type: "agentMessage", id: "item-3", text: "what was said" },
  ] }]));
  const w = await startWorker(t, sb, { thread: "th-old", env: { FAKE_CODEX_HISTORY: history } });
  assert.deepEqual(w.journal().map((x) => x.id), ["turn-start:tu-old", "tu-old:item-1", "tu-old:item-2", "tu-old:item-3", "turn-end:tu-old"]);
  await w.send({ op: "say", text: "more" });
  await w.ended(2);
  const p = page(sb);
  assert.deepEqual(p.items.filter((x) => x.kind === "user").map((x) => [x.text, x.from]), [["what was asked", "owner"], ["more", "owner"]]);

  // SIGTERM ends it: its record and live file go.
  w.proc.kill("SIGTERM");
  await w.exited;
  assert.equal(existsSync(join(w.dir, "codex.json")), false);
  assert.equal(existsSync(join(w.dir, "stream.live.json")), false);
  assert.equal(page(sb).view, "terminal", "with no worker the read shows the terminal view, and still the conversation");
  assert.equal(page(sb).items.length, 9);
});
