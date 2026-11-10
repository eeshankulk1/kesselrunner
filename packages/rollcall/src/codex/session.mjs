// One Codex session on its own app server, for the agent host (host/codex.mjs); the tmux worker (codex/worker.mjs)
// shares its protocol pieces (the dialog, approval and question shapes) and keeps its own loop. startCodex starts `codex app-server` on a unix socket, starts the task's thread (or resumes it),
// writes the chat's items to the journal (`codex-<session>.jsonl`, codex/items.mjs) and turns the protocol into events.
//
// The protocol stands in for Claude Code's hooks: each event below goes through supervisor.workerHook as the hook
// of the same name would, so a Codex worker's task record moves exactly as a Claude worker's does.
//   item/started userMessage   -> prompt-submit (receipts, busy, the context notes, a question still open)
//   turn/completed             -> stop (idle, last words, the cap's block) or stop-failure (a usage limit)
//   approval server requests   -> dialog (as PermissionRequest: approved on a grant, or held while the owner is away);
//                                 serverRequest/resolved -> clear
//   item/tool/requestUserInput -> ask (the owner's picker in the supervisor), answered with the hook's reason
//   thread/tokenUsage/updated  -> the context use the status line records for Claude Code, and the cap flag
//   account/rateLimits/updated -> the usage meter
// and, as Claude Code's SessionStart and Stop hooks do, a turn snapshot (snapshot.mjs) at the start and after each turn.
// What a hook would add to the model's context goes in as a steer into the running turn; a Stop hook's block is a
// new turn. rollcall's own messages carry a clientUserMessageId starting "rollcall-", so the UI's are the owner's.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { summaryOf, trimInput } from "../away.mjs";
import { commandOf } from "../claude/stream.mjs";
import { journalFile, launchFile, policyFor, sandboxPolicyOf } from "../harness/codex.mjs";
import { pidAlive } from "../proc.mjs";
import { BIN } from "../session.mjs";
import * as store from "../store.mjs";
import { capFlag, markCap, workerHook } from "../supervisor.mjs";
import { recordCodex } from "../usage.mjs";
import { historyItems, itemOf, todosOf, turnEnd, turnStart } from "./items.mjs";
import { connect } from "./rpc.mjs";

const IMAGES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** rollcall's messages into a thread: "rollcall-d-" a delivery (send.mjs), "rollcall-i-" a note of the worker's own. */
export const DELIVERY = "rollcall-d-";
export const INJECTED = "rollcall-i-";
export const clientId = (prefix) => `${prefix}${randomBytes(6).toString("hex")}`;

/** The text of a userMessage item: its text parts, joined. */
export const textOf = (item) => (item?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n").trim();

/** An object without its null, undefined and empty-string fields. */
const present = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ""));

/**
 * Codex's server requests that open a dialog the owner answers, as the hook payload Claude Code's PermissionRequest
 * would carry. The input names everything that makes one request differ from another (the command's argv and folder,
 * every file a patch changes and a hash of the changes, the permissions asked for): away mode's grant matches on it.
 */
export function dialogPayload(method, p) {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    const argv = Array.isArray(p?.command) ? p.command : null;
    const command = argv ? argv.join(" ") : p?.command ?? "";
    const tool_input = present({ command, argv: argv && argv.length > 1 ? argv : null, cwd: p?.cwd, network: p?.networkApprovalContext, description: p?.reason });
    return { tool_name: "Bash", tool_input, notification_type: "permission_prompt", message: p?.reason ?? null };
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    const changes = p?.fileChanges && typeof p.fileChanges === "object" ? p.fileChanges : {};
    const files = Object.keys(changes).sort();
    const hash = files.length ? createHash("sha256").update(JSON.stringify(files.map((f) => [f, changes[f]]))).digest("hex").slice(0, 16) : null;
    const tool_input = present({ file_path: p?.grantRoot ?? files[0], files: files.length > 1 ? files : null, changes: hash, description: p?.reason });
    return { tool_name: "Edit", tool_input, notification_type: "permission_prompt", message: p?.reason ?? null };
  }
  if (method === "item/permissions/requestApproval") {
    const tool_input = present({ permissions: p?.permissions, cwd: p?.cwd, description: p?.reason });
    return { tool_name: null, tool_input, notification_type: "permission_prompt", message: p?.reason ?? "Codex asks for more permissions" };
  }
  if (method === "mcpServer/elicitation/request") return { tool_name: null, notification_type: "elicitation_dialog", message: `${p?.serverName ?? "an MCP server"} asks for input` };
  return null;
}

/** The server requests that ask the owner's permission for an action (not an MCP server's question). */
export const APPROVALS = new Set(["item/commandExecution/requestApproval", "execCommandApproval", "item/fileChange/requestApproval", "applyPatchApproval", "item/permissions/requestApproval"]);

/**
 * The answer to approval request `method` that rollcall decided (away.mjs), or the owner gave in the chat: allowed
 * (`always`: for the rest of the session, where Codex offers that), or declined so the turn goes on (`cancel` /
 * `abort` would stop it). The older requests carry the reason with the denial; the newer ones take none.
 */
export function approvalAnswer(method, p, allow, reason = null, always = false) {
  if (method === "execCommandApproval" || method === "applyPatchApproval") return { decision: allow ? "approved" : { denied: { rejection: reason ?? "the owner declined it" } } };
  if (method === "item/permissions/requestApproval") return allow ? { permissions: p?.permissions ?? {}, scope: always ? "session" : "turn" } : { permissions: {}, scope: "turn" };
  return { decision: allow ? (always ? "acceptForSession" : "accept") : "decline" };
}

/** A PermissionRequest decision from the hook's JSON answer: { behavior, message }, or null. */
export const decisionIn = (out) => { try { return JSON.parse(out)?.hookSpecificOutput?.decision ?? null; } catch { return null; } };

/** A request_user_input call's questions as AskUserQuestion's: { question, header, options, multiSelect }. Free-text questions keep no options. */
export function questionsOf(p) {
  return (p?.questions ?? []).map((x) => ({
    question: x.question, header: x.header ?? "", multiSelect: false,
    options: (x.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })),
  }));
}

/** The answer to a request_user_input call that rollcall took to the owner's picker: the hook's reason, for each question. */
export function answerFor(p, reason) {
  return { answers: Object.fromEntries((p?.questions ?? []).map((x) => [x.id, { answers: [reason] }])) };
}

/** Whether a failed turn's error is the account's usage limit. */
export const usageLimited = (err) => err?.codexErrorInfo === "usageLimitExceeded" || (typeof err?.codexErrorInfo === "object" && err.codexErrorInfo && "usageLimitExceeded" in err.codexErrorInfo);

/** The context use a token usage update says: { pct, tokens, size } (the last request's tokens against the window), or null. */
export function contextOf(usage) {
  const size = usage?.modelContextWindow;
  const tokens = usage?.last?.totalTokens ?? usage?.last?.inputTokens;
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(tokens)) return null;
  return { pct: Math.min(100, Math.round((tokens / size) * 100)), tokens, size, total: usage?.total?.totalTokens ?? null };
}

/** The hook's added context, from its JSON answer, or null. */
const contextIn = (out) => { try { return JSON.parse(out)?.hookSpecificOutput?.additionalContext ?? null; } catch { return null; } };
const reasonIn = (out) => { try { return JSON.parse(out)?.hookSpecificOutput?.permissionDecisionReason ?? null; } catch { return null; } };
const blockIn = (out) => { try { const x = JSON.parse(out); return x?.decision === "block" ? x.reason : null; } catch { return null; } };

/**
 * The input of a message the owner sends: their text with every attached file named on a last line (as a Claude
 * worker's), and the images among them as images.
 */
export function inputOf(text, attachments = []) {
  const files = (attachments ?? []).filter((p) => typeof p === "string" && p);
  const body = files.length ? `${text}\n\n[Attached: ${files.join(", ")}]` : String(text);
  return [{ type: "text", text: body }, ...files.filter((p) => IMAGES.has(extname(p).toLowerCase()) && existsSync(p)).map((path) => ({ type: "localImage", path }))];
}

/** The prompt a Codex server request opens in the chat (API.md "The prompt"), from its dialog payload. */
export function promptOf(id, method, params, d, { cwd = null, now = Date.now() } = {}) {
  if (method === "item/tool/requestUserInput") {
    return { id, at: now, kind: "question", tool: "request_user_input", input: {}, summary: "A question", reason: null, questions: questionsOf(params), plan: null, relays: null, suggestions: null };
  }
  const tool = d?.tool_name ?? null;
  const input = d?.tool_input ?? {};
  return {
    id, at: now, kind: "permission", tool,
    input: trimInput(input), summary: tool ? summaryOf({ worktree: cwd }, tool, input) : store.oneLine(d?.message ?? "Codex asks"),
    reason: params?.reason ?? d?.message ?? null, questions: null, plan: null, relays: null,
    // Codex has one wider grant for these: the rest of the session (`always`).
    suggestions: APPROVALS.has(method) && method !== "execCommandApproval" && method !== "applyPatchApproval" ? [{ type: "session", destination: "session" }] : null,
  };
}

/**
 * Starts Codex's app server for task `h`:`id` on launch file `cfg` (codex-launch.json) and opens its thread: a new
 * one, or `cfg.thread` resumed. Resolves once the thread runs (rejects when the server or the thread does not start).
 * `sock` is the server's socket path; `envFile` the task's environment (the host's login shell sources it), `hosted`
 * says the agent host runs it (no window to open Codex's own screen in). A chat's own session (`id` null) passes
 * `hook(event, payload)` for what a worker's hooks do (host/chat-hooks.mjs); its launch's `instructions` file goes in
 * as Codex's developer instructions. `on(event)` hears:
 *   { type: "turn-start", turn, at }
 *   { type: "taken", cid, text, injected }   a user message went in (`cid` its client id; `injected`: rollcall's note)
 *   { type: "item", item, phase, clientId }  an item journaled (phase "started" or "completed"; a skip has `skip`)
 *   { type: "text", id, kind, append, sep }  streamed text on an item not finished yet
 *   { type: "text-end", id }
 *   { type: "turn-end", turn, ms, status, context }
 *   { type: "after-turn" }                   the turn's hooks ran (a view may switch now)
 *   { type: "request", rid, prompt, input }  a prompt for the owner (its id `codex-<rid>`)
 *   { type: "cancel", rid }                  resolved elsewhere
 *   { type: "exit", code, err }              the app server ended without close()
 */
export async function startCodex({ h, id, cfg, sock, envFile = null, env = process.env, hosted = false, hook: ownHook = null, on = () => {}, log = null }) {
  const { recordAsk } = await import("../task.mjs");
  const say = (line) => { if (log || !id) log?.(line); else { try { store.appendStatus(h, id, { ev: "codex", line: store.clip(String(line), 300) }); } catch {} } };
  const emit = (e) => { try { on(e); } catch (x) { say(`a Codex event failed: ${x?.stack ?? x}`); } };
  const hook = (event, p = {}) => {
    try { return ownHook ? ownHook(event, { session_id: cfg.session, ...p }) : workerHook(h, id, event, { session_id: cfg.session, ...p }, { recordAsk }); } catch { return null; }
  };
  // A turn snapshot of the worktree in its own detached process, as the Claude hooks start theirs (`turns take`
  // skips a main checkout). Nothing here waits on it, except the first prompt on the baseline: resolves when the
  // take exits, or after 10 s.
  const snapshot = (...args) => new Promise((done) => {
    if (!cfg.cwd || store.envFlag("ROLLCALL_SNAPSHOTS") === false) return done();
    try {
      const child = spawn(process.execPath, [BIN, "-C", cfg.cwd, "turns", "take", "--quiet", "--session", cfg.session, ...args], { detached: true, stdio: "ignore" });
      child.on("error", () => done());
      child.on("exit", () => done());
      child.unref();
      setTimeout(done, 10_000).unref();
    } catch { done(); }
  });
  const rememberLaunch = (patch) => {
    Object.assign(cfg, patch);
    const f = launchFile(h, id);
    const tmp = `${f}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    try { writeFileSync(tmp, JSON.stringify(cfg, null, 2)); renameSync(tmp, f); } catch { rmSync(tmp, { force: true }); }
  };

  rmSync(sock, { force: true });
  const serverArgs = ["app-server", "--listen", `unix://${sock}`, ...(cfg.questions ? ["--enable", "default_mode_request_user_input"] : [])];
  const [cmd, argv] = commandOf(cfg.bin, serverArgs, envFile);
  const server = spawn(cmd, argv, { stdio: ["ignore", "ignore", "pipe"], env, cwd: hosted && cfg.cwd && existsSync(cfg.cwd) ? cfg.cwd : undefined });
  let serverErr = "";
  server.stderr.on("data", (d) => { serverErr = (serverErr + d).slice(-4000); });
  let up = false;
  let closing = false;
  const tail = () => serverErr.trim().split("\n").slice(-6).join("\n");
  let failStart = null;
  server.on("exit", (code, signal) => {
    if (!up) { failStart?.(new Error(`Codex's app server exited (${code ?? signal}) before the thread started.\n${tail()}`)); return; }
    if (closing) { emit({ type: "exit", code: 0, err: "", closed: true }); return; }
    say(`Codex's app server stopped (exit ${code ?? signal})`);
    hook("session-end", { reason: "crash" });
    emit({ type: "exit", code: code ?? 1, err: tail() });
  });
  server.on("error", (e) => failStart?.(e));
  const kill = (sig = "SIGTERM") => { try { server.kill(sig); } catch {} };

  const s = {
    pid: server.pid, sock, thread: null, turn: null, turnAt: null,
    get exited() { return server.exitCode !== null || server.signalCode !== null; },
  };
  const pending = new Map(); // server request id -> "dialog" (a dialog the hook raised its flag for)
  const prompts = new Map(); // prompt id -> { req, method, params, prompt }: what the chat may answer
  const closed = new Set(); // prompts answered or resolved elsewhere: a second answer is `already`
  let lastWords = null;
  let resetsAt = null; // when the Codex limit resets, from the last rate limits heard (ms)
  let blocked = false; // the cap's block went out this turn: once, as Claude Code's stop_hook_active
  let usage = null; // the thread's last token usage
  let turnTotals = null; // its totals when the running turn started
  let nextModel = cfg.model ?? null; // a model set from a front end, for the next turn rollcall starts
  let nextPolicy = null; // a chat's mode set from a front end: its approval policy and sandbox, for the next turn
  let conn;

  // ---- the journal
  const jfile = journalFile(h, id, cfg.session);
  const written = new Map(); // item id -> a hash of the line written last: an unchanged item is not written again
  const firstAt = new Map(); // item id -> when it was first heard: a later line keeps that time
  const streamed = new Set(); // items whose text streamed
  const journal = (x, phase = "completed", clientId = null) => {
    if (!x?.id) return;
    if (firstAt.has(x.id) && x.at != null) x.at = firstAt.get(x.id);
    else if (x.at != null) firstAt.set(x.id, x.at);
    const line = JSON.stringify(x);
    const sum = createHash("sha1").update(line).digest("base64");
    if (written.get(x.id) === sum) return;
    written.set(x.id, sum);
    try { appendFileSync(jfile, `${line}\n`); } catch (e) { say(`the journal did not take a line: ${e.message}`); }
    emit({ type: "item", item: x, phase, clientId });
  };

  const inject = async (text) => {
    if (!text || !s.thread) return;
    const input = [{ type: "text", text }];
    const cid = clientId(INJECTED);
    try {
      if (s.turn) await conn.request("turn/steer", { threadId: s.thread, expectedTurnId: s.turn, input, clientUserMessageId: cid });
      else await conn.request("turn/start", { threadId: s.thread, input, clientUserMessageId: cid });
    } catch (e) { say(`could not add rollcall's note: ${e.message}`); }
  };

  // ---- prompts
  const openPrompt = (req, method, params, d) => {
    const p = promptOf(`codex-${req}`, method, params, d, { cwd: cfg.cwd });
    prompts.set(p.id, { req, method, params, prompt: p });
    emit({ type: "request", rid: req, prompt: p, input: d?.tool_input ?? {} });
  };
  /** The owner's answer to prompt `a.prompt`: { ok, answered, allowed }, { ok, already }, or a refusal. */
  const answer = (a) => {
    const open = prompts.get(a.prompt);
    if (!open) return closed.has(a.prompt) ? { ok: true, already: true } : { ok: false, code: "not-found", err: `no prompt ${a.prompt}` };
    const { req, method, params, prompt } = open;
    let result;
    let allowed = false;
    if (prompt.kind === "question") {
      const answers = a.allow !== false && a.answers && typeof a.answers === "object" ? a.answers : null;
      if (!answers && a.allow !== false) return { ok: false, code: "bad-payload", err: "a question takes answers" };
      result = { answers: Object.fromEntries((params?.questions ?? []).map((x) => [x.id, { answers: answers && answers[x.question] != null ? [String(answers[x.question])] : [] }])) };
      allowed = !!answers;
    } else if (method === "mcpServer/elicitation/request") {
      allowed = a.allow === true;
      result = allowed ? { action: "accept", content: {} } : { action: "decline", content: null };
    } else {
      allowed = a.allow === true;
      result = approvalAnswer(method, params, allowed, a.why ? `The owner declined: ${a.why}` : null, a.always === true);
    }
    conn.respond(req, result);
    // The dialog the hook raised closes with the answer: Codex need not say it resolved a request this client answered.
    if (pending.delete(req)) hook("clear");
    closed.add(a.prompt);
    prompts.delete(a.prompt);
    // A newer request takes no reason with its decline: the owner's words go in as a note the turn reads.
    if (!allowed && a.why && prompt.kind === "permission" && method !== "execCommandApproval" && method !== "applyPatchApproval") void inject(`The owner declined that: ${a.why}`);
    return { ok: true, answered: true, allowed };
  };

  /** The thread's running turn, from the server itself (the record can be a moment behind), or null. */
  const runningTurn = async () => {
    const r = await conn.request("thread/read", { threadId: s.thread, includeTurns: true }, 5000);
    return (r?.thread?.turns ?? []).findLast((t) => t.status === "inProgress")?.id ?? null;
  };
  /** Codex's plan limits read now: recorded on the meter; resolves to when the fullest window resets (ms), or null. */
  const limitsNow = async () => {
    try {
      const r = await conn.request("account/rateLimits/read", undefined, 10_000);
      const x = r?.rateLimitsByLimitId?.codex ?? r?.rateLimits;
      recordCodex(x);
      const wins = [x?.primary, x?.secondary].filter((w) => w && Number.isFinite(w.resetsAt)).sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0));
      return wins[0] ? wins[0].resetsAt * 1000 : null;
    } catch { return null; }
  };

  const onMessage = (m) => {
    const p = m.params ?? {};
    if (p.threadId && s.thread && p.threadId !== s.thread) return; // a subagent's thread: not the worker's own
    if (m.id !== undefined && m.method) return void onRequest(m).catch((e) => say(e.message));
    switch (m.method) {
      case "turn/started": {
        s.turn = p.turn?.id ?? null; s.turnAt = Date.now(); lastWords = null;
        turnTotals = usage?.total ?? null;
        emit({ type: "turn-start", turn: s.turn, at: s.turnAt });
        if (s.turn) journal(turnStart(s.turn, s.turnAt));
        return;
      }
      case "item/started": {
        const item = p.item ?? {};
        if (item.type !== "userMessage") {
          const x = itemOf(item, { cwd: cfg.cwd });
          if (x && (x.kind === "tool" || x.kind === "subagent")) journal(x, "started");
          return;
        }
        const cid = String(item.clientId ?? "");
        journal(itemOf(item, { cwd: cfg.cwd }), "started", cid || null);
        const injected = cid.startsWith(INJECTED);
        emit({ type: "taken", cid, text: textOf(item), injected });
        // A note of the worker's own (a steer from this process) starts nothing: busy is all it says.
        if (injected) { if (id) { try { store.appendStatus(h, id, { ev: "busy" }); } catch {} } return; }
        const out = hook("prompt-submit", { prompt: textOf(item), owner: !cid.startsWith("rollcall-") });
        void inject(contextIn(out));
        return;
      }
      case "item/agentMessage/delta":
        if (typeof p.delta === "string" && p.delta) { streamed.add(p.itemId); emit({ type: "text", id: p.itemId, kind: "assistant", append: p.delta, sep: "", part: null }); }
        return;
      case "item/reasoning/summaryTextDelta":
        if (typeof p.delta === "string" && p.delta) { streamed.add(p.itemId); emit({ type: "text", id: p.itemId, kind: "thinking", append: p.delta, sep: "\n\n", part: p.summaryIndex }); }
        return;
      case "item/completed": {
        const item = p.item ?? {};
        if (item.type === "agentMessage" && typeof item.text === "string") lastWords = item.text;
        // After each tool call while the cap flag is up, as Claude Code's PostToolUse hook hears it.
        else if (item.type && item.type !== "userMessage" && item.type !== "reasoning" && existsSync(capFlag(h, id))) void inject(contextIn(hook("cap")));
        const x = itemOf(item, { cwd: cfg.cwd });
        if (x) journal(x, "completed", item.type === "userMessage" ? String(item.clientId ?? "") || null : null);
        else if (streamed.has(item.id)) journal({ id: item.id, skip: true });
        if (streamed.delete(item.id)) emit({ type: "text-end", id: item.id });
        return;
      }
      case "turn/plan/updated": if (p.turnId) journal(todosOf(p.turnId, p.plan)); return;
      case "turn/completed": {
        const turn = p.turn ?? {};
        const now = Date.now();
        const total = usage?.total ?? null;
        const d = (k) => (total && Number.isFinite(total[k]) ? total[k] - (turnTotals?.[k] ?? 0) : null);
        const c = contextOf(usage);
        if (turn.id) journal(turnEnd(turn, { at: now, startedAt: s.turnAt, tokens: { input: d("inputTokens"), output: d("outputTokens"), context: c?.tokens ?? null } }));
        const ms = Number.isFinite(turn.durationMs) ? turn.durationMs : s.turnAt ? now - s.turnAt : null;
        s.turn = null; s.turnAt = null;
        streamed.clear();
        emit({ type: "turn-end", turn: turn.id ?? null, ms, status: turn.status ?? null, error: turn.status === "failed" ? store.oneLine(turn.error?.message ?? "failed") : null, context: c });
        if (turn.status === "failed") {
          const err = turn.error ?? {};
          if (!usageLimited(err)) hook("stop-failure", { error: "unknown", last_assistant_message: err.message ?? null });
          // When the plan resets: from the limits Codex last sent, else asked now (the failure itself does not say).
          else void limitsNow().then((at) => hook("stop-failure", { error: "rate_limit", limit: "usage-codex", last_assistant_message: err.message ?? null, resets_at: at ?? resetsAt }));
          emit({ type: "after-turn" });
          return;
        }
        void snapshot();
        const out = hook("stop", { last_assistant_message: lastWords, background_tasks: [], stop_hook_active: blocked });
        const block = blockIn(out);
        blocked = !!block;
        if (block) void inject(block);
        emit({ type: "after-turn" });
        return;
      }
      case "thread/tokenUsage/updated": {
        usage = p.tokenUsage ?? usage;
        const c = contextOf(p.tokenUsage);
        if (!c) return;
        // A chat's own context is the home's (`context`), as a Claude chat's is.
        if (!id) { store.writeHomeFile(h, "context", { pct: c.pct, session: cfg.session, at: Date.now() }); return; }
        store.writeHomeFile(h, `context-${id}`, { pct: c.pct, at: Date.now(), session: cfg.session, tokens: c.tokens, size: c.size, total: c.total, harness: "codex" });
        const t = store.readTask(h, id);
        if (t) markCap(t, cfg.session, c.pct);
        return;
      }
      case "account/rateLimits/updated":
        if (p.rateLimits?.limitId === "codex" || !p.rateLimits?.limitId) { resetsAt = p.rateLimits?.primary?.resetsAt ? p.rateLimits.primary.resetsAt * 1000 : resetsAt; recordCodex(p.rateLimits); }
        return;
      case "serverRequest/resolved": {
        const was = pending.get(p.requestId);
        pending.delete(p.requestId);
        if (was === "dialog") hook("clear");
        // Answered elsewhere (Codex's own screen, or the request settled itself): the chat's prompt goes too.
        const pid = `codex-${p.requestId}`;
        closed.add(pid);
        if (prompts.delete(pid)) emit({ type: "cancel", rid: p.requestId });
        return;
      }
      default:
    }
  };

  const onRequest = async (m) => {
    if (m.method === "item/tool/requestUserInput") {
      const questions = questionsOf(m.params);
      const reason = reasonIn(hook("ask", { tool_input: { questions } }));
      // Null: the owner watches this window, or the question is malformed: Codex's own screen asks it, as Claude
      // Code's would, and the chat asks it too.
      if (reason) conn.respond(m.id, answerFor(m.params, reason));
      else openPrompt(m.id, m.method, m.params, null);
      return;
    }
    const d = dialogPayload(m.method, m.params);
    if (!d) return;
    // A permission request goes as Claude Code's PermissionRequest hook would: approved on the owner's grant, or held
    // while the owner is away (away.mjs). Codex's decline lets the turn go on but carries no reason, so the note goes
    // in as a steer. With no decision the hook raised the dialog flag, as for any dialog, and the chat shows it.
    const permission = APPROVALS.has(m.method);
    const out = hook("dialog", permission ? { ...d, tool_name: d.tool_name ?? "permissions", tool_input: d.tool_input ?? {}, hook_event_name: "PermissionRequest", harness: "codex" } : d);
    const decided = decisionIn(out);
    if (!decided) { pending.set(m.id, "dialog"); openPrompt(m.id, m.method, m.params, d); return; }
    conn.respond(m.id, approvalAnswer(m.method, m.params, decided.behavior === "allow", decided.message));
    if (decided.behavior !== "allow" && decided.message) void inject(decided.message);
  };

  // ---- the thread
  try {
    for (let i = 0; i < 100 && !existsSync(sock) && !s.exited; i++) await sleep(100);
    const failed = new Promise((_, j) => { failStart = j; });
    // A message that fails here is said on the task: the connection would swallow it.
    conn = await Promise.race([failed, connect(sock, (m) => { try { onMessage(m); } catch (e) { say(`a ${m?.method ?? "message"} from Codex failed: ${e?.stack ?? e}`); } })]);
    conn.done.then(() => { if (!closing) say("the app server closed its connection"); });
    // A chat's contract, read at each start (a remade worktree rewrites it): Codex's developer instructions.
    let instructions = "";
    if (cfg.instructions) { try { instructions = readFileSync(cfg.instructions, "utf8").trim(); } catch {} }
    const settings = {
      cwd: cfg.cwd, approvalPolicy: cfg.approvalPolicy, approvalsReviewer: cfg.approvalsReviewer, sandbox: cfg.sandbox,
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(instructions ? { developerInstructions: instructions } : {}),
      config: {
        ...(cfg.effort ? { model_reasoning_effort: cfg.effort } : {}),
        ...(cfg.sandbox === "workspace-write" ? { sandbox_workspace_write: { network_access: true, writable_roots: cfg.writableRoots ?? [] } } : {}),
      },
    };
    const opened = await Promise.race([failed, cfg.thread
      ? conn.request("thread/resume", { threadId: cfg.thread, ...settings })
      : conn.request("thread/start", { ...settings, serviceName: "rollcall" })]);
    s.thread = opened?.thread?.id ?? cfg.thread;
    up = true;
    // A thread resumed whose journal is gone (or never written): its saved history.
    if (cfg.thread && !existsSync(jfile)) {
      const lines = historyItems(opened?.thread?.turns, { cwd: cfg.cwd });
      if (lines.length) { try { writeFileSync(jfile, `${lines.map((x) => JSON.stringify(x)).join("\n")}\n`); } catch {} }
    }
  } catch (e) {
    closing = true;
    kill();
    try { conn?.close(); } catch {}
    rmSync(sock, { force: true });
    throw new Error(`${cfg.thread ? "Codex could not resume the thread" : "Codex could not start the thread"}: ${e.message}`);
  }
  nextModel = null; // the thread runs on the launch's model already
  if (s.thread !== cfg.thread) rememberLaunch({ thread: s.thread });
  recordThread(h, id, cfg.session, s.thread);
  hook("session-start", { source: cfg.thread ? "resume" : "startup" });
  // The baseline goes first when a prompt follows at once, so a quick first turn's files are that turn's, not turn 0's.
  s.baseline = snapshot("--baseline");
  void checkHooks(conn, cfg.cwd, h, id, { hosted, note: (text) => emit({ type: "item", item: { id: `rollcall-hooks-${randomBytes(4).toString("hex")}`, at: Date.now(), kind: "system", text }, phase: "completed", clientId: null }) });

  return Object.assign(s, {
    conn, hook, inject, answer, rememberLaunch,
    /** Open prompts or dialogs: a view's quiet point waits for none. */
    get asking() { return prompts.size + pending.size; },
    get prompts() { return [...prompts.values()].map((x) => x.prompt); },
    /** Words into the thread: a new turn when idle, else steered into the running one. Resolves to { how }. */
    async say(text, attachments = [], cid = clientId(DELIVERY), { effort = null } = {}) {
      const input = inputOf(text, attachments);
      const how = s.turn ? "queued" : "sent";
      // A turn can end between the record and the send, so on a refusal the server says which turn runs, for one more try.
      for (let i = 0; i < 2; i++) {
        const turnId = i === 0 ? s.turn : await runningTurn();
        try {
          if (turnId) await conn.request("turn/steer", { threadId: s.thread, expectedTurnId: turnId, input, clientUserMessageId: cid }, 5000);
          else {
            await conn.request("turn/start", { threadId: s.thread, input, clientUserMessageId: cid, ...(nextModel ? { model: nextModel } : {}), ...(nextPolicy ?? {}), ...(effort ? { effort } : {}) }, 5000);
            nextModel = null; // a turn's model and mode last for the turns after it
            nextPolicy = null;
          }
          return { how, uuid: cid };
        } catch (e) { if (i) throw e; }
      }
      throw new Error("the app server refused");
    },
    async interrupt() {
      const turnId = s.turn ?? (await runningTurn().catch(() => null));
      if (!turnId) return false;
      await conn.request("turn/interrupt", { threadId: s.thread, turnId }, 5000);
      return true;
    },
    /** From the next turn rollcall starts, and for every resume after. */
    setModel(model) { nextModel = model; rememberLaunch({ model }); return Promise.resolve({}); },
    /**
     * A chat's mode (host/chat.mjs CODEX_MODES), from the next turn rollcall starts (a running turn keeps the one it
     * started with), and for every resume after.
     */
    setMode(mode) {
      const policy = policyFor(mode);
      rememberLaunch({ mode, ...policy });
      nextPolicy = { approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer, sandboxPolicy: sandboxPolicyOf({ sandbox: policy.sandbox, writableRoots: cfg.writableRoots ?? [] }) };
      return Promise.resolve({});
    },
    /** Ends the session: the SessionEnd hook, then the server. */
    close(reason = "exit") {
      if (closing) return;
      closing = true;
      hook("session-end", { reason });
      try { conn.close(); } catch {}
      kill();
      rmSync(sock, { force: true });
    },
    kill(sig = "SIGTERM") { closing = true; kill(sig); rmSync(sock, { force: true }); },
  });
}

/** Stops app server `pid` that a killed process left on socket `sock` (only while that id still runs one on it). */
export function killServer(pid, sock) {
  if (!Number.isInteger(pid) || !pidAlive(pid)) return;
  const cmd = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).stdout ?? "";
  if (/\bapp-server\b/.test(cmd) && cmd.includes(String(sock ?? "\0"))) { try { process.kill(pid, "SIGTERM"); } catch {} }
}

/** The task's session `session` ran Codex thread `thread`: on the record, so a resume finds it. */
function recordThread(h, id, session, thread) {
  store.withTasksLock(h, () => {
    const x = store.readTask(h, id);
    const s = x?.sessions?.find((y) => y.id === session);
    if (!s || s.thread === thread) return;
    s.thread = thread;
    s.harness = "codex";
    store.writeTask(x);
  });
}

/**
 * Hooks Codex has not been told to trust do not run, the owner's guards among them: said on the task once per
 * worker start, for the owner to trust them in Codex's /hooks (the one step that is theirs).
 */
async function checkHooks(conn, cwd, h, id, { hosted = false, note = null } = {}) {
  try {
    const r = await conn.request("hooks/list", { cwds: [cwd] });
    const hooks = (r?.data ?? []).flatMap((e) => e.hooks ?? []);
    const untrusted = hooks.filter((x) => x.enabled && (x.trustStatus === "untrusted" || x.trustStatus === "modified"));
    if (!untrusted.length) return;
    // A chat has no task to note it on: the chat itself says it, once per start.
    if (!id) { note?.(`${untrusted.length} of Codex's hooks are not trusted, so they do not run in this chat (your guards among them). Trust them once: run \`codex\` in this chat's folder, "Review hooks", then trust all.`); return; }
    const where = `in Codex's own screen (run \`codex\` in the task's worktree), "Review hooks", then trust all`;
    store.withTasksLock(h, () => {
      const x = store.readTask(h, id);
      if (!x) return;
      x.notes.push({ at: Date.now(), by: "rollcall", text: `codex: ${untrusted.length} of its hooks are not trusted, so they do not run on this worker (the owner's guards among them). The owner trusts them once: ${where}.` });
      store.writeTask(x);
    });
    // The owner's step, so it is news for the supervisor too.
    store.enqueueWake(h, { task: id, kind: "hooks-untrusted", count: untrusted.length });
  } catch {}
}
