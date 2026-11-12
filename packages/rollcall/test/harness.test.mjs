// The harness layer (harness/*.mjs) and the Codex worker (codex/*.mjs): which harness a task runs on, how a Codex
// worker's protocol events become the task record a Claude worker's hooks write, and the usage meter. The Codex
// worker runs against a stand-in CLI (fixtures/fake-codex.mjs) that speaks the app server's protocol on a unix socket.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BIN, FIXTURES, cleanEnv } from "./helpers.mjs";

const FAKE = join(FIXTURES, "fake-codex.mjs");

// Each test gets its own store: the modules read ROLLCALL_HOME when called, not when loaded.
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), "rc-harness-"));
  process.env.ROLLCALL_HOME = join(dir, "home");
  process.env.ROLLCALL_WATCHER = "0";
  return dir;
}
const mod = (m) => import(`../src/${m}`);

test("a harness is named in the owner's words, defaults to the owner's setting, and old tasks and sessions ran on Claude Code", async () => {
  const { harnessName, defaultHarness, harnessOf, sessionHarness, adapter, workerAdapter } = await mod("harness/index.mjs");
  assert.equal(harnessName("on codex"), "codex");
  assert.equal(harnessName("Codex"), "codex");
  assert.equal(harnessName("claude code"), "claude");
  assert.equal(harnessName("gemini"), null);
  assert.equal(defaultHarness({}), "claude");
  assert.equal(defaultHarness({ ROLLCALL_WORKER_HARNESS: "codex" }), "codex");
  assert.equal(harnessOf({}), "claude", "a task from before harnesses");
  assert.equal(sessionHarness({ id: "x" }), "claude");
  assert.equal(adapter("codex").name, "codex");
  // A task moved to Codex whose Claude worker still runs is driven as a Claude worker until it is replaced.
  assert.equal(workerAdapter({ harness: "codex", sessions: [{ id: "a", endedAt: null }] }).name, "claude");
  assert.equal(workerAdapter({ harness: "codex", sessions: [{ id: "a", endedAt: null, harness: "codex" }] }).name, "codex");
  assert.equal(workerAdapter({ harness: "codex", sessions: [] }).name, "codex");
});

test("models and modes map per harness: a Claude model means nothing on Codex, and auto mode is Codex's auto review", async () => {
  const codex = await mod("harness/codex.mjs");
  const claude = await mod("harness/claude.mjs");
  assert.equal(codex.models.map("opus"), null);
  assert.equal(codex.models.map("gpt-5.6-terra"), "gpt-5.6-terra");
  assert.equal(claude.models.map("gpt-5.6-terra"), null);
  assert.equal(claude.models.map("opus[1m]"), "opus[1m]");
  assert.deepEqual(codex.modelFor({ model: "opus", effort: "xhigh" }, { ROLLCALL_CODEX_MODEL: "gpt-5.6-luna" }), { model: "gpt-5.6-luna", effort: "xhigh" });
  // Codex's own levels: no max, but minimal and none.
  assert.deepEqual(codex.modelFor({ effort: "max" }, {}), { model: null, effort: null });
  assert.deepEqual(codex.modelFor({ effort: "minimal" }, {}), { model: null, effort: "minimal" });
  assert.deepEqual(codex.modelFor({ effort: "max" }, { ROLLCALL_CODEX_EFFORT: "none" }), { model: null, effort: "none" });
  assert.deepEqual(codex.modelFor({ effort: "nope" }, {}), { model: null, effort: null });
  assert.deepEqual(codex.policyFor("auto"), { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" });
  assert.equal(codex.policyFor("bypassPermissions").sandbox, "danger-full-access");
  assert.equal(codex.policyFor(null).approvalsReviewer, "user");
});

test("Codex's protocol in the shapes Claude Code's hooks carry: dialogs, questions, answers, limits, context", async () => {
  const w = await mod("codex/worker.mjs");
  assert.deepEqual(w.dialogPayload("item/commandExecution/requestApproval", { command: ["git", "push"], reason: "push" }), { tool_name: "Bash", tool_input: { command: "git push", argv: ["git", "push"], description: "push" }, notification_type: "permission_prompt", message: "push" });
  // Away mode's grant matches on the input, so it names what makes one request differ from another.
  assert.deepEqual(w.dialogPayload("item/commandExecution/requestApproval", { command: "ls", cwd: "/w" }).tool_input, { command: "ls", cwd: "/w" });
  assert.notDeepEqual(w.dialogPayload("execCommandApproval", { command: ["a b"] }).tool_input, w.dialogPayload("execCommandApproval", { command: ["a", "b"] }).tool_input, "argv with a space is not the same command");
  const patch = (fileChanges) => w.dialogPayload("applyPatchApproval", { fileChanges }).tool_input;
  assert.notDeepEqual(patch({ "a.ts": { add: "x" } }), patch({ "a.ts": { add: "y" } }), "the same file with other changes is another request");
  assert.deepEqual(patch({ "b.ts": {}, "a.ts": {} }).files, ["a.ts", "b.ts"]);
  assert.deepEqual(w.dialogPayload("item/fileChange/requestApproval", { reason: "edit" }).tool_input, { description: "edit" }, "a v2 file change names no files");
  assert.deepEqual(w.dialogPayload("item/permissions/requestApproval", { permissions: { network: { enabled: true } }, cwd: "/w", reason: "net" }).tool_input, { permissions: { network: { enabled: true } }, cwd: "/w", description: "net" });
  assert.equal(w.dialogPayload("mcpServer/elicitation/request", { serverName: "github" }).notification_type, "elicitation_dialog");
  assert.equal(w.dialogPayload("item/tool/call", {}), null, "a dynamic tool call opens nothing for the owner");
  const p = { questions: [{ id: "q1", header: "Ship", question: "Ship it?", options: [{ label: "Yes", description: "go" }] }, { id: "q2", header: "Why", question: "Why?" }] };
  assert.deepEqual(w.questionsOf(p), [
    { question: "Ship it?", header: "Ship", multiSelect: false, options: [{ label: "Yes", description: "go" }] },
    { question: "Why?", header: "Why", multiSelect: false, options: [] },
  ]);
  assert.deepEqual(w.answerFor(p, "went to the picker"), { answers: { q1: { answers: ["went to the picker"] }, q2: { answers: ["went to the picker"] } } });
  assert.ok(w.usageLimited({ codexErrorInfo: "usageLimitExceeded" }));
  assert.ok(!w.usageLimited({ codexErrorInfo: { httpConnectionFailed: {} } }));
  assert.deepEqual(w.contextOf({ last: { totalTokens: 350 }, total: { totalTokens: 900 }, modelContextWindow: 1000 }), { pct: 35, tokens: 350, size: 1000, total: 900 });
  assert.equal(w.contextOf({ last: { totalTokens: 5 } }), null, "no window, no percent");
  assert.equal(w.textOf({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "a\nb");
});

test("the usage meter: Claude's windows from the status line, Codex's from its protocol, a passed reset is empty, and near means past the bar", async () => {
  freshHome();
  const u = await mod("usage.mjs");
  const now = Date.now();
  const inHour = Math.floor(now / 1000) + 3600;
  u.recordClaude({ five_hour: { used_percentage: 91.6, resets_at: inHour }, seven_day: { used_percentage: 40, resets_at: inHour + 86400 } }, now);
  u.recordCodex({ limitId: "codex", primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: inHour }, planType: "plus" }, now);
  const got = u.usageOf(now);
  assert.equal(got.claude.fiveHour.pct, 92);
  assert.equal(got.codex.primary.windowMins, 300);
  assert.deepEqual(u.near(now).map((x) => [x.harness, x.name]), [["claude", "five-hour"]]);
  assert.match(u.usageLine(now), /^Claude 5h 92% until .+ · wk 40% \| Codex 5h 20%$/);
  // Past its reset, a window is empty again, whatever the last reading said.
  const later = now + 2 * 3600_000;
  assert.equal(u.usageOf(later).claude.fiveHour.pct, 0);
  assert.deepEqual(u.near(later), []);
  // An idle session's status line still carries an older, lower reading of the same window: the higher one stands.
  u.recordClaude({ five_hour: { used_percentage: 50, resets_at: inHour }, seven_day: { used_percentage: 41, resets_at: inHour + 86400 } }, now + 1000);
  assert.equal(u.usageOf(now).claude.fiveHour.pct, 92);
  assert.equal(u.usageOf(now).claude.weekly.pct, 41);
  // A new window starts from its own reading.
  u.recordClaude({ five_hour: { used_percentage: 3, resets_at: inHour + 5 * 3600 } }, now + 2000);
  assert.equal(u.usageOf(now).claude.fiveHour.pct, 3);
  // A snapshot of another of Codex's limits (no windows) leaves the plan's reading alone.
  u.recordCodex({ limitId: "premium", primary: null, secondary: null }, now);
  assert.equal(u.usageOf(now).codex.primary.pct, 20);
});

test("Codex's limits are read through a short-lived app server on stdio, at most every ten minutes", async () => {
  freshHome();
  process.env.ROLLCALL_CODEX_BIN = FAKE;
  try {
    const u = await mod("usage.mjs");
    await u.refreshCodex(Date.now(), { force: true });
    assert.equal(u.usageOf().codex.primary.pct, 40);
    assert.equal(u.usageOf().codex.plan, "plus");
    assert.equal(u.refreshCodex(), null, "read just now: not again");
  } finally { delete process.env.ROLLCALL_CODEX_BIN; }
});

/** Polls `fn` until it returns something truthy, or fails with `what`. */
async function until(fn, what, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${typeof what === "function" ? what() : what}`);
    await sleep(100);
  }
}

test("a Codex worker: its thread starts on the brief, and its turns, receipts, dialogs, questions, context and limits reach the task as a Claude worker's hooks would", { timeout: 120_000 }, async (t) => {
  const dir = freshHome();
  const log = join(dir, "codex.log");
  const env = cleanEnv({ ROLLCALL_HOME: process.env.ROLLCALL_HOME, ROLLCALL_WATCHER: "0", ROLLCALL_CODEX_BIN: FAKE, FAKE_CODEX_LOG: log });
  const made = spawnSync(process.execPath, [BIN, "task", "new", "codex job", "--no-repo", "--home", "falcon", "--harness", "codex", "--json"], { encoding: "utf8", env, cwd: dir });
  assert.equal(made.status, 0, made.stderr);
  Object.assign(process.env, { ROLLCALL_CODEX_BIN: FAKE });
  const store = await mod("store.mjs");
  const codex = await mod("harness/codex.mjs");
  const { launching } = await mod("delivery.mjs");
  const h = "falcon";
  let task = store.readTask(h, "t1");
  assert.equal(task.harness, "codex");
  // What launch() does, without tmux: the launch files, the receipt for the brief, the session on the record.
  const { session } = codex.writeLaunch(task, { prompt: "the brief TOKENS=400", mode: "auto", model: "opus", effort: "high" });
  launching(task, "the brief TOKENS=400", { fresh: true });
  store.withTasksLock(h, () => { const x = store.readTask(h, "t1"); x.sessions.push({ id: session, at: Date.now(), endedAt: null, tmux: true, harness: "codex" }); store.writeTask(x); });
  const cfg = JSON.parse(readFileSync(codex.launchFile(h, "t1"), "utf8"));
  assert.equal(cfg.model, null, "a Claude model is not passed to Codex");
  assert.equal(cfg.approvalsReviewer, "auto_review");

  const worker = spawn(process.execPath, [BIN, "codex-worker", h, "t1"], { env, cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  worker.stderr.on("data", (d) => { err += d; });
  t.after(() => { try { worker.kill("SIGTERM"); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const status = () => store.readStatus(h, "t1");
  const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

  // The thread starts with the task's sandbox and the brief goes in as its first turn; its receipt clears the launch item.
  await until(() => status().some((e) => e.ev === "session"), `the session event (${err})`);
  task = store.readTask(h, "t1");
  assert.equal(task.sessions.at(-1).thread, "th-1", "the thread is on the session, for a resume");
  const start = lines().find((l) => l.in?.method === "thread/start")?.in.params;
  assert.equal(start.sandbox, "workspace-write");
  assert.equal(start.config.model_reasoning_effort, "high");
  assert.equal(start.config.sandbox_workspace_write.network_access, true);
  await until(() => status().some((e) => e.ev === "idle" && e.last === "done: the brief TOKENS=400"), "the first turn's end");
  assert.ok(status().some((e) => e.ev === "busy"));
  assert.equal(store.readHomeFile(h, "outbox-t1"), null, "the brief's receipt took it off the queue");
  await until(() => lines().some((l) => l.ui?.includes("resume") && l.ui.includes("th-1")), "the owner's UI attached to the thread");
  const ctx = store.readHomeFile(h, "context-t1");
  assert.equal(ctx.pct, 40);
  assert.equal(ctx.total, 800);
  assert.match(store.readTask(h, "t1").notes.map((n) => n.text).join("\n"), /not trusted/, "untrusted hooks are said on the task");
  assert.ok(store.listWakes(h).queued.some((e) => e.kind === "hooks-untrusted"), "and are news for the supervisor");
  assert.match((await mod("watch.mjs")).wakeText(h, store.listWakes(h).queued), /not trusted yet/);

  // rollcall's words go through the protocol, with an id of its own, and the server's answer is the receipt.
  const { enqueue } = await mod("delivery.mjs");
  task = store.readTask(h, "t1");
  enqueue(task, "words", "APPROVE now");
  store.withHomeLock(h, () => { const items = store.readHomeFile(h, "outbox-t1"); items[0].typedAt = Date.now(); items[0].tries = 1; store.writeHomeFile(h, "outbox-t1", items); });
  assert.deepEqual(codex.type(task, "APPROVE now"), { ok: true });
  assert.equal(store.readHomeFile(h, "outbox-t1"), null, "delivered");
  const sent = lines().findLast((l) => l.in?.method === "turn/start")?.in.params;
  assert.match(sent.clientUserMessageId, /^rollcall-d-/);
  // A command waiting on approval raises the dialog flag; the server resolving it takes it down.
  const { dialogFlag } = await mod("delivery.mjs");
  await until(() => existsSync(dialogFlag(h, "t1")), "the dialog flag");
  assert.equal(JSON.parse(readFileSync(dialogFlag(h, "t1"), "utf8")).what, "rm -rf build");
  await until(() => !existsSync(dialogFlag(h, "t1")), "the dialog flag to come down");
  await until(() => status().some((e) => e.ev === "idle" && e.last === "done: APPROVE now"), "the approval turn's end");

  // While the owner is away the approval is held: declined so the turn goes on, with the note as a steer (Codex's
  // decline carries no reason), and on the held list. No dialog opens.
  const away = await mod("away.mjs");
  away.setAway(true, "test");
  assert.deepEqual(codex.type(store.readTask(h, "t1"), "APPROVE later"), { ok: true });
  await until(() => lines().some((l) => l.in?.result?.decision === "decline"), "the declined approval");
  await until(() => lines().some((l) => l.in?.method === "turn/steer" && JSON.stringify(l.in.params.input).includes("held for them")), "the hold note, steered in");
  assert.deepEqual(away.heldView().map((x) => [x.ref, x.harness, x.tool, x.summary, x.reason]), [[`${h}:t1`, "codex", "Bash", "rm -rf build", "clean the build"]]);
  assert.equal(existsSync(dialogFlag(h, "t1")), false);
  await until(() => status().some((e) => e.ev === "idle" && e.last === "done: APPROVE later"), "the held turn's end");
  away.setAway(false, "test");

  // A question goes to the owner's picker: the task turns needs-you, and the worker hears where it went.
  assert.deepEqual(codex.type(store.readTask(h, "t1"), "ASK please"), { ok: true });
  await until(() => store.readTask(h, "t1").state === "needs-you", "needs-you");
  assert.equal(store.readTask(h, "t1").ask.questions[0].question, "Ship it?");
  const answer = await until(() => lines().find((l) => l.in?.result?.answers?.q1)?.in.result.answers.q1.answers[0], "the answer to request_user_input");
  assert.match(answer, /went to the owner's picker/);

  // A turn the owner types in the UI (no id of rollcall's) is theirs: noted for the watcher to put on the record.
  const { typedWaiting } = await mod("delivery.mjs");
  const { connect } = await mod("codex/rpc.mjs");
  const ui = await connect(codex.workerRecord(h, "t1").sock, () => {});
  await ui.request("turn/start", { threadId: "th-1", input: [{ type: "text", text: "the owner typed this" }] });
  await until(() => typedWaiting(h, "t1").some((x) => x.owner && x.text === "the owner typed this"), "the owner's prompt noted");
  ui.close();
  await until(() => status().some((e) => e.ev === "idle" && e.last === "done: the owner typed this"), "the owner's turn's end");

  // The usage limit: the task waits on it, until the plan resets.
  assert.deepEqual(codex.type(store.readTask(h, "t1"), "LIMIT"), { ok: true });
  // Codex's own blocker: the Claude supervisor's news does not pause for it, and the wait ends when Codex resets.
  const wait = await until(() => store.readTask(h, "t1").wait?.on === "usage-codex" && store.readTask(h, "t1").wait, "the Codex usage wait");
  assert.ok(wait.until > Date.now() + 3600_000, "its reset time came from Codex");
  assert.ok(status().some((e) => e.ev === "idle" && e.failed === "rate_limit"));
  const trouble = await mod("trouble.mjs");
  assert.ok(trouble.openBlockers()["usage-codex"] && !trouble.paused(), "Codex's limit is its own blocker");
  assert.equal((await mod("usage.mjs")).usageOf().codex.primary.pct, 100, "the limits read at the failure are on the meter");

  // An interrupt stops the running turn.
  assert.deepEqual(codex.type(store.readTask(h, "t1"), "SLOW one"), { ok: true });
  await until(() => codex.workerRecord(h, "t1")?.turn, "the slow turn");
  assert.equal(codex.interrupt(store.readTask(h, "t1")), true);
  await until(() => !codex.workerRecord(h, "t1")?.turn, "the interrupt");

  // Stopping the worker ends its server and records its exit.
  worker.kill("SIGTERM");
  await until(() => status().some((e) => e.ev === "exit"), "the exit");
  await until(() => !existsSync(codex.stateFile(h, "t1")), "its record gone");
});

test("a Codex worker in a linked worktree takes turn snapshots as a Claude worker's hooks do: a baseline at its start, a turn after each turn", { timeout: 60_000 }, async (t) => {
  const dir = freshHome();
  const g = (cwd, ...a) => { const r = spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const repo = join(dir, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  g(repo, "add", "a.txt");
  g(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const wt = join(dir, "wt");
  g(repo, "worktree", "add", "-q", "-b", "task", wt);
  const env = cleanEnv({ ROLLCALL_HOME: process.env.ROLLCALL_HOME, ROLLCALL_WATCHER: "0", ROLLCALL_CODEX_BIN: FAKE, ROLLCALL_SNAPSHOTS: "1", FAKE_CODEX_LOG: join(dir, "codex.log") });
  const made = spawnSync(process.execPath, [BIN, "task", "new", "codex snap", "--no-repo", "--home", "falcon", "--harness", "codex", "--json"], { encoding: "utf8", env, cwd: dir });
  assert.equal(made.status, 0, made.stderr);
  Object.assign(process.env, { ROLLCALL_CODEX_BIN: FAKE });
  const store = await mod("store.mjs");
  const codex = await mod("harness/codex.mjs");
  const h = "falcon";
  const task = store.readTask(h, "t1");
  const { session } = codex.writeLaunch(task, { prompt: "write the client WRITE=gen/client.js", mode: "auto" });
  store.withTasksLock(h, () => { const x = store.readTask(h, "t1"); x.sessions.push({ id: session, at: Date.now(), endedAt: null, tmux: true, harness: "codex" }); store.writeTask(x); });
  // The task has no worktree of its own here: point its worker at the linked one.
  const cfg = JSON.parse(readFileSync(codex.launchFile(h, "t1"), "utf8"));
  writeFileSync(codex.launchFile(h, "t1"), JSON.stringify({ ...cfg, cwd: wt }));
  const worker = spawn(process.execPath, [BIN, "codex-worker", h, "t1"], { env, cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  worker.stderr.on("data", (d) => { err += d; });
  t.after(() => { try { worker.kill("SIGTERM"); } catch {} rmSync(dir, { recursive: true, force: true }); });

  const turns = () => {
    const r = spawnSync(process.execPath, [BIN, "turns", "--json"], { encoding: "utf8", env, cwd: wt });
    return r.status === 0 ? JSON.parse(r.stdout).turns : [];
  };
  const got = await until(() => { const ts = turns(); return ts.length >= 2 && ts; }, () => `the baseline and the first turn's snapshot (turns: ${JSON.stringify(turns())}; file: ${existsSync(join(wt, "gen/client.js"))}; worker: ${err}; status: ${JSON.stringify(store.readStatus(h, "t1"))})`);
  assert.equal(got[0].kind, "baseline");
  assert.equal(got[1].session, session);
  assert.deepEqual(got[1].files.map((f) => `${f.status} ${f.path}`), ["A gen/client.js"]);
});

test("efforts: each harness its own levels, a level clamped to what a model takes, Claude's and Codex's lists and defaults", async () => {
  const dir = freshHome();
  const e = await mod("harness/efforts.mjs");
  const store = await mod("store.mjs");
  assert.equal(e.effortOk("max", "claude"), true);
  assert.equal(e.effortOk("max", "codex"), false, "Codex has no max");
  assert.equal(e.effortOk("minimal", "codex"), true);
  assert.equal(e.effortOk("minimal", "claude"), false);
  assert.equal(e.effortOk("none", "codex"), true);
  assert.equal(e.effortOk(undefined), false);
  // clampEffort: kept when taken, else the highest taken below, else the lowest; null when the model takes none.
  assert.equal(e.clampEffort("xhigh", ["low", "medium", "high", "max"]), "high");
  assert.equal(e.clampEffort("high", ["low", "high"]), "high");
  assert.equal(e.clampEffort("low", ["medium", "high"]), "medium", "nothing below: the lowest");
  assert.equal(e.clampEffort("max", []), null);
  assert.equal(e.clampEffort(null, ["low"]), null);
  assert.equal(e.clampEffort("xhigh", ["minimal", "low", "medium"], "codex"), "medium");
  assert.deepEqual(e.codexListEfforts([{ reasoningEffort: "high" }, "low", { reasoningEffort: "bogus" }]), ["low", "high"]);
  assert.equal(e.codexListEfforts(undefined), null);

  // Claude: before a read every model takes all five; the default comes from the owner's settings, else null.
  const cfg = join(dir, "claude");
  mkdirSync(cfg, { recursive: true });
  const settings = (s) => writeFileSync(join(cfg, "settings.json"), JSON.stringify(s));
  const env = { CLAUDE_CONFIG_DIR: cfg };
  assert.equal(e.claudeModelsStale(), true);
  assert.deepEqual(e.effortsFor("claude", "haiku"), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(e.defaultEffortFor("claude", "opus", env), null, "no settings: unknown");
  settings({ effortLevel: "xhigh" });
  assert.equal(e.defaultEffortFor("claude", "opus", env), "xhigh");
  assert.equal(e.defaultEffortFor("claude", "opus", { ...env, CLAUDE_CODE_EFFORT_LEVEL: "low" }), "low", "the env wins");
  settings({ effortLevel: "xhigh", modelSettings: { "claude-opus-5-5": { effortLevel: "medium" } } });
  assert.equal(e.defaultEffortFor("claude", "opus", env), "medium", "the alias's resolved id, before a read too");
  // Claude Code's list, read: per model, in Claude's order; a model with no levels takes none.
  e.rememberClaudeModels([
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", supportedEffortLevels: ["max", "low", "medium", "high", "xhigh"] },
    { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet", supportedEffortLevels: ["low", "medium", "high", "max"] },
    { value: "claude-haiku-4-5-20251001", displayName: "Haiku" },
    { nope: true },
  ]);
  assert.deepEqual(store.readMachineFile("claude-models").models.map((m) => [m.id, m.resolved, m.efforts.length]), [["opus", "claude-opus-5-5", 5], ["sonnet", "claude-sonnet-5-5", 4], ["claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001", 0]]);
  assert.equal(e.claudeModelsStale(), false);
  assert.equal(e.claudeModelsStale(Date.now() + e.CLAUDE_MODELS_TTL + 1), true, "old after the TTL");
  assert.deepEqual(e.effortsFor("claude", "opus"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(e.effortsFor("claude", "claude-sonnet-5-5[1m]"), ["low", "medium", "high", "max"], "by resolved id, a context suffix left off");
  assert.deepEqual(e.effortsFor("claude", "claude-haiku-4-5-20251001"), []);
  assert.deepEqual(e.effortsFor("claude", "claude-unlisted-9"), ["low", "medium", "high", "xhigh", "max"], "a model it did not list takes all");
  assert.equal(e.defaultEffortFor("claude", "claude-haiku-4-5-20251001", env), null, "no levels: no default");
  settings({ effortLevel: "xhigh", modelSettings: { sonnet: { effortLevel: "low" } } });
  assert.equal(e.defaultEffortFor("claude", "sonnet", env), "low", "the alias's entry when the resolved id has none");
  settings({ effortLevel: "xhigh" });
  assert.equal(e.defaultEffortFor("claude", "sonnet", env), "high", "clamped to what sonnet takes");
  assert.equal(e.rememberClaudeModels([]), null);

  // Codex: the fallback until its list is read, then each model's own list and default.
  assert.deepEqual(e.effortsFor("codex", "gpt-x"), ["low", "medium", "high"]);
  assert.equal(e.defaultEffortFor("codex", "gpt-x", {}), null);
  store.updateMachineFile("codex-models", () => ({ value: { at: Date.now(), models: [
    { id: "gpt-a", label: "A", harness: "codex", efforts: ["minimal", "low", "medium", "high", "xhigh"], defaultEffort: "medium" },
    { id: "gpt-b", label: "B", harness: "codex", efforts: [], defaultEffort: null },
  ] }, out: null }));
  assert.deepEqual(e.effortsFor("codex", "gpt-a"), ["minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(e.effortsFor("codex", null), ["minimal", "low", "medium", "high", "xhigh"], "no model: Codex's default, listed first");
  assert.deepEqual(e.effortsFor("codex", "gpt-b"), []);
  assert.equal(e.defaultEffortFor("codex", "gpt-a", {}), "medium");
  assert.equal(e.defaultEffortFor("codex", "gpt-a", { ROLLCALL_CODEX_EFFORT: "none" }), "minimal", "ROLLCALL_CODEX_EFFORT, clamped");
  assert.equal(e.defaultEffortFor("codex", "gpt-b", {}), null);
});

test("chatOptions: each model carries its efforts and default, from Claude Code's and Codex's lists or the fallbacks", async () => {
  const dir = freshHome();
  const { chatOptions } = await mod("host/chat.mjs");
  const e = await mod("harness/efforts.mjs");
  const store = await mod("store.mjs");
  const keep = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_CODE_EFFORT_LEVEL: process.env.CLAUDE_CODE_EFFORT_LEVEL, ROLLCALL_CODEX_EFFORT: process.env.ROLLCALL_CODEX_EFFORT };
  try {
    process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    delete process.env.ROLLCALL_CODEX_EFFORT;
    mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ effortLevel: "xhigh", modelSettings: { "claude-opus-5-5": { effortLevel: "high" } } }));
    const of = (o, id) => o.models.find((m) => m.id === id);
    // Before any read: every Claude model takes all five; the settings say the default; Codex's fallback model.
    let o = chatOptions({ codex: () => true });
    for (const m of o.models.filter((m) => m.harness === "claude")) assert.deepEqual(m.efforts, ["low", "medium", "high", "xhigh", "max"], m.id);
    assert.equal(of(o, "opus").defaultEffort, "high", "modelSettings by resolved id wins over effortLevel");
    assert.equal(of(o, "sonnet").defaultEffort, "xhigh");
    assert.deepEqual(of(o, "gpt-5.6-terra").efforts, ["low", "medium", "high"]);
    assert.equal(of(o, "gpt-5.6-terra").defaultEffort, null);
    // Read: haiku takes none; sonnet no xhigh, so its default clamps.
    e.rememberClaudeModels([
      { value: "opus", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
      { value: "sonnet", resolvedModel: "claude-sonnet-5-5", supportedEffortLevels: ["low", "medium", "high", "max"] },
      { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" },
    ]);
    store.updateMachineFile("codex-models", () => ({ value: { at: Date.now(), models: [
      { id: "gpt-a", label: "A", harness: "codex", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
      { id: "gpt-b", label: "B", harness: "codex", efforts: [], defaultEffort: null },
    ] }, out: null }));
    o = chatOptions({ codex: () => true });
    assert.deepEqual(of(o, "haiku"), { id: "haiku", label: "Haiku", harness: "claude", efforts: [], defaultEffort: null });
    assert.deepEqual(of(o, "sonnet").efforts, ["low", "medium", "high", "max"]);
    assert.equal(of(o, "sonnet").defaultEffort, "high");
    assert.equal(of(o, "opus").defaultEffort, "high");
    assert.deepEqual(of(o, "fable").efforts, ["low", "medium", "high", "xhigh", "max"], "a model Claude Code did not list takes all");
    assert.deepEqual(of(o, "gpt-a"), { id: "gpt-a", label: "A", harness: "codex", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" });
    assert.deepEqual([of(o, "gpt-b").efforts, of(o, "gpt-b").defaultEffort], [[], null]);
  } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
