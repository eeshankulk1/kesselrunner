// Done when: a Claude Code transcript folds into the chat contract's items (ids stable, tool results filling their
// call, subagents, todos, compaction, turns with their time), the huge lines it skips by their first bytes never
// matter, the stream-mode worker's live file shows text still streaming and messages sent while busy, a page
// pages back by its cursor, `api conversation` resolves a task and the Falcon, and a follow prints the page, then
// each new item, appended text, prompt and view, and starts over when the transcript is replaced.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createFolder, follow, foldTranscript, matchTurns, overlayItems, patchOf, readPage, summaryOf } from "../src/conversation.mjs";
import { BIN, cleanEnv } from "./helpers.mjs";

const S = "11111111-2222-3333-4444-555555555555";
const T0 = Date.parse("2026-11-08T10:00:00.000Z");
const ts = (s) => new Date(T0 + s * 1000).toISOString();
const base = (uuid, s) => ({ parentUuid: null, isSidechain: false, uuid, timestamp: ts(s), sessionId: S, cwd: "/w" });
const user = (uuid, s, content, extra = {}) => ({ ...base(uuid, s), type: "user", message: { role: "user", content }, ...extra });
const asst = (uuid, s, mid, block, extra = {}) => ({ ...base(uuid, s), type: "assistant", message: { id: mid, role: "assistant", content: [block] }, ...extra });
const result = (uuid, s, id, content, extra = {}, isError = false) => user(uuid, s, [{ tool_use_id: id, type: "tool_result", content, is_error: isError }], extra);
const sys = (uuid, s, subtype, extra = {}) => ({ ...base(uuid, s), type: "system", subtype, ...extra });
const att = (uuid, s, attachment) => ({ ...base(uuid, s), type: "attachment", attachment });

/** One turn of everything the fold reads, plus lines it must skip. */
const TURN = [
  { type: "session-owner", sessionId: S },
  { type: "api-request", sessionId: S, params: { huge: "x".repeat(5000) } },
  att("a0", 0, { type: "hook_success", content: "context for the model" }),
  user("m0", 0, "<system-reminder>not the owner's</system-reminder>", { isMeta: true }),
  user("u1", 1, "Fix the bug"),
  asst("a1", 2, "msg_1", { type: "thinking", thinking: "Let me look." }),
  asst("a2", 3, "msg_1", { type: "text", text: "Looking." }),
  asst("a3", 4, "msg_1", { type: "tool_use", id: "tu_bash", name: "Bash", input: { command: "ls -la\necho two", description: "List" } }),
  result("r1", 5, "tu_bash", "a.js\nb.js", { toolUseResult: { stdout: "a.js\nb.js", stderr: "" } }),
  att("q1", 5, { type: "queued_command", prompt: "also check c.js", source_uuid: "src-q1" }),
  asst("a4", 6, "msg_2", { type: "tool_use", id: "tu_edit", name: "Edit", input: { file_path: "/w/src/a.js", old_string: "x", new_string: "y" } }),
  result("r2", 7, "tu_edit", "ok", { toolUseResult: { structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-x", "+y"] }] } }),
  asst("a5", 8, "msg_3", { type: "tool_use", id: "tu_agent", name: "Agent", input: { description: "Review it", subagent_type: "code-reviewer", prompt: "..." } }),
  result("r3", 9, "tu_agent", [{ type: "text", text: "Looks fine." }], { toolUseResult: { agentId: "abc" } }),
  asst("a6", 10, "msg_4", { type: "tool_use", id: "tu_todo", name: "TodoWrite", input: { todos: [{ content: "Fix", status: "in_progress", activeForm: "Fixing" }] } }),
  result("r4", 10, "tu_todo", "ok"),
  asst("a7", 11, "msg_5", { type: "tool_use", id: "tu_rm", name: "Bash", input: { command: "rm -rf /" } }),
  result("r5", 11, "tu_rm", "The user doesn't want to proceed with this tool use. The tool use was rejected", {}, true),
  asst("a8", 12, "msg_6", { type: "text", text: "Done." }),
  sys("s1", 13, "stop_hook_summary"),
  sys("s2", 13, "turn_duration", { durationMs: 12345 }),
];

test("a transcript folds into the contract's items, in order, skipping what is not the conversation", () => {
  const items = foldTranscript(TURN.map((o) => JSON.stringify(o)).join("\n"));
  assert.deepEqual(items.map((x) => x.id), ["turn-start:u1", "u1", "msg_1:0", "msg_1:1", "tu_bash", "src-q1", "tu_edit", "tu_agent", "tu_todo", "tu_rm", "msg_6:0", "turn-end:s1"]);
  const by = Object.fromEntries(items.map((x) => [x.id, x]));
  assert.deepEqual(by.u1, { id: "u1", at: T0 + 1000, kind: "user", text: "Fix the bug", images: [], from: "owner", queued: false });
  assert.equal(by["msg_1:0"].kind, "thinking");
  assert.equal(by["msg_1:1"].text, "Looking.");
  assert.equal(by.tu_bash.summary, "ls -la …");
  assert.equal(by.tu_bash.state, "done");
  assert.deepEqual(by.tu_bash.result, { text: "a.js\nb.js", truncated: false, size: 9 });
  assert.equal(by["src-q1"].text, "also check c.js");
  assert.equal(by.tu_edit.summary, "Edit src/a.js");
  assert.equal(by.tu_edit.patch, "--- a/src/a.js\n+++ b/src/a.js\n@@ -3,1 +3,1 @@\n-x\n+y");
  assert.deepEqual({ ...by.tu_agent, result: by.tu_agent.result.text }, { id: "tu_agent", at: T0 + 8000, kind: "subagent", agent: "code-reviewer", description: "Review it", state: "done", result: "Looks fine.", children: 0 });
  assert.deepEqual(by.tu_todo.todos, [{ content: "Fix", status: "in_progress", activeForm: "Fixing" }]);
  assert.equal(by.tu_rm.state, "denied");
  assert.deepEqual(by["turn-end:s1"], { id: "turn-end:s1", at: T0 + 13000, kind: "turn", phase: "end", ms: 12345 });
});

test("a tool runs until its result arrives; an error, rollcall's words, commands, compaction and API errors", () => {
  const f = createFolder();
  f.add(user("u1", 0, "[rollcall] The supervisor left you a message"));
  f.add(asst("a1", 1, "m1", { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/x.md", content: "y".repeat(3000) } }));
  assert.equal(f.get("t1").state, "running");
  assert.equal(f.get("t1").result, null);
  assert.equal(f.get("t1").input.content.length, 2000);
  assert.equal(f.get("t1").summary, "Read x.md");
  assert.deepEqual(f.takeDirty().map((x) => x.id), ["turn-start:u1", "u1", "t1"]);
  f.add(result("r1", 2, "t1", "Exit code 1\nboom", {}, true));
  assert.equal(f.get("t1").state, "error");
  assert.deepEqual(f.takeDirty().map((x) => x.id), ["t1"]);
  f.add(asst("a2", 3, "m2", { type: "text", text: "API Error: Connection lost" }, { isApiErrorMessage: true }));
  f.add(sys("s1", 4, "stop_hook_summary"));
  f.add(user("c1", 5, "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>"));
  f.add(sys("cb", 6, "compact_boundary", { compactMetadata: { trigger: "manual", preTokens: 500000 } }));
  f.add(user("cs", 6, "This session is being continued...", { isCompactSummary: true }));
  f.add(user("lo", 7, "<local-command-stdout>Compacted</local-command-stdout>"));
  const by = Object.fromEntries(f.items.map((x) => [x.id, x]));
  assert.equal(by.u1.from, "rollcall");
  assert.equal(by.a2.text, "API Error: Connection lost");
  assert.equal(by["turn-end:s1"].error, "API Error: Connection lost");
  assert.equal(by.c1.text, "/compact");
  assert.deepEqual(by["compact:cb"], { id: "compact:cb", at: T0 + 6000, kind: "compaction", trigger: "manual", tokens: 500000 });
  assert.equal(by.cs, undefined);
  assert.equal(by.lo.text, "Compacted");
});

test("summaries and patches", () => {
  assert.equal(summaryOf("Grep", { pattern: "foo|bar" }), "foo|bar");
  assert.equal(summaryOf("WebFetch", { url: "https://x.dev" }), "https://x.dev");
  assert.equal(summaryOf("mcp__x__y", { query: "q" }), "mcp__x__y q");
  assert.equal(summaryOf("Write", { file_path: "/w/a/b.ts" }, "/w"), "Edit a/b.ts");
  assert.equal(patchOf("Write", { file_path: "/w/n.txt", content: "a\nb" }, null, "/w"), "--- a/n.txt\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b");
  assert.equal(patchOf("Bash", { command: "x" }), null);
});

test("the live file shows streaming text and queued messages until the transcript has them; turns.jsonl gives a turn's tokens", () => {
  const f = createFolder();
  for (const o of TURN.slice(0, 8)) f.add(o);
  const live = { session: S, at: T0, items: [{ id: "msg_1:1", kind: "assistant", text: "Looki" }, { id: "msg_9:0", kind: "assistant", text: "Hel" }], queued: [{ uuid: "src-q1", text: "q", at: T0 }, { uuid: "u-new", text: "next", at: T0, from: "app" }] };
  assert.deepEqual(overlayItems(f, live).map((x) => x.id), ["msg_9:0", "src-q1", "u-new"]);
  assert.deepEqual(overlayItems(f, live)[0], { id: "msg_9:0", at: T0, kind: "assistant", text: "Hel", streaming: true });
  assert.equal(overlayItems(f, live)[2].from, "app");
  assert.equal(overlayItems(f, { ...live, session: "other" }).length, 0);
  const m = matchTurns([{ id: "e1", at: T0 }, { id: "e2", at: T0 + 60_000 }], [{ at: T0 + 61_000, ms: 5, tokens: { input: 1, output: 2, context: 3 } }]);
  assert.deepEqual([...m.keys()], ["e2"]);
});

/** A folder with a transcript of `n` turns, a worker dir, and the target for it. */
function fixture(n = 0) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rollcall-conv-")));
  const dir = join(root, "worker");
  mkdirSync(dir, { recursive: true });
  const transcript = join(root, `${S}.jsonl`);
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(user(`u${i}`, i * 10, `prompt ${i}`), asst(`a${i}`, i * 10 + 1, `msg_${i}`, { type: "text", text: `reply ${i}` }), sys(`s${i}`, i * 10 + 2, "stop_hook_summary"));
  writeFileSync(transcript, lines.map((o) => `${JSON.stringify(o)}\n`).join(""));
  return { root, dir, transcript, target: { ok: true, ref: "alpha:t1", harness: "claude", dir, session: S, cwd: "/w", transcript } };
}

test("a page is the last items; its cursor reads the page before it; the record gives view and prompt", () => {
  const { dir, target } = fixture(5);
  writeFileSync(join(dir, "claude.json"), JSON.stringify({ pid: process.pid, session: S, view: "chat", prompt: { id: "p1", kind: "permission" } }));
  writeFileSync(join(dir, "turns.jsonl"), `${JSON.stringify({ at: T0 + 42_000, ms: 1500, tokens: { input: 10, output: 20, context: 30 }, error: null, session: S })}\n`);
  const p = readPage(target, { limit: 6 });
  assert.equal(p.ok, true);
  assert.equal(p.items.length, 6);
  assert.equal(p.items.at(-1).id, "turn-end:s4");
  assert.deepEqual(p.items.at(-1).tokens, { input: 10, output: 20, context: 30 });
  assert.equal(p.items.at(-1).ms, 1500);
  assert.equal(p.more, true);
  assert.equal(p.cursor, p.items[0].id);
  assert.equal(p.view, "chat");
  assert.equal(p.prompt.id, "p1");
  assert.equal(p.session, S);
  const older = readPage(target, { limit: 6, before: p.cursor });
  assert.equal(older.items.at(-1).id, "u3");
  const first = readPage(target, { limit: 100, before: older.cursor });
  assert.equal(first.more, false);
  assert.equal(first.cursor, null);
  assert.equal(first.items[0].id, "turn-start:u0");
  assert.equal(readPage(target, { before: "nope" }).error.code, "not-found");
  writeFileSync(join(dir, "claude.json"), "{}");
  assert.equal(readPage(target).view, "terminal");
});

test("a subagent's own messages come under it from its file next to the transcript", () => {
  const { root, target, transcript } = fixture(0);
  writeFileSync(transcript, [user("u1", 0, "go"), asst("a1", 1, "m1", { type: "tool_use", id: "tu_ag", name: "Task", input: { description: "Look", subagent_type: "Explore" } })].map((o) => `${JSON.stringify(o)}\n`).join(""));
  const sub = join(root, S, "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "agent-x.meta.json"), JSON.stringify({ toolUseId: "tu_ag", agentType: "Explore" }));
  writeFileSync(join(sub, "agent-x.jsonl"), [user("su", 2, "the brief", { isSidechain: true }), asst("sa", 3, "sm", { type: "tool_use", id: "tu_in", name: "Grep", input: { pattern: "x" } }, { isSidechain: true })].map((o) => `${JSON.stringify(o)}\n`).join(""));
  const p = readPage(target);
  assert.deepEqual(p.items.map((x) => [x.id, x.parent ?? null]), [["turn-start:u1", null], ["u1", null], ["tu_ag", null], ["tu_in", "tu_ag"]]);
  assert.equal(p.items[2].children, 1);
});

/** Lines a follow wrote, parsed. */
const linesOf = (buf) => buf.split("\n").filter(Boolean).map((l) => JSON.parse(l));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  assert.fail("timed out");
}

test("a follow prints the page, then new items, appended text, prompts, views, and a reset when the transcript is replaced", async () => {
  const { dir, transcript, target } = fixture(1);
  process.env.ROLLCALL_CONVERSATION_BEAT_MS = "30";
  process.env.ROLLCALL_CONVERSATION_GRACE_MS = "100";
  const out = new PassThrough();
  let text = "";
  out.on("data", (d) => { text += d; });
  const ac = new AbortController();
  const done = follow(target, out, { signal: ac.signal, signals: false });
  const seen = () => linesOf(text);
  await until(() => seen().length >= 1);
  assert.equal(seen()[0].type, "page");
  assert.equal(seen()[0].v, 1);
  assert.equal(seen()[0].items.length, 4);

  // A new prompt with an answer streaming, then the answer landing in the transcript.
  appendFileSync(transcript, `${JSON.stringify(user("u9", 50, "more"))}\n`);
  await until(() => seen().some((l) => l.item?.id === "u9"));
  assert.deepEqual(seen().slice(1).map((l) => l.item?.id), ["turn-start:u9", "u9"], "the page's items are not sent again");
  writeFileSync(join(dir, "stream.live.json"), JSON.stringify({ session: S, at: T0, items: [{ id: "msg_9:0", kind: "assistant", text: "Hel" }], queued: [] }));
  await until(() => seen().some((l) => l.item?.id === "msg_9:0" && l.item.streaming));
  writeFileSync(join(dir, "stream.live.json"), JSON.stringify({ session: S, at: T0, items: [{ id: "msg_9:0", kind: "assistant", text: "Hello" }], queued: [] }));
  await until(() => seen().some((l) => l.type === "text" && l.id === "msg_9:0" && l.append === "lo"));
  appendFileSync(transcript, `${JSON.stringify(asst("a9", 51, "msg_9", { type: "text", text: "Hello there" }))}\n`);
  await until(() => seen().some((l) => l.item?.id === "msg_9:0" && l.item.streaming === false && l.item.text === "Hello there"));

  // A partial line waits for its end.
  const tool = JSON.stringify(asst("a10", 52, "msg_10", { type: "tool_use", id: "tu_x", name: "Bash", input: { command: "make" } }));
  appendFileSync(transcript, tool.slice(0, 20));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!seen().some((l) => l.item?.id === "tu_x"));
  appendFileSync(transcript, `${tool.slice(20)}\n`);
  await until(() => seen().some((l) => l.item?.id === "tu_x" && l.item.state === "running"));
  appendFileSync(transcript, `${JSON.stringify(result("r10", 53, "tu_x", "built"))}\n`);
  await until(() => seen().some((l) => l.item?.id === "tu_x" && l.item.state === "done"));

  // The record: a prompt opens, the view changes.
  writeFileSync(join(dir, "claude.json"), JSON.stringify({ pid: process.pid, session: S, view: "chat", switching: null, prompt: { id: "p1", kind: "permission" } }));
  await until(() => seen().some((l) => l.type === "prompt" && l.prompt?.id === "p1"));
  assert.ok(seen().some((l) => l.type === "view" && l.view === "chat"));

  // The transcript replaced (shorter): reset, then a fresh page.
  writeFileSync(transcript, `${JSON.stringify(user("u0", 0, "prompt 0"))}\n`);
  await until(() => seen().some((l) => l.type === "reset"));
  await until(() => seen().filter((l) => l.type === "page").length === 2);
  const seqs = seen().map((l) => l.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
  ac.abort();
  await done;
});

test("api conversation resolves a task's worker session and the Falcon's own; a Codex task reads its worker's journal", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rollcall-conv-cli-")));
  const home = join(root, "home");
  const config = join(root, "claude");
  const env = cleanEnv({ ROLLCALL_HOME: home, CLAUDE_CONFIG_DIR: config, ROLLCALL_WATCHER: "0", ROLLCALL_GC: "0" });
  const tasks = join(home, "_supervisors", "alpha", "tasks");
  mkdirSync(tasks, { recursive: true });
  writeFileSync(join(tasks, "t1.json"), JSON.stringify({ id: "t1", home: "alpha", title: "x", worktree: "/w/x", sessions: [{ id: S, at: T0, endedAt: null }] }));
  writeFileSync(join(tasks, "t2.json"), JSON.stringify({ id: "t2", home: "alpha", title: "y", harness: "codex", sessions: [{ id: "th", harness: "codex", at: T0 }] }));
  const proj = join(config, "projects", "-w-x");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${S}.jsonl`), TURN.map((o) => `${JSON.stringify(o)}\n`).join(""));
  const sup = "99999999-2222-3333-4444-555555555555";
  writeFileSync(join(home, "_supervisors", "alpha", "falcon.json"), JSON.stringify({ session: sup, cwd: "/w/x" }));
  writeFileSync(join(proj, `${sup}.jsonl`), `${JSON.stringify({ ...user("fu", 0, "/supervisor alpha"), sessionId: sup })}\n`);
  const run = (...args) => { const r = spawnSync(process.execPath, [BIN, "api", ...args], { encoding: "utf8", env }); return { code: r.status, out: JSON.parse(r.stdout) }; };

  const p = run("conversation", "alpha:yoda", "--limit", "3");
  assert.equal(p.code, 0, JSON.stringify(p.out));
  assert.equal(p.out.ref, "alpha:t1");
  assert.equal(p.out.session, S);
  assert.equal(p.out.items.length, 3);
  assert.equal(p.out.view, "terminal");
  assert.equal(p.out.more, true);
  const f = run("conversation", "alpha");
  assert.equal(f.out.items.at(-1).text, "/supervisor alpha");
  // A Codex task: its worker's journal (codex/items.mjs), an empty page while it has none.
  assert.deepEqual([run("conversation", "alpha:t2").out.harness, run("conversation", "alpha:t2").out.items], ["codex", []]);
  const workers = join(home, "_supervisors", "alpha", "workers", "t2");
  mkdirSync(workers, { recursive: true });
  writeFileSync(join(workers, "codex-th.jsonl"), `${JSON.stringify({ id: "u1", at: T0, kind: "user", text: "hi", images: [], from: "owner", queued: false })}\n`);
  assert.deepEqual(run("conversation", "alpha:t2").out.items.map((x) => x.text), ["hi"]);
  assert.equal(run("conversation", "alpha:t9").out.error.code, "not-found");
  assert.ok(run("version").out.verbs.includes("conversation"));
});

test("a queued_command attachment is read whichever key comes first on its line", () => {
  const a = { uuid: "a1", timestamp: new Date(T0).toISOString(), attachment: { type: "queued_command", prompt: "hello", source_uuid: "q1" } };
  const lines = [{ type: "attachment", ...a }, { parentUuid: null, type: "attachment", ...a, uuid: "a2", attachment: { ...a.attachment, source_uuid: "q2", prompt: "again" } }];
  assert.deepEqual(foldTranscript(lines.map((x) => JSON.stringify(x)).join("\n")).map((x) => x.id), ["q1", "q2"]);
});
