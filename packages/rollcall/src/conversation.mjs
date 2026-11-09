// A Claude transcript (or a Codex journal) folded into the chat's items (API.md "Items"): the agent host's own
// folder for the stream it runs (claude/stream.mjs createFolder), and the reader that backfills a hosted task's
// history with its earlier sessions (host/history.mjs). turns.jsonl gives a turn end its time and tokens.
//
// Transcripts are large (tens of MB, mostly the whole API request on `api-request*` lines), so a line is judged by
// its first bytes and only the kept ones are parsed.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { createJournalFolder } from "./codex/items.mjs";
import { P } from "./session.mjs";
import * as store from "./store.mjs";

const INPUT_CUT = 2000;
const RESULT_CUT = 100_000;
const PAGE = 200;
const envMs = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : dflt; };

// ---------------------------------------------------------------- lines

// Attachments worth reading: a message the owner sent mid-turn, and hook messages the CLI shows the owner.
const KEEP_ATTACHMENT = new Set(["queued_command", "hook_blocking_error", "hook_non_blocking_error"]);
const KEEP_TYPE = new Set(["user", "assistant", "system"]);

/** Whether the line in buf[start, end) is one the fold reads, from its first bytes only (no parse). */
function wanted(buf, start, end) {
  const head = buf.toString("latin1", start, Math.min(end, start + 240));
  const top = /^\{"type":"([^"]+)"/.exec(head);
  if (top && top[1] !== "attachment") return KEEP_TYPE.has(top[1]);
  const a = /"attachment":\{"type":"([^"]+)"/.exec(head);
  if (a) return KEEP_ATTACHMENT.has(a[1]);
  return !top && head.startsWith("{");
}

/** Feeds the complete lines of buf[from, to) to `folder`; returns where the unread rest (a partial line) starts. */
function feed(folder, buf, from = 0, to = buf.length) {
  let i = from;
  while (i < to) {
    const j = buf.indexOf(10, i);
    if (j < 0 || j >= to) break;
    if (j > i && wanted(buf, i, j)) {
      let o = null;
      try { o = JSON.parse(buf.toString("utf8", i, j)); } catch {}
      if (o) folder.add(o);
    }
    i = j + 1;
  }
  return i;
}

// ---------------------------------------------------------------- the fold

export const oneLine = (s, max = 300) => {
  const t = String(s ?? "").trim();
  const first = t.split("\n")[0];
  const line = first.length < t.length ? `${first} …` : first;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
export const cutText = (text) => {
  const t = String(text ?? "");
  return { text: t.length > RESULT_CUT ? t.slice(0, RESULT_CUT) : t, truncated: t.length > RESULT_CUT, size: t.length };
};
/** `input` with every long string cut at 2,000 chars. */
export const cutInput = (v) => {
  if (typeof v === "string") return v.length > INPUT_CUT ? v.slice(0, INPUT_CUT) : v;
  if (Array.isArray(v)) return v.map(cutInput);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cutInput(x)]));
  return v;
};
const blocksText = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
};
const tag = (text, name) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text); return m ? m[1].trim() : null; };

// A tool result that says the owner, a hook or the permission system stopped the call.
const DENIED = /^(The user doesn't want to proceed|The user doesn't want to take this action|Permission for this action was denied|Permission to use \S+ has been denied|PreToolUse:\S+ hook error|This (Bash )?command .*requires approval|A variable in this command can't be checked)|tool use was rejected/;

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const AGENTS = new Set(["Task", "Agent"]);

/** The one-line summary of a tool call. */
export function summaryOf(tool, input = {}, cwd = null) {
  const rel = (p) => (typeof p === "string" && cwd && isAbsolute(p) && p.startsWith(`${cwd}/`) ? relative(cwd, p) : p);
  const i = input ?? {};
  if (tool === "Bash") return oneLine(i.command);
  if (EDITS.has(tool)) return oneLine(`Edit ${rel(i.file_path ?? i.notebook_path ?? "")}`);
  if (tool === "Read") return oneLine(`Read ${rel(i.file_path ?? "")}`);
  if (tool === "Grep" || tool === "Glob") return oneLine(i.pattern);
  if (tool === "WebFetch") return oneLine(i.url);
  if (tool === "WebSearch") return oneLine(i.query);
  if (AGENTS.has(tool)) return oneLine(i.description);
  const key = ["file_path", "path", "url", "query", "pattern", "command", "description", "skill", "prompt", "name", "title", "task_id", "action"].find((k) => typeof i[k] === "string" && i[k]);
  const val = key ? i[key] : Object.values(i).find((x) => typeof x === "string" && x);
  return oneLine(val ? `${tool} ${rel(val)}` : tool);
}

const hunk = (path, body) => `--- a/${path}\n+++ b/${path}\n${body}`;
const lines = (s) => (s === "" ? [] : String(s ?? "").split("\n"));
const simpleHunk = (oldS, newS) => {
  const o = lines(oldS), n = lines(newS);
  return `@@ -${o.length ? 1 : 0},${o.length} +${n.length ? 1 : 0},${n.length} @@\n${[...o.map((l) => `-${l}`), ...n.map((l) => `+${l}`)].join("\n")}`;
};
/** A unified diff for an edit, from the result's structuredPatch when there is one, else from the call's input. */
export function patchOf(tool, input, extra, cwd = null) {
  if (!["Edit", "Write", "MultiEdit"].includes(tool) || !input?.file_path) return null;
  const path = cwd && input.file_path.startsWith(`${cwd}/`) ? relative(cwd, input.file_path) : input.file_path.replace(/^\//, "");
  const sp = extra?.structuredPatch;
  let body;
  if (Array.isArray(sp) && sp.length) body = sp.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${(h.lines ?? []).join("\n")}`).join("\n");
  else if (tool === "Write") body = simpleHunk(extra?.originalFile ?? "", input.content ?? "");
  else if (tool === "Edit") body = simpleHunk(input.old_string, input.new_string);
  else body = (input.edits ?? []).map((e) => simpleHunk(e.old_string, e.new_string)).join("\n");
  const d = hunk(path, body);
  return d.length > RESULT_CUT ? d.slice(0, RESULT_CUT) : d;
}

/** Where a pasted image (base64 in the transcript) is saved so a front end can show it by path; once per image. */
function saveImage(session, id, block) {
  const src = block?.source;
  if (src?.type !== "base64" || !src.data) return null;
  const ext = (/^image\/(\w+)/.exec(src.media_type ?? "")?.[1] ?? "png").replace("jpeg", "jpg");
  const dir = join(tmpdir(), "rollcall-images", String(session ?? "unknown").replace(/[^\w-]/g, ""));
  const file = join(dir, `${String(id).replace(/[^\w:-]/g, "")}.${ext}`.replace(/:/g, "-"));
  try {
    if (!existsSync(file)) { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(file, Buffer.from(src.data, "base64"), { mode: 0o600 }); }
    return file;
  } catch { return null; }
}

/**
 * An incremental fold of transcript entries into items. `add(entry)` takes one parsed line; `items` is the order;
 * `takeDirty()` names the ids added or changed since the last call. `child` folds a subagent's own file: every item
 * gets `parent`, and the subagent's prompt and turns are left out.
 */
export function createFolder({ cwd = null, parent = null, images = saveImage } = {}) {
  const items = [];
  const index = new Map();
  const known = new Set(); // ids the transcript holds without an item (an empty thinking block), for the live overlay
  const dirty = new Set();
  const blocks = new Map(); // message.id -> the next block's ordinal
  const seen = new Set();
  const agentOf = new Map(); // subagent item id -> its agentId
  const raw = new Map(); // edit tool id -> its whole input, for the patch once the result arrives
  const subagents = [];
  const fromDuration = new Set(); // turn ends whose ms came from Claude Code's own turn_duration
  let turn = null;
  let lastEnd = null;
  let lastAt = 0;
  const f = { items, session: null, cwd, agentOf, subagents };

  const put = (item) => {
    if (parent && (item.kind === "turn" || item.kind === "user")) return item;
    if (parent) item.parent = parent;
    if (index.has(item.id)) items[index.get(item.id)] = item;
    else { index.set(item.id, items.length); items.push(item); }
    dirty.add(item.id);
    return item;
  };
  const get = (id) => (index.has(id) ? items[index.get(id)] : null);
  const system = (id, at, text) => { if (text?.trim()) put({ id, at, kind: "system", text: text.trim() }); };
  const startTurn = (uuid, at) => { put({ id: `turn-start:${uuid}`, at, kind: "turn", phase: "start" }); turn = { at, error: null }; };
  const endTurn = (uuid, at, { ms = null, error = null } = {}) => {
    if (!turn) return;
    const item = { id: `turn-end:${uuid}`, at, kind: "turn", phase: "end", ms: ms ?? Math.max(0, at - turn.at) };
    const err = error ?? turn.error;
    if (err) item.error = err;
    if (ms != null) fromDuration.add(item.id);
    turn = null;
    lastEnd = put(item);
  };

  const notification = (text, id, at) => {
    const toolId = tag(text, "tool-use-id");
    const status = tag(text, "status");
    const result = tag(text, "result");
    const item = toolId ? get(toolId) : null;
    if (item?.kind === "subagent") {
      if (status === "completed") item.state = "done";
      else if (status && status !== "running") item.state = "error";
      if (result) item.result = cutText(result);
      put(item);
    }
    system(id, at, tag(text, "summary") ?? "A background task finished");
  };

  const toolUse = (b, at) => {
    const input = b.input ?? {};
    if (AGENTS.has(b.name)) {
      const s = put({ id: b.id, at, kind: "subagent", agent: input.subagent_type ?? "general-purpose", description: input.description ?? "", state: "running", result: null, children: 0 });
      if (!parent) subagents.push(s);
      return s;
    }
    if (b.name === "TodoWrite") return put({ id: b.id, at, kind: "todos", todos: (input.todos ?? []).map((t) => ({ content: t.content, status: t.status, activeForm: t.activeForm })) });
    const item = { id: b.id, at, kind: "tool", tool: b.name, summary: summaryOf(b.name, input, f.cwd), input: cutInput(input), state: "running", result: null };
    const patch = patchOf(b.name, input, null, f.cwd);
    if (patch) { item.patch = patch; raw.set(b.id, input); }
    return put(item);
  };

  const toolResult = (b, extra) => {
    const item = get(b.tool_use_id);
    if (!item || item.kind === "todos") return;
    const text = blocksText(b.content);
    const state = b.is_error ? (DENIED.test(text) ? "denied" : "error") : "done";
    if (item.kind === "subagent") {
      if (extra?.agentId) agentOf.set(item.id, extra.agentId);
      if (extra?.status === "async_launched" && !b.is_error) return put(item);
      item.state = state === "denied" ? "error" : state;
      item.result = cutText(text);
      return put(item);
    }
    item.state = state;
    item.result = cutText(text);
    if (state === "done" && raw.has(item.id)) {
      const patch = patchOf(item.tool, raw.get(item.id), extra, f.cwd);
      if (patch) item.patch = patch;
    }
    raw.delete(item.id);
    put(item);
  };

  const user = (o, at) => {
    if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return;
    const c = o.message?.content;
    if (Array.isArray(c) && c.some((b) => b?.type === "tool_result")) {
      for (const b of c) if (b?.type === "tool_result") toolResult(b, o.toolUseResult && typeof o.toolUseResult === "object" ? o.toolUseResult : null);
      return;
    }
    // A long paste comes wrapped in <pasted_content id="..."> tags: the words are the owner's (or rollcall's) all the same.
    const text = (typeof c === "string" ? c : (c ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("\n")).replace(/<\/?pasted_content[^>]*>\n?/g, "").trim();
    const imgs = Array.isArray(c) ? c.filter((b) => b?.type === "image") : [];
    if (!text && !imgs.length) return;
    const id = o.uuid;
    if (text.startsWith("<task-notification>")) return notification(text, id, at);
    if (/^<local-command-(stdout|stderr)>/.test(text)) return system(id, at, text.replace(/<\/?local-command-(stdout|stderr)>/g, ""));
    if (text.startsWith("<bash-input>")) return put({ id, at, kind: "user", text: `!${tag(text, "bash-input") ?? ""}`, images: [], from: "owner", queued: false });
    if (/^<bash-(stdout|stderr)>/.test(text)) return system(id, at, [tag(text, "bash-stdout"), tag(text, "bash-stderr")].filter(Boolean).join("\n"));
    if (text.startsWith("<command-name>") || text.startsWith("<command-message>")) {
      const name = tag(text, "command-name");
      if (name) put({ id, at, kind: "user", text: `${name} ${tag(text, "command-args") ?? ""}`.trim(), images: [], from: "owner", queued: false });
      return;
    }
    if (/^<(local-command-caveat|system-reminder)>/.test(text)) return;
    if (/^\[Request interrupted by user/.test(text)) {
      system(id, at, "Interrupted");
      return endTurn(id, at, { error: "interrupted" });
    }
    if (turn) endTurn(id, lastAt);
    startTurn(id, at);
    put({ id, at, kind: "user", text, images: imgs.map((b, n) => images?.(f.session, `${id}-${n}`, b)).filter(Boolean), from: text.startsWith(P) ? "rollcall" : "owner", queued: false });
  };

  const assistant = (o, at) => {
    const m = o.message ?? {};
    if (o.isApiErrorMessage) {
      const text = blocksText(m.content);
      if (turn) turn.error = oneLine(text, 200);
      return system(o.uuid, at, text);
    }
    if (!turn && !parent) startTurn(o.uuid, at);
    const mid = m.id ?? o.uuid;
    for (const b of Array.isArray(m.content) ? m.content : []) {
      const n = blocks.get(mid) ?? 0;
      blocks.set(mid, n + 1);
      const id = `${mid}:${n}`;
      if (b.type === "text") { if (b.text) put({ id, at, kind: "assistant", text: b.text, streaming: false }); else known.add(id); }
      else if (b.type === "thinking") { if (b.thinking) put({ id, at, kind: "thinking", text: b.thinking, streaming: false }); else known.add(id); }
      else if (b.type === "tool_use") toolUse(b, at);
      else known.add(id);
    }
  };

  const sys = (o, at) => {
    switch (o.subtype) {
      case "compact_boundary": {
        const md = o.compactMetadata ?? {};
        const item = { id: `compact:${o.uuid}`, at, kind: "compaction", trigger: md.trigger === "manual" ? "manual" : "auto" };
        if (Number.isFinite(md.preTokens)) item.tokens = md.preTokens;
        return put(item);
      }
      case "stop_hook_summary": return endTurn(o.uuid, at);
      case "turn_duration":
        if (turn) return endTurn(o.uuid, at, { ms: o.durationMs });
        if (lastEnd && !fromDuration.has(lastEnd.id) && Number.isFinite(o.durationMs)) { lastEnd.ms = o.durationMs; fromDuration.add(lastEnd.id); put(lastEnd); }
        return;
      case "informational": case "scheduled_task_fire":
        return system(o.uuid, at, o.content);
      case "away_summary":
        return system(o.uuid, at, String(o.content ?? "").replace(/\s*\(disable recaps in \/config\)\s*$/, ""));
      case "local_command": {
        const out = tag(String(o.content ?? ""), "local-command-stdout") ?? tag(String(o.content ?? ""), "local-command-stderr");
        return system(o.uuid, at, out);
      }
      default:
        if (o.level === "error" && typeof o.content === "string") return system(o.uuid, at, o.content);
    }
  };

  const attachment = (o, at) => {
    const a = o.attachment ?? {};
    if (a.type === "queued_command") {
      const text = (typeof a.prompt === "string" ? a.prompt : blocksText(a.prompt)).trim();
      const id = a.source_uuid ?? o.uuid;
      if (text.startsWith("<task-notification>")) return notification(text, id, at);
      if (!text) return;
      return put({ id, at, kind: "user", text, images: [], from: text.startsWith(P) ? "rollcall" : "owner", queued: false });
    }
    if (a.type === "hook_blocking_error") return system(o.uuid, at, `${a.hookName ?? "A"} hook: ${a.blockingError?.blockingError ?? a.blockingError ?? ""}`);
    if (a.type === "hook_non_blocking_error") return system(o.uuid, at, `${a.hookName ?? "A"} hook error: ${a.stderr || a.stdout || ""}`);
  };

  f.add = (o) => {
    if (!o || typeof o !== "object") return;
    if (o.uuid) { if (seen.has(o.uuid)) return; seen.add(o.uuid); }
    if (o.isSidechain && !parent) return;
    f.session ??= o.sessionId ?? null;
    if (!f.cwd && typeof o.cwd === "string") f.cwd = o.cwd;
    const at = Date.parse(o.timestamp ?? o.attachment?.timestamp ?? "") || lastAt;
    if (o.type === "user") user(o, at);
    else if (o.type === "assistant") assistant(o, at);
    else if (o.type === "system") sys(o, at);
    else if (o.type === "attachment") attachment(o, at);
    if (at) lastAt = at;
  };
  f.get = get;
  f.has = (id) => index.has(id) || known.has(id);
  f.takeDirty = () => { const d = [...dirty].filter((id) => index.has(id)).sort((a, b) => index.get(a) - index.get(b)); dirty.clear(); return d.map(get); };
  return f;
}

/** The items of a transcript (its text, a Buffer, or an array of lines or entries), in order. */
export function foldTranscript(input, opts = {}) {
  const f = createFolder(opts);
  if (Buffer.isBuffer(input)) feed(f, input);
  else if (typeof input === "string") feed(f, Buffer.from(input.endsWith("\n") ? input : `${input}\n`));
  else for (const x of input ?? []) { if (typeof x === "string") { try { f.add(JSON.parse(x)); } catch {} } else f.add(x); }
  return f.items;
}

// ---------------------------------------------------------------- files

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const readLines = (p) => { try { return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");

/** Session `id`'s transcript: as its hooks recorded it, else where Claude Code keeps it for `cwd`, else found by name. */
export function transcriptFor(id, cwd = null) {
  if (!id) return null;
  const g = store.readGlobal(id)?.transcript;
  if (g) return g;
  if (cwd) { const p = join(projectsDir(), cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`); if (existsSync(p)) return p; }
  try {
    for (const d of readdirSync(projectsDir())) { const p = join(projectsDir(), d, `${id}.jsonl`); if (existsSync(p)) return p; }
  } catch {}
  return cwd ? join(projectsDir(), cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`) : null;
}

/**
 * What `ref` reads: { ok, ref, home, id, harness, dir, session, transcript, cwd, record } or { ok: false, code,
 * message }. A task's current (or last) worker session, or with a bare home the supervisor's own. `transcript` is the
 * file the items come from (a Codex worker's journal), `record` the name of the worker's record in `dir`.
 */
/** turns.jsonl lines matched to the turn ends they belong to (the nearest end within 30 s, each once): Map endId -> line. */
export function matchTurns(ends, turns, session = null) {
  const out = new Map();
  const used = new Set();
  for (const l of turns) {
    if (!Number.isFinite(l?.at) || (session && l.session && l.session !== session)) continue;
    let best = null;
    for (const e of ends) {
      if (used.has(e.id)) continue;
      const d = Math.abs(e.at - l.at);
      if (d <= 30_000 && (!best || d < best.d)) best = { e, d };
    }
    if (best) { used.add(best.e.id); out.set(best.e.id, l); }
  }
  return out;
}

const enrich = (item, matched) => {
  const l = item.kind === "turn" && item.phase === "end" ? matched.get(item.id) : null;
  if (!l) return item;
  const x = { ...item };
  if (Number.isFinite(l.ms)) x.ms = l.ms;
  if (l.tokens) x.tokens = l.tokens;
  if (l.error) x.error = oneLine(l.error, 200);
  return x;
};

/** A subagent's own transcript files next to the main one: Map toolUseId -> path (from each one's meta file). */
function agentFiles(transcript, session) {
  const out = new Map();
  if (!transcript || !session) return out;
  const dir = join(dirname(transcript), session, "subagents");
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith(".meta.json")) continue;
    const meta = readJson(join(dir, n));
    const file = join(dir, n.replace(/\.meta\.json$/, ".jsonl"));
    if (meta?.toolUseId) out.set(meta.toolUseId, file);
  }
  return out;
}

/** A file read from where it was last read: new complete lines go to its folder. */
class Tail {
  constructor(path, folder) { this.path = path; this.folder = folder; this.offset = 0; this.ino = null; }
  /** "grew", "same", "gone" or "replaced" (shrunk or a new file: start over). */
  read() {
    let fd;
    try { fd = openSync(this.path, "r"); } catch { return this.ino === null ? "gone" : "replaced"; }
    try {
      const st = fstatSync(fd);
      if (this.ino !== null && (st.ino !== this.ino || st.size < this.offset)) return "replaced";
      this.ino = st.ino;
      if (st.size <= this.offset) return "same";
      const buf = Buffer.alloc(st.size - this.offset);
      const n = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += feed(this.folder, buf, 0, n);
      return "grew";
    } finally { closeSync(fd); }
  }
}

/** Everything a page or a follow reads for a target. */
function load(target) {
  const folder = target.harness === "codex" ? createJournalFolder({ cwd: target.cwd, session: target.session }) : createFolder({ cwd: target.cwd });
  const tail = target.transcript ? new Tail(target.transcript, folder) : null;
  tail?.read();
  folder.takeDirty();
  return { target, folder, tail, children: new Map() };
}

const turnsOf = (t) => (t.dir ? readLines(join(t.dir, "turns.jsonl")) : []);
const endsOf = (folder) => folder.items.filter((x) => x.kind === "turn" && x.phase === "end");

/** The children of subagent item `s` (folded from its own file), with `s.children` set. Cached per state. */
function childrenOf(state, s, files) {
  let c = state.children.get(s.id);
  if (!c) {
    const file = files.get(s.id);
    if (!file) return [];
    c = new Tail(file, createFolder({ cwd: state.folder.cwd, parent: s.id }));
    state.children.set(s.id, c);
  }
  c.read();
  s.children = c.folder.items.length;
  return c.folder.items;
}

/** The page fields for a loaded state. */
function pageOf(state, { before = null, limit = PAGE } = {}) {
  const { target, folder } = state;
  const matched = matchTurns(endsOf(folder), turnsOf(target), folder.session ?? target.session);
  const all = folder.items;
  let end = all.length;
  if (before != null) {
    end = all.findIndex((x) => x.id === before);
    if (end < 0) return { ok: false, error: { code: "not-found", message: `no item ${before} in this conversation: read the last page again` } };
  }
  const n = Math.max(1, Math.min(Number(limit) || PAGE, 5000));
  const start = Math.max(0, end - n);
  const files = all.slice(start, end).some((x) => x.kind === "subagent") ? agentFiles(tail(state), folder.session ?? target.session) : new Map();
  const items = [];
  for (const x of all.slice(start, end)) {
    const kids = x.kind === "subagent" ? childrenOf(state, x, files) : [];
    items.push(enrich(x, matched), ...kids);
  }
  return {
    ok: true, ref: target.ref, session: folder.session ?? target.session ?? null, harness: target.harness ?? "claude",
    items, cursor: start > 0 ? all[start].id : null, more: start > 0,
  };
}
const tail = (state) => state.tail?.path ?? state.target.transcript;

/**
 * One page of `target` ({ ref, home, id, harness, dir, session, cwd, transcript }: a Claude transcript or a Codex
 * journal): the last `limit` items, or those before item `before`.
 */
export function readPage(target, { before = null, limit = PAGE } = {}) {
  return pageOf(load(target), { before, limit });
}
