// The table of a task's moves (src/state.mjs), row by row: each event against each state, written out here by hand
// so a changed row has to change a line of this file too. The flows that use the table run in task.test.mjs and
// the supervisor end-to-end suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { MOVES, STATES, allowed, isOpen, transition } from "../src/state.mjs";

const SRC = new URL("../src/", import.meta.url);
const [W, N, P, Q, L, C] = STATES;

/** `event` on a task in each state, for one with the facts `extra` holds. */
const after = (event, extra = {}, to) => STATES.map((state) => {
  const t = { state, ...extra };
  transition(t, event, { to, now: 1 });
  return t.state;
});

// Each event's result, in the order of STATES: working, needs-you, pr-open, queued, landed, closed.
const ROWS = {
  asked: [N, N, N, N, L, C],
  "owner-said": [W, W, P, Q, L, C],
  "pr-opened": [P, N, P, Q, P, P],
  "queue-joined": [Q, Q, Q, Q, L, C],
  "queue-parked": [N, N, N, N, L, C],
  "queue-stuck": [N, N, N, N, L, C],
  "merged": [L, N, L, L, L, C],
  "merged-more-to-do": [W, N, W, W, L, C],
  "no-worktree": [C, N, P, Q, L, C],
  "moved-away": [C, C, C, C, C, C],
  "abandoned": [C, C, C, C, L, C],
};

for (const [event, want] of Object.entries(ROWS)) {
  test(`${event}: every state`, () => assert.deepEqual(after(event), want));
}

test("queue-moving and queue-sent-back: a question the queue did not ask stands, and so does its task", () => {
  const theirs = { question: "deploy staging?" };
  const queues = { question: "merge queue: #4 has not moved" };
  assert.deepEqual(after("queue-moving", theirs), [Q, N, Q, Q, L, C]);
  assert.deepEqual(after("queue-moving", queues), [Q, Q, Q, Q, L, C]);
  assert.deepEqual(after("queue-moving"), [Q, Q, Q, Q, L, C], "no question at all");
  assert.deepEqual(after("queue-sent-back", theirs), [W, N, W, W, L, C]);
  assert.deepEqual(after("queue-sent-back", queues), [W, W, W, W, L, C]);
});

test("fresh-worker: only a task whose PR rollcall saw merge goes back to working", () => {
  const url = "https://github.com/o/r/pull/9";
  assert.deepEqual(after("fresh-worker", { pr: url, merged: { pr: url } }), [W, N, W, W, L, C]);
  assert.deepEqual(after("fresh-worker", { pr: url }), [W, N, P, Q, L, C], "its PR is still open");
  assert.deepEqual(after("fresh-worker", { pr: "https://github.com/o/r/pull/10", merged: { pr: url } }), [W, N, P, Q, L, C], "its next PR is open");
  assert.deepEqual(after("fresh-worker"), [W, N, P, Q, L, C]);
});

test("worker-report: any state on an open task; on a finished one, only a new PR", () => {
  for (const from of STATES) {
    for (const to of STATES) {
      const want = from === to || isOpen({ state: from }) || to === P;
      assert.equal(allowed({ state: from }, "worker-report", to), want, `${from} to ${to}`);
      const t = { state: from };
      transition(t, "worker-report", { to });
      assert.equal(t.state, want ? to : from, `${from} to ${to}`);
    }
  }
});

test("report (the supervisor, a shell): any state to any state", () => {
  for (const from of STATES) {
    for (const to of STATES) {
      assert.equal(allowed({ state: from }, "report", to), true, `${from} to ${to}`);
      assert.deepEqual(after("report", {}, to).every((s) => s === to), true);
    }
  }
});

test("a report that names no state moves nothing, and neither does an unknown event", () => {
  assert.deepEqual(after("report"), STATES);
  assert.deepEqual(after("no such event"), STATES);
});

test("a move stamps the state and ends what the task waited on; no move touches anything", () => {
  const ask = { at: 1, questions: [] };
  const t = { state: N, stateAt: 1, question: "which one?", ask };
  assert.equal(transition(t, "owner-said", { now: 5 }), true);
  assert.deepEqual(t, { state: W, stateAt: 5, question: null, ask: null });
  const same = { state: N, stateAt: 1, question: "which one?", ask };
  assert.equal(transition(same, "asked", { now: 5 }), false, "already there");
  assert.deepEqual(same, { state: N, stateAt: 1, question: "which one?", ask });
  const refused = { state: L, stateAt: 1 };
  assert.equal(transition(refused, "asked", { now: 5 }), false);
  assert.deepEqual(refused, { state: L, stateAt: 1 });
});

test("isOpen: every state but landed and closed", () => {
  assert.deepEqual(STATES.filter((state) => isOpen({ state })), [W, N, P, Q]);
  assert.equal(isOpen(null), false);
});

test("only state.mjs writes a task's state, and every row of its table has a caller", () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith(".mjs") && f !== "state.mjs");
  const text = Object.fromEntries(files.map((f) => [f, readFileSync(new URL(f, SRC), "utf8")]));
  text["start.mjs"] = readFileSync(new URL("../../../scripts/supervisor/start.mjs", SRC), "utf8");
  for (const [f, s] of Object.entries(text)) {
    assert.doesNotMatch(s, /\b(?:t|t0|x|task)\.state\s*=(?!=)/, `${f} sets a task's state itself`);
    assert.doesNotMatch(s, /Object\.assign\((?:t|t0|x|task), \{[^}]*\bstate:/, `${f} sets a task's state itself`);
  }
  const all = Object.values(text).join("\n");
  for (const event of new Set(MOVES.map(([e]) => e))) assert.ok(all.includes(`"${event}"`), `no caller of ${event}`);
});
