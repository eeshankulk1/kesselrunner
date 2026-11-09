// What rollcall types into a worker, with a receipt. tmux exiting 0 says the keys left, not that a prompt arrived,
// so everything for a worker (the owner's words, a pick, a doorbell) goes through one queue per task
// (`outbox-<id>.json` in its home) and leaves it only when the worker's own prompt-submit hook records it. That
// hook fires as Enter lands, even in the middle of a turn. An item with no receipt after receiptMs goes out again,
// TRIES times at most, then the owner hears once, and it goes out again once the worker moves, up to SENDS times in
// all: a worker that moves is often moving on the very prompt whose receipt was missed. Its prompt in the
// transcript is a receipt too, for a hook that failed. A launch's first prompt is on the queue as well, never typed:
// its receipt is how rollcall knows that prompt for its own.
//
// Nothing here reads the screen. A dialog is the worker's hook flag: Claude Code's PermissionRequest hook fires
// as a permission prompt or a picker opens (its notification comes 6 s later), and Enter there would answer it.
// Cancelling a dialog fires no hook at all, so an open flag holds only while its tool call waits in the transcript.
//
// A Codex worker takes words through its app server instead of keys (harness/codex.mjs): the server's answer is the
// receipt, and its UI's prompts are the owner's, since rollcall's carry an id of its own.
//
// Who wrote a prompt is the transcript's to say, and Claude Code writes that record only after the hook returns:
// the hook notes a prompt that is no delivery of rollcall's (`typed-<id>.json`), and the watcher settles it.
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { asked, promptAuthor, sameWords } from "./asked.mjs";
import * as store from "./store.mjs";
import { workerAdapter } from "./harness/index.mjs";

const ms = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : dflt; };
/** How long a typed prompt has to reach the session's prompt hook before it counts as lost. */
export const receiptMs = () => ms("ROLLCALL_RECEIPT_MS", 60_000);
/** What must hold before rollcall types into a window, so it never lands in what the owner is typing. */
export const keyQuietMs = () => ms("ROLLCALL_KEY_QUIET_MS", 15_000);
const TRIES = 3;
// However often the worker moves, an item goes out this many times at most and then leaves the queue: its words are
// on the task's record already, and an item that arrives but is never recognised would otherwise go in on every turn.
const SENDS = 2 * TRIES;
// How long a turn's end gives a prompt queued just before it to reach the transcript.
const SETTLE_GRACE_MS = 5_000;
// A dialog's tool call can reach the transcript a moment after the hook that flags it.
const FLAG_GRACE_MS = 2_000;
// How long before its dialog's flag a subagent's transcript can have been written, for the call that asks.
const SUBAGENT_LEAD_MS = 60_000;

const OUTBOX = (id) => `outbox-${id}`;
const TYPED = (id) => `typed-${id}`;

/** Runs `fn` on home file `name`'s list under the home's lock, writes the list it returns, and hands back `out`. */
function edit(h, name, fn) {
  const r = store.withHomeLock(h, () => {
    const { items, out } = fn(store.readHomeFile(h, name) ?? []);
    store.writeHomeFile(h, name, items.length ? items : null);
    return out;
  });
  return r?.out;
}

export const outbox = (h, id) => store.readHomeFile(h, OUTBOX(id)) ?? [];
/** What waits to be typed into the task's worker (a launch's prompt is on its command line, not waiting). */
export const waiting = (h, id) => outbox(h, id).filter((x) => x.kind !== "launch");

/** Puts `text` on the task's queue: "words", "notice" (a line of rollcall's), or "doorbell", of which one is enough. Returns the new item's id, or false when the store stayed busy. */
export function enqueue(t, kind, text, now = Date.now()) {
  const id = randomBytes(4).toString("hex");
  const queued = edit(t.home, OUTBOX(t.id), (items) => ({
    items: kind === "doorbell" && items.some((x) => x.kind === kind) ? items : [...items, { id, kind, text, at: now, typedAt: null, tries: 0 }],
    out: true,
  }));
  store.pokeWatcher(t.home);
  // The new item's id (truthy), or false when the store stayed busy and nothing went on.
  return queued === true ? id : false;
}

/**
 * A worker starts with `prompt` on its command line: its hook's receipt marks that prompt as rollcall's. With
 * `fresh` the worker is a new one, whose brief carries the owner's words: only a doorbell stays for it.
 */
export function launching(t, prompt, { fresh = false } = {}) {
  edit(t.home, OUTBOX(t.id), (items) => ({
    items: [
      ...items.filter((x) => x.kind !== "launch" && !(fresh && x.kind === "words")),
      ...(prompt ? [{ id: randomBytes(4).toString("hex"), kind: "launch", text: prompt, at: Date.now(), typedAt: Date.now(), tries: 1 }] : []),
    ],
  }));
}

/** Takes `items` off the queue: they went out some other way. */
export function drop(t, items) {
  const ids = items.map((x) => x.id);
  edit(t.home, OUTBOX(t.id), (all) => ({ items: all.filter((x) => !ids.includes(x.id)) }));
}

/** The worker's prompt hook: takes what `prompt` delivers off the queue and returns it ([] when it is none of rollcall's). */
export function received(t, prompt, now = Date.now()) {
  if (!outbox(t.home, t.id).length) return [];
  const got = edit(t.home, OUTBOX(t.id), (items) => {
    const out = items.filter((x) => x.typedAt && sameWords(x.text, prompt));
    return { items: items.filter((x) => !out.includes(x)), out };
  }) ?? [];
  for (const x of got) store.appendStatus(t.home, t.id, { ev: "delivered", kind: x.kind, wait: now - x.at });
  return got;
}

/**
 * Whether worker `w` can take words now: it runs, its session has started (before that Claude Code may be showing
 * its trust prompt, which no hook reports and where Enter means "No, exit"), and its harness takes them: for Claude
 * Code no dialog is open and no key was pressed in its window just now (harness/*.mjs takesTyping).
 */
export const canTake = (t, w, now = Date.now()) => !!w?.alive && w.started && workerAdapter(t).takesTyping(t, w, now);

/**
 * Types what is due on the task's queue as one prompt, when worker `w` can take it. Returns { typed: how many
 * items went, err: why typing failed, lost: items that just ran out of tries (`gone` on one that left the queue) }.
 */
export function flush(t, w, now = Date.now()) {
  const { home: h, id } = t;
  const quiet = { typed: 0, err: null, lost: [] };
  const items = waiting(h, id);
  if (!items.length || !canTake(t, w, now)) return quiet;
  // Its hook may have failed while the prompt went in: the transcript has the last word before anything goes twice.
  const file = workerAdapter(t).transcriptOf(w);
  const overdue = items.filter((x) => x.typedAt && now - x.typedAt >= receiptMs());
  const arrived = overdue.filter((x) => promptAuthor(file, x.text, x.typedAt)).map((x) => x.id);
  const { due, lost } = edit(h, OUTBOX(id), (all) => {
    const out = { due: [], lost: [] };
    const left = all.filter((x) => !arrived.includes(x.id)).filter((x) => {
      if (x.kind === "launch" || (x.typedAt && now - x.typedAt < receiptMs())) return true;
      const sends = x.sends ?? x.tries;
      if (sends >= SENDS) {
        out.lost.push({ ...x, gone: true });
        return false;
      }
      // A worker that moved since the last try is no longer what stopped it.
      if (x.typedAt && (w.since ?? 0) > x.typedAt) x.tries = 0;
      if (x.tries >= TRIES) {
        if (!x.noticed) { x.noticed = true; out.lost.push(x); }
        return true;
      }
      x.typedAt = now;
      x.tries += 1;
      x.sends = sends + 1;
      out.due.push(x);
      return true;
    });
    return { items: left, out };
  }) ?? { due: [], lost: [] };
  if (!due.length) return { ...quiet, lost };
  // A dialog that opens in the moment between paste and Enter must not get that Enter.
  const r = workerAdapter(t).type(t, due.map((x) => x.text).join("\n\n"), { before: () => !dialogUp(h, id) });
  // A hosted worker says how it took them: `sent` (a turn starts) or `queued` (into the running turn).
  if (r.ok) return { typed: due.length, err: null, lost, ...(r.how ? { how: r.how } : {}) };
  const ids = due.map((x) => x.id);
  edit(h, OUTBOX(id), (all) => ({ items: all.map((x) => (ids.includes(x.id) ? { ...x, typedAt: null, tries: x.tries - 1, sends: x.sends - 1 } : x)) }));
  return { typed: 0, err: r.err || "tmux refused", lost };
}

// ---------------------------------------------------------------- dialogs

/** The worker's dialog flag: written by its hooks while a dialog is open in it. */
export const dialogFlag = (h, id) => join(store.workerDir(h, id), "dialog");
export function dialogUp(h, id) {
  try { statSync(dialogFlag(h, id)); return true; } catch { return false; }
}

/** Takes down a flag whose dialog was cancelled (no hook says so): its call no longer waits. Returns whether it did. */
export function settleDialog(t, now = Date.now()) {
  const flag = dialogFlag(t.home, t.id);
  let open = null;
  let since = now;
  try {
    since = statSync(flag).mtimeMs;
    if (now - since < FLAG_GRACE_MS) return false;
    open = JSON.parse(readFileSync(flag, "utf8"));
  } catch { return false; }
  // A subagent's call that asks writes its record just before the flag and nothing while the dialog stays open: a
  // dialog left for an hour still counts it, and a subagent that stopped long before the dialog does not.
  if (!open?.transcript || asked(open.transcript, now, now - since + SUBAGENT_LEAD_MS)) return false;
  rmSync(flag, { force: true });
  store.appendStatus(t.home, t.id, { ev: "dialog-gone" });
  store.pokeWatcher(t.home);
  return true;
}

// ---------------------------------------------------------------- who wrote a prompt

/** The worker's hook: a prompt rollcall did not send, for the watcher to settle once the transcript has it. */
export function noteTyped(t, p, now = Date.now()) {
  const text = typeof p.prompt === "string" ? p.prompt.trim() : "";
  // A harness that says who sent a prompt (Codex: a message rollcall sent carries its id) needs no transcript.
  if (!text || p.agent_id || (!p.transcript_path && p.owner !== true)) return;
  edit(t.home, TYPED(t.id), (items) => ({ items: [...items, { at: now, text, session: p.session_id, transcript: p.transcript_path ?? null, ...(p.owner === true ? { owner: true } : {}) }] }));
}

export const typedWaiting = (h, id) => store.readHomeFile(h, TYPED(id)) ?? [];

/**
 * The prompts noted for the task that the transcript now settles. Returns the owner's: [{ at, text, session }]. A prompt
 * the transcript never shows by the end of the next turn was none of the owner's (a slash command, a shell line).
 */
export function settleTyped(t, turnEnded, now = Date.now()) {
  if (!typedWaiting(t.home, t.id).length) return [];
  return edit(t.home, TYPED(t.id), (items) => {
    const owner = [];
    const left = items.filter((x) => {
      const who = x.owner ? "owner" : promptAuthor(x.transcript, x.text, x.at);
      if (who === "owner") owner.push(x);
      return !who && !(turnEnded > x.at && now - turnEnded > SETTLE_GRACE_MS);
    });
    return { items: left, out: owner };
  }) ?? [];
}
