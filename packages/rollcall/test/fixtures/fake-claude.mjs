#!/usr/bin/env node
// A stand-in for `claude`, for the stream-mode worker's tests (claude/worker.mjs).
//
// With `-p` it plays Claude Code 2.1.319's stream mode: stream-json lines in on stdin, out on stdout (shapes in
// docs/plans/2026-11-08-chat-stream.md, only the fields the worker reads). A user message gets its replay
// (`isReplay`, same uuid), a streamed text block, the `assistant` message and a `result`. A message that arrives
// while a turn runs is taken into that turn ("absorbed mid-turn"): its replay comes at the turn's next step and
// the turn ends with one result. What a turn does follows its words:
//   TOOL       asks can_use_tool for Bash and waits for the answer; the reply says allowed or denied
//   ASKTAGGED  asks AskUserQuestion with the questions in $FAKE_CLAUDE_QUESTIONS (JSON)
//   ASK        asks AskUserQuestion with one "Ship it?" question
//   SLOW       streams for about 2 s (an interrupt ends it with an error result)
// Control requests: interrupt, set_model and set_permission_mode answer success. stdin's end: exit 0 once the
// turn running is done.
//
// Without `-p` it is the real CLI in the terminal: prints a line and waits until SIGTERM (exit 0), or until its
// parent is gone.
//
// $FAKE_CLAUDE_LOG gets one JSON line per fact: { argv }, { in } (every stdin line), { replayed }, { sigterm }.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const log = (x) => { if (process.env.FAKE_CLAUDE_LOG) { try { appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ pid: process.pid, ...x })}\n`); } catch {} } };
const argAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

log({ argv: args });

if (!args.includes("-p")) {
  process.stdout.write("fake claude: the real CLI\n");
  // $FAKE_CLAUDE_TERMINAL_TURN: one turn in the terminal ("<words>"), written to the session's transcript, then exit 0.
  if (process.env.FAKE_CLAUDE_TERMINAL_TURN) {
    const session = argAfter("--resume") ?? argAfter("--session-id");
    const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const words = process.env.FAKE_CLAUDE_TERMINAL_TURN;
    appendFileSync(join(dir, `${session}.jsonl`), [
      { type: "user", uuid: `tu-${now}`, timestamp: new Date(now).toISOString(), sessionId: session, message: { role: "user", content: words } },
      { type: "assistant", uuid: `ta-${now}`, timestamp: new Date(now + 1).toISOString(), sessionId: session, message: { id: `msg_t${now}`, role: "assistant", content: [{ type: "text", text: `terminal: ${words}` }] } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");
    setTimeout(() => process.exit(0), Number(process.env.FAKE_CLAUDE_TERMINAL_MS) || 300);
  }
  process.on("SIGTERM", () => { log({ sigterm: true }); process.exit(0); });
  // Its worker gone (killed in a test's cleanup), it goes too: nothing else would stop it.
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 200);
} else {
  stream();
}

function stream() {
  const session = argAfter("--resume") ?? argAfter("--session-id") ?? randomUUID();
  const model = argAfter("--model") ?? "claude-fake-1";
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const base = { session_id: session };

  const inbox = []; // user messages not yet taken
  const waiting = new Map(); // our control request id -> resolve
  let running = false;
  let interrupted = false;
  let ended = false;
  let n = 0;

  out({ type: "system", subtype: "init", ...base, model, tools: ["Bash"], cwd: process.cwd() });

  const textOf = (m) => {
    const c = m.message?.content;
    return typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text).join("\n") : "";
  };
  const replay = (m) => {
    log({ replayed: m.uuid });
    out({ type: "user", ...base, uuid: m.uuid, isReplay: true, parent_tool_use_id: null, message: m.message });
  };
  // Messages written while a turn runs join it.
  const absorb = () => { while (inbox.length) replay(inbox.shift()); };

  const ask = (tool, input) => new Promise((resolve) => {
    const rid = `fake-${++n}`;
    waiting.set(rid, resolve);
    out({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: tool, input, description: input.description, permission_suggestions: [{ type: "addRules", rules: [{ toolName: tool }], behavior: "allow", destination: "session" }], tool_use_id: `toolu_${rid}` } });
  });

  async function turn(first) {
    running = true;
    interrupted = false;
    const t0 = Date.now();
    replay(first);
    const words = textOf(first);
    const mid = `msg_${randomUUID().slice(0, 8)}`;
    const usage = { input_tokens: 20000, cache_read_input_tokens: 30000, cache_creation_input_tokens: 0, output_tokens: 1 };
    let reply = `done: ${words.split("\n")[0]}`;

    if (/TOOL/.test(words)) {
      const d = await ask("Bash", { command: "ls -la", description: "List the files" });
      reply = d?.behavior === "allow" ? `allowed ${JSON.stringify(d.updatedInput)}` : `denied: ${d?.message ?? ""}`;
    } else if (/ASKTAGGED/.test(words)) {
      const questions = JSON.parse(process.env.FAKE_CLAUDE_QUESTIONS ?? "[]");
      const d = await ask("AskUserQuestion", { questions });
      reply = d?.behavior === "allow" ? `answers ${JSON.stringify(d.updatedInput?.answers)}` : `no answer: ${d?.message ?? ""}`;
    } else if (/ASK/.test(words)) {
      const questions = [{ question: "Ship it?", header: "Ship", multiSelect: false, options: [{ label: "Yes", description: "ship" }, { label: "No", description: "wait" }] }];
      const d = await ask("AskUserQuestion", { questions });
      reply = d?.behavior === "allow" ? `answers ${JSON.stringify(d.updatedInput?.answers)}` : `no answer: ${d?.message ?? ""}`;
    }

    const ev = (event) => out({ type: "stream_event", ...base, uuid: randomUUID(), parent_tool_use_id: null, api_message_id: mid, event });
    ev({ type: "message_start", message: { id: mid, type: "message", role: "assistant", model, content: [], usage } });
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    const chunks = /SLOW/.test(words) ? Array.from({ length: 20 }, (_, i) => `slow ${i} `) : reply.match(/.{1,8}/gs) ?? [reply];
    let said = "";
    for (const c of chunks) {
      absorb();
      if (interrupted) break;
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: c } });
      said += c;
      await wait(/SLOW/.test(words) ? 100 : 5);
    }
    absorb();
    ev({ type: "content_block_stop", index: 0 });
    ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } });
    out({ type: "assistant", ...base, uuid: randomUUID(), parent_tool_use_id: null, message: { id: mid, role: "assistant", model, content: [{ type: "text", text: said }] } });
    const ms = Date.now() - t0;
    if (interrupted) out({ type: "result", subtype: "error_during_execution", is_error: true, ...base, duration_ms: ms, result: "Interrupted by the user", usage: { input_tokens: 20000, output_tokens: 42 }, modelUsage: { [model]: { contextWindow: 200000 } } });
    else out({ type: "result", subtype: "success", is_error: false, ...base, duration_ms: ms, result: said, usage: { input_tokens: 20000, output_tokens: 42 }, modelUsage: { [model]: { contextWindow: 200000 } } });
    running = false;
    if (inbox.length) return turn(inbox.shift());
    if (ended) process.exit(0);
  }

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { return; }
    log({ in: m });
    if (m.type === "user") {
      if (running) inbox.push(m);
      else void turn(m);
      return;
    }
    if (m.type === "control_response") {
      const rid = m.response?.request_id;
      const done = waiting.get(rid);
      if (done) { waiting.delete(rid); done(m.response?.response ?? null); }
      return;
    }
    if (m.type === "control_request") {
      const sub = m.request?.subtype;
      if (sub === "interrupt") interrupted = true;
      if (["interrupt", "set_model", "set_permission_mode"].includes(sub)) out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
      else out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: `fake claude: no ${sub}` } });
    }
  });
  rl.on("close", () => { ended = true; if (!running) process.exit(0); });
}
