#!/usr/bin/env node
// A stand-in for the codex CLI, for the Codex worker's tests: `--version`, `login status`, `app-server --listen
// unix://<path>` (a websocket JSON-RPC server that plays a thread's turns from the words it gets) and `--remote ...
// resume <id>` (the "UI": it waits until it is stopped). Every request and response it sees goes to
// $FAKE_CODEX_LOG, one JSON line each. What a turn does follows its words:
//   ASK      asks request_user_input and waits for the answer
//   APPROVE  asks to run a command, then resolves that request itself 300 ms later
//   LIMIT    fails on the usage limit
//   TOKENS=n reports n tokens of a 1000-token window
//   SLOW     runs 3 s before it ends (so a steer or interrupt can meet it)
//   WRITE=f  writes file f (relative to the thread's cwd) as the turn ends, as a shell command would
//   HOLD     asks to run a command and waits (up to 8 s) for a client's answer
//   TOOL     runs `ls` (a commandExecution item, started then completed)
//   EDIT     changes src/a.js (a fileChange item)
//   PLAN     sends its plan (turn/plan/updated)
//   THINK    thinks first (a reasoning summary, streamed)
//   STREAM   streams its reply in pieces, 100 ms apart
// thread/resume answers with the turns in $FAKE_CODEX_HISTORY (a JSON file), as a thread's saved history.
// With $FAKE_CODEX_THREADS (a folder) the threads are saved there, as Codex saves its own: every finished turn goes in
// <folder>/<thread>.json, thread/resume answers with them, and so does thread/read on stdio. `resume <thread>` (the
// real CLI in a terminal) with $FAKE_CODEX_TERMINAL_TURN ("<words>") adds one turn to the saved thread and exits 0
// after $FAKE_CODEX_TERMINAL_MS (default 300).
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import net from "node:net";

const args = process.argv.slice(2);
const log = (x) => { if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(x)}\n`); };

if (args[0] === "--version") { console.log("codex-cli 0.0.0-fake"); process.exit(0); }
if (args[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
const threadsDir = process.env.FAKE_CODEX_THREADS;
const savedTurns = (id) => { try { return JSON.parse(readFileSync(joinPath(threadsDir, `${id}.json`), "utf8")); } catch { return []; } };
const saveTurn = (id, turn) => { if (!threadsDir) return; mkdirSync(threadsDir, { recursive: true }); writeFileSync(joinPath(threadsDir, `${id}.json`), JSON.stringify([...savedTurns(id), turn])); };
const seconds = () => Math.floor(Date.now() / 1000);

if (args[0] === "resume") {
  log({ argv: args, pid: process.pid });
  const words = process.env.FAKE_CODEX_TERMINAL_TURN;
  if (words) {
    const thread = args[1];
    const id = `tu-${savedTurns(thread).length + 1}`;
    saveTurn(thread, { id, status: "completed", startedAt: seconds(), completedAt: seconds(), items: [{ type: "userMessage", id: `u-${id}`, content: [{ type: "text", text: words }] }, { type: "agentMessage", id: `a-${id}`, text: `terminal: ${words}` }] });
  }
  setTimeout(() => process.exit(0), Number(process.env.FAKE_CODEX_TERMINAL_MS) || 300);
} else if (args[0] === "--remote") {
  log({ ui: args });
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1 << 30);
} else if (args[0] === "app-server" && !args.includes("--listen")) {
  // One client on stdio, a JSON message per line.
  serveStdio();
} else if (args[0] === "app-server") {
  const listen = args[args.indexOf("--listen") + 1];
  const path = listen.replace(/^unix:\/\//, "");
  rmSync(path, { force: true });
  log({ server: args });
  serve(path);
} else {
  process.stderr.write(`fake codex: unknown ${args.join(" ")}\n`);
  process.exit(2);
}

function serve(path) {
  const clients = new Set();
  let turnN = 0;
  let reqN = 1000;
  const thread = { id: "th-1", turn: null, cwd: null };
  const waiting = new Map();
  const turnItems = new Map(); // turn id -> { at, items } for the saved thread
  const saved = (turnId, status, extra = []) => {
    const t = turnItems.get(turnId);
    turnItems.delete(turnId);
    if (t) saveTurn(thread.id, { id: turnId, status, startedAt: t.at, completedAt: seconds(), items: [...t.items, ...extra] });
  };
  const broadcast = (m) => { for (const c of clients) c.send(m); };
  const notify = (method, params) => broadcast({ method, params });

  async function play(text) {
    const turnId = `tu-${++turnN}`;
    thread.turn = turnId;
    notify("turn/started", { threadId: thread.id, turn: { id: turnId, status: "inProgress" } });
    return turnId;
  }
  async function finish(turnId, text) {
    const tokens = /TOKENS=(\d+)/.exec(text);
    if (tokens) notify("thread/tokenUsage/updated", { threadId: thread.id, turnId, tokenUsage: { last: { totalTokens: Number(tokens[1]), inputTokens: Number(tokens[1]) }, total: { totalTokens: Number(tokens[1]) * 2 }, modelContextWindow: 1000 } });
    if (/APPROVE/.test(text)) {
      const id = ++reqN;
      broadcast({ id, method: "item/commandExecution/requestApproval", params: { threadId: thread.id, turnId, itemId: "i1", startedAtMs: Date.now(), command: "rm -rf build", reason: "clean the build" } });
      await wait(300);
      notify("serverRequest/resolved", { threadId: thread.id, requestId: id });
    }
    if (/HOLD/.test(text)) {
      const id = ++reqN;
      const answered = new Promise((r) => waiting.set(id, r));
      broadcast({ id, method: "item/commandExecution/requestApproval", params: { threadId: thread.id, turnId, itemId: "i3", startedAtMs: Date.now(), command: "rm -rf build", reason: "clean the build" } });
      await Promise.race([answered, wait(8000)]);
      notify("serverRequest/resolved", { threadId: thread.id, requestId: id });
    }
    if (/PLAN/.test(text)) notify("turn/plan/updated", { threadId: thread.id, turnId, plan: [{ step: "Read the code", status: "completed" }, { step: "Fix it", status: "inProgress" }, { step: "Test it", status: "pending" }] });
    if (/THINK/.test(text)) {
      const rid = `r-${turnId}`;
      notify("item/started", { threadId: thread.id, turnId, item: { type: "reasoning", id: rid, summary: [], content: [] } });
      for (const d of ["Looking ", "at it"]) { notify("item/reasoning/summaryTextDelta", { threadId: thread.id, turnId, itemId: rid, summaryIndex: 0, delta: d }); await wait(20); }
      notify("item/completed", { threadId: thread.id, turnId, item: { type: "reasoning", id: rid, summary: ["Looking at it"], content: [] } });
    }
    if (/TOOL/.test(text)) {
      const item = { type: "commandExecution", id: `c-${turnId}`, command: "ls", cwd: thread.cwd ?? "/", commandActions: [], status: "inProgress" };
      notify("item/started", { threadId: thread.id, turnId, item });
      await wait(50);
      notify("item/completed", { threadId: thread.id, turnId, item: { ...item, status: "completed", exitCode: 0, aggregatedOutput: "a.txt\n", durationMs: 12 } });
    }
    if (/EDIT/.test(text)) {
      const item = { type: "fileChange", id: `f-${turnId}`, status: "completed", changes: [{ path: `${thread.cwd ?? ""}/src/a.js`, kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-src/a.js\n+src/a.js changed" }] };
      notify("item/started", { threadId: thread.id, turnId, item: { ...item, status: "inProgress" } });
      notify("item/completed", { threadId: thread.id, turnId, item });
    }
    if (/ASK/.test(text)) {
      const id = ++reqN;
      const answered = new Promise((r) => waiting.set(id, r));
      broadcast({ id, method: "item/tool/requestUserInput", params: { threadId: thread.id, turnId, itemId: "i2", questions: [{ id: "q1", header: "Ship", question: "Ship it?", options: [{ label: "Yes", description: "ship" }, { label: "No", description: "wait" }] }] } });
      await Promise.race([answered, wait(5000)]);
    }
    if (/SLOW/.test(text)) await wait(3000);
    const write = /WRITE=(\S+)/.exec(text);
    if (write && thread.cwd) { const f = joinPath(thread.cwd, write[1]); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `written by ${turnId}\n`); }
    const reply = `done: ${text.split("\n")[0]}`;
    if (/STREAM/.test(text) && !/LIMIT/.test(text)) {
      notify("item/started", { threadId: thread.id, turnId, item: { type: "agentMessage", id: `a-${turnId}`, text: "" } });
      for (let i = 0; i < reply.length; i += 4) {
        if (thread.turn !== turnId) return;
        notify("item/agentMessage/delta", { threadId: thread.id, turnId, itemId: `a-${turnId}`, delta: reply.slice(i, i + 4) });
        await wait(100);
      }
    }
    if (thread.turn !== turnId) return; // interrupted meanwhile
    thread.turn = null;
    if (/LIMIT/.test(text)) {
      saved(turnId, "failed");
      notify("turn/completed", { threadId: thread.id, turn: { id: turnId, status: "failed", error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } } });
      return;
    }
    notify("item/completed", { threadId: thread.id, turnId, item: { type: "agentMessage", id: `a-${turnId}`, text: reply } });
    saved(turnId, "completed", [{ type: "agentMessage", id: `a-${turnId}`, text: reply }]);
    notify("turn/completed", { threadId: thread.id, turn: { id: turnId, status: "completed" } });
  }

  const handle = async (c, m) => {
    log({ in: m });
    if (m.id !== undefined && !m.method) { waiting.get(m.id)?.(m.result); return; }
    const reply = (result) => { log({ out: { id: m.id, result } }); c.send({ id: m.id, result }); };
    const p = m.params ?? {};
    switch (m.method) {
      case "initialize": return reply({ userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" });
      case "initialized": return;
      case "thread/start": thread.cwd = p.cwd ?? null; reply({ thread: { id: thread.id } }); return notify("thread/started", { thread: { id: thread.id } });
      case "thread/resume": {
        thread.id = p.threadId;
        thread.cwd = p.cwd ?? thread.cwd;
        let turns = [];
        try { turns = JSON.parse(readFileSync(process.env.FAKE_CODEX_HISTORY, "utf8")); } catch {}
        if (threadsDir) { turns = savedTurns(p.threadId); turnN = turns.length; }
        return reply({ thread: { id: p.threadId, turns } });
      }
      case "thread/read": return reply({ thread: { id: thread.id, turns: thread.turn ? [{ id: thread.turn, status: "inProgress" }] : [] } });
      case "hooks/list": return reply({ data: [{ cwd: p.cwds?.[0] ?? "", hooks: [{ enabled: true, trustStatus: "untrusted" }], errors: [], warnings: [] }] });
      case "account/rateLimits/read": return reply({ rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 7200 }, planType: "plus" } }, rateLimits: { limitId: "codex", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, planType: "plus" } });
      case "turn/start": {
        const text = (p.input ?? []).map((x) => x.text).join("\n");
        const turnId = await play(text);
        reply({ turn: { id: turnId, status: "inProgress" } });
        const said = { type: "userMessage", id: `u-${turnId}`, clientId: p.clientUserMessageId ?? null, content: [{ type: "text", text }] };
        turnItems.set(turnId, { at: seconds(), items: [said] });
        notify("item/started", { threadId: thread.id, turnId, item: said });
        setTimeout(() => notify("item/completed", { threadId: thread.id, turnId, item: said }), 5);
        notify("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, planType: "plus" } });
        void finish(turnId, text);
        return;
      }
      case "turn/steer": {
        if (p.expectedTurnId !== thread.turn) { c.send({ id: m.id, error: { code: -32600, message: "no such running turn" } }); return; }
        const text = (p.input ?? []).map((x) => x.text).join("\n");
        reply({ turnId: thread.turn });
        return notify("item/started", { threadId: thread.id, turnId: thread.turn, item: { type: "userMessage", id: `s-${Date.now()}`, clientId: p.clientUserMessageId ?? null, content: [{ type: "text", text }] } });
      }
      case "turn/interrupt": {
        const turnId = thread.turn;
        thread.turn = null;
        reply({});
        saved(turnId, "interrupted");
        return notify("turn/completed", { threadId: thread.id, turn: { id: turnId, status: "interrupted" } });
      }
      default:
        c.send({ id: m.id, error: { code: -32601, message: `fake codex: no ${m.method}` } });
    }
  };

  net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let open = false;
    const c = {
      send(o) {
        const p = Buffer.from(JSON.stringify(o));
        const head = p.length < 126 ? Buffer.from([0x81, p.length]) : p.length < 65536 ? Buffer.from([0x81, 126, p.length >> 8, p.length & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(p.length), 2); return b; })();
        sock.write(Buffer.concat([head, p]));
      },
    };
    sock.on("error", () => {});
    sock.on("close", () => clients.delete(c));
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!open) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(buf.subarray(0, i).toString())?.[1]?.trim();
        buf = buf.subarray(i + 4);
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        open = true;
        clients.add(c);
      }
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 127;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = buf[1] & 0x80;
        const mask = masked ? buf.subarray(off, off + 4) : null;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const op = buf[0] & 15;
        const payload = Buffer.from(buf.subarray(off, off + len));
        buf = buf.subarray(off + len);
        if (mask) for (let k = 0; k < payload.length; k++) payload[k] ^= mask[k & 3];
        if (op === 0x8) { sock.end(); return; }
        if (op === 0x1) { try { void handle(c, JSON.parse(payload.toString())); } catch {} }
      }
    });
  }).listen(path);
  process.on("SIGTERM", () => { rmSync(path, { force: true }); process.exit(0); });
}

function serveStdio() {
  let buf = "";
  const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.method === "initialize") send({ id: m.id, result: {} });
      else if (m.method === "thread/read") send({ id: m.id, result: { thread: { id: m.params?.threadId, turns: m.params?.includeTurns ? savedTurns(m.params?.threadId) : [] } } });
      else if (m.method === "account/rateLimits/read") send({ id: m.id, result: { rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, planType: "plus" } } } });
      else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "no" } });
    }
  });
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
