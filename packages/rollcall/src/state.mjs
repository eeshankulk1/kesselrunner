// A task's state, and every way it changes. One table says what may move a task from where to where, and one
// function makes the move, so what a finished task is, and what can reopen one, is read here and nowhere else.
// Pure on purpose: the table's tests need no store, tmux or git. Facts that decide a move and take a look at the
// world (a worker running, an open PR, a saved report) stay with their callers in task.mjs.

const OPEN = ["working", "needs-you", "pr-open", "queued"];
const FINISHED = ["landed", "closed"];
export const STATES = [...OPEN, ...FINISHED];

export const isOpen = (t) => !!t && !FINISHED.includes(t.state);

/** A task's question that is the merge queue's own, which the queue may answer itself. Any other waits on the owner. */
const queueMayMove = (t) => t.state !== "needs-you" || !t.question || t.question.startsWith("merge queue");
/** The PR the task shows has merged (rollcall saw it), so the task no longer waits on that PR. */
const prMergedSeen = (t) => !!t.pr && t.merged?.pr === t.pr;

/**
 * [event, from, to, when]: what happened, the states it applies in, the states it may move to (the first and only
 * one, unless the caller names one) and any further condition. Nothing else moves a task; test/state.test.mjs
 * spells out every event against every state.
 */
export const MOVES = [
  // A finished task asks nothing: a worker brought back to it answers with a reply note.
  ["asked", OPEN, ["needs-you"]],
  ["owner-said", ["needs-you"], ["working"]],
  // gh pr create in its worktree. A finished task opens again: a discussion turned build, a second PR after a landing.
  ["pr-opened", ["working", ...FINISHED], ["pr-open"]],
  // A worker reports on an open task; on a finished one only a new PR, as above. The rest of a finished task is the
  // supervisor's to reopen. Anyone else (the supervisor, the owner in a shell) may set any state.
  ["worker-report", OPEN, STATES],
  ["worker-report", FINISHED, ["pr-open"]],
  ["report", STATES, STATES],
  // The merge queue, on the task's PR.
  ["queue-joined", OPEN, ["queued"]],
  ["queue-parked", OPEN, ["needs-you"]],
  ["queue-stuck", OPEN, ["needs-you"]],
  ["queue-moving", OPEN, ["queued"], queueMayMove],
  ["queue-sent-back", OPEN, ["working"], queueMayMove],
  // What rollcall sees of the merge: its PR landed all of the worktree, or part of it.
  ["merged", ["working", "pr-open", "queued"], ["landed"]],
  ["merged-more-to-do", ["pr-open", "queued"], ["working"]],
  // A fresh worker on a task whose PR merged carries on with the next part: nothing waits on that PR now.
  ["fresh-worker", ["pr-open", "queued"], ["working"], prMergedSeen],
  // rollcall's own closes: the worktree could not be made, the task went to another supervisor, its home went quiet.
  ["no-worktree", ["working"], ["closed"]],
  ["moved-away", STATES, ["closed"]],
  ["abandoned", OPEN, ["closed"]],
];

/** The state `event` may move `t` to, or null: `to` when the event lets the caller name one, else the event's only target. */
function target(t, event, to) {
  const row = MOVES.find(([e, from]) => e === event && from.includes(t.state));
  if (!row) return null;
  const [, , targets, when] = row;
  const next = to ?? (targets.length === 1 ? targets[0] : null);
  return targets.includes(next) && (!when || when(t)) ? next : null;
}

/** Whether `event` may move `t` to `to`; staying put is no move and always allowed. */
export const allowed = (t, event, to) => t.state === to || target(t, event, to) !== null;

/**
 * Moves `t` (under its task lock) as `event` allows: a new state, stamped, and whatever it was waiting on is over.
 * Returns whether it moved.
 */
export function transition(t, event, { to, now = Date.now() } = {}) {
  const next = target(t, event, to);
  if (!next || next === t.state) return false;
  Object.assign(t, { state: next, stateAt: now, question: null, ask: null });
  return true;
}
