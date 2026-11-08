// A Codex worker's conversation as the chat's items (API.md "Items"), the same shapes conversation.mjs folds out of a
// Claude transcript. The worker (codex/worker.mjs) hears every item of its thread from its app server, in either view,
// and writes each one, mapped here, as a line of its journal (`codex-<session>.jsonl` in its folder): a later line
// with the same id replaces the item (a command's result arrived). Text that streams now goes to stream.live.json, as
// a Claude worker's does. A journal missing when a worker resumes a thread is written from the thread's saved history
// (thread/resume's turns), whose item ids differ from the live ones: the journal only ever holds one or the other.
import { cutInput, cutText, oneLine, summaryOf } from "../conversation.mjs";
import { isAbsolute, relative } from "node:path";
import { P } from "../session.mjs";

/** rollcall's own messages into a thread carry a clientUserMessageId starting with this (codex/worker.mjs). */
const OURS = "rollcall-";
/** The ids of messages rollcall writes that are not the owner's words: the brief ("rollcall-l-") and its own notes ("rollcall-i-"). */
const NOT_OWNER = /^rollcall-[li]-/;

/** A tool item's state from Codex's status. */
export const stateOf = (status) => ({ inProgress: "running", completed: "done", failed: "error", declined: "denied" })[status] ?? "done";

const textOfUser = (item) => (item?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n").trimEnd();
const imagesOfUser = (item) => (item?.content ?? []).filter((c) => c?.type === "localImage" && c.path).map((c) => c.path);

/** A file change's unified diff, every file in one: Codex's diff for an update, the whole text for an add or delete. */
export function patchOfChanges(changes, cwd = null) {
  const rel = (p) => (cwd && isAbsolute(p) && p.startsWith(`${cwd}/`) ? relative(cwd, p) : String(p ?? "").replace(/^\//, ""));
  const out = [];
  for (const c of Array.isArray(changes) ? changes : []) {
    const path = rel(c?.path);
    const diff = String(c?.diff ?? "");
    const kind = c?.kind?.type;
    const lines = diff === "" ? [] : diff.replace(/\n$/, "").split("\n");
    if (kind === "add" && !/^@@ /m.test(diff)) out.push(`--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`);
    else if (kind === "delete" && !/^@@ /m.test(diff)) out.push(`--- a/${path}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${lines.map((l) => `-${l}`).join("\n")}`);
    else out.push(/^--- /m.test(diff) ? diff.replace(/\n$/, "") : `--- a/${path}\n+++ b/${kind === "update" && c.kind.move_path ? rel(c.kind.move_path) : path}\n${diff.replace(/\n$/, "")}`);
  }
  const d = out.join("\n");
  return d ? cutText(d).text : null;
}

/** An MCP or dynamic tool's result as text: its text parts, else the whole content as JSON. */
const contentText = (content) => {
  if (!Array.isArray(content)) return content == null ? "" : typeof content === "string" ? content : JSON.stringify(content);
  const texts = content.map((c) => (c?.type === "text" || c?.type === "inputText" ? c.text : null)).filter((x) => typeof x === "string");
  return texts.length ? texts.join("\n") : JSON.stringify(content);
};

const tool = (base, { name, input, summary, state, result = null, patch = null }) => {
  const x = { ...base, kind: "tool", tool: name, summary, input: cutInput(input ?? {}), state, result: state === "running" ? null : result ?? cutText("") };
  if (patch) x.patch = patch;
  return x;
};

/**
 * The chat item a Codex thread item maps to, or null (an item the chat does not show). `at` is when it was heard,
 * `cwd` the worker's folder (paths in summaries are relative to it), `id` the item id to use (a history item's is
 * prefixed with its turn's, so two threads' "item-1" never meet), and `from` what the message's client id says.
 */
export function itemOf(item, { at = Date.now(), cwd = null, id = item?.id } = {}) {
  if (!item?.type || !id) return null;
  const base = { id, at };
  switch (item.type) {
    case "userMessage": {
      const text = textOfUser(item);
      const cid = String(item.clientId ?? "");
      const from = NOT_OWNER.test(cid) || text.startsWith(P) ? "rollcall" : "owner";
      // A message rollcall sent keeps its client id as its item id: the chat showed it under that id while it waited.
      return { ...base, id: cid.startsWith(OURS) ? cid : id, kind: "user", text, images: imagesOfUser(item), from, queued: false };
    }
    case "agentMessage": return item.text ? { ...base, kind: "assistant", text: item.text, streaming: false } : null;
    case "plan": return item.text ? { ...base, kind: "assistant", text: item.text, streaming: false } : null;
    case "reasoning": {
      const text = (item.summary?.length ? item.summary : item.content ?? []).filter(Boolean).join("\n\n").trim();
      return text ? { ...base, kind: "thinking", text, streaming: false } : null;
    }
    case "hookPrompt": {
      const text = (item.fragments ?? []).map((f) => f?.text).filter(Boolean).join("\n").trim();
      return text ? { ...base, kind: "system", text } : null;
    }
    case "commandExecution": {
      const state = item.status === "completed" && Number.isInteger(item.exitCode) && item.exitCode !== 0 ? "error" : stateOf(item.status);
      const out = String(item.aggregatedOutput ?? "");
      return tool(base, { name: "Bash", input: { command: item.command, cwd: item.cwd }, summary: oneLine(item.command), state, result: cutText(out) });
    }
    case "fileChange": {
      const files = (item.changes ?? []).map((c) => c?.path).filter(Boolean);
      const first = files[0] ?? "";
      const summary = oneLine(`${summaryOf("Edit", { file_path: first }, cwd)}${files.length > 1 ? ` and ${files.length - 1} more` : ""}`);
      return tool(base, { name: "Edit", input: { file_path: first, ...(files.length > 1 ? { files } : {}) }, summary, state: stateOf(item.status), patch: patchOfChanges(item.changes, cwd) });
    }
    case "mcpToolCall": {
      const name = `mcp__${item.server}__${item.tool}`;
      const input = item.arguments && typeof item.arguments === "object" ? item.arguments : { arguments: item.arguments };
      const result = item.error?.message ? cutText(item.error.message) : cutText(contentText(item.result?.content));
      return tool(base, { name, input, summary: summaryOf(name, input, cwd), state: item.error ? "error" : stateOf(item.status), result });
    }
    case "dynamicToolCall": {
      const name = item.namespace ? `${item.namespace}.${item.tool}` : item.tool;
      const input = item.arguments && typeof item.arguments === "object" ? item.arguments : { arguments: item.arguments };
      const state = item.success === false ? "error" : stateOf(item.status);
      return tool(base, { name, input, summary: summaryOf(name, input, cwd), state, result: cutText(contentText(item.contentItems)) });
    }
    case "collabAgentToolCall": {
      if (item.tool === "spawnAgent") {
        const s = stateOf(item.status);
        return { ...base, kind: "subagent", agent: item.model ? `codex (${item.model})` : "codex", description: oneLine(item.prompt ?? ""), state: s === "denied" ? "error" : s, result: null, children: 0 };
      }
      const input = { tool: item.tool, agents: item.receiverThreadIds ?? [] };
      return tool(base, { name: `Agent.${item.tool}`, input, summary: oneLine(`Agent ${item.tool}`), state: stateOf(item.status) });
    }
    case "webSearch": return tool(base, { name: "WebSearch", input: { query: item.query }, summary: oneLine(item.query), state: "done" });
    case "imageView": return tool(base, { name: "ViewImage", input: { path: item.path }, summary: summaryOf("Read", { file_path: item.path }, cwd), state: "done" });
    case "imageGeneration": return tool(base, { name: "ImageGeneration", input: { prompt: item.revisedPrompt ?? "" }, summary: oneLine(item.savedPath ?? item.revisedPrompt ?? "an image"), state: stateOf(item.status), result: cutText(item.savedPath ?? "") });
    case "enteredReviewMode": return { ...base, kind: "system", text: "Codex started a review" };
    case "exitedReviewMode": return { ...base, kind: "system", text: "Codex finished its review" };
    case "contextCompaction": return { ...base, kind: "compaction", trigger: "auto", tokens: null };
    default: return null;
  }
}

/** Codex's plan for a turn (turn/plan/updated) as the chat's todo list: one item per turn, the latest list. */
export function todosOf(turnId, plan, at = Date.now()) {
  const status = (s) => (s === "inProgress" ? "in_progress" : s === "completed" ? "completed" : "pending");
  return { id: `todos:${turnId}`, at, kind: "todos", todos: (plan ?? []).map((s) => ({ content: s.step, status: status(s.status), activeForm: s.step })) };
}

export const turnStart = (turnId, at) => ({ id: `turn-start:${turnId}`, at, kind: "turn", phase: "start" });

/** A turn's end: its time, its tokens ({ input, output, context }) and, when it failed or was stopped, one line why. */
export function turnEnd(turn, { at = Date.now(), startedAt = null, tokens = null } = {}) {
  const ms = Number.isFinite(turn?.durationMs) ? turn.durationMs : startedAt ? Math.max(0, at - startedAt) : 0;
  const x = { id: `turn-end:${turn.id}`, at, kind: "turn", phase: "end", ms };
  if (tokens) x.tokens = tokens;
  if (turn.status === "failed") x.error = oneLine(turn.error?.message ?? "the turn failed", 200);
  else if (turn.status === "interrupted") x.error = "Stopped";
  return x;
}

/** A thread's saved history (thread/resume's turns) as journal lines, for a worker whose journal is missing. */
export function historyItems(turns, { cwd = null } = {}) {
  const out = [];
  for (const t of turns ?? []) {
    if (!t?.id) continue;
    const start = Number.isFinite(t.startedAt) ? t.startedAt * 1000 : Date.now();
    out.push(turnStart(t.id, start));
    for (const it of t.items ?? []) {
      const x = itemOf(it, { at: start, cwd, id: `${t.id}:${it.id}` });
      if (x) out.push(x);
    }
    if (t.status !== "inProgress") out.push(turnEnd(t, { at: Number.isFinite(t.completedAt) ? t.completedAt * 1000 : start }));
  }
  return out;
}

/**
 * A folder over journal lines (conversation.mjs feeds it, as it feeds a Claude transcript to its own folder): items
 * in first-heard order, a later line replacing the item with the same id. A `{ id, skip: true }` line names an id
 * the chat shows nothing for (an empty reasoning block), so its live text leaving is no reset.
 */
export function createJournalFolder({ cwd = null, session = null } = {}) {
  const items = [];
  const index = new Map();
  const known = new Set();
  const dirty = new Set();
  const f = { items, session, cwd, subagents: [], agentOf: new Map() };
  f.add = (o) => {
    if (!o?.id) return;
    if (o.skip) { known.add(o.id); return; }
    if (!o.kind) return;
    const at = index.get(o.id);
    if (at !== undefined) items[at] = o;
    else {
      index.set(o.id, items.length);
      items.push(o);
    }
    if (o.kind === "subagent") {
      const k = f.subagents.findIndex((s) => s.id === o.id);
      if (k < 0) f.subagents.push(o);
      else f.subagents[k] = o;
    }
    dirty.add(o.id);
  };
  f.get = (id) => (index.has(id) ? items[index.get(id)] : null);
  f.has = (id) => index.has(id) || known.has(id);
  f.takeDirty = () => { const d = [...dirty].sort((a, b) => index.get(a) - index.get(b)); dirty.clear(); return d.map(f.get); };
  return f;
}
