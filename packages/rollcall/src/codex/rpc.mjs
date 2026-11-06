// Codex's app server, spoken to: JSON-RPC 2.0, as text frames of a websocket over a unix socket (`codex app-server
// --listen unix://<path>`), or as lines on a child's stdio (`codex app-server`, one call and gone). rollcall needs no
// websocket library: this is the client half of RFC 6455 for unmasked text frames from the server, enough for one
// local socket. Every assumption about the protocol that rollcall makes lives in codex/*.mjs, and
// test/codex-contract.test.mjs checks the installed Codex still answers that way.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";

const CLIENT = { name: "rollcall", title: "rollcall", version: "1" };

/** A websocket frame from the client: masked, as the protocol requires. */
function frame(text, op = 0x1) {
  const p = Buffer.from(text);
  const mask = randomBytes(4);
  let head;
  if (p.length < 126) head = Buffer.from([0x80 | op, 0x80 | p.length]);
  else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
  const body = Buffer.alloc(p.length);
  for (let i = 0; i < p.length; i++) body[i] = p[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

/**
 * A JSON-RPC peer over `write`: requests with ids and promises, notifications and server requests to `on`.
 * Returns { request(method, params, timeoutMs), notify(method, params), respond(id, result), feed(message), close }.
 */
function peer(write, on) {
  let next = 1;
  const pending = new Map();
  return {
    request(method, params, timeoutMs = 30_000) {
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: no answer in ${timeoutMs} ms`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    notify: (method, params) => write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }),
    respond: (id, result) => write({ jsonrpc: "2.0", id, result }),
    fail: (id, message) => write({ jsonrpc: "2.0", id, error: { code: -32000, message } }),
    feed(m) {
      if (m && m.id !== undefined && m.method === undefined) {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(Object.assign(new Error(`${p.method}: ${m.error.message ?? "error"}`), { rpc: m.error }));
        else p.resolve(m.result);
        return;
      }
      on?.(m);
    },
    closed(err) {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err ?? new Error("the app server closed the connection")); }
      pending.clear();
    },
  };
}

/**
 * Connects to the app server listening on unix socket `sock` and initializes. `on(message)` hears notifications
 * and server requests ({ id, method, params }). Resolves to the peer plus close() and `done` (settles when the
 * connection ends).
 */
export function connect(sock, on, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    let buf = Buffer.alloc(0);
    let open = false;
    let ended;
    const done = new Promise((r) => { ended = r; });
    const rpc = peer((o) => c.write(frame(JSON.stringify(o))), on);
    const timer = setTimeout(() => { c.destroy(); reject(new Error(`no app server answered on ${sock}`)); }, timeoutMs);
    c.on("error", (e) => { clearTimeout(timer); if (!open) reject(e); });
    c.on("close", () => { rpc.closed(); ended(); });
    c.on("connect", () => {
      c.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    c.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!open) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        const status = buf.subarray(0, i).toString().split("\r\n")[0];
        buf = buf.subarray(i + 4);
        if (!/ 101 /.test(status)) { clearTimeout(timer); c.destroy(); reject(new Error(`the app server refused the connection: ${status}`)); return; }
        open = true;
        clearTimeout(timer);
        const api = { ...rpc, close: () => c.end(), done };
        rpc.request("initialize", { clientInfo: CLIENT, capabilities: { experimentalApi: true } }, timeoutMs)
          .then(() => { rpc.notify("initialized"); resolve(api); }, (e) => { c.destroy(); reject(e); });
      }
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 127;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf[1] & 0x80) off += 4; // a server never masks; tolerated anyway
        if (buf.length < off + len) return;
        const op = buf[0] & 15;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 0x1) { try { rpc.feed(JSON.parse(payload.toString())); } catch {} }
        else if (op === 0x9) c.write(frame(payload.toString(), 0xa)); // ping: pong
        else if (op === 0x8) c.end();
      }
    });
  });
}

/**
 * One call to a short-lived app server on stdio (`codex app-server`): starts it, initializes, asks `method`, and stops
 * it. For reads that need no worker (the account's rate limits). Resolves to the result.
 */
export function once(bin, method, params, { timeoutMs = 15_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], env }); } catch (e) { reject(e); return; }
    let buf = "";
    const stop = () => { try { p.kill(); } catch {} };
    const timer = setTimeout(() => { stop(); reject(new Error(`${method}: no answer in ${timeoutMs} ms`)); }, timeoutMs);
    const rpc = peer((o) => p.stdin.write(`${JSON.stringify(o)}\n`), null);
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("exit", () => rpc.closed());
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { rpc.feed(JSON.parse(line)); } catch {}
      }
    });
    rpc.request("initialize", { clientInfo: CLIENT }, timeoutMs)
      .then(() => { rpc.notify("initialized"); return rpc.request(method, params, timeoutMs); })
      .then((r) => { clearTimeout(timer); stop(); resolve(r); }, (e) => { clearTimeout(timer); stop(); reject(e); });
  });
}
