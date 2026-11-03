// Done when: a task record holds a piece of work across sessions (the owner's words verbatim, notes,
// worker sessions, state, PR, report) in its supervisor's own home; two named supervisors keep separate
// tasks and id counters and never write to each other's; one live session holds a name; a worker's
// reports queue a wake for its supervisor and nobody else; its worktree is kept until its work lands; a
// supervisor edits no project file; and v2's global tasks move to the default home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BIN, denied, git, reason, sandbox, write } from "./helpers.mjs";

const json = (r) => { assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout); };
const wakes = (sb, h) => { try { return readdirSync(join(sb.home, "_supervisors", h, "wake")).filter((n) => n.startsWith("q-")).map((n) => JSON.parse(readFileSync(join(sb.home, "_supervisors", h, "wake", n), "utf8"))); } catch { return []; } };
/** A task's worker as rollcall sees it: its environment names the task. */
const workerEnv = (h, id) => ({ env: { ROLLCALL_TASK: `${h}:${id}` } });

test("task new records the owner's words in the supervisor's home and makes the worktree; list, show, set, words, note, output, close", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  assert.match(sup.cli(["task", "new", "x", "--repo", sb.main]).stderr, /supervises nothing: run `rollcall supervise <name>` first/);
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  const words = "In the app, the header just says 'main'.\nMake it feel professional.";
  const made = sup.cli(["task", "new", "chat header polish", "--repo", sb.main, "--words", words, "--type", "fix"]);
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, /^t1: "chat header polish" in origin, supervisor alpha/);
  const wt = join(sb.main, ".claude/worktrees/chat-header-polish");
  assert.equal(git(wt, "branch", "--show-current"), "fix/chat-header-polish");

  const task = json(sup.cli(["task", "show", "t1", "--json"]));
  assert.equal(task.words[0].text, words, "the owner's words are kept verbatim, line breaks and all");
  assert.equal(task.home, "alpha");
  assert.equal(task.baseSha, git(sb.main, "rev-parse", "origin/main"), "the commit it started from, for the landed test");
  assert.ok(existsSync(join(sb.home, "_supervisors/alpha/tasks/t1.json")));

  // A second task with the same title gets its own worktree; task ids are never reused.
  assert.match(sup.cli(["task", "new", "chat header polish", "--repo", sb.main]).stdout, /^t2: .*\n.*chat-header-polish-2 \(feat\/chat-header-polish-2/);

  // The worker reports through the record; its environment names the task, so it needs no home.
  const asked = sup.cli(["task", "set", "t1", "--state", "needs-you", "--question", "A: bold title, B: subtitle. I'd pick B."], workerEnv("alpha", "t1"));
  assert.equal(asked.code, 0, asked.stderr);
  assert.match(asked.stdout, /^t1: needs-you - A: bold title.*\n  supervisor alpha hears this now/);
  assert.deepEqual(wakes(sb, "alpha").map((w) => [w.task, w.kind]), [["t1", "needs-you"]]);
  assert.equal(sup.cli(["task", "words", "t1", "B, but keep the icon"]).code, 0);
  assert.equal(sup.cli(["task", "note", "t1", "decided: subtitle under the title"], workerEnv("alpha", "t1")).code, 0);
  assert.equal(sup.cli(["task", "set", "t1", "--state", "working"], workerEnv("alpha", "t1")).code, 0);
  assert.equal(wakes(sb, "alpha").length, 1, "carrying on is no news");

  const listed = json(sup.cli(["task", "list", "--json"])).tasks;
  assert.deepEqual(listed.map((x) => x.id), ["t1", "t2"]);
  assert.equal(listed[0].question, null, "a state change clears the open question");
  assert.equal(listed[0].worker, null, "no worker started yet");

  const shown = sup.cli(["task", "show", "1"]).stdout;
  assert.match(shown, /supervisor alpha, repo origin/);
  assert.match(shown, /The owner's words, verbatim[\s\S]*Make it feel professional\.[\s\S]*B, but keep the icon/);
  assert.match(shown, /worker: decided: subtitle under the title/);

  write(join(sb.root, "report.md"), "Subtitle added; tests pass.\n");
  assert.equal(sup.cli(["task", "output", "t1", "--file", join(sb.root, "report.md")], workerEnv("alpha", "t1")).code, 0);
  assert.match(sup.cli(["task", "show", "t1"]).stdout, /Last report .*:\nSubtitle added; tests pass\./);

  assert.match(sup.cli(["task", "close", "t2", "duplicate"]).stdout, /^t2: closed/);
  assert.equal(wakes(sb, "alpha").length, 1, "the supervisor's own close wakes nobody");
  assert.deepEqual(json(sup.cli(["task", "list", "--json"])).tasks.map((x) => x.id), ["t1", "t2"], "a task finished in the last hour still shows");
  assert.equal(sup.cli(["task", "show", "t9"]).code, 1);
  assert.equal(sup.cli(["task", "set", "t1", "--state", "done"]).code, 1, "states are a fixed list");
});

test("two named supervisors: one live session per name, their own tasks and ids, and neither writes to the other's", async (t) => {
  const sb = sandbox(t);
  const alpha = sb.session(sb.root);
  alpha.start();
  const beta = sb.session(sb.root);
  beta.start();
  assert.match(alpha.cli(["supervise", "alpha"]).stdout, /is supervisor alpha/);
  assert.match(beta.cli(["supervise", "beta"]).stdout, /is supervisor beta: .*\n  Tabs: .*`falcon resume beta`.*\n  no open tasks\n  other supervisors: alpha/);
  assert.match(alpha.cli(["task", "new", "header", "--repo", sb.main]).stdout, /^t1: "header" .*supervisor alpha/);
  assert.match(alpha.cli(["task", "new", "footer", "--repo", sb.main]).stdout, /^t2: /);
  assert.match(beta.cli(["task", "new", "export", "--repo", sb.main]).stdout, /^t1: "export" .*supervisor beta/, "each home counts its own ids");

  assert.deepEqual(json(alpha.cli(["task", "list", "--json"])).tasks.map((x) => x.title), ["header", "footer"]);
  assert.deepEqual(json(beta.cli(["task", "list", "--json"])).tasks.map((x) => x.title), ["export"]);
  assert.equal(json(beta.cli(["task", "show", "t1", "--json"])).title, "export");

  // beta cannot write to alpha's task, even naming it: only a note it names there goes in, which the worker hears.
  const guess = beta.cli(["task", "set", "t2", "--home", "alpha", "--title", "guessed"]);
  assert.equal(guess.code, 1);
  assert.match(guess.stderr, /t2 is supervisor alpha's task, not this one's \(beta\)/);
  assert.match(beta.cli(["task", "note", "t2", "--home", "alpha", "the font moved"]).stdout, /^t2: note added/);
  assert.equal(json(alpha.cli(["task", "show", "t2", "--json"])).notes.at(-1).by, "supervisor beta");
  assert.match(alpha.cli(["inbox"], workerEnv("alpha", "t2")).stdout, /From supervisor beta: the font moved/);

  // A second session asking for a name already held is refused and stays a plain session.
  const third = sb.session(sb.root);
  third.start();
  const refused = third.cli(["supervise", "alpha"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, new RegExp(`supervisor alpha is running in session ${alpha.short}, so this session stays a plain one`));
  assert.ok(!denied(third.pre(join(sb.main, "src/a.js"))), "a refused session is no supervisor");
  // A plain shell names the home when an id is in two of them.
  const shell = third.cli(["task", "show", "t1"]);
  assert.match(shell.stderr, /t1 is a task of alpha and beta: pass --home <name>/);
  assert.equal(json(third.cli(["task", "show", "t2", "--json"])).title, "footer", "an id only one home has needs no --home");

  // Once the holder is gone, the name is free.
  await alpha.crash();
  assert.match(third.cli(["supervise", "alpha"]).stdout, /is supervisor alpha.*\n  Tabs: .*\n  2 open tasks/);
  assert.match(third.cli(["supervise", "--help"]).stdout + third.cli(["supervise", "Bad Name"]).stderr, /lowercase letters/);
});

test("a supervisor edits no file inside a git checkout, and --off undoes it", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  assert.match(sup.cli(["supervise"]).stdout, /is supervisor falcon/, "no name: the first free ship");
  assert.equal(json(sup.cli(["status", "--json"], { cwd: sb.root })).me.home, "falcon");
  assert.equal(json(sup.cli(["status", "--json"], { cwd: sb.root })).me.supervisor, false, "a v2 band must not take this session for its kind of supervisor");
  sup.cli(["task", "new", "export", "--repo", sb.main]);
  const file = join(sb.main, "src/a.js");
  const r = sup.pre(file);
  assert.ok(denied(r));
  assert.match(reason(r), /this session is a supervisor, .*task tell <id>/s);
  assert.ok(denied(sup.pre(join(sb.main, ".claude/worktrees/export/src/a.js"), "Write")), "task worktrees too");
  assert.equal(sup.pre(join(sb.root, "scratch.md")).stdout, "", "outside any checkout it may write");
  assert.equal(sup.cli(["supervise", "--off"]).code, 0);
  assert.ok(!denied(sup.pre(file)));
  assert.equal(json(sup.cli(["status", "--json"], { cwd: sb.root })).me.home, null);
});

test("what the owner types in a task's worker goes on its record and closes its question; what the transcript gives to anyone else does not", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  sup.cli(["task", "new", "pin bump", "--repo", sb.main, "--words", "bump the pin"]);
  const sid = "11111111-1111-4111-8111-111111111111";
  const record = join(sb.home, "_supervisors/alpha/tasks/t1.json");
  const x = JSON.parse(readFileSync(record, "utf8"));
  x.sessions.push({ id: sid, name: "t1-pin-bump", at: Date.now(), endedAt: null, tmux: false });
  write(record, JSON.stringify(x));
  const transcript = join(sb.root, "worker.jsonl");
  const show = () => json(sup.cli(["task", "show", "t1", "--json"]));
  // Claude Code writes a prompt's transcript record after its hook returns; the watcher settles it from there.
  const typed = (text, rec) => {
    const r = spawnSync(process.execPath, [BIN, "worker-hook", "alpha", "t1", "prompt-submit"], { input: JSON.stringify({ session_id: sid, transcript_path: transcript, prompt: text }), env: sb.env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    if (rec) appendFileSync(transcript, `${JSON.stringify({ timestamp: new Date().toISOString(), ...rec(text) })}\n`);
    assert.equal(spawnSync(process.execPath, [BIN, "watch", "alpha", "--once"], { env: sb.env, encoding: "utf8", timeout: 30_000 }).status, 0);
  };
  const owner = (text) => ({ type: "user", message: { content: text }, origin: { kind: "human" }, promptSource: "typed" });
  const queued = (text) => ({ type: "attachment", attachment: { type: "queued_command", prompt: text, origin: { kind: "human" } } });
  sup.cli(["task", "set", "t1", "--state", "needs-you", "--question", "Carry the sweep or turn it off?"], workerEnv("alpha", "t1"));

  typed("Continue the task you were working on.", (text) => ({ type: "user", message: { content: text }, isMeta: true, origin: { kind: "auto-continuation" } }));
  typed("check the deploy", (text) => ({ type: "user", message: { content: text }, isMeta: true, promptSource: "system", turnOrigin: "scheduled" }));
  typed("a background task finished", (text) => ({ type: "user", message: { content: text }, promptSource: "system", origin: { kind: "task-notification" } }));
  typed("/compact"); // a slash command reaches no transcript as a prompt
  assert.equal(show().words.length, 1);
  assert.equal(show().state, "needs-you");
  assert.deepEqual(wakes(sb, "alpha").filter((w) => w.kind === "said"), [], "and nobody hears of them");

  typed("turn it off for now, ship only the pin bump", owner);
  const task = show();
  assert.deepEqual(task.words.slice(1).map((w) => [w.text, w.via]), [["turn it off for now, ship only the pin bump", "worker"]]);
  assert.equal(task.words[1].closed, "Carry the sweep or turn it off?");
  assert.equal(task.state, "working");
  assert.match(sup.cli(["task", "show", "t1"]).stdout, /\(typed in the worker's own window\)\nturn it off/);

  // The supervisor hears it once, at its next turn, though it sits in no repo.
  const news = sup.prompt("anything new?").context ?? "";
  assert.match(news, /\[rollcall\] yoda · pin bump: the owner talked to its worker in its own window, 1 message, .*closed its open question \("Carry the sweep or turn it off\?"\)/);
  assert.doesNotMatch(sup.prompt("and now?").context ?? "", /talked to its worker/);

  // Typed in the middle of a turn, a prompt reaches the transcript as an attachment.
  typed("and keep the changelog line", queued);
  assert.deepEqual(show().words.at(-1).text, "and keep the changelog line");

  // A prompt that starts with a path is words, not a command.
  typed("/tmp/shot.png the footer is cut off here", owner);
  assert.deepEqual(show().words.at(-1).text, "/tmp/shot.png the footer is cut off here");
});

test("the supervisor's messages land in the worker's inbox, which prints them once", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  sup.cli(["task", "new", "pin", "--repo", sb.main]);
  const told = sup.cli(["task", "tell", "t1", "the docs task touches the same README; leave it alone"]);
  assert.match(told.stdout, /^t1: message left in its inbox; it has no worker yet: the doorbell rings once one starts \(.*start\.mjs t1\)$/m);
  const worker = workerEnv("alpha", "t1");
  const first = sup.cli(["inbox"], worker);
  assert.match(first.stdout, /--- from supervisor alpha, just now \(the supervisor's words, not the owner's\)\nthe docs task touches the same README/);
  assert.match(first.stdout, /To answer the supervisor: .*task note t1 "reply: <answer>" \(the supervisor hears it\)/);
  assert.match(sup.cli(["inbox"], worker).stdout, /no unread messages for t1/);
  assert.match(sup.cli(["inbox"]).stderr, /not a task's worker/);
});

test("a worker's question, its handoff, a grown task and its PR go on the queue; a picker question comes from its AskUserQuestion", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  sup.cli(["task", "new", "pin", "--repo", sb.main]);
  const w = workerEnv("alpha", "t1");
  const questions = [{ question: "Which header style?", header: "Style", multiSelect: false, options: [{ label: "Subtitle (Recommended)", description: "a second line" }, { label: "Bold title", description: "one line" }] }];
  write(join(sb.root, "ask.json"), JSON.stringify({ questions }));
  assert.equal(sup.cli(["task", "set", "t1", "--state", "needs-you", "--ask-json", join(sb.root, "ask.json")], w).code, 0);
  assert.equal(json(sup.cli(["task", "show", "t1", "--json"])).ask.questions[0].options[0].label, "Subtitle (Recommended)");
  write(join(sb.root, "bad.json"), JSON.stringify([{ question: "q", options: [{ label: "only one" }] }]));
  assert.equal(sup.cli(["task", "set", "t1", "--state", "needs-you", "--ask-json", join(sb.root, "bad.json")], w).code, 1);
  assert.equal(sup.cli(["task", "note", "t1", "handoff: done the pin, next the docs"], w).code, 0, "a handoff note, as briefs before `task handoff` said");
  assert.equal(sup.cli(["task", "note", "t1", "grew: the settings screen needs the same pin"], w).code, 0);
  assert.equal(sup.cli(["task", "note", "t1", "grew: a supervisor's note is no news"]).code, 0);
  assert.equal(sup.cli(["task", "note", "t1", "reply: waiting on CI, about 5 minutes"], w).code, 0);
  // The handoff itself: the worker's prompt for the next one, on the record; a supervisor cannot write one.
  write(join(sb.root, "handoff.md"), "The pin works on iOS; the web half is next.\n");
  assert.match(sup.cli(["task", "handoff", "t1", "--file", join(sb.root, "handoff.md")]).stderr, /a handoff is the worker's to write/);
  const handed = sup.cli(["task", "handoff", "t1", "--file", join(sb.root, "handoff.md")], w);
  assert.equal(handed.code, 0, handed.stderr);
  assert.match(handed.stdout, /^t1: handoff saved\. rollcall starts a fresh worker from it; end your turn now/);
  assert.equal(json(sup.cli(["task", "show", "t1", "--json"])).handoff.text, "The pin works on iOS; the web half is next.\n");
  assert.match(sup.cli(["task", "show", "t1"]).stdout, /Last handoff \([^)]*\):\nThe pin works on iOS/);
  assert.equal(sup.cli(["task", "set", "t1", "--state", "pr-open", "--pr", "https://github.com/o/r/pull/7"], w).code, 0);
  assert.deepEqual(wakes(sb, "alpha").map((x) => x.kind), ["ask", "handoff", "grew", "reply", "handoff", "pr-open"]);
  assert.equal(sup.cli(["task", "set", "t1", "--ask-json", join(sb.root, "ask.json")], w).code, 1, "a picker question goes with needs-you");
});

test("--base takes a task, whose branch need not be pushed yet; a base that does not resolve writes nothing", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  sup.cli(["task", "new", "parent", "--repo", sb.main]);
  const parent = json(sup.cli(["task", "show", "t1", "--json"]));
  write(join(parent.worktree, "part1.txt"), "part 1\n");
  git(parent.worktree, "add", ".");
  git(parent.worktree, "commit", "-qm", "part 1");

  const unpushed = sup.cli(["task", "new", "child", "--repo", sb.main, "--base", `origin/${parent.branch}`]);
  assert.equal(unpushed.code, 1);
  assert.match(unpushed.stderr, /has no commit or branch origin\/feat\/parent\. A task that has not pushed goes by its id \(--base t4\); nothing was created/);
  assert.deepEqual(json(sup.cli(["task", "list", "--json"])).tasks.map((x) => x.id), ["t1"], "no record, no spent id");

  assert.equal(sup.cli(["task", "new", "child", "--repo", sb.main, "--after", "t1", "--base", "t1"]).code, 0);
  const child = json(sup.cli(["task", "show", "t2", "--json"]));
  assert.equal(child.base, parent.branch);
  assert.equal(child.baseSha, git(parent.worktree, "rev-parse", "HEAD"));

  assert.equal(sup.cli(["task", "new", "read only", "--repo", sb.main, "--no-worktree"]).code, 0);
  assert.match(sup.cli(["task", "new", "x", "--repo", sb.main, "--base", "t3"]).stderr, /--base t3: t3 works in the main checkout/);
});

test("text over a limit comes back with the limit: a worker's question, a decision, a note, a report and a handoff stay whole", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  sup.cli(["task", "new", "pin", "--repo", sb.main]);
  const w = workerEnv("alpha", "t1");
  const show = () => json(sup.cli(["task", "show", "t1", "--json"]));
  const ask = (question, label = "One", description = "") => {
    write(join(sb.root, "long.json"), JSON.stringify([{ question, options: [{ label, description }, { label: "Two" }] }]));
    return sup.cli(["task", "set", "t1", "--state", "needs-you", "--ask-json", join(sb.root, "long.json")], w);
  };
  assert.match(ask("x".repeat(1001)).stderr, /a question is 1001 characters, over the limit of 1000/);
  assert.match(ask("q", "x".repeat(81)).stderr, /the label of option "x+\.\.\." is 81 characters, over the limit of 80/);
  assert.match(ask("q", "One", "x".repeat(401)).stderr, /the description of option "One" is 401 characters, over the limit of 400/);
  assert.equal(show().state, "working");
  assert.deepEqual(wakes(sb, "alpha"), []);

  // AskUserQuestion: the hook refuses it back to the worker, and nothing reaches the task.
  const hook = (question) => JSON.parse(spawnSync(process.execPath, [BIN, "worker-hook", "alpha", "t1", "ask"], { input: JSON.stringify({ session_id: "s1", tool_name: "AskUserQuestion", tool_input: { questions: [{ question, options: [{ label: "One" }, { label: "Two" }] }] } }), env: sb.env, encoding: "utf8" }).stdout);
  const refused = hook("x".repeat(1001)).hookSpecificOutput;
  assert.equal(refused.permissionDecision, "deny");
  assert.match(refused.permissionDecisionReason, /did not go to the owner: a question is 1001 characters, over the limit of 1000\. Shorten it/);
  assert.equal(show().state, "working");
  const whole = "y".repeat(1000);
  assert.match(hook(whole).hookSpecificOutput.permissionDecisionReason, /went to the owner's picker/);
  assert.equal(show().ask.questions[0].question, whole, "a question at the limit goes whole");
  assert.equal(sup.cli(["task", "set", "t1", "--state", "working"], w).code, 0);

  assert.match(sup.cli(["task", "decisions", "add", "x".repeat(301)], w).stderr, /a decision is 301 characters, over the limit of 300/);
  assert.match(sup.cli(["task", "decisions", "add", "rotate the key", "--where", "x".repeat(201)], w).stderr, /--where is 201 characters, over the limit of 200/);
  assert.match(sup.cli(["task", "note", "t1", `reply: ${"x".repeat(4000)}`], w).stderr, /a note is 4007 characters, over the limit of 4000: shorten it, or save the whole text with `.*task output t1 --file <f>`/);
  assert.match(sup.cli(["task", "new", "x", "--repo", sb.main, "--note", "x".repeat(4001)]).stderr, /a note is 4001 characters, over the limit of 4000/);
  write(join(sb.root, "long.txt"), "x".repeat(50_001));
  assert.match(sup.cli(["task", "output", "t1", "--file", join(sb.root, "long.txt")], w).stderr, /a report is 50001 characters, over the limit of 50000/);
  assert.match(sup.cli(["task", "handoff", "t1", "--file", join(sb.root, "long.txt")], w).stderr, /a handoff is 50001 characters, over the limit of 50000/);
  assert.equal(show().output, null);
  assert.equal(show().notes.length, 0);
});

test("a wait on the owner names what it waits for: needs-you with no question is refused", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  sup.cli(["task", "new", "pin", "--repo", sb.main]);
  const w = workerEnv("alpha", "t1");
  const set = (...a) => sup.cli(["task", "set", "t1", ...a], w);
  const show = () => json(sup.cli(["task", "show", "t1", "--json"]));
  assert.match(set("--state", "needs-you").stderr, /needs-you takes the question: --question/);
  assert.equal(set("--state", "needs-you", "--question", "  ").code, 1);
  assert.equal(show().state, "working");
  assert.deepEqual(wakes(sb, "alpha"), []);
  assert.equal(set("--state", "needs-you", "--question", "Which header?").code, 0);
  assert.equal(set("--state", "needs-you", "--pr", "https://github.com/o/r/pull/9").code, 0, "it keeps the question it has");
  assert.equal(set("--question", "").code, 1, "and does not lose it");
  assert.equal(show().question, "Which header?");
});

test("only the worker's own AskUserQuestion asks the owner, and a turn that starts while the task waits on the owner hears so", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  sup.cli(["task", "new", "pin", "--repo", sb.main]);
  const hook = (event, payload) => {
    const r = spawnSync(process.execPath, [BIN, "worker-hook", "alpha", "t1", event], { input: JSON.stringify({ session_id: "s1", ...payload }), env: sb.env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  const show = () => json(sup.cli(["task", "show", "t1", "--json"]));
  const questions = [{ question: "Suggestion-mode reply?", header: "Suggest", options: [{ label: "Silent", description: "nothing to type" }, { label: "Ship it", description: "premature" }] }];

  // The prompt-suggestion pass Claude Code runs after a turn is a fork with an agent_id; so is a subagent.
  assert.equal(hook("ask", { tool_name: "AskUserQuestion", tool_input: { questions }, agent_id: "a7f3" }), null, "a fork's question is left to Claude Code");
  assert.equal(show().state, "working");
  assert.deepEqual(wakes(sb, "alpha"), [], "and wakes no one");

  const asked = hook("ask", { tool_name: "AskUserQuestion", tool_input: { questions } });
  assert.equal(asked.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(show().state, "needs-you");
  assert.deepEqual(wakes(sb, "alpha").map((x) => x.kind), ["ask"]);

  // Any turn that starts hears the question is still open. Only the transcript knows whose a prompt is, and only
  // after this hook, so the line allows for the owner's answer.
  const heard = hook("prompt-submit", { prompt: "<task-notification>done</task-notification>" }).hookSpecificOutput.additionalContext;
  assert.match(heard, /^\[rollcall\] Task t1 still waits on the owner \(needs-you\).*"Suggestion-mode reply\?".*rollcall task set t1 --state working/);
  assert.match(heard, /If this prompt is their answer, rollcall closes the question by itself\.$/);
  assert.equal(sup.cli(["task", "set", "t1", "--state", "working"], workerEnv("alpha", "t1")).code, 0);
  assert.equal(hook("prompt-submit", { prompt: "<task-notification>done</task-notification>" }), null, "once it clears, nothing to hear");
});

test("a dialog that opens behind another keeps the flag up until its own call ends", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  sup.cli(["task", "new", "pin", "--repo", sb.main]);
  const hook = (event, command) => {
    const r = spawnSync(process.execPath, [BIN, "worker-hook", "alpha", "t1", event], { input: JSON.stringify({ session_id: "s1", transcript_path: join(sb.root, "s1.jsonl"), tool_name: "Bash", tool_input: { command } }), env: sb.env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  const flag = join(sb.home, "_supervisors/alpha/workers/t1/dialog");
  const open = () => JSON.parse(readFileSync(flag, "utf8"));
  const opened = new Date(Date.now() - 3600_000);

  hook("dialog", "rm a");
  hook("dialog", "rm b");
  hook("dialog", "rm c");
  utimesSync(flag, opened, opened);
  assert.equal(open().what, "rm a", "the flag names the dialog on screen");

  hook("clear", "ls");
  assert.deepEqual([open().what, open().more.map((x) => x.what)], ["rm a", ["rm b", "rm c"]], "a call with no dialog changes nothing");
  hook("clear", "rm c");
  assert.deepEqual([open().what, open().more.map((x) => x.what)], ["rm a", ["rm b"]], "one that ends out of turn leaves the list");
  hook("clear", "rm a");
  assert.equal(existsSync(flag), true, "the next dialog waits, and Enter would approve it");
  assert.deepEqual([open().what, open().more], ["rm b", []]);
  assert.ok(Math.abs(statSync(flag).mtimeMs - opened.getTime()) < 2, "and the flag keeps the time its first dialog opened");
  hook("clear", "rm b");
  assert.equal(existsSync(flag), false);

  // Two calls with the same words are two dialogs, whichever ends first.
  hook("dialog", "rm a");
  hook("dialog", "rm b");
  hook("dialog", "rm a");
  hook("clear", "rm a");
  assert.deepEqual([open().what, open().more.map((x) => x.what)], ["rm b", ["rm a"]]);
  hook("clear", "rm a");
  assert.deepEqual([open().what, open().more], ["rm b", []]);
  hook("clear", "rm b");
  assert.equal(existsSync(flag), false);

  // An elicitation names no call: it ends with any call, but not before a dialog behind it.
  const bare = (event) => assert.equal(spawnSync(process.execPath, [BIN, "worker-hook", "alpha", "t1", event], { input: JSON.stringify({ session_id: "s1", transcript_path: join(sb.root, "s1.jsonl"), notification_type: "elicitation_dialog", message: "Pick one" }), env: sb.env, encoding: "utf8" }).status, 0);
  bare("dialog");
  hook("dialog", "rm a");
  hook("clear", "ls");
  assert.deepEqual([open().what, open().more], ["rm a", []], "any call ends the elicitation, and the dialog behind it is next");
  hook("clear", "rm a");
  assert.equal(existsSync(flag), false);
  hook("dialog", "rm a");
  bare("dialog");
  hook("clear", "rm a");
  assert.deepEqual([open().tool, open().message, open().more], [null, "Pick one", []], "the elicitation waits behind the call");
});

test("decisions left to the owner outlive their task: listed until answered, the answer back on the task they came from", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  sup.cli(["task", "new", "issue triage", "--repo", sb.main]);
  assert.match(sup.cli(["task", "decisions"]).stdout, /nothing waits on the owner/);
  const added = sup.cli(["task", "decisions", "add", "#381: keep the free tier at 3 connections?", "--where", "a comment on #381"], workerEnv("alpha", "t1"));
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stdout, /^d1: listed for the owner until answered/);
  assert.equal(sup.cli(["task", "decisions", "add", "which Plaid environment is real"]).code, 0);
  assert.match(sup.cli(["task", "decisions", "add"]).stderr, /usage: rollcall task decisions add/);
  assert.match(sup.cli(["task", "decisions", "add", "x", "--from", "t9"]).stderr, /no task t9 in supervisor alpha/);
  // The worker's decision is news for the supervisor; its own is not.
  assert.deepEqual(wakes(sb, "alpha").map((x) => [x.task, x.kind, x.n]), [["t1", "decision", 1]]);
  assert.equal(sup.cli(["task", "output", "t1", "Triaged #381; the free tier is the owner's call."], workerEnv("alpha", "t1")).code, 0);
  assert.equal(sup.cli(["task", "close", "t1", "triaged"], workerEnv("alpha", "t1")).code, 0);
  const listed = sup.cli(["task", "list"]).stdout;
  // A decision whose task finished may be settled already: the list says so.
  assert.match(listed, /Waiting on the owner, from every supervisor, until answered \(rollcall task decisions done <n>\):\n  d1  #381: keep the free tier at 3 connections\? - answer: a comment on #381 \(from yoda, just now; yoda is closed: check it still stands\)\n  d2  which Plaid environment is real \(just now\)/);
  assert.deepEqual(json(sup.cli(["task", "list", "--json"])).decisions.map((d) => [d.n, d.from]), [[1, "t1"], [2, null]]);

  const other = sb.session(sb.root);
  other.start();
  other.cli(["supervise", "beta"]);
  // Every supervisor shows the one list, and any of them can close an item on it.
  assert.match(other.cli(["task", "list"]).stdout, /d1  #381: .* \(alpha's from yoda, just now; yoda is closed: check it still stands\)\n  d2  which Plaid environment is real \(alpha, just now\)/);
  assert.match(other.cli(["task", "decisions", "add", "x", "--home", "alpha"]).stderr, /this session is supervisor beta/);
  assert.match(other.cli(["task", "decisions", "done", "9"]).stderr, /no open decision d9/);
  assert.match(other.cli(["task", "decisions", "done", "d1", "yes, keep 3"]).stdout, /^d1: answered: yes, keep 3/);
  assert.deepEqual(json(sup.cli(["task", "list", "--json"])).decisions.map((d) => d.n), [2]);
  assert.match(json(sup.cli(["task", "show", "t1", "--json"])).notes.at(-1).text, /^decided: #381: keep the free tier at 3 connections\? - yes, keep 3$/);
});

test("each home's decisions become one list, once, oldest first; a likely duplicate and a task long finished are flagged", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  const homes = join(sb.home, "_supervisors");
  const item = (n, text, at, from = null) => ({ n, text, where: null, from, at });
  write(join(homes, "alpha/decisions.json"), JSON.stringify({ seq: 9, items: [item(9, "newest of all", 3000)] }));
  write(join(homes, "ghost/decisions.json"), "{ not json");
  write(join(homes, "tantive/decisions.json"), JSON.stringify({ seq: 44, items: [
    item(43, "Set RAILWAY_DRAINING_SECONDS to about 30 on Railway staging and production when the restart fix is built", 1000, "t40"),
    item(44, "Before the restart build: set RAILWAY_DRAINING_SECONDS to about 30 on Railway staging and production", 2000),
  ] }));
  const listed = sup.cli(["task", "decisions"]).stdout;
  assert.match(listed, /d1  Set RAILWAY_DRAINING_SECONDS .* \(tantive's from [\w-]+, .*; [\w-]+ finished long ago: check it still stands\)/);
  assert.match(listed, /d2  Before the restart build: .* \(tantive, .*; reads like d1\)/);
  assert.match(listed, /d3  newest of all \(/);
  assert.ok(!existsSync(join(homes, "tantive/decisions.json")), "the home's list is gone: one place holds them");
  assert.equal(readFileSync(join(homes, "ghost/decisions.json.moved"), "utf8"), "{ not json", "one that cannot be read is kept whole");
  const dup = sup.cli(["task", "decisions", "add", "Set RAILWAY_DRAINING_SECONDS to 30 on Railway staging and production"]);
  assert.match(dup.stdout, /^d4: listed for the owner until answered\n  it reads like d1: "Set RAILWAY_DRAINING_SECONDS/);
  assert.match(dup.stdout, /task decisions done 4 "same as d1"/);
  assert.equal(JSON.parse(readFileSync(join(sb.home, "_machine/decisions.json"), "utf8")).seq, 4);
});

test("the first write to the decisions list, and the first prune of a dead home, each move what the homes hold", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  const homes = join(sb.home, "_supervisors");
  const old = (h, text) => write(join(homes, h, "decisions.json"), JSON.stringify({ seq: 1, items: [{ n: 1, text, where: null, from: null, at: 1000 }] }));
  old("alpha", "from before the move");
  assert.equal(sup.cli(["task", "decisions", "add", "a new one"]).code, 0);
  assert.deepEqual(json(sup.cli(["task", "list", "--json"])).decisions.map((d) => [d.n, d.text]), [[1, "from before the move"], [2, "a new one"]]);

  rmSync(join(sb.home, "_machine/decisions.json"));
  old("gone", "in a home a prune drops");
  const quiet = (Date.now() - 8 * 86400_000) / 1000;
  for (const f of ["decisions.json", "tasks"]) { try { utimesSync(join(homes, "gone", f), quiet, quiet); } catch {} }
  utimesSync(join(homes, "gone"), quiet, quiet);
  const later = sb.session(sb.main);
  later.start();
  assert.ok(!existsSync(join(homes, "gone", "decisions.json")));
  assert.ok(JSON.parse(readFileSync(join(sb.home, "_machine/decisions.json"), "utf8")).items.some((d) => d.text === "in a home a prune drops"));
});

test("task new: --ship and --until landed go on the record, and --no-repo works in a plain folder", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  assert.equal(sup.cli(["task", "new", "plan", "--repo", sb.main]).code, 0);
  assert.match(sup.cli(["task", "new", "x", "--repo", sb.main, "--until", "landed"]).stderr, /--until landed goes with --after <task>/);
  assert.match(sup.cli(["task", "new", "x", "--repo", sb.main, "--after", "t1", "--until", "merged"]).stderr, /--until takes one word: landed/);
  assert.match(sup.cli(["task", "new", "build", "--repo", sb.main, "--after", "t1", "--until", "landed", "--ship"]).stdout, /after: t1, once landed/);
  const child = json(sup.cli(["task", "show", "t2", "--json"]));
  assert.deepEqual([child.until, child.ship, child.after], ["landed", true, ["t1"]]);
  assert.match(sup.cli(["task", "new", "x", "--no-repo", "--repo", sb.main]).stderr, /--no-repo runs in a plain folder/);
  const made = sup.cli(["task", "new", "clean the disk", "--no-repo"]);
  assert.equal(made.code, 0, made.stderr);
  const job = json(sup.cli(["task", "show", "t3", "--json"]));
  assert.deepEqual([job.repo.key, job.repo.name, job.branch, job.worktree], [null, "no repo", null, join(sb.home, "_machine/jobs")]);
  assert.ok(existsSync(job.worktree));
  assert.match(sup.cli(["task", "list"]).stdout, /t3 +working +no repo/);
  assert.equal(sup.cli(["task", "output", "t3", "Freed 20 GB."], workerEnv("alpha", "t3")).code, 0);
  assert.equal(sup.cli(["task", "close", "t3"], workerEnv("alpha", "t3")).code, 0);
});

test("an option that merges never opens a picker, where Enter takes the first option", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  sup.cli(["task", "new", "header", "--repo", sb.main]);
  const ask = (options, multiSelect = false) => {
    write(join(sb.root, "ask.json"), JSON.stringify([{ question: "Ship it?", header: "Ship", multiSelect, options }]));
    assert.equal(sup.cli(["task", "set", "t1", "--state", "needs-you", "--ask-json", join(sb.root, "ask.json")], workerEnv("alpha", "t1")).code, 0);
    return json(sup.cli(["task", "show", "t1", "--json"])).ask.questions[0].options.map((o) => o.label);
  };
  assert.deepEqual(ask([{ label: "Ship it (Recommended)" }, { label: "Change something first" }]), ["Change something first", "Ship it (Recommended)"]);
  assert.deepEqual(ask([{ label: "Yes, merge it" }, { label: "Land it now" }, { label: "Hold it" }]), ["Hold it", "Yes, merge it", "Land it now"]);
  assert.deepEqual(ask([{ label: "Ship" }, { label: "Deploy" }]), ["Ship", "Deploy"], "nothing safe to put first");
  assert.deepEqual(ask([{ label: "Ship" }, { label: "Docs" }], true), ["Ship", "Docs"], "in a multi-select Enter picks nothing by itself");
  assert.deepEqual(ask([{ label: "Shipping label" }, { label: "Other" }]), ["Shipping label", "Other"], "a word that only starts the same stays");
});

test("task stage notes a ship's stage and counts a stage's time once the next starts; outside a task it does nothing", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  const plain = sup.cli(["task", "stage", "here", "checks"]);
  assert.deepEqual([plain.code, plain.stdout], [0, ""]);
  sup.cli(["task", "new", "header", "--repo", sb.main]);
  const w = workerEnv("alpha", "t1");
  assert.match(sup.cli(["task", "stage", "here"], w).stderr, /usage: rollcall task stage/);
  assert.match(sup.cli(["task", "stage", "here", "CI"], w).stdout, /^t1: stage: CI/);
  const at = json(sup.cli(["task", "show", "t1", "--json"])).stage.at;
  assert.equal(sup.cli(["task", "stage", "here", "CI"], w).code, 0);
  assert.equal(json(sup.cli(["task", "show", "t1", "--json"])).stage.at, at, "the same stage again starts nothing");
  assert.match(sup.cli(["task", "stage", "here", "merge queue"], w).stdout, /^t1: stage: merge queue/);
  assert.match(sup.cli(["task", "stage", "here", "done"], w).stdout, /stages done/);
  const task = json(sup.cli(["task", "show", "t1", "--json"]));
  assert.equal(task.stage, null);
  assert.equal(sup.cli(["task", "output", "t1", "Done."], w).code, 0);
  assert.equal(sup.cli(["task", "close", "t1"], w).code, 0);
  assert.equal(sup.cli(["task", "stage", "t1", "done"], w).code, 0, "the shipper's last line may come after the landing");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(sb.home, task.repo.key, "stages.json"), "utf8"))), ["CI", "merge queue"]);
});

test("a supervisor sent to the background keeps its home under its new id, and its old record blocks nobody", (t) => {
  const sb = sandbox(t);
  const first = sb.session(sb.root);
  first.start();
  assert.equal(first.cli(["supervise", "alpha"]).code, 0);
  assert.equal(first.cli(["task", "new", "next apps", "--repo", sb.main]).code, 0);

  // Sent to the background: a new process under a new id. The old process lives on (as the agent view), so its pid says nothing.
  const next = sb.session(sb.root);
  continuedIn(sb, first, next.id);
  assert.match(next.start().context, new RegExp(`continues supervisor alpha \\(session ${first.short} was sent to the background\\), so it runs alpha now: t1`));
  assert.equal(json(next.cli(["status", "--json"], { cwd: sb.root })).me.home, "alpha");
  assert.equal(json(next.cli(["task", "show", "t1", "--json"])).title, "next apps");
  assert.ok(denied(next.pre(join(sb.main, "src/a.js"))), "still a supervisor");

  // Any session sent to the background: the record it left behind does not block the session it became.
  const dev = sb.session(sb.main);
  dev.start();
  dev.edit(join(sb.main, "src/b.js"));
  const after = sb.session(sb.main);
  continuedIn(sb, dev, after.id);
  after.start();
  assert.ok(!denied(after.pre(join(sb.main, "src/b.js"))));
});

function continuedIn(sb, s, next) {
  write(join(sb.root, "transcripts", `${s.id}.jsonl`), [
    JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "/supervisor" }, sessionId: s.id }),
    JSON.stringify({ type: "continued-in", timestamp: new Date().toISOString(), sessionId: s.id, continuedInSessionId: next }),
    "",
  ].join("\n"));
}

test("gc keeps an open task's worktree until its branch's work is on main, whatever the task's state", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  sup.cli(["task", "new", "squashed", "--repo", sb.main]);
  sup.cli(["task", "new", "idle", "--repo", sb.main]);
  const wt = join(sb.main, ".claude/worktrees/squashed");
  write(join(wt, "src/s.js"), "s\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "s");

  let out = sup.cli(["gc"], { cwd: sb.main }).stdout;
  assert.match(out, /kept squashed \(feat\/squashed\): task t1 is open \(working\)/);
  assert.match(out, /kept idle \(feat\/idle\): task t2 is open \(working\)/, "a fresh task worktree, on main because it has no commit yet, survives gc");

  // A squash merge: main gets the same content in a commit the branch does not have. The task never said pr-open.
  const other = sb.otherClone();
  write(join(other, "src/s.js"), "s\n");
  git(other, "add", ".");
  git(other, "commit", "-qm", "squash of #7");
  git(other, "push", "-q", "origin", "main");
  git(sb.main, "fetch", "-q", "origin");
  // The idle task's worker brings its branch up to main before its first commit: its HEAD is on main now,
  // but none of that is its own work.
  git(join(sb.main, ".claude/worktrees/idle"), "merge", "-q", "--ff-only", "origin/main");

  out = sup.cli(["gc"], { cwd: sb.main }).stdout;
  assert.match(out, /removed 1 merged worktree .*: squashed/);
  assert.match(out, /kept idle .*task t2 is open/);
  assert.equal(json(sup.cli(["task", "show", "t2", "--json"])).state, "working", "a branch that only caught up with main has not landed");
  assert.ok(!existsSync(wt));
  const t1 = json(sup.cli(["task", "show", "t1", "--json"]));
  assert.equal(t1.state, "landed");
  assert.match(t1.notes.at(-1).text, /landed: content in origin\/main/);
  assert.match(t1.output.text, /^rollcall marked this task landed: content in origin\/main\. No worker ran it, so nothing confirms its after-merge steps ran/);
  assert.deepEqual(wakes(sb, "alpha").map((x) => [x.task, x.kind]), [["t1", "landed"]]);

  // rollcall's own report is not a worker's: a worker that finishes the reopened task still reports first.
  const w = workerEnv("alpha", "t1");
  assert.equal(sup.cli(["task", "set", "t1", "--state", "pr-open", "--pr", "https://github.com/o/r/pull/8"], w).code, 0);
  assert.match(sup.cli(["task", "set", "t1", "--state", "landed"], w).stderr, /t1 is not landed yet: save your report first/);
  assert.equal(sup.cli(["task", "output", "t1", "The second PR is on main."], w).code, 0);
  assert.equal(sup.cli(["task", "set", "t1", "--state", "landed"], w).code, 0);
});

test("gc lands a merged task once: never one waiting on the owner, and never over a state set after it saw the merge", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  sup.cli(["task", "new", "asks", "--repo", sb.main]);
  sup.cli(["task", "new", "reopened", "--repo", sb.main]);
  const other = sb.otherClone();
  for (const name of ["asks", "reopened"]) {
    const wt = join(sb.main, `.claude/worktrees/${name}`);
    write(join(wt, `src/${name}.js`), `${name}\n`);
    git(wt, "add", ".");
    git(wt, "commit", "-qm", name);
    write(join(other, `src/${name}.js`), `${name}\n`);
  }
  // Both squash-merged; the second worktree keeps a scratch file, so gc keeps it after the landing.
  git(other, "add", ".");
  git(other, "commit", "-qm", "squash of #7 and #8");
  git(other, "push", "-q", "origin", "main");
  git(sb.main, "fetch", "-q", "origin");
  write(join(sb.main, ".claude/worktrees/reopened/scratch.txt"), "x\n");
  // The first task's worker asked the owner something after the merge (may it deploy staging?).
  assert.equal(sup.cli(["task", "set", "t1", "--state", "needs-you", "--question", "deploy staging?"], workerEnv("alpha", "t1")).code, 0);

  assert.match(sup.cli(["gc", "--dry-run"], { cwd: sb.main }).stdout, /kept asks \(feat\/asks\): task t1 is open \(needs-you\): it waits on the owner/);
  assert.equal(json(sup.cli(["task", "show", "t1", "--json"])).merged, undefined, "a dry run writes nothing");
  let out = sup.cli(["gc"], { cwd: sb.main }).stdout;
  assert.match(out, /kept asks \(feat\/asks\): task t1 is open \(needs-you\): it waits on the owner/);
  assert.match(out, /kept reopened \(feat\/reopened\): uncommitted changes/);
  let t1 = json(sup.cli(["task", "show", "t1", "--json"]));
  assert.equal(t1.state, "needs-you");
  assert.equal(t1.question, "deploy staging?");
  assert.equal(t1.notes.at(-1).text, "merge seen (content in origin/main); the task stays needs-you: it waits on the owner");
  assert.equal(json(sup.cli(["task", "show", "t2", "--json"])).state, "landed");

  // The owner answers t1 (back to working), and the supervisor sets t2 back to working: both stand.
  assert.equal(sup.cli(["task", "words", "t1", "yes, once Railway is back"]).code, 0);
  assert.equal(sup.cli(["task", "set", "t2", "--state", "working"]).code, 0);
  out = sup.cli(["gc"], { cwd: sb.main }).stdout;
  assert.match(out, /kept asks .*: task t1 is open \(working\): it was set working after its merge/);
  assert.match(out, /kept reopened .*: task t2 is open \(working\): it was set working after its merge/);
  t1 = json(sup.cli(["task", "show", "t1", "--json"]));
  assert.equal(t1.state, "working");
  assert.equal(t1.notes.filter((n) => /^merge seen/.test(n.text)).length, 1, "one note per merge");
  assert.equal(json(sup.cli(["task", "show", "t2", "--json"])).state, "working");
  assert.deepEqual(wakes(sb, "alpha").filter((x) => x.kind === "landed").map((x) => x.task), ["t2"], "landed once");
});

test("every task command takes --help; task new: an unknown flag is no title, --note and --kind discuss go on the record", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  for (const sub of ["new", "list", "show", "set", "words", "note", "output", "tell", "close", "move"]) {
    const help = sup.cli(["task", sub, "--help"]);
    assert.equal(help.code, 0, sub);
    assert.match(help.stdout, /rollcall task new "<title>"/, sub);
  }
  assert.equal(sup.cli(["task", "bogus"]).code, 1);
  assert.equal(sup.cli(["task", "new", "--bogus", "x", "--repo", sb.main]).code, 1);
  assert.match(sup.cli(["task", "list"]).stdout, /no tasks in supervisor alpha/, "neither made a task");

  const made = sup.cli(["task", "new", "next apps", "--repo", sb.main, "--kind", "discuss", "--note", "Context: T10 merges the GitHub connections"]);
  assert.match(made.stdout, /^t1: "next apps" in origin \(a discussion\)/);
  const task = json(sup.cli(["task", "show", "t1", "--json"]));
  assert.equal(task.kind, "discuss");
  assert.deepEqual(task.notes.map((n) => n.text), ["Context: T10 merges the GitHub connections"]);
  assert.equal(sup.cli(["task", "new", "x", "--repo", sb.main, "--kind", "chat"]).code, 1);
});

test("a task moves to another supervisor under that home's next id, and only by an explicit move", (t) => {
  const sb = sandbox(t);
  const alpha = sb.session(sb.root);
  alpha.start();
  alpha.cli(["supervise", "alpha"]);
  alpha.cli(["task", "new", "header", "--repo", sb.main, "--words", "make it professional"]);
  const beta = sb.session(sb.root);
  beta.start();
  beta.cli(["supervise", "beta"]);
  beta.cli(["task", "new", "export", "--repo", sb.main]);
  alpha.cli(["task", "tell", "t1", "unread note"]);
  const moved = alpha.cli(["task", "move", "t1", "--to", "beta"]);
  assert.equal(moved.code, 0, moved.stderr);
  assert.match(moved.stdout, /^alpha:t1 is now beta:t2 \("header"\)/);
  const there = json(beta.cli(["task", "show", "t2", "--json"]));
  assert.equal(there.words[0].text, "make it professional");
  assert.match(there.notes.at(-1).text, /moved from supervisor alpha, where it was t1/);
  assert.equal(json(alpha.cli(["task", "show", "t1", "--json"])).state, "closed");
  assert.match(beta.cli(["inbox"], workerEnv("beta", "t2")).stdout, /unread note/, "its unread messages go along");
});

test("a home no live session holds refuses no move, and a moved task's decisions go with it", (t) => {
  const sb = sandbox(t);
  const alpha = sb.session(sb.root);
  alpha.start();
  alpha.cli(["supervise", "alpha"]);
  alpha.cli(["task", "new", "header", "--repo", sb.main]);
  alpha.cli(["task", "new", "footer", "--repo", sb.main]);
  alpha.cli(["task", "decisions", "add", "keep the free tier?"], workerEnv("alpha", "t1"));
  alpha.cli(["task", "decisions", "add", "which font?"], workerEnv("alpha", "t2"));
  alpha.cli(["task", "decisions", "add", "rotate the key"]);
  const beta = sb.session(sb.root);
  beta.start();
  beta.cli(["supervise", "beta"]);
  beta.cli(["task", "new", "export", "--repo", sb.main]);
  beta.cli(["task", "decisions", "add", "beta's own"]);

  // While alpha lives the move is refused, and a move by its holder takes the task's own decisions along.
  const list = () => json(beta.cli(["task", "list", "--json"])).decisions.map((d) => [d.n, d.text, d.home, d.from]);
  assert.equal(beta.cli(["task", "move", "t1", "--to", "beta", "--home", "alpha"]).code, 1);
  assert.equal(alpha.cli(["task", "move", "t2", "--to", "beta"]).code, 0);
  assert.deepEqual(list(), [[1, "keep the free tier?", "alpha", "t1"], [2, "which font?", "beta", "t2"], [3, "rotate the key", "alpha", null], [4, "beta's own", "beta", null]]);

  // alpha's session ends in a reboot: its id now runs something else, and its record says so by the start time.
  const file = join(sb.home, "_sessions", `${alpha.id}.json`);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  write(file, JSON.stringify({ ...rec, pidStart: rec.pidStart - 60_000 }));
  const moved = beta.cli(["task", "move", "t1", "--to", "beta", "--home", "alpha"]);
  assert.equal(moved.code, 0, moved.stderr);
  assert.deepEqual(list(), [[1, "keep the free tier?", "beta", "t3"], [2, "which font?", "beta", "t2"], [3, "rotate the key", "alpha", null], [4, "beta's own", "beta", null]]);
});

test("v2's global tasks move to the default home once, ids and counter kept, their background workers marked v2", (t) => {
  const sb = sandbox(t);
  const old = join(sb.home, "_tasks");
  write(join(old, "t7.json"), JSON.stringify({ id: "t7", n: 7, title: "ios speed", kind: "build", state: "pr-open", words: [], notes: [], sessions: [{ id: "aaaabbbb-1111", at: 1, endedAt: null }], repo: { key: "k", name: "acme", main: sb.main }, worktree: sb.main, supervisor: { id: "x", name: "y" } }));
  write(join(old, "seq"), "10");
  const sup = sb.session(sb.root);
  sup.start();
  const on = sup.cli(["supervise", "default"]);
  assert.match(on.stdout, /is supervisor default.*\n  Tabs: .*\n  1 open task: rollcall task list\n  t7 still has a v2 worker \(claude --bg\)/);
  assert.ok(!existsSync(old));
  const t7 = json(sup.cli(["task", "show", "t7", "--json"]));
  assert.equal(t7.home, "default");
  assert.equal(t7.worker.legacy, true);
  assert.equal(t7.supervisor, undefined);
  assert.match(sup.cli(["task", "new", "next", "--repo", sb.main, "--no-worktree"]).stdout, /^t11: /, "the counter carries on");
});

test("the band and rollcall agree on the band protocol", () => {
  const band = readFileSync(new URL("../../../mods/rollcall-band/hooks/register.tsx", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../src/cli.mjs", import.meta.url), "utf8");
  const of = (src) => /const BAND_PROTOCOL = (\d+)/.exec(src)?.[1];
  assert.ok(of(band));
  assert.equal(of(band), of(cli));
});

test("a supervisor hears once when the skill it loaded changed under it", (t) => {
  const sb = sandbox(t);
  const skill = join(sb.root, "SKILL.md");
  write(skill, "v1\n");
  const sup = sb.session(sb.root);
  sup.env = { ...sup.env, ROLLCALL_SUPERVISOR_SKILL: skill };
  sup.start();
  assert.equal(sup.cli(["supervise"]).code, 0);
  assert.doesNotMatch(sup.prompt("hello").context ?? "", /skill changed/);
  write(skill, "v2\n");
  assert.match(sup.prompt("next").context, /The \/supervisor skill changed since this session loaded it .*Read .*SKILL\.md again/);
  assert.doesNotMatch(sup.prompt("again").context ?? "", /skill changed/, "once per change");
});

test("a worker saves its report before it finishes its task; the supervisor and rollcall's own landing need none", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  sup.cli(["task", "new", "header", "--repo", sb.main]);
  sup.cli(["task", "new", "footer", "--repo", sb.main]);
  const w = workerEnv("alpha", "t1");
  const landed = sup.cli(["task", "set", "t1", "--state", "landed"], w);
  assert.equal(landed.code, 1);
  assert.match(landed.stderr, /t1 is not landed yet: save your report first, then set landed again\. `.*task output t1 --file <f>` with what the owner needs from this task: what now works/);
  assert.match(sup.cli(["task", "close", "t1"], w).stderr, /t1 is not closed yet: save your report first/);
  assert.equal(json(sup.cli(["task", "show", "t1", "--json"])).state, "working");
  assert.deepEqual(wakes(sb, "alpha"), [], "a refused finish is no news");
  assert.equal(sup.cli(["task", "output", "t1", "The header reads Messages. Check it in TestFlight build 94."], w).code, 0);
  assert.equal(sup.cli(["task", "set", "t1", "--state", "landed"], w).code, 0);
  assert.deepEqual(wakes(sb, "alpha").map((x) => x.kind), ["landed"]);
  assert.equal(sup.cli(["task", "close", "t2", "not needed"]).code, 0, "the supervisor closes a task without a report");
});

test("a finished task stays finished for its worker: only a new PR opens it, and the supervisor may", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  sup.cli(["task", "new", "header", "--repo", sb.main]);
  const w = workerEnv("alpha", "t1");
  const state = () => json(sup.cli(["task", "show", "t1", "--json"])).state;
  assert.equal(sup.cli(["task", "output", "t1", "Shipped."], w).code, 0);
  assert.equal(sup.cli(["task", "set", "t1", "--state", "landed"], w).code, 0);
  for (const args of [["--state", "working"], ["--state", "closed"], ["--state", "needs-you", "--question", "and the footer?"]]) {
    const r = sup.cli(["task", "set", "t1", ...args], w);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /t1 is landed and stays so: its worker answers with `.*task note t1 "reply: <answer>"` and reports nothing else/);
  }
  assert.match(sup.cli(["task", "close", "t1"], w).stderr, /t1 is landed and stays so/);
  assert.equal(state(), "landed");
  assert.equal(sup.cli(["task", "set", "t1", "--state", "landed"], w).code, 0, "the same state again is no move");
  const asked = spawnSync(process.execPath, [BIN, "worker-hook", "alpha", "t1", "ask"], { input: JSON.stringify({ session_id: "s1", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "And the footer?", options: [{ label: "Yes" }, { label: "No" }] }] } }), env: sb.env, encoding: "utf8" });
  assert.match(JSON.parse(asked.stdout).hookSpecificOutput.permissionDecisionReason, /did not go to the owner: task t1 is landed, and a finished task asks nothing\. Put it in a reply/);
  assert.equal(state(), "landed");
  assert.equal(sup.cli(["task", "set", "t1", "--state", "pr-open", "--pr", "https://github.com/o/r/pull/8"], w).code, 0, "a new PR opens it");
  assert.equal(state(), "pr-open");
  assert.equal(sup.cli(["task", "set", "t1", "--state", "landed"], w).code, 0);
  assert.equal(sup.cli(["task", "set", "t1", "--state", "working"]).code, 0, "the supervisor reopens it");
  assert.equal(state(), "working");
});

test("gh pr create in a task's worktree puts the PR on its record and opens a finished task again; closed waits while the branch has an open PR", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  sup.cli(["task", "new", "header", "--repo", sb.main]);
  sup.cli(["task", "new", "pick a chart library", "--repo", sb.main, "--kind", "discuss"]);
  const show = (id) => json(sup.cli(["task", "show", id, "--json"]));
  const created = (id, stdout, command = "gh pr create --fill") =>
    sup.hook("post-tool-use", "PostToolUse", { tool_name: "Bash", tool_input: { command }, tool_response: { stdout, stderr: "" }, cwd: show(id).worktree }, { ROLLCALL_TASK: `alpha:${id}` });
  // A shipper told to leave task state alone still runs gh pr create in the worktree.
  created("t1", "Creating pull request for feat/header into main\n\nhttps://github.com/o/r/pull/7\n");
  assert.equal(show("t1").state, "pr-open");
  assert.equal(show("t1").pr, "https://github.com/o/r/pull/7");
  assert.match(show("t1").notes.at(-1).text, /^PR opened: https:\/\/github\.com\/o\/r\/pull\/7$/);
  assert.deepEqual(wakes(sb, "alpha").map((x) => [x.task, x.kind]), [["t1", "pr-open"]]);
  created("t1", "https://github.com/o/r/pull/7\n");
  assert.equal(wakes(sb, "alpha").length, 1, "the same PR again is no news");
  // Landed, then gh pr create again prints the PR that exists: the task stays landed.
  assert.equal(sup.cli(["task", "output", "t1", "Shipped."], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  assert.equal(sup.cli(["task", "set", "t1", "--state", "landed"], { env: { ROLLCALL_TASK: "alpha:t1" } }).code, 0);
  created("t1", "a pull request for branch \"feat/header\" into branch \"main\" already exists:\nhttps://github.com/o/r/pull/7\n");
  assert.equal(show("t1").state, "landed");
  assert.equal(sup.cli(["task", "set", "t1", "--state", "pr-open"]).code, 0, "back to pr-open for the close check below");
  created("t1", "https://github.com/o/r/pull/8\n", "gh pr view 8");
  assert.equal(show("t1").pr, "https://github.com/o/r/pull/7", "only gh pr create counts");
  // A discussion the owner turned into a build in its own window, after it closed: open again, with its PR.
  assert.equal(sup.cli(["task", "close", "t2", "answered"]).code, 0);
  created("t2", "https://github.com/o/r/pull/9\n");
  assert.equal(show("t2").state, "pr-open");
  assert.match(show("t2").notes.at(-1).text, /\(the task was closed: open again\)$/);

  // While gh says its branch has an open PR, the task does not close.
  const gh = join(sb.root, "fake-gh");
  write(gh, `#!/bin/sh\ncase "$*" in *"pr list"*) echo '[{"url":"https://github.com/o/r/pull/7"}]';; *) echo '[]';; esac\n`);
  spawnSync("chmod", ["+x", gh]);
  const env = { env: { ROLLCALL_GH: gh } };
  const refused = sup.cli(["task", "close", "t1"], env);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /t1's branch has an open PR \(https:\/\/github\.com\/o\/r\/pull\/7\): it is not closed while that PR is open/);
  assert.equal(sup.cli(["task", "set", "t1", "--state", "closed"], env).code, 1);
  assert.equal(show("t1").state, "pr-open");
});

test("task new --worktree takes over an existing worktree on its branch; --model and --effort go on the record, checked", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  sup.cli(["supervise", "alpha"]);
  const mine = join(sb.main, ".claude/worktrees/mine");
  git(sb.main, "worktree", "add", "-q", mine, "-b", "feat/mine", "origin/main");
  write(join(mine, "src/c.js"), "c\n");
  git(mine, "add", ".");
  git(mine, "commit", "-qm", "started");
  const made = sup.cli(["task", "new", "carry on", "--worktree", mine, "--model", "sonnet", "--effort", "low"]);
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, /worktree: .*mine \(feat\/mine, taken over as it was\)/);
  const task = json(sup.cli(["task", "show", "t1", "--json"]));
  assert.equal(task.worktree, mine);
  assert.equal(task.branch, "feat/mine");
  assert.equal(task.baseSha, git(sb.main, "rev-parse", "origin/main"), "where its branch left main");
  assert.deepEqual([task.model, task.effort], ["sonnet", "low"]);
  assert.match(sup.cli(["task", "new", "again", "--worktree", mine]).stderr, /mine is already task t1's, of supervisor alpha/);
  assert.match(sup.cli(["task", "new", "main", "--worktree", sb.main]).stderr, /--worktree takes a worktree of origin \(not its main checkout\)/);
  assert.match(sup.cli(["task", "new", "x", "--repo", sb.main, "--model", "opus; rm -rf ~"]).stderr, /--model is a model alias or id/);
  assert.match(sup.cli(["task", "new", "x", "--repo", sb.main, "--effort", "huge"]).stderr, /--effort is one of low, medium, high, xhigh, max/);
});

test("a finished task's record goes after two days; what it left for the owner stays for good, its report with it", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  assert.equal(sup.cli(["task", "new", "audit", "--repo", sb.main]).code, 0);
  assert.equal(sup.cli(["task", "output", "t1", "The audit found two holes."]).code, 0);
  assert.equal(sup.cli(["task", "set", "t1", "--state", "closed"]).code, 0);
  const home = join(sb.home, "_supervisors/alpha");
  const old = (Date.now() - 60 * 86400_000) / 1000;
  // Its folder, and one whose record went long ago: nothing but a date to go on.
  for (const id of ["t1", "t0"]) {
    write(join(home, "files", id, "audit.md"), "the deliverable\n");
    utimesSync(join(home, "files", id, "audit.md"), old, old);
    utimesSync(join(home, "files", id), old, old);
  }
  const record = join(home, "tasks/t1.json");
  write(record, JSON.stringify({ ...JSON.parse(readFileSync(record, "utf8")), updatedAt: Date.now() - 3 * 86400_000 }));

  sb.session(sb.main).start();
  assert.ok(!existsSync(record), "the record went");
  assert.equal(readFileSync(join(home, "files/t1/audit.md"), "utf8"), "the deliverable\n");
  assert.equal(readFileSync(join(home, "files/t0/audit.md"), "utf8"), "the deliverable\n");
  assert.equal(readFileSync(join(home, "files/t1/task-report.md"), "utf8"), "The audit found two holes.");
});

test("a home quiet for a week closes its open tasks, then drops all but its files and seq; a live session keeps it, and its decisions stay on the list", (t) => {
  const sb = sandbox(t);
  const sup = sb.session(sb.root);
  sup.start();
  const homes = join(sb.home, "_supervisors");
  const old = (Date.now() - 8 * 86400_000) / 1000;
  /** Everything in a home, its files aside, last changed eight days ago. */
  const age = (h, dir = join(homes, h)) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.name !== "files" && e.isDirectory()) age(h, join(dir, e.name));
    for (const n of readdirSync(dir)) if (n !== "files") utimesSync(join(dir, n), old, old);
    utimesSync(dir, old, old);
  };
  const sweep = () => sb.session(sb.main).start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  assert.equal(sup.cli(["task", "new", "stale work", "--repo", sb.main]).code, 0);
  assert.equal(sup.cli(["task", "set", "t1", "--state", "needs-you", "--question", "still there?"]).code, 0);
  write(join(homes, "alpha/files/t1/audit.md"), "the deliverable\n");
  assert.equal(sup.cli(["task", "decisions", "add", "pick a name"]).code, 0);
  assert.equal(sup.cli(["supervise", "beta"]).code, 0, "alpha has no live session now");

  // The session holding a home keeps it however quiet.
  age("beta");
  sweep();
  assert.ok(existsSync(join(homes, "beta/lock.json")));

  // A quiet week: the open task closes.
  age("alpha");
  sweep();
  const task = JSON.parse(readFileSync(join(homes, "alpha/tasks/t1.json"), "utf8"));
  assert.equal(task.state, "closed");
  assert.equal(task.question, null);
  assert.match(task.notes.at(-1).text, /gone for a week/);

  // Two days on the record goes; a quiet week later the home goes, its files and seq left, and the owner's decision stays.
  const rec = join(homes, "alpha/tasks/t1.json");
  write(rec, JSON.stringify({ ...JSON.parse(readFileSync(rec, "utf8")), updatedAt: Date.now() - 3 * 86400_000 }));
  sweep();
  age("alpha");
  sweep();
  assert.deepEqual(readdirSync(join(homes, "alpha")).sort(), ["files", "seq"]);
  assert.match(json(sup.cli(["task", "list", "--json", "--home", "beta"])).decisions[0].text, /pick a name/);
  assert.equal(readFileSync(join(homes, "alpha/files/t1/audit.md"), "utf8"), "the deliverable\n");
  assert.equal(readFileSync(join(homes, "alpha/seq"), "utf8").trim(), "1");

  // A name used again carries on from its seq: its new task never lands in the old task's folder.
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  assert.match(sup.cli(["task", "new", "new work", "--repo", sb.main]).stdout, /^t2: /);

  // A home with no files goes altogether.
  assert.equal(sup.cli(["supervise", "gamma"]).code, 0);
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  age("gamma");
  sweep();
  assert.ok(!existsSync(join(homes, "gamma")));
});
