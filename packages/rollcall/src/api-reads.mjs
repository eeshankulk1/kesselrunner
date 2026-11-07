// The front-end interface's reads for review and shipping (cockpit's review and ship panels): a task's diff against
// main, its turns and a restore, where the owner's comments sit now, its PR's timeline (checks with their times,
// deployments, review threads, the merge queue, main's checks), a failed check's log, a repo's open issues, PRs and
// branches, and a run action's log. Each answers from git, gh and rollcall's own records, so a front end never runs
// git or gh itself. api-actions.mjs lists them beside the actions; they throw its ApiError.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { actionState, actionsDir } from "./checkout.mjs";
import { locate as commentAt, readComments, view as commentView } from "./comments.mjs";
import { defaultBranch, gitSync, locate, mainCheckout, repoKey } from "./git.mjs";
import { checksOf, gh } from "./queue.mjs";
import { listTurns, richDiff, worktreeNowTree, worktreeOf } from "./snapshot.mjs";
import * as store from "./store.mjs";
import { graphql, listThreads } from "./threads.mjs";

export const PATCH_MAX = 1024 * 1024;
const LOG_MAX = 512 * 1024;
const RUN_LOG_TAIL = 64 * 1024;
const RUN_LOG_MAX = 256 * 1024;

const ms = (iso) => (iso ? Date.parse(iso) || null : null);
const cut = (patch) => (patch.length > PATCH_MAX ? { patch: patch.slice(0, PATCH_MAX), truncated: true } : { patch, truncated: false });

/** gh's failure as an API error: `unavailable` when gh is missing or logged out, else `failed` with its words. */
export function ghError(err, refuse) {
  const e = String(err ?? "");
  if (/ENOENT/.test(e)) refuse("unavailable", "gh (GitHub's CLI) is not installed");
  if (/gh auth login|not logged in|authentication/i.test(e)) refuse("unavailable", `gh is not logged in: run gh auth login (${store.clip(store.oneLine(e), 200)})`);
  refuse("failed", store.clip(e || "gh failed", 2000));
}

/** Where gh and git run for task `t`: its worktree while it has one, else its repo's main checkout. */
function placeOf(t) {
  const wt = t.worktree && locate(t.worktree);
  if (wt) return t.worktree;
  if (t.repo?.main && locate(t.repo.main)) return t.repo.main;
  return null;
}

// ---------------------------------------------------------------- task.diff

/**
 * Task `t`'s diff: `base` (where its branch left the default branch, to its worktree's files now), `committed`
 * (that point to HEAD) or `uncommitted` (HEAD to its files now, untracked ones included, ignored ones left out).
 */
export async function taskDiff(t, against, refuse) {
  const wt = t.worktree ? worktreeOf(t.worktree) : null;
  if (!wt) refuse("refused", `task ${t.id} has no worktree to diff${t.archived ? " (it is archived)" : ""}`);
  const top = wt.top;
  const rev = (r) => { const x = gitSync(top, ["rev-parse", "-q", "--verify", `${r}^{commit}`]); return x.status === 0 ? x.stdout.trim() : null; };
  const head = rev("HEAD");
  if (!head) refuse("failed", `${top} has no commit at HEAD`);
  const def = defaultBranch(wt.info);
  let base = null;
  let from = head;
  if (against !== "uncommitted") {
    const local = ["main", "master"].find((b) => rev(`refs/heads/${b}`));
    const tries = [def && [`origin/${def}`, def], local && [local, local], t.base && [t.base, t.base.replace(/^origin\//, "")], t.baseSha && [t.baseSha, null]].filter(Boolean);
    const found = tries.find(([ref]) => { const mb = gitSync(top, ["merge-base", "HEAD", ref]); if (mb.status === 0 && mb.stdout.trim()) { from = mb.stdout.trim(); return true; } return false; });
    if (!found) refuse("failed", `${top}: no default branch or base to compare with`);
    base = found[1] ?? def;
  } else base = def;
  let d;
  try {
    if (against === "committed") d = richDiff(wt, from, head, { inWorktree: true });
    else d = richDiff(wt, from, await worktreeNowTree(wt));
  } catch (e) { refuse("failed", e.message); }
  return { against, from, to: against === "committed" ? head : "worktree", base, files: d.files, ...cut(d.patch) };
}

// ---------------------------------------------------------------- turns.list

/** Task `t`'s turns, oldest first: { n, at, session, kind, files, restored }. */
export function turnsOf(t, refuse) {
  const wt = t.worktree ? worktreeOf(t.worktree) : null;
  if (!wt) refuse("refused", `task ${t.id} has no linked worktree with turns${t.archived ? " (it is archived)" : ""}`);
  return listTurns(wt.top).map(({ n, at, session, kind, files, restored }) => ({ n, at, session, kind, files, restored }));
}

// ---------------------------------------------------------------- review.comments

/** The owner's comments on task `t`'s diff, each with where it sits now (`now: null` once its lines are gone). */
export function commentsNow(t) {
  return readComments(t.home, t.id).items.map((c) => {
    const v = commentView(t, c);
    const loc = c.state === "resolved" ? commentAt(t, c) : v.now;
    const gone = !loc || loc.at === "stale";
    return {
      n: c.n, state: c.state, file: c.file, line: c.line, end: c.end, text: c.text, by: c.by, at: c.at, sentAt: c.sentAt ?? null,
      delivered: v.delivered, reply: c.reply ?? null, resolved: c.resolved ?? null, hunk: c.hunk ?? null,
      now: gone ? null : { file: c.file, line: loc.line, end: loc.end, moved: loc.at === "moved" },
      stale: gone ? loc?.why ?? "its lines are gone" : null,
    };
  });
}

// ---------------------------------------------------------------- pr.timeline

const CHECK = `__typename
  ... on CheckRun { databaseId name status conclusion startedAt completedAt detailsUrl checkSuite { workflowRun { workflow { name } } } }
  ... on StatusContext { context state targetUrl createdAt }`;
const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number url title state isDraft mergeStateStatus headRefOid baseRefName createdAt mergedAt closedAt
      reviews(last: 100) { nodes { author { login __typename } state submittedAt url } }
      commits(last: 1) { nodes { commit {
        statusCheckRollup { contexts(first: 100) { nodes { ${CHECK} } } }
        deployments(last: 20) { nodes { environment createdAt state latestStatus { state environmentUrl logUrl createdAt } } }
      } } }
    }
    defaultBranchRef { name target { ... on Commit { oid statusCheckRollup { contexts(first: 100) { nodes { ${CHECK} } } } } } }
  }
}`;

/** One check run or commit status as the timeline shows it. */
function checkOf(c) {
  if (c.__typename === "StatusContext") {
    const done = !["PENDING", "EXPECTED"].includes(c.state);
    return {
      name: c.context, workflow: null, state: done ? "completed" : "in_progress",
      conclusion: done ? (c.state === "SUCCESS" ? "success" : "failure") : null,
      startedAt: ms(c.createdAt), completedAt: done ? ms(c.createdAt) : null, link: c.targetUrl ?? null, id: null,
    };
  }
  const status = String(c.status ?? "").toLowerCase();
  return {
    name: c.name, workflow: c.checkSuite?.workflowRun?.workflow?.name ?? null,
    state: status === "completed" ? "completed" : status === "in_progress" ? "in_progress" : "queued",
    conclusion: c.conclusion ? String(c.conclusion).toLowerCase() : null,
    startedAt: ms(c.startedAt), completedAt: ms(c.completedAt), link: c.detailsUrl ?? null, id: c.databaseId ?? null,
  };
}

/** The PR's number from its URL. */
const prNumber = (t) => Number(/\/pull\/(\d+)/.exec(t.pr ?? "")?.[1]) || null;

/** Task `t`'s PR and main, as GitHub has them now: { cwd, pr (GraphQL), main (GraphQL) }. */
function fetchPr(t, refuse) {
  const number = prNumber(t);
  if (!number) refuse("not-found", "no PR");
  const cwd = placeOf(t);
  if (!cwd) refuse("refused", `task ${t.id} has no checkout to ask GitHub from`);
  const r = graphql(cwd, PR_QUERY, { owner: "{owner}", name: "{repo}", number });
  if (r.err) ghError(r.err, refuse);
  const pr = r.data?.repository?.pullRequest;
  if (!pr) refuse("not-found", `no PR #${number} in ${t.repo?.name ?? "its repo"}`);
  return { cwd, number, pr, main: r.data.repository.defaultBranchRef ?? null };
}

const checksIn = (commit) => (commit?.statusCheckRollup?.contexts?.nodes ?? []).map(checkOf);

/** Task `t`'s PR timeline: the PR, its checks, deployments and review threads, a merged event list, its queue place and main's state. */
export function prTimeline(t, refuse, now = Date.now()) {
  const { cwd, number, pr, main } = fetchPr(t, refuse);
  const head = pr.commits?.nodes?.[0]?.commit ?? null;
  const checks = checksIn(head);
  const deployments = (head?.deployments?.nodes ?? []).map((d) => ({
    environment: d.environment ?? null,
    state: String(d.latestStatus?.state ?? d.state ?? "").toLowerCase() || null,
    url: d.latestStatus?.environmentUrl || null, logUrl: d.latestStatus?.logUrl || null,
    at: ms(d.latestStatus?.createdAt ?? d.createdAt),
  }));
  const th = listThreads(cwd, number);
  if (th.err) ghError(th.err, refuse);
  const threads = th.threads.map((x) => ({
    id: x.id, file: x.path, line: x.line, author: x.by, bot: x.bot, body: x.comments[0]?.body ?? "", resolved: x.resolved, outdated: x.outdated,
    url: x.url, at: ms(x.comments[0]?.at), replies: Math.max(0, x.comments.length - 1),
    comments: x.comments.map((c) => ({ author: c.by, bot: c.bot, body: c.body, url: c.url, at: ms(c.at) })),
  }));

  // The merge queue: this PR's place, and what the lander said of it (on the task's notes, and in the queue's outcomes).
  const q = t.repo?.key ? store.readQueue(t.repo.key) : null;
  const waiting = q ? Object.values(q.entries).sort((a, b) => a.at - b.at) : [];
  const at = waiting.findIndex((e) => e.pr === number);
  const queue = at < 0 ? null : { position: at + 1, length: waiting.length, state: waiting[at].state, line: t.queueLine ?? null };

  const events = [];
  const add = (when, kind, text, url = null) => { if (when) events.push({ at: when, kind, text, url }); };
  add(ms(pr.createdAt), "opened", `#${pr.number} opened: ${pr.title}`, pr.url);
  for (const c of checks) if (c.completedAt) add(c.completedAt, "check", `${c.name}: ${c.conclusion ?? "done"}`, c.link);
  for (const d of deployments) add(d.at, "deploy", `${d.environment ?? "deploy"}: ${d.state ?? "?"}`, d.url ?? d.logUrl);
  for (const r of pr.reviews?.nodes ?? []) add(ms(r.submittedAt), "review", `${r.author?.login ?? "ghost"}: ${String(r.state ?? "").toLowerCase().replace(/_/g, " ")}`, r.url ?? null);
  for (const x of threads) add(x.at, "thread", `${x.author} on ${x.file ?? "the PR"}${x.line ? `:${x.line}` : ""}: ${store.clip(store.oneLine(x.body), 140)}`, x.url);
  const said = (t.notes ?? []).filter((n) => /^merge queue: /.test(n.text ?? ""));
  for (const n of said) add(n.at, "queue", n.text.replace(/^merge queue: /, ""));
  for (const o of q?.outcomes ?? []) {
    if (o.pr !== number || said.some((n) => Math.abs(n.at - o.at) < 5000)) continue;
    add(o.at, "queue", `${o.kind}: ${store.clip(store.oneLine(o.text ?? ""), 300)}`);
  }
  if (pr.mergedAt) add(ms(pr.mergedAt), "merged", `#${pr.number} merged`, pr.url);
  else if (pr.state === "CLOSED") add(ms(pr.closedAt), "closed", `#${pr.number} closed`, pr.url);
  events.sort((a, b) => a.at - b.at);

  const mainChecks = main?.target?.statusCheckRollup?.contexts?.nodes ?? [];
  const m = checksOf(mainChecks);
  return {
    pr: {
      url: pr.url, number: pr.number, title: pr.title, state: pr.state, draft: !!pr.isDraft, mergeState: pr.mergeStateStatus ?? null,
      headSha: pr.headRefOid, baseBranch: pr.baseRefName, createdAt: ms(pr.createdAt), mergedAt: ms(pr.mergedAt),
    },
    checks, deployments, threads, events, queue,
    main: main ? {
      branch: main.name, sha: main.target?.oid ?? null,
      state: m.failed.length ? "failing" : m.pending.length ? "pending" : m.passed.length ? "passing" : "none",
      failed: m.failed,
    } : null,
    at: now,
  };
}

// ---------------------------------------------------------------- check.log

/** The log of one of task `t`'s PR checks (`id` from pr.timeline, or `name`): its failed steps, else the whole job. */
export function checkLog(t, { id = null, name = null }, refuse) {
  const { cwd, pr } = fetchPr(t, refuse);
  const all = checksIn(pr.commits?.nodes?.[0]?.commit);
  const c = id !== null ? all.find((x) => x.id === id) : all.filter((x) => x.name === name).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
  if (!c) refuse("not-found", id !== null ? `no check ${id} on #${pr.number}'s head` : `no check named "${name}" on #${pr.number}'s head`);
  if (!c.id || !/\/actions\/runs\/\d+/.test(c.link ?? "")) refuse("refused", `${c.name} is not a GitHub Actions job, so it has no log here: ${c.link ?? "it gives no link"}`);
  const opts = { timeout: 120_000, maxBuffer: 256 * 1024 * 1024 };
  let r = gh(cwd, ["run", "view", "--job", String(c.id), "--log-failed"], opts);
  if (!r.ok || !r.out.trim()) {
    const whole = gh(cwd, ["run", "view", "--job", String(c.id), "--log"], opts);
    if (!whole.ok) ghError(r.ok ? whole.err : r.err || whole.err, refuse);
    r = whole;
  }
  const log = r.out.length > LOG_MAX ? r.out.slice(-LOG_MAX) : r.out;
  return { name: c.name, id: c.id, url: c.link, log, truncated: log.length < r.out.length };
}

// ---------------------------------------------------------------- repo.items

/** A repo's open issues and PRs (newest updated first) and origin's branches (newest commit first), for picking a task's start. */
export function repoItems(path, refuse) {
  const info = locate(path);
  if (!info) refuse("bad-payload", `repo is not a path inside a git repo: ${path}`);
  const main = mainCheckout(info);
  const { key, name } = repoKey(info);
  const list = (args) => {
    const r = gh(main, args);
    if (!r.ok) ghError(r.err, refuse);
    try { return JSON.parse(r.out) ?? []; } catch { refuse("failed", `gh printed no JSON: ${store.clip(r.out, 120)}`); }
  };
  const byUpdate = (a, b) => (ms(b.updatedAt) ?? 0) - (ms(a.updatedAt) ?? 0);
  const issues = list(["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title,url,author,labels,updatedAt"]).sort(byUpdate)
    .map((i) => ({ number: i.number, title: i.title, url: i.url, author: i.author?.login ?? null, labels: (i.labels ?? []).map((l) => l.name), updatedAt: ms(i.updatedAt) }));
  const prs = list(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,url,headRefName,author,isDraft,updatedAt"]).sort(byUpdate)
    .map((p) => ({ number: p.number, title: p.title, url: p.url, branch: p.headRefName, author: p.author?.login ?? null, draft: !!p.isDraft, updatedAt: ms(p.updatedAt) }));
  // origin's branches as this machine last fetched them, fetched again first (quietly: a failure keeps what it has).
  gitSync(main, ["fetch", "--quiet", "--no-tags", "origin"], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" }, timeout: 20_000 });
  const def = defaultBranch(info);
  const refs = gitSync(main, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(committerdate:unix)", "refs/remotes/origin/"]);
  const branches = (refs.status === 0 ? refs.stdout : "").split("\n").filter(Boolean).map((l) => {
    const [ref, at] = l.split("\0");
    return { name: ref.slice("refs/remotes/origin/".length), at: Number(at) * 1000 || null };
  }).filter((b) => b.name !== "HEAD" && b.name !== def).slice(0, 100);
  return { repo: { key, name }, issues, prs, branches };
}

// ---------------------------------------------------------------- task.run log

/** Part of a run action's log: from `offset` (default: its last 64 KB) to its end, at most 256 KB a call. */
export function runLog(t, name, offset, refuse) {
  if (!t.worktree || t.archived) refuse("refused", `task ${t.id} has no worktree${t.archived ? " (it is archived)" : ""}`);
  const top = locate(t.worktree)?.top;
  if (!top) refuse("refused", `task ${t.id}'s worktree is gone`);
  const path = actionState(top, name)?.log ?? join(actionsDir(top), `${name}.log`);
  let fd;
  try { fd = openSync(path, "r"); } catch { refuse("not-found", `run action ${name} has no log yet`); }
  try {
    const size = fstatSync(fd).size;
    const asked = offset ?? Math.max(0, size - RUN_LOG_TAIL);
    // An offset past the end: the action started again with a fresh log, so it reads from the start.
    const from = asked > size ? 0 : asked;
    const len = Math.min(RUN_LOG_MAX, size - from);
    const buf = Buffer.alloc(len);
    const got = len ? readSync(fd, buf, 0, len, from) : 0;
    return { name, log: buf.subarray(0, got).toString("utf8"), offset: from + got, size, truncated: offset === null ? from > 0 : asked > size, more: from + got < size };
  } finally { closeSync(fd); }
}
