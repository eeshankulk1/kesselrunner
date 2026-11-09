// `rollcall api conversation <ref>` for an agent the host runs (a hosted crew's supervisor or task): its page from
// the host's history, and with --follow the host's push events printed as lines (`page`, `item`, `text`, `prompt`,
// `heartbeat`, `error`). The history spans every session, so a new session needs no `reset`.
import * as store from "../store.mjs";
import { call, ensureHost, hostedHome } from "./client.mjs";

const INTERFACE = 1;

/** Whether `ref` names a hosted crew's supervisor (`falcon`) or one of its tasks (`falcon:t3`). */
export function hostedRef(ref) {
  const m = /^([a-z][a-z0-9-]{0,23})(?::([A-Za-z0-9._-]+))?$/.exec(String(ref ?? ""));
  if (!m || !hostedHome(m[1])) return false;
  return !m[2] || !!store.readTask(m[1], m[2]);
}

const pageOf = (r) => ({
  ok: true, ref: r.ref, session: r.session ?? null, harness: r.harness ?? "claude", view: "chat",
  items: r.items, cursor: r.cursor, more: r.more, prompt: r.requests?.[0] ?? null, agent: r.agent ?? null,
});

/** One page, from the host (started when it does not run). */
export async function hostedPage(ref, { before = null, limit = 200 } = {}) {
  const r = await call("history", { ref, before, limit });
  return r.ok ? pageOf(r) : { ok: false, error: r.error };
}

/** Follows a hosted conversation until a signal or the reader closes its end. */
export async function hostedFollow(ref, out = process.stdout, { limit = 200, signals = true } = {}) {
  let seq = 0;
  const write = (o) => { try { out.write(`${JSON.stringify({ v: INTERFACE, seq: ++seq, at: Date.now(), ...o })}\n`); } catch {} };
  return new Promise((done) => {
    let stopped = false;
    let conn = null;
    let beat = null;
    const open = new Map(); // request id -> request
    const seen = new Set(); // streamed ids announced as an item
    const stop = () => { if (stopped) return; stopped = true; clearInterval(beat); conn?.close(); done(); };
    if (signals) for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(s, stop);
    out.on?.("error", stop);
    const heartbeatMs = Number(process.env.ROLLCALL_API_HEARTBEAT_MS) > 0 ? Number(process.env.ROLLCALL_API_HEARTBEAT_MS) : 15_000;
    let last = Date.now();
    beat = setInterval(() => { if (Date.now() - last >= heartbeatMs) { write({ type: "heartbeat" }); last = Date.now(); } }, Math.min(heartbeatMs, 1000));
    const send = (o) => { last = Date.now(); write(o); };
    const onEvent = (e) => {
      if (e.type === "closed") { if (!stopped) { send({ type: "error", message: "the agent host went away; following again" }); setTimeout(attach, 1000); } return; }
      if (e.ref !== ref) return;
      if (e.ev === "item") { seen.delete(e.item.id); send({ type: "item", item: e.item }); }
      else if (e.ev === "text") {
        if (!seen.has(e.id)) { seen.add(e.id); send({ type: "item", item: { id: e.id, at: Date.now(), kind: e.kind, text: e.append, streaming: true, ...(e.parent ? { parent: e.parent } : {}) } }); }
        else send({ type: "text", id: e.id, append: e.append });
      } else if (e.ev === "request") { open.set(e.request.id, e.request); send({ type: "prompt", prompt: [...open.values()][0] ?? null }); }
      else if (e.ev === "closed") { if (open.delete(e.id)) send({ type: "prompt", prompt: [...open.values()][0] ?? null }); }
    };
    const attach = async () => {
      if (stopped) return;
      try {
        conn = await ensureHost({ onEvent });
        await conn.call("subscribe", { refs: [ref] });
        const r = await conn.call("history", { ref, limit });
        if (!r.ok) { send({ type: "error", message: r.error?.message ?? "the history did not read" }); return; }
        open.clear();
        for (const q of r.requests ?? []) open.set(q.id, q);
        if (seq) send({ type: "reset" });
        send({ type: "page", ...pageOf(r) });
      } catch (e) {
        send({ type: "error", message: e.message });
        setTimeout(attach, 1000);
      }
    };
    void attach();
  });
}
