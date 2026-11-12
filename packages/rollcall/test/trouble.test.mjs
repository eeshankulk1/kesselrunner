// Done when: what stops work is one record per cause: the owner hears of it once however many workers or watchers
// meet it, it closes by itself when the cause is gone, and rollcall holds nothing back to prevent it; a usage limit's
// reset time reads right in the owner's zone; gc removes what ended work surely left behind and only that, a low
// disk's list deletes nothing until the owner says so, and neither reaches the machine from a store not its own.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deleteList, sweepLeftovers } from "../src/leftovers.mjs";
import * as store from "../src/store.mjs";
import { SPOTLIGHT_FIX, assess, clock, closeBlocker, lines, look, openBlocker, openBlockers, resetAt, waitLabel } from "../src/trouble.mjs";
import { BIN, cleanEnv, sandbox, until, write } from "./helpers.mjs";

const PDT = (d, h, m = 0) => Date.UTC(2026, 9, d, h + 7, m);
const NOW = PDT(30, 12);
/** The time of this file's looks, which only ever moves on: `look` keeps the last one in memory. */
let at = Date.now();
const later = (ms = 120_000) => (at += ms);

test("assess: what the machine's facts open and close", () => {
  const ac = { on: "ac" };
  const low = { on: "battery", pct: 15 };
  const fine = { on: "battery", pct: 80 };
  const rows = [
    [{ diskGb: 40 }, {}, [], []],
    [{ diskGb: 9 }, {}, [{ kind: "disk", gb: 9, full: false }], []],
    [{ diskGb: 1.5 }, {}, [{ kind: "disk", gb: 1.5, full: true }], []],
    // Room for a while before it closes, so a disk at the line is not news every minute.
    [{ diskGb: 12 }, { disk: {} }, [{ kind: "disk", gb: 12, full: false }], []],
    [{ diskGb: 15 }, { disk: {} }, [], ["disk"]],
    [{ power: fine }, {}, [], []],
    [{ power: low }, {}, [{ kind: "power", pct: 15, low: true, shipping: false }], []],
    [{ power: fine, shipping: true }, {}, [{ kind: "power", pct: 80, low: false, shipping: true }], []],
    [{ power: fine }, { power: {} }, [], ["power"]],
    // A worker that waits on power waits for the plug, not for the charge.
    [{ power: fine }, { power: { waited: true } }, [{ kind: "power", pct: 80, low: false, shipping: false }], []],
    [{ power: ac }, { power: { waited: true } }, [], ["power"]],
    [{ memoryPct: 8 }, {}, [{ kind: "memory", pct: 8 }], []],
    [{ memoryPct: 15 }, { memory: {} }, [], []],
    [{ memoryPct: 25 }, { memory: {} }, [], ["memory"]],
    // Spotlight read-only is its own cause: the disk having room again does not close it, only mdutil saying so.
    [{ spotlightReadOnly: true }, {}, [{ kind: "spotlight" }], []],
    [{ spotlightReadOnly: true, diskGb: 40 }, { spotlight: {} }, [], []],
    [{ spotlightReadOnly: null }, { spotlight: {} }, [], []],
    [{ spotlightReadOnly: false }, { spotlight: {} }, [], ["spotlight"]],
  ];
  for (const [facts, open, want, gone] of rows) assert.deepEqual(assess(facts, open, NOW), { want, gone }, JSON.stringify([facts, open]));
  assert.deepEqual(assess({}, {}, NOW), { want: [], gone: [] }, "a machine that says nothing changes nothing");
  // A usage limit closes a little after its reset, so Claude Code's own continue goes first.
  assert.deepEqual(assess({}, { usage: { until: NOW - 60_000 } }, NOW).gone, []);
  assert.deepEqual(assess({}, { usage: { until: NOW - 3 * 60_000 } }, NOW).gone, ["usage"]);
  assert.deepEqual(assess({}, { usage: { since: NOW - 10 * 60_000 } }, NOW).gone, [], "no reset time: it tries again soon, not at once");
  assert.deepEqual(assess({}, { usage: { since: NOW - 18 * 60_000 } }, NOW).gone, ["usage"]);
});

test("resetAt reads Claude Code's limit lines, in the zone they name", () => {
  const session = (t) => `You've hit your session limit · resets ${t} (America/Los_Angeles)`;
  assert.equal(resetAt(session("2:20pm"), NOW), PDT(30, 14, 20));
  assert.equal(resetAt(session("2pm"), NOW), PDT(30, 14));
  assert.equal(resetAt(session("12am"), NOW), PDT(31, 0), "a time already past is the next one");
  assert.equal(resetAt(session("11am"), NOW), PDT(31, 11));
  assert.equal(resetAt("You've hit your weekly limit · resets Nov 3 at 11am (America/Los_Angeles)", NOW), Date.UTC(2026, 10, 3, 19), "across the clock change");
  assert.equal(resetAt("You've hit your weekly limit · resets Oct 21 at 11am (America/Los_Angeles)", NOW), Date.UTC(2027, 9, 21, 18), "next year's");
  assert.equal(resetAt("hit your limit · resets 9am (Asia/Tokyo)", PDT(30, 12)), Date.UTC(2026, 9, 31, 0));
  assert.equal(resetAt("hit your limit · resets 9am (Not/AZone)", NOW) > NOW, true, "a zone it cannot read falls back to the Mac's");
  assert.equal(resetAt("API Error: Rate limit reached", NOW), null);
  assert.equal(resetAt(undefined, NOW), null);
});

test("a task's tab says what it waits on", () => {
  const until = Date.UTC(2026, 9, 30, 21, 20);
  assert.match(clock(until, until - 3600_000), /^\d{1,2}:20 [AP]M$/, "plain spaces, for a terminal");
  assert.match(clock(until, until - 3 * 86400_000), /^Oct 3\d, \d{1,2}:20 [AP]M$/);
  assert.match(waitLabel({ on: "usage", until }, until - 3600_000), /^paused until \d{1,2}:20 [AP]M$/);
  assert.equal(waitLabel({ on: "usage" }), "paused at the usage limit");
  assert.equal(waitLabel({ on: "disk" }), "waits on disk space");
  assert.equal(waitLabel({ on: null, check: "curl -f https://status.example.com" }), "waits on `curl -f https://status.example.com`");
  assert.equal(waitLabel({ on: null, check: "curl", why: "the Railway outage" }), "waits on the Railway outage");
});

/** This process on a sandbox's store, with the machine's facts from a file and notifications in a log. */
function machine(t) {
  const sb = sandbox(t);
  const facts = join(sb.root, "facts.json");
  const log = join(sb.root, "notify.log");
  const env = { ROLLCALL_HOME: sb.home, ROLLCALL_MACHINE_FACTS: facts, ROLLCALL_NOTIFY_LOG: log, ROLLCALL_TROUBLE_LOOK_MS: "1" };
  const was = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  return {
    sb, env, setFacts: (f) => writeFileSync(facts, JSON.stringify(f)),
    notes: () => { try { return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } },
  };
}

test("a cause is one notice however many look, and one that comes back soon is no news", (t) => {
  const m = machine(t);
  const next = () => look(later());
  m.setFacts({ power: { on: "battery", pct: 12 } });
  next();
  next();
  assert.equal(m.notes().length, 1);
  assert.match(m.notes()[0].text, /on battery at 12%/);
  assert.deepEqual(lines(at), ["on battery at 12%: plug in the Mac"]);
  m.setFacts({ power: { on: "ac" } });
  next();
  assert.deepEqual(openBlockers(), {}, "plugged in, it closes by itself");
  m.setFacts({ power: { on: "battery", pct: 11 } });
  next();
  assert.ok(openBlockers().power, "open again");
  assert.equal(m.notes().length, 1, "and no news within two hours");
  m.setFacts({ power: { on: "ac" } });
  next();
  later(3 * 3600_000);
  m.setFacts({ power: { on: "battery", pct: 9 } });
  next();
  assert.equal(m.notes().length, 2, "later, it is news again");
});

test("Spotlight gone read-only is one notice with the command that fixes it, and closes once mdutil says it is back", (t) => {
  const m = machine(t);
  m.setFacts({ spotlightReadOnly: true, diskGb: 40 });
  look(later());
  look(later());
  assert.equal(m.notes().length, 1);
  assert.equal(m.notes()[0].title, "rollcall: Spotlight");
  assert.ok(m.notes()[0].text.includes(SPOTLIGHT_FIX), m.notes()[0].text);
  assert.deepEqual(lines(at), [`Spotlight read-only, Cmd-Space misses apps: ${SPOTLIGHT_FIX}`]);
  m.setFacts({ spotlightReadOnly: false, diskGb: 40 });
  look(later());
  assert.deepEqual(openBlockers(), {});
  assert.equal(m.notes().length, 1, "back: nothing to say");
});

test("a usage limit's notice names the reset and how to clear it, once over both a worker's hook and a supervisor's", (t) => {
  const m = machine(t);
  m.setFacts({});
  const until = later() + 3600_000;
  openBlocker("usage", { until, text: "You've hit your session limit · resets 2:20pm (America/Los_Angeles)" });
  openBlocker("usage", { until: until - 60_000, text: "You've hit your session limit · resets 2:19pm (America/Los_Angeles)" });
  assert.equal(openBlockers().usage.until, until, "the later reset wins");
  look(later());
  assert.equal(m.notes().length, 1);
  assert.match(m.notes()[0].text, /session limit · resets 2:19pm \(America\/Los_Angeles\)\. rollcall resumes them after .*rollcall blockers clear usage/);
  assert.equal(closeBlocker("usage"), true);
  assert.equal(closeBlocker("usage"), false);
});

test("billing with no run to try again leaves the clearing to the owner, and says so", (t) => {
  const m = machine(t);
  m.setFacts({});
  openBlocker("billing", { text: "spending limit" });
  look(later());
  assert.match(m.notes()[0].text, /Fix it under Billing and plans on GitHub, then run rollcall blockers clear billing\./);
  assert.deepEqual(lines(), ["GitHub billing refuses jobs: rollcall blockers clear billing once fixed"]);
});

test("GitHub billing clears by itself: the refused run goes again, later each time, until a job gets past the refusal", (t) => {
  const m = machine(t);
  m.setFacts({});
  const log = join(m.sb.root, "gh.log");
  const view = join(m.sb.root, "run.json");
  const gh = join(m.sb.root, "gh");
  write(gh, `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\n[ "$2" = view ] && cat ${JSON.stringify(view)}\nexit 0\n`);
  chmodSync(gh, 0o755);
  process.env.ROLLCALL_GH = gh;
  t.after(() => { delete process.env.ROLLCALL_GH; });
  const calls = () => { try { return readFileSync(log, "utf8").trim().split("\n"); } catch { return []; } };
  const refused = { status: "completed", conclusion: "failure", jobs: [{ conclusion: "failure", steps: [] }] };
  writeFileSync(view, JSON.stringify(refused));
  openBlocker("billing", { text: "spending limit", main: m.sb.main, run: "55" }, later());
  look(later());
  assert.deepEqual(calls(), [], "not at once: GitHub just refused it");
  assert.match(m.notes()[0].text, /rollcall retries by itself/);
  look(later(15 * 60_000));
  assert.deepEqual(calls(), ["run rerun 55 --failed"]);
  look(later());
  assert.equal(calls().at(-1).startsWith("run view 55"), true);
  assert.ok(openBlockers().billing, "refused again: it stays");
  look(later(15 * 60_000));
  assert.equal(calls().length, 2, "the wait doubles");
  look(later(15 * 60_000));
  assert.equal(calls().at(-1), "run rerun 55 --failed");
  writeFileSync(view, JSON.stringify({ status: "completed", conclusion: "failure", jobs: [{ conclusion: "failure", steps: [{ name: "Run tests" }] }] }));
  look(later());
  assert.equal(openBlockers().billing, undefined, "a job that ran steps got past the refusal, whatever it did then");
  assert.equal(m.notes().length, 1);
});

const DAY = 24 * 3600_000;
const UUID = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;
const plist = (workspace) => `<?xml version="1.0"?><plist><dict><key>WorkspacePath</key><string>${workspace}</string></dict></plist>`;
const age = (p, ms) => { const at = new Date(Date.now() - ms); utimesSync(p, at, at); };

/** A task t1 with session UUID(2), a live supervisor, and fake machine folders holding one of each case. */
function leftovers(t) {
  const m = machine(t);
  const { sb } = m;
  const root = join(sb.root, "machine");
  const derived = join(root, "DerivedData");
  const temp = join(root, "claude-tmp");
  const browsers = join(root, "tmp");
  const psFile = join(root, "ps");
  const orphan = sb.track(spawn("sleep", ["600"], { stdio: "ignore" }));
  const env = { ROLLCALL_DERIVED_DATA: derived, ROLLCALL_CLAUDE_TMP: temp, ROLLCALL_BROWSER_TMP: browsers, ROLLCALL_PS_FILE: psFile };
  Object.assign(process.env, env);
  t.after(() => { for (const k of Object.keys(env)) delete process.env[k]; });
  const sup = sb.session(sb.root);
  sup.env = { ...sup.env, ...m.env, ...env };
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  assert.equal(sup.cli(["task", "new", "header", "--repo", sb.main]).code, 0);
  const task = store.readTask("alpha", "t1");
  task.sessions = [{ id: UUID(2), at: Date.now() }];
  store.writeTask(task);

  const buildFolder = (name, workspace) => { write(join(derived, name, "info.plist"), plist(workspace)); return join(derived, name); };
  const gone = buildFolder("Gone-abc", join(sb.root, "removed-worktree", "App.xcodeproj"));
  const kept = buildFolder("Kept-abc", join(sb.main, "src"));
  const open = buildFolder("Open-abc", join(task.worktree, "src"));
  const away = buildFolder("Away-abc", "/Volumes/Backup/App.xcodeproj");
  const module = join(derived, "ModuleCache.noindex");
  mkdirSync(module, { recursive: true });
  for (const f of [kept, open]) { write(join(f, "Build/x"), "x".repeat(4096)); age(join(f, "info.plist"), 2 * 3600_000); }

  const folder = (id, ms) => { const p = join(temp, "-project", id); write(join(p, "scratchpad/x"), "x"); age(join(p, "scratchpad"), ms); age(p, ms); return p; };
  const ended = folder(UUID(1), 2 * DAY);
  const openTask = folder(UUID(2), 2 * DAY);
  const young = folder(UUID(3), 2 * 3600_000);
  const quietLess = folder(UUID(4), 600_000);
  const live = folder(sup.id, 2 * DAY);
  const notSession = folder("not-a-session", 2 * DAY);

  const profile = (name, ms) => { const p = join(browsers, name); mkdirSync(p, { recursive: true }); age(p, ms); return p; };
  const dead = profile("playwright_chromiumdev_profile-abc", 2 * DAY);
  const running = profile("acme-browser-tests-abc", 2 * DAY);
  const fresh = profile("playwright_chromiumdev_profile-new", 3600_000);
  const other = profile("some-app-cache", 2 * DAY);
  writeFileSync(psFile, [
    `${orphan.pid} 1 02:00:00 /Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --headless=new --user-data-dir=${running}/profiles/x`,
    `999991 1 00:30 /Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --user-data-dir=/tmp/young`,
    `999995 1 02:00:00 /Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --user-data-dir=/Users/me/my-profile`,
    `999992 1 02:00:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/mine`,
    `999993 500 02:00:00 /Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --user-data-dir=/tmp/in-use`,
    "999994 1 02:00:00 /Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome Helper --type=renderer --user-data-dir=/tmp/x",
    "",
  ].join("\n"));
  return { ...m, sup, env, orphan, gone, kept, open, away, module, ended, openTask, young, quietLess, live, notSession, dead, running, fresh, other };
}

test("gc removes what ended work left and nothing an open task or a running session may need", (t) => {
  const l = leftovers(t);
  const gc = (...a) => l.sup.cli(["gc", ...a], { cwd: l.sb.main });
  const dry = gc("--dry-run");
  assert.match(dry.stdout, /would remove leftovers of ended work: 1 DerivedData folder, 1 temp folder, 1 browser profile, 1 test browser/);
  assert.ok(existsSync(l.gone) && existsSync(l.ended) && existsSync(l.dead), "a dry run takes nothing");
  assert.equal(l.orphan.exitCode, null);

  assert.match(gc().stdout, /removed leftovers of ended work: 1 DerivedData folder, 1 temp folder, 1 browser profile, 1 test browser/);
  for (const p of [l.gone, l.ended, l.dead]) assert.ok(!existsSync(p), `${p} went`);
  for (const p of [l.kept, l.open, l.away, l.module, l.openTask, l.young, l.live, l.notSession, l.running, l.fresh, l.other]) assert.ok(existsSync(p), `${p} stays`);
  assert.equal(l.orphan.signalCode ?? "SIGTERM", "SIGTERM");
});

test("the delete list shows what is only rebuildable, deletes nothing until --yes, and keeps what work uses", (t) => {
  const l = leftovers(t);
  const list = l.sup.cli(["clean"]);
  assert.match(list.stdout, /rollcall clean --yes deletes these 3 folders/);
  assert.match(list.stdout, new RegExp(`Kept-abc\\n.*Xcode build folder of ${l.sb.main}/src`));
  assert.match(list.stdout, /ModuleCache\.noindex\n.*shared build cache/);
  assert.match(list.stdout, /temp folder of an ended session/);
  for (const p of [l.open, l.gone, l.live, l.openTask, l.quietLess]) assert.ok(!list.stdout.includes(p), `${p} is not listed`);
  for (const p of [l.kept, l.module, l.young]) assert.ok(existsSync(p), "listing deletes nothing");

  // A build running puts every Xcode folder off limits, even after it was listed. So does ps not answering.
  const ps = readFileSync(process.env.ROLLCALL_PS_FILE, "utf8");
  writeFileSync(process.env.ROLLCALL_PS_FILE, "123 456 01:00 /usr/bin/xcodebuild test\n");
  const yes = l.sup.cli(["clean", "--yes"]).stdout;
  assert.match(yes, /deleted 1 folder /);
  assert.ok(yes.includes(l.young), "it says what went");
  assert.ok(!existsSync(l.young));
  assert.ok(existsSync(l.kept) && existsSync(l.module), "in use since it was listed");
  writeFileSync(process.env.ROLLCALL_PS_FILE, "");
  assert.match(l.sup.cli(["clean"]).stdout, /nothing on the delete list/);
  writeFileSync(process.env.ROLLCALL_PS_FILE, ps);
  l.sup.cli(["clean"]);
  assert.match(l.sup.cli(["clean", "--yes"]).stdout, /deleted 2 folders/);
  assert.match(l.sup.cli(["clean"]).stdout, /nothing on the delete list/);
});

test("a --yes deletes only a list the owner saw", (t) => {
  const l = leftovers(t);
  const list = store.readCleanList();
  assert.deepEqual(list, { items: [], shown: 0 });
  // The watcher's run saves a list the owner hears only a count of.
  assert.equal(l.sup.cli(["clean", "--low-disk"]).code, 0);
  assert.ok(store.readCleanList().items.length);
  assert.equal(store.readCleanList().shown, 0);
  const first = l.sup.cli(["clean", "--yes"]).stdout;
  assert.match(first, /rollcall clean --yes deletes these 3 folders/);
  assert.match(first, /nothing deleted yet/);
  assert.ok(existsSync(l.kept) && existsSync(l.module), "seen first");
  assert.match(l.sup.cli(["clean", "--yes"]).stdout, /deleted 3 folders/);
  assert.ok(!existsSync(l.kept));
});

test("the watcher listing again keeps what the owner saw, and a list with something new is unseen", (t) => {
  const l = leftovers(t);
  l.sup.cli(["clean"]);
  assert.ok(store.readCleanList().shown, "the owner saw it");
  l.sup.cli(["clean", "--low-disk"]);
  assert.ok(store.readCleanList().shown, "the same folders: still seen");
  const extra = join(process.env.ROLLCALL_DERIVED_DATA, "NewKept-abc");
  write(join(extra, "info.plist"), plist(`${l.sb.main}/src`));
  age(join(extra, "info.plist"), 2 * 3600_000);
  l.sup.cli(["clean", "--low-disk"]);
  assert.equal(store.readCleanList().shown, 0, "a folder the owner did not see");
  assert.match(l.sup.cli(["clean", "--yes"]).stdout, /nothing deleted yet/);
  assert.ok(existsSync(extra));
});

test("a sweep with no answer from ps leaves browsers and profiles", (t) => {
  const l = leftovers(t);
  writeFileSync(process.env.ROLLCALL_PS_FILE, "");
  assert.match(l.sup.cli(["gc", "--dry-run"], { cwd: l.sb.main }).stdout, /would remove leftovers of ended work: 1 DerivedData folder, 1 temp folder \(/);
  l.sup.cli(["gc"], { cwd: l.sb.main });
  assert.ok(existsSync(l.dead), "a dead profile stays until ps can say so");
  assert.equal(l.orphan.exitCode, null);
});

test("a project path stat may not read is not gone, and an escaped one reads right", (t) => {
  const l = leftovers(t);
  const blocked = join(l.sb.root, "denied");
  mkdirSync(blocked);
  const tricky = join(l.sb.root, "a<b");
  mkdirSync(tricky);
  const denied = join(process.env.ROLLCALL_DERIVED_DATA, "Denied-abc");
  write(join(denied, "info.plist"), plist(join(blocked, "App.xcodeproj")));
  const escaped = join(process.env.ROLLCALL_DERIVED_DATA, "Escaped-abc");
  write(join(escaped, "info.plist"), plist(tricky.replace("<", "&lt;")));
  chmodSync(blocked, 0);
  try { l.sup.cli(["gc"], { cwd: l.sb.main }); } finally { chmodSync(blocked, 0o755); }
  assert.ok(existsSync(denied), "stat refused, so unknown");
  assert.ok(existsSync(escaped), "a<b exists");
  assert.ok(!existsSync(l.gone));
});

test("a low disk is one notice with the list; a run that makes room says nothing", async (t) => {
  const l = leftovers(t);
  const run = () => assert.equal(l.sup.cli(["clean", "--low-disk"]).code, 0);
  l.setFacts({ diskGb: 6 });
  look(later());
  await until(() => l.notes().some((n) => /disk/.test(n.title)), { timeout: 20_000 });
  const [note] = l.notes();
  assert.match(note.text, /^The disk has 6 GB free\. rollcall already cleared .* of leftovers\. It found .* more it can delete, listed in .*clean-list\.txt\. Say "clean up" to a supervisor, or run rollcall clean to see it: nothing goes until you say yes\./);
  assert.ok(!existsSync(l.gone), "what surely belongs to nothing goes at once");
  assert.ok(existsSync(l.kept), "the rest waits on the owner");
  assert.match(lines(at)[0], /^disk: 6 GB free, rollcall clean lists .* it can free/);
  look(later());
  run();
  assert.equal(l.notes().length, 1, "still one notice");

  closeBlocker("disk");
  openBlocker("disk", { gb: 6 });
  l.setFacts({ diskGb: 30 });
  run();
  assert.deepEqual(openBlockers(), {}, "room made: it closes");
  assert.equal(l.notes().length, 1);
});

test("a store that is not the machine's own reaches none of its folders", (t) => {
  // Only this test's own settings and its fakes' absence: with no session of the machine's on record, every one would read as over.
  const m = machine(t);
  assert.notEqual(store.home(), join(process.env.HOME ?? "", ".rollcall"));
  for (const k of ["ROLLCALL_DERIVED_DATA", "ROLLCALL_CLAUDE_TMP", "ROLLCALL_BROWSER_TMP", "ROLLCALL_PS_FILE"]) assert.equal(process.env[k], undefined);
  assert.deepEqual(sweepLeftovers({ dryRun: true }), { kb: 0, line: null });
  assert.deepEqual(deleteList(), []);
  assert.ok(m.sb.home);
});

test("task wait-for: a worker's wait on a blocker or a check, and what it refuses", (t) => {
  const m = machine(t);
  const { sb } = m;
  const sup = sb.session(sb.root);
  sup.env = { ...sup.env, ...m.env };
  sup.start();
  assert.equal(sup.cli(["supervise", "alpha"]).code, 0);
  assert.equal(sup.cli(["task", "new", "header", "--repo", sb.main]).code, 0);
  const worker = { env: { ROLLCALL_TASK: "alpha:t1" } };
  const wait = (...a) => sup.cli(["task", "wait-for", "t1", ...a], worker);
  assert.match(wait().stderr, /usage: rollcall task wait-for/);
  assert.match(wait("disk", "--every", "0").stderr, /--every takes minutes/);

  assert.match(wait("disk").stdout, /t1: waits on disk\. End your turn now: rollcall tells the owner once, and brings you back when it clears/);
  assert.equal(store.readTask("alpha", "t1").wait.on, "disk");
  assert.ok(openBlockers().disk.waited);
  assert.match(sup.cli(["task", "list"]).stdout, /waits on disk space/);
  assert.match(sup.cli(["blockers"]).stdout, /^disk: /);
  assert.match(sup.cli(["blockers", "clear", "disk"]).stdout, /disk cleared/);
  assert.match(sup.cli(["blockers"]).stdout, /nothing is blocking work/);
  assert.match(sup.cli(["blockers", "clear", "disk"]).stdout, /nothing open for disk/);

  assert.match(wait("curl -sf https://status.example.com", "--every", "5", "--why", "the Railway outage").stdout, /waits on `curl -sf https:\/\/status\.example\.com`\. End your turn now: rollcall runs the check while you are parked/);
  const w = store.readTask("alpha", "t1").wait;
  assert.deepEqual([w.on, w.check, w.every, w.why], [null, "curl -sf https://status.example.com", 300_000, "the Railway outage"]);
  assert.match(sup.cli(["task", "show", "t1"]).stdout, /waits on the Railway outage, since/);

  assert.equal(sup.cli(["task", "close", "t1"]).code, 0);
  assert.match(wait("disk").stderr, /t1 is closed: a finished task waits on nothing/);
});
