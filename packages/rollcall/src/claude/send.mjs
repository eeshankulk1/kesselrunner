// `rollcall _claude-send <sock>` (stdin: one JSON request): one request to a stream-mode Claude worker's socket,
// for the synchronous callers (claude/live.mjs send). Prints the worker's one-line answer and exits 0 when it
// answered, 1 when it could not be reached. Every wait is bounded, well inside the 20 s its caller gives it.
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";

export const STEP_MS = 10_000;

/** Sends `req` to the socket and resolves with the worker's answer (parsed), or rejects. */
export function request(sock, req, timeoutMs = STEP_MS) {
  return new Promise((resolve, reject) => {
    const c = createConnection(sock);
    let buf = "";
    const timer = setTimeout(() => { c.destroy(); reject(new Error("the worker did not answer in time")); }, timeoutMs);
    c.on("connect", () => c.write(`${JSON.stringify(req)}\n`));
    c.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      clearTimeout(timer);
      c.end();
      try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
    });
    c.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function claudeSend([sock]) {
  if (!sock) { process.stderr.write("usage: rollcall _claude-send <sock> (stdin: the request)\n"); return 2; }
  let req;
  try { req = JSON.parse(readFileSync(0, "utf8")); } catch { process.stderr.write("the request is not JSON\n"); return 2; }
  try {
    const r = await request(sock, req);
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
}
