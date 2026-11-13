// The light half of the ship script (ship.mjs): what the merge queue's outcomes and the CLI's usage need, without
// loading the lander. News that needs a model goes into the task's worker as a notice; a landed --land ship starts
// its after-merge runner.
import { existsSync } from "node:fs";
import { enqueue } from "./delivery.mjs";
import { locate, mainCheckout } from "./git.mjs";
import { spawnDetached } from "./proc.mjs";
import { BIN, P } from "./session.mjs";
import { isOpen } from "./state.mjs";
import * as store from "./store.mjs";

export const SHIP_USAGE = `  rollcall ship start [--land] [--owner-ok "<their words>"]
                                         once the PR is open and pushed: rollcall watches its checks from here, with
                                         no agent waiting. --land: once green with no open review thread, it joins
                                         the merge queue, lands, and rollcall watches the deploys and runs the
                                         manifest's release commands. A red check, a thread, a conflict or a failed
                                         release step comes back to the task's worker (or ship wait) with what failed
  rollcall ship wait [--timeout <min>]   block until this branch's ship needs you or is done, then print the line;
                                         run it in the background in a session with no task
  rollcall ship status [--json]          this branch's ship: its stage, how long, the last news`;

/** What a ship's session does next after it was sent back: the fix, then the ship again. */
export const AGAIN = "then rollcall ship start --land again (it watches the checks and joins the queue once they are green)";

/**
 * The kinds of news that end a ship's `ship wait`: each needs a model turn, or ends the ship. "landed" does not,
 * when an after-merge runner carries on from it.
 */
export const ENDS = new Set(["red", "review", "conflict", "failed", "left", "parked", "green", "after-failed", "release-step", "shipped"]);
/** The kinds that need a model turn: they go into the task's worker as a notice. */
const WAKES = new Set(["red", "review", "conflict", "failed", "left", "after-failed", "release-step"]);

/**
 * News about ship entry `e` reaches whoever acts on it with no model turn spent on news: kinds that need one go into
 * the task's worker as a notice (a parked worker comes back for it), and the task's record and tab follow.
 */
export function shipNews(e, kind, text) {
  if (!e.task || !WAKES.has(kind)) return;
  const [h, id] = e.task.split(":");
  const t = store.readTask(h, id);
  if (!isOpen(t)) return;
  enqueue(t, "notice", `${P} ship: ${text}`);
}

/** Starts the after-merge runner for landed ship entry `e` (merge commit `sha`). */
export function startAfter(key, e, sha) {
  store.updateQueue(key, (q) => {
    q.after ??= {};
    for (const [pr, a] of Object.entries(q.after)) if (a.stage === "done" && Date.now() - a.at > 7 * 86400_000) delete q.after[pr];
    q.after[e.pr] = { pr: e.pr, branch: e.branch, sha: sha ?? null, task: e.task ?? null, session: e.session ?? null, who: e.who ?? null, checkout: e.checkout ?? null, stage: "deploys", step: null, at: Date.now(), pid: null, start: null };
  });
  if (process.env.ROLLCALL_SHIP_AFTER === "0") return;
  const info = e.checkout && existsSync(e.checkout) ? locate(e.checkout) : null;
  const main = info ? mainCheckout(info) : null;
  if (main) spawnDetached(process.execPath, [BIN, "-C", main, "ship", "after", String(e.pr)], { cwd: main });
}
