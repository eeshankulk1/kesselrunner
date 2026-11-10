// Done when: a chat (host/chat.mjs) starts in its own worktree and branch from origin's default branch (or in the
// folder itself, with a note, when git refuses), runs the owner's words first with the chat contract appended to
// Claude Code's system prompt, is titled from its first words and then by the title model unless the owner renamed it
// first, renames its branch only while unpushed, shows the tasks it starts as cards, archives by hand (refused with
// open tasks, a turn running or a request open) and by itself once unused, wakes on the owner's words, is found by
// search, shows in the snapshot with chatOptions, keeps its worktree from gc while not archived, and takes Claude's
// auto mode.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BIN, FIXTURES, denied, git, sandbox, until } from "./helpers.mjs";
import { FAKE, lines, readJson, setup } from "./host-helpers.mjs";
import { archiveDue, cleanTitle, draftTitle, renameBranch, slugOf } from "../src/host/chat.mjs";

const TITLER = join(FIXTURES, "fake-title.mjs");
chmodSync(TITLER, 0o755);

/** A host sandbox whose chats run the stand-in Claude Code and title model. */
function chatSetup(t, env = {}) {
  const x = setup(t, { env: { KESSELRUNNER_CLAUDE_BIN: FAKE, ROLLCALL_CHAT_TITLE_CMD: TITLER, ...env } });
  x.api = (action, payload) => {
    const r = spawnSync(process.execPath, [BIN, "api", "do", action, JSON.stringify(payload)], { env: x.hostEnv, encoding: "utf8", cwd: x.sb.root });
    try { return JSON.parse(r.stdout); } catch { throw new Error(`${action}: ${r.stdout}${r.stderr}`); }
  };
  x.home = (h) => join(x.sb.home, "_supervisors", h);
  x.chat = (h) => readJson(join(x.home(h), "chat.json"));
  x.chatHistory = (h) => lines(join(x.home(h), "workers", h, "history.jsonl"));
  x.chatAgent = (h) => readJson(join(x.home(h), "workers", h, "agent.json"));
  x.newChat = (payload = {}) => {
    const r = x.api("chat.new", { cwd: x.sb.main, text: "Create hello.txt containing hi, then commit it", ...payload });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.result;
  };
  return x;
}

test("chat unit: draft titles, slugs, cleaned titles, archive due", () => {
  assert.equal(draftTitle("Fix the login page\nmore words"), "Fix the login page");
  const long = draftTitle("Create hello.txt containing hi, then commit it and then do a lot of other things please");
  assert.ok(long.length <= 60 && long.endsWith("..."), long);
  assert.equal(slugOf("Fix the Login Page: crash!"), "fix-the-login-page-crash");
  assert.equal(cleanTitle('Title: "Hello File Commit."\n'), "Hello File Commit");
  const now = 10 * 86400_000;
  const c = { createdAt: 0, lastUsedAt: now - 8 * 86400_000, archivedAt: null };
  assert.equal(archiveDue(c, {}, now, 7), true);
  assert.equal(archiveDue(c, { open: 1 }, now, 7), false, "open tasks keep it");
  assert.equal(archiveDue(c, { running: true }, now, 7), false, "a running turn keeps it");
  assert.equal(archiveDue(c, { requests: 1 }, now, 7), false, "an open request keeps it");
  assert.equal(archiveDue({ ...c, lastUsedAt: now - 86400_000 }, {}, now, 7), false, "used lately");
  assert.equal(archiveDue({ ...c, archivedAt: 1 }, {}, now, 7), false, "archived already");
});

test("chat unit: task news reads plain, by title, a question as words", async () => {
  const { chatNewsLine } = await import("../src/watch.mjs");
  const questions = [{ question: "Ship it now?", header: "Ship", multiSelect: false, options: [{ label: "Yes", description: "ship" }, { label: "No", description: "wait" }] }];
  const t = { id: "t3", title: "Fix the login page", state: "needs-you", ask: { questions }, notes: [] };
  const ask = chatNewsLine({ task: "t3", kind: "ask" }, t);
  assert.equal(ask, '"Fix the login page" (luke) asks: Ship it now? (Yes / No)');
  assert.doesNotMatch(ask, /[{}[\]]|AskUserQuestion/, "no JSON, no orders for a supervisor");
  const asked = chatNewsLine({ task: "t3", kind: "needs-you" }, { ...t, ask: null, question: "Which port?" });
  assert.equal(asked, '"Fix the login page" (luke) asks: "Which port?"');
  const replied = { ...t, state: "landed", ask: null, notes: [{ at: 5, by: "worker", text: "reply: it is on main" }] };
  assert.equal(chatNewsLine({ task: "t3", kind: "reply", note: 5 }, replied), '"Fix the login page" (luke) (landed) replies: "it is on main"');
  const long = { ...replied, notes: [{ at: 5, by: "worker", text: `reply: ${"word ".repeat(200)}` }] };
  assert.match(chatNewsLine({ task: "t3", kind: "reply", note: 5 }, long), /\(the rest: `rollcall task show luke`\)$/);
  assert.equal(chatNewsLine({ task: "t3", kind: "ask" }, { ...t, state: "working" }), null, "news that no longer stands");
});

test("chat.new: worktree and branch, owner's words first, contract appended, draft then auto title, branch renamed", async (t) => {
  const x = chatSetup(t, { FAKE_TITLE_MS: "300" });
  await x.startHost();
  const r = x.newChat();
  const h = r.home;
  assert.match(h, /^chat-[a-z0-9]{6}$/);
  assert.equal(r.ref, h);
  assert.equal(r.chat.titleBy, "draft");
  assert.equal(r.chat.title, "Create hello.txt containing hi, then commit it");
  const wt = join(x.sb.main, ".claude", "worktrees", h);
  assert.equal(r.chat.worktree, wt);
  assert.equal(r.chat.folder, x.sb.main);
  assert.equal(r.chat.repo.main, x.sb.main);
  assert.equal(r.chat.note, null);
  assert.ok(existsSync(wt), "the worktree exists");
  assert.equal(git(wt, "rev-parse", "HEAD"), git(x.sb.main, "rev-parse", "origin/main"), "from origin's default branch");
  assert.equal(readJson(join(x.home(h), "runtime.json")).kind, "chat");
  // The agent runs in the worktree, the contract appended, the owner's words its first message.
  const run = await until(() => x.fake().find((l) => l.argv && l.argv.includes("-p")));
  const i = run.argv.indexOf("--append-system-prompt");
  assert.ok(i > 0, "the contract is appended");
  assert.match(run.argv[i + 1], /You are a chat in cockpit/);
  assert.ok(run.argv[i + 1].includes(wt), "the contract names the worktree");
  assert.ok(run.argv[i + 1].includes(h), "and the home its tasks belong to");
  const first = await until(() => x.inputs().find((m) => m.type === "user"));
  assert.equal(first.message.content, "Create hello.txt containing hi, then commit it");
  await until(() => x.chatHistory(h).some((e) => e.ev === "item" && e.item.text === "done: Create hello.txt containing hi, then commit it"));
  const items = x.chatHistory(h).filter((e) => e.ev === "item").map((e) => e.item);
  assert.equal(items.find((i) => i.kind === "user").text, "Create hello.txt containing hi, then commit it", "the owner's words come first");
  assert.equal(items.find((i) => i.kind === "user").from ?? "owner", "owner");
  // Bound as its home's session, with edits allowed (supervisor.chat).
  const lock = readJson(join(x.home(h), "lock.json"));
  assert.equal(lock.session, r.session);
  const g = readJson(join(x.sb.home, "_sessions", `${r.session}.json`));
  assert.equal(g.chat.home, h, "a chat, not a supervisor: its edits are allowed");
  assert.equal(g.supervisor, null);
  // The title model's title, and the branch after it.
  const c = await until(() => (x.chat(h)?.titleBy === "auto" ? x.chat(h) : null));
  assert.equal(c.title, "Hello File Commit");
  assert.equal(c.branch, "chat/hello-file-commit");
  assert.equal(git(wt, "branch", "--show-current"), "chat/hello-file-commit");
  assert.ok(c.lastUsedAt >= c.createdAt);
});

test("chat.new: the owner's rename wins over the title model; a named chat gets no model title", async (t) => {
  const x = chatSetup(t, { FAKE_TITLE_MS: "3000" });
  await x.startHost();
  const { home: h } = x.newChat();
  const r = x.api("chat.rename", { home: h, title: "My own name" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.chat.titleBy, "owner");
  assert.equal(r.result.chat.branch, "chat/my-own-name");
  // The model's title comes later (the host logs it either way) and loses.
  const hostLog = join(x.sb.home, "_host", "host.log");
  await until(() => { try { return readFileSync(hostLog, "utf8").includes(`${h}: titled`); } catch { return false; } }, { timeout: 30_000 });
  assert.equal(x.chat(h).title, "My own name");
  assert.equal(x.chat(h).titleBy, "owner");
  const named = x.newChat({ title: "Named up front" });
  assert.equal(named.chat.titleBy, "owner");
  assert.equal(named.chat.branch, `chat/${named.home}`, "the branch is renamed when a title lands, not at the start");
  assert.equal(x.api("chat.rename", { home: "chat-zzzzzz", title: "x" }).error.code, "not-found");
});

test("chat.new: a folder git refuses runs the chat there, with a note; a Codex model is not available", async (t) => {
  const x = chatSetup(t);
  await x.startHost();
  const plain = join(x.sb.root, "plain");
  mkdirSync(plain);
  const r = x.newChat({ cwd: plain, mode: "acceptEdits", model: "haiku" });
  assert.equal(r.chat.worktree, null);
  assert.equal(r.chat.branch, null);
  assert.equal(r.chat.repo, null);
  assert.match(r.chat.note, /^Working in the folder itself: /);
  const launch = readJson(join(x.home(r.home), "workers", r.home, "claude-launch.json"));
  assert.equal(launch.cwd, plain);
  assert.equal(launch.mode, "acceptEdits");
  assert.equal(launch.model, "haiku");
  assert.equal(x.api("chat.new", { cwd: x.sb.main, text: "hi", model: "gpt-5.6-terra" }).error.code, "not-available");
  assert.equal(x.api("chat.new", { cwd: x.sb.main, text: "hi", mode: "bypassPermissions" }).error.code, "bad-payload");
  assert.equal(x.api("chat.new", { cwd: "relative", text: "hi" }).error.code, "bad-payload");
});

test("chat: a task it makes is a card in its history; archive is refused with open tasks, by hand and words wake it", async (t) => {
  const x = chatSetup(t);
  await x.startHost();
  const c = await x.client();
  const { home: h } = x.newChat();
  await until(() => x.chatAgent(h)?.state === "idle");
  const made = spawnSync(process.execPath, [BIN, "task", "new", "Side part", "--home", h, "--repo", x.sb.main, "--words", "do the side part", "--json"], { env: x.hostEnv, encoding: "utf8", cwd: x.sb.main });
  assert.equal(made.status, 0, made.stderr);
  const tid = JSON.parse(made.stdout).id;
  const card = await until(() => x.chatHistory(h).find((e) => e.ev === "item" && e.item.kind === "task")?.item);
  assert.deepEqual({ ...card, at: 0 }, { kind: "task", id: `task:${h}:${tid}`, at: 0, ref: `${h}:${tid}`, title: "Side part" });
  const page = await c.call("history", { ref: h });
  assert.ok(page.items.some((i) => i.kind === "task" && i.ref === `${h}:${tid}`), "the history page carries it");
  const refused = x.api("chat.archive", { home: h });
  assert.equal(refused.error.code, "refused");
  assert.match(refused.error.message, /it has 1 open task/);
  // A chat with no tasks archives; its process ends; the owner's words bring it back.
  const { home: h2 } = x.newChat({ text: "second chat" });
  await until(() => x.chatAgent(h2)?.state === "idle");
  const a = x.api("chat.archive", { home: h2 });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.result.chat.archivedBy, "owner");
  assert.ok(a.result.chat.archivedAt);
  await until(() => x.chatAgent(h2)?.state === "stopped");
  const told = x.api("task.tell", { task: h2, text: "are you there" });
  assert.equal(told.ok, true, JSON.stringify(told));
  assert.equal(x.chat(h2).archivedAt, null, "words unarchive it");
  await until(() => x.chatHistory(h2).some((e) => e.ev === "item" && e.item.text === "done: are you there"));
  // Unarchive by hand; a worktree gc took meanwhile comes back from origin's default branch, on a new branch.
  await until(() => x.chatAgent(h2)?.state === "idle");
  assert.equal(x.api("chat.archive", { home: h2 }).ok, true);
  const wt2 = x.chat(h2).worktree;
  await until(() => x.chatAgent(h2)?.state === "stopped");
  git(x.sb.main, "worktree", "remove", "--force", wt2);
  const u = x.api("chat.unarchive", { home: h2 });
  assert.equal(u.result.chat.archivedAt, null);
  assert.equal(u.result.chat.worktree, wt2, "the same folder, so its session resumes there");
  assert.ok(existsSync(wt2));
  assert.equal(u.result.chat.branch, `chat/${h2}`);
  assert.match(u.result.chat.note, /new one from origin\/main/);
});

test("chat: archive by hand is refused while a turn runs or a request is open; the snapshot says which", async (t) => {
  const x = chatSetup(t, { FAKE_CLAUDE_SLOW_MS: "1500" }); // a 30 s turn, ended by an interrupt: no race with a busy machine
  await x.startHost();
  const snapChat = (h) => JSON.parse(spawnSync(process.execPath, [BIN, "api", "snapshot"], { env: x.hostEnv, encoding: "utf8" }).stdout).supervisors.find((s) => s.name === h)?.chat;
  const { home: slow } = x.newChat({ text: "SLOW work" });
  await until(() => x.chatAgent(slow)?.state === "running");
  const working = x.api("chat.archive", { home: slow });
  assert.equal(working.error?.code, "refused", JSON.stringify(working));
  assert.match(working.error.message, /it is working/);
  assert.equal(snapChat(slow).busy, "working");
  assert.equal(x.chat(slow).archivedAt, null, "not archived");
  assert.equal(x.api("task.interrupt", { task: slow }).ok, true);
  await until(() => x.chatAgent(slow)?.state === "idle");
  assert.equal(snapChat(slow).busy, null);
  assert.equal(x.api("chat.archive", { home: slow }).ok, true, "archives once the turn ended");
  const { home: asks } = x.newChat({ text: "ASK first" });
  await until(() => x.chatAgent(asks)?.requests === 1);
  const waiting = x.api("chat.archive", { home: asks });
  assert.equal(waiting.error?.code, "refused", JSON.stringify(waiting));
  assert.match(waiting.error.message, /it is waiting on you/);
  assert.equal(snapChat(asks).busy, "waiting");
});

test("chat: archives itself once unused for the delay", async (t) => {
  const x = chatSetup(t, { ROLLCALL_CHAT_ARCHIVE_DAYS: String(1 / 86400), ROLLCALL_CHAT_ARCHIVE_POLL_MS: "200" });
  await x.startHost();
  const { home: h } = x.newChat({ text: "quick one" });
  const c = await until(() => (x.chat(h)?.archivedAt ? x.chat(h) : null), { timeout: 15_000 });
  assert.equal(c.archivedBy, "auto");
  assert.ok(c.archivedAt - c.lastUsedAt >= 1000, "not before the delay");
  await until(() => x.chatAgent(h)?.state === "stopped");
  assert.ok(x.chatHistory(h).some((e) => e.ev === "item" && e.item.text === "done: quick one"), "only after its turn");
});

test("chat: search, snapshot chat and chatOptions, gc keeps its worktree, worker.set auto", async (t) => {
  const x = chatSetup(t);
  await x.startHost();
  const { home: h } = x.newChat({ text: "Explain the zebra module" });
  await until(() => x.chatHistory(h).some((e) => e.ev === "item" && e.item.text === "done: Explain the zebra module"));
  await until(() => x.chat(h)?.titleBy === "auto");
  // Search: the title first, then the text, with a snippet and the item.
  const byTitle = x.api("chat.search", { query: "hello FILE" });
  assert.equal(byTitle.result.results[0].home, h);
  assert.equal(byTitle.result.results[0].match.in, "title");
  const byText = x.api("chat.search", { query: "zebra explain" });
  assert.equal(byText.result.results[0].match.in, "text");
  assert.match(byText.result.results[0].match.snippet, /zebra/);
  assert.ok(byText.result.results[0].match.itemId);
  assert.deepEqual(x.api("chat.search", { query: "nothing-like-this" }).result.results, []);
  assert.equal(x.api("chat.search", { query: "" }).error.code, "bad-payload");
  // The snapshot: the chat, a hosted crew from before (alpha) titled by name, and the options.
  writeFileSync(join(x.home("alpha"), "falcon.json"), JSON.stringify({ session: "s", cwd: x.sb.main, at: Date.now() }));
  const snap = JSON.parse(spawnSync(process.execPath, [BIN, "api", "snapshot"], { env: x.hostEnv, encoding: "utf8" }).stdout);
  const mine = snap.supervisors.find((s) => s.name === h);
  assert.equal(mine.runtime, "host");
  assert.equal(mine.chat.title, "Hello File Commit");
  assert.equal(mine.chat.harness, "claude");
  assert.equal(mine.chat.folderName, "repo");
  const old = snap.supervisors.find((s) => s.name === "alpha");
  assert.equal(old.chat.titleBy, "name");
  assert.equal(old.chat.title, "alpha");
  assert.equal(old.chat.folder, x.sb.main);
  assert.equal(snap.chatOptions.defaultModel, "opus");
  assert.deepEqual(snap.chatOptions.models.map((m) => m.harness), ["claude", "claude", "claude"]);
  assert.deepEqual(snap.chatOptions.modes.claude.map((m) => m.id), ["default", "acceptEdits", "plan", "auto"]);
  assert.equal(snap.chatOptions.modeFixed.codex, true);
  assert.equal(snap.chatOptions.archiveAfterDays, 7);
  // gc: a fresh chat worktree has no commits and sits on main, yet stays while the chat is open.
  const gc = spawnSync(process.execPath, [BIN, "gc"], { env: x.hostEnv, encoding: "utf8", cwd: x.sb.main });
  assert.match(gc.stdout, new RegExp(`kept ${h} \\(chat/hello-file-commit\\): chat ${h} is open`), gc.stdout + gc.stderr);
  assert.ok(existsSync(x.chat(h).worktree));
  // worker.set takes Claude's auto mode.
  const set = x.api("worker.set", { task: h, mode: "auto" });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.result.set.mode, "auto");
  assert.ok(x.inputs().some((m) => m.type === "control_request" && m.request?.subtype === "set_permission_mode" && m.request.mode === "auto"));
  assert.equal(x.chatAgent(h).mode, "auto");
  // A chat's mode outlives its process: archived and woken, it resumes in auto; parked, it takes a new pick for later.
  await until(() => x.chatAgent(h)?.state === "idle");
  assert.equal(x.api("chat.archive", { home: h }).ok, true);
  await until(() => x.chatAgent(h)?.state === "stopped");
  const parked = x.api("worker.set", { task: h, mode: "acceptEdits" });
  assert.equal(parked.ok, true, JSON.stringify(parked));
  assert.equal(x.api("task.tell", { task: h, text: "back again" }).ok, true);
  await until(() => x.chatHistory(h).some((e) => e.ev === "item" && e.item.text === "done: back again"));
  assert.equal(x.chatAgent(h).mode, "acceptEdits");
  const resumed = x.fake().filter((l) => l.argv?.includes("--resume")).at(-1)?.argv ?? [];
  assert.equal(resumed[resumed.indexOf("--permission-mode") + 1], "acceptEdits", resumed.join(" "));
  assert.equal(x.chat(h).mode, "acceptEdits", "the chat's record, which a remade worktree's launch is written from");
});

test("chat: the branch keeps its name once pushed", (t) => {
  const sb = sandbox(t);
  const wt = sb.worktree("chat/chat-abcdef");
  const c = { worktree: wt, branch: "chat/chat-abcdef" };
  writeFileSync(join(wt, "x.txt"), "x\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "x");
  git(wt, "push", "-q", "-u", "origin", "chat/chat-abcdef");
  assert.equal(renameBranch(c, "Something New"), null, "an upstream keeps it");
  // Unpushed: renamed, and a taken name gets a suffix.
  const wt2 = sb.worktree("chat/chat-ghijkl");
  git(sb.main, "branch", "chat/something-new");
  assert.equal(renameBranch({ worktree: wt2, branch: "chat/chat-ghijkl" }, "Something New"), "chat/something-new-2");
  assert.equal(readFileSync(join(wt2, ".git"), "utf8").startsWith("gitdir:"), true);
  assert.equal(git(wt2, "branch", "--show-current"), "chat/something-new-2");
});

test("chat hooks: a chat's session edits in its worktree, and its turns are marked as a supervisor's", (t) => {
  const sb = sandbox(t);
  const h = "chat-abc123";
  const wt = sb.worktree("chat/chat-abc123");
  const dir = join(sb.home, "_supervisors", h);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "runtime.json"), JSON.stringify({ runtime: "host", kind: "chat", at: Date.now() }));
  const s = sb.session(wt);
  // As bindChat leaves it before the session runs.
  writeFileSync(join(dir, "lock.json"), JSON.stringify({ session: s.id, at: Date.now(), chat: true }));
  mkdirSync(join(sb.home, "_sessions"), { recursive: true });
  writeFileSync(join(sb.home, "_sessions", `${s.id}.json`), JSON.stringify({ id: s.id, repos: [], supervisor: null, chat: { home: h, at: Date.now() } }));
  s.start();
  assert.equal(denied(s.pre(join(wt, "src/a.js"))), false, "its edits pass");
  s.prompt("make the change");
  assert.equal(readJson(join(dir, "turn.json")).idle, false, "its turn is marked");
  s.stop();
  assert.equal(readJson(join(dir, "turn.json")).idle, true);
  // A supervisor's session in the same place is still denied.
  const sup = sb.session(wt);
  sup.start();
  writeFileSync(join(sb.home, "_sessions", `${sup.id}.json`), JSON.stringify({ ...readJson(join(sb.home, "_sessions", `${sup.id}.json`)), supervisor: { home: "alpha", at: Date.now() } }));
  assert.equal(denied(sup.pre(join(wt, "src/b.js"))), true);
});
