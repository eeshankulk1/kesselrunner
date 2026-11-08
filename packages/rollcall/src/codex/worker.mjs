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
// The thread itself, its hooks, snapshots, journal and prompts are codex/session.mjs's (startCodex), the code the agent
// host runs too; this file adds the pane's two views, the live file, the record and the control socket.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { VIEWS, liveFile } from "../claude/live.mjs";
import { bold, cyan, detailOf, dim, safe, screen, userLine, yellow } from "../claude/worker.mjs";
import { launchFile, stateFile } from "../harness/codex.mjs";
import { pidAlive } from "../proc.mjs";
import * as store from "../store.mjs";
import { DELIVERY, clientId, inputOf, killServer, startCodex } from "./session.mjs";

export { APPROVALS, DELIVERY, INJECTED, answerFor, approvalAnswer, clientId, contextOf, decisionIn, dialogPayload, inputOf, promptOf, questionsOf, textOf, usageLimited } from "./session.mjs";

const LIVE_MS = 80; // the live file's rewrite, at most this often while text streams
const KEEP_DONE_MS = 1500; // a finished message stays in the live file this long: the journal has it by then
const QUIET_POLL_MS = 500;
const KEY_SETTLE_MS = 300; // a prompt is on screen this long before a key answers it

export async function codexWorker([h, id]) {
  let cfg;
  try { cfg = JSON.parse(readFileSync(launchFile(h, id), "utf8")); } catch { process.stderr.write(`rollcall: ${h}:${id} has no Codex launch file\n`); return 1; }
  const log = (line) => { try { store.appendStatus(h, id, { ev: "codex", line: store.clip(String(line), 300) }); } catch {} };

  // A worker of this task killed outright (SIGKILL: no handler runs) left its server and socket: they go first.
  leftovers(h, id);
  // A unix socket path has room for ~100 bytes: the system temp folder, not the store.
  const sock = join(tmpdir(), `rollcall-codex-${process.pid}.sock`);
  const ctl = join(tmpdir(), `rollcall-codexctl-${process.pid}.sock`);
  rmSync(ctl, { force: true });
  let core = null; // the session (codex/session.mjs): its server, thread, hooks and prompts
  let ui = null; // Codex's own UI, while the terminal view runs
  let ending = false;
  let control = null;
  const pane = screen();
  const showing = () => state.view === "chat" && !ui && !ending;
  const say = (fn) => { if (showing()) fn(); };

  const stopAll = (code) => {
    ending = true;
    try { ui?.kill("SIGTERM"); } catch {}
    core?.kill();
    try { control?.close(); } catch {}
    rmSync(sock, { force: true });
    rmSync(ctl, { force: true });
    // Only its own record: a new worker of the task may have written its own meanwhile.
    try { if (JSON.parse(readFileSync(stateFile(h, id), "utf8")).pid === process.pid) { rmSync(stateFile(h, id), { force: true }); rmSync(liveFile(h, id), { force: true }); } } catch {}
    process.exit(code);
  };
  for (const s of ["SIGHUP", "SIGTERM"]) process.on(s, () => { core?.hook("session-end", { reason: "signal" }); stopAll(0); });
  // Whatever ends this process ends its server too: a crash here must not leave it running on its socket.
  process.on("uncaughtException", (e) => { log(`the worker process failed: ${e?.stack ?? e}`); core?.hook("session-end", { reason: "crash" }); stopAll(1); });
  process.on("exit", () => { core?.kill(); try { ui?.kill("SIGTERM"); } catch {} rmSync(sock, { force: true }); rmSync(ctl, { force: true }); });
  // Ctrl-C belongs to the UI in the foreground (or the chat view's keys); this process must not die of it.
  process.on("SIGINT", () => {});

  const state = {
    pid: process.pid, server: null, sock, ctl: null, home: h, task: id, session: cfg.session, thread: null, turn: null,
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
  const rememberLaunch = (patch) => core.rememberLaunch(patch);

  // ---- the live file
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

  // ---- prompts: the session keeps them; the record and the pane show the last one open
  const closePrompt = () => {
    const next = core.prompts.at(-1) ?? null;
    state.prompt = next;
    if (next) say(() => showPrompt(next));
    save();
    trySwitch();
  };
  /** The owner's answer to a prompt, from a front end or the pane's keys: { ok, answered } or { ok, already }. */
  const answer = (a) => {
    const r = core.answer(a);
    if (!r.answered) return r;
    say(() => pane.line(dim(`  ${r.allowed ? "approved" : "declined"}${a.by ? ` from ${safe(a.by)}` : ""}`)));
    closePrompt();
    return { ok: true, answered: true };
  };

  // ---- quiet points and the switch
  const quiet = () => !state.turn && !core?.asking && !live.queued.length;
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
  async function handle(req) {
    if (!req || typeof req !== "object") return { ok: false, err: "bad request" };
    switch (req.op) {
      case "state": return { ok: true, ...state };
      case "switch": return requestSwitch(req.to);
      case "say": {
        if (!state.thread) return { ok: false, err: "its Codex thread has not started yet" };
        const text = String(req.text ?? "");
        if (!text.trim() && !req.attachments?.length) return { ok: false, err: "nothing to say" };
        const cid = clientId(DELIVERY);
        const how = state.turn ? "queued" : "sent";
        live.queued.push({ uuid: cid, text: inputOf(text, req.attachments ?? [])[0].text, at: Date.now(), from: req.from ?? null });
        writeLive();
        // Into the running turn, as Codex takes words typed mid-turn.
        try {
          await core.say(text, req.attachments ?? [], cid);
          return { ok: true, how, uuid: cid };
        } catch (e) {
          live.queued = live.queued.filter((x) => x.uuid !== cid);
          writeLive();
          return { ok: false, err: e.message };
        }
      }
      case "interrupt": return { ok: true, interrupted: await core.interrupt() };
      case "answer": return answer(req);
      case "set": {
        if (req.mode) return { ok: false, code: "bad-payload", err: "a Codex worker keeps the permission mode it started with" };
        if (!req.model) return { ok: false, code: "bad-payload", err: "model is required" };
        await core.setModel(req.model);
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

  // ---- the session's events
  const onEvent = (e) => {
    switch (e.type) {
      case "turn-start": state.turn = e.turn; state.turnAt = e.at; save(); return;
      case "taken": {
        const was = live.queued.length;
        live.queued = live.queued.filter((q) => q.uuid !== e.cid);
        if (live.queued.length !== was) writeLive();
        say(() => pane.line(`\n${userLine(e.text)}`));
        return;
      }
      case "item": {
        const x = e.item;
        if (e.phase === "started" && (x.kind === "tool" || x.kind === "subagent")) say(() => toolLine(x));
        if (e.phase === "completed" && x.kind === "assistant") { const l = live.items.get(x.id); say(() => { if (!l) pane.line(`\n${safe(x.text)}`); pane.close(); }); }
        return;
      }
      case "text": {
        const x = live.items.get(e.id);
        const sep = e.part == null ? "" : x && x.part !== e.part ? "\n\n" : "";
        streamText(e.id, e.kind, e.append, sep);
        if (e.part != null) live.items.get(e.id).part = e.part;
        return;
      }
      case "text-end": { const l = live.items.get(e.id); if (l) { l.doneAt = Date.now(); writeLive(); } return; }
      case "turn-end": {
        const now = Date.now();
        for (const x of live.items.values()) x.doneAt ??= now;
        writeLive();
        say(() => pane.hint(`── ${e.ms ? `${Math.round(e.ms / 1000)} s` : "turn ended"}${e.status === "failed" ? " · failed" : e.status === "interrupted" ? " · stopped" : ""}${e.context ? ` · context ${e.context.pct}%` : ""} · Enter opens Codex's own screen`));
        state.turn = null; state.turnAt = null; save();
        // Words steered in as the turn ended and never taken: gone, rather than shown waiting for good.
        if (live.queued.length) setTimeout(() => { if (!state.turn && live.queued.length) { live.queued = []; writeLive(); trySwitch(); } }, 3000).unref();
        return;
      }
      case "after-turn": trySwitch(); return;
      case "request": state.prompt = e.prompt; save(); say(() => showPrompt(e.prompt)); return;
      case "cancel": closePrompt(); return;
      case "exit":
        if (ending) return;
        // The thread lived on it: nothing is left to show in either view.
        process.stderr.write(`\nrollcall: Codex's app server stopped (exit ${e.code}).\n${e.err}\n`);
        stopAll(1);
        return;
      default:
    }
  };

  try { core = await startCodex({ h, id, cfg, sock, on: onEvent, log }); } catch (e) {
    process.stderr.write(`rollcall: ${e.message}\n`);
    stopAll(1);
    return 1;
  }
  state.server = core.pid;
  state.thread = core.thread;
  await new Promise((resolve) => control.listen(ctl, resolve));
  try { chmodSync(ctl, 0o600); } catch {} // only the owner reaches it, whatever the umask or the temp folder
  state.ctl = ctl;
  save();
  if (cfg.prompt) await core.baseline;

  // The chat view's header goes up before the first turn, so the turn's lines print under it.
  if (state.view === "chat") header();
  let headed = state.view === "chat";
  if (cfg.prompt) {
    let prompt = "";
    try { prompt = readFileSync(cfg.prompt, "utf8"); } catch {}
    if (prompt) {
      try { await core.say(prompt, [], clientId("rollcall-l-"), { effort: cfg.effort }); }
      catch (e) { log(`the first prompt did not go in: ${e.message}`); }
      // Codex's own screen resumes from the thread's saved record, which its first message starts.
      if (state.view === "terminal") { for (let i = 0; i < 50 && !state.turn; i++) await sleep(100); await sleep(300); }
    }
  }

  // ---- the views
  const keys = (d) => {
    const s = String(d);
    if (!showing()) return;
    if (s === "\r" || s === "\n") { const r = requestSwitch("terminal"); if (r.pending) pane.hint(state.turn || core.asking ? "Codex's own screen opens when this turn ends." : "Codex's own screen opens in a moment."); return; }
    if (s === "\x1b" || s === "\x03") { if (state.turn) { pane.hint("Stopping the turn…"); void core.interrupt().catch(() => {}); } return; }
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
      if (code === 0 || Date.now() - started > 10_000 || core.exited) break;
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
  core.hook("session-end", { reason: "exit" });
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
  killServer(rec?.server, rec?.sock);
  if (rec?.sock) rmSync(rec.sock, { force: true });
  rmSync(stateFile(h, id), { force: true });
}
