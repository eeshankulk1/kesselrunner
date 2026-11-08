// Done when: away mode holds instead of waiting. While it is on, a task worker's permission request is refused with a
// note and saved to the held list (once per request, one notice each), its question goes to the task with the "carry
// on, then stop" note, and the 10-minute reminders stop; the owner's answer reaches the worker, and an approval lets
// the next matching request through once. The switch, the held list and their answers are in the front-end
// interface (away.set, held.answer, held.allowAll, the snapshot's away and held, their stream events), and a decision
// answered from any surface reaches its task's worker.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { changes } from "../src/api-stream.mjs";
import { approvalAnswer, decisionIn } from "../src/codex/worker.mjs";
import { grantable, matchKey, summaryOf, trimInput } from "../src/away.mjs";
import { BIN, sandbox } from "./helpers.mjs";

const WORKER = { env: { ROLLCALL_TASK: "alpha:t1" } };

function owner(sb, args, { env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: sb.root, encoding: "utf8", env: { ...sb.env, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const parsed = (r) => { try { return JSON.parse(r.stdout); } catch { assert.fail(`not JSON (exit ${r.code}): ${r.stdout}${r.stderr}`); } };
const act = (sb, name, payload) => { const r = owner(sb, ["api", "do", name, JSON.stringify(payload)]); return { exit: r.code, ...parsed(r) }; };
const snap = (sb) => parsed(owner(sb, ["api", "snapshot"]));
const record = (sb, id = "t1") => JSON.parse(readFileSync(join(sb.home, "_supervisors", "alpha", "tasks", `${id}.json`), "utf8"));
const notices = (sb) => { try { return readFileSync(join(sb.home, "_machine", "notices.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } };

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

  const s = snap(sb);
  assert.equal(s.away.on, true);
  assert.equal(s.away.by, "the terminal");
  assert.equal(s.held.length, 1);
  const h = s.held[0];
  assert.match(h.id, /^h-\d+-[0-9a-f]+$/);
  assert.deepEqual({ ...h, id: null, at: null }, {
    id: null, at: null, ref: "alpha:t1", home: "alpha", harness: "claude", tool: "Bash", input: { command: "npm publish", description: "publish the package" },
    summary: "npm publish", reason: "publish the package", state: "held", answer: null, truncated: false,
  });
  const told = notices(sb).filter((n) => n.kind === "held");
  assert.equal(told.length, 1);
  assert.equal(told[0].ref, "alpha:t1");
  assert.equal(told[0].held, h.id);
  assert.match(told[0].text, /npm publish/);

  // The same request again is the same item, with no second notice.
  assert.match(permission(sb, { command: "npm publish", description: "try again" }).decision.message, /held already/);
  assert.equal(snap(sb).held.length, 1);
  assert.equal(notices(sb).filter((n) => n.kind === "held").length, 1);

  // A picker's permission request is no action to hold.
  assert.equal(permission(sb, { questions: [] }, { tool: "AskUserQuestion" }), null);
  clearFlag(sb);

  // A question while away waits on the task, and the worker hears to carry on, then stop.
  const asked = spawnSync(process.execPath, [BIN, "worker-hook", "alpha", "t2", "ask"], { input: JSON.stringify({ session_id: "s2", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Blue or green?", header: "Color", options: [{ label: "Blue" }, { label: "Green" }] }] } }), env: sb.env, encoding: "utf8" });
  const reasonText = JSON.parse(asked.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reasonText, /The owner is away: this question waits on task t2's record/);
  assert.match(reasonText, /carry on with any part of the task that does not depend on the answer, then end your turn/);
  assert.equal(record(sb, "t2").state, "needs-you");

  // The watcher's look: one `question` notice at once while away, never a reminder.
  const look = `import { tick } from "${new URL("../src/watch.mjs", import.meta.url).href}"; tick("alpha", Number(process.env.NOW));`;
  const run = (now) => { const r = spawnSync(process.execPath, ["--input-type=module", "-e", look], { env: { ...sb.env, NOW: String(now) }, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };
  run(Date.now());
  run(Date.now() + 11 * 60_000);
  const q = notices(sb).filter((n) => n.kind === "question");
  assert.equal(q.length, 1, "one notice per question, no 10-minute reminder");
  assert.equal(q[0].ref, "alpha:t2");
  assert.match(q[0].text, /Blue or green\?/);

  // Off: the spell is kept with what got done, and the held item stays held.
  assert.equal(sup.cli(["task", "close", "t2", "not needed"]).code, 0);
  const off = owner(sb, ["away", "off"]);
  assert.equal(off.code, 0, off.stderr);
  assert.match(off.stdout, /away mode off\. Done meanwhile: alpha:t2 closed\./);
  assert.match(off.stdout, new RegExp(`${h.id}  alpha:t1: Bash: npm publish`));
  const after = snap(sb);
  assert.deepEqual([after.away.on, after.away.since, after.away.by], [false, null, null]);
  assert.equal(after.away.last.since, s.away.since);
  assert.deepEqual(after.away.last.done.map((d) => [d.ref, d.title, d.state, d.pr]), [["alpha:t2", "footer polish", "closed", null]]);
  assert.equal(after.held[0].state, "held");
  // Off, a new request opens a dialog again.
  assert.equal(permission(sb, { command: "rm -rf dist" }), null);
  assert.ok(flagUp(sb));
});

test("held.answer: an approval lets the next matching request through once and reaches the task; a denial carries the owner's words; the first answer wins", (t) => {
  const { sb } = setup(t);
  assert.equal(act(sb, "away.set", { on: "yes" }).error.code, "bad-payload");
  const set = act(sb, "away.set", { on: true, client: "cockpit-phone" });
  assert.equal(set.result.already, false);
  assert.equal(set.result.away.on, true);
  assert.equal(set.result.away.by, "cockpit-phone");
  assert.equal(act(sb, "away.set", { on: true }).result.already, true);
  assert.equal(owner(sb, ["api", "do", "away.set", '{"on":false}'], WORKER).code, 1, "refused from a worker, as every do");

  permission(sb, { command: "npm publish" });
  permission(sb, { file_path: `${sb.root}/a.txt`, content: "x" }, { tool: "Write" });
  permission(sb, { command: "git push" }, { id: "t2" });
  const held = snap(sb).held;
  assert.deepEqual(held.map((x) => [x.ref, x.tool, x.state]), [["alpha:t1", "Bash", "held"], ["alpha:t1", "Write", "held"], ["alpha:t2", "Bash", "held"]]);

  assert.equal(act(sb, "held.answer", { id: "h-nope", allow: true }).error.code, "not-found");
  assert.equal(act(sb, "held.answer", { id: held[0].id }).error.code, "bad-payload");
  const yes = act(sb, "held.answer", { id: held[0].id, allow: true, client: "cockpit" });
  assert.equal(yes.ok, true);
  assert.deepEqual([yes.result.answered, yes.result.already, yes.result.delivered], [true, false, false], "t1 has no worker yet: on its record, not delivered");
  assert.equal(yes.result.view.ref, "alpha:t1");
  assert.match(record(sb).notes.at(-1).text, /held request approved by the owner \(cockpit\): npm publish/);
  assert.deepEqual(act(sb, "held.answer", { id: held[0].id, allow: true }).result.already, true, "the same answer again is harmless");
  const clash = act(sb, "held.answer", { id: held[0].id, allow: false });
  assert.equal(clash.error.code, "already-answered");
  assert.equal(clash.error.answer.by, "cockpit");

  // The grant: the next matching request goes through, once, even with away mode still on.
  assert.deepEqual(permission(sb, { command: "npm publish", description: "now" }), { hookEventName: "PermissionRequest", decision: { behavior: "allow" } });
  assert.equal(permission(sb, { command: "npm publish" }).decision.behavior, "deny", "used up: held again");
  assert.equal(permission(sb, { command: "npm publish" }, { id: "t2" }).decision.behavior, "deny", "a grant is for its own task");

  const no = act(sb, "held.answer", { id: held[1].id, allow: false, why: "write it in the worktree" });
  assert.equal(no.ok, true);
  assert.match(record(sb).notes.at(-1).text, /held request denied by the owner \(frontend\): Write .*a\.txt - write it in the worktree/);
  const answered = snap(sb).held.find((x) => x.id === held[1].id);
  assert.equal(answered.state, "denied");
  assert.deepEqual({ ...answered.answer, at: null }, { at: null, by: "frontend", allow: false, why: "write it in the worktree", all: false });

  // Allow all: every item still held, of one supervisor when it names one.
  assert.deepEqual(act(sb, "held.allowAll", { home: "nobody" }).result, { approved: [], count: 0 });
  const open = snap(sb).held.filter((x) => x.state === "held").map((x) => x.id);
  assert.equal(open.length, 3, "t2's push and publish, and t1's publish held again");
  const all = act(sb, "held.allowAll", { home: "alpha" });
  assert.deepEqual(all.result.approved.sort(), open.sort());
  assert.equal(all.result.count, 3);
  assert.ok(snap(sb).held.filter((x) => open.includes(x.id)).every((x) => x.state === "approved" && x.answer.all));
  assert.equal(permission(sb, { command: "git push" }, { id: "t2" }).decision.behavior, "allow");
  assert.equal(permission(sb, { command: "git push" }, { id: "t2" }).decision.behavior, "deny", "allow all's grant was used once");

  // A request the owner saw only part of gets no grant: approving it tells the worker, and it asks again.
  const long = `echo ${"x".repeat(2100)}`;
  permission(sb, { command: long });
  const cut = snap(sb).held.find((x) => x.state === "held" && x.truncated);
  assert.ok(cut, "a cut input is marked");
  assert.equal(act(sb, "held.answer", { id: cut.id, allow: true }).ok, true);
  assert.equal(permission(sb, { command: long }).decision.behavior, "deny", "no grant for what the owner could not see");
  // Turning away mode off drops a grant not yet used: the request shows to the owner, who is back.
  permission(sb, { command: "npm test" });
  const test1 = snap(sb).held.find((x) => x.state === "held" && x.summary === "npm test");
  assert.equal(act(sb, "held.answer", { id: test1.id, allow: true }).ok, true);
  assert.equal(act(sb, "away.set", { on: false }).ok, true);
  assert.equal(permission(sb, { command: "npm test" }), null);
});

test("away CLI answers: refused in a worker, the owner's terminal answers and lists", (t) => {
  const { sb, sup } = setup(t);
  assert.equal(owner(sb, ["away", "on"]).code, 0);
  permission(sb, { command: "npm publish" });
  const id = snap(sb).held[0].id;
  const status = owner(sb, ["away", "status"]);
  assert.match(status.stdout, /away mode on since/);
  assert.match(status.stdout, new RegExp(`${id}  alpha:t1: Bash: npm publish`));
  assert.equal(owner(sb, ["away", "allow", id], WORKER).code, 1, "a worker gives no grant (an agent's shell is stopped by the Bash guard)");
  const denied = owner(sb, ["away", "deny", id, "not", "today"]);
  assert.equal(denied.code, 0, denied.stderr);
  assert.match(denied.stdout, new RegExp(`${id} denied; not sent to its worker`));
  assert.match(record(sb).notes.at(-1).text, /denied by the owner \(the terminal\): npm publish - not today/);
  assert.match(owner(sb, ["away", "allow-all"]).stdout, /nothing is held/);
});

test("decision.answer and task decisions done reach the deciding task's worker, and say whether it went", (t) => {
  const { sb, sup } = setup(t);
  assert.equal(sup.cli(["task", "decisions", "add", "ship on friday?", "--from", "t1"]).code, 0);
  const n = snap(sb).decisions[0].n;
  const r = act(sb, "decision.answer", { n, answer: "yes" });
  assert.deepEqual(r.result, { answered: true, delivered: false, how: null }, "t1 has no worker: on its record only");
  assert.match(record(sb).notes.at(-1).text, /decided: ship on friday\? - yes/);
  assert.equal(sup.cli(["task", "decisions", "add", "and the footer?", "--from", "t1"]).code, 0);
  const done = sup.cli(["task", "decisions", "done", String(n + 1), "later"]);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /answered: later; not sent to yoda's worker: it has no worker yet/);
});

test("changes(): away and held come as their own events, whole", () => {
  const base = { tasks: [], supervisors: [], tmux: {}, sessions: [], queues: [], blockers: [], blockerLines: [], decisions: [], usage: {}, usageOffer: null, clients: [], away: { on: false, since: null, by: null, last: null }, held: [] };
  const away = { on: true, since: 1, by: "cockpit", last: null };
  const held = [{ id: "h-1-a", ref: "alpha:t1", state: "held" }];
  assert.deepEqual(changes(base, { ...base, away, held }), [{ type: "away.changed", away }, { type: "held.changed", held }]);
  assert.deepEqual(changes(base, base), []);
});
