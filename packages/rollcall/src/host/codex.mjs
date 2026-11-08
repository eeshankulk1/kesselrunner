// A Codex agent's process in the host: codex/session.mjs's startCodex (the code the tmux worker runs too: the app
// server, the thread, the hooks, snapshots, journal, prompts, the usage limit and the context cap), its events turned
// into the ones host/server.mjs hears from a Claude agent (claude/stream.mjs startClaude).
//
// Item ids get the session's first 8 characters as a prefix (`3f2a9c1d:item-4`): Codex numbers live items per
// process, so two sessions in one history would reuse them. A user message keeps the id it was sent with (its client
// id), as a Claude replay does, so the words a front end showed waiting become the item in place.
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DELIVERY, clientId, startCodex } from "../codex/session.mjs";

/** Starts the session; resolves to the runtime host/server.mjs drives (rejects when the thread does not start). */
export async function startCodexAgent({ h, id, cfg, envFile = null, env = process.env, on, log }) {
  // A unix socket path has room for ~100 bytes: the system temp folder, not the store.
  const sock = join(tmpdir(), `rollcall-codex-${process.pid}-${randomBytes(4).toString("hex")}.sock`);
  const pre = `${String(cfg.session).slice(0, 8)}:`;
  const parts = new Map(); // streamed item id -> the summary part it is on (a new part starts a paragraph)
  const idOf = (x, cid) => (x.kind === "user" && cid ? cid : x.id.startsWith("rollcall-") ? x.id : pre + x.id);
  const emit = (e) => on(e);
  const onEvent = (e) => {
    switch (e.type) {
      case "turn-start": return emit({ type: "turn-start" });
      case "taken": return emit({ type: "taken", uuid: e.cid, text: e.text });
      case "item": if (!e.item.skip) emit({ type: "items", items: [{ ...e.item, id: idOf(e.item, e.clientId) }] }); return;
      case "text": {
        const sep = e.part != null && parts.has(e.id) && parts.get(e.id) !== e.part ? "\n\n" : "";
        parts.set(e.id, e.part);
        return emit({ type: "text", id: pre + e.id, kind: e.kind, append: sep + e.append, parent: null });
      }
      case "text-end": parts.delete(e.id); return;
      // The session recorded the context and the cap on its token updates: nothing for the host to record again.
      case "turn-end": parts.clear(); return emit({ type: "turn-end", ms: e.ms, tokens: null, error: e.error, context: null });
      case "request": return emit({ type: "request", rid: e.rid, prompt: e.prompt, input: e.input });
      case "cancel": return emit({ type: "cancel", rid: e.rid });
      case "exit": return emit({ type: "exit", code: e.code, err: e.err });
      default:
    }
  };
  const core = await startCodex({ h, id, cfg, sock, envFile, env, hosted: true, on: onEvent, log });
  return {
    harness: "codex",
    pid: core.pid,
    sock,
    get session() { return cfg.session; },
    get thread() { return core.thread; },
    get turn() { return core.turn; },
    /** Resolves when the session's first snapshot is taken: a first prompt waits for it. */
    baseline: core.baseline,
    /** The client id words go in with: rollcall's deliveries carry rollcall's prefix, so the hooks know they are not the owner's. */
    idFor: (from, uuid) => (from === "owner" ? uuid : clientId(DELIVERY)),
    say: (text, attachments = [], uuid) => core.say(text, attachments, uuid),
    answer: (rid, p, input, a) => core.answer({ ...a, prompt: `codex-${rid}` }).allowed === true,
    interrupt: () => core.interrupt(),
    setModel: (model) => core.setModel(model),
    setMode: () => Promise.resolve({ error: "a Codex worker keeps the permission mode it started with" }),
    /** Ends the session (its SessionEnd hook) and the server. */
    close: () => core.close("exit"),
    kill: (sig) => core.kill(sig),
  };
}
