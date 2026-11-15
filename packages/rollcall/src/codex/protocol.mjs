// The Codex app server's protocol shapes a worker needs (codex/worker.mjs): the dialog, approval and question
// shapes, the usage-limit and context reads, and the client ids that mark rollcall's own messages in a thread.
import { createHash, randomBytes } from "node:crypto";

/** rollcall's messages into a thread: "rollcall-d-" a delivery (send.mjs), "rollcall-i-" a note of the worker's own. */
export const DELIVERY = "rollcall-d-";
export const INJECTED = "rollcall-i-";
export const clientId = (prefix) => `${prefix}${randomBytes(6).toString("hex")}`;

/** The text of a userMessage item: its text parts, joined. */
export const textOf = (item) => (item?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n").trim();

/** An object without its null, undefined and empty-string fields. */
const present = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ""));

/**
 * Codex's server requests that open a dialog the owner answers, as the hook payload Claude Code's PermissionRequest
 * would carry. The input names everything that makes one request differ from another (the command's argv and folder,
 * every file a patch changes and a hash of the changes, the permissions asked for): away mode's grant matches on it.
 */
export function dialogPayload(method, p) {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    const argv = Array.isArray(p?.command) ? p.command : null;
    const command = argv ? argv.join(" ") : p?.command ?? "";
    const tool_input = present({ command, argv: argv && argv.length > 1 ? argv : null, cwd: p?.cwd, network: p?.networkApprovalContext, description: p?.reason });
    return { tool_name: "Bash", tool_input, notification_type: "permission_prompt", message: p?.reason ?? null };
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    const changes = p?.fileChanges && typeof p.fileChanges === "object" ? p.fileChanges : {};
    const files = Object.keys(changes).sort();
    const hash = files.length ? createHash("sha256").update(JSON.stringify(files.map((f) => [f, changes[f]]))).digest("hex").slice(0, 16) : null;
    const tool_input = present({ file_path: p?.grantRoot ?? files[0], files: files.length > 1 ? files : null, changes: hash, description: p?.reason });
    return { tool_name: "Edit", tool_input, notification_type: "permission_prompt", message: p?.reason ?? null };
  }
  if (method === "item/permissions/requestApproval") {
    const tool_input = present({ permissions: p?.permissions, cwd: p?.cwd, description: p?.reason });
    return { tool_name: null, tool_input, notification_type: "permission_prompt", message: p?.reason ?? "Codex asks for more permissions" };
  }
  if (method === "mcpServer/elicitation/request") return { tool_name: null, notification_type: "elicitation_dialog", message: `${p?.serverName ?? "an MCP server"} asks for input` };
  return null;
}

/** The server requests that ask the owner's permission for an action (not an MCP server's question). */
export const APPROVALS = new Set(["item/commandExecution/requestApproval", "execCommandApproval", "item/fileChange/requestApproval", "applyPatchApproval", "item/permissions/requestApproval"]);

/**
 * The answer to approval request `method` that rollcall decided (away.mjs): allowed
 * (`always`: for the rest of the session, where Codex offers that), or declined so the turn goes on (`cancel` /
 * `abort` would stop it). The older requests carry the reason with the denial; the newer ones take none.
 */
export function approvalAnswer(method, p, allow, reason = null, always = false) {
  if (method === "execCommandApproval" || method === "applyPatchApproval") return { decision: allow ? "approved" : { denied: { rejection: reason ?? "the owner declined it" } } };
  if (method === "item/permissions/requestApproval") return allow ? { permissions: p?.permissions ?? {}, scope: always ? "session" : "turn" } : { permissions: {}, scope: "turn" };
  return { decision: allow ? (always ? "acceptForSession" : "accept") : "decline" };
}

/** A PermissionRequest decision from the hook's JSON answer: { behavior, message }, or null. */
export const decisionIn = (out) => { try { return JSON.parse(out)?.hookSpecificOutput?.decision ?? null; } catch { return null; } };

/** A request_user_input call's questions as AskUserQuestion's: { question, header, options, multiSelect }. Free-text questions keep no options. */
export function questionsOf(p) {
  return (p?.questions ?? []).map((x) => ({
    question: x.question, header: x.header ?? "", multiSelect: false,
    options: (x.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })),
  }));
}

/** The answer to a request_user_input call that rollcall took to the owner's picker: the hook's reason, for each question. */
export function answerFor(p, reason) {
  return { answers: Object.fromEntries((p?.questions ?? []).map((x) => [x.id, { answers: [reason] }])) };
}

/** Whether a failed turn's error is the account's usage limit. */
export const usageLimited = (err) => err?.codexErrorInfo === "usageLimitExceeded" || (typeof err?.codexErrorInfo === "object" && err.codexErrorInfo && "usageLimitExceeded" in err.codexErrorInfo);

/** The context use a token usage update says: { pct, tokens, size } (the last request's tokens against the window), or null. */
export function contextOf(usage) {
  const size = usage?.modelContextWindow;
  const tokens = usage?.last?.totalTokens ?? usage?.last?.inputTokens;
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(tokens)) return null;
  return { pct: Math.min(100, Math.round((tokens / size) * 100)), tokens, size, total: usage?.total?.totalTokens ?? null };
}
