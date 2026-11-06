// What a worker's transcript says that no hook does: whether a tool call still waits (the newest one with no result
// yet, in its own transcript or in one of its subagents': a subagent asks for its own calls), and who wrote a prompt.
import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as store from "./store.mjs";

// How much of a transcript's end is read: a call waiting on its prompt is among the last entries.
const TAIL = 256 * 1024;
// A subagent's transcript counts while it was written this recently: an older one has no prompt open.
const RECENT_MS = 10 * 60_000;
// Calls that wait on a subagent, not on a prompt of their own.
const WAITERS = new Set(["Agent", "Task"]);

/** The entries in the last TAIL bytes of a JSONL file (a line the cut split is dropped); [] when unreadable. */
export function tail(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    if (len < size) lines.shift();
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The calls in `entries` with no result yet: [{ id, at, name, input }]. */
export function pending(entries) {
  const done = new Set();
  const calls = [];
  for (const e of entries) {
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "tool_result") done.add(c.tool_use_id);
      else if (c?.type === "tool_use" && !WAITERS.has(c.name)) calls.push({ id: c.id, at: Date.parse(e.timestamp) || 0, name: c.name, input: c.input ?? {} });
    }
  }
  return calls.filter((c) => !done.has(c.id));
}

// As tmux.type sends it: no control characters but line breaks and tabs.
const flat = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim();

/**
 * Whether `prompt`, as a hook or the transcript has it, holds `sent`: Claude Code wraps a long paste in a tag,
 * and what was in the box already goes in front.
 */
export function sameWords(sent, prompt) {
  const a = flat(sent);
  return !!a && flat(prompt).includes(a);
}

// A record from the worker's own clock can sit this far before the hook's time for the same prompt.
const AUTHOR_SKEW_MS = 10_000;

/** What a transcript entry says of a prompt: { text, at, owner }, or null when it is none. */
function promptOf(e) {
  const at = Date.parse(e?.timestamp);
  if (e?.type === "attachment" && e.attachment?.type === "queued_command") {
    // Typed in the middle of a turn: it reaches the model alongside the next tool result.
    return { text: e.attachment.prompt, at, owner: e.attachment.origin?.kind === "human" };
  }
  if (e?.type !== "user") return null;
  const content = e.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text).join("\n") : "";
  return text ? { text, at, owner: !e.isMeta && e.origin?.kind === "human" } : null;
}

/**
 * Who wrote prompt `text`, submitted at `since`, from the records of transcript `file`: "owner", "machine" (a
 * scheduled wake-up, Claude Code's own continuation, a task notification), or null while no record shows it.
 * Claude Code marks each prompt there (`origin`, `isMeta`) and in no hook payload.
 */
export function promptAuthor(file, text, since) {
  if (typeof file !== "string" || !file) return null;
  const entries = tail(file);
  for (let i = entries.length - 1; i >= 0; i--) {
    const p = promptOf(entries[i]);
    if (!p) continue;
    if (p.at < since - AUTHOR_SKEW_MS) return null;
    if (sameWords(text, p.text)) return p.owner ? "owner" : "machine";
  }
  return null;
}

/** A call as its prompt shows it: { tool, what (the command, file or address, one line), why (its description) }. */
export function describe({ name, input }) {
  const one = (v, n) => (typeof v === "string" && v.trim() ? store.clip(store.oneLine(v), n) : null);
  const what = ["command", "file_path", "notebook_path", "path", "url", "pattern", "query"].map((k) => one(input?.[k], 240)).find(Boolean) ?? null;
  return { tool: name, what, why: one(input?.description, 120) };
}

/** What a worker's open dialog asks (workerState's `asks`), in a few words: 'approval for Bash: Copy the icon (`cp a b`)'. */
export function asksText(asks) {
  const quoted = asks?.message ? ` ("${store.clip(store.oneLine(asks.message), 160)}")` : "";
  if (asks?.tool) return `approval for ${asks.tool}${asks.why ? `: ${asks.why}` : ""}${asks.what ? ` (\`${asks.what}\`)` : ""}`;
  if (asks?.type === "elicitation_dialog") return `a question from one of its tools${quoted}`;
  return `a permission prompt${quoted}`;
}

/**
 * What the prompt open in the session with transcript `transcript` asks: describe() of the newest call with
 * no result, in that transcript or a subagent's written in the last `recent` ms (RECENT_MS); null when none is found.
 * A prompt left open writes nothing, so a caller that asks about one open for long passes the time it opened.
 */
export function asked(transcript, now = Date.now(), recent = RECENT_MS) {
  if (typeof transcript !== "string" || !transcript) return null;
  const files = [transcript];
  const subagents = join(dirname(transcript), basename(transcript, ".jsonl"), "subagents");
  try {
    for (const n of readdirSync(subagents)) {
      const f = join(subagents, n);
      if (n.endsWith(".jsonl") && now - statSync(f).mtimeMs < recent) files.push(f);
    }
  } catch {}
  const call = files.flatMap((f) => pending(tail(f))).sort((a, b) => b.at - a.at)[0];
  return call ? describe(call) : null;
}
