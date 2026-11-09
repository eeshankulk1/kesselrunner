// The supervisor's tools on a worker that are not task-record edits: `rollcall task chat <id>` (a page of its chat),
// `task interrupt <id>` (its turn stops) and `task wait <id>` (until its turn ends or it asks something). Starting
// a worker (start.mjs) and telling it (`task tell`) already reach a hosted worker through the host. They serve a
// hosted supervisor's workers (cockpit's crews), through the host's socket: no tmux, no screen read, no keys. A
// terminal supervisor's workers run in tmux, where `task interrupt` is Esc and chat and wait do not apply.
import { call, connect, ensureHost } from "./host/client.mjs";
import { P } from "./session.mjs";
import * as store from "./store.mjs";
import { hostedTask, label, nameOf } from "./supervisor.mjs";
import { workerAdapter } from "./harness/index.mjs";

const take = (args, name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const has = (args, name) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const refOf = (t) => `${t.home}:${t.id}`;

/** One line for an item of the chat, as the supervisor reads it. */
export function chatLine(x) {
  const one = (s, n = 600) => store.clip(store.oneLine(String(s ?? "")), n);
  const kid = x.parent ? "  " : "";
  switch (x.kind) {
    case "user": return `${kid}> ${x.from === "rollcall" || String(x.text).startsWith(P) ? "(rollcall) " : ""}${one(x.text)}${x.queued ? " [waiting]" : ""}`;
    case "assistant": return `${kid}${one(x.text, 2000)}`;
    case "thinking": return null;
    case "tool": return `${kid}  [${x.tool ?? x.name ?? "tool"}] ${one(x.summary ?? x.input?.command ?? x.input?.description ?? "", 200)}${x.error ? " (error)" : ""}`;
    case "subagent": return `${kid}  [subagent] ${one(x.description ?? x.text ?? "", 200)}`;
    case "turn": return x.phase === "end" ? `${kid}-- turn ended${x.error ? `: ${one(x.error, 200)}` : ""}` : null;
    case "compaction": return `${kid}-- compacted`;
    case "system": return `${kid}[system] ${one(x.text, 400)}`;
    default: return x.text ? `${kid}${one(x.text)}` : null;
  }
}

/** `task chat <id> [--before <cursor>] [--limit <n>] [--json]`: a page of the worker's chat, newest last. */
export async function chatCmd(args, ctx, resolve) {
  const before = take(args, "--before") ?? null;
  const limit = Number(take(args, "--limit") ?? 40);
  const json = has(args, "--json");
  const t = resolve(args.shift(), ctx);
  if (!(limit > 0)) ctx.fail("--limit takes a number above 0");
  if (!hostedTask(t)) ctx.fail(`${label(t)} runs in tmux: /attach ${t.id} shows its terminal. task chat is for a worker the agent host runs.`);
  const { hostedPage } = await import("./host/conversation.mjs");
  const page = await hostedPage(refOf(t), { before, limit });
  if (!page.ok) ctx.fail(`${label(t)}: ${page.error?.message ?? "its chat could not be read"}`);
  if (json) { ctx.say(JSON.stringify(page)); return 0; }
  ctx.say(`${label(t)}: ${page.items.length} items${page.more ? ` (earlier: task chat ${t.id} --before ${page.cursor})` : ""}`);
  for (const x of page.items) { const l = chatLine(x); if (l) ctx.say(l); }
  if (page.prompt) ctx.say(`[asks now] ${store.clip(store.oneLine(page.prompt.summary ?? page.prompt.questions?.map((q) => q.question).join(" / ") ?? page.prompt.tool ?? ""), 300)}`);
  return 0;
}

/** `task interrupt <id>`: the worker's turn stops, as the owner's Esc would. */
export async function interruptCmd(args, ctx, resolve) {
  const t = resolve(args.shift(), ctx);
  let done;
  if (hostedTask(t)) {
    const r = await call("interrupt", { ref: refOf(t) });
    if (!r.ok) ctx.fail(`${label(t)}: ${r.error?.message}`);
    done = r.interrupted;
  } else done = workerAdapter(t).interrupt(t);
  ctx.say(done ? `${label(t)}: its turn stopped` : `${label(t)}: nothing to stop (no turn runs)`);
  return 0;
}

/**
 * `task wait <id> [--timeout <minutes>]`: waits until the hosted worker's turn ends or it asks something, then says
 * which. Prints at once when it is not in a turn. A tmux worker's news reaches the supervisor by itself instead.
 */
export async function waitCmd(args, ctx, resolve) {
  const minutes = Number(take(args, "--timeout") ?? 10);
  const t = resolve(args.shift(), ctx);
  if (!(minutes > 0)) ctx.fail("--timeout takes minutes");
  if (!hostedTask(t)) ctx.fail(`${label(t)} runs in tmux: its news reaches you by itself when its turn ends. task wait is for a worker the agent host runs.`);
  const ref = refOf(t);
  const said = (a, why) => {
    const ask = a.requests?.[0];
    if (ask) ctx.say(`${label(t)} asks: ${store.clip(store.oneLine(ask.summary ?? ask.questions?.map((q) => q.question).join(" / ") ?? ask.tool ?? ""), 300)} (request ${ask.id})`);
    else ctx.say(`${label(t)}: ${why} (${a.state})`);
    return 0;
  };
  await ensureHost().then((c) => c.close()).catch(() => {});
  return new Promise((resolveP) => {
    let c = null;
    const end = (code) => { clearTimeout(timer); try { c?.close(); } catch {} resolveP(code); };
    const timer = setTimeout(() => { ctx.say(`${label(t)}: still in its turn after ${minutes} min`); end(1); }, minutes * 60_000);
    connect({
      onEvent: (e) => {
        if (e.ref !== ref) return;
        if (e.ev === "request") end(said({ requests: [e.request], state: "running" }));
        else if (e.ev === "state" && e.agent.state !== "running") end(said(e.agent, e.agent.state === "terminal" ? "it is open in a terminal" : "its turn ended"));
      },
    }).then(async (conn) => {
      c = conn;
      const r = await c.call("subscribe", { refs: [ref] });
      const a = r.agents?.[0];
      if (!a) return end(said({ state: "parked" }, `${nameOf(t.id)} has no hosted worker running`));
      if (a.state !== "running" || a.requests?.length) end(said(a, a.state === "terminal" ? "it is open in a terminal" : "no turn runs"));
    }).catch((e) => { ctx.say(`${label(t)}: ${e.message}`); end(1); });
  });
}
