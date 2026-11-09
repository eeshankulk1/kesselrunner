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
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BIN } from "../session.mjs";
import * as store from "../store.mjs";
import { capFlag, markCap, workerHook } from "../supervisor.mjs";
import { launchFile, stateFile } from "../harness/codex.mjs";
import { recordCodex } from "../usage.mjs";
import { connect } from "./rpc.mjs";

// The protocol's pieces live in session.mjs, which the agent host's Codex agents run on too.
import { answerFor, approvalAnswer, clientId, contextOf, decisionIn, dialogPayload, questionsOf, usageLimited, APPROVALS, DELIVERY, INJECTED, textOf } from "./session.mjs";
export { APPROVALS, DELIVERY, INJECTED, answerFor, approvalAnswer, clientId, contextOf, decisionIn, dialogPayload, questionsOf, textOf, usageLimited };
const contextIn = (out) => { try { return JSON.parse(out)?.hookSpecificOutput?.additionalContext ?? null; } catch { return null; } };
const reasonIn = (out) => { try { return JSON.parse(out)?.hookSpecificOutput?.permissionDecisionReason ?? null; } catch { return null; } };
const blockIn = (out) => { try { const x = JSON.parse(out); return x?.decision === "block" ? x.reason : null; } catch { return null; } };

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

  // A worker of this task killed outright (SIGKILL: no handler runs) left its server and socket: they go first.
  leftovers(h, id);
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
    // Only its own record: a new worker of the task may have written its own meanwhile.
    try { if (JSON.parse(readFileSync(stateFile(h, id), "utf8")).pid === process.pid) rmSync(stateFile(h, id), { force: true }); } catch {}
    process.exit(code);
  };
  for (const s of ["SIGHUP", "SIGTERM"]) process.on(s, () => { hook("session-end", { reason: "signal" }); stopAll(0); });
  // Whatever ends this process ends its server too: a crash here must not leave it running on its socket.
  process.on("uncaughtException", (e) => { log(`the worker process failed: ${e?.message ?? e}`); hook("session-end", { reason: "crash" }); stopAll(1); });
  process.on("exit", () => { try { server.kill("SIGTERM"); } catch {} try { ui?.kill("SIGTERM"); } catch {} rmSync(sock, { force: true }); });
  // Ctrl-C belongs to the UI in the foreground; this process shares its terminal and must not die of it.
  process.on("SIGINT", () => {});
  server.on("exit", (code) => { if (!ui) { process.stderr.write(`rollcall: Codex's app server exited (${code}) before the worker started.\n${serverErr}\n`); stopAll(1); } });

  for (let i = 0; i < 100 && !existsSync(sock); i++) await sleep(100);
  const state = { pid: process.pid, server: server.pid, sock, session: cfg.session, thread: null, turn: null, at: Date.now() };
  // Swapped in whole: the watcher and every sender read it while turns start and end.
  const save = () => { const f = stateFile(h, id); const tmp = `${f}.${process.pid}.tmp`; try { writeFileSync(tmp, JSON.stringify(state)); renameSync(tmp, f); } catch { rmSync(tmp, { force: true }); } };
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
        if (cid.startsWith(INJECTED)) { try { store.appendStatus(h, id, { ev: "busy" }); } catch {} return; }
        const out = hook("prompt-submit", { prompt: textOf(p.item), owner: !cid.startsWith("rollcall-") });
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
        void snapshot();
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
    if (!d) return;
    // A permission request goes as Claude Code's PermissionRequest hook would: approved on the owner's grant, or held
    // while the owner is away (away.mjs). Codex's decline lets the turn go on but carries no reason, so the note goes
    // in as a steer. With no decision the hook raised the dialog flag, as for any dialog.
    const permission = APPROVALS.has(m.method);
    const out = hook("dialog", permission ? { ...d, tool_name: d.tool_name ?? "permissions", tool_input: d.tool_input ?? {}, hook_event_name: "PermissionRequest", harness: "codex" } : d);
    const decided = decisionIn(out);
    if (!decided) { pending.set(m.id, "dialog"); return; }
    conn.respond(m.id, approvalAnswer(m.method, m.params, decided.behavior === "allow", decided.message));
    if (decided.behavior !== "allow" && decided.message) void inject(decided.message);
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
  // The baseline goes first when a prompt follows at once, so a quick first turn's files are that turn's, not turn 0's.
  const baseline = snapshot("--baseline");
  if (cfg.prompt) await baseline;
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
    // A UI that ran a while, or one whose server is gone, is not retried: there is nothing left to attach to.
    if (code === 0 || Date.now() - started > 10_000 || server.exitCode !== null || server.signalCode !== null) break;
    await sleep(1000);
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
      x.notes.push({ at: Date.now(), by: "rollcall", text: `codex: ${untrusted.length} of its hooks are not trusted, so they do not run on this worker (the owner's guards among them). The owner trusts them once: in the worker's window, "Review hooks", then trust all.` });
      store.writeTask(x);
    });
    // The owner's step, so it is news for the supervisor too.
    store.enqueueWake(h, { task: id, kind: "hooks-untrusted", count: untrusted.length });
  } catch {}
}
