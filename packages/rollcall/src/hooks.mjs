// Hook handlers. Each returns the hook's stdout (a JSON string) or null.
// Local file I/O only on the hot path (PreToolUse, PostToolUse); git runs only
// when origin/main actually moved, and the fetch is detached.
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  configValue, defaultBranch, diffNames, dirtyPaths, fetchDetached, isMainCheckout, locate, mainCheckout, mainSha, mergeConflicts,
  remoteUrl, repoKey, safeName,
} from "./git.mjs";
import { spawnDetached } from "./proc.mjs";
import { matchScope } from "./glob.mjs";
import { gitMutations } from "./shell.mjs";
import {
  BIN, P, ago, autoSummary, claimLabel, cli, doneLine, ensureSession, fileList, intentOf, isAlive, isDone, isLive,
  joinRepo, markDone, msgLine, peersOf, presenceSince, remember, settle, short, trimPrompt, who, worktreeCommand,
} from "./session.mjs";
import * as store from "./store.mjs";
import { sameWords } from "./asked.mjs";
import { hostedHome } from "./host/client.mjs";
import { answeredElsewhere, droppedPick, joinLines, markAnswered, pickLine, questionId } from "./answer.mjs";
import { PICTURE, picturesFindable, picturesLater } from "./pictures.mjs";
import { MENTION, tempDenial } from "./temp.mjs";
import * as tmux from "./tmux.mjs";
import { ACCOUNT_ERRORS, deliverWords, ensureWatcher, homeOf, idOf, inheritHome, label, nameOf, pruneHomes, taskEnv, taskOfQuestion } from "./supervisor.mjs";
import { isOpen } from "./state.mjs";
import { SKILL, ownerNews, prOpened, recordWords, skillStamp, taskAt } from "./task.mjs";
import { openBlocker, resetAt } from "./trouble.mjs";
import { turnEnded, turnFailed, turnReady, turnStarted } from "./watch.mjs";

const HOOKS = {
  "session-start": ["SessionStart", sessionStart],
  "prompt-submit": ["UserPromptSubmit", promptSubmit],
  "pre-tool-use": ["PreToolUse", preToolUse],
  "post-tool-use": ["PostToolUse", postToolUse],
  stop: ["Stop", stop],
  "stop-failure": ["StopFailure", stopFailure],
  "session-end": ["SessionEnd", sessionEnd],
};
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Handlers return notice lines, `{ deny }`, `{ stop }` (a prompt kept from the model, and why), or null. */
export function runHook(arg, payload) {
  const [event, handler] = HOOKS[arg] ?? [];
  if (!handler || !payload?.session_id) return null;
  const out = handler(payload, Date.now());
  // continue:false shows the owner's line and the reason, clears the prompt box and makes no model call
  // (a blocked prompt goes back into the box); the model reads both lines on its next turn.
  if (out?.stop) return JSON.stringify({ continue: false, stopReason: out.stop });
  if (out?.deny) {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: out.deny } });
  }
  return out?.length ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: out.join("\n") } }) : null;
}

// A subagent's activity (payload carries agent_id) counts as the session's, but never
// relocates it: a worktree-isolated subagent must not cost its parent the parent's checkout.
const focusOn = (p, info, kind) => (info ? { info, repo: repoKey(info), move: p.agent_id ? false : kind, edit: kind === "edit" } : null);
// Notices go to the main thread only: a subagent's hooks leave them unread for its parent.
const deliverTo = (p) => !p.agent_id;
const cwdOf = (p) => (typeof p.cwd === "string" && p.cwd) || process.cwd();
const cwdFocus = (p) => focusOn(p, locate(cwdOf(p)), "cwd");

function editFocus(p) {
  const ti = p.tool_input ?? {};
  const f = ti.file_path ?? ti.notebook_path ?? ti.path;
  if (typeof f !== "string" || !f) return null;
  return focusOn(p, locate(isAbsolute(f) ? f : resolve(cwdOf(p), f)), "edit");
}

/**
 * The live peer that owns `top` ahead of this session (earlier continuous
 * presence), if any. `mine` is this session's record in the repo (may be
 * null); a session that set allow-shared for `top` has no blocker there.
 */
function senior(peers, mine, id, top, now) {
  if (mine?.allowShared?.includes(top)) return null;
  const mySince = presenceSince(mine, top, now);
  return peers
    .filter((r) => r.checkout === top && isLive(r, now) && (r.since < mySince || (r.since === mySince && r.id < id)))
    .sort((a, b) => a.since - b.since)[0] ?? null;
}

/**
 * Other sessions in the repo, and the one (if any) that should stop this
 * session from changing `info.top`. The main checkout of a repo that opted
 * into main edits (`rollcall allow-main`, e.g. a notes repo every session
 * commits to) is a shared workspace by design: nobody owns it.
 */
function blocker(g, info, repo, now, mine = store.readRecord(repo.key, g.id)) {
  const others = peersOf(repo.key, g);
  if (isMainCheckout(info) && mainEditsAllowed(info)) return { others, owner: null };
  return { others, owner: senior(others, mine, g.id, info.top, now) };
}

function denial(what, owner, info, g, now) {
  return [
    `${P} ${what} blocked: session ${who(owner)} is already working in this checkout (${info.top}), last active ${ago(owner.seen, now)}: "${intentOf(owner)}".`,
    `${P} Work in your own worktree instead: ${worktreeCommand(info)} (type: feat, fix, refactor, test or docs), then cd into it and continue there.`,
    `${P} Only if the user wants both sessions in this checkout: ${cli()} -C "${info.top}" allow-shared. The user can switch rollcall off with ROLLCALL_DISABLE=1.`,
  ].join("\n");
}

/**
 * Agents edit in worktrees: a repo's main checkout is read-only for them unless
 * the repo opted out (`rollcall allow-main`, i.e. git config rollcall.mainEdits)
 * or ROLLCALL_MAIN_EDITS=allow. Repos without an origin (scratch repos, a fresh
 * `git init`) are exempt: there is no default branch to fork a worktree from.
 */
function mainGuarded(info) {
  if (store.envFlag("ROLLCALL_MAIN_EDITS") === true || !isMainCheckout(info)) return false;
  return !!remoteUrl(info) && !mainEditsAllowed(info);
}

const mainEditsAllowed = (info) => store.parseFlag(configValue(info, "rollcall", "mainEdits")) === true;

function mainDenial(info) {
  return [
    `${P} Edit blocked: agents work in a worktree, never in the main checkout of this repo (${info.top}).`,
    `${P} Start one for this task: ${worktreeCommand(info)} (type: feat, fix, refactor, test or docs), cd into it, run the test manifest's worktree.setup if it defines one, and continue there.`,
    `${P} Continuing a branch that already has a worktree: cd into it (git worktree list). Only if the user wants edits in this checkout: ${cli()} -C "${info.top}" allow-main.`,
  ].join("\n");
}

/**
 * Whether session `g` holds a home: a supervisor (`rollcall supervise`), or a cockpit chat (`chat`, host/chat.mjs
 * bindChat), which does its own work: its turns and its tasks' news are tracked as a supervisor's, its edits never denied.
 */
const holds = (g) => !!(g.supervisor || g.chat);

/** A supervisor (`rollcall supervise`) routes work to task workers and edits no project file, its subagents included. */
function supervisorDenial(info) {
  return [
    `${P} Edit blocked: this session is a supervisor, and a supervisor never edits project files (${info.top}).`,
    `${P} Hand the change to the task's worker (\`${cli()} task tell <id> "<message>"\`), or start a task for it (\`${cli()} task new\`). Only if the owner wants this session to edit again: ${cli()} supervise --off.`,
  ].join("\n");
}

/** Background `rollcall gc --report` for one repo; never waits. ROLLCALL_GC=0 turns it off. */
function gcDetached(main, args = []) {
  if (store.envFlag("ROLLCALL_GC") !== false) spawnDetached(process.execPath, [BIN, "-C", main, "gc", "--report", ...args]);
}

const agentWorktrees = (main) => join(main, ".claude", "worktrees");

/**
 * Background `rollcall turns take` (snapshot.mjs) for a session in a linked worktree; never waits, never in a
 * main checkout. ROLLCALL_SNAPSHOTS=0 turns it off.
 */
function snapshotDetached(info, args) {
  if (!info || isMainCheckout(info) || store.envFlag("ROLLCALL_SNAPSHOTS") === false) return;
  spawnDetached(process.execPath, [BIN, "-C", info.top, "turns", "take", "--quiet", ...args]);
}

// ---------------------------------------------------------------- SessionStart

function sessionStart(p, now) {
  const g = ensureSession(p, { redetect: true });
  // Now and then, in the background, the sessions nothing needs park (park.mjs): each start is a chance, since one begins often.
  if (store.envFlag("ROLLCALL_PARK") !== false && store.claimParkSlot(now)) spawnDetached(process.execPath, [BIN, "park", "--quiet"]);
  // Before the repo check: a supervisor often sits in no repo.
  const inherited = inheritHome(g, now);
  const h = homeOf(g.id);
  if (h) { turnReady(h, g, now); ensureWatcher(h); }
  const focus = cwdFocus(p);
  if (!focus) return inherited.length ? inherited : null;
  const { info, repo } = focus;
  // Turn 0: the worktree as this session found it, so its first turn's diff has a start (a no-op once there is one).
  if (!g.supervisor) snapshotDetached(info, ["--baseline", "--session", g.id]);
  store.prune(repo.key);
  store.pruneTasks(now);
  pruneHomes(now);
  const rec = store.withLock(repo.key, g.id, () => {
    const r = joinRepo(g, info, repo, now, focus.move);
    r.idle = null;
    store.writeRecord(repo.key, r);
    return r;
  });
  if (!rec) return null;

  const peers = peersOf(repo.key, rec, { alive: true });
  const lines = [...inherited, ...peers.slice(0, 5).map((r) => {
    const doing = r.claim ? `claimed ${claimLabel(r.claim.intent, r.claim.scope)}` : `"${intentOf(r)}"`;
    const state = isLive(r, now) ? `active ${ago(r.seen, now)}` : `idle since ${ago(r.seen, now)}`;
    return `${P} ${who(r)} is also in ${repo.name}, ${state}: ${doing}`;
  })];
  if (peers.length > 5) lines.push(`${P} ...and ${peers.length - 5} more (${cli()} status)`);
  const owner = senior(peers, rec, g.id, info.top, now);
  if (owner) {
    lines.push(`${P} ${short(owner.id)} is already working in this checkout, so your edits here will be blocked. Create a worktree before editing: ${worktreeCommand(info)}, then cd into it.`);
  } else if (mainGuarded(info)) {
    lines.push(`${P} This is the main checkout of ${repo.name}: read freely, but edits happen in a task worktree. Before the first edit: ${worktreeCommand(info)}, then cd into it.`);
  }
  const env = taskEnv();
  const task = env ? store.readTask(env.home, env.id) : taskAt(info.top);
  if (isOpen(task) && task.worktree !== mainCheckout(info)) {
    lines.push(`${P} This worktree belongs to task ${task.id} of supervisor ${task.home} ("${task.title}", ${task.state}): \`${cli()} task show ${task.id}${env ? "" : ` --home ${task.home}`}\` has the owner's words, notes and the last report.`);
  }
  for (const line of store.takeGcReport(repo.key)) lines.push(`${P} worktree gc: ${line}`);
  const main = mainCheckout(info);
  if (existsSync(agentWorktrees(main)) && store.claimGcSlot(repo.key, now)) gcDetached(main);
  return lines;
}

// ---------------------------------------------------------------- PreToolUse

function preToolUse(p, now) {
  if (p.tool_name === "Bash") return bashGuard(p, now);
  const focus = editFocus(p);
  if (!focus) return null;
  const { info, repo } = focus;
  const g = ensureSession(p);
  if (g.supervisor) return { deny: supervisorDenial(info) };
  const mine = store.readRecord(repo.key, g.id);
  // A session already editing this checkout (started before the rule, or while the repo allowed it) finishes there.
  if (mainGuarded(info) && !(mine?.checkout === info.top && mine.editedAt)) return { deny: mainDenial(info) };
  const { others, owner } = blocker(g, info, repo, now, mine);
  if (owner) {
    // Denied edits never move the session, but it is now known to be here.
    store.withLock(repo.key, g.id, () => store.writeRecord(repo.key, joinRepo(g, info, repo, now, false)));
    return { deny: denial("Edit", owner, info, g, now) };
  }
  // A short wait (exponential, ~125 ms at most) for the lock: parallel edits of one session must not drop each other's overlap warnings.
  return store.withLock(repo.key, g.id, () => {
    const rec = joinRepo(g, info, repo, now, focus.move, focus.edit);
    const lines = [];
    for (const r of others) {
      const key = `overlap:${r.id}:${info.rel}`;
      if (rec.notified.includes(key)) continue;
      const inClaim = r.claim?.scope?.length && matchScope(r.claim.scope, info.rel);
      if ((!inClaim && !store.readTouched(repo.key, r.id).includes(info.rel)) || !isAlive(r)) continue;
      remember(rec, key);
      if (!rec.overlaps.includes(r.id)) rec.overlaps.push(r.id);
      const how = inClaim ? "is inside the claim of" : "was also edited by";
      lines.push(`${P} ${info.rel} ${how} session ${who(r)}: "${intentOf(r)}". Coordinate before overlapping: ${cli()} send ${short(r.id)} "<message>".`);
    }
    store.writeRecord(repo.key, rec);
    return lines;
  }, { retries: 6 });
}

// `task relay` types the owner's own line to their supervisor into a worker, as their say-so: only rollcall's
// prompt hook writes that line (said.json in a supervisor's home), and only a supervisor relays it, never a
// worker. A command must name the file and the home to be stopped, so reading rollcall's own source passes.
const SAID_FILE = /\bsaid\.json\b/;
const HOME_PATH = /\.rollcall\b|_supervisors\b|\bROLLCALL_HOME\b/;
const RELAY = /\btask\s+relay\b/;
// The front-end interface's actions (api.mjs) act as the owner: their words reach a worker as the owner's own. A
// front end is no agent session, so an agent's shell never runs them (api-cli.mjs refuses them there too).
const API_DO = /\bapi[\s'\"\\]+do\b/;
// Away mode (away.mjs) is the owner's switch, and an answer to what it held grants a permission: the owner runs them
// in their own terminal or with `!` in the Falcon, which pass no hook; an agent's shell never does. Nor does it touch
// the records behind them. A guard rail for an agent that means well, not a wall: the CLI refuses a worker too.
const AWAY_ANSWER = /\baway[\s'\"\\]+(allow|deny|allow-all)\b/;
const AWAY_SWITCH = /\baway[\s'\"\\]+(on|off)\b/;
const AWAY_RECORD = /_machine\b[^\s;|&]*[\\/](grants|held|away)\.json\b/;

function saidDenial(cmd) {
  if (SAID_FILE.test(cmd) && HOME_PATH.test(cmd)) {
    return `${P} Blocked: said.json is rollcall's record of the owner's own words to their supervisor, written only by its prompt hook, and \`${cli()} task relay\` types it into a worker as theirs. Leave it alone: for the owner's say-so, ask them to type their words (to the supervisor, or \`@<name> <words>\`).`;
  }
  if (API_DO.test(cmd) && /\brollcall\b/.test(cmd)) {
    return `${P} Blocked: \`rollcall api do\` is the front-end interface, which acts as the owner, for the apps the owner uses. An agent session uses the \`${cli()} task\` commands, which run the same code.`;
  }
  if (AWAY_ANSWER.test(cmd) && /\brollcall\b/.test(cmd)) {
    return `${P} Blocked: answering what away mode held grants a permission, and that is the owner's alone (their terminal, or \`!\` in the Falcon). Leave it to them; mention what you need in your report.`;
  }
  if (AWAY_SWITCH.test(cmd) && /\brollcall\b/.test(cmd) && taskEnv()) {
    return `${P} Blocked: away mode is the owner's switch; a worker does not turn it on or off.`;
  }
  if (AWAY_RECORD.test(cmd)) {
    return `${P} Blocked: rollcall's away-mode records (held, grants, away) are its own. Read them with \`${cli()} away status\`; answering what it held is the owner's.`;
  }
  if (RELAY.test(cmd) && taskEnv()) {
    return `${P} Blocked: \`task relay\` is the supervisor's, and types the owner's words into a worker. Put what you need from the owner in a question or your report (\`${cli()} task output\`).`;
  }
  return null;
}

/**
 * Bash is never blocked, except git commands that would change the files,
 * branch or index of a checkout another live session owns (checkout, reset,
 * stash, commit...), deletions that reach a live session's Claude temp
 * folder (temp.mjs), the two ways around `task relay`, the front-end interface's actions, and away mode's answers and
 * records (saidDenial).
 * Read-only git and `git worktree add` always pass.
 */
function bashGuard(p, now) {
  const cmd = p.tool_input?.command;
  if (typeof cmd !== "string") return null;
  const said = saidDenial(cmd);
  if (said) return { deny: said };
  const temp = cmd.includes(MENTION) && tempDenial(cmd, cwdOf(p), () => ensureSession(p));
  if (temp) return { deny: temp };
  let g = null;
  const checked = new Set();
  for (const { dir, sub } of gitMutations(cmd, cwdOf(p))) {
    const info = locate(dir);
    if (!info || checked.has(info.top)) continue;
    checked.add(info.top);
    g ??= ensureSession(p);
    const { owner } = blocker(g, info, repoKey(info), now);
    if (owner) return { deny: denial(`\`git ${sub}\``, owner, info, g, now) };
  }
  return null;
}

// ---------------------------------------------------------------- PostToolUse / UserPromptSubmit / Stop

// A PR `gh pr create` printed: the task whose worktree it ran in shows it at once (prOpened).
const PR_CREATE = /\bgh\s+pr\s+create\b/;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

function prCreated(p) {
  if (p.tool_name !== "Bash" || !PR_CREATE.test(String(p.tool_input?.command ?? ""))) return;
  const url = PR_URL.exec(JSON.stringify(p.tool_response ?? ""))?.[0];
  if (!url) return;
  const env = taskEnv();
  const t = env ? store.readTask(env.home, env.id) : taskAt(cwdOf(p));
  if (t?.branch) prOpened(t, url);
}

function postToolUse(p, now) {
  const g = ensureSession(p);
  if (p.tool_name === "AskUserQuestion") return picks(g, p);
  try { prCreated(p); } catch {}
  const edit = EDIT_TOOLS.has(p.tool_name) ? editFocus(p) : null;
  if (edit) edit.touched = store.addTouched(edit.repo.key, g.id, edit.info.rel);
  return refresh(g, now, edit ?? cwdFocus(p), { deliver: deliverTo(p) });
}

/**
 * Supervisor `h`'s prompt that may be the owner's line: neither a delivery of rollcall's (its text is on the home's
 * `sent` record), a slash command nor a subagent's prompt. No hook payload says who sent a prompt, and the transcript
 * says only after this hook, so the rest is settled where it counts: `task relay` asks the transcript, and a sticky
 * `@luke` asks the keyboard (keyed).
 */
function ownerLine(h, p) {
  const text = typeof p.prompt === "string" ? p.prompt.trim() : "";
  return !!text && !p.agent_id && !text.startsWith("/") && !sameWords(store.readHomeFile(h, "sent")?.text, text);
}

// Prompts Claude Code frames itself: all that can be told of a prompt where no terminal on rollcall's tmux shows keys.
const FRAMED = /^<|^Another Claude session sent a message/;
// How soon before its hook a typed line's Enter was pressed, at the most, on a loaded Mac.
const KEYED_MS = 30_000;

/**
 * Whether a key made this line: every line goes to the task after a sticky `@luke`, and a scheduled wake-up or
 * Claude Code's own "limit has reset, continue" must not reach a worker as the owner's words.
 */
function keyed(h, text, now) {
  // A line from a front end's composer to a hosted supervisor (the host writes it) is the owner's as much as a key press.
  if (hostedHome(h)) {
    const app = store.readHomeFile(h, "app-line");
    if (app && now - app.at < KEYED_MS && sameWords(app.text, text)) return true;
    return !FRAMED.test(text);
  }
  if (!tmux.windowOf(h, h)?.alive) return !FRAMED.test(text);
  tmux.forget(h);
  return now - tmux.lastUsed(h, h) < KEYED_MS;
}

/** How many of the owner's last lines to a supervisor rollcall keeps for `task relay`. */
const SAID_KEEP = 5;

function promptSubmit(p, now) {
  let g = ensureSession(p);
  // The permission mode the owner runs in: a supervisor starts (and resumes) its workers in the same one.
  if (typeof p.permission_mode === "string" && p.permission_mode !== g.mode) { g = { ...g, mode: p.permission_mode }; store.writeGlobal(g); }
  // A supervisor's `@luke` (or `@t3`) lines go to that task's worker, typed, and never reach its model.
  const home = homeOf(g.id);
  const h = home && ownerLine(home, p) ? home : null;
  const routed = h ? route(h, g, p.prompt.trim(), now) : null;
  // A finished task's answer comes back through the watcher, which may have ended (no task open, no window left).
  if (routed?.task) ensureWatcher(h);
  if (routed) return routed;
  // The owner's line to the supervisor, for `task relay` to type into a worker word for word.
  if (h) {
    const said = store.readHomeFile(h, "said");
    store.writeHomeFile(h, "said", [...(Array.isArray(said) ? said : []), { at: now, session: g.id, text: p.prompt.trim().slice(0, 50_000) }].slice(-SAID_KEEP));
  }
  // A turn starts in a supervisor: what the watcher holds for it goes with this prompt.
  const running = holds(g) ? homeOf(g.id) : null;
  const news = running ? turnStarted(running, g, now) : [];
  let changed = false;
  if (!g.firstPrompt) {
    const fp = trimPrompt(p.prompt);
    if (fp) { g.firstPrompt = fp; changed = true; }
  }
  if (changed) store.writeGlobal(g);
  return [...news, ...refresh(g, now, cwdFocus(p), { deliver: deliverTo(p) })];
}

// ---------------------------------------------------------------- the owner's words for a task, from the supervisor

// The word after @ is a task's name ("luke", "yoda-2") or id ("t3"); idOf says which task, or none.
const ADDRESSED = /^@([a-z][\w-]*)\s+([\s\S]*\S)\s*$/i;
const ALONE = /^@([a-z][\w-]*)\s*$/i;
const LEAVE = /^@\s*$/;

/** "→ luke · header: typed into its worker", or why the words wait or did not get there. */
function sent(t, r) {
  if (!r.ok) return `${label(t)}: your words are recorded, but ${r.why}.`;
  return `→ ${label(t)}: ${r.how === "typed" ? "typed into its worker" : r.how === "resumed" ? "its worker had stopped; it resumes with your words as its prompt" : r.how === "fresh" ? "its worker had stopped after writing where it stood; a fresh worker starts with your words in its brief" : r.why}`;
}

/** Whether the owner's words can reach the task: an open one, or a finished one that had a worker (it runs, or resumes). */
const reachable = (t) => isOpen(t) || !!t?.sessions?.length;

/** Delivers the owner's words to task `id` of home `h`, typed (`typed`, when the worker hears more than the record keeps): { stop } for the hook. */
function sendTo(h, g, id, text, typed = text, mark = null) {
  const t = store.readTask(h, id);
  if (!reachable(t)) return { stop: `No task ${nameOf(id)} (${id}) with a worker in supervisor ${h}: \`${cli()} task list\` shows them.` };
  return { stop: sent(t, deliverWords(t, typed, { record: () => recordWords(t, text, "supervisor", mark), mode: g.mode })), task: t };
}

/**
 * A line the owner typed in a supervisor: `@luke <text>` (or `@t3 <text>`) goes to that task's worker word
 * for word; `@luke` alone sends every line after it there until a line that is just `@` (the status line
 * names who hears the next
 * line). Returns { stop } when the line went to a task, else null (it is the supervisor's).
 */
function route(h, g, text, now) {
  const to = store.readHomeFile(h, "reply-to")?.task ?? null;
  if (LEAVE.test(text)) {
    store.writeHomeFile(h, "reply-to", null);
    return { stop: to ? "← back to the supervisor" : "Already talking to the supervisor; a task's name alone (@luke) talks to it." };
  }
  const alone = ALONE.exec(text);
  const aloneId = alone && idOf(alone[1]);
  if (aloneId) {
    const t = store.readTask(h, aloneId);
    if (!reachable(t)) return { stop: `No task ${alone[1]} with a worker in supervisor ${h}.` };
    store.writeHomeFile(h, "reply-to", { task: t.id, at: Date.now() });
    return { stop: `→ talking to ${label(t)}: every line goes to it until a line that is just @` };
  }
  const addressed = ADDRESSED.exec(text);
  const addressedId = addressed && idOf(addressed[1]);
  if (addressedId) return sendTo(h, g, addressedId, addressed[2]);
  if (!to || text.startsWith("@") || text.startsWith("/")) return null; // a slash command stays the supervisor's
  if (!reachable(store.readTask(h, to))) { store.writeHomeFile(h, "reply-to", null); return null; }
  return keyed(h, text, now) ? sendTo(h, g, to, text) : null;
}

// The owner's own words in a worker's picker that are meant for the supervisor ("so this should be its own task").
const ROUTING = /\b(?:own|separate|new|another|different) tasks?\b|\bsplit (?:this|that|it)\b|\bsupervisor\b/i;

/** The owner's own words in a pick go on the record `task relay` reads, since they may be meant for another task. */
function keepSaid(h, g, text, now) {
  const said = store.readHomeFile(h, "said");
  store.writeHomeFile(h, "said", [...(Array.isArray(said) ? said : []), { at: now, session: g.id, text: text.slice(0, 50_000), pick: true }].slice(-SAID_KEEP));
}

/**
 * The owner answered the supervisor's picker: each question tagged "luke · ..." is a worker's (or one the
 * supervisor asked for it), and the pick goes to that task's worker, typed. Several questions for one task
 * go as one prompt, numbered in their order. Free text is often a question for the worker, whose window
 * nobody reads, so it also hears how to reply. Free text that routes work stops at the supervisor, and a picture
 * follows its pick as a saved path (pictures.mjs).
 */
function picks(g, p) {
  const h = homeOf(g.id);
  const questions = p.tool_input?.questions;
  const answers = p.tool_response?.answers ?? p.tool_input?.answers;
  if (!h || !Array.isArray(questions) || !answers || typeof answers !== "object") return null;
  const byTask = new Map();
  for (const x of questions) {
    const id = taskOfQuestion(x);
    const a = typeof answers[x.question] === "string" ? answers[x.question].trim() : "";
    if (id && a) byTask.set(id, [...(byTask.get(id) ?? []), { ...pickLine(x, a, nameOf(id)), x }]);
  }
  const lines = [];
  const now = Date.now();
  for (const [id, all] of byTask) {
    // The first answer wins: a question a front end answered meanwhile is not answered twice (answer.mjs).
    const t0 = store.readTask(h, id);
    const gone = all.map((a) => answeredElsewhere(t0, a.x.question)).find(Boolean);
    const picked = all.filter((a) => !answeredElsewhere(t0, a.x.question));
    if (gone) lines.push(droppedPick(t0, gone));
    if (!picked.length) continue;
    // Only the picker's own result is the owner's: the same field on the tool's input is the model's to fill.
    if (p.tool_response?.answers) for (const a of picked) if (a.own) keepSaid(h, g, a.said, now);
    const text = joinLines(picked);
    const routing = picked.find((a) => a.own && ROUTING.test(a.said));
    if (routing) {
      const rest = picked.filter((a) => a !== routing).map((a) => a.line);
      lines.push(`${P} The owner's words in ${nameOf(id)}'s picker read as meant for you, so they did not go to its worker: "${store.clip(store.oneLine(routing.said), 300)}".${rest.length ? ` Its other answers there were held too: ${store.clip(store.oneLine(rest.join(" | ")), 600)}.` : ""} Act on them. If they answer ${nameOf(id)} after all: \`${cli()} task relay ${id}\`. Its question stays open: else close it (\`${cli()} task tell ${id} "<what moved>"\`, then \`${cli()} task set ${id} --state working\`).`);
      continue;
    }
    const reply = picked.some((a) => a.own) ? `\nIf this asks you something, answer with \`${cli()} task note ${id} "reply: <answer>"\`: what you write in this window reaches no one.` : "";
    const pictured = picked.some((a) => a.own && a.said.includes(PICTURE));
    const findable = pictured && picturesFindable(p);
    const picture = !pictured ? "" : findable ? `\n${P} Their picture comes next, as a saved path: wait for it, and do not search for it.` : `\n${P} rollcall could not save their picture: ask them for it, and do not search for it.`;
    lines.push(`${P} ${sendTo(h, g, id, text, `${text}${reply}${picture}`, (t) => markAnswered(t, picked.map((a) => a.x), "the terminal Falcon", text, { qid: questionId(t0) })).stop}`);
    if (findable) picturesLater(h, id, p);
  }
  return lines;
}

function stop(p, now) {
  const g = ensureSession(p);
  const focus = cwdFocus(p);
  refresh(g, now, focus, { idle: true });
  if (!g.supervisor) snapshotDetached(focus?.info, ["--session", g.id]);
  const h = holds(g) ? homeOf(g.id) : null;
  if (h) turnEnded(h, g, now);
  return null;
}

/** A supervisor's turn ended on an API error (a worker's has its own hook): what it carried goes back in the queue. */
function stopFailure(p, now) {
  const g = ensureSession(p);
  const h = holds(g) ? homeOf(g.id) : null;
  if (!h) return null;
  if (ACCOUNT_ERRORS.has(p.error)) openBlocker("usage", { until: resetAt(p.last_assistant_message), text: store.clip(store.oneLine(p.last_assistant_message ?? ""), 240) || null }, now);
  turnFailed(h, g, now);
  return null;
}

/**
 * Heartbeat + delta delivery. The focus repo (where this hook's activity
 * happened) gets the heartbeat and the main-moved check, so a session that
 * moved on stops owning its old checkout once it goes stale. Other joined
 * repos only get their unread events delivered, and only when there are any.
 */
function refresh(g, now, focus, { deliver = false, idle = false }) {
  const lines = [];
  if (focus) {
    store.withLock(focus.repo.key, g.id, () => {
      const rec = joinRepo(g, focus.info, focus.repo, now, focus.move, focus.edit);
      rec.idle = idle ? now : null;
      if (deliver) lines.push(...deltas(focus.repo.key, rec), ...mainMoved(focus.repo.key, rec, focus, now));
      store.writeRecord(focus.repo.key, rec);
    });
  }
  if (!deliver) return lines;
  // A supervisor works across repos and may sit in none: what the owner told its workers directly is task news, not a repo event.
  const home = holds(g) ? homeOf(g.id) : null;
  if (home) lines.push(...ownerNews(home, now), ...(g.supervisor ? skillChanged(g) : []));
  for (const key of g.repos) {
    if (key === focus?.repo.key) continue;
    const peek = store.readRecord(key, g.id);
    if (!peek || peek.endedAt || !store.hasNewEvents(key, peek.cursor)) continue;
    store.withLock(key, g.id, () => {
      const rec = store.readRecord(key, g.id);
      lines.push(...deltas(key, rec));
      store.writeRecord(key, rec);
    });
  }
  return lines;
}

/**
 * A supervisor runs all day on the skill text it loaded at the start, while a sync started by any other
 * session can change that file under it: one line, once per change, tells it to read the new text.
 */
function skillChanged(g) {
  const now = skillStamp();
  if (now === null || g.supervisor.skill === undefined || now === g.supervisor.skill) return [];
  store.writeGlobal({ ...g, supervisor: { ...g.supervisor, skill: now } });
  return [`${P} The /supervisor skill changed since this session loaded it (a sync pulled a new version). Read ${SKILL} again and follow the new text from here on.`];
}

// A subagent hears no deltas (deliverTo), so this line reaches the main thread alone. A shipper has the same news from
// its `queue wait`; a worker that read this as its own step went to investigate the same bounce beside it.
const SHIPPER_HAS_IT = "If you started a shipper and its report has not come, it has this from its queue wait and acts on it: leave it to the shipper.";

/**
 * Unread events that concern this session: addressed messages, waits on it, dependencies finishing,
 * claims over its files, and the merge queue's news about its own PR (landed, a conflict, a failed check, parked).
 */
function deltas(key, rec) {
  const { events, cursor } = store.readEventsSince(key, rec.cursor);
  rec.cursor = cursor;
  const lines = [];
  let touched = null;
  for (const e of events) {
    if (e.session === rec.id) continue;
    if (e.type === "msg" && (e.to === rec.id || e.to === "all")) {
      lines.push(msgLine(e));
    } else if (e.type === "wait" && e.target === rec.id) {
      lines.push(`${P} ${e.who} is waiting for you to finish "${e.intent}". Run \`${cli()} done "<summary>"\` when it is done.`);
    } else if (e.type === "done" && (rec.waits.includes(e.session) || rec.overlaps?.includes(e.session))) {
      if (settle(rec, e)) lines.push(doneLine(e));
    } else if (e.type === "claim" && e.scope?.length) {
      touched ??= store.readTouched(key, rec.id);
      const hits = touched.filter((f) => matchScope(e.scope, f));
      if (hits.length) lines.push(`${P} ${e.who} claimed ${claimLabel(e.intent, e.scope)}, which covers files you edited: ${fileList(hits)}`);
    } else if (e.type === "queue" && e.to === rec.id && e.kind !== "added") {
      // A ship's news (ship.mjs) has no shipper waiting on it: the line is the session's own to act on.
      lines.push(e.ship ? `${P} ship: ${e.text}` : `${P} merge queue: ${e.text} ${SHIPPER_HAS_IT}`);
    }
  }
  return lines;
}

// Each of mainMoved's two extra git calls gets a short leash: the hook has ~3 s in all.
const HOOK_GIT_MS = 1200;

/**
 * One notice per (file, main change): origin's default branch gained commits
 * touching files this session edited, and they collide with its work. A newly
 * edited file is checked against everything main gained since the session
 * started (baseMain..cur: one diff per main move, cached); after that, only
 * against new main commits (mainSha..cur). Files whose main version already
 * equals this checkout's HEAD (e.g. this session's own PR just merged) are
 * skipped. Main moving is not news by itself: the notice is sent when main no
 * longer merges into this branch, or changed a file the session has
 * uncommitted edits in (which git cannot check). Committed work that still
 * merges cleanly hears nothing.
 */
function mainMoved(key, rec, focus, now) {
  const info = focus.info.top === rec.checkout ? focus.info : locate(rec.checkout);
  if (!info) return [];
  const b = defaultBranch(info);
  if (!b) return [];
  maybeFetch(key, info, b, now);
  const cur = mainSha(info, b);
  if (!cur) return [];
  if (!rec.baseMain) { rec.baseMain = rec.mainSha = cur; return []; }
  const touched = focus.touched ?? store.readTouched(key, rec.id);
  const checked = touched.slice(0, rec.mainN);
  const fresh = touched.slice(rec.mainN);
  const hits = new Set();
  if (cur !== rec.mainSha) {
    if (checked.length) for (const f of diffNames(info.top, rec.mainSha, cur, checked) ?? []) hits.add(f);
    rec.mainSha = cur;
  }
  if (fresh.length && cur !== rec.baseMain) {
    const sinceBase = changedSinceBase(key, rec, info, cur);
    for (const f of fresh) if (sinceBase.has(f)) hits.add(f);
  }
  rec.mainN = touched.length;
  if (!hits.size) return [];
  const differ = diffNames(info.top, cur, "HEAD", [...hits]);
  const files = [...hits].filter((f) => !differ || differ.has(f));
  if (!files.length) return [];
  const conflicts = mergeConflicts(info.top, "HEAD", cur, HOOK_GIT_MS);
  // git too old to merge in memory: the file overlap is all there is to go on.
  if (!conflicts) return [`${P} origin/${b} gained commits touching files you edited: ${fileList(files)}. Bring them in before going further (git merge origin/${b}, or rebase).`];
  const landed = store.readAllEvents(key).findLast((e) => e.type === "landed" && e.sha === cur && e.session !== rec.id);
  const by = landed ? ` (${landed.who} landed ${landed.branch}${landed.pr ? `, #${landed.pr}` : ""})` : "";
  if (conflicts.length) return [`${P} origin/${b} no longer merges into your branch${by}. It conflicts in: ${fileList(conflicts.map(safeName))}. Merge it in before building further on those files: git merge origin/${b}`];
  const dirty = dirtyPaths(info.top, files, HOOK_GIT_MS) ?? [];
  const open = files.filter((f) => dirty.includes(f));
  if (!open.length) return [];
  return [`${P} origin/${b} changed files you have uncommitted edits in${by}: ${fileList(open.map(safeName))}. Commit them, then git merge origin/${b}, before building further on them.`];
}

/** Files changed on main between the session's base and `cur`: one git diff per main move, cached. */
function changedSinceBase(key, rec, info, cur) {
  const cached = store.readCache(key, rec.id, "main");
  if (cached?.base === rec.baseMain && cached.sha === cur) return new Set(cached.files);
  const files = diffNames(info.top, rec.baseMain, cur);
  if (!files) return new Set();
  store.writeCache(key, rec.id, "main", { base: rec.baseMain, sha: cur, files: [...files] });
  return files;
}

/** Throttled, detached `git fetch` so origin/main stays current without the hook ever waiting on the network. */
function maybeFetch(key, info, b, now) {
  if (remoteUrl(info) && store.claimFetchSlot(key, now)) fetchDetached(info.top, b);
}

// ---------------------------------------------------------------- SessionEnd

/**
 * Best effort (never fires on a crash): emit `done` unless the session already
 * said so, and mark it ended. A session that worked in an agent worktree frees
 * it here: a background gc collects it once the harness has exited (its shells
 * may still sit inside the worktree until then) and the PR has merged.
 */
function sessionEnd(p, now) {
  const g = store.readGlobal(p.session_id);
  if (!g) return null;
  const mains = new Set();
  for (const key of g.repos) {
    const rec = store.readRecord(key, g.id);
    if (!rec || rec.endedAt) continue;
    if (!isDone(rec)) markDone(key, rec, `${autoSummary(rec, store.readTouched(key, g.id))} [session ended${p.reason ? `: ${p.reason}` : ""}]`);
    Object.assign(rec, { claim: null, endedAt: now });
    store.writeRecord(key, rec);
    if (rec.main && rec.checkout?.startsWith(agentWorktrees(rec.main))) mains.add(rec.main);
  }
  store.writeGlobal({ ...g, endedAt: now });
  for (const main of mains) gcDetached(main, g.pid ? ["--after-pid", String(g.pid)] : []);
  return null;
}
