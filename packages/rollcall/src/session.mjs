// Session identity, liveness and the per-repo record, shared by hooks and CLI.
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { branch, defaultBranch, mainCheckout, mainSha } from "./git.mjs";
import { findHarness, pidAlive, sameProcess } from "./proc.mjs";
import * as store from "./store.mjs";

export const P = "[rollcall]";
export const short = (id) => String(id).slice(0, 8);

/** Alive = the harness process exists. Says nothing about whether anyone is using it. */
export const isAlive = (s) => !!s && !s.endedAt && pidAlive(s.pid, s.pidStart);
/** isAlive, and surely that process (it runs `ps`): for a claim that can outlast its id, such as a supervisor's name. */
export const isHolding = (s) => isAlive(s) && sameProcess(s.pid, s.pidStart);
/** Live = alive and active recently. Only a live session can cause a deny. */
export const isLive = (s, now = Date.now()) => now - (s?.seen ?? 0) < store.staleMs() && isAlive(s);

/** Said `done` (or ended) and has not claimed or edited anything since. */
export const isDone = (r) => !!r.endedAt || (!!r.doneAt && !r.claim && (r.editedAt ?? 0) <= r.doneAt);

/**
 * One family = the same harness process (e.g. before and after /clear) or one
 * harness running inside the other (a nested `claude -p`, a delegated worker).
 * A family never blocks or warns itself.
 */
export function family(a, b) {
  if (!a?.pid || !b?.pid) return false;
  return a.pid === b.pid || (a.ancestors ?? []).includes(b.pid) || (b.ancestors ?? []).includes(a.pid);
}

/**
 * Other sessions' records in a repo, `me`'s family excluded, and so is any session `me` continues: sending a
 * session to the background goes on under a new id in a new process, while the old process lives on as the
 * agent view, and the old record must not block or warn the conversation it became.
 */
export function peersOf(key, me, { alive = false } = {}) {
  return store.listRecords(key).filter((r) => r.id !== me.id && !family(r, me) && (!alive || isAlive(r)) && !(currentSession(r.id)?.id === me.id && isAlive(r)));
}

/**
 * When `rec` started its continuous presence in `top`: its recorded `since` if
 * it is still live there, else now. A session that ended, crashed and was
 * resumed in a new process, or went stale rejoins as a newcomer, so it can
 * never retroactively outrank a session that took the checkout meanwhile.
 */
export const presenceSince = (rec, top, now) => (rec?.checkout === top && isLive(rec, now) ? rec.since : now);

/**
 * The session's global record, creating it (and detecting the harness pid)
 * on first contact. Detection re-runs at SessionStart and when the recorded
 * pid has died (a resumed session in a new process), at most once a minute.
 */
export function ensureSession(payload, { redetect = false } = {}) {
  const id = payload.session_id;
  const now = Date.now();
  let g = store.readGlobal(id);
  const due = !g || redetect || (!pidAlive(g.pid) && now - (g.detectedAt ?? 0) > 60_000);
  if (due) {
    const h = findHarness();
    const codex = /codex/i.test(h?.name ?? "") || /[/\\]\.codex[/\\]/.test(payload.transcript_path ?? "");
    g = {
      id, startedAt: now, repos: [], firstPrompt: null, ...g,
      pid: h?.pid ?? null, pidStart: h?.start ?? null, ancestors: h?.ancestors ?? [], harness: codex ? "codex" : "claude",
      detectedAt: now, endedAt: null,
    };
    store.writeGlobal(g);
  }
  // The transcript says whether Claude Code continued this session under another id (successorOf).
  if (typeof payload.transcript_path === "string" && payload.transcript_path && g.transcript !== payload.transcript_path) {
    g = { ...g, transcript: payload.transcript_path };
    store.writeGlobal(g);
  }
  return g;
}

/** How much of a transcript's end successorOf reads. */
const TAIL_BYTES = 32 * 1024;

/**
 * The id of the session that continued `g`, or null. Sending a session to the background continues it
 * in a new process under a new id and name, and ends the old transcript with a `continued-in` record,
 * while the old process can live on (as the agent view), so a live pid proves nothing about who holds
 * the conversation. A record followed by more conversation means the old id was resumed again.
 */
export function successorOf(g) {
  if (!g?.transcript) return null;
  let fd;
  try {
    fd = openSync(g.transcript, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/"type":"(user|assistant)"/.test(lines[i])) return null;
      const m = /"type":"continued-in".*"continuedInSessionId":"([0-9a-f-]{8,})"/.exec(lines[i]);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** `id`'s record, or the record of the session that continued it, followed to the end of the chain. */
export function currentSession(id) {
  let g = id ? store.readGlobal(id) : null;
  for (let hops = 0; g && hops < 8; hops++) {
    const next = successorOf(g);
    if (!next || next === g.id) break;
    g = store.readGlobal(next) ?? { id: next, pid: null, endedAt: null };
  }
  return g;
}

/**
 * This session's record in `repo`, created on first contact. `move` says
 * whether this contact relocates the session to `info.top`:
 *   "edit": an edit there (always moves);
 *   "cwd":  the session's cwd is there (moves only until it has edited in this repo);
 *   false:  keep the recorded checkout (denied edits, subagents).
 * `edit` marks an edit in `info.top`: once the session has edited in its own
 * checkout (a subagent's edit there counts), only another edit moves it.
 * Seniority (`since`) follows presenceSince: it restarts on a move and whenever
 * the record was not live, so the continuously present session owns a checkout.
 */
export function joinRepo(g, info, repo, now, move, edit = move === "edit") {
  let rec = store.readRecord(repo.key, g.id);
  if (!rec) {
    const sha = mainSha(info);
    rec = {
      id: g.id, checkout: info.top, gitDir: info.gitDir, main: mainCheckout(info),
      since: now, idle: null, claim: null, lastIntent: null, doneAt: null, editedAt: null,
      baseMain: sha, mainSha: sha, mainN: 0, notified: [], overlaps: [], cursor: store.logEnd(repo.key),
      allowShared: [], waits: [], endedAt: null,
    };
    // After /clear the same harness process continues under a new session id: it keeps its predecessor's seniority.
    for (const r of store.listRecords(repo.key)) {
      if (g.pid && r.pid === g.pid && r.checkout === info.top && now - (r.seen ?? 0) < store.staleMs()) rec.since = Math.min(rec.since, r.since);
    }
    if (!g.repos.includes(repo.key)) { g.repos.push(repo.key); store.writeGlobal(g); }
  } else {
    rec.since = presenceSince(rec, rec.checkout, now);
    rec.endedAt = null;
    if (rec.checkout !== info.top && (move === "edit" || (move === "cwd" && !rec.editedAt))) {
      Object.assign(rec, { checkout: info.top, gitDir: info.gitDir, main: mainCheckout(info), since: now });
    }
  }
  if (edit && rec.checkout === info.top) rec.editedAt = now;
  Object.assign(rec, {
    pid: g.pid, pidStart: g.pidStart, ancestors: g.ancestors, harness: g.harness, repoName: repo.name, seen: now,
    firstPrompt: rec.firstPrompt ?? g.firstPrompt ?? null,
  });
  rec.branch = branch({ gitDir: rec.gitDir }) ?? rec.branch ?? null;
  return rec;
}

/** Emits `done` for `rec` and releases its claim. */
export function markDone(key, rec, summary, extra) {
  store.appendEvent(key, { type: "done", session: rec.id, who: who(rec), intent: rec.claim?.intent ?? null, summary });
  Object.assign(rec, { claim: null, ...extra });
}

const MAX_NOTIFIED = 400;
/** Dedupe for derived notices: `key` is a fact already told to this session. */
export function remember(rec, key) {
  rec.notified.push(key);
  if (rec.notified.length > MAX_NOTIFIED) rec.notified.splice(0, rec.notified.length - MAX_NOTIFIED);
}

/**
 * Records that this session has heard `e` (a done event), whichever way it
 * arrived (its `wait` or its hooks): the dependency is released and the same
 * done is never told twice. Returns false when it was already heard.
 */
export function settle(rec, e) {
  rec.waits = rec.waits.filter((id) => id !== e.session);
  const key = `done:${e.session}:${e.ts}`;
  if (rec.notified.includes(key)) return false;
  remember(rec, key);
  return true;
}

// ---------------------------------------------------------------- wording

/** A claim sets lastIntent too, and `done` keeps it, so this names the current or last task. */
export const intentOf = (r) => r.lastIntent || r.firstPrompt || "no task described yet";

/** `"intent" [scope, ...]` */
export const claimLabel = (intent, scope) => `"${intent}"${scope?.length ? ` [${scope.join(", ")}]` : ""}`;

export function whereOf(r) {
  if (!r.checkout) return "?";
  if (r.checkout === r.main) return "main checkout";
  const rel = r.main && relative(r.main, r.checkout);
  return rel && !rel.startsWith("..") ? rel : r.checkout;
}

/** "3f9a1c2e (feat/x, .claude/worktrees/x)" */
export const who = (r) => `${short(r.id)} (${[r.branch, whereOf(r)].filter(Boolean).join(", ")})`;

/** A message event as one notice line; the sender is labelled so its words never pass for the user's. */
export function msgLine(e, suffix = "") {
  const from = e.session === "user" ? "a shell outside any agent session" : `${e.who} (their words, not the user's)`;
  return `${P} message from ${from}${suffix}: ${JSON.stringify(e.text)}`;
}
export const doneLine = (e) => `${P} ${e.who} is done: ${e.summary}`;

export function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fileList(files, max = 4) {
  const shown = files.slice(0, max).join(", ");
  return files.length > max ? `${shown} (+${files.length - max} more)` : shown;
}

/** First meaningful line of a prompt, tags stripped, capped for one-line labels. */
export function trimPrompt(p) {
  const line = String(p ?? "").replace(/<[^>]*>/g, "\n").split("\n").map((s) => s.trim()).find(Boolean);
  return line ? store.clip(store.oneLine(line), 72) : null;
}

export function autoSummary(rec, touched) {
  const files = touched.length ? `; edited ${touched.length} file${touched.length === 1 ? "" : "s"}: ${fileList(touched)}` : "";
  return `${intentOf(rec)} (${rec.branch ?? "no branch"})${files}`;
}

export const BIN = fileURLToPath(new URL("../bin/rollcall.mjs", import.meta.url));
let cliCommand;

/** How to invoke the CLI from an agent's shell: `rollcall` when on PATH, else node + absolute path. */
export function cli() {
  cliCommand ??= (process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(join(dir, "rollcall"))) ? "rollcall" : `node "${BIN}"`;
  return cliCommand;
}

/** The command that starts a task worktree: named for the task, on its own branch, from origin's default branch. */
export function worktreeCommand(info, slug = "<slug>", branchName = `<type>/${slug}`) {
  const main = mainCheckout(info);
  const b = defaultBranch(info);
  const base = b && mainSha(info, b) ? ` origin/${b}` : "";
  return `git -C "${main}" worktree add "${main}/.claude/worktrees/${slug}" -b ${branchName}${base}`;
}
