// `rollcall codex-worker <home> <task>`: a Codex worker, as one process in the task's tmux window. It starts the
// worker's own app server on a unix socket, starts the task's thread (or resumes it), sends the first prompt, and
// runs Codex's terminal UI attached to the same server in the foreground, where the owner watches and types. All
// three live and die together: the UI exiting ends the server and this process, and the pane falls back to a shell,
// which reads as a dead worker, as with Claude Code.
//
// The protocol stands in for Claude Code's hooks: each event below goes through supervisor.workerHook as the hook
// of the same name would, so a Codex worker's task record moves exactly as a Claude worker's does.
//   item/started userMessage   -> prompt-submit (receipts, busy, the context notes, a question still open)
//   turn/completed             -> stop (idle, last words, the cap's block) or stop-failure (a usage limit)
//   approval server requests   -> dialog; serverRequest/resolved -> clear
//   item/tool/requestUserInput -> ask (the owner's picker in the supervisor), answered with the hook's reason
//   thread/tokenUsage/updated  -> the context use the status line records for Claude Code, and the cap flag
//   account/rateLimits/updated -> the usage meter
// What a hook would add to the model's context goes in as a steer into the running turn; a Stop hook's block is a
// new turn. rollcall's own messages carry a clientUserMessageId starting "rollcall-", so the UI's are the owner's.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import * as store from "../store.mjs";
import { capFlag, markCap, workerHook } from "../supervisor.mjs";
import { launchFile, stateFile } from "../harness/codex.mjs";
import { recordCodex } from "../usage.mjs";
import { connect } from "./rpc.mjs";

/** rollcall's messages into a thread: "rollcall-d-" a delivery (send.mjs), "rollcall-i-" a note of the worker's own. */
export const DELIVERY = "rollcall-d-";
export const INJECTED = "rollcall-i-";
export const clientId = (prefix) => `${prefix}${randomBytes(6).toString("hex")}`;

/** The text of a userMessage item: its text parts, joined. */
export const textOf = (item) => (item?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n").trim();

/** Codex's server requests that open a dialog the owner answers, as the hook payload Claude Code's PermissionRequest would carry. */
export function dialogPayload(method, p) {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    const command = Array.isArray(p?.command) ? p.command.join(" ") : p?.command ?? "";
    return { tool_name: "Bash", tool_input: { command, description: p?.reason ?? undefined }, notification_type: "permission_prompt", message: p?.reason ?? null };
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    return { tool_name: "Edit", tool_input: { file_path: p?.grantRoot ?? Object.keys(p?.fileChanges ?? {})[0] ?? "" }, notification_type: "permission_prompt", message: p?.reason ?? null };
  }
  if (method === "item/permissions/requestApproval") return { tool_name: null, notification_type: "permission_prompt", message: p?.reason ?? "Codex asks for more permissions" };
  if (method === "mcpServer/elicitation/request") return { tool_name: null, notification_type: "elicitation_dialog", message: `${p?.serverName ?? "an MCP server"} asks for input` };
  return null;
}

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

export async function codexWorker([h, id]) {
  let cfg;
  try { cfg = JSON.parse(readFileSync(launchFile(h, id), "utf8")); } catch { process.stderr.write(`rollcall: ${h}:${id} has no Codex launch file\n`); return 1; }
  const { recordAsk } = await import("../task.mjs");
  const hook = (event, p = {}) => { try { return workerHook(h, id, event, { session_id: cfg.session, ...p }, { recordAsk }); } catch { return null; } };
  const log = (line) => { try { store.appendStatus(h, id, { ev: "codex", line: store.clip(String(line), 300) }); } catch {} };

  // A unix socket path has room for ~100 bytes: the system temp folder, not the store.
  const sock = join(tmpdir(), `rollcall-codex-${process.pid}.sock`);
  rmSync(sock, { force: true });
  const serverArgs = ["app-server", "--listen", `unix://${sock}`, ...(cfg.questions ? ["--enable", "default_mode_request_user_input"] : [])];
  const server = spawn(cfg.bin, serverArgs, { stdio: ["ignore", "ignore", "pipe"], env: process.env });
  let serverErr = "";
  server.stderr.on("data", (d) => { serverErr = (serverErr + d).slice(-4000); });
  let ui = null;
  const stopAll = (code) => {
    try { ui?.kill("SIGTERM"); } catch {}
    try { server.kill("SIGTERM"); } catch {}
    rmSync(sock, { force: true });
    rmSync(stateFile(h, id), { force: true });
    process.exit(code);
  };
  for (const s of ["SIGHUP", "SIGTERM"]) process.on(s, () => { hook("session-end", { reason: "signal" }); stopAll(0); });
  // Ctrl-C belongs to the UI in the foreground; this process shares its terminal and must not die of it.
  process.on("SIGINT", () => {});
  server.on("exit", (code) => { if (!ui) { process.stderr.write(`rollcall: Codex's app server exited (${code}) before the worker started.\n${serverErr}\n`); stopAll(1); } });

  for (let i = 0; i < 100 && !existsSync(sock); i++) await sleep(100);
  const state = { pid: process.pid, sock, session: cfg.session, thread: null, turn: null, at: Date.now() };
  const save = () => { try { writeFileSync(stateFile(h, id), JSON.stringify(state)); } catch {} };
  const pending = new Map(); // server request id -> what it is
  let lastWords = null;
  let resetsAt = null; // when the Codex limit resets, from the last rate limits heard (ms)
  let blocked = false; // the cap's block went out this turn: once, as Claude Code's stop_hook_active
  let conn;

  const inject = async (text) => {
    if (!text || !state.thread) return;
    const input = [{ type: "text", text }];
    const cid = clientId(INJECTED);
    try {
      if (state.turn) await conn.request("turn/steer", { threadId: state.thread, expectedTurnId: state.turn, input, clientUserMessageId: cid });
      else await conn.request("turn/start", { threadId: state.thread, input, clientUserMessageId: cid });
    } catch (e) { log(`could not add rollcall's note: ${e.message}`); }
  };

  const onMessage = (m) => {
    const p = m.params ?? {};
    if (p.threadId && state.thread && p.threadId !== state.thread) return; // a subagent's thread: not the worker's own
    if (m.id !== undefined && m.method) return void onRequest(m).catch((e) => log(e.message));
    switch (m.method) {
      case "turn/started":
        state.turn = p.turn?.id ?? null; lastWords = null; save(); return;
      case "item/started": {
        if (p.item?.type !== "userMessage") return;
        const cid = String(p.item.clientId ?? "");
        // A note of the worker's own (a steer from this process) starts nothing: busy is all it says.
        if (cid.startsWith(INJECTED)) { store.appendStatus(h, id, { ev: "busy" }); return; }
        const out = hook("prompt-submit", { prompt: textOf(p.item), owner: !cid.startsWith(DELIVERY) && !cid.startsWith("rollcall-") });
        void inject(contextIn(out));
        return;
      }
      case "item/completed":
        if (p.item?.type === "agentMessage" && typeof p.item.text === "string") lastWords = p.item.text;
        // After each tool call while the cap flag is up, as Claude Code's PostToolUse hook hears it.
        else if (p.item?.type && p.item.type !== "userMessage" && p.item.type !== "reasoning" && existsSync(capFlag(h, id))) void inject(contextIn(hook("cap")));
        return;
      case "turn/completed": {
        state.turn = null; save();
        const turn = p.turn ?? {};
        if (turn.status === "failed") {
          const err = turn.error ?? {};
          if (!usageLimited(err)) { hook("stop-failure", { error: "unknown", last_assistant_message: err.message ?? null }); return; }
          // When the plan resets: from the limits Codex last sent, else asked now (the failure itself does not say).
          void limitsNow().then((at) => hook("stop-failure", { error: "rate_limit", limit: "usage-codex", last_assistant_message: err.message ?? null, resets_at: at ?? resetsAt }));
          return;
        }
        const out = hook("stop", { last_assistant_message: lastWords, background_tasks: [], stop_hook_active: blocked });
        const block = blockIn(out);
        blocked = !!block;
        if (block) void inject(block);
        return;
      }
      case "thread/tokenUsage/updated": {
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
      // Null: the owner watches this window, or the question is malformed: the UI asks it, as Claude Code's would.
      if (reason) conn.respond(m.id, answerFor(m.params, reason));
      return;
    }
    const d = dialogPayload(m.method, m.params);
    if (d) { pending.set(m.id, "dialog"); hook("dialog", d); }
  };

  try {
    conn = await connect(sock, onMessage);
  } catch (e) {
    process.stderr.write(`rollcall: could not reach Codex's app server: ${e.message}\n${serverErr}\n`);
    stopAll(1);
  }
  conn.done.then(() => { if (ui) { log("the app server closed its connection"); } });

  const settings = {
    cwd: cfg.cwd, approvalPolicy: cfg.approvalPolicy, approvalsReviewer: cfg.approvalsReviewer, sandbox: cfg.sandbox,
    ...(cfg.model ? { model: cfg.model } : {}),
    config: {
      ...(cfg.effort ? { model_reasoning_effort: cfg.effort } : {}),
      ...(cfg.sandbox === "workspace-write" ? { sandbox_workspace_write: { network_access: true, writable_roots: cfg.writableRoots ?? [] } } : {}),
    },
  };
  try {
    const r = cfg.thread
      ? await conn.request("thread/resume", { threadId: cfg.thread, ...settings })
      : await conn.request("thread/start", { ...settings, serviceName: "rollcall" });
    state.thread = r?.thread?.id ?? cfg.thread;
  } catch (e) {
    process.stderr.write(`rollcall: Codex could not ${cfg.thread ? "resume" : "start"} the thread: ${e.message}\n`);
    stopAll(1);
  }
  save();
  recordThread(h, id, cfg.session, state.thread);
  hook("session-start", { source: cfg.thread ? "resume" : "startup" });
  void checkHooks(conn, cfg.cwd, h, id);

  if (cfg.prompt) {
    let prompt = "";
    try { prompt = readFileSync(cfg.prompt, "utf8"); } catch {}
    if (prompt) {
      try { await conn.request("turn/start", { threadId: state.thread, input: [{ type: "text", text: prompt }], clientUserMessageId: clientId("rollcall-l-"), ...(cfg.effort ? { effort: cfg.effort } : {}) }); }
      catch (e) { log(`the first prompt did not go in: ${e.message}`); }
      // The UI resumes from the thread's saved record, which its first message starts.
      for (let i = 0; i < 50 && !state.turn; i++) await sleep(100);
      await sleep(300);
    }
  }

  // The owner's view: Codex's own UI on the same server. A UI that cannot attach yet tries again, briefly.
  let code = 1;
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = Date.now();
    ui = spawn(cfg.bin, ["--remote", `unix://${sock}`, "resume", state.thread], { stdio: "inherit", env: process.env });
    code = await new Promise((resolve) => ui.on("exit", (c) => resolve(c ?? 0)));
    if (code === 0 || Date.now() - started > 10_000) break;
    await sleep(1000);
  }
  hook("session-end", { reason: "exit" });
  stopAll(code);
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
      x.notes.push({ at: Date.now(), by: "rollcall", text: `codex: ${untrusted.length} of its hooks are not trusted, so they do not run on this worker (the owner's guards among them). The owner trusts them once: in the worker's window, "Review hooks", then trust all.` });
      store.writeTask(x);
    });
  } catch {}
}
