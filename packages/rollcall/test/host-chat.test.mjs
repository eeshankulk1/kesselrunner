// Done when: a chat (host/chat.mjs) starts in its own worktree and branch from origin's default branch (or in the
// folder itself, with a note, when git refuses), runs the owner's words first with the chat contract appended to
// Claude Code's system prompt, is titled from its first words and then by the title model unless the owner renamed it
// first, renames its branch only while unpushed, shows the tasks it starts as cards, archives by hand (refused with
// open tasks, a turn running or a request open) and by itself once unused, wakes on the owner's words, is found by
// search, shows in the snapshot with chatOptions, keeps its worktree from gc while not archived, and takes Claude's
// auto mode. A Codex model makes a Codex chat: Codex's own model list, its instructions, its modes (Auto as Codex's
// auto review) changed mid-chat, task news and its own `rollcall task` commands, as a Claude chat has them.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BIN, FIXTURES, denied, git, sandbox, until } from "./helpers.mjs";
import { FAKE, FAKE_CODEX, lines, readJson, setup } from "./host-helpers.mjs";
import { archiveDue, chatOptions, cleanTitle, draftTitle, renameBranch, slugOf } from "../src/host/chat.mjs";
import { policyFor, sandboxPolicyOf } from "../src/harness/codex.mjs";

const TITLER = join(FIXTURES, "fake-title.mjs");
const START = fileURLToPath(new URL("../../../scripts/supervisor/start.mjs", import.meta.url));
chmodSync(TITLER, 0o755);

/** A host sandbox whose chats run the stand-in Claude Code and title model. */
function chatSetup(t, env = {}) {
  // No Codex unless a test names one: the Mac's own must not answer.
  const x = setup(t, { env: { KESSELRUNNER_CLAUDE_BIN: FAKE, ROLLCALL_CHAT_TITLE_CMD: TITLER, ROLLCALL_CODEX_BIN: join("/nonexistent", "codex"), ...env } });
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

test("chat.new: a folder git refuses runs the chat there, with a note; a Codex model needs Codex", async (t) => {
  // chatSetup's codex does not run: Codex is not installed (or not signed in), so a Codex chat is not available.
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

test("chat: a hosted crew from before chats archives, wakes on words and renames as a chat; a terminal crew does not", async (t) => {
  const x = chatSetup(t);
  await x.startHost();
  // alpha: a hosted crew from before chats (runtime.json with no kind), started in the repo, with a supervisor launch.
  writeFileSync(join(x.home("alpha"), "falcon.json"), JSON.stringify({ session: "s", cwd: x.sb.main, at: Date.now() }));
  const sup = join(x.home("alpha"), "workers", "alpha");
  mkdirSync(sup, { recursive: true });
  writeFileSync(join(sup, "claude-launch.json"), JSON.stringify({ home: "alpha", task: null, session: randomUUID(), resume: false, settings: join(x.sb.root, "settings.json"), cwd: x.sb.main, bin: FAKE, prompt: null, mode: null, model: null, effort: null, addDir: [], name: "alpha", view: "chat" }));
  // Its open task refuses the archive, as a chat's does, and a refusal writes no record.
  const refused = x.api("chat.archive", { home: "alpha" });
  assert.equal(refused.error?.code, "refused", JSON.stringify(refused));
  assert.match(refused.error.message, /it has 1 open task/);
  assert.equal(x.chat("alpha"), null);
  x.task({ state: "landed" });
  const a = x.api("chat.archive", { home: "alpha" });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.result.chat.archivedBy, "owner");
  assert.ok(a.result.chat.archivedAt);
  assert.equal(a.result.chat.title, "alpha", "still titled by its name");
  assert.equal(a.result.chat.titleBy, "name");
  assert.equal(a.result.chat.folder, x.sb.main);
  const snap = JSON.parse(spawnSync(process.execPath, [BIN, "api", "snapshot"], { env: x.hostEnv, encoding: "utf8" }).stdout);
  assert.ok(snap.supervisors.find((s) => s.name === "alpha").chat.archivedAt, "the snapshot shows it archived");
  // The owner's words unarchive it and wake it.
  const told = x.api("task.tell", { task: "alpha", text: "still there" });
  assert.equal(told.ok, true, JSON.stringify(told));
  assert.equal(x.chat("alpha").archivedAt, null, "words unarchive it");
  await until(() => lines(join(sup, "history.jsonl")).some((e) => e.ev === "item" && e.item.text === "done: still there"));
  // gamma: another crew from before chats, renamed before anything else gave it a record.
  mkdirSync(x.home("gamma"), { recursive: true });
  writeFileSync(join(x.home("gamma"), "runtime.json"), JSON.stringify({ runtime: "host", at: Date.now() }));
  const r = x.api("chat.rename", { home: "gamma", title: "Old crew" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.chat.title, "Old crew");
  assert.equal(r.result.chat.titleBy, "owner");
  assert.equal(x.chat("gamma").title, "Old crew");
  // A terminal crew is no chat.
  mkdirSync(x.home("beta"), { recursive: true });
  assert.equal(x.api("chat.archive", { home: "beta" }).error?.code, "not-found");
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
  assert.deepEqual(snap.chatOptions.models.map((m) => m.harness), ["claude", "claude", "claude", "claude"]);
  assert.deepEqual(snap.chatOptions.modes.claude.map((m) => m.id), ["default", "acceptEdits", "plan", "auto"]);
  assert.equal(snap.chatOptions.modeFixed.codex, false);
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

test("chat unit: Codex's modes in the chip, as its approval policy and sandbox", () => {
  const o = chatOptions({ codex: () => false });
  assert.deepEqual(o.modes.codex.map((m) => m.id), ["default", "auto", "read-only"]);
  assert.equal(o.defaultMode.codex, "auto");
  assert.ok(o.models.every((m) => m.harness === "claude"), "no Codex models without Codex");
  assert.ok(chatOptions({ codex: () => true }).models.some((m) => m.harness === "codex"));
  assert.equal(policyFor("auto").approvalsReviewer, "auto_review");
  assert.deepEqual(policyFor("read-only"), { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "read-only" });
  assert.equal(policyFor("default").approvalsReviewer, "user");
  assert.deepEqual(sandboxPolicyOf({ sandbox: "read-only" }), { type: "readOnly", networkAccess: false });
  assert.deepEqual(sandboxPolicyOf({ sandbox: "workspace-write", writableRoots: ["/r"] }), { type: "workspaceWrite", writableRoots: ["/r"], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
});

test("chat on Codex: its models, its instructions, Auto, a mode changed mid-chat, its turns, hooks and session", async (t) => {
  const x = chatSetup(t, { ROLLCALL_CODEX_BIN: FAKE_CODEX, ROLLCALL_CODEX_MODELS: "1" });
  await x.startHost();
  const snapshot = () => JSON.parse(spawnSync(process.execPath, [BIN, "api", "snapshot"], { env: x.hostEnv, encoding: "utf8" }).stdout);
  // The host reads Codex's own list: shown models only, the default first.
  await until(() => snapshot().chatOptions.models.some((m) => m.id === "gpt-fake-main"));
  const codex = snapshot().chatOptions.models.filter((m) => m.harness === "codex");
  assert.deepEqual(codex.map((m) => [m.id, m.label]), [["gpt-fake-main", "GPT Fake"], ["gpt-fake-pro", "GPT Fake Pro"]]);
  assert.equal(x.api("chat.new", { cwd: x.sb.main, text: "hi", model: "gpt-fake-main", mode: "acceptEdits" }).error.code, "bad-payload", "a Claude mode");

  const { home: h, chat } = x.newChat({ model: "gpt-fake-main", mode: "auto", text: "hello codex" });
  assert.equal(chat.harness, "codex");
  const dir = join(x.home(h), "workers", h);
  const launch = readJson(join(dir, "codex-launch.json"));
  assert.equal(launch.task, null);
  assert.equal(launch.model, "gpt-fake-main");
  assert.equal(launch.approvalsReviewer, "auto_review", "Auto is Codex's auto review");
  assert.equal(launch.cwd, chat.worktree);
  assert.equal(existsSync(join(dir, "claude-launch.json")), false);
  await until(() => x.chatHistory(h).some((e) => e.ev === "item" && e.item.text === "done: hello codex"));
  const ins = x.codexFake().filter((l) => l.in).map((l) => l.in);
  const start = ins.find((m) => m.method === "thread/start");
  assert.match(start.params.developerInstructions, /You are a chat in cockpit/);
  assert.match(start.params.developerInstructions, /a terminal session of Codex/);
  assert.match(start.params.developerInstructions, /request_user_input/);
  assert.equal(start.params.approvalsReviewer, "auto_review");
  assert.equal(start.params.cwd, chat.worktree);
  // Its shell names its session, so `rollcall task new` there finds its home; its tasks start in auto.
  const session = readJson(join(dir, "codex-launch.json")).session;
  assert.equal(x.codexFake().find((l) => l.server)?.session, session);
  const g = readJson(join(x.sb.home, "_sessions", `${session}.json`));
  assert.equal(g.chat.home, h);
  assert.equal(g.mode, "auto");
  // Its turns are marked as a Claude chat's hooks mark them.
  await until(() => readJson(join(x.home(h), "turn.json"))?.idle === true);
  assert.equal(readJson(join(x.home(h), "turn.json")).session, session);
  // Codex's untrusted hooks: the chat says so.
  await until(() => x.chatHistory(h).some((e) => e.ev === "item" && /hooks are not trusted/.test(e.item.text ?? "")));

  // A mode changed mid-chat: Codex's modes only, from the next turn, and the chat keeps it.
  assert.equal(x.api("worker.set", { task: h, mode: "plan" }).error.code, "bad-payload");
  assert.equal(x.api("worker.set", { task: h, model: "opus" }).error.code, "bad-payload");
  const set = x.api("worker.set", { task: h, mode: "read-only" });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(x.chatAgent(h).mode, "read-only");
  assert.equal(x.api("task.tell", { task: h, text: "look only" }).ok, true);
  await until(() => x.chatHistory(h).some((e) => e.ev === "item" && e.item.text === "done: look only"));
  const turn = x.codexFake().filter((l) => l.in?.method === "turn/start").map((l) => l.in.params).find((p) => p.input?.[0]?.text === "look only");
  assert.equal(turn.approvalPolicy, "on-request");
  assert.equal(turn.approvalsReviewer, "user");
  assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(readJson(join(dir, "codex-launch.json")).sandbox, "read-only", "a resume starts in it");
  assert.equal(x.chat(h).mode, "read-only");
  assert.equal(readJson(join(x.sb.home, "_sessions", `${session}.json`)).mode, "default", "its tasks start asking");
  const snap = snapshot().supervisors.find((s) => s.name === h);
  assert.equal(snap.chat.harness, "codex");
  assert.equal(snap.chat.mode, "read-only");
  // A Codex chat in a parked state takes a model of Codex's for its next start.
  assert.equal(x.api("worker.set", { task: h, model: "gpt-fake-pro" }).ok, true);
});

/** The `--effort` an argv names, or null. */
const effortArg = (argv = []) => (argv.includes("--effort") ? argv[argv.indexOf("--effort") + 1] : null);

test("chat effort: the host reads Claude Code's models; chat.new and worker.set take a level the model takes, live or for the next start; a model change clamps", async (t) => {
  const x = chatSetup(t);
  mkdirSync(x.claudeDir, { recursive: true });
  writeFileSync(join(x.claudeDir, "settings.json"), JSON.stringify({ effortLevel: "medium" }));
  await x.startHost();
  const snapshot = () => JSON.parse(spawnSync(process.execPath, [BIN, "api", "snapshot"], { env: x.hostEnv, encoding: "utf8" }).stdout);
  const option = (id) => snapshot().chatOptions.models.find((m) => m.id === id);
  const modelsFile = join(x.sb.home, "_machine", "claude-models.json");
  // Before a session listed Claude Code's models, every model takes all five; the owner's settings name the default.
  assert.equal(readJson(modelsFile), null);
  assert.deepEqual(option("haiku").efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(option("haiku").defaultEffort, "medium");
  assert.equal(x.api("chat.new", { cwd: x.sb.main, text: "hi", effort: "huge" }).error.code, "bad-payload");

  const { home: h, chat } = x.newChat({ effort: "xhigh" });
  assert.equal(chat.effort, "xhigh");
  const dir = join(x.home(h), "workers", h);
  const launch = () => readJson(join(dir, "claude-launch.json"));
  assert.equal(launch().effort, "xhigh");
  assert.equal(x.chat(h).effort, "xhigh");
  const run = await until(() => x.fake().find((l) => l.argv?.includes("-p")));
  assert.equal(effortArg(run.argv), "xhigh", "Claude Code starts on it");
  // The host read Claude Code's models from that session (initialize), and the options follow them.
  const kept = await until(() => readJson(modelsFile));
  assert.ok(x.inputs().some((m) => m.type === "control_request" && m.request?.subtype === "initialize"));
  assert.deepEqual(kept.models.find((m) => m.id === "haiku"), { id: "haiku", resolved: "claude-haiku-4-5-20251001", label: "Haiku", efforts: [] });
  assert.deepEqual(option("haiku").efforts, []);
  assert.equal(option("haiku").defaultEffort, null);
  assert.deepEqual(option("sonnet").efforts, ["low", "medium", "high", "max"]);
  const none = x.api("chat.new", { cwd: x.sb.main, text: "hi", model: "haiku", effort: "low" });
  assert.equal(none.error.code, "bad-payload");
  assert.match(none.error.message, /haiku takes no effort level/);
  const lacks = x.api("chat.new", { cwd: x.sb.main, text: "hi", model: "sonnet", effort: "xhigh" });
  assert.equal(lacks.error.code, "bad-payload");
  assert.match(lacks.error.message, /effort on sonnet is one of low, medium, high, max/);
  await until(() => x.chatAgent(h)?.state === "idle");
  const snapChat = () => snapshot().supervisors.find((s) => s.name === h).chat;
  assert.equal(snapChat().effort, "xhigh");

  // Live: Claude Code's flag settings, as /effort sets it; the agent, the launch and the chat keep it.
  const set = x.api("worker.set", { task: h, effort: "high" });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.result.set.effort, "high");
  assert.ok(x.inputs().some((m) => m.type === "control_request" && m.request?.subtype === "apply_flag_settings" && m.request.settings?.effortLevel === "high"));
  assert.equal(x.fake().filter((l) => "effort" in l).at(-1).effort, "high");
  assert.equal(x.chatAgent(h).effort, "high");
  assert.equal(launch().effort, "high");
  assert.equal(x.chat(h).effort, "high");
  assert.equal(snapChat().effort, "high");
  assert.equal(x.api("worker.set", { task: h, effort: "minimal" }).error.code, "bad-payload", "a Codex level");

  // A model change: the level stays when the new model takes it, else the highest it takes below; asked for, it must take it.
  assert.equal(x.api("worker.set", { task: h, effort: "xhigh" }).ok, true);
  const down = x.api("worker.set", { task: h, model: "sonnet" });
  assert.equal(down.ok, true, JSON.stringify(down));
  assert.deepEqual(down.result.set, { model: "sonnet", effort: "high" });
  assert.equal(x.fake().filter((l) => "effort" in l).at(-1).effort, "high");
  assert.deepEqual([launch().model, launch().effort], ["sonnet", "high"]);
  assert.equal(x.chat(h).effort, "high");
  const same = x.api("worker.set", { task: h, model: "opus" });
  assert.deepEqual(same.result.set, { model: "opus" }, "opus takes high: no change");
  assert.equal(x.api("worker.set", { task: h, model: "sonnet", effort: "xhigh" }).error.code, "bad-payload");
  assert.equal(x.api("worker.set", { task: h, model: "haiku", effort: "low" }).error.code, "bad-payload");
  assert.equal(x.chatAgent(h).model, "opus", "a refused pick changes nothing");
  const toHaiku = x.api("worker.set", { task: h, model: "haiku" });
  assert.deepEqual(toHaiku.result.set, { model: "haiku", effort: null }, "a model with no levels: none");
  assert.equal(x.api("worker.set", { task: h, effort: "low" }).error.code, "bad-payload");
  assert.equal(snapChat().effort, null);
  assert.equal(x.api("worker.set", { task: h, model: "opus", effort: "medium" }).ok, true);

  // Archived (no process): the launch and the chat take it, nothing goes to Claude Code, and the wake starts on it.
  await until(() => x.chatAgent(h)?.state === "idle");
  assert.equal(x.api("chat.archive", { home: h }).ok, true);
  await until(() => x.chatAgent(h)?.state === "stopped");
  const sent = x.fake().filter((l) => "effort" in l).length;
  const parked = x.api("worker.set", { task: h, effort: "low" });
  assert.equal(parked.ok, true, JSON.stringify(parked));
  assert.equal(parked.result.set.effort, "low");
  assert.equal(launch().effort, "low");
  assert.equal(x.chat(h).effort, "low");
  assert.equal(x.fake().filter((l) => "effort" in l).length, sent, "nothing sent");
  assert.equal(snapChat().effort, "low");
  assert.equal(x.api("worker.set", { task: h, model: "haiku", effort: "low" }).error.code, "bad-payload", "the host checks the model's list there too");
  assert.equal(x.api("task.tell", { task: h, text: "back again" }).ok, true);
  await until(() => x.chatHistory(h).some((e) => e.ev === "item" && e.item.text === "done: back again"));
  const resumed = x.fake().filter((l) => l.argv?.includes("--resume")).at(-1)?.argv;
  assert.equal(effortArg(resumed), "low", (resumed ?? []).join(" "));
});

test("chat effort: a chat with no pick shows its model's default; Claude Code refusing a level answers failed", async (t) => {
  const x = chatSetup(t, { FAKE_CLAUDE_REFUSE: "apply_flag_settings" });
  mkdirSync(x.claudeDir, { recursive: true });
  writeFileSync(join(x.claudeDir, "settings.json"), JSON.stringify({ effortLevel: "xhigh", modelSettings: { "claude-opus-5-5": { effortLevel: "max" } } }));
  await x.startHost();
  const { home: h } = x.newChat();
  assert.equal(readJson(join(x.home(h), "workers", h, "claude-launch.json")).effort, null, "no pick: Claude Code's own");
  const run = await until(() => x.fake().find((l) => l.argv?.includes("-p")));
  assert.equal(effortArg(run.argv), null);
  await until(() => x.chatAgent(h)?.state === "idle");
  const snapChat = () => JSON.parse(spawnSync(process.execPath, [BIN, "api", "snapshot"], { env: x.hostEnv, encoding: "utf8" }).stdout).supervisors.find((s) => s.name === h).chat;
  assert.equal(snapChat().effort, "max", "the settings' level for opus's resolved id");
  const r = x.api("worker.set", { task: h, effort: "low" });
  assert.equal(r.error?.code, "failed", JSON.stringify(r));
  assert.match(r.error.message, /did not take effort low/);
  assert.equal(x.chat(h).effort, null, "a refused level is not kept");
  assert.equal(snapChat().effort, "max");
});

test("chat effort on Codex: its models' own levels, the chat's level at its start, a change from the next turn, a model change clamps", async (t) => {
  const x = chatSetup(t, { ROLLCALL_CODEX_BIN: FAKE_CODEX, ROLLCALL_CODEX_MODELS: "1" });
  await x.startHost();
  const snapshot = () => JSON.parse(spawnSync(process.execPath, [BIN, "api", "snapshot"], { env: x.hostEnv, encoding: "utf8" }).stdout);
  const main = await until(() => snapshot().chatOptions.models.find((m) => m.id === "gpt-fake-main"));
  assert.deepEqual([main.efforts, main.defaultEffort], [["minimal", "low", "medium", "high", "xhigh"], "medium"], "Codex's order, its default");
  const pro = snapshot().chatOptions.models.find((m) => m.id === "gpt-fake-pro");
  assert.deepEqual([pro.efforts, pro.defaultEffort], [[], null], "a model that lists none");
  assert.deepEqual(readJson(join(x.sb.home, "_machine", "codex-models.json")).models[0].efforts, ["minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(x.api("chat.new", { cwd: x.sb.main, text: "hi", model: "gpt-fake-main", effort: "max" }).error.code, "bad-payload", "Codex has no max");
  assert.equal(x.api("chat.new", { cwd: x.sb.main, text: "hi", model: "gpt-fake-pro", effort: "low" }).error.code, "bad-payload");

  const { home: h } = x.newChat({ model: "gpt-fake-main", mode: "auto", effort: "high", text: "hello codex" });
  const dir = join(x.home(h), "workers", h);
  const launch = () => readJson(join(dir, "codex-launch.json"));
  assert.equal(launch().effort, "high");
  await until(() => x.chatHistory(h).some((e) => e.ev === "item" && e.item.text === "done: hello codex"));
  const ins = () => x.codexFake().filter((l) => l.in).map((l) => l.in);
  assert.equal(ins().find((m) => m.method === "thread/start").params.config.model_reasoning_effort, "high", "the thread starts on it");
  const snapChat = () => snapshot().supervisors.find((s) => s.name === h).chat;
  assert.equal(snapChat().effort, "high");
  await until(() => x.chatAgent(h)?.state === "idle");

  // A change: from the next turn rollcall starts, and every resume after.
  assert.equal(x.api("worker.set", { task: h, effort: "max" }).error.code, "bad-payload");
  const set = x.api("worker.set", { task: h, effort: "minimal" });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.result.set.effort, "minimal");
  assert.equal(launch().effort, "minimal");
  assert.equal(x.chatAgent(h).effort, "minimal");
  assert.equal(x.chat(h).effort, "minimal");
  assert.equal(snapChat().effort, "minimal");
  const turnFor = (text) => x.codexFake().filter((l) => l.in?.method === "turn/start").map((l) => l.in.params).find((p) => p.input?.[0]?.text === text);
  assert.equal(x.api("task.tell", { task: h, text: "think less" }).ok, true);
  await until(() => x.chatHistory(h).some((e) => e.ev === "item" && e.item.text === "done: think less"));
  assert.equal(turnFor("think less").effort, "minimal");

  // A model change clamps: an unlisted model takes the fallback (low, medium, high), so xhigh comes down to high.
  await until(() => x.chatAgent(h)?.state === "idle");
  assert.equal(x.api("worker.set", { task: h, effort: "xhigh" }).ok, true);
  const down = x.api("worker.set", { task: h, model: "gpt-5.6-terra" });
  assert.equal(down.ok, true, JSON.stringify(down));
  assert.deepEqual(down.result.set, { model: "gpt-5.6-terra", effort: "high" });
  assert.equal(x.api("worker.set", { task: h, model: "gpt-fake-pro", effort: "low" }).error.code, "bad-payload");
  assert.equal(x.api("task.tell", { task: h, text: "on terra" }).ok, true);
  await until(() => x.chatHistory(h).some((e) => e.ev === "item" && e.item.text === "done: on terra"));
  assert.deepEqual([turnFor("on terra").model, turnFor("on terra").effort], ["gpt-5.6-terra", "high"]);
  assert.deepEqual([launch().model, launch().effort], ["gpt-5.6-terra", "high"]);
});

test("worker effort: a hosted task's worker.effort is the host's, changed live; a stopped worker takes a level for its next start", async (t) => {
  const x = chatSetup(t);
  const ref = "alpha:t1";
  const cfg = x.launch({ effort: "high" });
  x.task({ sessions: [{ id: cfg.session, at: Date.now(), hosted: true }] });
  await x.startHost();
  const c = await x.client();
  assert.equal((await c.call("start", { ref })).ok, true);
  await c.call("say", { ref, text: "first" });
  await until(() => x.agent()?.state === "idle");
  const worker = () => JSON.parse(spawnSync(process.execPath, [BIN, "api", "snapshot"], { env: x.hostEnv, encoding: "utf8" }).stdout).tasks.find((v) => v.ref === ref).worker;
  assert.equal(worker().effort, "high");
  const set = x.api("worker.set", { task: ref, effort: "medium" });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.result.set.effort, "medium");
  assert.equal(x.fake().filter((l) => "effort" in l).at(-1).effort, "medium", "Claude Code got it");
  assert.equal(worker().effort, "medium", "the snapshot shows the live change");
  assert.equal(readJson(join(x.dir, "claude-launch.json")).effort, "medium");
  // Stopped: the host takes the level for its next start; a mode lasts only for a running session.
  await c.call("stop", { ref });
  await until(() => x.agent()?.state === "stopped");
  const sent = x.fake().filter((l) => "effort" in l).length;
  const stopped = x.api("worker.set", { task: ref, effort: "low" });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.equal(readJson(join(x.dir, "claude-launch.json")).effort, "low");
  assert.equal(x.fake().filter((l) => "effort" in l).length, sent, "nothing sent");
  assert.equal(worker().effort, "low");
  assert.equal(x.api("worker.set", { task: ref, mode: "auto" }).error?.code, "refused");
});

test("chat effort: a task the chat starts takes its level when it names none, clamped to its model; its own --effort wins", async (t) => {
  const x = chatSetup(t);
  await x.startHost();
  const { home: h } = x.newChat({ effort: "xhigh" });
  await until(() => readJson(join(x.sb.home, "_machine", "claude-models.json"))); // sonnet takes no xhigh
  await until(() => x.chatAgent(h)?.state === "idle");
  const made = (title, ...more) => {
    const r = spawnSync(process.execPath, [BIN, "task", "new", title, "--home", h, "--repo", x.sb.main, "--json", ...more], { env: x.hostEnv, encoding: "utf8", cwd: x.sb.main });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).id;
  };
  const ids = [made("plain part"), made("own part", "--effort", "low"), made("sonnet part", "--model", "sonnet")];
  // Their workers start as the owner's word or the watcher would start them (side by side: each waits on its session).
  const started = (id) => new Promise((done) => {
    const p = spawn(process.execPath, [START, id, "--home", h], { env: x.hostEnv, cwd: x.sb.main, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("exit", (code) => done({ code, out }));
  });
  for (const r of await Promise.all(ids.map(started))) assert.equal(r.code, 0, r.out);
  const launched = (id) => readJson(join(x.home(h), "workers", id, "claude-launch.json"));
  const [plain, own, sonnet] = ids.map(launched);
  assert.equal(plain.effort, "xhigh", "the chat's level");
  assert.equal(own.effort, "low", "its own wins");
  assert.deepEqual([sonnet.model, sonnet.effort], ["sonnet", "high"], "clamped to what sonnet takes");
});
