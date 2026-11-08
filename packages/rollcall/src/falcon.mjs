// falcon: opens a supervisor in this terminal tab, the way `claude` opens a session. The supervisor runs
// as the first window of its home's tmux session (`sv-<home>`), beside its workers' windows, and tmux's
// status bar is the tabs: a click shows a worker, a click on the supervisor's name comes back.
//
//   falcon               a new supervisor, named for the owner (SHIPS in supervisor.mjs)
//   falcon continue      back into the supervisor used last (also --continue)
//   falcon resume [name] pick one from a list, or open that one (also --resume)
//
// Closing the terminal tab only detaches it: the supervisor and its workers keep running, and falcon
// continue shows them again. A supervisor whose Claude Code stopped (a /exit, a Mac restart, parked while
// idle) comes back with its conversation (`claude --resume`), in the folder it started in, or as a fresh
// supervisor once that conversation grew big (window.mjs comeBack).
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { blocked, check, lines } from "./needs.mjs";
import { BIN, short } from "./session.mjs";
import * as store from "./store.mjs";
import { isOpen } from "./state.mjs";
import { holderOf, nameOf, pickName } from "./supervisor.mjs";
import * as tmux from "./tmux.mjs";
import { decisionsOf } from "./task.mjs";
import { view } from "./watch.mjs";
import { backText, comeBack, hostedSupervisor, lastSession, startWindow, supervisorHosted, unparkHome, writeWindow } from "./window.mjs";

const USAGE = `falcon - open a supervisor in this terminal tab, the way \`claude\` opens a session.

  falcon                  start a new supervisor (named for a ship: falcon, then venator, ghost, ...)
  falcon continue         go back into the supervisor you used last (also --continue)
  falcon resume           pick a supervisor from a list (also --resume)
  falcon resume <name>    open that one

Each task shows as a tab in the bar at the bottom: click one to switch to it, and click the
supervisor's name to come back. Closing the terminal tab stops nothing: falcon continue brings
everything back.`;

class Exit extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (msg, code = 1) => { throw new Exit(code, `falcon: ${msg}`); };
const say = (s) => process.stdout.write(`${s}\n`);
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const clip = (s, n) => { const x = String(s).replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x; };

export async function main(argv) {
  const args = [...argv];
  const cmd = args[0]?.replace(/^--/, "");
  try {
    if (cmd === "help" || args.includes("--help") || args.includes("-h")) { say(USAGE); return 0; }
    if (cmd !== undefined && cmd !== "continue" && cmd !== "resume") fail(`unknown command "${args[0]}"\n\n${USAGE}`);
    if (args.length > (cmd === "resume" ? 2 : cmd ? 1 : 0)) fail(`too many arguments\n\n${USAGE}`);
    const needs = check();
    for (const l of lines(needs)) process.stderr.write(`falcon: ${l}\n`);
    if (blocked(needs)) return 1;
    if (process.env.TMUX && !tmux.inside()) fail("this terminal tab is already inside tmux. Open a new terminal tab and run falcon there.");
    if (cmd === undefined) return start();
    if (cmd === "continue") return open(supervisors()[0]?.h ?? fail("no supervisor yet: run falcon to start one."), "falcon continue");
    const name = args[1];
    if (name) {
      if (!store.listHomes().includes(name)) fail(`no supervisor named ${name}. falcon resume lists them.`);
      return open(name, `falcon resume ${name}`);
    }
    const h = await pick();
    return h ? open(h, `falcon resume ${h}`) : 0;
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    process.stderr.write(`${e.message}\n`);
    return e.code;
  }
}

// ---------------------------------------------------------------- starting and opening

/** A new supervisor: the next free name, reserved by making its home, then its window. */
function start() {
  const h = reserve();
  if (supervisorHosted(h)) return openHosted(h, { session: randomUUID(), cwd: process.cwd(), resume: false });
  const r = startWindow(h, { session: randomUUID(), cwd: process.cwd(), resume: false });
  if (!r.ok) fail(`could not open ${h}'s window: ${r.err}`);
  return attach(h);
}

/** The next free name, its home made at once (mkdir is atomic), so two falcons never take one name. */
function reserve() {
  for (let tries = 0; tries < 50; tries++) {
    const h = pickName();
    mkdirSync(dirname(store.homeDir(h)), { recursive: true });
    try { mkdirSync(store.homeDir(h)); return h; } catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  return fail("could not find a free supervisor name");
}

/**
 * Shows supervisor `h`: its window when it runs; else it comes back there (comeBack: its conversation
 * resumed, or a fresh one), first telling the owner where its tasks stand when it was parked. One running in
 * another terminal is left alone: one process per conversation, so the owner quits it there first.
 */
function open(h, again) {
  if (supervisorHosted(h)) {
    const a = hostedSupervisor(h);
    if (a?.state === "terminal") fail(`${h} is open in another terminal. Quit it there, then run ${again} again.`);
    if (a && a.state !== "stopped") return openTerminal(h);
    const holder = holderOf(h);
    if (holder) fail(`${h} is open in another terminal (session ${short(holder.id)}). Quit it there with /exit, then run ${again} again.`);
    const parked = unparkHome(h);
    return openHosted(h, comeBack(h), { prompt: parked ? backText(h) : null });
  }
  if (!tmux.windowOf(h, h)?.alive) {
    const holder = holderOf(h);
    if (holder) fail(`${h} is open in another terminal (session ${short(holder.id)}). Quit it there with /exit, then run ${again} again.`);
    const parked = unparkHome(h);
    const r = startWindow(h, comeBack(h), { prompt: parked ? backText(h) : null });
    if (!r.ok) fail(`could not open ${h}'s window: ${r.err}`);
  }
  return attach(h);
}

/**
 * A supervisor the agent host runs (ROLLCALL_HOST=1) has no window. Until the owner settles what the terminal Falcon
 * becomes (docs/plans/2026-11-08-agent-host.md, slice 4), falcon opens the terminal escape hatch on the supervisor's
 * own session: the real CLI here, the host carrying on once it exits. A placeholder, not the Falcon's new form.
 */
function openHosted(h, back, opts = {}) {
  writeWindow(h, back, opts);
  return openTerminal(h);
}

const openTerminal = (h) => spawnSync(process.execPath, [BIN, "open", h], { stdio: "inherit" }).status ?? 1;

/** Shows the supervisor's window in this terminal: attaches it, or switches to it inside falcon's tmux. */
function attach(h) {
  tmux.dress();
  tmux.select(h, h);
  const s = `=${tmux.sessionName(h)}`;
  if (process.env.FALCON_NO_ATTACH) { say(`falcon: ${h} is ready in tmux session ${tmux.sessionName(h)}`); return 0; }
  if (tmux.inside()) return tmux.tmux(["switch-client", "-t", s]).ok ? 0 : 1;
  const r = spawnSync("tmux", ["-L", tmux.SOCKET(), "attach-session", "-t", s], { stdio: "inherit", env: tmux.cleanEnv() });
  return r.status ?? 1;
}

// ---------------------------------------------------------------- the list

/**
 * Every supervisor that ever ran, newest first: { h, state, tasks, last } where state is "open here"
 * (its falcon window runs), "open in another terminal" or "closed".
 */
export function supervisors(now = Date.now()) {
  const out = [];
  for (const h of store.listHomes()) {
    const lock = store.readHomeFile(h, "lock");
    const f = store.readHomeFile(h, "falcon");
    if (!lock?.session && !f?.session) continue;
    const tasks = store.listTasks(h);
    const last = lastSession(h);
    let seen = Math.max(lock?.at ?? 0, f?.at ?? 0, ...tasks.map((t) => t.updatedAt ?? 0));
    const transcript = last && store.readGlobal(last.id)?.transcript;
    try { if (transcript) seen = Math.max(seen, statSync(transcript).mtimeMs); } catch {}
    const parked = store.readHomeFile(h, "parked");
    const state = tmux.windowOf(h, h)?.alive ? "open here" : parked ? "parked" : holderOf(h) ? "open in another terminal" : "closed";
    out.push({ h, state, tasks: tasks.filter(isOpen), decisions: decisionsOf(h).length, last: seen });
  }
  return out.sort((a, b) => b.last - a.last);
}

function when(ms, now = Date.now()) {
  const d = new Date(ms);
  if (new Date(now).toDateString() === d.toDateString()) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The list, one supervisor per line: its name, where it is open, its open tasks and when it was last used. */
export function listing(rows, now = Date.now()) {
  const width = Math.max(...rows.map((r) => r.h.length));
  return rows.map((r, i) => {
    const tasks = r.tasks.length
      ? r.tasks.slice(0, 3).map((t) => `${nameOf(t.id)} ${clip(t.title, 24)}: ${view(t, now).said}`).join(", ") + (r.tasks.length > 3 ? `, +${r.tasks.length - 3} more` : "")
      : "no open tasks";
    const where = r.state === "closed" ? "" : r.state === "parked" ? "(parked while idle) " : `(${r.state}) `;
    const owed = r.decisions ? `; ${r.decisions} decision${r.decisions === 1 ? "" : "s"} wait${r.decisions === 1 ? "s" : ""} on you` : "";
    return `  ${String(i + 1).padStart(2)}  ${r.h.padEnd(width)}  ${when(r.last, now).padEnd(8)}  ${where}${tasks}${owed}`;
  }).join("\n");
}

/** Asks which supervisor to open: a number or a name, Enter for the newest. Null when the owner backs out. */
async function pick() {
  // A closed supervisor with nothing open, unused two days, drops off the list (falcon resume <name> still opens it).
  const now = Date.now();
  const rows = supervisors(now).filter((r) => r.state !== "closed" || r.tasks.length || r.decisions || now - r.last < 2 * 86_400_000);
  if (!rows.length) fail("no supervisor yet: run falcon to start one.");
  say(`Supervisors, newest first:\n${listing(rows)}`);
  if (!process.stdin.isTTY) fail("pick one by name: falcon resume <name>");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const a = (await rl.question("Open which? (number or name, Enter for 1, q to quit) ")).trim().toLowerCase();
      if (a === "q") return null;
      if (a === "") return rows[0].h;
      const byNumber = /^\d+$/.test(a) ? rows[Number(a) - 1] : null;
      const hit = byNumber ?? rows.find((r) => r.h === a);
      if (hit) return hit.h;
      say(`  no supervisor "${a}" in the list`);
    }
  } finally { rl.close(); }
}
