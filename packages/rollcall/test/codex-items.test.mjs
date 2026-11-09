// Done when: a hosted Codex agent's thread items map onto the chat's items (codex/items.mjs: replies, reasoning,
// commands with their output, edits with a patch, the plan as todos, turn ends), history items carry their turn's id,
// a journal folder replaces by id, and the protocol pieces codex/session.mjs answers with (approvals for the session,
// images as images) have the shapes Codex takes.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createJournalFolder, historyItems, itemOf, patchOfChanges, todosOf, turnEnd } from "../src/codex/items.mjs";
import { approvalAnswer, inputOf } from "../src/codex/session.mjs";
import { FIXTURES } from "./helpers.mjs";

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

