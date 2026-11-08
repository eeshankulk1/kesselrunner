// Supervisor v3 end to end on a real tmux server (a private socket) with a fake `claude`: the fake runs the
// hooks of its launch settings like Claude Code does, and logs its argv and every prompt typed into it.
// Done when: start.mjs launches the worker in its tmux window with the brief, a fixed session id and its
// hooks; `@t3` lines and picks reach it typed, never the supervisor's model, and leave its delivery queue only on the
// worker's own receipt, retried and then told to the owner once; words wait while a dialog's flag is up, which a
// cancelled dialog takes down through the transcript; the transcript says whose a prompt is; a dead worker resumes with the owner's words; a home has one watcher, which starts by itself, takes the
// fixed steps (a fresh worker after a handoff, a resume, a start once nothing holds a task), tells the owner plain
// facts with no model turn, and hands the model only what needs a judgment: typed once its turn ended, with
// nothing in the way, or with the owner's next line, and again after a crash; the status line draws one chip per
// task of its own home, keeps each task's tab, and inside falcon leaves the task list to the tab bar; a worker past
// 35% context hears it once from its own hooks, and at the cap its hooks make it hand off; a supervisor past its
// mark hands over to a fresh session; a merged PR lands its task only when its worktree holds nothing more; a
// finished task's tab counts down to its window closing, which waits while a terminal shows it; a finished task's
// worker comes back on --resume or @name, its worktree restored after gc; and falcon opens a supervisor as the
// first window of its home's tmux session, continues or resumes it, and closes it cleanly.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BIN, sandbox, until, write } from "../packages/rollcall/test/helpers.mjs";
import { trusted, wantsBrowser } from "../packages/rollcall/src/supervisor.mjs";

const START = fileURLToPath(new URL("../scripts/supervisor/start.mjs", import.meta.url));
const FALCON = fileURLToPath(new URL("../packages/rollcall/bin/falcon.mjs", import.meta.url));
const HAS_TMUX = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const QUESTIONS = [{ question: "Which header style?", header: "Style", multiSelect: false, options: [{ label: "Subtitle (Recommended)", description: "a second line" }, { label: "Bold title", description: "one line" }] }];

/**
 * A fake interactive `claude`: runs its --settings hooks (SessionStart, then UserPromptSubmit and Stop per
 * prompt), turns on bracketed paste, and takes typed lines as prompts. Like Claude Code it writes a prompt's
 * transcript record after UserPromptSubmit returns, and it fires that hook while a turn runs too. Prompt "ask"
 * calls AskUserQuestion; "dialog" opens a permission prompt for a Bash call its transcript holds (PermissionRequest,
 * and "Esc to cancel" on screen) that Enter answers and Esc cancels with no hook at all; "dialog two" also finishes
 * another tool call while it is open; "wakeup <text>" comes in as a prompt Claude Code made, as a scheduled wake-up
 * does; "busy" starts a turn that runs until "/stop", in which a typed line reaches the hook at once and the transcript
 * at the next tool result; "say <text>" prints the text above an idle prompt box; "box <text>" draws the prompt box
 * holding that text, a draft; "limit <text>" ends its turn on a usage limit, as an API error does: StopFailure and
 * no Stop; "limit-dialog <text>" does too and then shows the limit dialog, which takes no typed line; "error" ends its
 * turn on another API error; "/exit" quits. A file `fake-mode` beside it changes how prompts land: "lost" (seen
 * by nothing), "no-hook" (the transcript has it, the hook failed), "wrap" (wrapped as Claude Code wraps a long paste,
 * a paste's tag inside it escaped), "reshaped" (reversed: nothing rollcall typed is known again). A file `fake-trust` puts Claude Code's trust prompt
 * first, where no hook runs, Enter means "No, exit" and "y" goes on.
 */
function fakeClaude(sb) {
  const bin = join(sb.root, "claude");
  const log = join(sb.root, "claude.log");
  write(bin, `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const LOG = ${JSON.stringify(log)};
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + "\\n");
const ROOT = ${JSON.stringify(sb.root)};
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const sid = opt("--session-id") ?? opt("--resume");
// A supervisor falcon starts gets settings with no hooks of its own.
const settings = opt("--settings") ? JSON.parse(fs.readFileSync(opt("--settings"), "utf8")) : {};
settings.hooks ??= {};
const valued = new Set(["--session-id", "--resume", "--add-dir", "--settings", "--permission-mode", "--model", "--effort", "-n"]);
let prompt = null;
for (let i = 0; i < args.length; i++) { if (valued.has(args[i])) { i++; continue; } prompt = args[i]; }
log({ argv: args, cwd: process.cwd(), task: process.env.ROLLCALL_TASK, port: process.env.ROLLCALL_PORT, pid: process.pid });
const TRANSCRIPT = ROOT + "/transcripts/" + sid + ".jsonl";
fs.mkdirSync(ROOT + "/transcripts", { recursive: true });
const record = (o) => fs.appendFileSync(TRANSCRIPT, JSON.stringify({ timestamp: new Date().toISOString(), sessionId: sid, ...o }) + "\\n");
const mode = () => { try { return fs.readFileSync(ROOT + "/fake-mode", "utf8").trim(); } catch { return ""; } };
function hook(event, payload = {}, on) {
  let out = "";
  for (const entry of settings.hooks[event] ?? []) {
    if (entry.matcher && on !== undefined && !new RegExp(entry.matcher).test(on)) continue;
    for (const h of entry.hooks) out += spawnSync("sh", ["-c", h.command], { input: JSON.stringify({ session_id: sid, transcript_path: TRANSCRIPT, hook_event_name: event, ...payload }), encoding: "utf8" }).stdout ?? "";
  }
  return out;
}
let dialog = null, turn = false;
const HUMAN = { origin: { kind: "human" }, promptSource: "typed" };
let behindDialog = false;
function submit(text) {
  if (behindDialog) { log({ unseen: text }); return; }
  log({ prompt: text });
  if (text === "/exit") process.exit(0);
  if (mode() === "lost") return;
  if (text === "/stop") { turn = false; hook("Stop"); return; }
  const wakeup = text.startsWith("wakeup ");
  const given = wakeup ? text.slice(7) : text;
  const said = mode() === "wrap" ? '\\n\\n<pasted_content id="1325">\\n' + given.replace(/<(\\/?)pasted_content/g, "<\\\\$1pasted_content") + '\\n</pasted_content id="1325">\\n'
    : mode() === "reshaped" ? [...given].reverse().join("") : given;
  if (mode() !== "no-hook") hook("UserPromptSubmit", { prompt: said });
  if (turn) { record({ type: "attachment", attachment: { type: "queued_command", prompt: said, origin: { kind: "human" } } }); return; }
  record({ type: "user", message: { role: "user", content: said }, ...(wakeup ? { isMeta: true, promptSource: "system", turnOrigin: "scheduled" } : HUMAN) });
  if (text === "busy") { turn = true; return; }
  if (text.startsWith("limit")) {
    hook("StopFailure", { error: "rate_limit", error_details: "429", last_assistant_message: text.replace(/^limit(-dialog)? /, "") });
    if (text.startsWith("limit-dialog")) { behindDialog = true; process.stdout.write("\\r\\nWhat do you want to do?\\r\\n> 1. Stop and wait for limit to reset\\r\\n"); }
    return;
  }
  if (text === "error") { hook("StopFailure", { error: "server_error", last_assistant_message: "API Error: 500" }); return; }
  if (text === "ask") log({ ask: hook("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions: ${JSON.stringify(QUESTIONS)} } }, "AskUserQuestion") });
  if (text.startsWith("say ")) process.stdout.write("\\r\\n" + text.slice(4) + "\\r\\n\\r\\n────────\\r\\n> \\r\\n────────\\r\\n  ? for shortcuts\\r\\n");
  if (text.startsWith("box")) process.stdout.write("\\r\\n────────\\r\\n❯ " + text.slice(4) + "\\r\\n────────\\r\\n");
  if (text.startsWith("dialog")) {
    const call = { type: "tool_use", id: "toolu_" + Date.now(), name: "Bash", input: { command: "cp icon.png /tmp/icon.png", description: "Copy the app icon" } };
    record({ type: "assistant", message: { content: [call] } });
    hook("PermissionRequest", { tool_name: "Bash", tool_input: call.input });
    process.stdout.write("\\r\\nDo you want to proceed?\\r\\n> 1. Yes\\r\\nEsc to cancel\\r\\n");
    dialog = call;
    if (text === "dialog two") hook("PostToolUse", { tool_name: "Read", tool_input: { file_path: "/tmp/other" } });
    return;
  }
  hook("Stop");
}
function closeDialog(result) {
  const call = dialog;
  dialog = null;
  record({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, ...result }] } });
  process.stdout.write("\\x1b[2J\\x1b[H");
  return call;
}
function run() {
  hook("SessionStart", { source: opt("--resume") ? "resume" : "startup" });
  process.stdout.write("fake claude " + sid + "\\r\\n");
  if (prompt) submit(prompt);
}
process.stdout.write("\\x1b[?2004h");
let trust = fs.existsSync(ROOT + "/fake-trust");
if (trust) process.stdout.write("Quick safety check: Is this a project you trust?\\r\\n> 1. Yes, I trust this folder\\r\\n  2. No, exit\\r\\n");
else run();
process.stdin.setRawMode(true);
let buf = "", paste = false;
process.stdin.on("data", (d) => {
  let s = d.toString("utf8");
  while (s.length) {
    if (s.startsWith("\\x1b[200~")) { paste = true; s = s.slice(6); continue; }
    if (s.startsWith("\\x1b[201~")) { paste = false; s = s.slice(6); continue; }
    if (s[0] === "\\x1b") {
      log({ key: "escape" });
      s = s.slice(1);
      // No hook fires: only the transcript says the call ended.
      if (dialog) { closeDialog({ is_error: true, content: "The user doesn't want to proceed" }); record({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } }); }
      continue;
    }
    const c = s[0];
    s = s.slice(1);
    if (trust) {
      if (c === "y") { trust = false; buf = ""; run(); continue; }
      if ((c === "\\r" || c === "\\n") && !paste) { log({ trust: "no, exit" }); process.exit(1); }
      continue;
    }
    if ((c === "\\r" || c === "\\n") && !paste) {
      if (dialog) { log({ answered: buf }); buf = ""; const call = closeDialog({ content: "done" }); hook("PostToolUse", { tool_name: "Bash", tool_input: call.input }); hook("Stop"); continue; }
      const text = buf; buf = ""; submit(text); continue;
    }
    // Inside a paste tmux sends a line break as CR; Claude Code keeps it as a newline in the prompt.
    buf += paste && c === "\\r" ? "\\n" : c;
  }
});
`);
  chmodSync(bin, 0o755);
  const lines = () => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { bin, lines, prompts: () => lines().filter((l) => "prompt" in l).map((l) => l.prompt), runs: () => lines().filter((l) => l.argv) };
}

/**
 * A private tmux server, the sandbox and the fake claude. The server's teardown is registered first so it
 * runs before the sandbox's (after hooks run in order) and the fakes' log still exists: terminals and fakes
 * go before the server, since a process still opening its tty when tmux revokes it hangs in the kernel
 * (macOS) and keeps the pty.
 */
function server(t) {
  const socket = `rc-sup-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const terminals = [];
  let claude = null;
  t.after(() => {
    for (const p of terminals) { try { p.kill("SIGKILL"); } catch {} }
    for (const r of claude?.runs() ?? []) { try { process.kill(r.pid, "SIGKILL"); } catch {} }
    // A home's watcher, where a test let one start by itself: it would write into a sandbox that is gone.
    for (const h of homes(sb)) { const pid = watching({ sb }, h); if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} } }
    if (process.env.ROLLCALL_KEEP_SANDBOX) return;
    spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    // tmux leaves the socket file behind when its server is killed.
    rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid()}`, socket), { force: true });
  });
  const sb = sandbox(t);
  sb.env = { ...sb.env, ROLLCALL_TMUX_SOCKET: socket, SHELL: "/bin/sh", HOME: sb.root, ROLLCALL_NOTIFY_LOG: join(sb.root, "notify.log") };
  delete sb.env.TMUX;
  claude = fakeClaude(sb);
  const tmux = (...a) => spawnSync("tmux", ["-L", socket, ...a], { encoding: "utf8" }).stdout.trim();
  return { sb, claude, socket, tmux, terminals };
}

/**
 * A terminal showing home h's tmux session, as the owner's tab would: a control-mode client, which needs no
 * tty (`script` refuses a pipe for stdin, and from /dev/null it types a ^D into the pane).
 */
async function terminal(w, h) {
  const p = spawn("tmux", ["-L", w.socket, "-C", "attach-session", "-t", `=sv-${h}`], { stdio: ["pipe", "ignore", "ignore"], env: w.sb.env });
  w.terminals.push(p);
  await until(() => w.tmux("list-clients", "-t", `=sv-${h}`) !== "", { timeout: 5000 });
  return p;
}

const HAS_PYTHON = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;

/**
 * A terminal on window `name` of home h's session that has lost the focus, as a Cockpit tab the owner is not on: a
 * real tty (python's pty, since a control-mode client takes no keys) that reports focus-out once attached. tmux
 * counts a terminal focused until it says otherwise.
 */
async function unfocused(w, h, name) {
  const py = "import os,pty,sys,time\npid,fd=pty.fork()\nif pid==0: os.execvp('tmux',sys.argv[1:])\ntime.sleep(0.5)\nos.write(fd,b'\\x1b[O')\nwhile True:\n  try:\n    if not os.read(fd,4096): break\n  except OSError: break\n";
  const p = spawn("python3", ["-c", py, "tmux", "-L", w.socket, "attach-session", "-t", `=sv-${h}:=${name}`], { stdio: "ignore", env: { ...w.sb.env, TERM: "xterm-256color" } });
  w.terminals.push(p);
  const rows = () => w.tmux("list-clients", "-F", "#{window_name}\t#{client_flags}").split("\n").filter((l) => l.startsWith(`${name}\t`));
  await until(() => rows().some((l) => !l.split("\t")[1].split(",").includes("focused")), { timeout: 20_000 });
  return p;
}

/** A sandbox with a supervisor alpha and one task, its own tmux server, and the fake claude. */
function world(t, { words = "make the header professional" } = {}) {
  const { sb, claude, socket, tmux, terminals } = server(t);
  const sup = sb.session(sb.root);
  sup.env = { ...sup.env, KESSELRUNNER_CLAUDE_BIN: claude.bin };
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  assert.equal(sup.cli(["task", "new", "chat header", "--repo", sb.main, "--words", words]).code, 0);
  const startArgs = (args) => {
    const r = spawnSync(process.execPath, [START, ...args], { cwd: sup.cwd, encoding: "utf8", env: { ...sup.env, ROLLCALL_SESSION: sup.id } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const task = () => JSON.parse(sup.cli(["task", "show", "t1", "--json"]).stdout);
  return { sb, sup, claude, start: startArgs, tmux, task, socket, terminals, wt: join(sb.main, ".claude/worktrees/chat-header") };
}

const routed = (r) => (r.json?.continue === false ? r.json.stopReason : null);
/** What a hook's answer adds to the model's context, or null. */
const addedContext = (r) => r.json?.hookSpecificOutput?.additionalContext ?? null;
const ask = (sup, questions, answers) => sup.hook("post-tool-use", "PostToolUse", { tool_name: "AskUserQuestion", tool_input: { questions }, tool_response: { questions, answers }, tool_use_id: "toolu_1" });
const FAST = { ROLLCALL_WATCH_POLL_MS: "100", ROLLCALL_GONE_MS: "300" };
const homes = (sb) => { try { return readdirSync(join(sb.home, "_supervisors")); } catch { return []; } };
/** The pid in home h's watch.json, or null. */
const watching = (w, h = "alpha") => { try { return JSON.parse(readFileSync(join(w.sb.home, "_supervisors", h, "watch.json"), "utf8")).pid; } catch { return null; } };
/** Home h's watcher, running: `done` is its exit code, and stop() ends it. */
function watcher(w, env = {}, h = "alpha") {
  const p = spawn(process.execPath, [BIN, "watch", h], { env: { ...w.sup.env, ...FAST, ...env }, stdio: "ignore" });
  w.sb.track(p);
  const done = new Promise((res) => p.on("exit", (code) => res(code)));
  return { proc: p, done, stop: () => { p.kill(); return done; } };
}
/** One look by home h's watcher, to the end of the steps it starts. */
const look = (w, env = {}, h = "alpha") => spawnSync(process.execPath, [BIN, "watch", h, "--once"], { env: { ...w.sup.env, ...FAST, ...env }, encoding: "utf8", timeout: 30_000 });
/** What the supervisor's model hears with the turn that starts now. The turn ends, so it hears a thing once. */
function news(w) {
  const heard = addedContext(w.sup.prompt("what now?")) ?? "";
  w.sup.stop();
  return heard;
}
/** What the owner was told with no model turn, oldest first. */
const feed = (w, h = "alpha") => { try { return JSON.parse(readFileSync(join(w.sb.home, "_supervisors", h, "feed.json"), "utf8")).map((e) => e.text); } catch { return []; } };
const notified = (w) => { try { return readFileSync(join(w.sb.root, "notify.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } };
/** Home h's news queue: "q" or "d" per entry, and its kinds. */
const queue = (w, h = "alpha") => readdirSync(join(w.sb.home, "_supervisors", h, "wake")).filter((n) => n.endsWith(".json")).sort().map((n) => n[0]);
const kinds = (w, h = "alpha") => readdirSync(join(w.sb.home, "_supervisors", h, "wake")).filter((n) => n.endsWith(".json")).sort().map((n) => JSON.parse(readFileSync(join(w.sb.home, "_supervisors", h, "wake", n), "utf8")).kind);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const homeFile = (w, name, h = "alpha") => { try { return JSON.parse(readFileSync(join(w.sb.home, "_supervisors", h, `${name}.json`), "utf8")); } catch { return null; } };
/** What waits on task t1's delivery queue, by kind. */
const outbox = (w) => (homeFile(w, "outbox-t1") ?? []).map((x) => x.kind);
const statusLog = (w) => readFileSync(join(w.sb.home, "_supervisors/alpha/status/t1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
/** Types a line into t1's window as the owner would there, no terminal needed. */
const inWorker = (w, text) => { w.tmux("send-keys", "-t", "=sv-alpha:=t1", "-l", text); w.tmux("send-keys", "-t", "=sv-alpha:=t1", "Enter"); };
const fakeMode = (w, mode) => (mode ? write(join(w.sb.root, "fake-mode"), mode) : rmSync(join(w.sb.root, "fake-mode"), { force: true }));
const times = (w, text) => w.claude.prompts().filter((p) => p === text).length;

test("start launches the worker in its tmux window: the brief, a fixed session id, its hooks, the task's env", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const brief = w.start(["t1", "--dry-run"]);
  assert.equal(brief.code, 0, brief.stderr);
  assert.match(brief.stdout, /^You are the worker for task t1 \(the owner calls it yoda\), "chat header", in origin, for supervisor alpha/);
  assert.match(brief.stdout, /## The owner's words \(verbatim: these are the task\)\n\nmake the header professional\n/);
  assert.match(brief.stdout, /task set t1 \.\.\.`[\s\S]*task set t1 --state needs-you --question "<the question, one sentence>"`/);
  assert.match(brief.stdout, /"\[rollcall\]" is rollcall's, never the owner's. .* inbox/);
  assert.doesNotMatch(brief.stdout, /SendMessage/);

  const r = w.start(["t1"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^t1: worker [0-9a-f]{8} started \(t1-chat-header\) in .*chat-header\n  watch it: rollcall attach t1/);
  const run = w.claude.runs()[0];
  const sid = w.task().sessions[0].id;
  const files = join(w.sb.home, "_supervisors/alpha/files/t1");
  assert.deepEqual(run.argv.slice(0, 6), ["--session-id", sid, "--add-dir", files, "--settings", join(w.sb.home, "_supervisors/alpha/workers/t1/settings.json")]);
  assert.equal(run.cwd, w.wt);
  assert.equal(run.task, "alpha:t1", "its environment names its task");
  assert.match(run.argv.at(-1), /^You are the worker for task t1/);
  assert.equal(w.tmux("list-windows", "-t", "=sv-alpha", "-F", "#{window_name}"), "t1");
  const settings = JSON.parse(readFileSync(run.argv[5], "utf8"));
  assert.equal(settings.enabledPlugins["1password@1password"], false);
  assert.equal(settings.enabledPlugins["playwright@claude-plugins-official"], undefined, "a repo with no test manifest keeps the browser servers");
  // Nothing in a worker's status line changes with time: it runs on its own events, not the owner's 5 s timer.
  assert.equal(settings.statusLine.refreshInterval, 3600);
  // The owner's screenshots go to the task's folder, which each browser server is told of its own way.
  assert.ok(existsSync(files));
  assert.ok(readFileSync(join(dirname(run.argv[5]), "launch.sh"), "utf8").includes(`export PLAYWRIGHT_MCP_OUTPUT_DIR='${files}'`));
  assert.match(settings.statusLine.command, /rollcall\.mjs' statusline$/);
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /worker-hook 'alpha' 't1' ask/);
  await until(() => w.task().worker?.alive && !w.task().worker.busy, { timeout: 5000 });
  assert.equal(w.start(["t1"]).code, 1, "a running worker is not started twice");
});

test("@t1 and @yoda lines and picks reach the worker typed and never the supervisor's model; @t1 alone points the prompt", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);

  const r = w.sup.prompt("@t1 keep the icon\nand ship it");
  assert.equal(routed(r), "→ yoda · chat header: typed into its worker");
  await until(() => w.claude.prompts().includes("keep the icon\nand ship it"), { timeout: 5000 });
  assert.equal(w.task().words.at(-1).text, "keep the icon\nand ship it");
  assert.equal(w.task().words.length, 2, "recorded once, though the worker's own hook saw it typed too");

  assert.equal(routed(w.sup.prompt("@t1")), "→ talking to yoda · chat header: every line goes to it until a line that is just @");
  assert.equal(routed(w.sup.prompt("one more thing")), "→ yoda · chat header: typed into its worker");
  assert.equal(routed(w.sup.prompt("@")), "← back to the supervisor");
  assert.equal(w.sup.prompt("what is open?").json, null, "a plain line is the supervisor's");
  assert.match(routed(w.sup.prompt("@t9 hi")), /^No task chewie \(t9\) with a worker in supervisor alpha/);
  // The owner calls a task by its name as well: t1 is yoda.
  assert.equal(routed(w.sup.prompt("@yoda keep it blue")), "→ yoda · chat header: typed into its worker");
  await until(() => w.claude.prompts().includes("keep it blue"), { timeout: 5000 });
  assert.equal(routed(w.sup.prompt("@Yoda")), "→ talking to yoda · chat header: every line goes to it until a line that is just @");
  assert.equal(routed(w.sup.prompt("@")), "← back to the supervisor");
  assert.equal(w.sup.prompt("@everyone look at this").json, null, "a word that names no task is the supervisor's");

  // The owner's pick in the supervisor's picker: the question's header names its task.
  const tagged = [{ ...QUESTIONS[0], header: "yoda Style" }];
  const picked = ask(w.sup, tagged, { "Which header style?": "Bold title" });
  assert.match(picked.context, /\[rollcall\] → yoda · chat header: typed into its worker/);
  await until(() => w.claude.prompts().includes("Style: Bold title"), { timeout: 5000 });
  assert.equal(w.task().words.at(-1).text, "Style: Bold title");
  // A picker opened before the name moved to the header: the tag in the question's text still finds its task.
  const old = [{ ...QUESTIONS[0], question: "yoda · chat header: Which header style?" }];
  assert.match(ask(w.sup, old, { "yoda · chat header: Which header style?": "Subtitle" }).context, /→ yoda · chat header: typed into its worker/);
  await until(() => w.claude.prompts().some((p) => p.startsWith("Style (the owner's own words, not one of your options): Subtitle\n")), { timeout: 5000 });
  assert.equal(ask(w.sup, QUESTIONS, { "Which header style?": "x" }).json, null, "the supervisor's own questions go nowhere");
});

test("a picture attached to a pick reaches the worker as a saved path; words meant for the supervisor stop there, and a relay can take them", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.task().worker?.alive && !w.task().worker.busy, { timeout: 5000 });
  const q = [{ question: "Which header style?", header: "yoda Style", options: [{ label: "Bold", description: "" }, { label: "Plain", description: "" }] }];
  const transcript = join(w.sb.root, "supervisor.jsonl");
  write(transcript, "");
  const said = "like this one (Image attached)";
  const png = Buffer.from("not really a png").toString("base64");
  const r = w.sup.hook("post-tool-use", "PostToolUse", { tool_name: "AskUserQuestion", tool_input: { questions: q }, tool_response: { questions: q, answers: { [q[0].question]: said } }, tool_use_id: "toolu_picture1", transcript_path: transcript });
  assert.match(addedContext(r), /→ yoda · chat header: typed into its worker/);
  assert.equal(w.task().words.at(-1).text.includes(said), true, "the words are on the record at once");
  await until(() => w.claude.prompts().some((p) => p.includes(said) && p.includes("Their picture comes next")), { timeout: 5000 });
  // The transcript's entry comes after the hook: the path follows it.
  appendFileSync(transcript, JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_picture1", content: "..." }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }] } }) + "\n");
  const saved = join(w.sb.home, "_supervisors/alpha/files/t1/picture-picture1-1.png");
  await until(() => w.claude.prompts().some((p) => p.includes(saved)), { timeout: 8000 });
  assert.equal(readFileSync(saved, "utf8"), "not really a png");
  assert.equal(w.sup.cli(["_pick-pictures", "alpha", "t1", transcript, "toolu_picture1"], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 1, "a worker never starts it");

  // Options a worker wrote are not the owner's words, even when a label holds a comma.
  const many = [{ question: "Which ones?", header: "yoda Which", multiSelect: true, options: [{ label: "Bold, tall", description: "" }, { label: "Plain", description: "" }] }];
  ask(w.sup, many, { "Which ones?": "Bold, tall, Plain" });
  assert.deepEqual(homeFile(w, "said").map((x) => x.text), [said], "no words of the owner's in that pick");

  // Routing words stop at the supervisor; the question stays open, and a relay can still take them.
  const before = w.claude.prompts().length;
  const words = "so this should be its own task";
  const held = ask(w.sup, q, { [q[0].question]: words });
  assert.match(addedContext(held), /read as meant for you, so they did not go to its worker: "so this should be its own task"/);
  await sleep(300);
  assert.equal(w.claude.prompts().length, before);
  assert.notEqual(w.task().words.at(-1).text, words);
  const relayed = w.sup.cli(["task", "relay", "t1"]);
  assert.equal(relayed.code, 0, relayed.stderr);
  await until(() => w.claude.prompts().includes(words), { timeout: 5000 });
});

test("a pick says which question it answers, and words of the owner's own under Other say so", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  const pick = async (questions, answers) => { const n = w.claude.prompts().length; ask(w.sup, questions, answers); await until(() => w.claude.prompts().length > n, { timeout: 5000 }); return w.claude.prompts().at(-1); };
  const budget = [{ question: "How much more?", header: "yoda Budget", multiSelect: false, options: [{ label: "$1.50", description: "" }, { label: "$3", description: "" }] }];
  assert.equal(await pick(budget, { "How much more?": "$3" }), "Budget: $3");
  // A bare "2" here was read as option 2 ($1.50) when the owner meant 2 dollars.
  const own = await pick(budget, { "How much more?": "2" });
  assert.match(own, /^Budget \(the owner's own words, not one of your options\): 2\nIf this asks you something, answer with `.*task note t1 "reply: <answer>"`/);
  assert.equal(w.task().words.at(-1).text, "Budget (the owner's own words, not one of your options): 2", "the record keeps what the owner said");

  const many = [{ question: "Which ones?", header: "yoda Pick", multiSelect: true, options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] }];
  assert.equal(await pick(many, { "Which ones?": "Red, Blue" }), "Pick: Red, Blue");
  assert.match(await pick(many, { "Which ones?": "Red, and a green one" }), /^Pick \(the owner's own words, not one of your options\): Red, and a green one\n/);

  // Two questions for one task go as one prompt, in their order.
  assert.equal(await pick([...budget, { ...many[0], multiSelect: false }], { "How much more?": "$3", "Which ones?": "Red" }), "1. Budget: $3\n2. Pick: Red");
});

test("while a dialog is open in the worker, the owner's words wait, and go in once it closes", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  assert.equal(routed(w.sup.prompt("@t1 dialog")), "→ yoda · chat header: typed into its worker");
  await until(() => w.task().worker?.dialog, { timeout: 5000 });
  assert.match(routed(w.sup.prompt("@t1 use the subtitle")), /a prompt is open in its worker: your words go in once it closes \(\/attach t1/);
  assert.ok(!w.claude.lines().some((l) => "answered" in l), "nothing typed into the dialog");
  // The owner answers the dialog in the worker's window; the watcher types what waited.
  w.tmux("send-keys", "-t", "=sv-alpha:=t1", "Enter");
  await until(() => w.claude.lines().some((l) => "answered" in l));
  const watch = watcher(w);
  await until(() => w.claude.prompts().includes("use the subtitle"), { timeout: 8000 });
  await watch.stop();
});

test("words the conversation on a worker's screen quotes from a dialog do not hold the owner's words: only its flag does", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  assert.equal(routed(w.sup.prompt("@t1 say Footer: Esc to cancel. Do you want to proceed?")), "→ yoda · chat header: typed into its worker");
  await until(() => w.tmux("capture-pane", "-p", "-t", "=sv-alpha:=t1").includes("Footer: Esc to cancel"), { timeout: 5000 });
  assert.equal(routed(w.sup.prompt("@t1 keep the icon")), "→ yoda · chat header: typed into its worker");
  await until(() => w.claude.prompts().includes("keep the icon"), { timeout: 5000 });
});

test("the worker's own prompt hook is the receipt: an item leaves the queue only then, even in the middle of a turn", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  await until(() => outbox(w).length === 0, { timeout: 5000 });
  assert.equal(homeFile(w, "typed-t1"), null, "its brief starts no \"[rollcall]\", and its receipt says it is rollcall's");

  inWorker(w, "busy");
  await until(() => w.claude.prompts().includes("busy"), { timeout: 5000 });
  assert.equal(routed(w.sup.prompt("@t1 keep the icon")), "→ yoda · chat header: typed into its worker");
  await until(() => w.claude.prompts().includes("keep the icon"), { timeout: 5000 });
  await until(() => outbox(w).length === 0, { timeout: 5000 });
  assert.equal(statusLog(w).findLast((e) => e.ev === "delivered")?.kind, "words");
  assert.equal(homeFile(w, "typed-t1")?.length, 1, "the owner's \"busy\", typed in its window, waits on the transcript");
  look(w);
  assert.deepEqual(w.task().words.slice(1).map((x) => x.text).sort(), ["busy", "keep the icon"], "the delivery is recorded once, the owner's own line too");

  // A doorbell starts "[rollcall]", and is rollcall's by the same receipt, not by that text.
  assert.equal(w.sup.cli(["task", "tell", "t1", "the docs task touches the README"]).code, 0);
  await until(() => w.claude.prompts().some((p) => p.startsWith("[rollcall] The supervisor left you a message")), { timeout: 5000 });
  await until(() => outbox(w).length === 0, { timeout: 5000 });
  assert.equal(homeFile(w, "typed-t1"), null);
});

test("no receipt: the words go out again, three tries, then the owner hears once, and they go again once the worker moves", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  await until(() => outbox(w).length === 0, { timeout: 5000 });
  fakeMode(w, "lost");
  assert.equal(routed(w.sup.prompt("@t1 keep the icon")), "→ yoda · chat header: typed into its worker");
  const run = watcher(w, { ROLLCALL_RECEIPT_MS: "300", ROLLCALL_WATCH_HELD_MS: "100" });
  t.after(() => run.proc.kill());
  await until(() => times(w, "keep the icon") === 3, { timeout: 8000 });
  await until(() => feed(w).some((l) => /your words did not reach its worker after three tries/.test(l)), { timeout: 5000 });
  assert.match(notified(w).at(-1).text, /did not reach its worker/);
  await sleep(1000);
  assert.equal(times(w, "keep the icon"), 3, "no more tries at a worker that does not move");
  assert.deepEqual(outbox(w), ["words"], "the words stay on the queue");

  fakeMode(w, null);
  inWorker(w, "say I moved");
  await until(() => times(w, "keep the icon") === 4, { timeout: 8000 });
  await until(() => outbox(w).length === 0, { timeout: 5000 });
  assert.equal(feed(w).filter((l) => /did not reach/.test(l)).length, 1, "one notice");
  await run.stop();
});

test("a relayed paste comes back wrapped with its own tag escaped, and still counts as rollcall's: it goes in once and is no line of the owner's in the worker's window", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  await until(() => outbox(w).length === 0, { timeout: 5000 });
  fakeMode(w, "wrap");
  const pasted = 'it failed: <pasted_content id="11a4">make: *** Error 127</pasted_content id="11a4">';
  routed(w.sup.prompt(`@t1 ${pasted}`));
  await until(() => w.claude.prompts().includes(pasted), { timeout: 5000 });
  await until(() => outbox(w).length === 0, { timeout: 5000 });
  const run = watcher(w, { ROLLCALL_RECEIPT_MS: "200", ROLLCALL_WATCH_HELD_MS: "100" });
  t.after(() => run.proc.kill());
  await sleep(1000);
  assert.equal(times(w, pasted), 1, "no second try");
  assert.equal(homeFile(w, "typed-t1"), null, "its receipt says it is rollcall's");
  assert.deepEqual(w.task().words.slice(1).map((x) => x.text), [pasted], "the owner's words once, as relayed");
  await run.stop();
});

test("words that go in but are never known again stop after six sends, though each one moves the worker, and the owner hears once", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  await until(() => outbox(w).length === 0, { timeout: 5000 });
  fakeMode(w, "reshaped");
  routed(w.sup.prompt("@t1 keep the icon"));
  const run = watcher(w, { ROLLCALL_RECEIPT_MS: "300", ROLLCALL_WATCH_HELD_MS: "100" });
  t.after(() => run.proc.kill());
  await until(() => outbox(w).length === 0, { timeout: 20_000 });
  await until(() => feed(w).some((l) => /stopped typing your words into its worker/.test(l)), { timeout: 5000 });
  await sleep(1000);
  assert.equal(times(w, "keep the icon"), 6);
  assert.equal(feed(w).filter((l) => /stopped typing/.test(l)).length, 1, "one notice");
  await run.stop();
});

test("a prompt in the transcript is a receipt too: a failed hook sends nothing twice", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  await until(() => outbox(w).length === 0, { timeout: 5000 });
  // rollcall's own hooks in the real settings record the transcript's path on the session.
  w.sb.session(w.wt, { id: w.task().sessions[0].id }).start();
  fakeMode(w, "no-hook");
  routed(w.sup.prompt("@t1 keep the icon"));
  await until(() => w.claude.prompts().includes("keep the icon"), { timeout: 5000 });
  const run = watcher(w, { ROLLCALL_RECEIPT_MS: "200", ROLLCALL_WATCH_HELD_MS: "100" });
  await until(() => outbox(w).length === 0, { timeout: 5000 });
  await sleep(500);
  assert.equal(times(w, "keep the icon"), 1);
  await run.stop();
});

test("a cancelled dialog fires no hook: the transcript takes its flag down, and what waited goes in", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  routed(w.sup.prompt("@t1 dialog"));
  await until(() => w.task().worker?.dialog, { timeout: 5000 });
  assert.match(routed(w.sup.prompt("@t1 use the subtitle")), /a prompt is open in its worker/);
  const run = watcher(w);
  await sleep(2500);
  assert.ok(w.task().worker?.dialog, "a dialog whose call still waits stays up");
  assert.ok(!w.claude.prompts().includes("use the subtitle"));

  w.tmux("send-keys", "-t", "=sv-alpha:=t1", "Escape");
  await until(() => w.claude.lines().some((l) => l.key === "escape"), { timeout: 5000 });
  await until(() => w.claude.prompts().includes("use the subtitle"), { timeout: 8000 });
  assert.ok(statusLog(w).some((e) => e.ev === "dialog-gone"));
  await run.stop();
});

test("another tool call finishing leaves the dialog of the call that waits", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  routed(w.sup.prompt("@t1 dialog two"));
  await until(() => w.task().worker?.dialog, { timeout: 5000 });
  await sleep(500);
  assert.ok(w.task().worker?.dialog, "a parallel call's result is not this dialog's");
  assert.match(routed(w.sup.prompt("@t1 use the subtitle")), /a prompt is open in its worker/);
  w.tmux("send-keys", "-t", "=sv-alpha:=t1", "Enter");
  await until(() => w.task().worker && !w.task().worker.dialog, { timeout: 5000 });
});

test("the transcript says whose a prompt in a worker's window is: Claude Code's own closes no question and tells no one, the owner's does", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "needs-you", "--question", "Which header?"], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  inWorker(w, "wakeup check the deploy");
  await until(() => homeFile(w, "typed-t1")?.length === 1, { timeout: 5000 });
  look(w);
  assert.equal(homeFile(w, "typed-t1"), null, "settled");
  assert.equal(w.task().state, "needs-you");
  assert.equal(w.task().words.length, 1);
  assert.doesNotMatch(news(w), /talked to its worker/);

  inWorker(w, "use the subtitle");
  await until(() => homeFile(w, "typed-t1")?.length === 1, { timeout: 5000 });
  look(w);
  assert.equal(w.task().state, "working");
  assert.equal(w.task().words.at(-1).closed, "Which header?");
  assert.match(news(w), /the owner talked to its worker in its own window, 1 message/);
});

test("a line after a sticky @name goes to the task only when the owner made it; a line relayed must be the owner's", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = await falconSupervisor(t);
  assert.equal(w.sup.cli(["task", "new", "chat header", "--repo", w.sb.main, "--no-worktree"]).code, 0);
  // What the prompt hook sees now, and the record Claude Code writes after it.
  const transcript = join(w.sb.root, "transcripts", `${w.sup.id}.jsonl`);
  const say = (text, more) => { const r = w.sup.prompt(text); appendFileSync(transcript, `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { content: text }, ...more })}\n`); return r; };
  const HUMAN = { origin: { kind: "human" } };
  const WAKE = { isMeta: true, promptSource: "system", turnOrigin: "scheduled" };

  assert.equal(routed(w.sup.prompt("@t1")), "→ talking to yoda · chat header: every line goes to it until a line that is just @");
  // No key in the supervisor's window: Claude Code's own continuation is the supervisor's, whatever it says.
  assert.equal(routed(say("Your usage limit has reset. Continue the task.", { isMeta: true, origin: { kind: "auto-continuation" } })), null);
  const term = await terminal(w, "falcon");
  assert.ok(routed(say("keep the icon", HUMAN)), "a key just now");
  term.kill("SIGKILL");
  await until(() => w.tmux("list-clients", "-t", "=sv-falcon") === "", { timeout: 5000 });
  assert.equal(routed(w.sup.prompt("@")), "← back to the supervisor");

  // That machine line is all the home kept, so there is nothing to relay.
  assert.match(w.sup.cli(["task", "relay", "t1"]).stderr, /no line from the owner to this supervisor/);

  // What rollcall typed into the supervisor (its news) is on the home's `sent` record, and is nobody's line.
  write(join(w.sb.home, "_supervisors/falcon/sent.json"), JSON.stringify({ text: "[rollcall] news from your tasks", at: Date.now() }));
  say("[rollcall] news from your tasks");
  assert.match(w.sup.cli(["task", "relay", "t1"]).stderr, /no line from the owner to this supervisor/);

  // The transcript settles a line the hook could not tell: a wake-up after the owner's line is passed over.
  say("ship yoda", HUMAN);
  say("check the deploy", WAKE);
  w.sup.cli(["task", "relay", "t1"]);
  assert.equal(JSON.parse(w.sup.cli(["task", "show", "t1", "--json"]).stdout).words.at(-1).text, "ship yoda");
});

test("a dialog open in a worker reaches the owner at once with what it asks, once per dialog, with no model turn, and not while a terminal shows that worker", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  // Its slow look is a minute away: the worker's hook pokes it when the dialog opens.
  const run = watcher(w, { ROLLCALL_WATCH_POLL_MS: "60000" });
  await until(() => watching(w) === run.proc.pid);
  const at = Date.now();
  w.sup.prompt("@t1 dialog");
  await until(() => feed(w).length === 1, { timeout: 5000 });
  assert.ok(Date.now() - at < 5000, "heard at once, not at the next look");
  assert.match(feed(w)[0], /^yoda · chat header: its worker waits on approval for Bash: Copy the app icon \(`cp icon\.png \/tmp\/icon\.png`\)\. Answer it in yoda's tab, or \/attach yoda\./);
  assert.match(notified(w).at(-1).text, /waits on approval for Bash/);
  assert.match(w.sup.cli(["task", "list"]).stdout, /waiting on approval for Bash: Copy the app icon \(`cp icon\.png \/tmp\/icon\.png`\) in its window/);
  assert.doesNotMatch(news(w), /approval/, "only the owner can answer it: no model turn");
  await run.stop();

  look(w);
  assert.equal(feed(w).length, 1, "once per dialog");

  // The owner answers it. The next one opens while a terminal shows the worker: they see it there, so no news until they leave it open.
  w.tmux("send-keys", "-t", "=sv-alpha:=t1", "Enter");
  await until(() => w.task().worker && !w.task().worker.dialog, { timeout: 5000 });
  const term = await terminal(w, "alpha");
  w.sup.env = { ...w.sup.env, ROLLCALL_KEY_QUIET_MS: "1" }; // the terminal's attach counts as a key
  w.sup.prompt("@t1 dialog");
  await until(() => w.task().worker?.dialog, { timeout: 5000 });
  look(w);
  assert.equal(feed(w).length, 1, "the owner sees it in the terminal on that worker");
  term.kill("SIGKILL");
  await until(() => w.tmux("list-clients", "-t", "=sv-alpha") === "", { timeout: 5000 });
  look(w);
  assert.equal(feed(w).length, 2, "left open once they look away");
});

test("a dead worker resumes in its window with the owner's words as its prompt, same session",{ skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  const sid = w.task().sessions[0].id;
  process.kill(w.claude.runs()[0].pid, "SIGKILL");
  await until(() => w.task().worker && !w.task().worker.alive, { timeout: 5000 });
  assert.equal(w.task().worker.window, true, "its window stays, back at a shell");
  assert.equal(routed(w.sup.prompt("@t1 carry on")), "→ yoda · chat header: its worker had stopped; it resumes with your words as its prompt");
  await until(() => w.claude.runs().length === 2, { timeout: 5000 });
  assert.deepEqual(w.claude.runs()[1].argv.slice(0, 2), ["--resume", sid]);
  assert.equal(w.claude.runs()[1].argv.at(-1), "carry on");
  assert.equal(w.task().sessions.length, 1, "the same session, not a new one");

  // A window gone entirely (the tmux server died, a restart): --resume makes it again.
  w.tmux("kill-server");
  const r = w.start(["t1", "--resume", "the Mac restarted"]);
  assert.equal(r.code, 0, r.stderr);
  await until(() => w.claude.runs().length === 3, { timeout: 5000 });
  assert.deepEqual(w.claude.runs()[2].argv.slice(0, 2), ["--resume", sid]);
  assert.match(w.claude.runs()[2].argv.at(-1), /^\[rollcall\] This session stopped while task t1 was open \(the Mac restarted\)/);
  assert.equal(w.start(["t1", "--resume", "again"]).code, 1, "a running worker is not resumed twice");

  assert.match(w.start(["t1", "--stop"]).stdout, /worker stopped/);
  assert.equal(w.task().worker.window, false);
  const fresh = w.start(["t1", "--fresh", "context full"]);
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.equal(w.task().sessions.length, 2);
  assert.match(w.claude.runs().at(-1).argv.at(-1), /## Where the last worker left it\n\nYou replace an earlier worker on this task \(context full\)/);
});

test("a worker's AskUserQuestion becomes the task's question, and the supervisor hears it with the picker to open", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  w.sup.prompt("@t1 ask");
  await until(() => w.claude.lines().some((l) => "ask" in l), { timeout: 5000 });
  const denied = JSON.parse(w.claude.lines().find((l) => "ask" in l).ask);
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /went to the owner's picker in the supervisor/);
  assert.equal(w.task().state, "needs-you");

  look(w);
  const heard = news(w);
  assert.match(heard, /^\[rollcall\] supervisor alpha: news from your tasks/);
  const json = JSON.parse(/exactly these questions: (\[.*\])$/m.exec(heard)[1]);
  assert.equal(json[0].question, "Which header style?", "the worker's own words, with no tag in front");
  assert.equal(json[0].header, "yoda Style", "the name leads the header: that is how the pick finds its worker");

  // The turn that carried it ended, so it is gone: a busy or idle worker is no news.
  assert.deepEqual(queue(w), []);
  look(w);
  assert.doesNotMatch(news(w), /asks the owner/);
});

test("a worker's question goes to the picker while a terminal only shows its window, and opens there while the owner is on it", { skip: (!HAS_TMUX && "tmux is not installed") || (!HAS_PYTHON && "python3 is not installed") }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  w.sup.env = { ...w.sup.env, ROLLCALL_KEY_QUIET_MS: "1" }; // a terminal's attach counts as a key
  const asks = () => w.claude.lines().filter((l) => "ask" in l).map((l) => l.ask);

  // The Cockpit app keeps a terminal on each task it opened; the owner is in another one (t19's question, 2026-11-07).
  await unfocused(w, "alpha", "t1");
  w.sup.prompt("@t1 ask");
  await until(() => asks().length === 1, { timeout: 20_000 });
  assert.equal(JSON.parse(asks()[0]).hookSpecificOutput.permissionDecision, "deny", "it went to the owner's picker");
  assert.equal(w.task().state, "needs-you");
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "working"]).code, 0);

  // A terminal with the focus on it: the owner is there, so the question opens in the window.
  await terminal(w, "alpha");
  w.tmux("select-window", "-t", "=sv-alpha:=t1");
  w.sup.prompt("@t1 ask");
  await until(() => asks().length === 2, { timeout: 20_000 });
  assert.equal(asks()[1], "", "left to Claude Code: it opens right there");
  assert.equal(w.task().state, "working");
});

test("a home has one watcher: a second stands down at once, one from before this kind gives way, and a name with no home is refused", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const first = watcher(w, { ROLLCALL_WATCH_POLL_MS: "60000" });
  await until(() => watching(w) === first.proc.pid);
  assert.equal(await watcher(w).done, 0, "one runs: it stands down");
  assert.equal(watching(w), first.proc.pid);
  await first.stop();

  // A watcher from a Stop hook: its file carries a generation, and it stands down once the file changes.
  const old = w.sb.track(spawn("sleep", ["60"], { stdio: "ignore" }));
  write(join(w.sb.home, "_supervisors/alpha/watch.json"), JSON.stringify({ gen: 7, pid: old.pid, at: Date.now() }));
  const next = watcher(w);
  await until(() => watching(w) === next.proc.pid);
  await next.stop();

  // Starting by itself sees through that file too: the status line starts the new kind, and the old one gives way.
  write(join(w.sb.home, "_supervisors/alpha/watch.json"), JSON.stringify({ gen: 8, pid: old.pid, at: Date.now() }));
  statusline({ id: w.sup.id, env: { ...w.sup.env, ...FAST, ROLLCALL_WATCHER: "1" } });
  const started = await until(() => (watching(w) !== old.pid ? watching(w) : null), { timeout: 5000 });
  assert.ok(started);
  process.kill(started);

  assert.notEqual(spawnSync(process.execPath, [BIN, "watch", "nobody"], { env: w.sup.env, encoding: "utf8" }).status, 0);
});

test("a home's watcher starts by itself, comes back when it died, and ends once the home holds nothing", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const on = { id: w.sup.id, env: { ...w.sup.env, ...FAST, ROLLCALL_WATCHER: "1" } };
  statusline(on);
  const pid = await until(() => watching(w), { timeout: 5000 });
  process.kill(pid, "SIGKILL");
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, { timeout: 5000 });
  statusline(on);
  const again = await until(() => (watching(w) !== pid ? watching(w) : null), { timeout: 5000 });
  assert.notEqual(again, pid);

  assert.equal(w.sup.cli(["task", "close", "t1"]).code, 0);
  w.sup.end();
  await until(() => !watching(w), { timeout: 8000 });
  // It clears its record a few milliseconds before the process is gone.
  await until(() => { try { process.kill(again, 0); return false; } catch { return true; } }, { timeout: 5000 });
});

test("the watcher hears queued news at once, though it looks over its tasks only on a slow beat", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const run = watcher(w, { ROLLCALL_WATCH_POLL_MS: "60000" });
  await until(() => watching(w) === run.proc.pid);
  const at = Date.now();
  w.sup.cli(["task", "set", "t1", "--state", "pr-open", "--pr", "https://github.com/o/r/pull/9"], { env: { ROLLCALL_TASK: "alpha:t1" } });
  await until(() => feed(w).includes("yoda · chat header: PR open https://github.com/o/r/pull/9."), { timeout: 5000 });
  assert.ok(Date.now() - at < 5000);
  await run.stop();
  assert.deepEqual(queue(w), [], "the PR is a plain fact: no model turn");
});

test("the status line draws this supervisor's chips only, a waiting task filled; a worker's shows its own task and records its context", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const line = (s, extra = {}) => spawnSync(process.execPath, [BIN, "statusline"], { input: JSON.stringify({ session_id: s.id, ...extra }), env: s.env, encoding: "utf8" }).stdout;
  assert.match(line(w.sup), /supervisor alpha.*\x1b\[38;2;10;132;255m yoda chat header: not started \x1b\[0m/, "a task no worker has run is not called starting");
  const beta = w.sb.session(w.sb.root);
  beta.env = { ...beta.env, ROLLCALL_TMUX_SOCKET: w.socket };
  beta.start();
  beta.cli(["supervise", "beta"]);
  assert.match(line(beta), /supervisor beta · no open tasks/);
  assert.equal(line(w.sb.session(w.sb.root)), "", "a plain session draws nothing");

  assert.equal(w.start(["t1"]).code, 0);
  await until(() => / yoda chat header: idle /.test(line(w.sup)), { timeout: 5000 });
  w.sup.cli(["task", "set", "t1", "--state", "needs-you", "--question", "Ship it?"], { env: { ROLLCALL_TASK: "alpha:t1" } });
  const record = join(w.sb.home, "_supervisors/alpha/tasks/t1.json");
  const x = JSON.parse(readFileSync(record, "utf8"));
  writeFileSync(record, JSON.stringify({ ...x, stateAt: Date.now() - 5 * 60_000 }));
  assert.match(line(w.sup), /\x1b\[1;38;2;0;0;0;48;2;10;132;255m yoda chat header: needs you 5m \x1b\[0m/);

  // The watcher notifies the owner about a wait past its threshold, once until the reminder is due.
  look(w);
  assert.deepEqual(notified(w).map((n) => n.title), ["yoda needs you (alpha)"]);
  assert.match(notified(w)[0].text, /yoda · chat header has waited 5m for you: Ship it\?/);
  look(w);
  assert.equal(notified(w).length, 1);

  // In a worker the status line draws its own task's chip in the task's color and keeps its context use for `task list`.
  const worker = w.sb.session(w.wt);
  worker.env = { ...worker.env, ROLLCALL_TASK: "alpha:t1" };
  assert.match(line(worker, { session_id: w.task().sessions[0].id, context_window: { used_percentage: 63.4 } }), /^\x1b\[1;38;2;0;0;0;48;2;10;132;255m yoda · chat header \x1b\[0m.*worker for supervisor alpha/);
  assert.equal(w.task().worker.context, 63);
});

test("an untrusted repo: the worker waits on Claude Code's trust prompt in its window, start says what the owner does, and nothing is typed there", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  write(join(w.sb.root, ".claude.json"), JSON.stringify({ projects: { [w.sb.root]: { hasTrustDialogAccepted: false } } }));
  write(join(w.sb.root, "fake-trust"), "");
  const r = w.start(["t1"]);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /t1's worker waits on Claude Code's trust prompt for origin .*rollcall attach t1/s);
  await until(() => w.task().worker?.alive, { timeout: 5000 });
  // Enter there is "No, exit": no hook reports the prompt, and no session means nothing can take typing.
  assert.match(routed(w.sup.prompt("@t1 keep the icon")), /still starting: your words go in once it runs/);
  look(w);
  assert.ok(!w.claude.lines().some((l) => "trust" in l), "no Enter reached the trust prompt");

  w.tmux("send-keys", "-t", "=sv-alpha:=t1", "y");
  const run = watcher(w);
  await until(() => w.claude.prompts().includes("keep the icon"), { timeout: 8000 });
  await until(() => outbox(w).length === 0, { timeout: 5000 });
  await run.stop();
  assert.equal(w.claude.prompts().length, 2, "its brief, then the owner's words");

  // Claude Code's rule: the repo's main checkout or the worktree's root, and never a folder above the repo.
  process.env.CLAUDE_CONFIG_DIR = w.sb.root;
  t.after(() => { delete process.env.CLAUDE_CONFIG_DIR; });
  const says = (key) => { write(join(w.sb.root, ".claude.json"), JSON.stringify({ projects: { [key]: { hasTrustDialogAccepted: true } } })); return trusted(w.task()); };
  assert.equal(says(w.sb.main), true, "accepted once for the repo, as every worktree of it");
  assert.equal(says(w.wt), true);
  assert.equal(says(w.sb.root), false, "a repo under a trusted folder is asked about");
  write(join(w.sb.root, ".claude.json"), "not json");
  assert.equal(trusted(w.task()), null, "what cannot be read says nothing");
});

const statusline = (s) => spawnSync(process.execPath, [BIN, "statusline"], { input: JSON.stringify({ session_id: s.id }), env: s.env, encoding: "utf8" }).stdout;

test("the status line keeps the tabs: each task's state, filled while it waits on the owner, and the supervisor's own", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const tab = (win, opt) => w.tmux("display", "-p", "-t", `=sv-alpha:=${win}`, `#{${opt}}`);
  assert.equal(w.start(["t1"]).code, 0);
  assert.equal(tab("t1", "@tab"), "yoda · chat header", "start names its tab at once");
  // A stand-in for falcon's window, and a server started by an older rollcall.
  w.tmux("new-window", "-d", "-t", "=sv-alpha:", "-n", "alpha", "sleep 600");
  w.tmux("set-option", "-gu", "@falcon_dress");
  await until(() => / yoda chat header: idle /.test(statusline(w.sup)), { timeout: 5000 });
  assert.equal(tab("t1", "@tab"), "yoda chat header · idle");
  assert.equal(tab("t1", "@tab_style"), "fg=#0A84FF");
  assert.equal(w.tmux("list-windows", "-t", "=sv-alpha", "-F", "#{@tab_back}|#{window_name}|#{@tab}|#{@tab_style}").split("\n").at(-1), "◀ |alpha|alpha|bold");
  assert.equal(w.tmux("show-options", "-gv", "@falcon_dress"), "2", "a server without the tab bar is dressed again");

  w.sup.cli(["task", "set", "t1", "--state", "needs-you", "--question", "Ship it?"], { env: { ROLLCALL_TASK: "alpha:t1" } });
  statusline(w.sup);
  assert.match(tab("t1", "@tab"), /^yoda chat header · needs you/);
  assert.equal(tab("t1", "@tab_style"), "bg=#0A84FF,fg=black,bold");
});

test("inside falcon the status line leaves the task list to the tab bar: only a task with no tab, and who hears the next line", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.sup.cli(["task", "new", "footer", "--repo", w.sb.main]).code, 0);
  assert.equal(w.sup.cli(["task", "new", "icons", "--repo", w.sb.main, "--after", "t1"]).code, 0);
  assert.equal(w.start(["t1"]).code, 0);
  // A stand-in for falcon's window, and the supervisor's status line run from inside it.
  w.tmux("new-window", "-d", "-t", "=sv-alpha:", "-n", "alpha", "sleep 600");
  const inFalcon = { id: w.sup.id, env: { ...w.sup.env, TMUX: `/private/tmp/tmux-${process.getuid()}/${w.socket},1,0` } };
  await until(() => / yoda chat header: idle /.test(statusline(w.sup)), { timeout: 5000 });
  assert.match(statusline(w.sup), /supervisor alpha.* yoda chat header: idle .* leia footer: not started .* luke icons: waits on yoda /, "outside falcon: every task's chip");
  const line = statusline(inFalcon);
  assert.doesNotMatch(line, /yoda chat header|supervisor alpha/, "a task with a tab gets no chip");
  assert.match(line, / leia footer: not started /, "a task with no window yet keeps its chip");
  assert.equal(w.tmux("display", "-p", "-t", "=sv-alpha:=t1", "#{@tab}"), "yoda chat header · idle", "the tabs still follow");
  w.sup.prompt("@t1");
  assert.match(statusline(inFalcon), /^\x1b\[2m→ yoda \(@ alone: back\)\x1b\[0m/);
  w.sup.cli(["task", "set", "t1", "--state", "pr-open", "--pr", "https://github.com/o/r/pull/1"], { env: { ROLLCALL_TASK: "alpha:t1" } });
  assert.match(statusline(inFalcon), / luke icons: not started /, "once the task it waits on has a PR, nothing holds it");
});

test("a finished task's tab counts down to its window closing, a new turn starts the wait again, and the window stays while a terminal shows it", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const tab = () => w.tmux("display", "-p", "-t", "=sv-alpha:=t1", "#{@tab}");
  const closeAfter = (v) => ({ id: w.sup.id, env: { ...w.sup.env, ROLLCALL_CLOSE_AFTER_MS: v } });
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.task().worker?.alive && !w.task().worker.busy, { timeout: 5000 });
  w.sup.cli(["task", "output", "t1", "Done."], { env: { ROLLCALL_TASK: "alpha:t1" } });
  w.sup.cli(["task", "set", "t1", "--state", "landed"], { env: { ROLLCALL_TASK: "alpha:t1" } });
  statusline(w.sup);
  assert.equal(tab(), "yoda chat header · landed · closes in 10m");
  assert.match(w.sup.cli(["task", "list"]).stdout, /idle, its turn ended just now, its window closes in 10m/);

  // The owner asks it one more thing: a new turn, and the wait starts again from its end.
  const since = w.task().worker.since;
  assert.equal(routed(w.sup.prompt("@t1 one more thing")), "→ yoda · chat header: typed into its worker");
  await until(() => w.task().worker.since > since && !w.task().worker.busy, { timeout: 5000 });
  look(w);
  assert.equal(w.task().worker.window, true, "not due yet");

  // Due while a terminal shows it: it stays, and its tab says so.
  const term = await terminal(w, "alpha");
  statusline(closeAfter("1"));
  assert.equal(tab(), "yoda chat header · landed · closes when you leave it");
  look(w, { ROLLCALL_CLOSE_AFTER_MS: "1" });
  assert.equal(w.task().worker.window, true, "not closed under the owner");

  term.kill("SIGKILL");
  await until(() => w.tmux("list-clients") === "", { timeout: 5000 });
  statusline(closeAfter("1"));
  assert.equal(tab(), "yoda chat header · landed · closing");
  look(w, { ROLLCALL_CLOSE_AFTER_MS: "1" });
  assert.equal(w.task().worker.window, false, "closed once no terminal shows it");
  assert.match(w.sup.cli(["task", "tell", "t1", "did the deploy finish?"]).stdout, /its worker is not running \(t1 is landed\): the doorbell rings once it runs again \(.*start\.mjs t1 --resume "<why>"\)/);
});

test("a finished task's worker comes back to answer the owner: --resume (its worktree restored after gc), --session for an earlier one, and @name", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  assert.equal(w.start(["t1", "--fresh", "context full"]).code, 0);
  await until(() => w.claude.runs().length === 2, { timeout: 5000 });
  const [first, second] = w.task().sessions.map((s) => s.id);
  w.sup.cli(["task", "output", "t1", "Done."], { env: { ROLLCALL_TASK: "alpha:t1" } });
  w.sup.cli(["task", "set", "t1", "--state", "landed"], { env: { ROLLCALL_TASK: "alpha:t1" } });
  assert.equal(w.start(["t1", "--stop"]).code, 0);
  // gc removed its worktree and branch after the landing.
  spawnSync("git", ["-C", w.sb.main, "worktree", "remove", "--force", w.wt]);
  spawnSync("git", ["-C", w.sb.main, "branch", "-D", w.task().branch]);
  assert.equal(existsSync(w.wt), false);

  const refused = w.start(["t1"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /t1 is landed; start a new task instead, or bring its worker back to ask it something: --resume "<why>"/);
  const r = w.start(["t1", "--resume", "a question about the fix"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /t1 stays landed; its window closes 10m after the worker's last turn/);
  await until(() => w.claude.runs().length === 3, { timeout: 5000 });
  const run = w.claude.runs()[2];
  assert.deepEqual(run.argv.slice(0, 2), ["--resume", second]);
  assert.match(run.argv.at(-1), /^\[rollcall\] The owner brought this worker back after task t1 was landed \(a question about the fix\)\. The task stays landed/);
  assert.equal(run.cwd, w.wt, "in the folder its conversation ran in");
  assert.equal(spawnSync("git", ["-C", w.wt, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim(), "HEAD", "the default branch, detached");
  assert.equal(w.task().state, "landed");

  assert.equal(w.start(["t1", "--stop"]).code, 0);
  assert.match(w.start(["t1", "--resume", "x", "--session", "nope"]).stderr, /t1 had no worker nope/);
  assert.match(w.start(["t1", "--session", first.slice(0, 8)]).stderr, /--session <id> goes with --resume/);
  assert.equal(w.start(["t1", "--resume", "it knew the old layout", "--session", first.slice(0, 8)]).code, 0);
  await until(() => w.claude.runs().length === 4, { timeout: 5000 });
  assert.deepEqual(w.claude.runs()[3].argv.slice(0, 2), ["--resume", first]);
  assert.equal(w.task().sessions.at(-1).id, first, "the earlier worker is the task's worker again");

  assert.equal(w.start(["t1", "--stop"]).code, 0);
  assert.equal(routed(w.sup.prompt("@yoda what did you change?")), "→ yoda · chat header: its worker had stopped; it resumes with your words as its prompt");
  await until(() => w.claude.runs().length === 5, { timeout: 5000 });
  assert.deepEqual(w.claude.runs()[4].argv.slice(0, 2), ["--resume", first]);
  assert.equal(w.claude.runs()[4].argv.at(-1), "what did you change?");
});

test("past 35% context a worker hears it once from its own hooks, not the supervisor; at the cap its hooks make it hand off, and rollcall starts the fresh worker from the handoff", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const brief = w.start(["t1", "--dry-run"]).stdout;
  assert.match(brief, /- Handing off: .*cap \(70%: at once, whatever you are doing\).*task handoff t1 --file <file>/);
  assert.match(brief, /task note t1 "grew: <the new part>"/);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  const sid = w.task().sessions[0].id;
  const context = (pct) => spawnSync(process.execPath, [BIN, "statusline"], { input: JSON.stringify({ session_id: sid, context_window: { used_percentage: pct, context_window_size: 1_000_000, total_input_tokens: Math.round(pct * 10_000) } }), env: { ...w.sup.env, ROLLCALL_TASK: "alpha:t1" }, encoding: "utf8" });
  const hook = (event, payload = {}) => spawnSync(process.execPath, [BIN, "worker-hook", "alpha", "t1", event], { input: JSON.stringify({ session_id: sid, ...payload }), env: w.sup.env, encoding: "utf8" }).stdout;
  // The PostToolUse hook from its launch settings, shell test and all.
  const settings = JSON.parse(readFileSync(w.claude.runs()[0].argv[5], "utf8"));
  const capHook = settings.hooks.PostToolUse.flatMap((e) => e.hooks).find((h) => /worker-hook 'alpha' 't1' cap/.test(h.command));
  assert.match(capHook.command, /^\[ -e '.*\/cap' \] && /, "node runs only once the cap flag is up");
  const afterTool = (session = sid) => spawnSync("sh", ["-c", capHook.command], { input: JSON.stringify({ session_id: session, hook_event_name: "PostToolUse" }), env: w.sup.env, encoding: "utf8" }).stdout;

  assert.equal(afterTool(), "", "below the soft mark a tool call hears nothing");
  context(40.2);
  const fromShipper = spawnSync("sh", ["-c", capHook.command], { input: JSON.stringify({ session_id: sid, hook_event_name: "PostToolUse", agent_id: "a1" }), env: w.sup.env, encoding: "utf8" }).stdout;
  assert.equal(fromShipper, "", "a subagent's tool call (its shipper's) hears nothing");
  const soft = JSON.parse(afterTool());
  assert.match(soft.hookSpecificOutput.additionalContext, /^\[rollcall\] Your context is at 40%\. .*hand off at your next clean point.*task handoff t1 --file <file>.*task note t1 "context 40%: carrying on, <what is left>"/);
  assert.match(soft.hookSpecificOutput.additionalContext, /the files to read first and what each is for/);
  assert.match(soft.hookSpecificOutput.additionalContext, /When only checks and the ship question remain.*do not hand off/);
  assert.equal(afterTool(), "", "the soft mark is heard once");
  context(45);
  assert.equal(afterTool(), "", "and stays heard as its context climbs");
  assert.match(w.sup.cli(["task", "list"]).stdout, /context 45% \(450k of 1M\)/);
  look(w);
  assert.doesNotMatch(news(w), /context/, "the supervisor hears nothing of it");

  context(73);
  const told = JSON.parse(afterTool());
  assert.equal(told.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(told.hookSpecificOutput.additionalContext, /^\[rollcall\] Your context is at 73%, the cap for a worker \(70%\): hand off now, whatever you are doing.*rollcall task handoff t1 --file <file>/);
  assert.equal(afterTool("another-session"), "", "the cap is this session's");
  assert.match(JSON.parse(hook("prompt-submit")).hookSpecificOutput.additionalContext, /hand off now.*Words the owner typed above are on the task.s record/);
  assert.equal(JSON.parse(hook("stop")).decision, "block", "it does not end its turn before it hands off");
  assert.equal(hook("stop", { stop_hook_active: true }), "", "told once, it may stop");

  write(join(w.sb.root, "handoff.md"), "The header is half done: title in, subtitle next.\n");
  assert.equal(w.sup.cli(["task", "handoff", "t1", "--file", join(w.sb.root, "handoff.md")], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  assert.equal(afterTool(), "", "a handoff lowers the cap flag");
  assert.equal(hook("stop"), "");
  look(w);
  assert.equal(feed(w).at(-1), "yoda · chat header: its worker handed off (context at 73%, the cap); a fresh worker carries on.");
  assert.equal(w.claude.runs().length, 2, "rollcall started it, with no model turn");
  assert.match(w.claude.runs().at(-1).argv.at(-1), /You replace an earlier worker on this task \(context at 73%, the cap\)[\s\S]*Its handoff, written for you[^\n]*:\n\nThe header is half done: title in, subtitle next\./);
  assert.equal(w.task().worker.context, null, "the new session's context is not the old one's");
});

test("a new task's worker starts once rollcall's setup is done, with its ports in its environment, and its brief says what already ran", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const { sb, claude } = server(t);
  const min = 43000 + (process.pid % 200) * 10;
  sb.env = { ...sb.env, ROLLCALL_PORT_MIN: String(min), ROLLCALL_PORT_MAX: String(min + 49) };
  write(join(sb.main, ".claude/test-manifest.json"), JSON.stringify({ worktree: { setup: "sleep 2 && echo ready > ready.txt" }, devServer: { baseUrl: "http://localhost:{port}" } }));
  write(join(sb.main, ".gitignore"), "ready.txt\n");
  for (const c of [["add", "."], ["commit", "-qm", "manifest"], ["push", "-q", "origin", "main"]]) spawnSync("git", ["-C", sb.main, ...c], { env: sb.env });
  const sup = sb.session(sb.root);
  sup.env = { ...sup.env, KESSELRUNNER_CLAUDE_BIN: claude.bin };
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  assert.equal(sup.cli(["task", "new", "chat header", "--repo", sb.main, "--words", "go"]).code, 0);
  const wt = join(sb.main, ".claude/worktrees/chat-header");
  const start = (args) => spawnSync(process.execPath, [START, ...args], { cwd: sup.cwd, encoding: "utf8", env: { ...sup.env, ROLLCALL_SESSION: sup.id } });
  const brief = start(["t1", "--dry-run"]).stdout;
  assert.match(brief, /rollcall set it up before your first turn \(it ran `sleep 2 && echo ready > ready\.txt`\): do not run that again\./);
  assert.match(brief, new RegExp(`Its ports are ${min}-${min + 9} \\(\`\\$ROLLCALL_PORT\` is the first\\)`));
  assert.match(brief, /before you trust a browser check, `[^`]*serving <port>` must say this checkout serves it/);
  assert.equal(start(["t1"]).status, 0);
  await until(() => claude.runs().length === 1, { timeout: 15_000 });
  assert.ok(existsSync(join(wt, "ready.txt")), "the worker started after its setup finished");
  assert.equal(claude.runs()[0].port, String(min), "its environment has its ports");
  assert.ok(readFileSync(join(sb.home, "_supervisors/alpha/workers/t1/launch.sh"), "utf8").includes("setup --wait --quiet"));
});

test("a fresh worker's brief: the notes that last and the last worker's own, the setup line, the files to start from; the first brief gets the manifest's exact command", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.match(w.start(["t1", "--dry-run"]).stdout, /Run the test manifest's worktree\.setup there first if it defines one\. Stay in it\./);
  write(join(w.wt, ".claude/test-manifest.json"), JSON.stringify({ worktree: { setup: "scripts/setup.sh", setupFlags: "--skip-ios when the task leaves ios/ alone" } }));
  assert.match(w.start(["t1", "--dry-run"]).stdout, /Run `scripts\/setup\.sh` there first \(--skip-ios when the task leaves ios\/ alone\)\. Stay in it\./);
  const worker = { env: { ROLLCALL_TASK: "alpha:t1" } };
  assert.equal(w.sup.cli(["task", "note", "t1", "scope: the header only"]).code, 0);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  for (const note of ["decided: the icon stays", "progress: title in", "Decided: dark mode waits"]) assert.equal(w.sup.cli(["task", "note", "t1", note], worker).code, 0);
  const handoff = () => {
    write(join(w.sb.root, "handoff.md"), "Read src/header.js first.\n");
    assert.equal(w.sup.cli(["task", "handoff", "t1", "--file", join(w.sb.root, "handoff.md")], worker).code, 0);
    look(w);
  };
  handoff();
  await until(() => w.claude.runs().length === 2);
  const second = w.claude.runs().at(-1).argv.at(-1);
  assert.match(second, /The last worker set it up; run `scripts\/setup\.sh` again only if something is missing\. Stay in it\./);
  assert.match(second, /Its handoff, written for you \(start with the files it names, and read more as the work needs it\):\n\nRead src\/header\.js first\./);
  assert.ok(second.includes("- worker") && second.includes("progress: title in"), "the first handoff keeps every note: all are the last worker's");
  assert.ok(!second.includes("older ones"), "nothing left out yet");
  assert.ok(!second.includes("latest PR"), "no PR yet, no PR line");
  assert.equal(w.sup.cli(["task", "set", "t1", "--pr", "https://github.com/o/r/pull/7"], worker).code, 0);

  assert.equal(w.sup.cli(["task", "note", "t1", "progress: subtitle in"], worker).code, 0);
  handoff();
  await until(() => w.claude.runs().length === 3);
  const third = w.claude.runs().at(-1).argv.at(-1);
  for (const kept of ["scope: the header only", "decided: the icon stays", "Decided: dark mode waits", "progress: subtitle in"]) assert.ok(third.includes(kept), kept);
  assert.ok(!third.includes("progress: title in"), "an older worker's progress stays on the record, out of the brief");
  assert.match(third, /Notes \(oldest first; `.*task show t1` has \d+ older ones\):/);
  assert.ok(third.includes("The task's latest PR: https://github.com/o/r/pull/7"), "the PR link outlasts the notes that dropped");
  assert.match(w.sup.cli(["task", "show", "t1"]).stdout, /progress: title in/);
});

test("a worker that ends its turn with nothing running reaches the supervisor once with its last words; one waiting on its shipper does not; its reply does, a bare one does not", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  const sid = w.task().sessions[0].id;
  // The worker's Stop hook, with what Claude Code says at the end of a turn.
  const stop = (payload) => spawnSync(process.execPath, [BIN, "worker-hook", "alpha", "t1", "stop"], { input: JSON.stringify({ session_id: sid, ...payload }), env: w.sup.env, encoding: "utf8" });
  const quick = { ROLLCALL_STUCK_MS: "100" };
  // The fake's own Stop for its first prompt lands first, so the turn ends below are the latest.
  await until(() => /worker \w+ idle/.test(w.sup.cli(["task", "list"]).stdout));

  stop({ background_tasks: [{ id: "a1", type: "local_agent", status: "running", description: "pr-create shipper" }], last_assistant_message: "The shipper is on CI.\nWaiting for its report." });
  const listed = w.sup.cli(["task", "list"]).stdout;
  assert.match(listed, /worker \w+ idle, its turn ended just now, .*waiting on pr-create shipper/);
  assert.match(listed, /its last words: "The shipper is on CI\. Waiting for its report\."/);
  await sleep(200);
  look(w, quick);
  assert.doesNotMatch(news(w), /ended its turn/, "waiting on its shipper is not stuck");

  stop({ background_tasks: [], last_assistant_message: "The header is done. Want me to ship it?" });
  assert.match(w.sup.cli(["task", "list"]).stdout, /nothing running/);
  await sleep(200);
  look(w, quick);
  assert.match(news(w), /yoda · chat header: its worker ended its turn .* with nothing running and reported nothing; the task is still working\. Its last words: "The header is done\. Want me to ship it\?"\. .*task tell t1/);
  look(w, quick);
  assert.doesNotMatch(news(w), /ended its turn/, "once per turn");
  stop({});
  await sleep(200);
  look(w, quick);
  assert.doesNotMatch(news(w), /ended its turn/, "where Claude Code does not say what runs, no news");

  // The supervisor asks; the worker sees it unread until it reads its inbox, and its reply reaches the supervisor.
  assert.equal(w.sup.cli(["task", "tell", "t1", "what are you waiting on?"]).code, 0);
  await until(() => w.claude.prompts().some((x) => /The supervisor left you a message/.test(x)));
  assert.match(w.sup.cli(["task", "list"]).stdout, /1 message unread, the oldest from just now/);
  const worker = { env: { ROLLCALL_TASK: "alpha:t1" } };
  assert.match(w.sup.cli(["inbox"], worker).stdout, /what are you waiting on\?/);
  assert.doesNotMatch(w.sup.cli(["task", "list"]).stdout, /unread/);
  assert.equal(w.sup.cli(["task", "note", "t1", "reply: on it"], worker).code, 0);
  assert.deepEqual(queue(w), [], "a bare reply is no news");
  assert.equal(w.sup.cli(["task", "note", "t1", "reply: on the owner's ship it"], worker).code, 0);
  assert.match(news(w), /yoda · chat header replies: "on the owner's ship it"\. Act on it, then one line to the owner/);
});

test("a finished task's answer to the owner comes back: its reply reaches the supervisor whole, and an answer left in its window comes with its last words", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.task().worker?.alive && !w.task().worker.busy, { timeout: 5000 });
  const worker = { env: { ROLLCALL_TASK: "alpha:t1" } };
  assert.equal(w.sup.cli(["task", "output", "t1", "Done."], worker).code, 0);
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "landed"], worker).code, 0);
  look(w);
  assert.equal(feed(w).at(-1), "yoda · chat header: landed. Done.");
  const sid = w.task().sessions[0].id;
  // The worker's own hooks, run by hand so a reply can land inside its turn.
  const hook = (event, payload = {}) => spawnSync(process.execPath, [BIN, "worker-hook", "alpha", "t1", event], { input: JSON.stringify({ session_id: sid, ...payload }), env: w.sup.env, encoding: "utf8" });

  // The supervisor relays the owner's ask; the worker answers with a reply, several lines long.
  assert.equal(w.sup.cli(["task", "words", "t1", "give me a caption"]).code, 0);
  hook("prompt-submit");
  assert.equal(w.sup.cli(["task", "note", "t1", "reply: 5 overrated Claude skills 😬\n#claude #claudeskills"], worker).code, 0);
  hook("stop", { background_tasks: [], last_assistant_message: "Sent the caption." });
  let heard = news(w);
  assert.match(heard, /yoda · chat header \(landed\) replies, as written:\n {4}5 overrated Claude skills 😬\n {4}#claude #claudeskills\n {2}Act on it, then one line to the owner; an answer to the owner's own words goes to them whole/);
  assert.doesNotMatch(heard, /without a reply/, "it replied");

  // Two replies before the supervisor's next turn: both come, oldest first.
  assert.equal(w.sup.cli(["task", "note", "t1", "reply: first"], worker).code, 0);
  assert.equal(w.sup.cli(["task", "note", "t1", "reply: second"], worker).code, 0);
  assert.match(news(w), /replies, as written:\n {4}first\n\n {4}second\n/);

  // Asked again, it answers in its window alone: its last words, whole, go to the supervisor, once.
  assert.equal(w.sup.cli(["task", "words", "t1", "and the hashtags?"]).code, 0);
  hook("prompt-submit");
  hook("stop", { background_tasks: [], last_assistant_message: "Here they are:\n#claude #ai" });
  assert.match(news(w), /yoda · chat header \(landed\) heard from you after it finished and ended its turn without a reply\. Its last words, as written:\n {4}Here they are:\n {4}#claude #ai\n {2}If they answer what the owner asked, give the owner that answer whole, as written; else ask it: `rollcall task tell t1/);
  hook("prompt-submit");
  hook("stop", { background_tasks: [], last_assistant_message: "Anything else?" });
  assert.doesNotMatch(news(w), /without a reply/, "once per thing it heard");

  // Still rendering in the background: it may reply yet, so no news until a turn ends with nothing running.
  assert.equal(w.sup.cli(["task", "words", "t1", "a shorter one?"]).code, 0);
  hook("prompt-submit");
  hook("stop", { background_tasks: [{ id: "b1", type: "local_bash", status: "running", description: "render" }], last_assistant_message: "Rendering." });
  assert.doesNotMatch(news(w), /without a reply/);
  hook("prompt-submit");
  hook("stop", { background_tasks: [], last_assistant_message: "Short: 5 overrated Claude skills." });
  assert.match(news(w), /without a reply\. Its last words, as written:\n {4}Short: 5 overrated Claude skills\./);

  // A message from the supervisor counts the same: its doorbell's turn (the fake says nothing) ends with no reply.
  assert.equal(w.sup.cli(["task", "tell", "t1", "[owner, relayed] which one did you pick?"]).code, 0);
  await until(() => w.claude.prompts().some((x) => /The supervisor left you a message/.test(x)));
  await until(() => queue(w).length === 1, { timeout: 5000 });
  assert.match(news(w), /heard from you after it finished and ended its turn without a reply\. It left no last words\./);
});

test("a task made to wait on another starts by itself once nothing holds it, unless the owner held it, and the status line counts the owner's decisions", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.sup.cli(["task", "new", "microsoft 365 group", "--repo", w.sb.main, "--after", "t1"]).code, 0);
  assert.equal(w.sup.cli(["task", "new", "apple group", "--repo", w.sb.main, "--after", "t1", "--hold"]).code, 0);
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "pr-open", "--pr", "https://github.com/o/r/pull/9"], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  // The watcher asks gh whether the PR merged: a fake one says it is open.
  const bin = join(w.sb.root, "bin");
  mkdirSync(bin, { recursive: true });
  write(join(bin, "gh"), `#!/bin/sh\necho '{"state":"OPEN"}'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const gh = { PATH: `${bin}:${w.sup.env.PATH ?? process.env.PATH}` };
  look(w, gh);
  assert.ok(feed(w).includes("yoda · chat header: PR open https://github.com/o/r/pull/9."));
  assert.ok(feed(w).includes("leia · microsoft 365 group: nothing holds it now; its worker started."));
  assert.deepEqual(w.claude.runs().map((r) => r.task), ["alpha:t2"], "rollcall started it, with no model turn");
  assert.match(statusline(w.sup), / luke apple group: held /);
  look(w, gh);
  assert.equal(w.claude.runs().length, 1, "a held task waits for the owner's word");

  // A task made after its parent had shipped (or one whose parent shipped while no watcher looked) starts too.
  assert.equal(w.sup.cli(["task", "output", "t1", "Shipped."], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "landed"], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  assert.equal(w.sup.cli(["task", "new", "outlook group", "--repo", w.sb.main, "--after", "t1"]).code, 0);
  look(w, gh);
  assert.deepEqual(w.claude.runs().map((r) => r.task), ["alpha:t2", "alpha:t4"]);
  // One still held does not: the chip says what it waits on.
  assert.equal(w.sup.cli(["task", "new", "teams group", "--repo", w.sb.main, "--after", "t2"]).code, 0);
  assert.match(statusline(w.sup), / \w+ teams group: waits on leia /);
  look(w, gh);
  assert.equal(w.claude.runs().length, 2);
  assert.equal(w.sup.cli(["task", "decisions", "add", "which Plaid environment is real"]).code, 0);
  assert.match(statusline(w.sup), /1 decision waits on you/);
});

test("a task made to start after its parent landed waits through the PR, and hears to bring in what landed", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.sup.cli(["task", "new", "the build", "--repo", w.sb.main, "--after", "t1", "--until", "landed"]).code, 0);
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "pr-open", "--pr", "https://github.com/o/r/pull/9"], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  const bin = join(w.sb.root, "bin");
  mkdirSync(bin, { recursive: true });
  write(join(bin, "gh"), `#!/bin/sh\necho '{"state":"OPEN"}'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const gh = { PATH: `${bin}:${w.sup.env.PATH ?? process.env.PATH}` };
  look(w, gh);
  assert.equal(w.claude.runs().length, 0, "a PR is not enough");
  assert.match(statusline(w.sup), / leia the build: waits on yoda /);
  assert.ok(w.start(["t2", "--dry-run"]).stdout.includes("This worktree was made before t1 landed: run `git fetch origin && git merge origin/main` first."));
  assert.equal(w.sup.cli(["task", "output", "t1", "The plan landed."], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "landed"], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  look(w, gh);
  assert.deepEqual(w.claude.runs().map((r) => r.task), ["alpha:t2"]);
});

test("a ship's tab shows its stage against the usual time and the Mac's load, and a stage past twice its usual is one line; a reminder comes due once", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const facts = join(w.sb.root, "facts.json");
  write(facts, JSON.stringify({ load: 5 }));
  w.sup.env = { ...w.sup.env, ROLLCALL_MACHINE_FACTS: facts };
  const worker = { env: { ROLLCALL_TASK: "alpha:t1" } };
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "pr-open", "--pr", "https://github.com/o/r/pull/9"], worker).code, 0);
  assert.match(statusline(w.sup), / yoda chat header: PR open /);
  assert.equal(w.sup.cli(["task", "stage", "here", "CI"], worker).code, 0);
  const file = join(w.sb.home, "_supervisors/alpha/tasks/t1.json");
  const task = JSON.parse(readFileSync(file, "utf8"));
  write(join(w.sb.home, task.repo.key, "stages.json"), JSON.stringify({ CI: [600_000, 600_000, 900_000] }));
  write(file, JSON.stringify({ ...task, stage: { name: "CI", at: Date.now() - 1_500_000 } }));
  assert.match(statusline(w.sup), / yoda chat header: CI 25m \(usual 10m\) · Mac load high /);
  const bin = join(w.sb.root, "bin");
  mkdirSync(bin, { recursive: true });
  write(join(bin, "gh"), `#!/bin/sh\necho '{"state":"OPEN"}'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const gh = { PATH: `${bin}:${w.sup.env.PATH ?? process.env.PATH}` };
  look(w, gh);
  const slow = (x) => x.includes("past twice its usual");
  assert.deepEqual(feed(w).filter(slow), ["yoda · chat header: CI has run 25m, past twice its usual 10m. Mac load high."]);
  look(w, gh);
  assert.equal(feed(w).filter(slow).length, 1, "once per stage");

  assert.match(w.sup.cli(["remind", "add build 94 to Public Beta"]).stderr, /usage: rollcall remind/);
  assert.match(w.sup.cli(["remind", "add build 94 to Public Beta", "--in", "2h"]).stdout, /the owner hears this .*add build 94/);
  assert.match(w.sup.cli(["remind"]).stdout, /add build 94 to Public Beta/);
  look(w, gh);
  assert.ok(!feed(w).some((x) => x.startsWith("Reminder")), "not due yet");
  const path = join(w.sb.home, "_supervisors/alpha/reminders.json");
  write(path, JSON.stringify(JSON.parse(readFileSync(path, "utf8")).map((r) => ({ ...r, at: Date.now() - 1000 }))));
  look(w, gh);
  look(w, gh);
  assert.deepEqual(feed(w).filter((x) => x.startsWith("Reminder")), ["Reminder: add build 94 to Public Beta"]);
  assert.match(w.sup.cli(["remind"]).stdout, /no reminders set/);
});

test("the brief: no ship question once the owner said ship, a merge option never first, a before/after page, owner steps only with a reason, a discussion's closing option", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const plain = w.start(["t1", "--dry-run"]).stdout;
  assert.match(plain, /When the owner's words already say to ship \("ship it", "no need to confirm"\), run \/pr-create, the whole ship chain, with no question/);
  assert.match(plain, /with "Change something first" as the first option and "Ship it \(Recommended\)" second/);
  assert.match(plain, /publish one before\/after page with the Artifact tool and put its link in the question/);
  assert.match(plain, /A step for the owner is one only they can take: a credential, a purchase, a physical act, a dashboard with no API/);
  assert.doesNotMatch(plain, /Land the plan and start the build/);
  assert.equal(w.sup.cli(["task", "new", "footer", "--repo", w.sb.main, "--ship"]).code, 0);
  assert.match(w.start(["t2", "--dry-run"]).stdout, /The owner already said to ship this, run \/pr-create/);
  assert.equal(w.sup.cli(["task", "new", "next apps", "--repo", w.sb.main, "--kind", "discuss"]).code, 0);
  const talk = w.start(["t3", "--dry-run"]).stdout;
  assert.match(talk, /closing question offers "Land the plan and start the build"/);
  assert.match(talk, /task new "<short title>" --repo ".*" --after t3 --until landed/);
  assert.equal(w.sup.cli(["task", "new", "clean the disk", "--no-repo"]).code, 0);
  assert.match(w.start(["t4", "--dry-run"]).stdout, /a plain folder: this task belongs to no repo/);
});

test("the owner's words for a task with no worker start one, with the words in its brief", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(routed(w.sup.prompt("@t1 keep the icon")), "yoda · chat header: your words are recorded, but it has no worker yet; rollcall starts one, with your words in its brief.");
  look(w);
  await until(() => w.claude.prompts().length === 1);
  assert.match(w.claude.prompts()[0], /\nkeep the icon\n/);
  assert.equal(feed(w).at(-1), "yoda · chat header: your words started its worker.");
  assert.deepEqual(queue(w), []);
});

test("a step rollcall cannot take reaches the supervisor, with why", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  // A window that cannot start: tmux refuses a socket path this long.
  w.sup.prompt("@t1 keep the icon");
  look(w, { ROLLCALL_TMUX_SOCKET: "x".repeat(300) });
  assert.match(news(w), /yoda · chat header: rollcall could not start its worker \(start\): .+\. Fix what you can, or tell the owner in one line\./);
});

test("a worker gone mid-task comes back by itself, three times in half an hour, then the supervisor hears; one stopped on purpose stays stopped", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  const sid = w.task().sessions[0].id;
  const run = watcher(w, { ROLLCALL_STARTING_MS: "500" });
  for (let i = 1; i <= 3; i++) {
    process.kill(w.claude.runs().at(-1).pid, "SIGKILL");
    await until(() => w.claude.runs().length === i + 1, { timeout: 8000 });
    assert.deepEqual(w.claude.runs().at(-1).argv.slice(0, 2), ["--resume", sid]);
    assert.match(w.claude.runs().at(-1).argv.at(-1), /^\[rollcall\] This session stopped while task t1 was open \(it exited while the task was being worked\)/);
    await until(() => w.task().worker?.alive, { timeout: 5000 });
  }
  await until(() => feed(w).length === 3, { timeout: 5000 });
  assert.equal(feed(w)[0], "yoda · chat header: its worker exited mid-task; rollcall resumed it.");
  process.kill(w.claude.runs().at(-1).pid, "SIGKILL");
  await until(() => kinds(w).includes("exit-loop"), { timeout: 8000 });
  await run.stop();
  assert.equal(w.claude.runs().length, 4);
  assert.match(news(w), /yoda · chat header: its worker exited 3 times in 30 minutes, so rollcall stopped resuming it\./);

  // Stopped on purpose: nothing to come back from.
  assert.equal(w.sup.cli(["task", "new", "footer", "--repo", w.sb.main]).code, 0);
  assert.equal(w.start(["t2"]).code, 0);
  await until(() => w.claude.runs().length === 5, { timeout: 5000 });
  assert.equal(w.start(["t2", "--stop"]).code, 0);
  const quiet = watcher(w, { ROLLCALL_STARTING_MS: "1" });
  await sleep(800);
  await quiet.stop();
  assert.equal(w.claude.runs().length, 5);
});

test("a ship silent past its limit reaches the supervisor once per silence", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "pr-open", "--pr", "https://github.com/o/r/pull/9"], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  const bin = join(w.sb.root, "bin");
  mkdirSync(bin, { recursive: true });
  write(join(bin, "gh"), `#!/bin/sh\necho '{"state":"OPEN","updatedAt":"2026-01-01T00:00:00Z"}'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const gh = { PATH: `${bin}:${w.sup.env.PATH ?? process.env.PATH}`, ROLLCALL_PR_CHECK_MS: "1" };
  look(w, gh);
  assert.doesNotMatch(news(w), /silent/, "a minute is no silence");
  const quick = { ...gh, ROLLCALL_STALL_MS: "1" };
  await sleep(50);
  look(w, quick);
  assert.match(news(w), /yoda · chat header: its ship has been silent a while: no push, check or queue event on https:\/\/github\.com\/o\/r\/pull\/9 \(pr-open\)\. Ask its worker what it waits on/);
  look(w, quick);
  assert.doesNotMatch(news(w), /silent/, "once per silence");
  // A push: its record moves, and a new silence can start.
  assert.equal(w.sup.cli(["task", "note", "t1", "pushed the fix"]).code, 0);
  await sleep(50);
  look(w, quick);
  assert.match(news(w), /its ship has been silent/);
});

test("the status line says which questions wait behind a picker, and what the owner was told, a report as a link", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const worker = (id) => ({ env: { ROLLCALL_TASK: `alpha:${id}` } });
  assert.equal(w.sup.cli(["task", "new", "footer", "--repo", w.sb.main]).code, 0);
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "needs-you", "--question", "Ship it?"], worker("t1")).code, 0);
  assert.equal(w.sup.cli(["task", "set", "t2", "--state", "needs-you", "--question", "Which footer?"], worker("t2")).code, 0);
  assert.match(statusline(w.sup), /questions waiting: yoda, leia/);
  assert.match(news(w), /Which footer\?/);
  assert.doesNotMatch(statusline(w.sup), /questions waiting/);

  assert.equal(w.sup.cli(["task", "output", "t1", "# The header\n\nIt now says Messages.\n"], worker("t1")).code, 0);
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "landed"], worker("t1")).code, 0);
  look(w);
  const report = join(w.sb.home, "_supervisors/alpha/files/t1/task-report.md");
  const line = statusline(w.sup);
  assert.match(line, /yoda · chat header: landed\. The header/);
  assert.ok(line.includes(`\x1b]8;;file://${encodeURI(report)}\x1b\\report\x1b]8;;\x1b\\`), line);
  assert.equal(readFileSync(report, "utf8").trim(), "# The header\n\nIt now says Messages.");
  assert.match(notified(w).at(-1).text, /yoda · chat header: landed\. The header Report: .*task-report\.md/);
});

test("a merged PR lands its task only when the PR held all of its worktree's work: a second PR on the way keeps it open", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const bin = join(w.sb.root, "bin");
  mkdirSync(bin, { recursive: true });
  write(join(bin, "gh"), `#!/bin/sh\necho '{"state":"MERGED","baseRefName":"main"}'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const env = { PATH: `${bin}:${w.sup.env.PATH ?? process.env.PATH}`, ROLLCALL_PR_CHECK_MS: "1" };
  const prOpen = (n) => assert.equal(w.sup.cli(["task", "set", "t1", "--state", "pr-open", "--pr", `https://github.com/o/r/pull/${n}`], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  const git = (...a) => spawnSync("git", ["-C", w.wt, ...a], { encoding: "utf8" });

  // Part 1's PR merged while part 2 is still uncommitted in the worktree.
  prOpen(9);
  write(join(w.wt, "src/part2.js"), "part 2\n");
  look(w, env);
  assert.equal(feed(w).at(-1), "yoda · chat header: https://github.com/o/r/pull/9 landed, but its worktree holds uncommitted changes, so the task stays open (back to working).");
  assert.equal(w.task().state, "working");

  // Committed, not yet on main: still open.
  git("add", ".");
  git("commit", "-qm", "part 2");
  prOpen(9);
  look(w, env);
  assert.match(feed(w).at(-1), /pull\/9 landed, but its worktree holds commits not on origin\/main/);

  // Part 2's own PR merged, squashed: its content is on main, so now the task has landed.
  const main = (...a) => assert.equal(spawnSync("git", ["-C", w.sb.main, ...a], { encoding: "utf8" }).status, 0, a.join(" "));
  main("merge", "-q", "--squash", w.task().branch);
  main("commit", "-qm", "part 2 (#10)");
  main("push", "-q", "origin", "main");
  prOpen(10);
  look(w, env);
  assert.match(feed(w).at(-1), /^yoda · chat header: landed \(https:\/\/github\.com\/o\/r\/pull\/10\)\./);
  assert.equal(w.task().state, "landed");
});

test("a PR merged into another branch has not landed: its task stays open until a PR reaches main", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const bin = join(w.sb.root, "bin");
  mkdirSync(bin, { recursive: true });
  const gh = (base) => { write(join(bin, "gh"), `#!/bin/sh\necho '{"state":"MERGED","baseRefName":"${base}"}'\n`); chmodSync(join(bin, "gh"), 0o755); };
  const env = { PATH: `${bin}:${w.sup.env.PATH ?? process.env.PATH}`, ROLLCALL_PR_CHECK_MS: "1" };
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "pr-open", "--pr", "https://github.com/o/r/pull/9"], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  gh("feat/parent");
  look(w, env);
  assert.equal(w.task().state, "pr-open");
  assert.equal(w.task().merged, undefined, "no merge on the record");
  gh("main");
  look(w, env);
  assert.match(feed(w).at(-1), /^yoda · chat header: landed \(https:\/\/github\.com\/o\/r\/pull\/9\)/);
  assert.equal(w.task().state, "landed");
});

test("a merged PR leaves its task open while its worker runs its after-merge steps, and lands it once nothing runs", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const bin = join(w.sb.root, "bin");
  mkdirSync(bin, { recursive: true });
  write(join(bin, "gh"), `#!/bin/sh\necho '{"state":"MERGED","baseRefName":"main"}'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const env = { PATH: `${bin}:${w.sup.env.PATH ?? process.env.PATH}`, ROLLCALL_PR_CHECK_MS: "1" };
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.task().worker?.alive && !w.task().worker.busy, { timeout: 5000 });

  // Its PR merged while its worker still watches the staging deploy: the task stays open, its tab says merged.
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "queued", "--pr", "https://github.com/o/r/pull/9"], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  look(w, env);
  assert.equal(w.task().state, "queued");
  assert.equal(w.task().notes.at(-1).text, "merge seen (its PR merged); the task stays queued: its worker runs, and reports landed once its after-merge steps are done");
  statusline(w.sup);
  assert.equal(w.tmux("display", "-p", "-t", "=sv-alpha:=t1", "#{@tab}"), "yoda chat header · merged");
  look(w, env);
  assert.equal(w.task().notes.filter((n) => /^merge seen/.test(n.text)).length, 1, "one note per merge");

  // Its worker stopped on purpose, without a report: nothing runs, so rollcall lands it and says what nobody confirmed.
  assert.equal(w.start(["t1", "--stop"]).code, 0);
  look(w, env);
  assert.match(feed(w).at(-1), /^yoda · chat header: landed \(https:\/\/github\.com\/o\/r\/pull\/9\)\. rollcall marked this task landed/);
  assert.equal(w.task().state, "landed");
  assert.equal(w.task().notes.at(-1).text, "landed: its PR merged");
  assert.equal(w.task().output.by, "rollcall");
  assert.match(w.task().output.text, /^rollcall marked this task landed: its PR merged \(https:\/\/github\.com\/o\/r\/pull\/9\)\. Its worker was stopped, so nothing confirms its after-merge steps ran \(a deploy watch, a release build\)/);
});

/** A worker on a task whose PR is in the queue, a fake gh that says it is open, and merge(), after which it says merged into main. */
async function queuedWorld(t) {
  const w = world(t);
  const bin = join(w.sb.root, "bin");
  mkdirSync(bin, { recursive: true });
  const gh = (json) => { write(join(bin, "gh"), `#!/bin/sh\necho '${json}'\n`); chmodSync(join(bin, "gh"), 0o755); };
  gh('{"state":"OPEN","baseRefName":"main"}');
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.task().worker?.alive && !w.task().worker.busy, { timeout: 5000 });
  const worker = { env: { ROLLCALL_TASK: "alpha:t1" } };
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "queued", "--pr", "https://github.com/o/r/pull/9"], worker).code, 0);
  const env = { PATH: `${bin}:${w.sup.env.PATH ?? process.env.PATH}`, ROLLCALL_PR_CHECK_MS: "1" };
  const sid = w.task().sessions[0].id;
  const park = async () => {
    stopHook(w, "t1", sid, { background_tasks: [], last_assistant_message: "Queued." });
    look(w, { ...env, ...PARK });
    await until(() => w.task().worker.parked, { timeout: 5000 });
  };
  return { w, worker, env, park, merge: () => gh('{"state":"MERGED","baseRefName":"main"}') };
}

const CAME_BACK = /^\[rollcall\] This session stopped while task t1 was open \(its work merged: run its after-merge steps, save your report and set the task landed\)/;

test("a merge while its worker is parked brings the worker back for its after-merge steps, and the landing is its to report", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const { w, worker, env, park, merge } = await queuedWorld(t);
  await park();
  merge();
  look(w, env);
  assert.equal(w.task().state, "queued");
  assert.equal(w.task().notes.at(-1).text, "merge seen (its PR merged); the task stays queued: its worker comes back for its after-merge steps");
  await until(() => CAME_BACK.test(w.claude.prompts().at(-1) ?? ""), { timeout: 5000 });
  assert.equal(feed(w).at(-1), "yoda · chat header: its work merged; its worker came back for what follows.");
  look(w, env);
  assert.equal(w.task().state, "queued", "back at work, it holds the task open");
  assert.equal(w.sup.cli(["task", "output", "t1", "Build 94 is on TestFlight."], worker).code, 0);
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "landed"], worker).code, 0);
  assert.equal(w.task().output.by, "worker");
});

test("a worker that comes back after a merge and reports nothing lets the task land: once per merge, and the report says what nobody confirmed", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const { w, env, park, merge } = await queuedWorld(t);
  await park();
  merge();
  look(w, env);
  await until(() => CAME_BACK.test(w.claude.prompts().at(-1) ?? ""), { timeout: 5000 });
  await until(() => w.task().worker?.alive && !w.task().worker.busy, { timeout: 5000 });
  await park();
  look(w, { ...env, ROLLCALL_STARTING_MS: "1" });
  assert.equal(w.task().state, "landed");
  assert.equal(w.claude.prompts().filter((p) => CAME_BACK.test(p)).length, 1);
  assert.match(w.task().output.text, /^rollcall marked this task landed: its PR merged \(https:\/\/github\.com\/o\/r\/pull\/9\)\. Its worker did not report, so nothing confirms its after-merge steps ran/);
  assert.match(feed(w).at(-1), /^yoda · chat header: landed \(https:\/\/github\.com\/o\/r\/pull\/9\)\. rollcall marked this task landed/);
});

test("a merge after its worker exited brings the worker back too, once, and a report it saved stands", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const { w, worker, env, merge } = await queuedWorld(t);
  assert.equal(w.sup.cli(["task", "output", "t1", "All but the release."], worker).code, 0);
  merge();
  process.kill(w.claude.runs().at(-1).pid, "SIGKILL");
  await until(() => !w.task().worker.alive, { timeout: 5000 });
  look(w, env);
  assert.equal(w.task().state, "queued");
  await until(() => CAME_BACK.test(w.claude.runs().at(-1).argv.at(-1)), { timeout: 5000 });
  await until(() => w.task().worker?.alive, { timeout: 5000 });
  process.kill(w.claude.runs().at(-1).pid, "SIGKILL");
  await until(() => !w.task().worker.alive, { timeout: 5000 });
  look(w, { ...env, ROLLCALL_STARTING_MS: "1" });
  assert.equal(w.task().state, "landed", "it came back once for this merge");
  assert.equal(w.task().output.text, "All but the release.", "the report its last worker saved stands");
});

test("a worker stopped on purpose after its merge's wake is not called back, and the next merge check lands the task", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const { w, env, merge } = await queuedWorld(t);
  assert.equal(w.start(["t1", "--stop"]).code, 0);
  write(join(w.sb.home, "_supervisors/alpha/wake/q-9-after-merge.json"), JSON.stringify({ task: "t1", kind: "after-merge", at: Date.now() }));
  look(w, env);
  assert.deepEqual(kinds(w).filter((k) => k === "after-merge"), [], "the step no longer stands, so nothing runs and the entry goes");
  assert.equal(w.claude.runs().length, 1);
  merge();
  look(w, env);
  assert.equal(w.task().state, "landed");
});

test("a handoff between the parts of a plan does not land the task: the merge waits for the fresh worker, which carries on", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const { w, worker, env, merge } = await queuedWorld(t);
  write(join(w.sb.root, "handoff.md"), "Part 1 merged. Part 2 is next.\n");
  assert.equal(w.sup.cli(["task", "handoff", "t1", "--file", join(w.sb.root, "handoff.md")], worker).code, 0);
  assert.equal(w.start(["t1", "--stop"]).code, 0);
  merge();
  look(w, env);
  assert.ok(w.task().notes.some((n) => n.text === "merge seen (its PR merged); the task stays queued: its worker handed off, and a fresh one carries on"));
  await until(() => w.claude.runs().length === 2, { timeout: 5000 });
  assert.match(w.claude.runs()[1].argv.at(-1), /Its handoff, written for you[^\n]*:\n\nPart 1 merged\. Part 2 is next\./);
  assert.equal(w.task().state, "working", "nothing waits on the merged PR now");
  look(w, env);
  assert.equal(w.task().state, "working");
});

test("rollcall attach switches the tab of a terminal on the home's session, and with none says how to open one",{ skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  const noApp = { env: { TERM_PROGRAM: "" } };
  assert.match(w.sup.cli(["attach", "t1"], noApp).stdout, /^Run this in a new terminal tab to reach yoda · chat header/);
  w.tmux("new-window", "-t", "=sv-alpha:", "-n", "alpha", "sleep 600");
  await terminal(w, "alpha");
  const shown = () => w.tmux("display", "-p", "-t", "=sv-alpha:", "#{window_name}");
  assert.equal(shown(), "alpha");
  assert.equal(w.sup.cli(["attach", "t1"], noApp).stdout, "Switched to yoda · chat header. Click alpha in the tab bar to come back.\n");
  assert.equal(shown(), "t1");
});

/** A sandbox for falcon: its own tmux server and the fake claude, and none of this session's environment. */
function falconWorld(t) {
  const w = server(t);
  // A gh that counts as logged in (falcon's first-run check reads `gh auth token`) and fails anything else, as a logged-out gh would.
  const ghDir = join(w.sb.root, "gh-bin");
  mkdirSync(ghDir, { recursive: true });
  writeFileSync(join(ghDir, "gh"), `#!/bin/sh\n[ "$1 $2" = "auth token" ] && exit 0\nexit 1\n`);
  chmodSync(join(ghDir, "gh"), 0o755);
  const env = { ...w.sb.env, PATH: `${ghDir}:${w.sb.env.PATH ?? process.env.PATH}`, KESSELRUNNER_CLAUDE_BIN: w.claude.bin, FALCON_NO_ATTACH: "1" };
  const falcon = (args, { cwd = w.sb.main, env: extra = {} } = {}) => {
    const r = spawnSync(process.execPath, [FALCON, ...args], { cwd, encoding: "utf8", env: { ...env, ...extra }, timeout: 15_000 });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const windows = (h) => w.tmux("list-windows", "-t", `=sv-${h}`, "-F", "#{window_name}").split("\n").filter(Boolean);
  const homeFile = (h, f) => JSON.parse(readFileSync(join(w.sb.home, "_supervisors", h, f), "utf8"));
  /** Where Claude Code would keep the session's transcript, made so falcon can resume it. */
  const transcript = (cwd, id) => {
    const file = join(w.sb.root, ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
    write(file, `${JSON.stringify({ type: "user", cwd })}\n`);
    return file;
  };
  return { ...w, falcon, windows, homeFile, transcript };
}

/** /exit in supervisor h's window: the fake quits as Claude Code would, and the window closes. */
async function quit(w, h) {
  w.tmux("send-keys", "-t", `=sv-${h}:=${h}`, "-l", "/exit");
  w.tmux("send-keys", "-t", `=sv-${h}:=${h}`, "Enter");
  await until(() => !w.windows(h).includes(h), { timeout: 5000 });
}

test("a worker gets the browser MCP servers where its repo shows something a browser can test, where nothing says, or when its task asks", (t) => {
  const root = join(process.env.TMPDIR || "/tmp", `rc-browser-${process.pid}`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const task = (manifest, extra = {}) => {
    const dir = join(root, String(Math.random()).slice(2));
    mkdirSync(dir, { recursive: true });
    if (manifest !== undefined) write(join(dir, ".claude/test-manifest.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    return { worktree: dir, repo: { main: join(root, "none") }, ...extra };
  };
  const unit = { stacks: [{ name: "rollcall", runner: "node:test" }, { name: "ios-unit", runner: "xctest" }] };
  assert.equal(wantsBrowser(task(unit)), false, "unit and iOS stacks only: nothing a browser could test");
  assert.equal(wantsBrowser(task(unit, { browser: true })), true, "task new --browser");
  assert.equal(wantsBrowser(task(undefined)), true, "no manifest: nothing says, so it keeps them");
  assert.equal(wantsBrowser(task("{ not json")), true);
  assert.equal(wantsBrowser(task({ ...unit, devServer: { command: "npm run dev" } })), true);
  assert.equal(wantsBrowser(task({ ...unit, routes: { key: ["/"] } })), true);
  assert.equal(wantsBrowser(task({ stacks: [{ name: "e2e", runner: "playwright" }] })), true);
  assert.equal(wantsBrowser(task({ stacks: [{ name: "web", runner: "tsc" }] })), true);
  // The worktree's own manifest first, then the main checkout's.
  const main = task({ devServer: { command: "x" } });
  assert.equal(wantsBrowser({ worktree: join(root, "gone"), repo: { main: main.worktree } }), true);
});

test("a worker in a repo with nothing for a browser starts without the browser servers; --browser keeps them", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const plugins = (id) => JSON.parse(readFileSync(join(w.sb.home, "_supervisors/alpha/workers", id, "settings.json"), "utf8")).enabledPlugins;
  const manifest = JSON.stringify({ stacks: [{ name: "unit", runner: "node:test" }] });
  write(join(w.wt, ".claude/test-manifest.json"), manifest);
  assert.equal(w.start(["t1"]).code, 0);
  assert.deepEqual(plugins("t1"), { "1password@1password": false, "playwright@claude-plugins-official": false, "chrome-devtools-mcp@claude-plugins-official": false });
  assert.equal(w.sup.cli(["task", "new", "browse the docs", "--repo", w.sb.main, "--browser", "--words", "look it up"]).code, 0);
  write(join(w.sb.main, ".claude/worktrees/browse-the-docs/.claude/test-manifest.json"), manifest);
  assert.equal(w.start(["t2"]).code, 0);
  assert.deepEqual(plugins("t2"), { "1password@1password": false });
  assert.equal(JSON.parse(w.sup.cli(["task", "show", "t2", "--json"]).stdout).browser, true);
  assert.equal(w.task().browser, undefined);
});

/** The worker's Stop hook as Claude Code runs it at the end of a turn, with what was left running. */
const stopHook = (w, id, sid, payload) => spawnSync(process.execPath, [BIN, "worker-hook", "alpha", id, "stop"], { input: JSON.stringify({ session_id: sid, ...payload }), env: w.sup.env, encoding: "utf8" });
const PARK = { ROLLCALL_PARK_AFTER_MS: "1" };

test("an idle worker whose task waits on the owner parks: its tab says so, Enter brings it back, and so do the owner's words, a doorbell and its task turning back to working", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  const sid = w.task().sessions[0].id;
  const worker = { env: { ROLLCALL_TASK: "alpha:t1" } };
  const pane = () => w.tmux("capture-pane", "-p", "-t", "=sv-alpha:=t1");
  const runs = () => w.claude.runs().length;
  // Idle, waiting on the owner, nothing running: it parks.
  const idle = async () => {
    await until(() => w.task().worker?.alive && !w.task().worker.busy, { timeout: 5000 });
    assert.equal(w.sup.cli(["task", "set", "t1", "--state", "needs-you", "--question", "Which style?"], worker).code, 0);
    stopHook(w, "t1", sid, { background_tasks: [], last_assistant_message: "Which style?" });
  };
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "needs-you", "--question", "Which style?"], worker).code, 0);
  stopHook(w, "t1", sid, { background_tasks: [{ id: "a1", status: "running", description: "a CI watch" }] });
  look(w, PARK);
  assert.equal(w.task().worker.alive, true, "a worker with work still running stays");
  await idle();
  look(w, { ...PARK, ROLLCALL_PARK: "0" });
  assert.equal(w.task().worker.alive, true, "ROLLCALL_PARK=0 keeps it running");
  look(w, PARK);
  await until(() => /yoda · chat header is parked: its worker stopped after \d+ minutes idle/.test(pane()), { timeout: 5000 });
  assert.equal(w.task().worker.alive, false);
  assert.equal(w.task().worker.parked, true);
  assert.match(w.sup.cli(["task", "list"]).stdout, /parked/);
  assert.match(statusline(w.sup), / yoda chat header: needs you/, "the owner still sees what it waits on");

  // Enter in its tab: the same conversation, waiting for words.
  const before = runs();
  w.tmux("send-keys", "-t", "=sv-alpha:=t1", "Enter");
  await until(() => runs() === before + 1, { timeout: 5000 });
  assert.deepEqual(w.claude.runs().at(-1).argv, ["--resume", sid, "--add-dir", join(w.sb.home, "_supervisors/alpha/files/t1"), "--settings", join(w.sb.home, "_supervisors/alpha/workers/t1/settings.json")]);
  await until(() => w.task().worker?.alive && !w.task().worker.parked, { timeout: 5000 });

  // The owner's words, from the supervisor: it resumes with them as its prompt.
  await idle();
  look(w, PARK);
  await until(() => w.task().worker.parked, { timeout: 5000 });
  assert.match(routed(w.sup.prompt("@yoda the bold one")), /its worker had stopped; it resumes with your words/);
  await until(() => w.claude.prompts().at(-1) === "the bold one", { timeout: 5000 });
  assert.deepEqual(w.claude.runs().at(-1).argv.slice(0, 2), ["--resume", sid]);

  // The supervisor's message rings it back.
  await idle();
  look(w, PARK);
  await until(() => w.task().worker.parked, { timeout: 5000 });
  assert.match(w.sup.cli(["task", "tell", "t1", "check the footer too"]).stdout, /the doorbell rang/);
  await until(() => /The supervisor left you a message/.test(w.claude.prompts().at(-1) ?? ""), { timeout: 5000 });

  // Its task back at work (the merge queue sent it back, or the supervisor set it): the watcher brings it back.
  await idle();
  look(w, PARK);
  await until(() => w.task().worker.parked, { timeout: 5000 });
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "working"]).code, 0);
  look(w, PARK);
  await until(() => /^\[rollcall\] You were parked \(stopped while idle, to free memory\), and task t1 is being worked again/.test(w.claude.prompts().at(-1) ?? ""), { timeout: 5000 });
});

test("the home's work goes on while news waits on the supervisor: an idle worker parks on time", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  const sid = w.task().sessions[0].id;
  await until(() => w.task().worker?.alive && !w.task().worker.busy, { timeout: 5000 });
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "needs-you", "--question", "Which style?"], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  stopHook(w, "t1", sid, { background_tasks: [], last_assistant_message: "Which style?" });
  const run = watcher(w, { ROLLCALL_PARK_AFTER_MS: "500" });
  await until(() => w.task().worker.parked, { timeout: 5000 });
  await run.stop();
  assert.deepEqual(kinds(w), ["needs-you"], "the news still waits");
});

test("a worker's turn redraws its tab at once through the watcher, not on the status line's timer", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const tab = () => w.tmux("display", "-p", "-t", "=sv-alpha:=t1", "#{@tab}");
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.task().worker?.alive && !w.task().worker.busy, { timeout: 5000 });
  // One look over the tasks when it starts, then none for a minute: only the worker's hooks can change the tab.
  const run = watcher(w, { ROLLCALL_WATCH_POLL_MS: "60000" });
  await until(() => tab() === "yoda chat header · idle", { timeout: 5000 });
  w.tmux("send-keys", "-t", "=sv-alpha:=t1", "-l", "dialog");
  w.tmux("send-keys", "-t", "=sv-alpha:=t1", "Enter");
  await until(() => /^yoda chat header · waiting on a prompt/.test(tab()), { timeout: 4000 });
  await run.stop();
});

test("a supervisor's status line asks tmux once or twice however many tasks it has", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  for (const title of ["footer", "icons", "dark mode"]) assert.equal(w.sup.cli(["task", "new", title, "--repo", w.sb.main, "--no-worktree"]).code, 0);
  await until(() => / yoda chat header: idle /.test(statusline(w.sup)), { timeout: 5000 });
  const real = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
  const log = join(w.sb.root, "tmux-calls.log");
  write(join(w.sb.root, "shim/tmux"), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(w.sb.root, "shim/tmux"), 0o755);
  const env = { ...w.sup.env, PATH: `${join(w.sb.root, "shim")}:${process.env.PATH}` };
  const out = spawnSync(process.execPath, [BIN, "statusline"], { input: JSON.stringify({ session_id: w.sup.id }), env, encoding: "utf8" }).stdout;
  assert.match(out, / yoda chat header: idle .* leia footer: not started .* luke icons: not started .* han dark mode: not started /);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.ok(calls.length <= 2, `tmux ran ${calls.length} times: ${calls.join(" | ")}`);
});

/**
 * A falcon supervisor in its window, its session recorded as rollcall's hooks would (the fake runs none), with a
 * transcript whose last message is `ago` ms old (a tool call still waiting, with `pending`).
 */
async function falconSupervisor(t) {
  const w = falconWorld(t);
  assert.equal(w.falcon([]).code, 0);
  await until(() => w.claude.runs().length === 1);
  const sup = w.sb.session(w.sb.main);
  // What the supervisor's watcher starts runs the same claude as falcon.
  sup.env = { ...sup.env, KESSELRUNNER_CLAUDE_BIN: w.claude.bin };
  // A session's start sweeps for what to park in the background, which would race the tests that park by hand.
  sup.hook("session-start", "SessionStart", { source: "startup", model: "claude-test" }, { ROLLCALL_PARK: "0" });
  assert.equal(sup.cli(["supervise", "falcon"]).code, 0);
  const transcript = join(w.sb.root, "transcripts", `${sup.id}.jsonl`);
  const said = (ago, { pending = false } = {}) => write(transcript, [
    { type: "user", cwd: w.sb.main, timestamp: new Date(Date.now() - ago - 1000).toISOString(), message: { content: "hi" } },
    { type: "assistant", cwd: w.sb.main, timestamp: new Date(Date.now() - ago).toISOString(), message: { content: [pending ? { type: "tool_use", name: "AskUserQuestion", input: {} } : { type: "text", text: "ok" }] } },
    // Claude Code writes to an idle session's transcript too: no message, so it moves nothing.
    { type: "system", subtype: "away_summary", timestamp: new Date().toISOString() },
  ].map((e) => `${JSON.stringify(e)}\n`).join(""));
  const park = (args = [], env = {}) => sup.cli(["park", ...args], { env: { ROLLCALL_PARK_SUPERVISOR_MS: String(3600_000), ROLLCALL_WATCH_POLL_MS: "100", ...env } });
  const pane = () => w.tmux("capture-pane", "-p", "-t", "=sv-falcon:=falcon");
  const start = (args) => { const r = spawnSync(process.execPath, [START, ...args], { cwd: sup.cwd, encoding: "utf8", env: { ...sup.env, ROLLCALL_SESSION: sup.id } }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
  return { ...w, sup, said, park, pane, start };
}

test("a falcon supervisor parks in place once quiet an hour between turns, whatever its tasks; a waiting picker or a terminal in use keeps it; Enter in its tab brings it back", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = await falconSupervisor(t);
  w.said(60_000);
  assert.equal(w.park(["--dry-run"]).stdout, "nothing to park\n", "quiet a minute: it stays");
  w.said(2 * 3600_000, { pending: true });
  assert.equal(w.park(["--dry-run"]).stdout, "nothing to park\n", "a picker waits on the owner: it stays");
  w.said(2 * 3600_000);
  await terminal(w, "falcon");
  assert.equal(w.park(["--dry-run"]).stdout, "nothing to park\n", "a terminal used just now: it stays");
  await new Promise((r) => setTimeout(r, 1500));
  assert.match(w.park(["--dry-run"], { ROLLCALL_PARK_SUPERVISOR_MS: "1000" }).stdout, /^would park supervisor falcon \(quiet 120m, no open task\)/, "a terminal left alone longer: it parks");
  assert.equal(w.sup.cli(["task", "new", "chat header", "--repo", w.sb.main, "--no-worktree"]).code, 0);
  const idle = { ROLLCALL_PARK_SUPERVISOR_MS: "1000" };
  assert.match(w.park(["--dry-run"], idle).stdout, /^would park supervisor falcon \(quiet 120m, 1 open task, whose news brings it back\): Enter in its tab or falcon continue resumes it\n$/);

  assert.match(w.park([], idle).stdout, /^parked supervisor falcon/);
  // In place: the window and the terminal on it stay, and the pane says what happened.
  await until(() => /falcon is parked: its Claude Code stopped after 2h00m quiet, to free memory\. Its task carries on, and it comes back by itself when one has news\./.test(w.pane()), { timeout: 5000 });
  assert.deepEqual(w.windows("falcon"), ["falcon"]);
  assert.notEqual(w.tmux("list-clients", "-t", "=sv-falcon"), "", "the terminal stays on it");
  assert.equal(w.tmux("show-options", "-wv", "-t", "=sv-falcon:=falcon", "@tab"), "falcon · parked");
  assert.match(w.falcon(["resume"]).stdout, /falcon .*\(parked while idle\) yoda chat header/);
  assert.equal(w.park(["--dry-run"]).stdout, "nothing to park\n", "parked once");

  // Enter in its tab: its conversation resumed there, first saying where its tasks stand.
  w.tmux("send-keys", "-t", "=sv-falcon:=falcon", "Enter");
  await until(() => w.claude.runs().length === 2, { timeout: 5000 });
  const back = w.claude.runs()[1];
  assert.deepEqual(back.argv.slice(0, 4), ["--resume", w.sup.id, "--settings", join(w.sb.home, "_supervisors/falcon/settings.json")]);
  assert.match(back.argv[4], /^\[rollcall\] Supervisor falcon is back: it was parked while idle, and the owner brought it back\. Run `rollcall task list`/);
  assert.equal(back.cwd, w.sb.main);
  assert.equal(existsSync(join(w.sb.home, "_supervisors/falcon/parked.json")), false, "back, it is no longer parked");
});

test("a parked supervisor's tab keeps its home, however long nothing happens there", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = await falconSupervisor(t);
  w.said(2 * 3600_000);
  assert.match(w.park([], { ROLLCALL_PARK_SUPERVISOR_MS: "1000" }).stdout, /^parked supervisor falcon/);
  const home = join(w.sb.home, "_supervisors/falcon");
  const old = (Date.now() - 8 * 86400_000) / 1000;
  const age = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) age(join(d, e.name)); utimesSync(join(d, e.name), old, old); }
    utimesSync(d, old, old);
  };
  await w.sup.crash(); // Parked: its Claude Code is gone, only the tab waits.
  age(home);
  w.sb.session(w.sb.main).start();
  assert.ok(existsSync(join(home, "parked.json")), "Enter in that tab still brings it back");
});

test("a parked supervisor comes back by itself for its tasks' news: resumed with the news as its prompt, or fresh once its conversation grew big", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  for (const big of [false, true]) {
    await t.test(big ? "fresh" : "resumed", async (t) => {
      const w = await falconSupervisor(t);
      assert.equal(w.sup.cli(["task", "new", "chat header", "--repo", w.sb.main, "--no-worktree"]).code, 0);
      if (big) assert.equal(w.sup.cli(["status", "--context", "52"]).code, 0);
      w.said(2 * 3600_000);
      assert.match(w.park().stdout, /^parked supervisor falcon/);
      await until(() => /falcon is parked/.test(w.pane()), { timeout: 5000 });
      await w.sup.crash(); // Parked: its Claude Code is gone.
      // The home's watcher runs on and hears the worker's reply at once.
      const watch = watcher(w, {}, "falcon");
      t.after(() => watch.proc.kill());
      assert.equal(w.sup.cli(["task", "note", "t1", "reply: the header is done"], { env: { ROLLCALL_TASK: "falcon:t1" } }).code, 0);
      await until(() => w.claude.runs().length === 2, { timeout: 5000 });
      const run = w.claude.runs()[1];
      const wakes = () => readdirSync(join(w.sb.home, "_supervisors/falcon/wake")).filter((n) => n.endsWith(".json"));
      if (!big) {
        assert.deepEqual(run.argv.slice(0, 2), ["--resume", w.sup.id]);
        assert.match(run.argv[4], /^\[rollcall\] Supervisor falcon was parked while idle, and news from its tasks brought it back\.\n\[rollcall\] supervisor falcon: news from your tasks\..*\n- yoda · chat header replies: "the header is done"/s);
        // The news went with that prompt, and the turn it starts acks it. bringBack marks it after the start returns.
        await until(() => wakes().map((n) => n[0]).join() === "d", { timeout: 5000 });
      } else {
        // A fresh supervisor reads its task records; the news, still queued, is typed once its first turn ends.
        assert.equal(run.argv[0], "--session-id");
        assert.notEqual(run.argv[1], w.sup.id);
        assert.deepEqual(run.argv.slice(4), ["-n", "falcon", "/supervisor falcon"]);
        assert.deepEqual(wakes().map((n) => n[0]), ["q"]);
      }
      assert.equal(existsSync(join(w.sb.home, "_supervisors/falcon/parked.json")), false);
    });
  }
});

test("news nothing stands behind any more does not bring a parked supervisor back", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = await falconSupervisor(t);
  assert.equal(w.sup.cli(["task", "new", "chat header", "--repo", w.sb.main, "--no-worktree"]).code, 0);
  w.said(2 * 3600_000);
  assert.match(w.park().stdout, /^parked supervisor falcon/);
  await until(() => /falcon is parked/.test(w.pane()), { timeout: 5000 });
  await w.sup.crash();
  // A worker that "stopped with nothing running" and has no worker left to be that: no line stands behind it.
  const wake = join(w.sb.home, "_supervisors/falcon/wake");
  mkdirSync(wake, { recursive: true });
  writeFileSync(join(wake, "q-1-1-stale.json"), JSON.stringify({ at: Date.now(), task: "t1", kind: "stuck" }));
  const run = watcher(w, {}, "falcon");
  t.after(() => run.proc.kill());
  await until(() => queue(w, "falcon").length === 0, { timeout: 5000 });
  assert.equal(w.claude.runs().length, 1, "no second session started");
  assert.ok(existsSync(join(w.sb.home, "_supervisors/falcon/parked.json")), "it stays parked");
});

test("news goes into a falcon supervisor only once its turn ended, never over an open picker, a draft or a key just pressed", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = await falconSupervisor(t);
  const typed = () => w.claude.prompts().filter((p) => /news from your tasks/.test(p));
  const box = (text) => { w.tmux("send-keys", "-t", "=sv-falcon:=falcon", "-l", text); w.tmux("send-keys", "-t", "=sv-falcon:=falcon", "Enter"); };
  assert.equal(w.sup.cli(["task", "new", "chat header", "--repo", w.sb.main, "--no-worktree"]).code, 0);
  // A turn runs, and the worker reports meanwhile.
  w.said(0);
  w.sup.prompt("how is the header?");
  assert.equal(w.sup.cli(["task", "note", "t1", "reply: the header is done"], { env: { ROLLCALL_TASK: "falcon:t1" } }).code, 0);
  const run = watcher(w, { ROLLCALL_KEY_QUIET_MS: "60000", ROLLCALL_SETTLE_MS: "1" }, "falcon");
  t.after(() => run.proc.kill());
  await sleep(500);
  assert.deepEqual(typed(), [], "its turn runs");

  // Its turn ends on a picker: the tool call still waits on the owner.
  w.said(0, { pending: true });
  w.sup.stop();
  await sleep(500);
  assert.deepEqual(typed(), [], "a picker is open");

  // No picker now, and words in the prompt box.
  box("box keep the icon");
  await until(() => /❯ keep the icon/.test(w.pane()), { timeout: 5000 });
  w.said(0);
  await sleep(500);
  assert.deepEqual(typed(), [], "the owner's draft stays theirs");

  // The box is empty, and the owner pressed a key just now.
  const term = await terminal(w, "falcon");
  box("box");
  await sleep(500);
  assert.deepEqual(typed(), [], "it waits for the key to go quiet");
  term.kill("SIGKILL");
  await until(() => typed().length === 1, { timeout: 5000 });
  assert.match(typed()[0], /yoda · chat header replies: "the header is done"/);

  // The prompt lands, its turn ends: the news is done with, and the owner's line carries none of it again.
  assert.equal(addedContext(w.sup.prompt(typed()[0])), null);
  w.sup.stop();
  assert.deepEqual(queue(w, "falcon"), []);
  assert.equal(typed().length, 1);
});

test("a typed prompt that reached no model goes out again, three times in all, then waits for the owner's next line", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = await falconSupervisor(t);
  const typed = () => w.claude.prompts().filter((p) => /news from your tasks/.test(p));
  assert.equal(w.sup.cli(["task", "new", "chat header", "--repo", w.sb.main, "--no-worktree"]).code, 0);
  w.said(0);
  w.sup.stop();
  assert.equal(w.sup.cli(["task", "note", "t1", "reply: the header is done"], { env: { ROLLCALL_TASK: "falcon:t1" } }).code, 0);
  const run = watcher(w, { ROLLCALL_KEY_QUIET_MS: "1", ROLLCALL_SETTLE_MS: "1", ROLLCALL_RECEIPT_MS: "100" }, "falcon");
  t.after(() => run.proc.kill());
  await until(() => notified(w).some((n) => n.title === "news waits (falcon)"), { timeout: 8000 });
  await sleep(300);
  assert.equal(typed().length, 3);
  assert.deepEqual(queue(w, "falcon"), ["q"], "still on disk");
  assert.match(addedContext(w.sup.prompt("anything?")), /replies: "the header is done"/);
  w.sup.stop();
  assert.deepEqual(queue(w, "falcon"), []);
});

test("news a supervisor took and never finished comes back: crashed, it resumes with that news once, and its session start adds none", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = await falconSupervisor(t);
  assert.equal(w.sup.cli(["task", "new", "chat header", "--repo", w.sb.main, "--no-worktree"]).code, 0);
  assert.equal(w.sup.cli(["task", "note", "t1", "reply: the header is done"], { env: { ROLLCALL_TASK: "falcon:t1" } }).code, 0);
  w.said(60_000);
  assert.match(addedContext(w.sup.prompt("what now?")), /replies: "the header is done"/);
  assert.deepEqual(queue(w, "falcon"), ["d"]);
  // It dies mid-turn: no Stop, no goodbye, nothing left in its window.
  await w.sup.crash();
  process.kill(w.claude.runs()[0].pid, "SIGKILL");
  const run = watcher(w, {}, "falcon");
  t.after(() => run.proc.kill());
  await until(() => w.claude.runs().length === 2, { timeout: 5000 });
  const back = w.claude.runs()[1];
  assert.deepEqual(back.argv.slice(0, 2), ["--resume", w.sup.id]);
  assert.match(back.argv[4], /^\[rollcall\] Supervisor falcon stopped without warning, and news from its tasks brought it back\.\n.*replies: "the header is done"/s);
  await until(() => queue(w, "falcon").join() === "d", { timeout: 5000 });
  await run.stop();

  // Its hooks in the resumed session: the news went with the prompt, and only there.
  const again = w.sb.session(w.sb.main, { id: w.sup.id });
  assert.doesNotMatch(again.start("resume").context ?? "", /the header is done/);
  assert.doesNotMatch(addedContext(again.prompt(back.argv[4])) ?? "", /the header is done/);
  again.stop();
  assert.deepEqual(queue(w, "falcon"), []);
});

test("a supervisor past its context mark hands over to a fresh session under an open picker, whose question is asked again", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = await falconSupervisor(t);
  assert.equal(w.sup.cli(["task", "new", "chat header", "--repo", w.sb.main, "--no-worktree"]).code, 0);
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "needs-you", "--question", "Ship it?"], { env: { ROLLCALL_TASK: "falcon:t1" } }).code, 0);
  assert.match(addedContext(w.sup.prompt("what now?")), /needs you: "Ship it\?"/);
  w.said(0, { pending: true });
  assert.equal(w.sup.cli(["status", "--context", "40"]).code, 0);
  const run = watcher(w, { ROLLCALL_HAND_OVER_QUIET_MS: "1", ROLLCALL_RECEIPT_MS: "100" }, "falcon");
  t.after(() => run.proc.kill());
  await until(() => w.claude.runs().length === 2, { timeout: 5000 });
  const fresh = w.claude.runs()[1];
  assert.equal(fresh.argv[0], "--session-id");
  assert.notEqual(fresh.argv[1], w.sup.id);
  assert.deepEqual(fresh.argv.slice(4), ["-n", "falcon", "/supervisor falcon"]);
  assert.match(feed(w, "falcon").at(-1), /^Supervisor falcon reached 40% of its context, so a fresh session took over/);
  await until(() => queue(w, "falcon").join() === "q", { timeout: 5000 });
  assert.deepEqual(kinds(w, "falcon"), ["needs-you"], "the new session opens the picker again");
});

test("a supervisor under its mark, or with the owner at its keys, stays", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = await falconSupervisor(t);
  assert.equal(w.sup.cli(["task", "new", "chat header", "--repo", w.sb.main, "--no-worktree"]).code, 0);
  w.said(0);
  w.sup.stop();
  assert.equal(w.sup.cli(["status", "--context", "20"]).code, 0);
  look(w, { ROLLCALL_HAND_OVER_QUIET_MS: "1", ROLLCALL_SETTLE_MS: "1" }, "falcon");
  assert.equal(w.claude.runs().length, 1, "under its mark");
  assert.equal(w.sup.cli(["status", "--context", "40"]).code, 0);
  await terminal(w, "falcon");
  look(w, { ROLLCALL_HAND_OVER_QUIET_MS: "60000", ROLLCALL_SETTLE_MS: "1" }, "falcon");
  assert.equal(w.claude.runs().length, 1, "the owner just used it");
});

test("a worker's handoff gets its fresh worker while the supervisor's picker stays open", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = await falconSupervisor(t);
  assert.equal(w.sup.cli(["task", "new", "chat header", "--repo", w.sb.main, "--no-worktree", "--words", "fix the header"]).code, 0);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.runs().length === 2, { timeout: 5000 });
  await until(() => JSON.parse(w.sup.cli(["task", "show", "t1", "--json"]).stdout).worker?.alive, { timeout: 5000 });
  // The supervisor's turn stays open on a picker, for as long as the owner likes.
  w.said(0, { pending: true });
  write(join(w.sb.root, "handoff.md"), "Half done.\n");
  assert.equal(w.sup.cli(["task", "handoff", "t1", "--file", join(w.sb.root, "handoff.md")], { env: { ROLLCALL_TASK: "falcon:t1" } }).code, 0);
  look(w, {}, "falcon");
  assert.equal(w.claude.runs().length, 3);
  assert.match(w.claude.runs()[2].argv.at(-1), /Its handoff, written for you[^\n]*:\n\nHalf done\./);
  assert.ok(!w.claude.prompts().some((p) => /news from your tasks/.test(p)), "nothing typed under the picker");
  assert.equal(feed(w, "falcon").at(-1), "yoda · chat header: its worker handed off; a fresh worker carries on.");
});

test("falcon starts the first free supervisor, falcon, in a window of its own in the folder it ran from, its tab drawn; the next takes venator", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = falconWorld(t);
  const r = w.falcon([]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "falcon: falcon is ready in tmux session sv-falcon\n");
  const f = w.homeFile("falcon", "falcon.json");
  assert.equal(f.cwd, w.sb.main);
  assert.ok(existsSync(join(w.sb.home, "_supervisors/falcon/supervisor.sh")));
  await until(() => w.claude.runs().length === 1);
  const supSettings = join(w.sb.home, "_supervisors/falcon/settings.json");
  assert.deepEqual(w.claude.runs()[0].argv, ["--session-id", f.session, "--settings", supSettings, "-n", "falcon", "/supervisor falcon"]);
  // A supervisor edits nothing and drives no browser; its tabs redraw on its workers' events, its status line every 30 s.
  const lean = JSON.parse(readFileSync(supSettings, "utf8"));
  assert.deepEqual(lean.enabledPlugins, { "playwright@claude-plugins-official": false, "chrome-devtools-mcp@claude-plugins-official": false });
  assert.equal(lean.statusLine.refreshInterval, 30);
  assert.equal(lean.awaySummaryEnabled, false, "no recap when the owner comes back: the tabs say where things stand");
  assert.match(lean.statusLine.command, /rollcall\.mjs' statusline$/);
  assert.equal(lean.hooks, undefined);
  assert.equal(w.claude.runs()[0].cwd, w.sb.main);
  assert.equal(w.tmux("list-windows", "-t", "=sv-falcon", "-F", "#{@tab_back}|#{window_name}|#{@tab}|#{@tab_style}"), "◀ |falcon|falcon|bold");
  assert.deepEqual(["@falcon_dress", "mouse", "status-left"].map((o) => w.tmux("show-options", "-gv", o)), ["2", "on", ""]);
  assert.match(w.tmux("show-options", "-gv", "window-status-format"), /#\{@tab_back\}#\{\?@tab,#\{@tab\},#W\}/);

  const next = w.falcon([], { cwd: w.sb.root });
  assert.equal(next.stdout, "falcon: venator is ready in tmux session sv-venator\n");
  await until(() => w.claude.runs().length === 2);
  assert.deepEqual(w.claude.runs()[1].argv.slice(2), ["--settings", join(w.sb.home, "_supervisors/venator/settings.json"), "-n", "venator", "/supervisor venator"]);
  assert.equal(w.claude.runs()[1].cwd, w.sb.root);
});

test("falcon continue opens the supervisor used last: its window while it runs, else its conversation resumed where it ran, else a fresh one", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = falconWorld(t);
  const work = join(w.sb.root, "work");
  mkdirSync(work);
  assert.equal(w.falcon([]).code, 0);
  assert.equal(w.falcon([], { cwd: work }).code, 0);
  await until(() => w.claude.runs().length === 2);
  const pane = () => w.tmux("display", "-p", "-t", "=sv-venator:=venator", "#{pane_pid}");
  const before = pane();
  assert.equal(w.falcon(["continue"]).stdout, "falcon: venator is ready in tmux session sv-venator\n", "venator is the newer one");
  assert.equal(pane(), before, "a running supervisor is shown as it is");
  assert.equal(w.claude.runs().length, 2);

  // Quit with a transcript saved: it resumes in the folder it ran in, first of its home's windows.
  w.tmux("new-window", "-d", "-t", "=sv-venator:", "-n", "t1", "sleep 600");
  const id = w.homeFile("venator", "falcon.json").session;
  await quit(w, "venator");
  const saved = w.transcript(work, id);
  assert.equal(w.falcon(["--continue"]).code, 0);
  await until(() => w.claude.runs().length === 3);
  assert.deepEqual(w.claude.runs()[2].argv, ["--resume", id, "--settings", join(w.sb.home, "_supervisors/venator/settings.json")]);
  assert.equal(w.claude.runs()[2].cwd, work);
  assert.deepEqual(w.windows("venator"), ["venator", "t1"]);

  // No transcript: a fresh conversation, a new session id.
  await quit(w, "venator");
  rmSync(saved);
  assert.equal(w.falcon(["continue"]).code, 0);
  await until(() => w.claude.runs().length === 4);
  const fresh = w.claude.runs()[3];
  assert.equal(fresh.argv[0], "--session-id");
  assert.notEqual(fresh.argv[1], id);
  assert.deepEqual(fresh.argv.slice(4), ["-n", "venator", "/supervisor venator"]);
  assert.equal(fresh.cwd, work);
  assert.equal(w.homeFile("venator", "falcon.json").session, fresh.argv[1]);

  // A transcript whose folder is gone cannot be resumed: a fresh one, in falcon's folder.
  await quit(w, "venator");
  w.transcript(work, fresh.argv[1]);
  rmSync(work, { recursive: true });
  assert.equal(w.falcon(["continue"]).code, 0);
  await until(() => w.claude.runs().length === 5);
  assert.equal(w.claude.runs()[4].argv[0], "--session-id");
  assert.notEqual(w.claude.runs()[4].argv[1], fresh.argv[1]);
  assert.equal(w.claude.runs()[4].cwd, w.sb.main);
});

test("falcon leaves a supervisor open in another terminal alone, and resumes its conversation once that one quits", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = falconWorld(t);
  const other = w.sb.session(w.sb.root);
  other.start();
  assert.match(other.cli(["supervise", "falcon"]).stdout, /runs `falcon resume falcon` in a terminal tab/);
  for (const [args, again] of [[["continue"], "falcon continue"], [["resume", "falcon"], "falcon resume falcon"]]) {
    const r = w.falcon(args);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, `falcon: falcon is open in another terminal (session ${other.short}). Quit it there with /exit, then run ${again} again.\n`);
  }
  assert.equal(w.windows("falcon").length, 0);

  // Its transcript, from rollcall's record of the session, says where it ran.
  await other.crash();
  write(join(w.sb.root, "transcripts", `${other.id}.jsonl`), `${JSON.stringify({ type: "user", cwd: w.sb.main })}\n`);
  const r = w.falcon(["resume", "falcon"], { cwd: w.sb.root });
  assert.equal(r.code, 0, r.stderr);
  await until(() => w.claude.runs().length === 1);
  assert.deepEqual(w.claude.runs()[0].argv, ["--resume", other.id, "--settings", join(w.sb.home, "_supervisors/falcon/settings.json")]);
  assert.equal(w.claude.runs()[0].cwd, w.sb.main);
});

test("falcon resume opens the supervisor named and lists them without a terminal; unknown names, bad arguments and another tmux are refused", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = falconWorld(t);
  assert.match(w.falcon(["continue"]).stderr, /^falcon: no supervisor yet: run falcon to start one/);
  const bogus = w.falcon(["bogus"]);
  assert.equal(bogus.code, 1);
  assert.match(bogus.stderr, /^falcon: unknown command "bogus"/);
  assert.equal(w.falcon(["continue", "falcon"]).code, 1);
  const help = w.falcon(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /falcon continue +go back into the supervisor you used last/);
  const nested = w.falcon([], { env: { TMUX: `/tmp/tmux-${process.getuid()}/default,123,0` } });
  assert.equal(nested.code, 1);
  assert.match(nested.stderr, /already inside tmux/);
  assert.ok(!existsSync(join(w.sb.home, "_supervisors/falcon")), "refused before it took a name");

  assert.equal(w.falcon([]).code, 0);
  await until(() => w.claude.runs().length === 1);
  const list = w.falcon(["resume"]);
  assert.equal(list.code, 1);
  assert.match(list.stdout, /^Supervisors, newest first:\n   1  falcon  .+\(open here\) no open tasks\n$/);
  assert.match(list.stderr, /pick one by name: falcon resume <name>/);
  const unknown = w.falcon(["resume", "nobody"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /no supervisor named nobody\. falcon resume lists them/);
  assert.equal(w.falcon(["resume", "falcon"]).stdout, "falcon: falcon is ready in tmux session sv-falcon\n");
  assert.equal(w.claude.runs().length, 1);
});

test("when the supervisor's Claude Code quits, its window closes and only the terminals showing it detach; workers stay", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = falconWorld(t);
  assert.equal(w.falcon([]).code, 0);
  await until(() => w.claude.runs().length === 1);
  w.tmux("new-window", "-d", "-t", "=sv-falcon:", "-n", "t1", "sleep 600");
  await terminal(w, "falcon");
  const showing = () => w.tmux("list-clients", "-t", "=sv-falcon", "-F", "#{window_name}");
  // The owner clicked t1's tab: that terminal stays on the worker.
  w.tmux("select-window", "-t", "=sv-falcon:=t1");
  await quit(w, "falcon");
  assert.deepEqual(w.windows("falcon"), ["t1"]);
  assert.equal(showing(), "t1");

  // Back on the supervisor, the terminal goes back to its own prompt when it quits.
  assert.equal(w.falcon(["continue"]).code, 0);
  await until(() => w.claude.runs().length === 2);
  assert.equal(showing(), "falcon");
  await quit(w, "falcon");
  await until(() => showing() === "");
  assert.deepEqual(w.windows("falcon"), ["t1"]);
});

test("a worker runs on the harness's model and effort, not on what /model last saved; its task's own win, and a resumed worker keeps them", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  // kesselrunner's state names the owner's overlay, whose settings name the model (HOME is the sandbox).
  write(join(w.sb.root, ".claude/.kesselrunner/state.json"), JSON.stringify({ overlay: join(w.sb.root, "overlay") }));
  write(join(w.sb.root, "overlay/settings.json"), JSON.stringify({ model: "opus[1m]", effortLevel: "high" }));
  write(join(w.sb.root, ".claude/settings.json"), JSON.stringify({ model: "fable" }));
  const r = w.start(["t1"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /started \(t1-chat-header\) in .*chat-header, opus\[1m\], high effort\n/);
  await until(() => w.claude.prompts().length === 1);
  const argv = w.claude.runs()[0].argv;
  assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 4), ["--model", "opus[1m]", "--effort", "high"]);
  // Stopped, then the owner's words bring it back on the same model.
  process.kill(w.claude.runs()[0].pid, "SIGKILL");
  await until(() => w.task().worker && !w.task().worker.alive, { timeout: 5000 });
  assert.equal(routed(w.sup.prompt("@t1 carry on")), "→ yoda · chat header: its worker had stopped; it resumes with your words as its prompt");
  await until(() => w.claude.runs().length === 2, { timeout: 5000 });
  assert.ok(w.claude.runs()[1].argv.join(" ").includes("--model opus[1m] --effort high"));
  // A task made for another model runs on it.
  assert.equal(w.sup.cli(["task", "new", "quick fix", "--repo", w.sb.main, "--model", "sonnet", "--effort", "low"]).code, 0);
  assert.equal(w.start(["t2"]).code, 0);
  await until(() => w.claude.runs().length === 3, { timeout: 5000 });
  assert.ok(w.claude.runs()[2].argv.join(" ").includes("--model sonnet --effort low"));
});

test("the brief: owner files outside the worktree, the header's budget, the owner's words stamped in local time, every finish with a report", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.sup.cli(["task", "words", "t1", "and keep the icon"]).code, 0);
  const brief = w.start(["t1", "--dry-run"]).stdout;
  const files = join(w.sb.home, "_supervisors/alpha/files/t1");
  assert.ok(existsSync(files), "its files folder exists before the worker needs it");
  assert.ok(brief.includes(`goes in ${files}, never in the worktree`));
  assert.match(brief, /\(Ship, Scope, Design\), 7 characters at most: the picker puts this task's name in front of it/);
  assert.match(brief, /^\[\d{4}-\d\d-\d\d \d\d:\d\d [A-Z]{2,5}[+\-\d:]*\]\nmake the header professional$/m);
  assert.match(brief, /finished: first save your report with `.*task output t1 --file <file>`.*Then `.*task set t1 --state landed` once the ship is done/);
  assert.doesNotMatch(brief, /--pr <url>|When an answer arrives/, "rollcall sets these itself, so the brief leaves them out");
  assert.match(brief, /question with no options to pick from.*`.*task set t1 --state needs-you --question "<the question, one sentence>"`/, "a whole command line, nothing to probe for");
  assert.match(brief, /Look at a web page through \/frontend-test and an iOS screen through \/ios-sim/);
  assert.match(brief, /with the screenshots in .*files\/t1: they judge how it looks/);
  assert.match(brief, /hands its result back before its context passes about 35%/);
});

test("a report goes to the supervisor as a path and a line, once, and to the owner with the finish; a finish without one says so", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const worker = { env: { ROLLCALL_TASK: "alpha:t1" } };
  assert.equal(w.sup.cli(["task", "output", "t1", "Three options; I pick B.\nOption A costs more."], worker).code, 0);
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "needs-you", "--question", "A, B or C?"], worker).code, 0);
  const report = join(w.sb.home, "_supervisors/alpha/files/t1/task-report.md");
  const heard = news(w);
  assert.ok(heard.includes(`yoda · chat header needs you: "A, B or C?"`));
  assert.ok(heard.includes(`Its report: \`${report}\``), heard);
  assert.match(heard, /: "Three options; I pick B\."\. Give the owner that path and line first, not the text/);
  assert.doesNotMatch(heard, /Option A costs more/, "the path and a line, never the text");
  assert.match(readFileSync(report, "utf8"), /Option A costs more/);

  // A later report says what moved.
  assert.equal(w.sup.cli(["task", "output", "t1", "Three options; I pick C.\nOption A costs more.\nOption C ships today."], worker).code, 0);
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "working"], worker).code, 0);
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "needs-you", "--question", "C then?"], worker).code, 0);
  assert.match(news(w), /\(since the last one: \+2 -1 lines\): "Three options; I pick C\."/);

  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "closed"], worker).code, 0);
  look(w);
  assert.equal(feed(w).at(-1), "yoda · chat header: closed. Three options; I pick C.");
  assert.doesNotMatch(news(w), /Three options/, "the finish is a plain fact: no model turn");
  // rollcall lands a task whose worker left without a report: the line says so.
  assert.equal(w.sup.cli(["task", "new", "footer", "--repo", w.sb.main]).code, 0);
  assert.equal(w.sup.cli(["task", "set", "t2", "--state", "landed"]).code, 0);
  write(join(w.sb.home, "_supervisors/alpha/wake/q-9-landed.json"), JSON.stringify({ task: "t2", kind: "landed", at: Date.now() }));
  look(w);
  assert.equal(feed(w).at(-1), "leia · footer: landed. It saved no report.");
});

test("a child made ahead of its parent's last commits hears of them at its first start", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.sup.cli(["task", "new", "footer", "--repo", w.sb.main, "--after", "t1", "--base", "t1"]).code, 0);
  assert.doesNotMatch(w.start(["t2", "--dry-run"]).stdout, /has moved on/);
  write(join(w.wt, "src/part1.js"), "part 1\n");
  spawnSync("git", ["-C", w.wt, "add", "."]);
  spawnSync("git", ["-C", w.wt, "commit", "-qm", "part 1"]);
  const { branch } = w.task();
  assert.ok(w.start(["t2", "--dry-run"]).stdout.includes(`${branch} has moved on 1 commit since this worktree was made: run \`git merge ${branch}\` first.`));
});

test("a discussion turned build re-briefs its worker; the owner's line to the supervisor is relayed to a worker word for word, all of it or a part", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.sup.cli(["task", "set", "t1", "--kind", "discuss"]).code, 0);
  assert.match(w.start(["t1", "--dry-run"]).stdout, /first run `.*task set t1 --kind build` and read your brief again/);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  assert.equal(w.sup.cli(["task", "set", "t1", "--kind", "build"]).code, 0);
  // The message tells it to read its brief again, with its worker running: that prints, and starts nothing.
  const again = w.start(["t1", "--dry-run"]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /the build and ship phases|Working with the owner/);
  assert.equal(w.task().sessions.length, 1);
  await until(() => w.claude.prompts().some((x) => /The supervisor left you a message/.test(x)), { timeout: 5000 });
  assert.match(w.sup.cli(["inbox"], { env: { ROLLCALL_TASK: "alpha:t1" } }).stdout, /Task t1 is now a build: .*start\.mjs t1 --dry-run` prints your brief as it now stands/);
  assert.equal(w.task().kind, "build");
  assert.match(w.sup.cli(["task", "set", "t1", "--kind", "chat"]).stderr, /--kind is one of build, discuss/);

  // The owner gives the supervisor a go-ahead meant for the worker; the supervisor relays that very line.
  assert.match(w.sup.cli(["task", "relay", "t1"]).stderr, /no line from the owner to this supervisor in the last 30 minutes/);
  assert.equal(w.sup.prompt("ship yoda without me needing to confirm").json, null, "a plain line is the supervisor's");
  const sent = w.sup.cli(["task", "relay", "yoda"]);
  assert.equal(sent.code, 0, sent.stderr);
  assert.match(sent.stdout, /^t1: the owner's words were typed into its worker: "ship yoda without me needing to confirm"/);
  await until(() => w.claude.prompts().includes("ship yoda without me needing to confirm"), { timeout: 5000 });
  assert.equal(w.task().words.at(-1).text, "ship yoda without me needing to confirm");
  assert.match(w.sup.cli(["task", "relay", "t1"], { env: { ROLLCALL_TASK: "alpha:t1" } }).stderr, /task relay is the supervisor's/);

  // A line for several tasks: with `-`, the part for this one, and only the owner's own words.
  w.sup.prompt("merge it, and leia can wait");
  const part = w.sup.cli(["task", "relay", "t1", "-"], { input: "merge it" });
  assert.equal(part.code, 0, part.stderr);
  await until(() => w.claude.prompts().includes("merge it"), { timeout: 5000 });
  const made = w.sup.cli(["task", "relay", "t1", "-"], { input: "merge everything" });
  assert.equal(made.code, 1);
  assert.match(made.stderr, /task relay types the owner's own words only: that text is not part of their last line/);
});

test("an Artifact's live updates are no background work: the worker counts as running nothing", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  await until(() => /worker \w+ idle/.test(w.sup.cli(["task", "list"]).stdout));
  const sid = w.task().sessions[0].id;
  const stop = (payload) => spawnSync(process.execPath, [BIN, "worker-hook", "alpha", "t1", "stop"], { input: JSON.stringify({ session_id: sid, ...payload }), env: w.sup.env, encoding: "utf8" });
  stop({ background_tasks: [{ id: "b1", type: "artifact_subscription", status: "running", description: "live updates for artifact https://claude.ai/artifact/abc (Hero options)" }] });
  assert.match(w.sup.cli(["task", "list"]).stdout, /nothing running/);
  stop({ background_tasks: [{ id: "b2", type: "local_bash", status: "running", description: "Watch PR checks" }, { id: "b3", type: "other", status: "running", description: "live updates for artifact https://claude.ai/artifact/abc" }] });
  assert.match(w.sup.cli(["task", "list"]).stdout, /waiting on Watch PR checks(?!;)/);
});

test("while a task ships the Mac stays awake on AC, and on battery the owner hears once that a sleep stalls it", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const bin = join(w.sb.root, "awake-bin");
  const power = join(w.sb.root, "power");
  const held = join(w.sb.root, "caffeinate.log");
  const facts = join(w.sb.root, "facts.json");
  write(power, "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charging\n");
  write(facts, JSON.stringify({ power: { on: "ac" } }));
  write(join(bin, "pmset"), `#!/bin/sh\ncat ${JSON.stringify(power)}\n`);
  write(join(bin, "caffeinate"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(held)}\n`);
  for (const f of ["pmset", "caffeinate"]) chmodSync(join(bin, f), 0o755);
  const env = { ROLLCALL_AWAKE: "1", ROLLCALL_PMSET: join(bin, "pmset"), ROLLCALL_CAFFEINATE: join(bin, "caffeinate"), ROLLCALL_MACHINE_FACTS: facts, ROLLCALL_TROUBLE_LOOK_MS: "1" };
  look(w, env);
  assert.ok(!existsSync(held), "nothing ships: the Mac may sleep");
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "pr-open", "--pr", "https://github.com/o/r/pull/9"]).code, 0);
  look(w, env);
  await until(() => existsSync(held), { timeout: 5000 });
  assert.equal(readFileSync(held, "utf8").trim(), "-i -t 300");
  // On battery: one notification, however many look, and no hold.
  write(power, "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t25%; discharging\n");
  write(facts, JSON.stringify({ power: { on: "battery", pct: 25 } }));
  writeFileSync(join(w.sb.home, "_supervisors/alpha/awake.json"), "{}");
  look(w, env);
  await sleep(5);
  look(w, env);
  const notes = notified(w).filter((n) => n.title === "rollcall: power");
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /The Mac is on battery at 25% with a ship running: a sleep stalls it until it wakes\. Plug it in/);
  assert.equal(readFileSync(held, "utf8").trim().split("\n").length, 1, "no hold on battery");
  // Plugged in, the blocker closes.
  write(facts, JSON.stringify({ power: { on: "ac" } }));
  await sleep(5);
  look(w, env);
  assert.deepEqual(JSON.parse(readFileSync(join(w.sb.home, "_machine/trouble.json"), "utf8")).open, {});
});

const trouble = (w) => JSON.parse(readFileSync(join(w.sb.home, "_machine/trouble.json"), "utf8"));
const setTrouble = (w, fn) => { const x = trouble(w); fn(x); writeFileSync(join(w.sb.home, "_machine/trouble.json"), JSON.stringify(x)); };
const LIMITS = { ROLLCALL_TROUBLE_LOOK_MS: "1", ROLLCALL_LIMIT_GRACE_MS: "1", ROLLCALL_STUCK_MS: "1" };
const LIMIT = (when) => `You've hit your session limit · resets ${when} (America/Los_Angeles)`;
const tomorrowish = () => new Date(Date.now() + 5 * 3600_000).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }).replace(/\s/g, "").toLowerCase();

test("a usage limit stops two workers: one notice, tabs that say paused, no stuck news; both come back after the reset, the one behind the dialog too", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.sup.cli(["task", "new", "chat footer", "--repo", w.sb.main]).code, 0);
  for (const id of ["t1", "t2"]) assert.equal(w.start([id]).code, 0);
  await until(() => w.claude.runs().length === 2 && w.claude.prompts().length >= 2, { timeout: 10_000 });
  const type = (win, text) => { w.tmux("send-keys", "-t", `=sv-alpha:=${win}`, "-l", text); w.tmux("send-keys", "-t", `=sv-alpha:=${win}`, "Enter"); };
  const line = LIMIT(tomorrowish());
  type("t1", `limit ${line}`);
  type("t2", `limit-dialog ${line}`);
  const wait = (id) => JSON.parse(w.sup.cli(["task", "show", id, "--json"]).stdout).wait;
  await until(() => wait("t1")?.on === "usage" && wait("t2")?.on === "usage", { timeout: 10_000 });
  assert.ok(trouble(w).open.usage.until > Date.now(), "the reset time came from the limit's own line");
  for (let i = 0; i < 2; i++) { look(w, LIMITS); await sleep(5); }
  const notes = notified(w).filter((n) => n.title === "rollcall: the usage limit");
  assert.equal(notes.length, 1, "one notice for two workers");
  assert.match(notes[0].text, /rollcall resumes them after /);
  assert.match(w.sup.cli(["task", "list"]).stdout, /paused until \d{1,2}:\d\d [AP]M/);
  assert.ok(!kinds(w).includes("stuck"), "paused is not stuck");
  assert.equal(JSON.parse(w.sup.cli(["task", "show", "t1", "--json"]).stdout).worker?.busy ?? false, false, "no Stop ran, and it does not read as busy");

  const runs = w.claude.runs().length;
  setTrouble(w, (x) => { x.open.usage.until = Date.now() - 1000; });
  look(w, LIMITS);
  await until(() => w.claude.runs().length === runs + 2, { timeout: 10_000 });
  assert.deepEqual(w.claude.runs().slice(-2).map((r) => r.argv.includes("--resume")), [true, true], "each resumes its conversation");
  await until(() => w.claude.prompts().filter((p) => /The usage limit that stopped you is over/.test(p)).length === 2, { timeout: 10_000 });
  assert.equal(trouble(w).open.usage, undefined);
  await until(() => !wait("t1") && !wait("t2"), { timeout: 5000 });
});

test("a worker Claude Code continued itself after the limit ends its own wait; any other API error is no limit", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  inWorker(w, `limit ${LIMIT(tomorrowish())}`);
  await until(() => w.task().wait?.on === "usage", { timeout: 5000 });
  const runs = w.claude.runs().length;
  inWorker(w, "wakeup Your claude.ai usage limit has reset. Continue the task.");
  await until(() => !w.task().wait, { timeout: 5000 });
  assert.equal(w.claude.runs().length, runs, "no restart needed");
  // Not a limit: the worker is idle, nothing opens, and it is news when it stays stopped.
  setTrouble(w, (x) => { delete x.open.usage; });
  inWorker(w, "error");
  await until(() => statusLog(w).at(-1).failed === "server_error", { timeout: 5000 });
  assert.equal(w.task().wait ?? null, null);
  assert.equal(trouble(w).open.usage, undefined);
  look(w, { ROLLCALL_STUCK_MS: "1" });
  assert.ok(kinds(w).includes("stuck"));
});

test("a named check runs while the worker parks and brings it back when it passes; a background queue wait does not keep it up", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  await until(() => w.task().worker?.alive && !w.task().worker.busy, { timeout: 5000 });
  const sid = w.task().sessions[0].id;
  const flag = join(w.sb.root, "railway-is-up");
  const env = { ROLLCALL_PARK_AFTER_MS: "1", ROLLCALL_CHECK_EVERY_MS: "1", ROLLCALL_STUCK_MS: "1" };
  assert.equal(w.sup.cli(["task", "wait-for", "t1", `test -f ${JSON.stringify(flag)}`], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  stopHook(w, "t1", sid, { background_tasks: [{ id: "b1", type: "local_bash", status: "running", description: "merge queue", command: "rollcall queue wait" }] });
  await sleep(5);
  look(w, env);
  assert.equal(w.task().state, "working");
  await until(() => !w.task().worker?.alive, { timeout: 5000 });
  assert.ok(!kinds(w).includes("stuck"), "a worker waiting on a check is not stuck");
  look(w, env);
  assert.equal(w.task().worker?.alive ?? false, false, "a failed check leaves it parked");
  write(flag, "");
  await sleep(5);
  look(w, env);
  await until(() => w.claude.prompts().some((p) => /Your check passed: `test -f/.test(p)), { timeout: 5000 });
  assert.equal(w.claude.runs().at(-1).argv.includes("--resume"), true);
  await until(() => !w.task().wait, { timeout: 5000 });
});

test("a live worker that waits on a blocker hears when it clears, typed into its prompt; a full disk puts a stopped worker on that wait", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.claude.prompts().length === 1);
  await until(() => w.task().worker?.alive && !w.task().worker.busy, { timeout: 5000 });
  const sid = w.task().sessions[0].id;
  const facts = join(w.sb.root, "facts.json");
  const env = { ROLLCALL_MACHINE_FACTS: facts, ROLLCALL_TROUBLE_LOOK_MS: "1", ROLLCALL_PARK: "0", ROLLCALL_STUCK_MS: "1" };
  write(facts, JSON.stringify({ diskGb: 1 }));
  look(w, env);
  assert.equal(trouble(w).open.disk.full, true);
  await sleep(10);
  stopHook(w, "t1", sid, { background_tasks: [], last_assistant_message: "ENOSPC: no space left on device" });
  look(w, { ...env, ROLLCALL_STUCK_MS: "600000" });
  await until(() => w.task().wait?.on === "disk", { timeout: 5000 });
  assert.match(w.sup.cli(["task", "list"]).stdout, /waits on disk space/);
  await sleep(5);
  look(w, env);
  assert.ok(!kinds(w).includes("stuck"));
  write(facts, JSON.stringify({ diskGb: 40 }));
  await sleep(5);
  look(w, env);
  await until(() => w.claude.prompts().some((p) => /The disk has room again\. Carry on where you left off/.test(p)), { timeout: 10_000 });
  await until(() => !w.task().wait, { timeout: 5000 });
  assert.equal(trouble(w).open.disk, undefined);
});

// ---------------------------------------------------------------- the front-end interface, end to end
// A scripted front end (`rollcall api ...`, as the cockpit app runs it) beside the terminal Falcon: both show the
// same tasks, the same answered question and the same news, and the first answer to a question wins.

/** The owner's environment, as an app on their Mac has it: no agent session, no task. */
const ownerEnv = (w, env = {}) => ({ ...w.sb.env, KESSELRUNNER_CLAUDE_BIN: w.claude.bin, ...env });
/** `rollcall api <args>` from a front end: its JSON. */
function api(w, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, "api", ...args], { cwd: w.sb.root, encoding: "utf8", env: ownerEnv(w, env), timeout: 60_000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}
/** `rollcall api do <name>` from the cockpit app. */
const act = (w, name, payload, env = {}) => api(w, ["do", name, JSON.stringify({ client: "cockpit", ...payload })], env);
/** A front end's stream, running: its lines so far, of(type), and end() (the front end stops it, SIGTERM). */
function apiStream(w, args = ["--client", "cockpit", "--notifies"], env = {}) {
  const p = spawn(process.execPath, [BIN, "api", "stream", ...args], { cwd: w.sb.root, env: ownerEnv(w, { ROLLCALL_API_BEAT_MS: "200", ...env }), stdio: ["ignore", "pipe", "ignore"] });
  w.terminals.push(p);
  const lines = [];
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      try { lines.push(JSON.parse(buf.slice(0, i))); } catch {}
      buf = buf.slice(i + 1);
    }
  });
  const done = new Promise((res) => p.on("exit", (code) => res(code)));
  return { proc: p, lines, of: (type, ref) => lines.filter((l) => l.type === type && (!ref || l.ref === ref)), end: () => { p.kill("SIGTERM"); return done; } };
}
/** A fake gh that says every PR merged into main, on PATH and as ROLLCALL_GH. */
function mergedGh(w) {
  const bin = join(w.sb.root, "bin");
  write(join(bin, "gh"), `#!/bin/sh\necho '{"state":"MERGED","baseRefName":"main"}'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return { PATH: `${bin}:${w.sup.env.PATH ?? process.env.PATH}`, ROLLCALL_GH: join(bin, "gh"), ROLLCALL_PR_CHECK_MS: "1" };
}
const showTask = (w, id) => JSON.parse(w.sup.cli(["task", "show", id, "--json"]).stdout);

test("a scripted front end beside the Falcon starts a task, answers its question, tells it, attaches to it and sees it land, and the Falcon shows the same; its notices replace rollcall's own while it runs", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  // This stand-in Claude Code speaks only the terminal: a front end following rollcall would start workers in the chat
  // view (claude-worker.test.mjs covers that), so this one keeps them in the terminal, where the Falcon shows them.
  const was = process.env.ROLLCALL_WORKER_VIEW;
  process.env.ROLLCALL_WORKER_VIEW = "terminal";
  t.after(() => { if (was === undefined) delete process.env.ROLLCALL_WORKER_VIEW; else process.env.ROLLCALL_WORKER_VIEW = was; });
  const w = world(t);
  for (const x of Object.values(w)) if (x && typeof x === "object" && x.env && typeof x.env === "object") x.env.ROLLCALL_WORKER_VIEW = "terminal";
  const gh = mergedGh(w);
  const s = apiStream(w, undefined, gh);
  await until(() => s.of("snapshot").length === 1, { timeout: 20_000 });
  const first = s.of("snapshot")[0].snapshot;
  assert.deepEqual(first.supervisors.map((x) => x.name), ["alpha"]);
  assert.deepEqual(first.tasks.map((x) => x.ref), ["alpha:t1"]);
  assert.deepEqual(first.clients.map((c) => [c.client, c.notifies]), [["cockpit", true]], "the stream registers its front end");

  // It starts a task: rollcall's own `task new` and start.mjs, in the supervisor's permission mode.
  const made = act(w, "task.start", { home: "alpha", title: "page footer", words: "make the footer match the header", repo: w.sb.main });
  assert.equal(made.code, 0, made.stdout + made.stderr);
  assert.equal(made.json.result.task, "alpha:t2");
  assert.equal(made.json.result.started, true, made.json.result.message);
  await until(() => w.claude.prompts().length === 1, { timeout: 20_000 });
  assert.match(w.claude.prompts()[0], /^You are the worker for task t2 \(the owner calls it leia\), "page footer"/);
  assert.equal(w.claude.runs()[0].task, "alpha:t2");
  await until(() => s.of("task.added").some((l) => l.task.ref === "alpha:t2"), { timeout: 20_000 });
  await until(() => showTask(w, "t2").worker?.alive && !showTask(w, "t2").worker.busy, { timeout: 20_000 });
  assert.match(w.sup.cli(["task", "list"]).stdout, /leia · page footer/, "the Falcon lists the task the app started");

  // The app tells the worker to ask; the question reaches the stream.
  const told = act(w, "task.tell", { task: "alpha:t2", text: "ask" });
  assert.equal(told.code, 0, told.stdout);
  await until(() => s.of("question.asked", "alpha:t2").length === 1, { timeout: 20_000 });
  const q = s.of("question.asked", "alpha:t2")[0].question;
  assert.equal(q.picker, true);
  assert.equal(q.questions[0].question, "Which header style?");
  assert.equal(showTask(w, "t2").state, "needs-you", "the Falcon has the same question open");
  look(w);
  assert.match(news(w), /"header":"leia Style"/, "and the supervisor hears it, for its picker");

  // The app answers it: the worker reads exactly what a pick in the Falcon's picker sends.
  const answered = act(w, "question.answer", { task: "alpha:t2", question: q.id, answers: { "Which header style?": "Subtitle (Recommended)" } });
  assert.equal(answered.code, 0, answered.stdout);
  assert.equal(answered.json.result.delivered, true);
  await until(() => w.claude.prompts().includes("Style: Subtitle (Recommended)"), { timeout: 20_000 });
  await until(() => s.of("question.closed", "alpha:t2").length === 1, { timeout: 20_000 });
  const closed = s.of("question.closed", "alpha:t2")[0];
  assert.equal(closed.question, q.id);
  assert.equal(closed.answered.by, "cockpit");
  const rec = showTask(w, "t2");
  assert.equal(rec.state, "working");
  assert.equal(rec.answered.by, "cockpit");
  assert.deepEqual([rec.words.at(-1).text, rec.words.at(-1).via, rec.words.at(-1).client], ["Style: Subtitle (Recommended)", "app", "cockpit"]);
  assert.match(w.sup.cli(["task", "show", "t2"]).stdout, /question closed by the owner's words from a front end: Which header style\?/);
  // The same answer again from the app, and a late pick in the Falcon, go nowhere.
  const again = act(w, "question.answer", { task: "alpha:t2", question: q.id, answers: { "Which header style?": "Bold title" } });
  assert.equal(again.code, 1);
  assert.equal(again.json.error.code, "already-answered");
  assert.equal(again.json.error.answered.by, "cockpit");
  const late = ask(w.sup, [{ ...QUESTIONS[0], header: "leia Style" }], { "Which header style?": "Bold title" });
  assert.match(late.context, /leia · page footer: its question was answered already from cockpit \("Style: Subtitle \(Recommended\)"\), so this pick did not go to leia's worker/);
  await sleep(300);
  assert.equal(times(w, "Style: Bold title"), 0, "the worker got one answer");

  // The app's words for the worker: typed in, on the record as the app's.
  const words = act(w, "task.tell", { task: "alpha:t2", text: "keep the footer to one line" });
  assert.equal(words.json.result.delivered, true, words.stdout);
  await until(() => w.claude.prompts().includes("keep the footer to one line"), { timeout: 20_000 });
  await until(() => s.of("words", "alpha:t2").some((l) => l.words.some((x) => x.text === "keep the footer to one line" && x.via === "app" && x.client === "cockpit")), { timeout: 20_000 });
  assert.deepEqual([showTask(w, "t2").words.at(-1).via, showTask(w, "t2").words.at(-1).client], ["app", "cockpit"]);

  // It attaches to the worker's terminal: a view session of its own on rollcall's tmux server, on the worker's window.
  const at = api(w, ["attach", "alpha:t2", "--client", "cockpit"]);
  assert.equal(at.code, 0, at.stdout);
  assert.deepEqual([at.json.socket, at.json.session, at.json.window, at.json.alive], [w.socket, "sv-alpha", "t2", true]);
  assert.deepEqual(at.json.argv.slice(0, 3), ["tmux", "-L", w.socket]);
  const view = spawn("tmux", ["-L", w.socket, "-C", ...at.json.argv.slice(3)], { stdio: ["pipe", "ignore", "ignore"], env: w.sb.env });
  w.terminals.push(view);
  await until(() => w.tmux("list-clients", "-t", `=${at.json.view}`) !== "", { timeout: 20_000 });
  assert.equal(w.tmux("display", "-p", "-t", `=${at.json.view}:`, "#{window_name}"), "t2", "the view shows the worker's window");
  view.kill("SIGKILL");
  await until(() => w.tmux("list-clients", "-t", "=sv-alpha") === "", { timeout: 20_000 });
  assert.equal(api(w, ["attach", "alpha"]).json.error.code, "no-window", "this supervisor runs outside falcon");

  // Its PR lands: the stream shows the state and the same news the Falcon shows, and the app's notice replaces rollcall's.
  assert.equal(act(w, "task.stop", { task: "alpha:t2" }).json.result.stopped, true);
  assert.equal(w.sup.cli(["task", "set", "t2", "--state", "pr-open", "--pr", "https://github.com/o/r/pull/12"], { env: { ROLLCALL_TASK: "alpha:t2" } }).code, 0);
  await until(() => s.of("pr.changed", "alpha:t2").some((l) => l.pr?.number === 12), { timeout: 20_000 });
  look(w, gh);
  assert.equal(showTask(w, "t2").state, "landed");
  const landed = feed(w).at(-1);
  assert.match(landed, /^leia · page footer: landed \(https:\/\/github\.com\/o\/r\/pull\/12\)\./);
  await until(() => s.of("task.state", "alpha:t2").some((l) => l.to === "landed"), { timeout: 20_000 });
  await until(() => s.of("news").some((l) => l.home === "alpha" && l.task === "alpha:t2" && l.text === landed), { timeout: 20_000 });
  await until(() => s.of("notice").some((l) => l.text.startsWith(landed)), { timeout: 20_000 });
  assert.ok(!notified(w).some((n) => n.text.startsWith(landed)), "shown by the app, so rollcall's own notification stays quiet");

  // The app closes its stream: rollcall notifies the owner itself again.
  assert.equal(await s.end(), 0);
  assert.deepEqual(api(w, ["snapshot"]).json.clients, []);
  assert.equal(w.sup.cli(["task", "set", "t1", "--state", "pr-open", "--pr", "https://github.com/o/r/pull/13"], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  look(w, gh);
  assert.match(feed(w).at(-1), /^yoda · chat header: landed \(https:\/\/github\.com\/o\/r\/pull\/13\)/);
  assert.ok(notified(w).some((n) => n.text.startsWith(feed(w).at(-1))), "no app shows it now");
});

/** World's t1, its worker started and asking QUESTIONS; returns the question's id as a front end sees it. */
async function asking(w) {
  assert.equal(w.start(["t1"]).code, 0);
  await until(() => w.task().worker?.alive && !w.task().worker.busy, { timeout: 20_000 });
  w.sup.prompt("@t1 ask");
  await until(() => w.task().state === "needs-you", { timeout: 20_000 });
  const qid = api(w, ["snapshot"]).json.tasks.find((x) => x.ref === "alpha:t1").question?.id;
  assert.ok(qid);
  return qid;
}
const TAGGED = [{ ...QUESTIONS[0], header: "yoda Style" }];

test("the first answer wins: a pick in the Falcon first, and the app's answer is refused; the worker hears one answer", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const qid = await asking(w);
  assert.match(ask(w.sup, TAGGED, { "Which header style?": "Bold title" }).context, /→ yoda · chat header: typed into its worker/);
  await until(() => w.claude.prompts().includes("Style: Bold title"), { timeout: 20_000 });
  assert.equal(w.task().answered.by, "the terminal Falcon");
  const r = act(w, "question.answer", { task: "alpha:t1", question: qid, answers: { "Which header style?": "Subtitle (Recommended)" } });
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, "already-answered", r.stdout);
  assert.equal(r.json.error.answered.by, "the terminal Falcon");
  await sleep(300);
  assert.equal(times(w, "Style: Bold title"), 1);
  assert.ok(!w.claude.prompts().some((p) => p.startsWith("Style: Subtitle")), "the worker got one answer");
});

test("the first answer wins: the app's answer first closes the Falcon's open picker with Esc, the supervisor hears why, and a late pick is dropped", { skip: !HAS_TMUX && "tmux is not installed" }, async (t) => {
  const w = world(t);
  const qid = await asking(w);
  // The supervisor in a falcon window, its picker open on this question: its transcript holds the call, unanswered.
  const keys = join(w.sb.root, "supervisor-keys.log");
  write(join(w.sb.root, "keys.cjs"), `const fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(keys)}, "");\nprocess.stdin.setRawMode(true);\nprocess.stdin.on("data", (d) => fs.appendFileSync(${JSON.stringify(keys)}, JSON.stringify(d.toString()) + "\\n"));\n`);
  w.tmux("new-window", "-d", "-t", "=sv-alpha:", "-n", "alpha", "--", process.execPath, join(w.sb.root, "keys.cjs"));
  await until(() => existsSync(keys), { timeout: 20_000 });
  const transcript = w.sup.payload("x").transcript_path;
  write(transcript, `${JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", id: "toolu_sup1", name: "AskUserQuestion", input: { questions: TAGGED } }] } })}\n`);

  const r = act(w, "question.answer", { task: "alpha:t1", question: qid, answers: { "Which header style?": "Subtitle (Recommended)" } });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.result.pickerClosed, true);
  await until(() => w.claude.prompts().includes("Style: Subtitle (Recommended)"), { timeout: 20_000 });
  await until(() => readFileSync(keys, "utf8").includes(JSON.stringify("\x1b")), { timeout: 20_000 });
  assert.ok(kinds(w).includes("answered-elsewhere"));
  look(w);
  assert.match(news(w), /yoda · chat header: the owner answered its question from cockpit \("Style: Subtitle \(Recommended\)"\), and it went to its worker, so rollcall closed your picker for it\. Do not ask it again\./);

  // The owner's pick landed as the picker closed: it goes nowhere.
  assert.match(ask(w.sup, TAGGED, { "Which header style?": "Bold title" }).context, /its question was answered already from cockpit/);
  await sleep(300);
  assert.equal(times(w, "Style: Bold title"), 0);
  assert.equal(times(w, "Style: Subtitle (Recommended)"), 1, "the worker got one answer");
});
