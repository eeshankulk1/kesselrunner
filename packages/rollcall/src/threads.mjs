// A PR's review threads, through gh's GraphQL API: what people and bot reviewers left on the diff. The shipping
// worker reads the open ones along with its checks, fixes or answers each, and resolves what it fixed; the merge
// queue takes no PR with open threads unless the owner said so, and the lander sends a PR back when one opens
// after it joined. Claude Code's /autofix-pr runs in a cloud session and resolves no thread, so a local worker
// needs these.
//   thread = { id, resolved, outdated, path, line, by, bot, url, comments: [{ by, bot, body, url, at }] }
// A bot's thread that repeats one already answered or resolved (same bot, same path, same text ignoring
// whitespace) counts as answered: it never blocks, and the worker is not handed it again.
import { gitSync, locate } from "./git.mjs";
import { gh, prLook } from "./queue.mjs";
import { P } from "./session.mjs";
import * as store from "./store.mjs";
import { taskAt } from "./task.mjs";

export const USAGE = `  rollcall pr threads [<pr>] [--all] [--json]
                                         the PR's open review threads (people and bot reviewers): file, line, who,
                                         what, and the thread id to answer. Default PR: this branch's (or task's).
                                         A bot's repeat of a thread already answered or resolved is not shown.
                                         --all: resolved threads and bot repeats too
  rollcall pr reply <thread-id> "<text>" [--resolve]
                                         answer a thread on GitHub (--resolve: and resolve it)
  rollcall pr resolve <thread-id>...     resolve threads whose point the pushed change fixed`;

const THREADS = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine
          comments(first: 50) { nodes { author { login __typename } body url createdAt } }
        }
      }
    }
  }
}`;
const REPLY = `mutation($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { url } }
}`;
const RESOLVE = `mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;

/** One GraphQL call through gh: { data } or { err }. `{owner}` and `{repo}` are gh's: the repo of `cwd`. */
export function graphql(cwd, query, fields = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  // -F types numbers and fills gh's placeholders; -f keeps text as text (a body starting with @ is not a file).
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) args.push(typeof v === "number" || k === "owner" || k === "name" ? "-F" : "-f", `${k}=${v}`);
  const r = gh(cwd, args);
  if (!r.ok) return { err: r.err || "gh api graphql failed" };
  try {
    const j = JSON.parse(r.out);
    if (j.errors?.length) return { err: j.errors.map((e) => e.message).join("; ") };
    return { data: j.data };
  } catch { return { err: `gh printed no JSON: ${store.clip(r.out, 120)}` }; }
}

const isBot = (a) => a?.__typename === "Bot" || /\[bot\]$/.test(a?.login ?? "");
const same = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function shape(n) {
  const comments = (n.comments?.nodes ?? []).map((c) => ({ by: c.author?.login ?? "ghost", bot: isBot(c.author), body: c.body ?? "", url: c.url ?? null, at: c.createdAt ?? null }));
  const first = comments[0] ?? { by: "ghost", bot: false, url: null };
  return { id: n.id, resolved: !!n.isResolved, outdated: !!n.isOutdated, path: n.path ?? null, line: n.line ?? n.originalLine ?? null, by: first.by, bot: first.bot, url: first.url, comments };
}

/** Every review thread on PR `number` in `cwd`'s repo: { threads } or { err }. */
export function listThreads(cwd, number) {
  const threads = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const r = graphql(cwd, THREADS, { owner: "{owner}", name: "{repo}", number: Number(number), after });
    if (r.err) return { err: r.err };
    const rt = r.data?.repository?.pullRequest?.reviewThreads;
    if (!rt) return { err: `no PR #${number} in this repo` };
    threads.push(...(rt.nodes ?? []).map(shape));
    if (!rt.pageInfo?.hasNextPage) break;
    after = rt.pageInfo.endCursor;
  }
  return { threads };
}

/** Answered: resolved, or someone other than whoever opened it replied. */
const answered = (t) => t.resolved || t.comments.slice(1).some((c) => c.by !== t.by);

/**
 * Threads sorted out: `open` (unresolved, what the worker acts on and what blocks the queue), `repeats` (a bot's
 * unresolved thread that says again what an answered or resolved one of the same bot on the same path said),
 * `resolved`.
 */
export function sortThreads(threads) {
  const out = { open: [], repeats: [], resolved: [] };
  for (const t of threads) {
    if (t.resolved) { out.resolved.push(t); continue; }
    const text = same(t.comments[0]?.body);
    const repeat = t.bot && threads.some((u) => u !== t && u.bot && u.by === t.by && u.path === t.path && answered(u) && same(u.comments[0]?.body) === text);
    (repeat ? out.repeats : out.open).push(t);
  }
  return out;
}

/** PR `number`'s threads sorted out ({ open, repeats, resolved }), or { err }. */
export function prThreads(cwd, number) {
  const r = listThreads(cwd, number);
  return r.err ? r : sortThreads(r.threads);
}

/** One line naming a thread: where, who, what it says, its id. */
export function threadLine(t, n = 140) {
  const where = t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "the PR";
  const last = t.comments.at(-1);
  const replies = t.comments.length > 1 ? ` (${t.comments.length - 1} repl${t.comments.length === 2 ? "y" : "ies"}, last by ${last.by})` : "";
  return `${where}, ${t.by}${t.bot ? " (bot)" : ""}${t.outdated ? ", outdated" : ""}: "${store.clip(store.oneLine(t.comments[0]?.body ?? ""), n)}"${replies} [${t.id}]`;
}

/** Answers thread `id` on GitHub: { url } or { err }. */
export function replyThread(cwd, id, body) {
  const r = graphql(cwd, REPLY, { id, body });
  return r.err ? r : { url: r.data?.addPullRequestReviewThreadReply?.comment?.url ?? null };
}

/** Resolves thread `id`: { ok } or { err }. */
export function resolveThread(cwd, id) {
  const r = graphql(cwd, RESOLVE, { id });
  return r.err ? r : { ok: !!r.data?.resolveReviewThread?.thread?.isResolved };
}

// ---------------------------------------------------------------- CLI

/** The PR a bare `rollcall pr threads` means: this branch's open one, else the task's. */
function whichPr(ctx, ref) {
  const info = locate(process.cwd());
  if (!info) ctx.fail("not inside a git checkout (cd into the repo, or pass -C <dir>)");
  const branch = gitSync(info.top, ["symbolic-ref", "-q", "--short", "HEAD"]).stdout?.trim();
  const refs = ref ? [ref] : [branch, taskAt(info.top)?.pr].filter(Boolean);
  if (!refs.length) ctx.fail("no branch here and no task PR: name the PR (rollcall pr threads <number>)");
  let err = null;
  for (const x of refs) {
    const r = prLook(info.top, x);
    if (r.pr && (ref || r.pr.state === "OPEN")) return { top: info.top, pr: r.pr };
    err = r.err ?? `#${r.pr.number} is ${r.pr.state.toLowerCase()}`;
  }
  ctx.fail(`no open PR for ${ref ?? branch ?? "this task"}: ${err}`);
}

export function prCommand(args, ctx) {
  const [sub, ...rest] = args;
  switch (sub) {
    case "threads": return threadsCmd(rest, ctx);
    case "reply": return replyCmd(rest, ctx);
    case "resolve": return resolveCmd(rest, ctx);
    case undefined: case "-h": case "--help": case "help": ctx.say(USAGE); return 0;
    default: ctx.fail(`pr: unknown command "${sub}"\n${USAGE}`);
  }
  return 1;
}

function threadsCmd(args, ctx) {
  const json = args.includes("--json");
  const all = args.includes("--all");
  const rest = args.filter((a) => a !== "--json" && a !== "--all");
  if (rest.length > 1 || rest.some((a) => a.startsWith("-"))) ctx.fail(`pr threads: unknown argument "${rest.find((a) => a.startsWith("-")) ?? rest[1]}"`);
  const { top, pr } = whichPr(ctx, rest[0]);
  const r = prThreads(top, pr.number);
  if (r.err) ctx.fail(`could not read #${pr.number}'s review threads: ${r.err}`);
  if (json) { ctx.say(JSON.stringify({ pr: pr.number, url: pr.url, ...(all ? r : { open: r.open, repeats: r.repeats.length, resolved: r.resolved.length }) }, null, 2)); return 0; }
  ctx.say(`${P} #${pr.number}: ${r.open.length} open review thread${r.open.length === 1 ? "" : "s"}${r.repeats.length ? `, ${r.repeats.length} bot repeat${r.repeats.length === 1 ? "" : "s"} of answered ones` : ""}, ${r.resolved.length} resolved`);
  r.open.forEach((t, i) => ctx.say(`  ${i + 1}. ${threadLine(t, 400)}`));
  if (all) {
    for (const t of r.repeats) ctx.say(`  repeat: ${threadLine(t)}`);
    for (const t of r.resolved) ctx.say(`  resolved: ${threadLine(t)}`);
  }
  if (r.open.length) ctx.say(`${P} fix or answer each: rollcall pr reply <thread-id> "<what changed, or why not>" [--resolve]; once a fix is pushed, rollcall pr resolve <thread-id>`);
  return 0;
}

function replyCmd(args, ctx) {
  const resolve = args.includes("--resolve");
  const [id, ...words] = args.filter((a) => a !== "--resolve");
  const body = words.join(" ").trim();
  if (!id || !body) ctx.fail('usage: rollcall pr reply <thread-id> "<text>" [--resolve]');
  const top = locate(process.cwd())?.top ?? process.cwd();
  const r = replyThread(top, id, body);
  if (r.err) ctx.fail(`could not answer ${id}: ${r.err}`);
  ctx.say(`${P} answered ${id}${r.url ? `: ${r.url}` : ""}`);
  if (!resolve) return 0;
  const s = resolveThread(top, id);
  if (s.err || !s.ok) ctx.fail(`answered, but could not resolve ${id}: ${s.err ?? "GitHub did not mark it resolved"}`);
  ctx.say(`${P} resolved ${id}`);
  return 0;
}

function resolveCmd(args, ctx) {
  if (!args.length) ctx.fail("usage: rollcall pr resolve <thread-id>...");
  const top = locate(process.cwd())?.top ?? process.cwd();
  let bad = 0;
  for (const id of args) {
    const r = resolveThread(top, id);
    if (r.err || !r.ok) { bad++; process.stderr.write(`rollcall: could not resolve ${id}: ${r.err ?? "GitHub did not mark it resolved"}\n`); }
    else ctx.say(`${P} resolved ${id}`);
  }
  return bad ? 1 : 0;
}
