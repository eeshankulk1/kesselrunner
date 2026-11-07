// Pure pieces: remote normalization, repo keys across worktrees, glob scopes,
// the event cursor (partial lines, pruning), status output, new supervisors' names, what a worker's open
// prompt asks, who wrote a prompt, what a worker's status log says, process identity.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asked, asksText, promptAuthor, sameWords } from "../src/asked.mjs";
import { dialogFlag, dialogUp, settleDialog } from "../src/delivery.mjs";
import { branch, locate, normalizeRemote, repoKey } from "../src/git.mjs";
import { globToRegExp, matchScope } from "../src/glob.mjs";
import { pidAlive, sameProcess, startOf } from "../src/proc.mjs";
import { isAlive, isHolding } from "../src/session.mjs";
import { HOME_NAME } from "../src/store.mjs";
import { CHARACTERS, SHIPS, idOf, nameOf, pickName, running, taskOfQuestion } from "../src/supervisor.mjs";
import { draftIn } from "../src/tmux.mjs";
import { git, sandbox } from "./helpers.mjs";

test("normalizeRemote collapses ssh, scp and https forms of one repo", () => {
  const want = "github.com/acme/kesselrunner";
  for (const u of [
    "git@github.com:acme/kesselrunner.git",
    "git@github.com:Acme/kesselrunner",
    "ssh://git@github.com/acme/kesselrunner.git",
    "https://github.com/acme/kesselrunner.git",
    "https://user:token@github.com/acme/kesselrunner/",
    "https://github.com/acme/kesselrunner.git/",
  ]) assert.equal(normalizeRemote(u), want, u);
  assert.equal(normalizeRemote("/srv/git/origin.git"), "/srv/git/origin");
});

test("every worktree of a repo shares one key; a repo without origin keys by its git common dir", (t) => {
  const sb = sandbox(t);
  const wt = sb.worktree("feature");
  const main = locate(join(sb.main, "src/a.js"));
  const other = locate(join(wt, "src/new-file.js")); // need not exist yet
  assert.equal(main.top, sb.main);
  assert.equal(other.top, wt);
  assert.equal(other.rel, "src/new-file.js");
  assert.equal(repoKey(main).key, repoKey(other).key);
  assert.equal(branch(other), "feature");

  git(sb.main, "remote", "remove", "origin");
  assert.equal(repoKey(locate(sb.main)).key, repoKey(locate(wt)).key, "no origin: still one key for all worktrees");
  assert.match(repoKey(locate(sb.main)).key, /^repo-[0-9a-f]{12}$/);
  assert.equal(locate(sb.root), null);
});

test("paths through a symlink resolve to the real checkout", (t) => {
  const sb = sandbox(t);
  const link = join(sb.root, "link-to-repo");
  symlinkSync(sb.main, link);
  const info = locate(join(link, "src/a.js"));
  assert.equal(info.top, sb.main);
  assert.equal(info.rel, "src/a.js");
});

test("glob scopes", () => {
  const cases = [
    ["src/api/**", "src/api/routes.js", true],
    ["src/api/**", "src/api/v1/x.js", true],
    ["src/api/**", "src/apis.js", false],
    ["src/*.js", "src/a.js", true],
    ["src/*.js", "src/sub/a.js", false],
    ["**/*.test.mjs", "test/a.test.mjs", true],
    ["**/*.test.mjs", "a.test.mjs", true],
    ["src/{a,b}.js", "src/b.js", true],
    ["src/{a,b}.js", "src/c.js", false],
    ["docs", "docs/plans/x.md", true],
    ["docs/", "docs", true],
    ["./README.md", "README.md", true],
    ["file?.txt", "file1.txt", true],
  ];
  for (const [g, p, want] of cases) assert.equal(globToRegExp(g).test(p), want, `${g} vs ${p}`);
  assert.ok(matchScope(["x/**", "src/a.js"], "src/a.js"));
  assert.ok(!matchScope([], "src/a.js"));
});

test("event cursor skips a half-written line and survives pruning", async (t) => {
  const sb = sandbox(t);
  process.env.ROLLCALL_HOME = sb.home;
  t.after(() => { delete process.env.ROLLCALL_HOME; });
  const store = await import("../src/store.mjs");
  const key = "demo-000000000000";
  const start = store.logEnd(key);
  store.appendEvent(key, { type: "msg", text: "one" });
  const path = join(sb.home, key, "events.jsonl");
  appendFileSync(path, '{"ts":1,"type":"msg","te');
  let r = store.readEventsSince(key, start);
  assert.deepEqual(r.events.map((e) => e.text), ["one"]);
  appendFileSync(path, 'xt":"two"}\n');
  r = store.readEventsSince(key, r.cursor);
  assert.deepEqual(r.events.map((e) => e.text), ["two"]);

  // Pruning rewrites the file (new inode): the reader re-scans it but only returns newer events.
  const before = r.cursor;
  for (let i = 0; i < 300; i++) store.appendEvent(key, { type: "msg", text: "x".repeat(1000) });
  store.prune(key);
  store.appendEvent(key, { type: "msg", text: "after prune" });
  r = store.readEventsSince(key, before);
  assert.equal(r.events.at(-1).text, "after prune");
  assert.ok(r.events.length <= 301);
  r = store.readEventsSince(key, r.cursor);
  assert.equal(r.events.length, 0);
});

test("an event appended after a torn line (crashed writer) is still delivered", async (t) => {
  const sb = sandbox(t);
  process.env.ROLLCALL_HOME = sb.home;
  t.after(() => { delete process.env.ROLLCALL_HOME; });
  const store = await import("../src/store.mjs");
  const key = "torn-000000000000";
  store.appendEvent(key, { type: "msg", text: "first" });
  const cursor = store.logEnd(key);
  appendFileSync(join(sb.home, key, "events.jsonl"), '{"ts":1,"type":"msg","sess');
  store.appendEvent(key, { type: "msg", text: "after the tear" });
  assert.deepEqual(store.readEventsSince(key, cursor).events.map((e) => e.text), ["after the tear"]);
});

test("claim --scope keeps brace alternatives together", (t) => {
  const sb = sandbox(t);
  const a = sb.session(sb.worktree("x"));
  const b = sb.session(sb.worktree("y"));
  a.start();
  b.start();
  assert.match(a.cli(["claim", "helpers", "--scope", "src/{a,b}.js,docs"]).stdout, /\[src\/\{a,b\}\.js, docs\]/);
  assert.match(b.pre(join(b.cwd, "src/b.js")).context, /is inside the claim of/);
});

test("appendEvent caps every string field, not just text - a runaway claim intent cannot bloat every peer's store", async (t) => {
  const sb = sandbox(t);
  process.env.ROLLCALL_HOME = sb.home;
  t.after(() => { delete process.env.ROLLCALL_HOME; });
  const store = await import("../src/store.mjs");
  const key = "demo2-00000000000";
  const huge = "x".repeat(50_000);
  const e = store.appendEvent(key, { type: "claim", session: "s1", who: "s1", intent: huge, scope: [] });
  assert.ok(e.intent.length < huge.length, "intent was truncated");
  assert.ok(e.intent.length <= store.MAX_TEXT);
  const [line] = readFileSync(join(sb.home, key, "events.jsonl"), "utf8").trim().split("\n");
  assert.ok(line.length < huge.length);
});

test("status lists live sessions with branch, place, state, claim and edits; --json for tools", (t) => {
  const sb = sandbox(t);
  const wt = sb.worktree("feature");
  const a = sb.session();
  const b = sb.session(wt);
  a.start();
  a.prompt("fix the login bug");
  b.start();
  b.cli(["claim", "new exporter", "--scope", "src/export/**"]);
  b.edit(join(wt, "src/b.js"));
  b.stop();

  const out = a.cli(["status"]).stdout;
  assert.match(out, /^origin - 2 sessions$/m);
  assert.match(out, new RegExp(`^\\* ${a.short}  main  main checkout  working, active just now  <- you$`, "m"));
  assert.match(out, new RegExp(`^  ${b.short}  feature  \\.claude/worktrees/feature  idle, turn ended just now$`, "m"));
  assert.match(out, /^ {4}claim: "new exporter" \[src\/export\/\*\*\]$/m);
  assert.match(out, /^ {4}edited: src\/b.js$/m);

  const json = JSON.parse(a.cli(["status", "--json"]).stdout);
  const [repo] = json.repos;
  assert.equal(repo.sessions.length, 2);
  const mine = repo.sessions.find((s) => s.you);
  assert.equal(mine.id, a.id);
  assert.equal(mine.checkout, sb.main);
  assert.equal(repo.sessions.find((s) => !s.you).touched[0], "src/b.js");
  const all = JSON.parse(a.cli(["status", "--json", "--all"], { cwd: sb.root }).stdout);
  assert.equal(all.repos.length, 1);
});

test("pickName takes the first ship no home has, then the same ships with -2", () => {
  assert.equal(pickName(new Set()), "falcon");
  assert.equal(pickName(new Set(["falcon", "ghost"])), "venator");
  assert.equal(pickName(new Set(["venator", "default", "yoda"])), "falcon");
  assert.equal(pickName(new Set(SHIPS)), "falcon-2");
  assert.equal(pickName(new Set([...SHIPS, "falcon-2"])), "venator-2");
  assert.ok(SHIPS.every((n) => HOME_NAME.test(`${n}-99`)), "every ship, numbered, is a valid home");
});

test("a task's name comes from its number, and a name or an id the owner types finds the task again", () => {
  assert.deepEqual(["t1", "t2", "t3", "t18", "t19", "t37"].map(nameOf), ["yoda", "leia", "luke", "wedge", "yoda-2", "yoda-3"]);
  for (let n = 1; n <= 60; n++) assert.equal(idOf(nameOf(`t${n}`)), `t${n}`);
  assert.deepEqual(["Leia", "t3", "T3", "3", "luke-2"].map(idOf), ["t2", "t3", "t3", "t3", "t21"]);
  assert.deepEqual(["yoda-1", "bob", "", "t", "luke-x"].map(idOf), [null, null, null, null, null]);
  assert.equal(new Set(CHARACTERS).size, CHARACTERS.length);
  const q = (header, question = "Which?") => taskOfQuestion({ header, question });
  assert.equal(q("luke Style"), "t3", "the name that leads the header");
  assert.equal(q("luke"), "t3");
  assert.equal(q("yoda-2 Ship"), "t19");
  for (const header of ["Style", "Luke Style", "t3 Style", "3 Style", "lukewarm", "bob Ship", "yoda-1 Ship", ""]) assert.equal(q(header), null, header);
  assert.equal(q("Style", "luke · chat header: Which?"), "t3", "a question tagged in its text, as rollcall did until 2026-10-18, still finds its task");
  assert.equal(q("Style", "🟣 luke · chat header: Which?"), "t3", "a question tagged with a dot, as older rollcall did, still finds its task");
  assert.equal(q("Style", "T3 · chat header: Which?"), "t3", "an old picker question still finds its task");
  assert.equal(q("Style", "Do luke · x"), null);
  assert.equal(q("Style", "Choose · one"), null);
  assert.equal(taskOfQuestion(null), null);
});

test("what a worker's open prompt asks: the newest call with no result, its own or a recent subagent's", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rc-asked-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const at = (s) => new Date(Date.UTC(2026, 9, 21, 13, 40, s)).toISOString();
  const use = (s, id, name, input) => JSON.stringify({ type: "assistant", timestamp: at(s), message: { content: [{ type: "text", text: "hm" }, { type: "tool_use", id, name, input }] } });
  const result = (s, id) => JSON.stringify({ type: "user", timestamp: at(s), message: { content: [{ type: "tool_result", tool_use_id: id }] } });
  const main = join(dir, "s1.jsonl");
  writeFileSync(main, [
    use(1, "a", "Bash", { command: "ls", description: "List files" }), result(2, "a"),
    "not json",
    use(3, "b", "Bash", { command: "cp \"a b\"\n  /tmp/x", description: "Copy the icon" }),
  ].join("\n") + "\n");
  assert.deepEqual(asked(main), { tool: "Bash", what: 'cp "a b" /tmp/x', why: "Copy the icon" }, "a call with a result is done; one without waits on the prompt");

  // The worker waits on a subagent (an Agent call with no result): the subagent's own call asks.
  appendFileSync(main, `${result(4, "b")}\n${use(5, "c", "Agent", { description: "Check hooks", prompt: "..." })}\n`);
  const subs = join(dir, "s1", "subagents");
  mkdirSync(subs, { recursive: true });
  writeFileSync(join(subs, "agent-1.jsonl"), `${use(6, "d", "WebFetch", { url: "https://code.claude.com/docs/en/hooks", prompt: "PermissionRequest" })}\n`);
  // An older subagent's transcript, left with a call that never got a result, is not where a prompt is open.
  writeFileSync(join(subs, "agent-0.jsonl"), `${use(9, "e", "Bash", { command: "rm -rf build" })}\n`);
  const old = new Date(Date.now() - 3600_000);
  utimesSync(join(subs, "agent-0.jsonl"), old, old);
  assert.deepEqual(asked(main), { tool: "WebFetch", what: "https://code.claude.com/docs/en/hooks", why: null });

  appendFileSync(join(subs, "agent-1.jsonl"), `${result(7, "d")}\n`);
  assert.equal(asked(main), null, "nothing waits: no call, rather than a guess");
  assert.equal(asked(join(dir, "missing.jsonl")), null);
  assert.equal(asked(undefined), null);

  assert.equal(asksText({ tool: "Bash", what: "cp a b", why: "Copy the icon" }), "approval for Bash: Copy the icon (`cp a b`)");
  assert.equal(asksText({ tool: "mcp__github__merge", what: null, why: null }), "approval for mcp__github__merge");
  assert.equal(asksText({ type: "elicitation_dialog", message: "Pick a repo" }), 'a question from one of its tools ("Pick a repo")');
  assert.equal(asksText({ type: "permission_prompt", message: "Claude needs your permission to use Bash" }), 'a permission prompt ("Claude needs your permission to use Bash")');
  assert.equal(asksText(null), "a permission prompt");
});

test("settleDialog: a flag stays while a call waits, however long its dialog stays open, and goes when none does", (t) => {
  const sb = sandbox(t);
  process.env.ROLLCALL_HOME = sb.home;
  t.after(() => { delete process.env.ROLLCALL_HOME; });
  const task = { home: "alpha", id: "t1" };
  const main = join(sb.root, "s1.jsonl");
  const subs = join(sb.root, "s1", "subagents");
  mkdirSync(subs, { recursive: true });
  const use = (id, name, input) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (id) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } });
  writeFileSync(main, `${use("a", "Agent", { description: "check", prompt: "..." })}\n`);
  const sub = join(subs, "agent-1.jsonl");
  writeFileSync(sub, `${use("b", "Bash", { command: "rm -rf build" })}\n`);
  const old = new Date(Date.now() - 3600_000);
  utimesSync(sub, old, old); // its call was written an hour ago, and the dialog has stayed open since
  const flag = dialogFlag(task.home, task.id);
  const raise = (ago) => {
    writeFileSync(flag, JSON.stringify({ type: "permission_request", tool: "Bash", transcript: main }));
    const at = new Date(Date.now() - ago);
    utimesSync(flag, at, at);
  };
  raise(3600_000 - 5_000);
  assert.equal(settleDialog(task), false, "the subagent's call still waits: its dialog is open");
  assert.equal(dialogUp(task.home, task.id), true);

  appendFileSync(sub, `${result("b")}\n`);
  assert.equal(settleDialog(task), true, "its call has a result: the dialog was cancelled or answered");
  assert.equal(dialogUp(task.home, task.id), false);

  // A subagent that stopped long before the dialog opened, with a call that never got a result, asks nothing.
  writeFileSync(sub, `${use("c", "Bash", { command: "ls" })}\n`);
  utimesSync(sub, old, old);
  raise(60_000);
  assert.equal(settleDialog(task), true);
  assert.equal(dialogUp(task.home, task.id), false);

  raise(500);
  assert.equal(settleDialog(task), false, "a flag just raised waits for its call to reach the transcript");
});

test("draftIn: words in Claude Code's prompt box are a draft; an empty box or its own gray hint is not", () => {
  const box = (line) => `Some answer above.\n\n────────────\n${line}\n────────────\n  ? for shortcuts\n`;
  assert.equal(draftIn(box("❯ ")), false, "an empty box");
  assert.equal(draftIn(box("> ")), false, "the box in an older Claude Code");
  assert.equal(draftIn(box("❯ keep the icon")), true);
  assert.equal(draftIn(box("\x1b[39m❯ \x1b[0mkeep the icon")), true, "in colors");
  assert.equal(draftIn(box("❯ \x1b[2mTry \"fix the tests\"\x1b[0m")), false, "dim: its hint");
  assert.equal(draftIn(box("❯ \x1b[90mTry \"fix the tests\"\x1b[0m")), false, "gray: its hint");
  assert.equal(draftIn(box("❯ \x1b[38;5;246mTry \"fix the tests\"\x1b[0m")), false, "a 256-color gray: its hint");
  // The conversation above can quote a box: the bottom-most one decides.
  assert.equal(draftIn(`❯ an old prompt\n\nAn answer.\n${box("❯ ")}`), false);
  // A picker, as Claude Code 2.1.314 draws it: the box is gone, and neither a past prompt nor the chosen option is it.
  const picker = "\x1b[38;5;246m\x1b[48;5;237m❯ \x1b[38;5;231mReply with one word\x1b[39m\n\n⏺ pong\n\n❯ /auto-mode-setup\n────────────\n  Which one?\n  \x1b[38;5;153m❯\x1b[39m \x1b[38;5;246m1. \x1b[38;5;153mApples\x1b[39m\n    2. Pears\n  Enter to select · Esc to cancel\n";
  assert.equal(draftIn(picker), false);
  // The box as Claude Code 2.1.314 draws it: a no-break space after the mark, and its hint word by word.
  const rule = "\x1b[38;5;244m────────────";
  assert.equal(draftIn(`${rule}\n\x1b[39m❯\u00a0\x1b[2mTry\x1b[0m \x1b[2m"edit\x1b[0m \x1b[2mworklog.jsonl\x1b[0m \x1b[2mto..."\x1b[0m\n${rule}\n`), false);
  assert.equal(draftIn(`${rule}\n\x1b[39m❯\u00a0keep the icon\n${rule}\n`), true);
  assert.equal(draftIn(`❯ an old prompt\n\nAn answer.\n${box("❯ new words")}`), true);
  assert.equal(draftIn("fake claude 1234\n"), false, "no box on screen");
  assert.equal(draftIn(""), false);
});

test("promptAuthor: the transcript's marks say who wrote a prompt; its text never does", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rollcall-author-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "t.jsonl");
  const at = Date.now();
  const stamp = (o, ms = at) => ({ timestamp: new Date(ms).toISOString(), ...o });
  const user = (text, more) => stamp({ type: "user", message: { role: "user", content: text }, ...more });
  writeFileSync(file, [
    user("typed by the owner", { origin: { kind: "human" }, promptSource: "typed" }),
    user([{ type: "text", text: "typed, in blocks" }], { origin: { kind: "human" }, promptSource: "typed" }),
    stamp({ type: "attachment", attachment: { type: "queued_command", prompt: "typed in the middle of a turn", origin: { kind: "human" } } }),
    user("check the deploy", { isMeta: true, promptSource: "system", turnOrigin: "scheduled" }),
    user("Your claude.ai usage limit has reset. Continue the task.", { isMeta: true, origin: { kind: "auto-continuation" } }),
    user("<task-notification>done</task-notification>", { promptSource: "system", origin: { kind: "task-notification" } }),
    stamp({ type: "attachment", attachment: { type: "queued_command", prompt: "queued by a hook", origin: { kind: "system" } } }),
    user("[rollcall] a line that looks like rollcall's", { origin: { kind: "human" }, promptSource: "typed" }),
    stamp({ type: "assistant", message: { content: [{ type: "text", text: "not a prompt: words a model wrote" }] } }),
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const who = (text, since = at) => promptAuthor(file, text, since);
  assert.equal(who("typed by the owner"), "owner");
  assert.equal(who("typed, in blocks"), "owner");
  assert.equal(who("typed in the middle of a turn"), "owner");
  assert.equal(who("check the deploy"), "machine", "a scheduled wake-up");
  assert.equal(who("Your claude.ai usage limit has reset. Continue the task."), "machine", "Claude Code's continuation");
  assert.equal(who("<task-notification>done</task-notification>"), "machine", "a task notification");
  assert.equal(who("queued by a hook"), "machine");
  assert.equal(who("[rollcall] a line that looks like rollcall's"), "owner", "the text decides nothing");
  assert.equal(who("not a prompt: words a model wrote"), null);
  assert.equal(who("not written yet"), null, "the record comes after the hook");
  assert.equal(who("typed by the owner", at + 60_000), null, "a prompt from before this one is another prompt");
  assert.equal(promptAuthor(join(dir, "gone.jsonl"), "x", at), null);
  assert.equal(promptAuthor(null, "x", at), null);
});

test("sameWords: what the hook sees of what was typed", () => {
  assert.ok(sameWords("keep the icon", "keep the icon"));
  assert.ok(sameWords("line one\nline two", "\n\n<pasted_content id=\"8768\">\nline one\n  line two\n</pasted_content>"), "a long paste comes back wrapped");
  assert.ok(sameWords("Reply only pong", "my own draft words Reply only pong"), "what was in the box goes in front");
  assert.ok(sameWords("a\u0007b", "ab"), "tmux.type drops control characters");
  const relayed = "it failed: \n\n<pasted_content id=\"11a4\">\nmake: *** Error 127\n</pasted_content id=\"11a4\">";
  assert.ok(sameWords(relayed, "\n\n<pasted_content id=\"1325\">\nit failed: \n\n<\\pasted_content id=\"11a4\">\nmake: *** Error 127\n<\\/pasted_content id=\"11a4\">\n</pasted_content id=\"1325\">\n"), "a paste holding a paste's tag comes back with that tag escaped");
  assert.ok(!sameWords("keep the icon", "drop the icon"));
  assert.ok(!sameWords("", "anything"), "nothing sent holds nothing");
  assert.ok(!sameWords(null, "anything"));
});

test("running: one fold of a worker's status log", () => {
  const log = (...evs) => evs.map((ev, i) => (typeof ev === "string" ? { ev, at: i + 1 } : { at: i + 1, ...ev }));
  const pick = ({ turn, last, launch, started, up, held }) => ({ turn: turn?.ev ?? null, last: last?.ev ?? null, launch: launch?.at ?? null, started, up, held });
  const rows = [
    [[], { turn: null, last: null, launch: null, started: true, up: 0, held: null }, "no log: no launch waits on a session"],
    [log("launch"), { turn: "launch", last: "launch", launch: 1, started: false, up: 1, held: null }, "launched, its session not up (a trust prompt may hold it)"],
    [log("launch", "session"), { turn: "launch", last: "launch", launch: 1, started: true, up: 2, held: null }, "up"],
    [log("launch", "session", "busy"), { turn: "busy", last: "busy", launch: 1, started: true, up: 2, held: null }, "a turn runs"],
    [log("launch", "session", "busy", "idle"), { turn: "idle", last: "idle", launch: 1, started: true, up: 2, held: null }, "a turn ended"],
    [log("launch", "session", "idle", "exit"), { turn: "idle", last: "exit", launch: 1, started: true, up: 2, held: null }, "an exit leaves the last turn, and is the last thing"],
    [log("launch", "session", "idle", "parked", "exit"), { turn: "idle", last: "exit", launch: 1, started: true, up: 2, held: "parked" }, "parked stays through its exit"],
    [log("launch", "session", "idle", "parked", "exit", "session"), { turn: "idle", last: "exit", launch: 1, started: true, up: 6, held: null }, "Enter in its tab brought it back"],
    [log("launch", "session", "idle", "stopped", "launch"), { turn: "launch", last: "launch", launch: 5, started: false, up: 5, held: null }, "a launch ends a stop"],
    [log("launch", "session", "stopped"), { turn: "launch", last: "launch", launch: 1, started: true, up: 2, held: "stopped" }, "stopped on purpose"],
    [log("launch", "session", "busy", "dialog", "delivered", "dialog-gone"), { turn: "busy", last: "busy", launch: 1, started: true, up: 2, held: null }, "other events change nothing"],
    [log("launch", "busy", "idle"), { turn: "idle", last: "idle", launch: 1, started: true, up: 1, held: null }, "a turn says its session is up, though its start left no record"],
  ];
  for (const [events, want, why] of rows) assert.deepEqual(pick(running(events)), want, why);
  const launched = running([{ ev: "launch", at: 1, mode: "auto", model: "opus", effort: "high" }, { ev: "session", at: 2 }, { ev: "idle", at: 3, bg: [1], last: "done" }]);
  assert.deepEqual([launched.launch.mode, launched.launch.model, launched.launch.effort, launched.turn.bg, launched.turn.last], ["auto", "opus", "high", [1], "done"]);
});

test("a process is its id and its start time: a reused id is another process", () => {
  const start = startOf(process.pid);
  assert.ok(Number.isInteger(start) && start <= Date.now() && start > Date.now() - 3600_000, "ps gives this process's start");
  assert.equal(start, startOf(process.pid), "and the same one each time");
  assert.equal(pidAlive(process.pid), true, "no recorded start: the id alone");
  assert.equal(pidAlive(process.pid, start), true);
  const beforeBoot = Date.now() - uptime() * 1000 - 60_000;
  assert.equal(pidAlive(process.pid, beforeBoot), false, "a process from before this boot is gone, whatever runs under its id");
  assert.equal(isAlive({ pid: process.pid, pidStart: beforeBoot }), false);
  assert.equal(pidAlive(99_999_999, start), false, "no such process");
  assert.equal(pidAlive(1), false, "never init");
  assert.equal(startOf(99_999_999), null);

  // The Mac stayed up and the id came round: only the start time tells.
  assert.equal(pidAlive(process.pid, start + 1000), true, "the check every hook makes spawns nothing and cannot see this");
  assert.equal(sameProcess(process.pid, start), true);
  assert.equal(sameProcess(process.pid, start + 1000), false);
  assert.equal(sameProcess(process.pid), true, "no recorded start: the id alone");
  assert.equal(sameProcess(99_999_999, start), false);
  assert.equal(isHolding({ pid: process.pid, pidStart: start }), true);
  assert.equal(isHolding({ pid: process.pid, pidStart: start + 1000 }), false);
  assert.equal(isAlive({ pid: process.pid, pidStart: start, endedAt: 1 }), false);
});
