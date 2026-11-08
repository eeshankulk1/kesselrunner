// `rollcall claude-worker <home> [<task>]`: a Claude Code worker (or, with no task, the supervisor itself) as one
// process in its tmux window, in one of two views at a time:
//
//   chat       Claude Code in its stream mode (the one its SDK uses): `-p` with stream-json in and out, partial
//              messages, and permission prompts over the pipe. The owner's whole setup loads (hooks, skills,
//              CLAUDE.md, MCP), so the hooks report to the task exactly as in the CLI. Front ends read the chat
//              (conversation.mjs) and answer its prompts; the pane shows a plain text view of it, where Enter
//              opens the real CLI.
//   terminal   the real CLI (`claude --resume <session>`) in the foreground, as a worker ran before this.
//
// A switch keeps the session (`--resume`) and waits for a quiet point: no turn running, no prompt open. The CLI
// quitting on its own (a /exit) ends the worker and the pane falls back to a shell, which reads as a dead worker.
//
// rollcall reaches it through a unix socket (claude/live.mjs send): `say`, `interrupt`, `answer`, `set`, `switch`,
// one JSON line in and one out. Its record (claude.json) says which view runs, whether a switch waits, and the
// prompt open now; stream.live.json holds the text streaming now and the messages waiting for the turn.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { summaryOf, trimInput } from "../away.mjs";
import { dialogFlag } from "../delivery.mjs";
import { P } from "../session.mjs";
import * as store from "../store.mjs";
import { recordClaude } from "../usage.mjs";
import { VIEWS, launchFile, liveFile, readJson, recordFile, turnsFile, writeJson } from "./live.mjs";

const LIVE_MS = 80; // the live file's rewrite, at most this often while text streams
const KEEP_DONE_MS = 4000; // a finished block stays in the live file this long: the transcript has it by then
const QUIET_POLL_MS = 500;
const KEY_SETTLE_MS = 300; // a prompt is on screen this long before a key answers it
const IMAGE = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const IMAGE_MAX = 5 * 1024 * 1024;

/** A user message's content: the owner's text, images inline, other attached files named for the worker to read. */
export function contentOf(text, attachments = []) {
  const images = [];
  const named = [];
  for (const p of attachments) {
    const media = IMAGE[extname(String(p)).toLowerCase()];
    if (media) {
      try {
        const data = readFileSync(p);
        if (data.length <= IMAGE_MAX) { images.push({ type: "image", source: { type: "base64", media_type: media, data: data.toString("base64") } }); named.push(p); continue; }
      } catch {}
    }
    named.push(p);
  }
  const body = named.length ? `${text}\n\n[Attached: ${named.join(", ")}]` : String(text);
  return images.length ? [...images, { type: "text", text: body }] : body;
}

/** The prompt a `can_use_tool` request opens, as a front end shows it (the contract's Prompt). */
export function promptOf(req, requestId, { cwd = null, relays = null, now = Date.now() } = {}) {
  const tool = req.tool_name ?? null;
  const input = req.input && typeof req.input === "object" ? req.input : {};
  const kind = tool === "AskUserQuestion" ? "question" : tool === "ExitPlanMode" ? "plan" : "permission";
  return {
    id: requestId, at: now, kind, tool,
    input: trimInput(input), summary: summaryOf({ worktree: cwd }, tool, input),
    reason: typeof req.description === "string" ? req.description : typeof input.description === "string" ? input.description : null,
    questions: kind === "question" && Array.isArray(input.questions)
      ? input.questions.map((x) => ({ question: x.question, header: x.header ?? "", multiSelect: !!x.multiSelect, options: (x.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })) }))
      : null,
    plan: kind === "plan" && typeof input.plan === "string" ? input.plan : null,
    relays,
    suggestions: Array.isArray(req.permission_suggestions) ? req.permission_suggestions : null,
  };
}

/** The modes a front end or the pane may set: the ones Shift-Tab cycles in the CLI. Wider ones stay the launch's. */
export const SET_MODES = new Set(["default", "acceptEdits", "plan"]);
/** The modes an approved plan may continue in. */
export const PLAN_MODES = new Set(["default", "acceptEdits"]);

/**
 * The answer to a `can_use_tool` request, from what the owner said about prompt `p` (the original input in `input`).
 * Only an explicit allow allows; `always` adds only the suggestions that last for this session, never a rule written
 * to a settings file or a new directory.
 */
export function decisionFor(p, input, a) {
  if (p.kind === "question") {
    const answers = a.allow !== false && a.answers && typeof a.answers === "object" ? a.answers : null;
    if (!answers) return { behavior: "deny", message: a.why || "The owner did not answer." };
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }
  if (a.allow !== true) return { behavior: "deny", message: a.why ? `The owner declined: ${a.why}` : "The owner declined this." };
  const out = { behavior: "allow", updatedInput: input };
  const session = a.always === true && p.kind === "permission" ? (p.suggestions ?? []).filter((x) => x?.destination === "session") : [];
  if (session.length) out.updatedPermissions = session;
  return out;
}

/** Text from Claude or a tool, safe to print in the pane: no control characters (an escape could redraw a prompt). */
export const safe = (s) => String(s ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

/** What the pane shows under a prompt before y approves it: the whole command, edit or input, never a clipped line. */
export function detailOf(tool, input) {
  const i = input && typeof input === "object" ? input : {};
  const lines = (prefix, text) => safe(text).split("\n").map((l) => `${prefix}${l}`);
  if (typeof i.command === "string") return lines("  $ ", i.command);
  if (tool === "Edit" && typeof i.old_string === "string") return [...lines("  - ", i.old_string), ...lines("  + ", i.new_string ?? "")];
  if (tool === "MultiEdit" && Array.isArray(i.edits)) return i.edits.flatMap((e) => [...lines("  - ", e?.old_string ?? ""), ...lines("  + ", e?.new_string ?? "")]);
  if (tool === "Write" && typeof i.content === "string") return lines("  + ", i.content);
  if (tool === "NotebookEdit" && typeof i.new_source === "string") return lines("  + ", i.new_source);
  const json = JSON.stringify(i, null, 2);
  return json && json !== "{}" ? lines("  ", json) : [];
}

/** The context use one model request says: { pct, tokens, size }, or null. */
export function contextOf(usage, size) {
  if (!usage || !Number.isFinite(size) || size <= 0) return null;
  const tokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  if (!tokens) return null;
  return { pct: Math.min(100, Math.round((tokens / size) * 100)), tokens, size };
}

/** The account's limits a stream's rate_limit_event carries, as the status line reports them (usage.mjs). */
export function limitsOf(info) {
  const w = info?.unifiedWindows;
  if (!w || typeof w !== "object") return null;
  const one = (x) => (x && Number.isFinite(x.utilization) ? { used_percentage: x.utilization * 100, resets_at: x.resetsAt ?? null } : undefined);
  return { five_hour: one(w.five_hour), seven_day: one(w.seven_day) };
}

// ---------------------------------------------------------------- the plain text view in the pane

const ESC = "\x1b[";
export const dim = (s) => `${ESC}2m${s}${ESC}0m`;
export const bold = (s) => `${ESC}1m${s}${ESC}0m`;
export const cyan = (s) => `${ESC}36m${s}${ESC}0m`;
export const yellow = (s) => `${ESC}33m${s}${ESC}0m`;

export function screen(out = process.stdout) {
  let open = null; // the block whose text streams on the current line
  const w = (s) => { try { out.write(s); } catch {} };
  const close = () => { if (open) { w("\n"); open = null; } };
  return {
    clear: () => w(`${ESC}2J${ESC}H`),
    line: (s) => { close(); w(`${s}\n`); },
    text: (id, delta) => { if (open !== id) { close(); w("\n"); open = id; } w(delta); },
    close,
    hint: (s) => { close(); w(`${dim(s)}\n`); },
  };
}

export const userLine = (text) => {
  const t = safe(text);
  return t.startsWith(P) ? dim(`› ${store.clip(store.oneLine(t), 400)}`) : `${bold("› You")}  ${store.clip(t, 4000)}`;
};

// ---------------------------------------------------------------- the worker

export async function claudeWorker([h, task]) {
  const id = task ?? null;
  const cfg = readJson(launchFile(h, id));
  if (!cfg) { process.stderr.write(`rollcall: ${id ? `${h}:${id}` : h} has no Claude launch file\n`); return 1; }
  const where = id ? `${h}:${id}` : h;
  if (!id) await loadFinder();
  const ui = screen();
  const log = (line) => { if (id) { try { store.appendStatus(h, id, { ev: "stream", line: store.clip(String(line), 300) }); } catch {} } };

  const state = {
    pid: process.pid, child: null, sock: null, home: h, task: id, session: cfg.session,
    view: VIEWS.includes(cfg.view) ? cfg.view : "chat", switching: null, busy: false, turnAt: null, prompt: null, at: Date.now(),
  };
  const save = () => { state.at = Date.now(); writeJson(recordFile(h, id), state); if (id) store.pokeWatcher(h); };
  let started = !!cfg.resume; // the session exists: every later run resumes it
  let stream = null; // the running stream session: { child, send, control }
  let terminal = null; // the running real CLI
  let ending = false;

  // ---- the live file: text streaming now, and messages waiting for the turn
  const live = { items: new Map(), queued: [] };
  let liveTimer = null;
  const writeLive = () => {
    clearTimeout(liveTimer);
    liveTimer = null;
    const now = Date.now();
    for (const [k, x] of live.items) if (x.doneAt && now - x.doneAt > KEEP_DONE_MS) live.items.delete(k);
    writeJson(liveFile(h, id), { session: state.session, at: now, items: [...live.items.values()].map(({ id: i, kind, text, parent }) => ({ id: i, kind, text, parent })), queued: live.queued });
  };
  const liveSoon = () => { if (!liveTimer) liveTimer = setTimeout(writeLive, LIVE_MS); };

  // ---- the socket
  const sock = join(tmpdir(), `rollcall-claude-${process.pid}.sock`);
  rmSync(sock, { force: true });
  const server = createServer((c) => {
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
  await new Promise((resolve) => server.listen(sock, resolve));
  try { chmodSync(sock, 0o600); } catch {} // only the owner reaches it, whatever the umask or the temp folder
  state.sock = sock;

  const cleanup = () => {
    try { server.close(); } catch {}
    rmSync(sock, { force: true });
    // Only its own record: a new worker of the task may have written its own meanwhile.
    if (readJson(recordFile(h, id))?.pid === process.pid) { rmSync(recordFile(h, id), { force: true }); rmSync(liveFile(h, id), { force: true }); }
  };
  const stopAll = (code) => {
    ending = true;
    try { stream?.child.stdin.end(); } catch {}
    try { stream?.child.kill("SIGTERM"); } catch {}
    try { terminal?.kill("SIGTERM"); } catch {}
    cleanup();
    process.exit(code);
  };
  for (const s of ["SIGHUP", "SIGTERM"]) process.on(s, () => stopAll(0));
  process.on("uncaughtException", (e) => { log(`the worker process failed: ${e?.stack ?? e}`); stopAll(1); });
  process.on("exit", () => { try { stream?.child.kill("SIGTERM"); } catch {} try { terminal?.kill("SIGTERM"); } catch {} cleanup(); });

  // ---- launch arguments, shared by both views
  // As the plain CLI always started: the session, then --add-dir (which takes every word up to the next flag, so
  // --settings follows it and it never stands before a prompt), then the rest.
  const common = () => [
    ...(started ? ["--resume", state.session] : ["--session-id", state.session]),
    ...(cfg.addDir?.length ? ["--add-dir", ...cfg.addDir] : []),
    "--settings", cfg.settings,
    ...(cfg.mode ? ["--permission-mode", cfg.mode] : []),
    ...(cfg.model ? ["--model", cfg.model] : []),
    ...(cfg.effort ? ["--effort", cfg.effort] : []),
  ];
  const rememberLaunch = (patch) => { Object.assign(cfg, patch); writeJson(launchFile(h, id), cfg); };

  // ---- quiet points and the switch
  const quiet = () => !state.busy && !state.prompt && !live.queued.length;
  const terminalQuiet = () => {
    if (id) {
      try { readFileSync(dialogFlag(h, id)); return false; } catch {}
      const last = store.readStatus(h, id).filter((e) => e.ev === "busy" || e.ev === "idle" || e.ev === "session").at(-1);
      return !last || last.ev !== "busy";
    }
    const turn = store.readHomeFile(h, "turn");
    return !turn || turn.session !== state.session || turn.idle !== false;
  };
  const requestSwitch = (to) => {
    if (!VIEWS.includes(to)) return { ok: false, err: `no view "${to}"` };
    if (to === state.view && !state.switching) return { ok: true, already: true, view: state.view };
    if (to === state.view) { state.switching = null; save(); return { ok: true, already: true, view: state.view }; }
    state.switching = { to, since: Date.now() };
    save();
    const now = trySwitch();
    return { ok: true, switched: now, pending: !now, view: state.view };
  };
  // A switch out of the chat closes the stream's input, which ends Claude Code once its work is done; out of the
  // terminal it stops the CLI. Either run then returns "switch" and the loop starts the other view.
  const trySwitch = () => {
    if (!state.switching) return false;
    if (state.view === "chat" && stream && quiet()) { ui.hint(`Opening the real CLI…`); stream.closing = true; try { stream.child.stdin.end(); } catch {} return true; }
    if (state.view === "terminal" && terminal && terminalQuiet()) { terminal.switching = true; try { terminal.kill("SIGTERM"); } catch {} return true; }
    return false;
  };
  setInterval(() => { if (state.switching && state.view === "terminal") trySwitch(); }, QUIET_POLL_MS).unref();

  // ---- requests from rollcall
  async function handle(req) {
    if (!req || typeof req !== "object") return { ok: false, err: "bad request" };
    switch (req.op) {
      case "state": return { ok: true, ...state };
      case "switch": return requestSwitch(req.to);
      case "say": {
        if (state.view !== "chat" || !stream) return { ok: false, err: "the worker runs in the terminal view", view: state.view };
        // The stream's input is closed for a switch to the terminal: the words wait on the caller's queue, which types them there.
        if (stream.closing) return { ok: false, err: "the worker is switching to the terminal view", view: "terminal" };
        const text = String(req.text ?? "");
        if (!text.trim() && !req.attachments?.length) return { ok: false, err: "nothing to say" };
        const uuid = typeof req.uuid === "string" && req.uuid ? req.uuid : randomUUID();
        const how = state.busy ? "queued" : "sent";
        live.queued.push({ uuid, text, at: Date.now(), from: req.from ?? null, attachments: req.attachments ?? [] });
        writeLive();
        stream.send({ type: "user", uuid, session_id: state.session, parent_tool_use_id: null, message: { role: "user", content: contentOf(text, req.attachments ?? []) } });
        if (!state.busy) { state.busy = true; state.turnAt = Date.now(); save(); }
        return { ok: true, how, uuid };
      }
      case "interrupt": {
        if (state.view !== "chat" || !stream) return { ok: false, err: "the worker runs in the terminal view", view: state.view };
        if (!state.busy) return { ok: true, interrupted: false };
        await stream.control({ subtype: "interrupt" }).catch(() => null);
        return { ok: true, interrupted: true };
      }
      case "answer": return answer(req);
      case "set": {
        if (state.view !== "chat" || !stream) return { ok: false, err: "the worker runs in the terminal view", view: state.view };
        if (req.mode && !SET_MODES.has(req.mode)) return { ok: false, code: "bad-payload", err: `mode is one of ${[...SET_MODES].join(", ")}` };
        const done = {};
        if (req.model) { const r = await stream.control({ subtype: "set_model", model: req.model }).catch((e) => ({ error: e.message })); if (r?.error) return { ok: false, err: r.error }; done.model = req.model; }
        if (req.mode) { const r = await stream.control({ subtype: "set_permission_mode", mode: req.mode }).catch((e) => ({ error: e.message })); if (r?.error) return { ok: false, err: r.error }; done.mode = req.mode; }
        // Only the model carries into a resume or a switch: a mode lasts for this session, as Shift-Tab's does in the CLI.
        if (done.model) rememberLaunch({ model: done.model });
        return { ok: true, set: done };
      }
      default: return { ok: false, err: `unknown op ${req.op}` };
    }
  }

  const pending = new Map(); // can_use_tool request id -> { prompt, input }
  const closed = new Set(); // prompts answered or cancelled: a second answer is `already`
  function answer(a) {
    const open = pending.get(a.prompt);
    if (!open) return closed.has(a.prompt) ? { ok: true, already: true } : { ok: false, code: "not-found", err: `no prompt ${a.prompt}` };
    if (open.prompt.kind === "question" && !(a.answers && typeof a.answers === "object") && a.allow !== false) return { ok: false, code: "bad-payload", err: "a question takes answers" };
    if (a.mode != null && !PLAN_MODES.has(a.mode)) return { ok: false, code: "bad-payload", err: `mode is one of ${[...PLAN_MODES].join(", ")}` };
    closed.add(a.prompt);
    const decision = decisionFor(open.prompt, open.input, a);
    pending.delete(a.prompt);
    stream?.respond(a.prompt, decision);
    ui.line(dim(`  ${decision.behavior === "allow" ? "approved" : "declined"}${a.by ? ` from ${safe(a.by)}` : ""}`));
    if (open.prompt.kind === "plan" && decision.behavior === "allow" && a.mode) void stream?.control({ subtype: "set_permission_mode", mode: a.mode }).catch(() => {});
    closePrompt();
    return { ok: true, answered: true };
  }
  const closePrompt = () => {
    const next = pending.size ? [...pending.values()].at(-1) : null;
    state.prompt = next?.prompt ?? null;
    if (next) showPrompt(next.prompt, next.input); // the pane's y answers what it shows last
    // The dialog flag the PermissionRequest hook raised goes with the last prompt: no tool result follows a denial.
    if (!state.prompt && id) rmSync(dialogFlag(h, id), { force: true });
    save();
    trySwitch();
  };

  let shown = null; // the prompt the pane printed last: { id, at }
  function showPrompt(p, input) {
    shown = { id: p.id, at: Date.now() };
    if (p.kind === "question") {
      ui.line(`${yellow("?")} ${bold(safe(p.questions?.[0]?.question ?? "A question"))}`);
      if (p.questions?.length === 1 && !p.questions[0].multiSelect) p.questions[0].options.forEach((o, n) => ui.line(dim(`  ${n + 1}. ${safe(o.label)}`)));
      ui.hint("Answer with a number, or in the app");
      return;
    }
    if (p.kind === "plan") { ui.line(`${yellow("?")} ${bold("Approve the plan?")}`); if (p.plan) for (const l of safe(p.plan).split("\n")) ui.line(`  ${l}`); }
    else { ui.line(`${yellow("?")} ${bold(`Allow ${safe(p.tool)}?`)}${p.reason ? ` ${dim(safe(p.reason))}` : ""}`); for (const l of detailOf(p.tool, input)) ui.line(l); }
    ui.hint("y approves, n declines (or answer in the app)");
  }

  // ---- keys in the plain view
  const keys = (d) => {
    const s = String(d);
    if (state.view !== "chat") return;
    if (s === "\r" || s === "\n") { const r = requestSwitch("terminal"); if (r.pending) ui.hint(state.busy || state.prompt ? "The real CLI opens when this turn ends." : "The real CLI opens in a moment."); return; }
    if (s === "\x1b" || s === "\x03") { if (state.busy) { ui.hint("Stopping the turn…"); void stream?.control({ subtype: "interrupt" }).catch(() => {}); } return; }
    const p = state.prompt;
    // A key answers only the prompt the pane shows, and only once it has been there a moment: a y pressed for one
    // prompt never lands on another that arrived in the same instant.
    if (!p || shown?.id !== p.id || Date.now() - shown.at < KEY_SETTLE_MS) return;
    if ((p.kind === "permission" || p.kind === "plan") && /^[yn]$/i.test(s)) { answer({ prompt: p.id, allow: /y/i.test(s), by: "the terminal" }); return; }
    if (p.kind === "question" && p.questions?.length === 1 && !p.questions[0].multiSelect && /^[1-9]$/.test(s)) {
      const o = p.questions[0].options[Number(s) - 1];
      if (o) answer({ prompt: p.id, answers: { [p.questions[0].question]: o.label }, by: "the terminal" });
    }
  };
  const rawKeys = (on) => {
    if (!process.stdin.isTTY) return;
    try { process.stdin.setRawMode(on); } catch {}
    if (on) { process.stdin.on("data", keys); process.stdin.resume(); } else { process.stdin.off("data", keys); process.stdin.pause(); }
  };

  // ---- the chat view: Claude Code in stream mode
  function runStream() {
    return new Promise((resolve) => {
      const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--replay-user-messages", "--permission-prompt-tool", "stdio", ...common()];
      const child = spawn(cfg.bin, args, { cwd: cfg.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
      let err = "";
      child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
      child.stdin.on("error", () => {}); // a write after Claude Code exited: its exit handler reports that
      const send = (o) => { try { child.stdin.write(`${JSON.stringify(o)}\n`); } catch {} };
      const waiting = new Map(); // control request id -> resolve
      const control = (request) => new Promise((ok, fail) => {
        const rid = `rc-${randomUUID().slice(0, 8)}`;
        const timer = setTimeout(() => { waiting.delete(rid); fail(new Error("Claude Code did not answer")); }, 15_000);
        waiting.set(rid, (r) => { clearTimeout(timer); ok(r); });
        send({ type: "control_request", request_id: rid, request });
      });
      const respond = (rid, response) => send({ type: "control_response", response: { subtype: "success", request_id: rid, response } });
      const refuse = (rid, error) => send({ type: "control_response", response: { subtype: "error", request_id: rid, error } });
      stream = { child, send, control, respond, closing: false };
      state.child = child.pid;
      started = true; // the next run resumes, whatever happens to this one
      save();
      rawKeys(true);
      ui.clear();
      ui.line(`${bold(`rollcall · ${where}`)} ${dim("· chat view · Claude Code in stream mode")}`);
      ui.hint("Enter opens the real CLI · Esc stops the turn");

      let msg = null; // the model message streaming now: { id, parent }
      let usage = null;
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          try { onMessage(m); } catch (e) { log(`a stream message failed: ${e.message}`); }
        }
      });

      const onMessage = (m) => {
        switch (m.type) {
          case "system":
            if (m.subtype === "init" && m.session_id && m.session_id !== state.session) { state.session = m.session_id; rememberLaunch({ session: m.session_id }); save(); }
            return;
          case "stream_event": {
            const e = m.event ?? {};
            if (e.type === "message_start") { msg = { id: e.message?.id ?? m.api_message_id ?? randomUUID(), parent: m.parent_tool_use_id ?? null }; if (e.message?.usage && !m.parent_tool_use_id) usage = e.message.usage; return; }
            if (e.type === "message_delta" && e.usage && !m.parent_tool_use_id) { usage = { ...usage, ...e.usage }; return; }
            if (!msg) return;
            if (e.type === "content_block_start") {
              const kind = e.content_block?.type === "text" ? "assistant" : e.content_block?.type === "thinking" ? "thinking" : null;
              if (!kind) return;
              const lid = `${msg.id}:${e.index}`;
              live.items.set(lid, { id: lid, kind, text: "", parent: msg.parent, doneAt: null });
              return;
            }
            if (e.type === "content_block_delta") {
              const x = live.items.get(`${msg.id}:${e.index}`);
              const add = e.delta?.type === "text_delta" ? e.delta.text : e.delta?.type === "thinking_delta" ? e.delta.thinking : null;
              if (!x || typeof add !== "string" || !add) return;
              x.text += add;
              if (x.kind === "assistant" && !x.parent) ui.text(x.id, safe(add));
              liveSoon();
              return;
            }
            if (e.type === "content_block_stop") {
              const x = live.items.get(`${msg.id}:${e.index}`);
              if (x) { x.doneAt = Date.now(); liveSoon(); }
            }
            return;
          }
          case "assistant": {
            if (m.parent_tool_use_id) return;
            for (const b of m.message?.content ?? []) {
              if (b.type === "tool_use") ui.line(`${cyan("•")} ${cyan(safe(b.name))} ${dim(safe(store.clip(String(summaryOf({ worktree: cfg.cwd }, b.name, b.input)).replace(new RegExp(`^${b.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `), ""), 200)))}`);
            }
            return;
          }
          case "user": {
            if (m.isReplay) {
              const q = live.queued.findIndex((x) => x.uuid === m.uuid);
              if (q >= 0) live.queued.splice(q, 1);
              writeLive();
              const c = m.message?.content;
              const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text).join("\n") : "";
              if (text) ui.line(`\n${userLine(text)}`);
              if (!state.busy) { state.busy = true; state.turnAt = Date.now(); save(); }
            }
            return;
          }
          case "result": {
            const ms = Number.isFinite(m.duration_ms) ? m.duration_ms : state.turnAt ? Date.now() - state.turnAt : null;
            const model = Object.keys(m.modelUsage ?? {})[0];
            const size = model ? m.modelUsage[model]?.contextWindow : null;
            const ctx = contextOf(usage, size);
            const tokens = { input: m.usage?.input_tokens ?? null, output: m.usage?.output_tokens ?? null, context: ctx?.tokens ?? null };
            try { appendFileSync(turnsFile(h, id), `${JSON.stringify({ at: Date.now(), ms, tokens, error: m.is_error ? store.clip(store.oneLine(String(m.result ?? m.subtype ?? "error")), 200) : null, session: state.session })}\n`); } catch {}
            if (ctx) recordContext(ctx);
            for (const x of live.items.values()) x.doneAt ??= Date.now();
            writeLive();
            // A message sent just before the turn ended starts the next one.
            state.busy = live.queued.length > 0;
            state.turnAt = state.busy ? Date.now() : null;
            save();
            ui.hint(`── ${ms ? `${Math.round(ms / 1000)} s` : "turn ended"}${m.is_error ? " · failed" : ""}${ctx ? ` · context ${ctx.pct}%` : ""} · Enter opens the real CLI`);
            trySwitch();
            return;
          }
          case "rate_limit_event": { const l = limitsOf(m.rate_limit_info); if (l) { try { recordClaude(l); } catch {} } return; }
          case "control_request": {
            const r = m.request ?? {};
            if (r.subtype !== "can_use_tool") { refuse(m.request_id, `rollcall does not handle ${r.subtype ?? "this request"}`); return; }
            const input = r.input && typeof r.input === "object" ? r.input : {};
            const p = promptOf(r, m.request_id, { cwd: cfg.cwd, relays: id ? null : relaysOf(h, input) });
            pending.set(m.request_id, { prompt: p, input });
            state.prompt = p;
            save();
            showPrompt(p, input);
            return;
          }
          case "control_cancel_request": {
            closed.add(m.request_id);
            if (pending.delete(m.request_id)) closePrompt();
            return;
          }
          case "control_response": {
            const rid = m.response?.request_id;
            const done = rid && waiting.get(rid);
            if (done) { waiting.delete(rid); done(m.response?.subtype === "error" ? { error: m.response.error ?? "refused" } : m.response?.response ?? {}); }
            return;
          }
          default:
        }
      };

      // The first prompt (a new session's brief, or what brings a resumed one back), then the owner's words as they come.
      if (cfg.prompt) {
        let text = "";
        try { text = readFileSync(cfg.prompt, "utf8"); } catch {}
        rememberLaunch({ prompt: null });
        if (text.trim()) {
          const uuid = randomUUID();
          live.queued.push({ uuid, text, at: Date.now(), from: "rollcall" });
          writeLive();
          send({ type: "user", uuid, session_id: state.session, parent_tool_use_id: null, message: { role: "user", content: text } });
          state.busy = true; state.turnAt = Date.now(); save();
        }
      }

      child.on("exit", (code) => {
        rawKeys(false);
        ui.close();
        pending.clear();
        // No tool result follows a prompt a dead stream left open: its dialog flag would hold rollcall's typing for good.
        if (id) rmSync(dialogFlag(h, id), { force: true });
        state.prompt = null; state.busy = false; state.child = null;
        live.items.clear(); live.queued = [];
        writeLive();
        const switching = stream?.closing && state.switching?.to === "terminal";
        stream = null;
        if (ending) return resolve("exit");
        if (switching) { state.view = "terminal"; state.switching = null; rememberLaunch({ view: "terminal" }); save(); return resolve("switch"); }
        if (code !== 0) { process.stderr.write(`\nrollcall: Claude Code stopped (exit ${code}).\n${err.trim().split("\n").slice(-6).join("\n")}\n`); log(`Claude Code stopped (exit ${code}): ${store.oneLine(err).slice(-200)}`); }
        resolve(code === 0 ? "exit" : "crash");
      });
    });
  }

  // ---- the terminal view: the real CLI
  function runTerminal() {
    return new Promise((resolve) => {
      ui.clear();
      // A worker that starts in the terminal gets its first prompt on the command line, as the CLI always did.
      let first = "";
      if (cfg.prompt) { try { first = readFileSync(cfg.prompt, "utf8"); } catch {} rememberLaunch({ prompt: null }); }
      const named = !started && cfg.name ? ["-n", cfg.name] : [];
      const child = spawn(cfg.bin, [...common(), ...named, ...(first.trim() ? [first.startsWith("-") ? ` ${first}` : first] : [])], { cwd: cfg.cwd, stdio: "inherit", env: process.env });
      terminal = child;
      state.child = child.pid;
      started = true;
      save();
      child.on("exit", (code) => {
        const switching = child.switching && state.switching?.to === "chat";
        terminal = null;
        state.child = null;
        if (ending) return resolve("exit");
        if (switching) { state.view = "chat"; state.switching = null; rememberLaunch({ view: "chat" }); save(); return resolve("switch"); }
        resolve(code === 0 ? "exit" : "crash");
      });
    });
  }

  const recordContext = (c) => {
    const now = Date.now();
    if (id) {
      store.writeHomeFile(h, `context-${id}`, { pct: c.pct, at: now, session: state.session, tokens: c.tokens, size: c.size });
      import("../supervisor.mjs").then(({ markCap }) => { const t = store.readTask(h, id); if (t) markCap(t, state.session, c.pct); }).catch(() => {});
    } else store.writeHomeFile(h, "context", { pct: c.pct, session: state.session, at: now });
  };

  save();
  let code = 0;
  for (;;) {
    const r = state.view === "chat" ? await runStream() : await runTerminal();
    if (r === "switch") continue;
    code = r === "crash" ? 1 : 0;
    break;
  }
  stopAll(code);
}

/**
 * The task question the supervisor's own question relays, when every question it asks names a task (its header
 * starts with the task's name, as the supervisor tags a worker's question) and that task asks something now:
 * { ref, question } (the task's ref and its question id), else null. A front end shows the task's card for it.
 */
export function relaysOf(h, input, { find } = {}) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  if (!qs.length) return null;
  try {
    const lookup = find ?? defaultFind;
    const hits = qs.map((x) => lookup(h, x));
    if (hits.some((x) => !x) || new Set(hits.map((x) => x.ref)).size !== 1) return null;
    return hits[0];
  } catch { return null; }
}

let finder = null;
const defaultFind = (h, q) => (finder ? finder(h, q) : null);
/** Wires the lookup relaysOf uses (supervisor.mjs and answer.mjs load late: they import half of rollcall). */
export async function loadFinder() {
  const [{ taskOfQuestion }, { questionId }] = await Promise.all([import("../supervisor.mjs"), import("../answer.mjs")]);
  finder = (h, q) => {
    const tid = taskOfQuestion(q);
    const t = tid && store.readTask(h, tid);
    const qid = t && questionId(t);
    return qid ? { ref: `${h}:${t.id}`, question: qid } : null;
  };
}
