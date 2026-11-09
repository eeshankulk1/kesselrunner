// Claude Code in its stream mode (the protocol the Agent SDK wraps; facts in docs/plans/2026-11-08-chat-stream.md):
// the agent host (host/server.mjs) runs a hosted Claude agent through startClaude. It turns the stream into events: items folded with conversation.mjs's own folder (so they match a
// transcript read, ids and all), streamed text, words taken, turn ends, permission requests and the exit.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { createFolder, oneLine } from "../conversation.mjs";
import { summaryOf, trimInput } from "../away.mjs";

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



const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text).join("\n") : "");

/** The command line: Claude Code in stream mode on `cfg` (claude-launch.json), resuming when `resume`. */
export function argsOf(cfg, resume) {
  return [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    "--replay-user-messages", "--permission-prompt-tool", "stdio",
    ...(resume ? ["--resume", cfg.session] : ["--session-id", cfg.session]),
    // --add-dir takes every word up to the next flag: --settings follows it.
    ...(cfg.addDir?.length ? ["--add-dir", ...cfg.addDir] : []),
    ...(cfg.settings ? ["--settings", cfg.settings] : []),
    ...(cfg.mode ? ["--permission-mode", cfg.mode] : []),
    ...(cfg.model ? ["--model", cfg.model] : []),
    ...(cfg.effort ? ["--effort", cfg.effort] : []),
  ];
}

/**
 * The program and arguments that run `bin args`: under the owner's login shell after sourcing `envFile` (the task's
 * environment, as its tmux launch script set it), or straight when there is none.
 */
export function commandOf(bin, args, envFile) {
  if (!envFile || !existsSync(envFile)) return [bin, args];
  const shell = process.env.ROLLCALL_HOST_SHELL || process.env.SHELL || "/bin/zsh";
  return [shell, ["-lc", '. "$0" >/dev/null 2>&1 </dev/null; exec "$@"', envFile, bin, ...args]];
}

/**
 * Starts Claude Code for one agent. `on(event)` hears:
 *   { type: "init", session }
 *   { type: "items", items }                      items new or changed, in order (children carry `parent`)
 *   { type: "text", id, kind, append, parent }    streamed text on an item not finished yet
 *   { type: "text-end", id }                      that text's block finished
 *   { type: "taken", uuid, text }                 a message we sent went in (its replay)
 *   { type: "turn-end", ms, tokens, error, context }
 *   { type: "request", rid, req }                 can_use_tool, waiting for respond(rid, decision)
 *   { type: "cancel", rid }
 *   { type: "limits", limits }
 *   { type: "exit", code, err }
 */
export function startClaude({ cfg, resume, envFile = null, env = process.env, on, onRaw = null, log = () => {} }) {
  const [cmd, argv] = commandOf(cfg.bin, argsOf(cfg, resume), envFile);
  const child = spawn(cmd, argv, { cwd: cfg.cwd && existsSync(cfg.cwd) ? cfg.cwd : undefined, stdio: ["pipe", "pipe", "pipe"], env });
  let err = "";
  child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
  child.stdin.on("error", () => {});
  const write = (o) => { try { child.stdin.write(`${JSON.stringify(o)}\n`); } catch {} };
  const waiting = new Map();
  const control = (request, ms = 15_000) => new Promise((ok, fail) => {
    const rid = `rc-${randomUUID().slice(0, 8)}`;
    const timer = setTimeout(() => { waiting.delete(rid); fail(new Error("Claude Code did not answer")); }, ms);
    waiting.set(rid, (r) => { clearTimeout(timer); ok(r); });
    write({ type: "control_request", request_id: rid, request });
  });

  let session = cfg.session;
  const folder = createFolder({ cwd: cfg.cwd ?? null });
  const kids = new Map(); // subagent tool use id -> its folder
  let turnOpen = false;
  let msg = null; // the model message streaming now
  let usage = null;
  const emit = (e) => { try { on(e); } catch (x) { log(`a host event failed: ${x.message}`); } };
  const flush = () => {
    const items = folder.takeDirty();
    for (const [pid, f] of kids) {
      const c = f.takeDirty();
      if (!c.length) continue;
      const s = folder.get(pid);
      if (s) { s.children = f.items.length; if (!items.includes(s)) items.push(s); }
      items.push(...c);
    }
    if (items.length) emit({ type: "items", items: items.map((x) => ({ ...x })) });
  };
  const fold = (o, parent) => {
    const at = new Date().toISOString();
    const entry = { ...o, timestamp: at, sessionId: session };
    if (!parent) return folder.add(entry);
    if (!kids.has(parent)) kids.set(parent, createFolder({ cwd: cfg.cwd ?? null, parent }));
    kids.get(parent).add(entry);
  };

  const onMessage = (m) => {
    switch (m.type) {
      case "system":
        if (m.subtype === "init") { if (m.session_id) session = m.session_id; emit({ type: "init", session }); return; }
        if (m.subtype === "compact_boundary") {
          const md = m.compact_metadata ?? m.compactMetadata ?? {};
          fold({ type: "system", subtype: "compact_boundary", uuid: m.uuid ?? randomUUID(), compactMetadata: { trigger: md.trigger, preTokens: md.pre_tokens ?? md.preTokens } });
          return flush();
        }
        if (m.subtype === "informational" || m.subtype === "local_command" || m.level === "error") { fold({ ...m, uuid: m.uuid ?? randomUUID() }); flush(); }
        return;
      case "stream_event": {
        const e = m.event ?? {};
        const parent = m.parent_tool_use_id ?? null;
        if (e.type === "message_start") { msg = { id: e.message?.id ?? m.api_message_id ?? randomUUID(), parent, kinds: new Map() }; if (e.message?.usage && !parent) usage = e.message.usage; return; }
        if (e.type === "message_delta" && e.usage && !parent) { usage = { ...usage, ...e.usage }; return; }
        if (!msg) return;
        if (e.type === "content_block_start") {
          const kind = e.content_block?.type === "text" ? "assistant" : e.content_block?.type === "thinking" ? "thinking" : null;
          if (kind) msg.kinds.set(e.index, kind);
          return;
        }
        if (e.type === "content_block_delta") {
          const kind = msg.kinds.get(e.index);
          const add = e.delta?.type === "text_delta" ? e.delta.text : e.delta?.type === "thinking_delta" ? e.delta.thinking : null;
          if (kind && typeof add === "string" && add) emit({ type: "text", id: `${msg.id}:${e.index}`, kind, append: add, parent: msg.parent });
        }
        if (e.type === "content_block_stop" && msg.kinds.has(e.index)) emit({ type: "text-end", id: `${msg.id}:${e.index}` });
        return;
      }
      case "assistant":
        fold(m, m.parent_tool_use_id ?? null);
        return flush();
      case "user": {
        const parent = m.parent_tool_use_id ?? null;
        if (m.isReplay && !parent) {
          emit({ type: "taken", uuid: m.uuid, text: textOf(m.message?.content) });
          // Words taken into a running turn: the transcript's queued_command, not a new turn.
          if (turnOpen) fold({ type: "attachment", uuid: m.uuid, attachment: { type: "queued_command", prompt: textOf(m.message?.content), source_uuid: m.uuid } });
          else { turnOpen = true; fold(m); }
          return flush();
        }
        fold(m, parent);
        return flush();
      }
      case "result": {
        const uuid = m.uuid ?? randomUUID();
        const ms = Number.isFinite(m.duration_ms) ? m.duration_ms : null;
        const model = Object.keys(m.modelUsage ?? {})[0];
        const context = contextOf(usage, model ? m.modelUsage[model]?.contextWindow : null);
        const tokens = { input: m.usage?.input_tokens ?? null, output: m.usage?.output_tokens ?? null, context: context?.tokens ?? null };
        const error = m.is_error ? oneLine(String(m.result ?? m.subtype ?? "error"), 200) : null;
        fold({ type: "system", subtype: "turn_duration", uuid, durationMs: ms ?? 0 });
        const end = folder.get(`turn-end:${uuid}`);
        if (end) { end.tokens = tokens; if (error) end.error = error; }
        turnOpen = false;
        flush();
        emit({ type: "turn-end", ms, tokens, error, context });
        return;
      }
      case "rate_limit_event": { const l = limitsOf(m.rate_limit_info); if (l) emit({ type: "limits", limits: l }); return; }
      case "control_request": {
        const r = m.request ?? {};
        if (r.subtype !== "can_use_tool") { write({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: `rollcall does not handle ${r.subtype ?? "this request"}` } }); return; }
        emit({ type: "request", rid: m.request_id, req: r });
        return;
      }
      case "control_cancel_request": emit({ type: "cancel", rid: m.request_id }); return;
      case "control_response": {
        const rid = m.response?.request_id;
        const done = rid && waiting.get(rid);
        if (done) { waiting.delete(rid); done(m.response?.subtype === "error" ? { error: m.response.error ?? "refused" } : m.response?.response ?? {}); }
        return;
      }
      default:
    }
  };

  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.startsWith("{")) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      try { onRaw?.(m); onMessage(m); } catch (e) { log(`a stream message failed: ${e.message}`); }
    }
  });
  child.on("exit", (code, signal) => emit({ type: "exit", code: code ?? (signal ? 1 : 0), signal, err: err.trim().split("\n").slice(-6).join("\n") }));
  child.on("error", (e) => emit({ type: "exit", code: 1, err: e.message }));

  return {
    pid: child.pid,
    get session() { return session; },
    /** One user message: the words, images inline and other files named. */
    say(text, attachments = [], uuid = randomUUID()) {
      write({ type: "user", uuid, session_id: session, parent_tool_use_id: null, message: { role: "user", content: contentOf(text, attachments) } });
      return uuid;
    },
    respond(rid, response) { write({ type: "control_response", response: { subtype: "success", request_id: rid, response } }); },
    /** The owner's answer `a` to request `rid` (its prompt `p`, original `input`): the decision sent, and an approved plan's mode set. */
    answer(rid, p, input, a) {
      const decision = decisionFor(p, input, a);
      this.respond(rid, decision);
      if (p.kind === "plan" && decision.behavior === "allow" && a.mode) void control({ subtype: "set_permission_mode", mode: a.mode }).catch(() => {});
      return decision.behavior === "allow";
    },
    control,
    interrupt: () => control({ subtype: "interrupt" }),
    setModel: (model) => control({ subtype: "set_model", model }),
    setMode: (mode) => control({ subtype: "set_permission_mode", mode }),
    /** Closes its input: Claude Code finishes what runs and exits. */
    close() { try { child.stdin.end(); } catch {} },
    kill(sig = "SIGTERM") { try { child.kill(sig); } catch {} },
  };
}
