// Done when: away mode holds instead of waiting. While it is on, a task worker's permission request is refused with a
// note and saved to the held list (once per request, one notification each), its question goes to the task with the
// "carry on, then stop" note, and the 10-minute reminders stop; the owner's answer reaches the worker, and an approval
// lets the next matching request through once. The switch and the answers are the CLI's (`rollcall away on|off|status`,
// `away allow|deny <id>`, `away allow-all`), kept in the machine records away.json, held.json and grants.json.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { approvalAnswer, decisionIn } from "../src/codex/worker.mjs";
import { grantable, matchKey, summaryOf, trimInput } from "../src/away.mjs";
import { BIN, sandbox } from "./helpers.mjs";

const WORKER = { env: { ROLLCALL_TASK: "alpha:t1" } };

function owner(sb, args, { env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: sb.root, encoding: "utf8", env: { ...sb.env, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const record = (sb, id = "t1") => JSON.parse(readFileSync(join(sb.home, "_supervisors", "alpha", "tasks", `${id}.json`), "utf8"));
const machine = (sb, name) => { try { return JSON.parse(readFileSync(join(sb.home, "_machine", `${name}.json`), "utf8")); } catch { return null; } };
const held = (sb) => machine(sb, "held") ?? [];
/** What rollcall told the owner: the lines of the notify log, { title, text } each. */
const notices = (sb) => { try { return readFileSync(join(sb.root, "notify.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } };
const heldNotices = (sb) => notices(sb).filter((n) => / held a request \(alpha\)$/.test(n.title));
const questionNotices = (sb) => notices(sb).filter((n) => / needs you \(alpha\)$/.test(n.title));

/** Supervisor alpha with tasks t1 and t2 (no worktrees, no workers); notifications go to a log, not the screen. */
function setup(t) {
  const sb = sandbox(t);
  sb.env.ROLLCALL_NOTIFY_LOG = join(sb.root, "notify.log");
  const sup = sb.session(sb.root);
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  for (const title of ["header polish", "footer polish"]) assert.equal(sup.cli(["task", "new", title, "--repo", sb.main, "--words", `do the ${title}`, "--no-worktree"]).code, 0);
  return { sb, sup };
}

/** Task `id`'s worker hook for a permission request (Claude Code's PermissionRequest, wired to `worker-hook dialog`). */
function permission(sb, input, { id = "t1", tool = "Bash" } = {}) {
  const r = spawnSync(process.execPath, [BIN, "worker-hook", "alpha", id, "dialog"], {
    input: JSON.stringify({ session_id: "s1", transcript_path: join(sb.root, "s1.jsonl"), hook_event_name: "PermissionRequest", tool_name: tool, tool_input: input }),
    env: sb.env, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
}
const flagUp = (sb, id = "t1") => spawnSync("test", ["-e", join(sb.home, "_supervisors/alpha/workers", id, "dialog")]).status === 0;
const clearFlag = (sb, id = "t1") => spawnSync("rm", ["-f", join(sb.home, "_supervisors/alpha/workers", id, "dialog")]);

test("held items: what a person reads, what a grant matches, and an input kept to a sane size", () => {
  const t = { worktree: "/w/t1" };
  assert.equal(summaryOf(t, "Bash", { command: "npm   publish\n--tag next", description: "publish it" }), "npm publish --tag next");
  assert.equal(summaryOf(t, "Edit", { file_path: "/w/t1/src/a.ts", old_string: "a", new_string: "b" }), "Edit src/a.ts");
  assert.equal(summaryOf(t, "WebFetch", { url: "https://example.com", prompt: "read" }), "WebFetch https://example.com");
  assert.equal(summaryOf(t, "mcp__x__y", {}), "mcp__x__y");
  assert.equal(matchKey("Bash", { command: "ls", description: "one" }), matchKey("Bash", { command: " ls ", description: "two" }), "the agent's own words about it do not count");
  assert.notEqual(matchKey("Bash", { command: "ls" }), matchKey("Bash", { command: "ls -a" }));
  assert.equal(matchKey("Edit", { b: 1, a: 2, description: "x" }), matchKey("Edit", { a: 2, b: 1 }));
  assert.equal(trimInput({ command: "x".repeat(5000) }).command.length, 2000);
  const big = trimInput({ command: "ls", blobs: Array.from({ length: 50 }, () => "y".repeat(1900)) });
  assert.deepEqual(big, { gist: "ls", trimmed: true }, "an input still too big keeps its gist");
  assert.notEqual(matchKey("Bash", { command: "ls" }), matchKey("Bash", { command: "ls", dangerouslyDisableSandbox: true }), "a flag changes what a command does");
  assert.equal(grantable({ key: matchKey("Bash", { command: "ls" }) }), true);
  assert.equal(grantable({ key: matchKey("permissions", { description: "more" }) }), false, "a request that names nothing to match is never approved ahead");
  assert.equal(grantable({ key: matchKey("Bash", { command: "ls" }), truncated: true }), false, "nor one the owner saw only part of");
});

test("Codex: a held approval is declined so the turn goes on, an approved one accepted, each in its request's own shape", () => {
  assert.deepEqual(approvalAnswer("item/commandExecution/requestApproval", {}, false, "held"), { decision: "decline" });
  assert.deepEqual(approvalAnswer("item/fileChange/requestApproval", {}, true), { decision: "accept" });
  assert.deepEqual(approvalAnswer("execCommandApproval", {}, false, "held for the owner"), { decision: { denied: { rejection: "held for the owner" } } });
  assert.deepEqual(approvalAnswer("applyPatchApproval", {}, true), { decision: "approved" });
  assert.deepEqual(approvalAnswer("item/permissions/requestApproval", { permissions: { network: { enabled: true } } }, true), { permissions: { network: { enabled: true } }, scope: "turn" });
  assert.deepEqual(approvalAnswer("item/permissions/requestApproval", { permissions: { network: { enabled: true } } }, false), { permissions: {}, scope: "turn" });
  assert.deepEqual(decisionIn(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "m" } } })), { behavior: "deny", message: "m" });
  assert.equal(decisionIn(null), null);
});

test("away mode: a worker's permission request is held with a note, once per request, and told once; off, it opens a dialog as before", (t) => {
  const { sb, sup } = setup(t);
  // Off: the request opens a dialog, as it always did.
  assert.equal(permission(sb, { command: "npm publish", description: "publish the package" }), null);
  assert.ok(flagUp(sb), "the dialog flag is up");
  clearFlag(sb);

  assert.equal(owner(sb, ["away", "on"], WORKER).code, 1, "a worker does not turn it on");
  const on = owner(sb, ["away", "on"]);
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /away mode on/);
  assert.match(owner(sb, ["away", "on"]).stdout, /on already/);

  const out = permission(sb, { command: "npm publish", description: "publish the package" });
  assert.equal(out.hookEventName, "PermissionRequest");
  assert.equal(out.decision.behavior, "deny");
  assert.match(out.decision.message, /^\[rollcall\] The owner is away, so this request is held for them: npm publish\. Do not try another way round it/);
  assert.match(out.decision.message, /mention it in your final report/);
  assert.equal(flagUp(sb), false, "no dialog opens: the worker carries on");

  const away = machine(sb, "away");
  assert.equal(away.on, true);
  assert.equal(away.by, "the terminal");
  assert.equal(held(sb).length, 1);
  const { key, ...h } = held(sb)[0];
  assert.ok(key.startsWith("Bash\n"));
  assert.match(h.id, /^h-\d+-[0-9a-f]+$/);
  assert.deepEqual({ ...h, id: null, at: null }, {
    id: null, at: null, ref: "alpha:t1", home: "alpha", harness: "claude", tool: "Bash", input: { command: "npm publish", description: "publish the package" },
    summary: "npm publish", reason: "publish the package", state: "held", answer: null, truncated: false,
  });
  const told = heldNotices(sb);
  assert.equal(told.length, 1);
  assert.match(told[0].text, /alpha:t1|header polish/);
  assert.match(told[0].text, /npm publish/);

  // The same request again is the same item, with no second notification.
  assert.match(permission(sb, { command: "npm publish", description: "try again" }).decision.message, /held already/);
  assert.equal(held(sb).length, 1);
  assert.equal(heldNotices(sb).length, 1);

  // A picker's permission request is no action to hold.
  assert.equal(permission(sb, { questions: [] }, { tool: "AskUserQuestion" }), null);
  clearFlag(sb);

  // A question while away waits on the task, and the worker hears to carry on, then stop.
  const asked = spawnSync(process.execPath, [BIN, "worker-hook", "alpha", "t2", "ask"], { input: JSON.stringify({ session_id: "s2", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Blue or green?", header: "Color", options: [{ label: "Blue" }, { label: "Green" }] }] } }), env: sb.env, encoding: "utf8" });
  const reasonText = JSON.parse(asked.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reasonText, /The owner is away: this question waits on task t2's record/);
  assert.match(reasonText, /carry on with any part of the task that does not depend on the answer, then end your turn/);
  assert.equal(record(sb, "t2").state, "needs-you");

  // The watcher's look: one notification at once while away, never a reminder.
  const look = `import { tick } from "${new URL("../src/watch.mjs", import.meta.url).href}"; tick("alpha", Number(process.env.NOW));`;
  const run = (now) => { const r = spawnSync(process.execPath, ["--input-type=module", "-e", look], { env: { ...sb.env, NOW: String(now) }, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };
  run(Date.now());
  run(Date.now() + 11 * 60_000);
  const q = questionNotices(sb);
  assert.equal(q.length, 1, "one notification per question, no 10-minute reminder");
  assert.match(q[0].text, /Blue or green\?/);

  // Off: the spell is kept with what got done, and the held item stays held.
  assert.equal(sup.cli(["task", "close", "t2", "not needed"]).code, 0);
  const off = owner(sb, ["away", "off"]);
  assert.equal(off.code, 0, off.stderr);
  assert.match(off.stdout, /away mode off\. Done meanwhile: alpha:t2 closed\./);
  assert.match(off.stdout, new RegExp(`${h.id}  alpha:t1: Bash: npm publish`));
  const after = machine(sb, "away");
  assert.deepEqual([after.on, after.since, after.by], [false, null, null]);
  assert.equal(after.last.since, away.since);
  assert.deepEqual(after.last.done.map((d) => [d.ref, d.title, d.state, d.pr]), [["alpha:t2", "footer polish", "closed", null]]);
  assert.equal(held(sb)[0].state, "held");
  assert.match(owner(sb, ["away", "status"]).stdout, /away mode off[\s\S]*alpha:t1: Bash: npm publish/);
  // Off, a new request opens a dialog again.
  assert.equal(permission(sb, { command: "rm -rf dist" }), null);
  assert.ok(flagUp(sb));
});

test("away answers: an approval lets the next matching request through once and reaches the task; a denial carries the owner's words; the first answer wins", (t) => {
  const { sb } = setup(t);
  assert.equal(owner(sb, ["away", "on"]).code, 0);

  permission(sb, { command: "npm publish" });
  permission(sb, { file_path: `${sb.root}/a.txt`, content: "x" }, { tool: "Write" });
  permission(sb, { command: "git push" }, { id: "t2" });
  const list = held(sb);
  assert.deepEqual(list.map((x) => [x.ref, x.tool, x.state]), [["alpha:t1", "Bash", "held"], ["alpha:t1", "Write", "held"], ["alpha:t2", "Bash", "held"]]);
  assert.equal(heldNotices(sb).length, 3, "one notification per held item");

  assert.notEqual(owner(sb, ["away", "allow", "h-nope"]).code, 0);
  assert.match(owner(sb, ["away", "allow", "h-nope"]).stderr, /no held request h-nope/);
  assert.notEqual(owner(sb, ["away", "allow"]).code, 0, "an answer names its item");
  assert.equal(owner(sb, ["away", "allow", list[0].id], WORKER).code, 1, "a worker gives no grant");
  assert.equal(held(sb)[0].state, "held", "and nothing changed");

  const yes = owner(sb, ["away", "allow", list[0].id]);
  assert.equal(yes.code, 0, yes.stderr);
  assert.match(yes.stdout, new RegExp(`${list[0].id} approved; not sent to its worker`), "t1 has no worker yet: on its record, not delivered");
  assert.match(record(sb).notes.at(-1).text, /held request approved by the owner \(the terminal\): npm publish/);
  const again = owner(sb, ["away", "allow", list[0].id]);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /approved already, from the terminal/, "the first answer wins: the same answer again is harmless");
  const clash = owner(sb, ["away", "deny", list[0].id, "too", "late"]);
  assert.match(clash.stdout, /approved already, from the terminal/, "a late opposite answer changes nothing");
  assert.equal(held(sb)[0].state, "approved");
  assert.deepEqual(machine(sb, "grants").map((g) => [g.ref, g.tool]), [["alpha:t1", "Bash"]]);

  // The grant: the next matching request goes through, once, even with away mode still on.
  assert.deepEqual(permission(sb, { command: "npm publish", description: "now" }), { hookEventName: "PermissionRequest", decision: { behavior: "allow" } });
  assert.equal(permission(sb, { command: "npm publish" }).decision.behavior, "deny", "used up: held again");
  assert.equal(permission(sb, { command: "npm publish" }, { id: "t2" }).decision.behavior, "deny", "a grant is for its own task");

  const no = owner(sb, ["away", "deny", list[1].id, "write", "it", "in", "the", "worktree"]);
  assert.equal(no.code, 0, no.stderr);
  assert.match(no.stdout, new RegExp(`${list[1].id} denied; not sent to its worker`));
  assert.match(record(sb).notes.at(-1).text, /held request denied by the owner \(the terminal\): Write .*a\.txt - write it in the worktree/);
  const answered = held(sb).find((x) => x.id === list[1].id);
  assert.equal(answered.state, "denied");
  assert.deepEqual({ ...answered.answer, at: null }, { at: null, by: "the terminal", allow: false, why: "write it in the worktree", all: false });

  // Allow all: every item still held.
  const open = held(sb).filter((x) => x.state === "held").map((x) => x.id);
  assert.equal(open.length, 3, "t2's push and publish, and t1's publish held again");
  const all = owner(sb, ["away", "allow-all"]);
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /approved 3: /);
  for (const id of open) assert.ok(all.stdout.includes(id));
  assert.ok(held(sb).filter((x) => open.includes(x.id)).every((x) => x.state === "approved" && x.answer.all));
  assert.equal(permission(sb, { command: "git push" }, { id: "t2" }).decision.behavior, "allow");
  assert.equal(permission(sb, { command: "git push" }, { id: "t2" }).decision.behavior, "deny", "allow all's grant was used once");
  assert.match(owner(sb, ["away", "allow-all"]).stdout, /approved 1: /, "the push held again is the one left");
  assert.match(owner(sb, ["away", "allow-all"]).stdout, /nothing is held/, "after that, the list is empty");

  // A request the owner saw only part of gets no grant: approving it tells the worker, and it asks again.
  const long = `echo ${"x".repeat(2100)}`;
  permission(sb, { command: long });
  const cut = held(sb).find((x) => x.state === "held" && x.truncated);
  assert.ok(cut, "a cut input is marked");
  assert.equal(owner(sb, ["away", "allow", cut.id]).code, 0);
  assert.equal(permission(sb, { command: long }).decision.behavior, "deny", "no grant for what the owner could not see");
  // Turning away mode off drops a grant not yet used: the request shows to the owner, who is back.
  permission(sb, { command: "npm test" });
  const test1 = held(sb).find((x) => x.state === "held" && x.summary === "npm test");
  assert.equal(owner(sb, ["away", "allow", test1.id]).code, 0);
  assert.equal(owner(sb, ["away", "off"]).code, 0);
  assert.equal(permission(sb, { command: "npm test" }), null);
});

test("away CLI: a worker is refused, the owner's terminal lists and answers", (t) => {
  const { sb } = setup(t);
  assert.equal(owner(sb, ["away", "on"]).code, 0);
  permission(sb, { command: "npm publish" });
  const id = held(sb)[0].id;
  const status = owner(sb, ["away", "status"]);
  assert.match(status.stdout, /away mode on since/);
  assert.match(status.stdout, new RegExp(`${id}  alpha:t1: Bash: npm publish`));
  assert.equal(owner(sb, ["away", "status"], WORKER).code, 1, "a worker has no say in away mode");
  assert.equal(owner(sb, ["away", "allow", id], WORKER).code, 1, "a worker gives no grant (an agent's shell is stopped by the Bash guard)");
  assert.equal(owner(sb, ["away", "allow-all"], WORKER).code, 1);
  const denied = owner(sb, ["away", "deny", id, "not", "today"]);
  assert.equal(denied.code, 0, denied.stderr);
  assert.match(denied.stdout, new RegExp(`${id} denied; not sent to its worker`));
  assert.match(record(sb).notes.at(-1).text, /denied by the owner \(the terminal\): npm publish - not today/);
  assert.match(owner(sb, ["away", "allow-all"]).stdout, /nothing is held/);
});
