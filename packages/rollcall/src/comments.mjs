// Review comments: the owner's line comments on a running task's diff. Each names a file and a line or range of the
// task's worktree, with the diff hunk it was written against and the lines it was written on (plus a little
// context), so it still finds its place after the code moves, or says it went stale. They wait as pending until the
// owner (or the supervisor for them) sends them: all pending ones go to the worker as ONE item on its delivery queue
// (delivery.mjs), so the receipt and retry rules apply, and Claude and Codex workers get them alike. The worker
// resolves each (what it changed) or replies (an answer, which closes it, or with --open leaves it for the owner).
//
// They live in the home file `comments-<id>.json` ({ next, items }), under the home's lock like the outbox, not on
// the task record, which many writers rewrite.
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { gitSync } from "./git.mjs";
import { enqueue, outbox } from "./delivery.mjs";
import { P, cli } from "./session.mjs";
import { isOpen } from "./state.mjs";
import * as store from "./store.mjs";
import { pump } from "./supervisor.mjs";
import { author, mayWrite, resolve, take } from "./task.mjs";

const FILE = (id) => `comments-${id}`;
/** Lines of context kept on each side of the commented lines, and shown around them in the batch. */
const CONTEXT = 2;
/** The most lines one comment may cover: a comment on a whole file goes in a note. */
const MAX_LINES = 200;
const MAX_TEXT = 4000;
const MAX_HUNK = 120;

export const readComments = (h, id) => store.readHomeFile(h, FILE(id)) ?? { next: 1, items: [] };

/** Runs `fn` on the task's comments under the home's lock and writes them back. Returns fn's result, or fails. */
function edit(t, ctx, fn) {
  const r = store.withHomeLock(t.home, () => {
    const all = readComments(t.home, t.id);
    const out = fn(all);
    store.writeHomeFile(t.home, FILE(t.id), all);
    return out;
  });
  if (!r) ctx.fail("the task store is busy; try again");
  return r.out;
}

const linesOf = (text) => {
  const l = text.split("\n");
  if (l.length && l.at(-1) === "") l.pop();
  return l;
};

function readLines(t, file) {
  try { return linesOf(readFileSync(join(t.worktree, file), "utf8")); } catch { return null; }
}

/** `<file>:<line>[-<end>]`, with the file relative to the worktree (an absolute path inside it is fine). */
function parseWhere(t, arg, ctx) {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(arg ?? "");
  if (!m) ctx.fail(`where the comment goes: <file>:<line> or <file>:<line>-<end line>, like src/app.js:42 (got "${arg ?? ""}")`);
  const abs = isAbsolute(m[1]) ? m[1] : resolvePath(t.worktree, m[1]);
  const file = relative(t.worktree, abs);
  if (!file || file.startsWith(`..${sep}`) || file === ".." || isAbsolute(file)) ctx.fail(`${m[1]} is not inside ${t.id}'s worktree (${t.worktree})`);
  let st = null;
  try { st = statSync(abs); } catch {}
  if (!st?.isFile()) ctx.fail(`${file} does not exist in ${t.id}'s worktree (${t.worktree})`);
  const lines = readLines(t, file) ?? [];
  const line = Number(m[2]);
  const end = m[3] === undefined ? line : Number(m[3]);
  if (line < 1 || line > lines.length) ctx.fail(`${file} has ${lines.length} line${lines.length === 1 ? "" : "s"}: there is no line ${line}`);
  if (end < line || end > lines.length) ctx.fail(`${file}:${line}-${end}: the range ends ${end < line ? "before it starts" : `past the file's last line (${lines.length})`}`);
  if (end - line + 1 > MAX_LINES) ctx.fail(`a comment covers at most ${MAX_LINES} lines: put a comment on a whole file in a note`);
  return { file, line, end, lines };
}

/** The commit the task's diff starts from: where its branch left its base, else its first commit, else HEAD. */
function diffBase(t) {
  const mb = t.base && gitSync(t.worktree, ["merge-base", "HEAD", t.base]);
  if (mb?.status === 0 && mb.stdout.trim()) return mb.stdout.trim();
  return t.baseSha || "HEAD";
}

/** The diff hunk of `file` (worktree against the task's base) that holds lines line..end, or null where the lines are unchanged. */
export function hunkAt(t, file, line, end) {
  const tracked = gitSync(t.worktree, ["ls-files", "--error-unmatch", "--", file]).status === 0;
  const r = tracked
    ? gitSync(t.worktree, ["diff", "--no-color", "--no-ext-diff", diffBase(t), "--", file])
    : gitSync(t.worktree, ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", file]);
  const out = r.stdout ?? "";
  const hunks = out.split(/^(?=@@ )/m).slice(1);
  for (const h of hunks) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(h);
    if (!m) continue;
    const from = Number(m[1]);
    const to = from + Number(m[2] ?? 1) - 1;
    if (line <= to && end >= from) {
      const l = linesOf(h);
      return l.length > MAX_HUNK ? [...l.slice(0, MAX_HUNK), `... (${l.length - MAX_HUNK} more lines)`].join("\n") : l.join("\n");
    }
  }
  return null;
}

// ---------------------------------------------------------------- where a comment sits now

const same = (a, b) => (a ?? "").trim() === (b ?? "").trim();
const matchAt = (lines, at, want) => want.every((x, i) => same(lines[at + i], x));

/**
 * Where comment `c`'s lines sit in the worktree now: { at: "here" | "moved" | "stale", line, end, lines (the file's) }.
 * Lines still at the recorded place stay; lines that moved go to the nearest place that holds them all, the one whose
 * context matches best; lines no longer anywhere (edited, deleted, the file gone) are stale.
 */
export function locate(t, c) {
  const lines = readLines(t, c.file);
  if (!lines) return { at: "stale", why: "the file is gone", line: c.line, end: c.end, lines: null };
  const want = c.anchor.lines;
  const span = want.length;
  const blank = want.every((x) => !x.trim());
  const fits = (p) => matchAt(lines, p, want) && (!blank || (matchAt(lines, p - c.anchor.before.length, c.anchor.before) && matchAt(lines, p + span, c.anchor.after)));
  const at0 = c.line - 1;
  if (fits(at0)) return { at: "here", line: c.line, end: c.end, lines };
  const score = (p) => c.anchor.before.filter((x, i) => same(lines[p - c.anchor.before.length + i], x)).length + c.anchor.after.filter((x, i) => same(lines[p + span + i], x)).length;
  let best = null;
  for (let p = 0; p + span <= lines.length; p++) {
    if (!fits(p)) continue;
    const s = score(p);
    const d = Math.abs(p - at0);
    if (!best || s > best.s || (s === best.s && d < best.d)) best = { p, s, d };
  }
  if (!best) return { at: "stale", why: `the line${span === 1 ? " is" : "s are"} no longer in ${c.file}`, line: c.line, end: c.end, lines };
  return { at: "moved", line: best.p + 1, end: best.p + span, lines };
}

const range = (line, end) => (end > line ? `${line}-${end}` : `${line}`);
/** "src/a.js:3", "src/a.js:5 (was line 3)", or "src/a.js:3 (stale: ...)". */
function whereNow(c, loc) {
  if (loc.at === "here") return `${c.file}:${range(c.line, c.end)}`;
  if (loc.at === "moved") return `${c.file}:${range(loc.line, loc.end)} (was ${range(c.line, c.end) === String(c.line) ? "line" : "lines"} ${range(c.line, c.end)})`;
  return `${c.file}:${range(c.line, c.end)} (stale: ${loc.why})`;
}

/** The commented lines, numbered and marked, with CONTEXT lines around them: where they are now, or as written when stale. */
function excerpt(c, loc) {
  const pad = (n) => String(n).padStart(5);
  if (loc.at === "stale") {
    const out = [];
    const first = c.line - c.anchor.before.length;
    [...c.anchor.before, ...c.anchor.lines, ...c.anchor.after].forEach((x, i) => {
      const n = first + i;
      out.push(`${n >= c.line && n <= c.end ? ">" : " "}${pad(n)}  ${x}`);
    });
    return out.join("\n");
  }
  const from = Math.max(1, loc.line - CONTEXT);
  const to = Math.min(loc.lines.length, loc.end + CONTEXT);
  const out = [];
  for (let n = from; n <= to; n++) out.push(`${n >= loc.line && n <= loc.end ? ">" : " "}${pad(n)}  ${loc.lines[n - 1]}`);
  return out.join("\n");
}

// ---------------------------------------------------------------- commands

const isWorker = (by) => /^worker\b/.test(by);
const textArg = (args) => { const s = args.join(" "); return s === "-" ? readFileSync(0, "utf8") : s; };
const byLabel = (by) => (by === "a shell" ? "the owner" : by === "supervisor" ? "the owner, through the supervisor" : by);

/** `task comment <id|here> <file>:<line>[-<end>] "<text>"`: the owner's comment, pending until sent. */
export function addComment(args, ctx) {
  const t = resolve(args.shift(), ctx);
  const where = args.shift();
  const text = textArg(args).trim();
  if (!text) ctx.fail('usage: rollcall task comment <id|here> <file>:<line>[-<end>] "<text>" (or - with the text on stdin)');
  if (text.length > MAX_TEXT) ctx.fail(`a comment is ${text.length} characters, over the limit of ${MAX_TEXT}: shorten it, or split it in two`);
  const g = ctx.whoAmI();
  mayWrite(t, g, ctx);
  const by = author(t, g);
  if (isWorker(by)) ctx.fail(`review comments are the owner's, for ${t.id}'s worker to answer: answer one with \`${cli()} task comments ${t.id} reply <n> "<answer>"\``);
  if (!isOpen(t)) ctx.fail(`${t.id} is ${t.state}: a finished task takes no review comments (new work is a new task)`);
  if (!t.worktree) ctx.fail(`${t.id} has no worktree to comment on`);
  const { file, line, end, lines } = parseWhere(t, where, ctx);
  const anchor = {
    before: lines.slice(Math.max(0, line - 1 - CONTEXT), line - 1),
    lines: lines.slice(line - 1, end),
    after: lines.slice(end, end + CONTEXT),
  };
  const hunk = hunkAt(t, file, line, end);
  const now = Date.now();
  const c = edit(t, ctx, (all) => {
    const x = { n: all.next, file, line, end, text, by, at: now, base: diffBase(t), hunk, anchor, state: "pending", sentAt: null, item: null, reply: null, resolved: null };
    all.next += 1;
    all.items.push(x);
    return x;
  });
  const pending = readComments(t.home, t.id).items.filter((x) => x.state === "pending").length;
  ctx.say(`${t.id}: comment #${c.n} on ${file}:${range(line, end)}${hunk ? "" : " (a line the task has not changed)"}; ${pending} waiting to be sent: \`${cli()} task comments ${t.id} send\``);
  return 0;
}

/** The text of one batch: every comment in it, each with enough to act on without reading the diff again. */
export function batchText(t, items) {
  const rc = cli();
  const head = [
    `${P} ${items.length === 1 ? "A review comment" : `${items.length} review comments`} from the owner on task ${t.id}'s diff. Each is their own words for this task: act on it, then answer it with one of these, so the task shows it closed:`,
    `- you changed the code: \`${rc} task comments ${t.id} resolve <n> "<what you changed>"\``,
    `- no change needed, or a question answered: \`${rc} task comments ${t.id} reply <n> "<your answer>"\` (this closes it)`,
    `- only the owner can decide: \`${rc} task comments ${t.id} reply <n> "<your question>" --open\` (it stays open, and the supervisor asks them)`,
    `\`${rc} task comments ${t.id}\` lists them with where each sits now.`,
  ];
  const body = items.map((c) => {
    const loc = locate(t, c);
    const stale = loc.at === "stale" ? `\nThese lines changed since the owner wrote this (${loc.why}); they were as below. Decide whether it still applies, and say so when you answer.` : "";
    return `#${c.n} ${whereNow(c, loc)}${stale}\n${excerpt(c, loc)}\n${byLabel(c.by)[0].toUpperCase()}${byLabel(c.by).slice(1)}: ${c.text}`;
  });
  return [...head, "", body.join("\n\n")].join("\n");
}

/** `task comments <id|here> [send | resolve <n> "<text>" | reply <n> "<text>" [--open]] [--json]`. */
export function commentsCommand(args, ctx) {
  const t = resolve(args.shift(), ctx);
  const json = take(args, "--json");
  const sub = args.shift();
  if (!sub) return list(t, json, ctx);
  if (sub === "send") return send(t, ctx);
  if (sub === "resolve" || sub === "reply") return answer(t, sub, args, ctx);
  ctx.fail(`task comments: "${sub}" is not one of send, resolve, reply (rollcall task comments --help)`);
}

function send(t, ctx) {
  const g = ctx.whoAmI();
  mayWrite(t, g, ctx);
  if (isWorker(author(t, g))) ctx.fail("the owner sends review comments; a worker answers them");
  if (!isOpen(t)) ctx.fail(`${t.id} is ${t.state}: a finished task's worker takes no review comments`);
  const now = Date.now();
  // Marked sent under the lock first, so two sends never put the same comment out twice. The queue takes the
  // home's lock itself, so the item goes on after this one is released.
  const sent = edit(t, ctx, (all) => {
    // A send that died between this mark and its queue left its comments sent with no item: they go again.
    const items = all.items.filter((x) => x.state === "pending" || (x.state === "sent" && !x.item && now - (x.sentAt ?? 0) > 60_000));
    for (const cm of items) Object.assign(cm, { state: "sent", sentAt: now });
    return items;
  });
  if (!sent.length) ctx.fail(`${t.id} has no comments waiting to be sent (\`${cli()} task comments ${t.id}\` lists them)`);
  const ns = sent.map((x) => x.n);
  const text = batchText(t, sent);
  const item = enqueue(t, "notice", text, now);
  const queued = !!item;
  edit(t, ctx, (all) => {
    for (const cm of all.items) if (ns.includes(cm.n) && cm.sentAt === now) Object.assign(cm, queued ? { item } : { state: "pending", sentAt: null });
  });
  if (!queued) ctx.fail("the task store stayed busy: nothing was sent; try again");
  const r = pump(t, now);
  const how = r.typed ? "typed into its worker" : r.err ? `on its queue (typing failed: ${r.err}; rollcall tries again)` : "on its queue: rollcall types them in once its worker can take them";
  ctx.say(`${t.id}: ${sent.length} comment${sent.length === 1 ? "" : "s"} (${sent.map((x) => `#${x.n}`).join(", ")}) sent as one message, ${how}`);
  return 0;
}

function answer(t0, sub, args, ctx) {
  const open = take(args, "--open");
  const n = Number(args.shift());
  const text = textArg(args).trim();
  if (!Number.isInteger(n) || n < 1 || !text) ctx.fail(`usage: rollcall task comments <id|here> ${sub} <n> "<${sub === "resolve" ? "what you changed" : "your answer"}>"${sub === "reply" ? " [--open]" : ""}`);
  if (open && sub !== "reply") ctx.fail("--open goes with reply: a resolved comment is closed");
  if (text.length > MAX_TEXT) ctx.fail(`that is ${text.length} characters, over the limit of ${MAX_TEXT}`);
  const g = ctx.whoAmI();
  mayWrite(t0, g, ctx);
  const by = author(t0, g);
  const now = Date.now();
  const c = edit(t0, ctx, (all) => {
    const cm = all.items.find((y) => y.n === n);
    if (!cm) return null;
    if (sub === "reply") cm.reply = { at: now, by, text };
    cm.state = open ? "answered" : "resolved";
    cm.resolved = open ? null : { at: now, by, how: sub === "resolve" ? "fixed" : "answered", text };
    return { ...cm };
  });
  if (!c) ctx.fail(`${t0.id} has no comment #${n} (\`${cli()} task comments ${t0.id}\` lists them)`);
  // A question for the owner goes the way a worker's reply does: a note, which wakes the supervisor.
  if (open && isWorker(by)) {
    store.withTasksLock(t0.home, () => {
      const t = store.readTask(t0.home, t0.id);
      if (!t) return;
      t.notes.push({ at: now, by, text: `reply: on review comment #${c.n} (${c.file}:${range(c.line, c.end)}, "${store.clip(store.oneLine(c.text), 120)}"): ${text}` });
      store.writeTask(t);
    });
    store.enqueueWake(t0.home, { task: t0.id, kind: "reply", note: now });
  }
  const left = readComments(t0.home, t0.id).items.filter((x) => x.state !== "resolved").length;
  ctx.say(`${t0.id}: comment #${c.n} ${c.state === "resolved" ? `resolved (${c.resolved.how})` : "answered, left open for the owner"}; ${left ? `${left} still open` : "none open"}`);
  return 0;
}

/** One comment for a listing: its state and where it sits now. */
export function view(t, c) {
  const loc = c.state === "resolved" ? null : locate(t, c);
  const delivered = c.state === "sent" && !!c.item && !outbox(t.home, t.id).some((x) => x.id === c.item);
  return {
    n: c.n, state: c.state, file: c.file, line: c.line, end: c.end, text: c.text, by: c.by, at: c.at,
    delivered: c.state === "sent" ? delivered : c.state !== "pending",
    now: loc ? { at: loc.at, line: loc.line, end: loc.end, ...(loc.why ? { why: loc.why } : {}) } : null,
    reply: c.reply, resolved: c.resolved, hunk: c.hunk,
  };
}

function list(t, json, ctx) {
  const items = readComments(t.home, t.id).items.map((c) => view(t, c));
  if (json) { ctx.say(JSON.stringify({ task: t.id, comments: items }, null, 2)); return 0; }
  if (!items.length) { ctx.say(`${t.id}: no review comments`); return 0; }
  for (const c of items) {
    const state = c.state === "sent" ? (c.delivered ? "sent" : "sent, not yet typed in") : c.state;
    const where = c.now ? whereNow(c, c.now) : `${c.file}:${range(c.line, c.end)}`;
    ctx.say(`#${c.n} ${state.padEnd(9)} ${where}  ${byLabel(c.by)}: ${store.clip(store.oneLine(c.text), 160)}`);
    if (c.reply) ctx.say(`     ${c.reply.by === "worker" ? "its worker" : byLabel(c.reply.by)} replied: ${store.clip(store.oneLine(c.reply.text), 300)}`);
    if (c.resolved && c.resolved.how === "fixed") ctx.say(`     resolved: ${store.clip(store.oneLine(c.resolved.text), 300)}`);
  }
  const pending = items.filter((c) => c.state === "pending").length;
  if (pending) ctx.say(`${pending} not sent yet: \`${cli()} task comments ${t.id} send\``);
  return 0;
}

/** A line for `task show`: what is open of the task's comments, or null when it has none. */
export function commentsLine(t) {
  const items = readComments(t.home, t.id).items;
  if (!items.length) return null;
  const by = (s) => items.filter((c) => c.state === s).length;
  const open = items.length - by("resolved");
  const stale = items.filter((c) => c.state !== "resolved" && locate(t, c).at === "stale").length;
  const parts = [by("pending") && `${by("pending")} not sent`, by("sent") && `${by("sent")} with its worker`, by("answered") && `${by("answered")} answered, waiting on the owner`, stale && `${stale} stale`].filter(Boolean);
  return `review comments: ${open ? `${open} open (${parts.join(", ")})` : "none open"}, ${by("resolved")} resolved: \`${cli()} task comments ${t.id}\``;
}

