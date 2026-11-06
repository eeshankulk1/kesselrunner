// `rollcall _codex-send <sock> <thread> say|interrupt` (stdin: the words): one message into a Codex worker's thread,
// from any rollcall process (the watcher, a CLI call), through the worker's app server. `say` starts a turn when the
// worker is idle and steers the running one otherwise; `interrupt` stops the running turn. Exit 0 once the server
// took it: its answer is the receipt (delivery.mjs), since nothing was typed that could be lost on the way.
import { readFileSync } from "node:fs";
import { connect } from "./rpc.mjs";
import { DELIVERY, clientId } from "./worker.mjs";

/** The thread's running turn, from the server itself (the worker's record can be a moment behind), or null. */
async function runningTurn(conn, threadId) {
  const r = await conn.request("thread/read", { threadId, includeTurns: true });
  return (r?.thread?.turns ?? []).findLast((t) => t.status === "inProgress")?.id ?? null;
}

export async function codexSend([sock, threadId, what]) {
  if (!sock || !threadId || !["say", "interrupt"].includes(what)) { process.stderr.write("usage: rollcall _codex-send <sock> <thread> say|interrupt\n"); return 2; }
  let conn;
  try { conn = await connect(sock, () => {}, { timeoutMs: 8000 }); } catch (e) { process.stderr.write(`${e.message}\n`); return 1; }
  try {
    if (what === "interrupt") {
      const turnId = await runningTurn(conn, threadId);
      if (turnId) await conn.request("turn/interrupt", { threadId, turnId });
      return 0;
    }
    const text = readFileSync(0, "utf8");
    if (!text.trim()) return 0;
    const input = [{ type: "text", text }];
    const cid = clientId(DELIVERY);
    // A turn can start or end between the look and the send: one more try the other way.
    for (let i = 0; i < 2; i++) {
      const turnId = await runningTurn(conn, threadId);
      try {
        if (turnId) await conn.request("turn/steer", { threadId, expectedTurnId: turnId, input, clientUserMessageId: cid });
        else await conn.request("turn/start", { threadId, input, clientUserMessageId: cid });
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
