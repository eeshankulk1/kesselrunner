// A Codex agent's process in the host: codex/session.mjs's startCodex (the app server, the thread, the hooks, snapshots, journal, prompts, the usage limit and the context cap), its events turned
// into the ones host/server.mjs hears from a Claude agent (claude/stream.mjs startClaude).
//
// Item ids get the session's first 8 characters as a prefix (`3f2a9c1d:item-4`): Codex numbers live items per
// process, so two sessions in one history would reuse them. A user message keeps the id it was sent with (its client
// id), as a Claude replay does, so the words a front end showed waiting become the item in place.
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandOf } from "../claude/stream.mjs";
import { historyItems } from "../codex/items.mjs";
import { once } from "../codex/rpc.mjs";
import { DELIVERY, clientId, startCodex } from "../codex/session.mjs";
import { journalFile } from "../harness/codex.mjs";

/** A history item's id for a journal line of session `session`: the session's prefix, but for rollcall's own ids. */
const historyId = (session, id) => (id.startsWith("rollcall-") ? id : `${String(session).slice(0, 8)}:${id}`);

/**
 * What a terminal (`codex resume <thread>`, the escape hatch) added to the thread, as history items in order. `codex
 * resume` writes no journal, so the thread itself says: Codex's `thread/read` on a short-lived app server. A turn the
 * history knows (`has` its start or end) is skipped, and so is one that started before `since` (ms, when the terminal
 * opened; a turn's start is in whole seconds). The new turns' lines also go in the session's journal, as a turn the
 * worker ran would. Ids as historyItems gives them (`<turn>:<item>`, so they never meet a live item's), prefixed as
 * startCodexAgent prefixes them.
 */
export async function terminalTurns({ h, id, cfg, thread, since = 0, has = () => false, envFile = null, env = process.env }) {
  const [cmd, args] = commandOf(cfg.bin, ["app-server"], envFile);
  const r = await once(cmd, "thread/read", { threadId: thread, includeTurns: true }, { env, args, timeoutMs: 20_000 });
  const fresh = (r?.thread?.turns ?? []).filter((t) => t?.id
    && !has(historyId(cfg.session, `turn-start:${t.id}`)) && !has(historyId(cfg.session, `turn-end:${t.id}`))
    && !(Number.isFinite(t.startedAt) && t.startedAt * 1000 < since - 1000));
  const lines = historyItems(fresh, { cwd: cfg.cwd });
  if (lines.length) { try { appendFileSync(journalFile(h, id, cfg.session), `${lines.map((x) => JSON.stringify(x)).join("\n")}\n`); } catch {} }
  return lines.map((x) => ({ ...x, id: historyId(cfg.session, x.id) }));
}

/**
 * Whether a turn a terminal started on Codex thread `thread` still runs (`status: "inProgress"`), by `thread/read` on
 * a short-lived app server, as terminalTurns reads it; null when that cannot be read. A turn that started before
 * `since` (ms, when the terminal opened) never counts: one the host's own process left unfinished stays in progress.
 */
export async function terminalTurnRunning({ cfg, thread, since = 0, envFile = null, env = process.env }) {
  const [cmd, args] = commandOf(cfg.bin, ["app-server"], envFile);
  try {
    const r = await once(cmd, "thread/read", { threadId: thread, includeTurns: true }, { env, args, timeoutMs: 10_000 });
    return (r?.thread?.turns ?? []).some((t) => t?.status === "inProgress" && Number.isFinite(t.startedAt) && t.startedAt * 1000 >= since - 1000);
  } catch { return null; }
}

/**
 * Starts the session; resolves to the runtime host/server.mjs drives (rejects when the thread does not start). A
 * chat's own session passes `hook` (host/chat-hooks.mjs) for what a task worker's hooks do.
 */
export async function startCodexAgent({ h, id, cfg, envFile = null, env = process.env, hook = null, on, log }) {
  // A unix socket path has room for ~100 bytes: the system temp folder, not the store.
  const sock = join(tmpdir(), `rollcall-codex-${process.pid}-${randomBytes(4).toString("hex")}.sock`);
  const pre = `${String(cfg.session).slice(0, 8)}:`;
  const parts = new Map(); // streamed item id -> the summary part it is on (a new part starts a paragraph)
  const idOf = (x, cid) => (x.kind === "user" && cid ? cid : historyId(cfg.session, x.id));
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
  const core = await startCodex({ h, id, cfg, sock, envFile, env, hosted: true, hook, on: onEvent, log });
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
    // A chat's mode, from its next turn (host/server.mjs refuses it for a task's worker).
    setMode: (mode) => (id ? Promise.resolve({ error: "a Codex worker keeps the permission mode it started with" }) : core.setMode(mode)),
    /** Ends the session (its SessionEnd hook) and the server. */
    close: () => core.close("exit"),
    kill: (sig) => core.kill(sig),
  };
}
