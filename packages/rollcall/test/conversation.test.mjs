// Done when: a Claude Code transcript folds into the chat contract's items (ids stable, tool results filling their
// call, subagents, todos, compaction, turns with their time), the huge lines it skips by their first bytes never
// matter, and a page pages back by its cursor. The agent host folds its stream and backfills a task's history
// with this reader (host/history.mjs).
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFolder, foldTranscript, matchTurns, patchOf, readPage, summaryOf } from "../src/conversation.mjs";

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

test("turns.jsonl lines match the nearest turn end within 30 s, each once", () => {
  const m = matchTurns([{ id: "e1", at: T0 }, { id: "e2", at: T0 + 60_000 }], [{ at: T0 + 61_000, ms: 5, tokens: { input: 1, output: 2, context: 3 } }]);
  assert.deepEqual([...m.keys()], ["e2"]);
});

test("a page is the last items; its cursor reads the page before it; turns.jsonl gives a turn end its time and tokens", () => {
  const { dir, target } = fixture(5);
  writeFileSync(join(dir, "turns.jsonl"), `${JSON.stringify({ at: T0 + 42_000, ms: 1500, tokens: { input: 10, output: 20, context: 30 }, error: null, session: S })}\n`);
  const p = readPage(target, { limit: 6 });
  assert.equal(p.ok, true);
  assert.equal(p.items.length, 6);
  assert.equal(p.items.at(-1).id, "turn-end:s4");
  assert.deepEqual(p.items.at(-1).tokens, { input: 10, output: 20, context: 30 });
  assert.equal(p.items.at(-1).ms, 1500);
  assert.equal(p.more, true);
  assert.equal(p.cursor, p.items[0].id);
  assert.equal(p.session, S);
  const older = readPage(target, { limit: 6, before: p.cursor });
  assert.equal(older.items.at(-1).id, "u3");
  const first = readPage(target, { limit: 100, before: older.cursor });
  assert.equal(first.more, false);
  assert.equal(first.cursor, null);
  assert.equal(first.items[0].id, "turn-start:u0");
  assert.equal(readPage(target, { before: "nope" }).error.code, "not-found");
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

test("a queued_command attachment is read whichever key comes first on its line", () => {
  const a = { uuid: "a1", timestamp: new Date(T0).toISOString(), attachment: { type: "queued_command", prompt: "hello", source_uuid: "q1" } };
  const lines = [{ type: "attachment", ...a }, { parentUuid: null, type: "attachment", ...a, uuid: "a2", attachment: { ...a.attachment, source_uuid: "q2", prompt: "again" } }];
  assert.deepEqual(foldTranscript(lines.map((x) => JSON.stringify(x)).join("\n")).map((x) => x.id), ["q1", "q2"]);
});
