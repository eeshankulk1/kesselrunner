// `rollcall _codex-send <sock> <thread> say|interrupt [<turn>|-]` (stdin: the words; <turn>: the running turn as the worker
// last recorded it): one message into a Codex worker's thread,
// from any rollcall process (the watcher, a CLI call), through the worker's app server. `say` starts a turn when the
// worker is idle and steers the running one otherwise; `interrupt` stops the running turn. Exit 0 once the server
// took it: its answer is the receipt (delivery.mjs), since nothing was typed that could be lost on the way.
import { readFileSync } from "node:fs";
import { connect } from "./rpc.mjs";
import { DELIVERY, clientId } from "./worker.mjs";

/** The thread's running turn, from the server itself (the worker's record can be a moment behind), or null. */
// Every wait here is short and bounded: at most 3 s to connect and 3 s per request, five calls at worst, so the sender
// always ends well inside the 20 s its caller gives it. A sender killed mid-call could not say whether its words went
// in, and the next try would send them twice.
const STEP_MS = 3000;

async function runningTurn(conn, threadId) {
  const r = await conn.request("thread/read", { threadId, includeTurns: true }, STEP_MS);
  return (r?.thread?.turns ?? []).findLast((t) => t.status === "inProgress")?.id ?? null;
}

export async function codexSend([sock, threadId, what, known = "-"]) {
  if (!sock || !threadId || !["say", "interrupt"].includes(what)) { process.stderr.write("usage: rollcall _codex-send <sock> <thread> say|interrupt [<turn>|-]\n"); return 2; }
  let conn;
  try { conn = await connect(sock, () => {}, { timeoutMs: STEP_MS }); } catch (e) { process.stderr.write(`${e.message}\n`); return 1; }
  try {
    if (what === "interrupt") {
      // A turn recorded as running may have ended a moment ago: then the server says which runs, if any.
      try { if (known !== "-") { await conn.request("turn/interrupt", { threadId, turnId: known }, STEP_MS); return 0; } } catch {}
      const turnId = await runningTurn(conn, threadId);
      if (turnId) await conn.request("turn/interrupt", { threadId, turnId }, STEP_MS);
      return 0;
    }
    const text = readFileSync(0, "utf8");
    if (!text.trim()) return 0;
    const input = [{ type: "text", text }];
    const cid = clientId(DELIVERY);
    // The worker's record first; a turn can start or end between its write and this send, so on a refusal the server
    // itself says which turn runs (reading the thread's turns, which costs more on a long thread) for one more try.
    for (let i = 0; i < 2; i++) {
      const turnId = i === 0 ? (known === "-" ? null : known) : await runningTurn(conn, threadId);
      try {
        if (turnId) await conn.request("turn/steer", { threadId, expectedTurnId: turnId, input, clientUserMessageId: cid }, STEP_MS);
        else await conn.request("turn/start", { threadId, input, clientUserMessageId: cid }, STEP_MS);
        return 0;
      } catch (e) { if (i) throw e; }
    }
    return 1;
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 1;
  } finally {
    conn.close();
  }
}
