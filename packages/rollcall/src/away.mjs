// Away mode: one switch for the whole machine (`rollcall away on|off`, the `away.set` action), for when the owner
// steps away. While it is on, nothing a task worker does waits on the owner: a permission prompt is refused with a
// note (held for the owner, carry on with other work) and saved to the held list, and a question goes to the task's
// record even when a terminal shows the worker. The owner answers held requests later, from any surface: an approval
// leaves a one-time grant that lets the worker's next matching request through, and either answer reaches the worker
// as its next prompt, which wakes it. Only task workers are held; the owner's own sessions and supervisors never are.
//
// Three machine records, each under its own lock (store.updateMachineFile):
//   away.json     { on, since, by, last }: the switch, and the last finished spell with what got done in it
//   held.json     [item]: held requests, open until answered; answered ones stay a day
//   grants.json   [{ ref, tool, key, at, until }]: approvals not yet used, a day at most, dropped when away mode ends
import { randomBytes } from "node:crypto";
import { relative } from "node:path";
import { describe } from "./asked.mjs";
import { P } from "./session.mjs";
import { isOpen } from "./state.mjs";
import * as store from "./store.mjs";
import { deliverWords, holderOf, label, nameOf } from "./supervisor.mjs";
import { notify } from "./trouble.mjs";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Tools whose permission request is a picker the worker shows, not an action to hold: AskUserQuestion has its own path. */
const NOT_HELD = new Set(["AskUserQuestion", "ExitPlanMode"]);
/** How much of a tool's input a held item keeps: a long string is cut, and an input still too big keeps its gist. */
const INPUT_STRING_MAX = 2000;
const INPUT_MAX = 8000;

const refOf = (t) => `${t.home}:${t.id}`;
const parse = (ref) => { const i = String(ref).indexOf(":"); return { home: ref.slice(0, i), id: ref.slice(i + 1) }; };

// ---------------------------------------------------------------- the switch

/** Away mode now: { on, since, by, last }. `last` is the most recent finished spell: { since, until, done }. */
export function awayState() {
  const a = store.readMachineFile("away");
  const on = a?.on === true;
  return { on, since: on ? a.since ?? null : null, by: on ? a.by ?? null : null, last: a?.last ?? null };
}
export const isAway = () => awayState().on;

/** Tasks that landed or closed between `since` and `until`, oldest first: what got done while the owner was away. */
export function doneBetween(since, until) {
  return store.listHomes().flatMap((h) => store.listTasks(h))
    .filter((t) => (t.state === "landed" || t.state === "closed") && (t.stateAt ?? 0) >= since && (t.stateAt ?? 0) <= until)
    .sort((a, b) => a.stateAt - b.stateAt)
    .map((t) => ({ ref: refOf(t), title: t.title, state: t.state, at: t.stateAt, pr: t.pr ?? null }));
}

/**
 * Turns away mode on or off for client `by` ("the terminal", "cockpit"). Turning it off keeps the spell that ended as
 * `last`, with what got done in it; turning it on starts a new one. Held items stay held until answered either way.
 * Returns { away, already }, or null when the record stayed busy.
 */
export function setAway(on, by, now = Date.now()) {
  const r = store.updateMachineFile("away", (raw) => {
    const was = raw?.on === true;
    if (was === on) return { value: raw, out: { already: true } };
    const value = on
      ? { on: true, since: now, by, last: null }
      : { on: false, since: null, by: null, last: { since: raw.since ?? now, until: now, done: doneBetween(raw.since ?? now, now) } };
    return { value, out: { already: false } };
  });
  if (!r) return null;
  // An approval not yet used is only for while the owner is away: once back, the worker's request shows to them.
  if (!on && !r.out.already) store.updateMachineFile("grants", () => ({ value: null, out: true }));
  return { away: awayState(), already: r.out.already };
}

// ---------------------------------------------------------------- held requests

/** A tool's input as a held item keeps it: long strings cut, and an input still too big down to its gist. */
export function trimInput(input) {
  const cut = (v, depth) => {
    if (typeof v === "string") return store.clip(v, INPUT_STRING_MAX);
    if (Array.isArray(v)) return depth > 3 ? "[...]" : v.slice(0, 50).map((x) => cut(x, depth + 1));
    if (v && typeof v === "object") return depth > 3 ? "{...}" : Object.fromEntries(Object.entries(v).slice(0, 50).map(([k, x]) => [k, cut(x, depth + 1)]));
    return v;
  };
  const out = cut(input && typeof input === "object" ? input : {}, 0);
  if (JSON.stringify(out).length <= INPUT_MAX) return out;
  const { what, why } = describe({ name: "", input });
  return { ...(what ? { gist: what } : {}), ...(why ? { description: why } : {}), trimmed: true };
}

/** What a request is, for matching a grant: its tool and its input without the agent's own words about it. */
export function matchKey(tool, input) {
  const i = input && typeof input === "object" ? input : {};
  const stable = (v) => (Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v);
  const { description, ...rest } = i;
  // Every other field counts (a command's sandbox or background flag changes what it does); only its edge spaces do not.
  if (typeof rest.command === "string") rest.command = rest.command.trim();
  return `${tool}\n${JSON.stringify(stable(rest))}`;
}

/**
 * Whether an approval of held `item` can let the worker's next matching request through. Not when the owner saw only
 * part of it (its input was cut to fit), and not when it names nothing to match (a Codex file change that lists no
 * files): then the approval reaches the worker as words, and the request asks again.
 */
export const grantable = (item) => !item.truncated && !String(item.key ?? "").endsWith("\n{}");

/** One plain line a person reads: the command, `Edit src/a.ts`, or the tool and what it names. */
export function summaryOf(t, tool, input) {
  const i = input && typeof input === "object" ? input : {};
  if (typeof i.command === "string" && i.command.trim()) return store.clip(store.oneLine(i.command), 300);
  const file = i.file_path ?? i.notebook_path ?? i.path;
  if (typeof file === "string" && file) {
    const rel = t?.worktree && file.startsWith(`${t.worktree}/`) ? relative(t.worktree, file) : file;
    return store.clip(`${tool} ${rel}`, 300);
  }
  const { what } = describe({ name: tool, input: i });
  return store.clip(what ? `${tool} ${what}` : tool, 300);
}

/** The held list as the snapshot shows it: every item still held, and those answered in the last hour, oldest first. */
export function heldView(now = Date.now()) {
  const items = store.readMachineFile("held");
  return (Array.isArray(items) ? items : [])
    .filter((x) => x.state === "held" || now - (x.answer?.at ?? 0) < HOUR)
    .map(({ key, ...x }) => x);
}

/** The items to keep: all still held, and those answered in the last day. */
const kept = (items, now) => items.filter((x) => x.state === "held" || now - (x.answer?.at ?? 0) < DAY);

/**
 * Holds task `t`'s permission request: saves it to the held list and tells the owner once (a `notice` a phone
 * pushes). The same request asked again while it is still held is the same item, with no second notice.
 * Returns { item, fresh }, or null when the list stayed busy.
 */
export function holdRequest(t, { harness, tool, input, now = Date.now() }) {
  const ref = refOf(t);
  const key = matchKey(tool, input);
  const r = store.updateMachineFile("held", (raw) => {
    const items = kept(Array.isArray(raw) ? raw : [], now);
    const same = items.find((x) => x.ref === ref && x.state === "held" && x.key === key);
    if (same) return { value: items, out: { item: same, fresh: false } };
    const reason = typeof input?.description === "string" && input.description.trim() ? store.clip(store.oneLine(input.description), 300) : null;
    const shown = trimInput(input);
    const item = {
      id: `h-${now}-${randomBytes(3).toString("hex")}`, ref, home: t.home, at: now, harness, tool, input: shown,
      summary: summaryOf(t, tool, input), reason, state: "held", answer: null, key,
      // The owner sees `input`: when it had to be cut, what they approve is not all of what would run.
      truncated: JSON.stringify(shown) !== JSON.stringify(input && typeof input === "object" ? input : {}),
    };
    return { value: [...items, item], out: { item, fresh: true } };
  });
  if (!r) return null;
  const { item, fresh } = r.out;
  if (fresh) {
    store.appendStatus(t.home, t.id, { ev: "held", id: item.id, tool });
    notify(`${nameOf(t.id)} held a request (${t.home})`, `${label(t)} asked for ${tool}: ${item.summary}. Held until you answer it.`, { tag: { kind: "held", ref, held: item.id } });
  }
  return { item, fresh };
}

/** The note the worker reads in place of the prompt it would have shown. */
export const holdNote = (item, fresh) =>
  `${P} The owner is away, so this request is held for them${fresh ? "" : " (it was held already)"}: ${item.summary}. ` +
  "Do not try another way round it (another tool, command or path to the same end). Carry on with the work that does not need it, " +
  "and mention it in your final report. If the owner approves it, you hear so as your next prompt; then run it again and it goes through.";

// ---------------------------------------------------------------- grants

/** A one-time approval for task `ref`'s request `key`, good for a day. Returns whether it was saved. */
function grant(ref, tool, key, now) {
  return !!store.updateMachineFile("grants", (raw) => {
    const live = (Array.isArray(raw) ? raw : []).filter((g) => g.until > now);
    return { value: [...live, { ref, tool, key, at: now, until: now + DAY }], out: true };
  });
}

/** Whether task `ref` holds a grant for this request; one that matches is used up. */
export function takeGrant(ref, tool, input, now = Date.now()) {
  const raw = store.readMachineFile("grants");
  if (!Array.isArray(raw) || !raw.length) return false;
  const key = matchKey(tool, input);
  const r = store.updateMachineFile("grants", (list) => {
    const live = (Array.isArray(list) ? list : []).filter((g) => g.until > now);
    const i = live.findIndex((g) => g.ref === ref && g.key === key);
    if (i >= 0) live.splice(i, 1);
    return { value: live.length ? live : null, out: i >= 0 };
  });
  return r?.out === true;
}

/**
 * A task worker's permission request (Claude Code's PermissionRequest hook, a Codex approval request): what rollcall
 * decides for it. { allow: true } for a request the owner approved (its grant is used up), { deny: note, item } for one
 * held while the owner is away, or null to let the prompt show as it always did.
 */
export function permissionDecision(t, { tool, input, harness = "claude" }, now = Date.now()) {
  if (!t || !tool || NOT_HELD.has(tool)) return null;
  if (takeGrant(refOf(t), tool, input, now)) return { allow: true };
  if (!isAway()) return null;
  const h = holdRequest(t, { harness, tool, input, now });
  return h ? { deny: holdNote(h.item, h.fresh), item: h.item } : null;
}

// ---------------------------------------------------------------- answers

/**
 * Words for task `ref`'s worker from the owner's answer: a note on the task, then the words as its next prompt (the
 * queue `task.tell` uses, which wakes an idle worker and resumes a stopped one). A finished task's worker is left be.
 * Returns { delivered, how, why }.
 */
export function deliverToTask(ref, text, note, by) {
  const { home, id } = parse(ref);
  const t = store.readTask(home, id);
  if (!t) return { delivered: false, how: null, why: `no task ${ref}` };
  if (!isOpen(t)) return { delivered: false, how: null, why: `${label(t)} is ${t.state}` };
  const record = () => store.withTasksLock(home, () => {
    const x = store.readTask(home, id);
    if (!x) return;
    x.notes.push({ at: Date.now(), by, text: store.clip(note, 4000) });
    store.writeTask(x);
  });
  const r = deliverWords(t, text, { record, mode: holderOf(home)?.mode ?? null });
  return { delivered: r.ok, how: r.how ?? null, why: r.why ?? null };
}

const ASKS_AGAIN = " (rollcall could not approve it ahead of time, so it asks again: shown to the owner, or held again while they are away)";
const approvedText = (items) => (items.length === 1
  ? `The owner approved your held request: ${items[0].summary}. Run it now${grantable(items[0]) ? "" : ASKS_AGAIN}.`
  : `The owner approved your held requests:\n${items.map((x, i) => `${i + 1}. ${x.summary}${grantable(x) ? "" : ASKS_AGAIN}`).join("\n")}\nRun them now.`);
const deniedText = (item, why) => `The owner denied your held request: ${item.summary}.${why ? ` Their words: ${why}` : ""}`;

/**
 * The owner's answer to held item `id` from `by`: approve (`allow`) or deny, with their words (`why`). The first
 * answer wins: { code: "not-found" }, { already: true, item } when it was answered already, or
 * { already: false, item, delivered, how, why }. An approval leaves a grant for the worker's next matching request.
 */
export function answerHeld(id, { allow, why = null, by, all = false, now = Date.now() }) {
  const r = store.updateMachineFile("held", (raw) => {
    const items = kept(Array.isArray(raw) ? raw : [], now);
    const item = items.find((x) => x.id === id);
    if (!item) return { value: items, out: { code: "not-found" } };
    if (item.state !== "held") return { value: items, out: { already: true, item } };
    Object.assign(item, { state: allow ? "approved" : "denied", answer: { at: now, by, allow: !!allow, why: why || null, all } });
    return { value: items, out: { already: false, item } };
  });
  if (!r) return { code: "busy" };
  if (r.out.code) return r.out;
  if (r.out.already) return { already: true, item: strip(r.out.item) };
  const { item } = r.out;
  if (allow && grantable(item) && !grant(item.ref, item.tool, item.key, now)) {
    reopen([item.id]);
    return { code: "busy" };
  }
  const d = deliverToTask(item.ref, allow ? approvedText([item]) : deniedText(item, why), `held request ${allow ? "approved" : "denied"} by the owner (${by}): ${item.summary}${why ? ` - ${why}` : ""}`, by);
  return { already: false, item: strip(item), ...d };
}

const strip = ({ key, ...x }) => x;

/** Puts answered items back to held: their approval could not be saved, so it never happened. */
function reopen(ids) {
  store.updateMachineFile("held", (raw) => {
    const items = Array.isArray(raw) ? raw : [];
    for (const item of items) if (ids.includes(item.id) && item.state === "approved") Object.assign(item, { state: "held", answer: null });
    return { value: items, out: true };
  });
}

/**
 * Approves every held item (of supervisor `home` alone, when given): a grant each, and one message per task listing
 * what was approved. Returns { approved: ids, count }, or null when the list stayed busy.
 */
export function allowAll({ home = null, by, now = Date.now() }) {
  const r = store.updateMachineFile("held", (raw) => {
    const items = kept(Array.isArray(raw) ? raw : [], now);
    const mine = items.filter((x) => x.state === "held" && (!home || x.home === home));
    for (const item of mine) Object.assign(item, { state: "approved", answer: { at: now, by, allow: true, why: null, all: true } });
    return { value: items, out: mine.map((x) => ({ ...x })) };
  });
  if (!r) return null;
  const failed = r.out.filter((item) => grantable(item) && !grant(item.ref, item.tool, item.key, now));
  if (failed.length) reopen(failed.map((x) => x.id));
  const approved = r.out.filter((x) => !failed.includes(x));
  const byTask = new Map();
  for (const item of approved) byTask.set(item.ref, [...(byTask.get(item.ref) ?? []), item]);
  for (const [ref, items] of byTask) {
    deliverToTask(ref, approvedText(items), `held requests approved by the owner (${by}, allow all): ${items.map((x) => x.summary).join("; ")}`, by);
  }
  return { approved: approved.map((x) => x.id), count: approved.length };
}
