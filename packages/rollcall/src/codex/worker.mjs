// `rollcall codex-worker <home> <task>`: a Codex worker, as one process in the task's tmux window. It starts the
// worker's own app server on a unix socket, starts the task's thread (or resumes it) and sends the first prompt. The
// server and its thread live as long as this process; what the pane shows is one of two views at a time:
//
//   chat       a plain text view of the conversation, where Enter opens Codex's own UI, Esc stops the turn and y/n
//              answer a prompt. Front ends read the chat (`api conversation`) and answer its prompts.
//   terminal   Codex's terminal UI attached to the same server (`codex --remote`), where the owner watches and types,
//              as a worker ran before the chat view.
//
// A switch waits for a quiet point (no turn running, no prompt open), then starts or stops the UI; the thread never
// stops. The UI quitting on its own ends the server and this process, and the pane falls back to a shell, which reads
// as a dead worker, as with Claude Code.
//
// In both views this process hears every item of the thread and writes the chat's items to its journal
// (`codex-<session>.jsonl`, codex/items.mjs), the text streaming now to stream.live.json, and its record (codex.json:
// the view, a switch waiting, the prompt open). rollcall reaches it through its control socket (`ctl`), with the
// requests a stream-mode Claude worker takes (claude/live.mjs send): say, interrupt, answer, set, switch, state.
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
import { pidAlive } from "../proc.mjs";
import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, randomBytes } from "node:crypto";
import { summaryOf, trimInput } from "../away.mjs";
import { VIEWS, liveFile } from "../claude/live.mjs";
import { bold, cyan, detailOf, dim, safe, screen, userLine, yellow } from "../claude/worker.mjs";
import { BIN } from "../session.mjs";
import * as store from "../store.mjs";
import { capFlag, markCap, workerHook } from "../supervisor.mjs";
import { journalFile, launchFile, stateFile } from "../harness/codex.mjs";
import { recordCodex } from "../usage.mjs";
import { historyItems, itemOf, todosOf, turnEnd, turnStart } from "./items.mjs";
import { connect } from "./rpc.mjs";

const LIVE_MS = 80; // the live file's rewrite, at most this often while text streams
const KEEP_DONE_MS = 1500; // a finished message stays in the live file this long: the journal has it by then
const QUIET_POLL_MS = 500;
const KEY_SETTLE_MS = 300; // a prompt is on screen this long before a key answers it
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

export async function codexWorker([h, id]) {
  let cfg;
  try { cfg = JSON.parse(readFileSync(launchFile(h, id), "utf8")); } catch { process.stderr.write(`rollcall: ${h}:${id} has no Codex launch file\n`); return 1; }
  const { recordAsk } = await import("../task.mjs");
  const hook = (event, p = {}) => { try { return workerHook(h, id, event, { session_id: cfg.session, ...p }, { recordAsk }); } catch { return null; } };
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
  const log = (line) => { try { store.appendStatus(h, id, { ev: "codex", line: store.clip(String(line), 300) }); } catch {} };
  const rememberLaunch = (patch) => {
    Object.assign(cfg, patch);
    const f = launchFile(h, id);
    const tmp = `${f}.${process.pid}.tmp`;
    try { writeFileSync(tmp, JSON.stringify(cfg, null, 2)); renameSync(tmp, f); } catch { rmSync(tmp, { force: true }); }
  };

  // A worker of this task killed outright (SIGKILL: no handler runs) left its server and socket: they go first.
  leftovers(h, id);
  // A unix socket path has room for ~100 bytes: the system temp folder, not the store.
  const sock = join(tmpdir(), `rollcall-codex-${process.pid}.sock`);
  const ctl = join(tmpdir(), `rollcall-codexctl-${process.pid}.sock`);
  rmSync(sock, { force: true });
  rmSync(ctl, { force: true });
  const serverArgs = ["app-server", "--listen", `unix://${sock}`, ...(cfg.questions ? ["--enable", "default_mode_request_user_input"] : [])];
  const server = spawn(cfg.bin, serverArgs, { stdio: ["ignore", "ignore", "pipe"], env: process.env });
  let serverErr = "";
  server.stderr.on("data", (d) => { serverErr = (serverErr + d).slice(-4000); });
  let ui = null; // Codex's own UI, while the terminal view runs
  let up = false; // the thread runs: from here a server that exits ends the worker
  let ending = false;
  let control = null;
  const pane = screen();
  const showing = () => state.view === "chat" && !ui && !ending;
  const say = (fn) => { if (showing()) fn(); };

  const stopAll = (code) => {
    ending = true;
    try { ui?.kill("SIGTERM"); } catch {}
    try { server.kill("SIGTERM"); } catch {}
    try { control?.close(); } catch {}
    rmSync(sock, { force: true });
    rmSync(ctl, { force: true });
    // Only its own record: a new worker of the task may have written its own meanwhile.
    try { if (JSON.parse(readFileSync(stateFile(h, id), "utf8")).pid === process.pid) { rmSync(stateFile(h, id), { force: true }); rmSync(liveFile(h, id), { force: true }); } } catch {}
    process.exit(code);
  };
  for (const s of ["SIGHUP", "SIGTERM"]) process.on(s, () => { hook("session-end", { reason: "signal" }); stopAll(0); });
  // Whatever ends this process ends its server too: a crash here must not leave it running on its socket.
  process.on("uncaughtException", (e) => { log(`the worker process failed: ${e?.stack ?? e}`); hook("session-end", { reason: "crash" }); stopAll(1); });
  process.on("exit", () => { try { server.kill("SIGTERM"); } catch {} try { ui?.kill("SIGTERM"); } catch {} rmSync(sock, { force: true }); rmSync(ctl, { force: true }); });
  // Ctrl-C belongs to the UI in the foreground (or the chat view's keys); this process must not die of it.
  process.on("SIGINT", () => {});
  server.on("exit", (code) => {
    if (ending) return;
    if (!up) { process.stderr.write(`rollcall: Codex's app server exited (${code}) before the worker started.\n${serverErr}\n`); stopAll(1); return; }
    // The thread lived on it: nothing is left to show in either view.
    process.stderr.write(`\nrollcall: Codex's app server stopped (exit ${code}).\n${serverErr.trim().split("\n").slice(-6).join("\n")}\n`);
    log(`Codex's app server stopped (exit ${code})`);
    hook("session-end", { reason: "crash" });
    stopAll(1);
  });

  for (let i = 0; i < 100 && !existsSync(sock); i++) await sleep(100);
  const state = {
    pid: process.pid, server: server.pid, sock, ctl: null, home: h, task: id, session: cfg.session, thread: null, turn: null,
    view: VIEWS.includes(cfg.view) ? cfg.view : "terminal", switching: null, busy: false, turnAt: null, prompt: null, at: Date.now(),
  };
  // Swapped in whole: the watcher, front ends and every sender read it while turns start and end.
  const save = () => {
    state.at = Date.now();
    state.busy = !!state.turn;
    const f = stateFile(h, id);
    const tmp = `${f}.${process.pid}.tmp`;
    try { writeFileSync(tmp, JSON.stringify(state)); renameSync(tmp, f); } catch { rmSync(tmp, { force: true }); }
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
  let conn;

  // ---- the journal and the live file
  const jfile = journalFile(h, id, cfg.session);
  const written = new Map(); // item id -> a hash of the line written last: an unchanged item is not written again
  const firstAt = new Map(); // item id -> when it was first heard: a later line keeps that time
  const journal = (x) => {
    if (!x?.id) return;
    if (firstAt.has(x.id) && x.at != null) x.at = firstAt.get(x.id);
    else if (x.at != null) firstAt.set(x.id, x.at);
    const line = JSON.stringify(x);
    const sum = createHash("sha1").update(line).digest("base64");
    if (written.get(x.id) === sum) return;
    written.set(x.id, sum);
    try { appendFileSync(jfile, `${line}\n`); } catch (e) { log(`the journal did not take a line: ${e.message}`); }
  };
  const live = { items: new Map(), queued: [] };
  let liveTimer = null;
  let sweepTimer = null;
  const writeLive = () => {
    clearTimeout(liveTimer);
    liveTimer = null;
    const now = Date.now();
    for (const [k, x] of live.items) if (x.doneAt && now - x.doneAt > KEEP_DONE_MS) live.items.delete(k);
    const f = liveFile(h, id);
    const tmp = `${f}.${process.pid}.tmp`;
    const body = { session: state.session, at: now, items: [...live.items.values()].filter((x) => x.text).map(({ id: i, kind, text }) => ({ id: i, kind, text })), queued: live.queued.map(({ uuid, text, at, from }) => ({ uuid, text, at, from })) };
    try { writeFileSync(tmp, JSON.stringify(body)); renameSync(tmp, f); } catch { rmSync(tmp, { force: true }); }
    // Finished text leaves the file once the journal surely has it.
    clearTimeout(sweepTimer);
    sweepTimer = [...live.items.values()].some((x) => x.doneAt) ? setTimeout(writeLive, KEEP_DONE_MS + 50) : null;
  };
  const liveSoon = () => { if (!liveTimer) liveTimer = setTimeout(writeLive, LIVE_MS); };
  const streamText = (itemId, kind, add, sep = "") => {
    if (typeof add !== "string" || !add) return;
    let x = live.items.get(itemId);
    if (!x) { x = { id: itemId, kind, text: "", doneAt: null }; live.items.set(itemId, x); }
    x.text += (x.text && sep ? sep : "") + add;
    if (kind === "assistant") say(() => pane.text(itemId, safe(add)));
    liveSoon();
  };

  const inject = async (text) => {
    if (!text || !state.thread) return;
    const input = [{ type: "text", text }];
    const cid = clientId(INJECTED);
    try {
      if (state.turn) await conn.request("turn/steer", { threadId: state.thread, expectedTurnId: state.turn, input, clientUserMessageId: cid });
      else await conn.request("turn/start", { threadId: state.thread, input, clientUserMessageId: cid });
    } catch (e) { log(`could not add rollcall's note: ${e.message}`); }
  };

  // ---- the pane's chat view
  const toolLine = (x) => {
    if (x?.kind === "tool") pane.line(`${cyan("•")} ${cyan(safe(x.tool))} ${dim(safe(store.clip(String(x.summary ?? "").replace(new RegExp(`^${x.tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `), ""), 200)))}`);
    else if (x?.kind === "subagent") pane.line(`${cyan("•")} ${cyan("subagent")} ${dim(safe(store.clip(x.description, 200)))}`);
  };
  let shown = null; // the prompt the pane printed last: { id, at }
  const showPrompt = (p) => {
    shown = { id: p.id, at: Date.now() };
    if (p.kind === "question") {
      pane.line(`${yellow("?")} ${bold(safe(p.questions?.[0]?.question ?? "A question"))}`);
      if (p.questions?.length === 1) p.questions[0].options.forEach((o, n) => pane.line(dim(`  ${n + 1}. ${safe(o.label)}`)));
      pane.hint("Answer with a number, or in the app");
      return;
    }
    pane.line(`${yellow("?")} ${bold(p.tool ? `Allow ${safe(p.tool)}?` : safe(p.summary))}${p.reason ? ` ${dim(safe(p.reason))}` : ""}`);
    for (const l of detailOf(p.tool, p.input)) pane.line(l);
    pane.hint("y approves, n declines (or answer in the app)");
  };
  const header = () => {
    pane.clear();
    pane.line(`${bold(`rollcall · ${h}:${id}`)} ${dim("· chat view · Codex")}`);
    pane.hint("Enter opens Codex's own screen · Esc stops the turn");
  };

  // ---- prompts
  const openPrompt = (req, method, params, d) => {
    const p = promptOf(`codex-${req}`, method, params, d, { cwd: cfg.cwd });
    prompts.set(p.id, { req, method, params, prompt: p });
    state.prompt = p;
    save();
    say(() => showPrompt(p));
  };
  const closePrompt = (pid) => {
    closed.add(pid);
    if (!prompts.delete(pid)) return;
    const next = prompts.size ? [...prompts.values()].at(-1).prompt : null;
    state.prompt = next;
    if (next) say(() => showPrompt(next));
    save();
    trySwitch();
  };
  /** The owner's answer to a prompt, from a front end or the pane's keys: { ok, answered } or { ok, already }. */
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
    say(() => pane.line(dim(`  ${allowed ? "approved" : "declined"}${a.by ? ` from ${safe(a.by)}` : ""}`)));
    closePrompt(a.prompt);
    // A newer request takes no reason with its decline: the owner's words go in as a note the turn reads.
    if (!allowed && a.why && prompt.kind === "permission" && method !== "execCommandApproval" && method !== "applyPatchApproval") void inject(`The owner declined that: ${a.why}`);
    return { ok: true, answered: true };
  };

  // ---- quiet points and the switch
  const quiet = () => !state.turn && !prompts.size && !pending.size && !live.queued.length;
  let switched = null; // resolves the chat view's run when it switches away
  const requestSwitch = (to) => {
    if (!VIEWS.includes(to)) return { ok: false, err: `no view "${to}"` };
    if (to === state.view) { if (state.switching) { state.switching = null; save(); } return { ok: true, already: true, view: state.view }; }
    state.switching = { to, since: Date.now() };
    save();
    const now = trySwitch();
    return { ok: true, switched: now, pending: !now, view: now ? to : state.view };
  };
  // Out of the chat: its run returns and the loop starts the UI. Out of the terminal: the UI stops, at a quiet point.
  const trySwitch = () => {
    if (!state.switching || !quiet()) return false;
    if (state.view === "chat" && switched) { say(() => pane.hint("Opening Codex's own screen…")); const done = switched; switched = null; done("switch"); return true; }
    if (state.view === "terminal" && ui && !ui.switching) { ui.switching = true; try { ui.kill("SIGTERM"); } catch {} return true; }
    return false;
  };
  setInterval(() => { if (state.switching) trySwitch(); }, QUIET_POLL_MS).unref();

  // ---- requests from rollcall (claude/live.mjs send)
  /** The thread's running turn, from the server itself (the record can be a moment behind), or null. */
  const runningTurn = async () => {
    const r = await conn.request("thread/read", { threadId: state.thread, includeTurns: true }, 5000);
    return (r?.thread?.turns ?? []).findLast((t) => t.status === "inProgress")?.id ?? null;
  };
  async function handle(req) {
    if (!req || typeof req !== "object") return { ok: false, err: "bad request" };
    switch (req.op) {
      case "state": return { ok: true, ...state };
      case "switch": return requestSwitch(req.to);
      case "say": {
        if (!state.thread) return { ok: false, err: "its Codex thread has not started yet" };
        const text = String(req.text ?? "");
        if (!text.trim() && !req.attachments?.length) return { ok: false, err: "nothing to say" };
        const input = inputOf(text, req.attachments ?? []);
        const cid = clientId(DELIVERY);
        const how = state.turn ? "queued" : "sent";
        live.queued.push({ uuid: cid, text: input[0].text, at: Date.now(), from: req.from ?? null });
        writeLive();
        // Into the running turn, as Codex takes words typed mid-turn; a turn can end between the record and the send,
        // so on a refusal the server says which turn runs, for one more try.
        try {
          for (let i = 0; i < 2; i++) {
            const turnId = i === 0 ? state.turn : await runningTurn();
            try {
              if (turnId) await conn.request("turn/steer", { threadId: state.thread, expectedTurnId: turnId, input, clientUserMessageId: cid }, 5000);
              else {
                await conn.request("turn/start", { threadId: state.thread, input, clientUserMessageId: cid, ...(nextModel ? { model: nextModel } : {}) }, 5000);
                nextModel = null; // a turn's model lasts for the turns after it
              }
              return { ok: true, how, uuid: cid };
            } catch (e) { if (i) throw e; }
          }
        } catch (e) {
          live.queued = live.queued.filter((x) => x.uuid !== cid);
          writeLive();
          return { ok: false, err: e.message };
        }
        return { ok: false, err: "the app server refused" };
      }
      case "interrupt": {
        const turnId = state.turn ?? (await runningTurn().catch(() => null));
        if (!turnId) return { ok: true, interrupted: false };
        await conn.request("turn/interrupt", { threadId: state.thread, turnId }, 5000);
        return { ok: true, interrupted: true };
      }
      case "answer": return answer(req);
      case "set": {
        if (req.mode) return { ok: false, code: "bad-payload", err: "a Codex worker keeps the permission mode it started with" };
        if (!req.model) return { ok: false, code: "bad-payload", err: "model is required" };
        // From the next turn rollcall starts, and for every resume after.
        nextModel = req.model;
        rememberLaunch({ model: req.model });
        return { ok: true, set: { model: req.model } };
      }
      default: return { ok: false, err: `unknown op ${req.op}` };
    }
  }
  control = createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) { if (buf.length > 4_000_000) c.destroy(); return; }
      let req = null;
      try { req = JSON.parse(buf.slice(0, i)); } catch {}
      Promise.resolve(handle(req)).catch((e) => ({ ok: false, err: e.message })).then((r) => { try { c.end(`${JSON.stringify(r ?? { ok: false, err: "no answer" })}\n`); } catch {} });
    });
    c.on("error", () => {});
  });

  const onMessage = (m) => {
    const p = m.params ?? {};
    if (p.threadId && state.thread && p.threadId !== state.thread) return; // a subagent's thread: not the worker's own
    if (m.id !== undefined && m.method) return void onRequest(m).catch((e) => log(e.message));
    switch (m.method) {
      case "turn/started": {
        state.turn = p.turn?.id ?? null; state.turnAt = Date.now(); lastWords = null;
        turnTotals = usage?.total ?? null;
        save();
        if (state.turn) journal(turnStart(state.turn, state.turnAt));
        return;
      }
      case "item/started": {
        const item = p.item ?? {};
        if (item.type !== "userMessage") {
          const x = itemOf(item, { cwd: cfg.cwd });
          if (x && (x.kind === "tool" || x.kind === "subagent")) { journal(x); say(() => toolLine(x)); }
          return;
        }
        const cid = String(item.clientId ?? "");
        const x = itemOf(item, { cwd: cfg.cwd });
        journal(x);
        const was = live.queued.length;
        live.queued = live.queued.filter((q) => q.uuid !== cid);
        if (live.queued.length !== was) writeLive();
        if (x) say(() => pane.line(`\n${userLine(x.text)}`));
        // A note of the worker's own (a steer from this process) starts nothing: busy is all it says.
        if (cid.startsWith(INJECTED)) { try { store.appendStatus(h, id, { ev: "busy" }); } catch {} return; }
        const out = hook("prompt-submit", { prompt: textOf(item), owner: !cid.startsWith("rollcall-") });
        void inject(contextIn(out));
        return;
      }
      case "item/agentMessage/delta": return streamText(p.itemId, "assistant", p.delta);
      case "item/reasoning/summaryTextDelta": {
        const x = live.items.get(p.itemId);
        const sep = x && x.part !== p.summaryIndex ? "\n\n" : "";
        streamText(p.itemId, "thinking", p.delta, sep);
        const y = live.items.get(p.itemId);
        if (y) y.part = p.summaryIndex;
        return;
      }
      case "item/completed": {
        const item = p.item ?? {};
        if (item.type === "agentMessage" && typeof item.text === "string") lastWords = item.text;
        // After each tool call while the cap flag is up, as Claude Code's PostToolUse hook hears it.
        else if (item.type && item.type !== "userMessage" && item.type !== "reasoning" && existsSync(capFlag(h, id))) void inject(contextIn(hook("cap")));
        const x = itemOf(item, { cwd: cfg.cwd });
        if (x) journal(x);
        else if (live.items.has(item.id)) journal({ id: item.id, skip: true });
        const l = live.items.get(item.id);
        if (l) { l.doneAt = Date.now(); writeLive(); }
        if (x?.kind === "assistant") say(() => { if (!l) pane.line(`\n${safe(x.text)}`); pane.close(); });
        return;
      }
      case "turn/plan/updated": if (p.turnId) journal(todosOf(p.turnId, p.plan)); return;
      case "turn/completed": {
        const turn = p.turn ?? {};
        const now = Date.now();
        const total = usage?.total ?? null;
        const d = (k) => (total && Number.isFinite(total[k]) ? total[k] - (turnTotals?.[k] ?? 0) : null);
        const c = contextOf(usage);
        if (turn.id) journal(turnEnd(turn, { at: now, startedAt: state.turnAt, tokens: { input: d("inputTokens"), output: d("outputTokens"), context: c?.tokens ?? null } }));
        for (const x of live.items.values()) x.doneAt ??= now;
        writeLive();
        const ms = Number.isFinite(turn.durationMs) ? turn.durationMs : state.turnAt ? now - state.turnAt : null;
        say(() => pane.hint(`── ${ms ? `${Math.round(ms / 1000)} s` : "turn ended"}${turn.status === "failed" ? " · failed" : turn.status === "interrupted" ? " · stopped" : ""}${c ? ` · context ${c.pct}%` : ""} · Enter opens Codex's own screen`));
        state.turn = null; state.turnAt = null; save();
        // Words steered in as the turn ended and never taken: gone, rather than shown waiting for good.
        if (live.queued.length) setTimeout(() => { if (!state.turn && live.queued.length) { live.queued = []; writeLive(); trySwitch(); } }, 3000).unref();
        if (turn.status === "failed") {
          const err = turn.error ?? {};
          if (!usageLimited(err)) { hook("stop-failure", { error: "unknown", last_assistant_message: err.message ?? null }); trySwitch(); return; }
          // When the plan resets: from the limits Codex last sent, else asked now (the failure itself does not say).
          void limitsNow().then((at) => hook("stop-failure", { error: "rate_limit", limit: "usage-codex", last_assistant_message: err.message ?? null, resets_at: at ?? resetsAt }));
          trySwitch();
          return;
        }
        void snapshot();
        const out = hook("stop", { last_assistant_message: lastWords, background_tasks: [], stop_hook_active: blocked });
        const block = blockIn(out);
        blocked = !!block;
        if (block) void inject(block);
        trySwitch();
        return;
      }
      case "thread/tokenUsage/updated": {
        usage = p.tokenUsage ?? usage;
        const c = contextOf(p.tokenUsage);
        if (!c) return;
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
        closePrompt(`codex-${p.requestId}`);
        return;
      }
      default:
    }
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

  try {
    // A message that fails here is said on the task: the connection would swallow it.
    conn = await connect(sock, (m) => { try { onMessage(m); } catch (e) { log(`a ${m?.method ?? "message"} from Codex failed: ${e?.stack ?? e}`); } });
  } catch (e) {
    process.stderr.write(`rollcall: could not reach Codex's app server: ${e.message}\n${serverErr}\n`);
    stopAll(1);
  }
  conn.done.then(() => { if (!ending) log("the app server closed its connection"); });

  const settings = {
    cwd: cfg.cwd, approvalPolicy: cfg.approvalPolicy, approvalsReviewer: cfg.approvalsReviewer, sandbox: cfg.sandbox,
    ...(cfg.model ? { model: cfg.model } : {}),
    config: {
      ...(cfg.effort ? { model_reasoning_effort: cfg.effort } : {}),
      ...(cfg.sandbox === "workspace-write" ? { sandbox_workspace_write: { network_access: true, writable_roots: cfg.writableRoots ?? [] } } : {}),
    },
  };
  let opened;
  try {
    opened = cfg.thread
      ? await conn.request("thread/resume", { threadId: cfg.thread, ...settings })
      : await conn.request("thread/start", { ...settings, serviceName: "rollcall" });
    state.thread = opened?.thread?.id ?? cfg.thread;
  } catch (e) {
    process.stderr.write(`rollcall: Codex could not ${cfg.thread ? "resume" : "start"} the thread: ${e.message}\n`);
    stopAll(1);
  }
  up = true;
  nextModel = null; // the thread runs on the launch's model already
  // A thread this worker resumes whose journal is gone (or never written, before the chat view): its saved history.
  if (cfg.thread && !existsSync(jfile)) {
    const lines = historyItems(opened?.thread?.turns, { cwd: cfg.cwd });
    if (lines.length) { try { writeFileSync(jfile, `${lines.map((x) => JSON.stringify(x)).join("\n")}\n`); } catch {} }
  }
  await new Promise((resolve) => control.listen(ctl, resolve));
  try { chmodSync(ctl, 0o600); } catch {} // only the owner reaches it, whatever the umask or the temp folder
  state.ctl = ctl;
  save();
  recordThread(h, id, cfg.session, state.thread);
  hook("session-start", { source: cfg.thread ? "resume" : "startup" });
  // The baseline goes first when a prompt follows at once, so a quick first turn's files are that turn's, not turn 0's.
  const baseline = snapshot("--baseline");
  if (cfg.prompt) await baseline;
  void checkHooks(conn, cfg.cwd, h, id);

  // The chat view's header goes up before the first turn, so the turn's lines print under it.
  if (state.view === "chat") header();
  let headed = state.view === "chat";
  if (cfg.prompt) {
    let prompt = "";
    try { prompt = readFileSync(cfg.prompt, "utf8"); } catch {}
    if (prompt) {
      try { await conn.request("turn/start", { threadId: state.thread, input: [{ type: "text", text: prompt }], clientUserMessageId: clientId("rollcall-l-"), ...(cfg.effort ? { effort: cfg.effort } : {}) }); }
      catch (e) { log(`the first prompt did not go in: ${e.message}`); }
      // Codex's own screen resumes from the thread's saved record, which its first message starts.
      if (state.view === "terminal") { for (let i = 0; i < 50 && !state.turn; i++) await sleep(100); await sleep(300); }
    }
  }

  // ---- the views
  const keys = (d) => {
    const s = String(d);
    if (!showing()) return;
    if (s === "\r" || s === "\n") { const r = requestSwitch("terminal"); if (r.pending) pane.hint(state.turn || prompts.size ? "Codex's own screen opens when this turn ends." : "Codex's own screen opens in a moment."); return; }
    if (s === "\x1b" || s === "\x03") { if (state.turn) { pane.hint("Stopping the turn…"); void handle({ op: "interrupt" }).catch(() => {}); } return; }
    const p = state.prompt;
    // A key answers only the prompt the pane shows, and only once it has been there a moment.
    if (!p || shown?.id !== p.id || Date.now() - shown.at < KEY_SETTLE_MS) return;
    if (p.kind === "permission" && /^[yn]$/i.test(s)) { answer({ prompt: p.id, allow: /y/i.test(s), by: "the terminal" }); return; }
    if (p.kind === "question" && p.questions?.length === 1 && /^[1-9]$/.test(s)) {
      const o = p.questions[0].options[Number(s) - 1];
      if (o) answer({ prompt: p.id, answers: { [p.questions[0].question]: o.label }, by: "the terminal" });
    }
  };
  const rawKeys = (on) => {
    if (!process.stdin.isTTY) return;
    try { process.stdin.setRawMode(on); } catch {}
    if (on) { process.stdin.on("data", keys); process.stdin.resume(); } else { process.stdin.off("data", keys); process.stdin.pause(); }
  };
  const runChat = () => new Promise((resolve) => {
    switched = resolve;
    if (!headed) header();
    headed = false; // a later return from the terminal view starts a clean screen
    if (state.prompt) showPrompt(state.prompt);
    rawKeys(true);
    trySwitch();
  }).then((r) => { rawKeys(false); pane.close(); state.view = "terminal"; state.switching = null; rememberLaunch({ view: "terminal" }); save(); return r; });

  // Codex's UI stopped by a signal leaves the terminal as it set it (raw, its own screen, mouse and key reporting on):
  // the plain view needs it back as a shell has it.
  const restoreTerminal = () => {
    if (!process.stdout.isTTY) return;
    try { process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[<u\x1b[0m"); } catch {}
    spawnSync("stty", ["sane"], { stdio: "inherit", timeout: 2000 });
  };
  // Codex's own UI on the same server. A UI that cannot attach yet tries again, briefly.
  const runTerminal = async () => {
    pane.clear();
    let code = 1;
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = Date.now();
      ui = spawn(cfg.bin, ["--remote", `unix://${sock}`, "resume", state.thread], { stdio: "inherit", env: process.env });
      const child = ui;
      code = await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 0)));
      ui = null;
      if (ending) return "exit";
      if (child.switching) { restoreTerminal(); state.view = "chat"; state.switching = null; rememberLaunch({ view: "chat" }); save(); return "switch"; }
      // A UI that ran a while, or one whose server is gone, is not retried: there is nothing left to attach to.
      if (code === 0 || Date.now() - started > 10_000 || server.exitCode !== null || server.signalCode !== null) break;
      await sleep(1000);
    }
    return code === 0 ? "exit" : "crash";
  };

  let code = 0;
  for (;;) {
    const r = state.view === "chat" ? await runChat() : await runTerminal();
    if (r === "switch") continue;
    code = r === "crash" ? 1 : 0;
    break;
  }
  hook("session-end", { reason: "exit" });
  stopAll(code);
}


/**
 * What an earlier worker of the task left when it was killed outright: its app server (by the pid it recorded, and
 * only while that id still runs a codex app server, so a reused id is left alone) and its socket.
 */
function leftovers(h, id) {
  let rec = null;
  try { rec = JSON.parse(readFileSync(stateFile(h, id), "utf8")); } catch { return; }
  if (rec?.pid && rec.pid !== process.pid && pidAlive(rec.pid)) return; // that worker still runs: not ours to touch
  if (Number.isInteger(rec?.server) && pidAlive(rec.server)) {
    const cmd = spawnSync("ps", ["-o", "command=", "-p", String(rec.server)], { encoding: "utf8", timeout: 2000 }).stdout ?? "";
    if (/\bapp-server\b/.test(cmd) && cmd.includes(String(rec.sock ?? "\0"))) { try { process.kill(rec.server, "SIGTERM"); } catch {} }
  }
  if (rec?.sock) rmSync(rec.sock, { force: true });
  rmSync(stateFile(h, id), { force: true });
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
async function checkHooks(conn, cwd, h, id) {
  try {
    const r = await conn.request("hooks/list", { cwds: [cwd] });
    const hooks = (r?.data ?? []).flatMap((e) => e.hooks ?? []);
    const untrusted = hooks.filter((x) => x.enabled && (x.trustStatus === "untrusted" || x.trustStatus === "modified"));
    if (!untrusted.length) return;
    store.withTasksLock(h, () => {
      const x = store.readTask(h, id);
      if (!x) return;
      x.notes.push({ at: Date.now(), by: "rollcall", text: `codex: ${untrusted.length} of its hooks are not trusted, so they do not run on this worker (the owner's guards among them). The owner trusts them once: in Codex's own screen in the worker's window (Enter there opens it from the chat view), "Review hooks", then trust all.` });
      store.writeTask(x);
    });
    // The owner's step, so it is news for the supervisor too.
    store.enqueueWake(h, { task: id, kind: "hooks-untrusted", count: untrusted.length });
  } catch {}
}
