// The commands over a checkout's runtime (runtime.mjs): its ports, its manifest with them filled in, its setup, its
// run actions, and which checkout serves a port. Each acts on the checkout holding the current folder (`-C <dir>` or
// `rollcall task <cmd> <id>` for a task's worktree).
import { setTimeout as sleep } from "node:timers/promises";
import { isOpen } from "./state.mjs";
import {
  actionsOf, checkoutEnv, checkoutFacts, inside, lastLines, listActions, resolvedManifest, runSetup, servedFrom, setupLine, setupState,
  startAction, startSetup, stopAction,
} from "./runtime.mjs";
import { BIN } from "./session.mjs";
import * as store from "./store.mjs";
import { nameOf } from "./supervisor.mjs";

export const USAGE = `  rollcall ports [--json]                this checkout's block of ports (handed out on first ask; gc and archive
                                         give it back); the main checkout uses the manifest's ports.default
  rollcall manifest [--json]             the test manifest with this checkout's ports filled in ({port}, {port+N})
  rollcall setup [--rerun] [--wait] [--json]
                                         how this worktree's setup went (rollcall runs it at task new: the files
                                         .worktreeinclude names, then the manifest's worktree.setup); --rerun runs it
                                         again in the background, --wait waits for one that runs
  rollcall run [list] [--json]           this checkout's run actions (the manifest's "run", else devServer/backend)
  rollcall run start|stop|restart <name|all>   start one as a process group with its own log, or stop it
  rollcall run log <name> [--lines <n>]  the end of its log
  rollcall serving <port|url> [--json]   which checkout serves that port: exit 0 when it is this one, 1 another,
                                         2 when nothing listens. A browser check trusts a result only after exit 0`;

/** The open task (else the newest) whose worktree is `top`, or null. */
export function taskOfCheckout(top) {
  const here = store.listTasks().filter((t) => t.worktree && inside(t.worktree, top) && inside(top, t.worktree)).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return here.filter(isOpen).pop() ?? here.pop() ?? null;
}

const named = (t) => (t ? { ...t, name: nameOf(t.id) } : null);

/** `ctx`: the CLI's { say, fail, flag }. Runs in process.cwd(). */
export async function runtimeCommand(cmd, args, ctx) {
  const json = take(args, "--json");
  if (cmd === "_setup") return setupWorker(args);
  if (cmd === "serving") return serving(args, ctx, json);
  const f = checkoutFacts(process.cwd(), { allocate: cmd === "ports" ? "always" : cmd === "manifest" || cmd === "run" });
  if (!f) ctx.fail("this folder is not inside a git checkout");
  if (cmd === "ports") return ports(f, ctx, json);
  if (cmd === "manifest") {
    const m = resolvedManifest(f.top);
    if (!m) ctx.fail(`${f.top} has no .claude/test-manifest.json`);
    ctx.say(JSON.stringify(m, null, json ? 0 : 2));
    return 0;
  }
  if (cmd === "setup") return await setup(f, args, ctx, json);
  if (cmd === "run") return await run(f, args, ctx, json);
  ctx.fail(`unknown command "${cmd}"`);
}

function ports(f, ctx, json) {
  const out = { checkout: f.top, main: f.isMain, port: f.base, ports: f.ports };
  if (json) { ctx.say(JSON.stringify(out)); return 0; }
  if (f.isMain && f.base && !f.ports) ctx.say(`${f.top}: the main checkout, on the manifest's ports.default ${f.base}`);
  else if (f.ports) ctx.say(`${f.top}: ports ${f.ports.base}-${f.ports.last} ({port} = ${f.ports.base}, ROLLCALL_PORT in its setup, run actions and worker)`);
  else ctx.fail("no free block of ports in range (ROLLCALL_PORT_MIN, ROLLCALL_PORT_MAX)");
  return 0;
}

// ---------------------------------------------------------------- setup

async function setup(f, args, ctx, json) {
  const rerun = take(args, "--rerun");
  const wait = take(args, "--wait");
  const quiet = take(args, "--quiet");
  if (f.isMain) ctx.fail("the main checkout is set up by hand: setup runs in a worktree");
  if (rerun) {
    if (setupState(f.top)?.state === "running") ctx.fail(`setup is running already (log: ${setupState(f.top).log})`);
    const s = startSetup(f.top, { bin: BIN });
    if (!s) ctx.fail("nothing to run: the manifest has no worktree.setup and the repo no .worktreeinclude");
    ctx.say(`setup started again in the background${s.cmd ? `: ${s.cmd}` : ""} (log: ${s.log}); \`rollcall setup --wait\` waits for it`);
    return 0;
  }
  let s = setupState(f.top);
  if (wait && s?.state === "running") {
    ctx.say(`rollcall: waiting for this worktree's setup to finish${s.cmd ? ` (${s.cmd})` : ""}; its log: ${s.log}`);
    while (s?.state === "running") { await sleep(1000); s = setupState(f.top); }
    if (s) ctx.say(`rollcall: ${setupLine(s)}`);
    return s?.state === "failed" ? 1 : 0;
  }
  if (json) { ctx.say(JSON.stringify(s)); return 0; }
  if (!s) { if (!quiet) ctx.say("no setup ran in this worktree (rollcall runs one for a task's worktree; --rerun runs it here)"); return 0; }
  if (quiet) return s.state === "failed" ? 1 : 0;
  ctx.say(setupLine(s));
  if (s.state === "failed") ctx.say(["the end of its log:", ...lastLines(s.log, 15).map((l) => `  ${l}`), "fix the cause, then: rollcall setup --rerun"].join("\n"));
  return s.state === "failed" ? 1 : 0;
}

/** `rollcall _setup <top> [--copy-only]`: the background run startSetup starts. A failure goes on its task and to its supervisor, once. */
function setupWorker(args) {
  const top = args[0];
  const f = top && checkoutFacts(top);
  if (!f) return 1;
  const t = taskOfCheckout(f.top);
  const s = runSetup(f.top, {
    copyOnly: args.includes("--copy-only"),
    env: checkoutEnv(f, named(t)),
    onFail: (st) => {
      if (!t) return;
      store.withTasksLock(t.home, () => {
        const x = store.readTask(t.home, t.id);
        if (!x) return;
        x.notes.push({ at: Date.now(), by: "rollcall", text: `setup failed: ${store.clip(store.oneLine(st.last ?? ""), 300)} (rerun: rollcall task setup ${t.id} --rerun; log: ${st.log})` });
        store.writeTask(x);
      });
      if (isOpen(t)) store.enqueueWake(t.home, { task: t.id, kind: "setup-failed" });
    },
  });
  return s.state === "failed" ? 1 : 0;
}

// ---------------------------------------------------------------- run actions

async function run(f, args, ctx, json) {
  const [linesArg] = ctx.flag(args, "--lines");
  const [sub = "list", which] = args;
  const env = checkoutEnv(f, named(taskOfCheckout(f.top)));
  if (sub === "list") {
    const all = listActions(f);
    if (json) { ctx.say(JSON.stringify(all)); return 0; }
    if (!all.length) { ctx.say(`${f.top}: no run actions (name them under "run" in .claude/test-manifest.json)`); return 0; }
    for (const a of all) ctx.say(`${a.name.padEnd(10)} ${a.running ? "running" : "stopped"}${a.url ? `  ${a.url}` : ""}  ${a.command ?? ""}${a.inManifest ? "" : "  (no longer in the manifest)"}`);
    return 0;
  }
  if (sub === "log") {
    if (!which) ctx.fail("usage: rollcall run log <name> [--lines <n>]");
    const a = listActions(f).find((x) => x.name === which) ?? ctx.fail(`no run action ${which} (rollcall run list)`);
    ctx.say(lastLines(a.log, Number(linesArg) || 40).join("\n") || `(its log is empty: ${a.log})`);
    return 0;
  }
  if (!["start", "stop", "restart"].includes(sub)) ctx.fail(`usage: rollcall run [list] | start|stop|restart <name|all> | log <name>`);
  if (!which) ctx.fail(`usage: rollcall run ${sub} <name|all>`);
  const known = sub === "stop" ? listActions(f) : actionsOf(f);
  const picked = which === "all" ? known : known.filter((a) => a.name === which);
  if (!picked.length) ctx.fail(which === "all" ? "no run actions here (rollcall run list)" : `no run action ${which} here (rollcall run list)`);
  let code = 0;
  for (const a of picked) {
    if (sub !== "start") { const was = stopAction(f.top, a.name); if (sub === "stop") { ctx.say(`${a.name}: ${was ? "stopped" : "was not running"}`); continue; } }
    const r = startAction(f, a, env);
    if (!r.ok) { ctx.say(`${a.name}: could not start: ${r.err}`); code = 1; continue; }
    if (r.already) { ctx.say(`${a.name}: running already${r.state.url ? ` at ${r.state.url}` : ""} (rollcall run restart ${a.name})`); continue; }
    // One that dies at once (a port in use, a missing script) says so now, not at the first page load.
    await sleep(Number(process.env.ROLLCALL_RUN_SETTLE_MS) || 1500);
    const alive = listActions(f).find((x) => x.name === a.name)?.running;
    if (!alive) { ctx.say([`${a.name}: exited at once; the end of its log (${r.state.log}):`, ...lastLines(r.state.log, 10).map((l) => `  ${l}`)].join("\n")); code = 1; continue; }
    ctx.say(`${a.name}: started${a.url ? ` at ${a.url}` : ""} (log: ${r.state.log})`);
  }
  return code;
}

// ---------------------------------------------------------------- serving

function serving(args, ctx, json) {
  const arg = args[0];
  let port = Number(arg);
  if (!(port > 0)) { try { const u = new URL(arg); port = Number(u.port) || (u.protocol === "https:" ? 443 : 80); } catch {} }
  if (!(port > 0)) ctx.fail("usage: rollcall serving <port|url>");
  const here = checkoutFacts(process.cwd(), { allocate: false })?.top ?? null;
  const s = servedFrom(port);
  const t = s?.top ? taskOfCheckout(s.top) : null;
  const ours = !!(s?.cwd && here && inside(s.cwd, here));
  if (json) { ctx.say(JSON.stringify({ port, listening: !!s, pid: s?.pid ?? null, cwd: s?.cwd ?? null, checkout: s?.top ?? null, task: t ? `${t.home}:${t.id}` : null, thisCheckout: ours })); return s ? (ours ? 0 : 1) : 2; }
  if (!s) { ctx.say(`nothing listens on port ${port}`); return 2; }
  const who = s.top ? `${s.top}${t ? ` (task ${t.id} of ${t.home})` : ""}` : s.cwd ? `${s.cwd}, outside any checkout` : "a process whose folder rollcall cannot read";
  ctx.say(`port ${port}: pid ${s.pid}, served from ${who}${ours ? ": this checkout" : here ? `: NOT this checkout (${here})` : ""}`);
  return ours ? 0 : 1;
}

function take(args, name) {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}
