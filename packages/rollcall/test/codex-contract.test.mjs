// What rollcall assumes about the real Codex CLI, checked against the one installed: every app server method,
// notification, server request and field the Codex worker uses (codex/*.mjs), the feature flag its question tool
// needs, and the UI's --remote option. Parts of the app server are marked experimental, so this is the test that
// fails loudly when Codex moves under rollcall. Offline: it reads the CLI's own protocol schema and help, signs in to
// nothing and runs no turn. Skipped where no codex CLI is installed (CI).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bin } from "../src/harness/codex.mjs";

const codex = process.env.ROLLCALL_CODEX_CONTRACT === "0" ? null : bin();
const real = !!codex && !/fake-codex/.test(codex) && spawnSync(codex, ["--version"], { stdio: "ignore", timeout: 15_000 }).status === 0;

test("the installed Codex still offers what the Codex worker uses", { skip: !real && "no codex CLI installed", timeout: 120_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rc-codex-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gen = spawnSync(codex, ["app-server", "generate-json-schema", "--out", dir], { encoding: "utf8", timeout: 60_000 });
  assert.equal(gen.status, 0, `generate-json-schema failed: ${gen.stderr}`);
  const read = (f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
  const methods = (f) => new Set(read(f).oneOf.map((o) => o.properties.method.enum[0]));
  const client = methods("ClientRequest.json");
  const server = methods("ServerRequest.json");
  const notes = methods("ServerNotification.json");
  for (const m of ["initialize", "thread/start", "thread/resume", "thread/read", "turn/start", "turn/steer", "turn/interrupt", "hooks/list", "account/rateLimits/read"]) assert.ok(client.has(m), `client method ${m}`);
  for (const m of ["item/tool/requestUserInput", "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "mcpServer/elicitation/request"]) assert.ok(server.has(m), `server request ${m}`);
  for (const m of ["turn/started", "turn/completed", "item/started", "item/completed", "thread/tokenUsage/updated", "account/rateLimits/updated", "serverRequest/resolved"]) assert.ok(notes.has(m), `notification ${m}`);

  const props = (f) => new Set(Object.keys(read(`v2/${f}.json`).properties ?? {}));
  for (const p of ["cwd", "approvalPolicy", "approvalsReviewer", "sandbox", "model", "config"]) assert.ok(props("ThreadStartParams").has(p), `thread/start takes ${p}`);
  for (const p of ["threadId", "approvalPolicy", "sandbox", "config"]) assert.ok(props("ThreadResumeParams").has(p), `thread/resume takes ${p}`);
  for (const p of ["threadId", "input", "clientUserMessageId", "effort"]) assert.ok(props("TurnStartParams").has(p), `turn/start takes ${p}`);
  for (const p of ["threadId", "expectedTurnId", "input", "clientUserMessageId"]) assert.ok(props("TurnSteerParams").has(p), `turn/steer takes ${p}`);
  assert.ok(props("ThreadTokenUsageUpdatedNotification").has("tokenUsage"));
  const usage = read("v2/ThreadTokenUsageUpdatedNotification.json").definitions.ThreadTokenUsage.properties;
  for (const p of ["last", "total", "modelContextWindow"]) assert.ok(p in usage, `token usage has ${p}`);
  const errors = JSON.stringify(read("v2/TurnCompletedNotification.json").definitions.CodexErrorInfo);
  assert.match(errors, /usageLimitExceeded/, "a failed turn still names the usage limit");
  assert.deepEqual(read("v2/TurnCompletedNotification.json").definitions.TurnStatus.enum.sort(), ["completed", "failed", "inProgress", "interrupted"]);
  const ask = read("ToolRequestUserInputParams.json");
  for (const p of ["questions", "threadId", "turnId"]) assert.ok(p in ask.properties, `request_user_input carries ${p}`);
  for (const p of ["id", "header", "question", "options"]) assert.ok(p in ask.definitions.ToolRequestUserInputQuestion.properties, `a question carries ${p}`);
  assert.ok("answers" in read("ToolRequestUserInputResponse.json").properties);
  // Away mode answers approvals itself (codex/worker.mjs approvalAnswer): a decline the turn goes on after, and the
  // permissions request's grant with its scope.
  for (const [f, def] of [["CommandExecutionRequestApprovalResponse", "CommandExecutionApprovalDecision"], ["FileChangeRequestApprovalResponse", "FileChangeApprovalDecision"]]) {
    const decisions = JSON.stringify(read(`${f}.json`).definitions[def]);
    for (const d of ["accept", "decline"]) assert.match(decisions, new RegExp(`"${d}"`), `${f} takes ${d}`);
  }
  for (const p of ["permissions", "scope"]) assert.ok(p in read("PermissionsRequestApprovalResponse.json").properties, `a permissions answer carries ${p}`);
  // The chat view (codex/items.mjs, codex/worker.mjs): streamed text, the plan, the thread items it maps and their
  // fields, a resumed thread's saved history, the session-wide approvals, images in a message, a turn's model.
  for (const m of ["item/agentMessage/delta", "item/reasoning/summaryTextDelta", "turn/plan/updated"]) assert.ok(notes.has(m), `notification ${m}`);
  const v2 = read("codex_app_server_protocol.v2.schemas.json").definitions;
  const items = Object.fromEntries(v2.ThreadItem.oneOf.map((o) => [o.properties.type.enum[0], new Set(Object.keys(o.properties))]));
  const want = {
    userMessage: ["id", "clientId", "content"], agentMessage: ["id", "text"], reasoning: ["id", "summary", "content"], plan: ["id", "text"],
    commandExecution: ["id", "command", "cwd", "status", "exitCode", "aggregatedOutput"], fileChange: ["id", "changes", "status"],
    mcpToolCall: ["id", "server", "tool", "arguments", "status", "result", "error"], collabAgentToolCall: ["id", "tool", "prompt", "status"],
    webSearch: ["id", "query"], contextCompaction: ["id"], hookPrompt: ["id", "fragments"],
  };
  for (const [type, fields] of Object.entries(want)) for (const f of fields) assert.ok(items[type]?.has(f), `a ${type} item carries ${f}`);
  for (const f of ["path", "kind", "diff"]) assert.ok(f in v2.FileUpdateChange.properties, `a file change carries ${f}`);
  assert.deepEqual(v2.CommandExecutionStatus.enum.sort(), ["completed", "declined", "failed", "inProgress"]);
  for (const f of ["id", "status", "items", "error", "durationMs", "startedAt", "completedAt"]) assert.ok(f in v2.Turn.properties, `a turn carries ${f}`);
  for (const f of ["step", "status"]) assert.ok(f in v2.TurnPlanStep.properties, `a plan step carries ${f}`);
  assert.ok("thread" in v2.ThreadResumeResponse.properties && "turns" in v2.Thread.properties, "a resumed thread comes with its turns");
  assert.ok(props("ThreadReadParams").has("includeTurns"));
  assert.ok(props("TurnStartParams").has("model"), "turn/start takes a model");
  assert.match(JSON.stringify(v2.UserInput), /"localImage"/, "a message takes a local image");
  for (const [f, def] of [["CommandExecutionRequestApprovalResponse", "CommandExecutionApprovalDecision"], ["FileChangeRequestApprovalResponse", "FileChangeApprovalDecision"]]) {
    assert.match(JSON.stringify(read(`${f}.json`).definitions[def]), /"acceptForSession"/, `${f} takes acceptForSession`);
  }
  assert.ok(read("PermissionsRequestApprovalResponse.json").definitions.PermissionGrantScope.enum.includes("session"));

  const caps = read("v1/InitializeParams.json").definitions.InitializeCapabilities.properties;
  assert.ok("experimentalApi" in caps, "initialize still takes experimentalApi");
  assert.match(JSON.stringify(read("v2/HooksListResponse.json").definitions.HookTrustStatus), /untrusted/);

  // The flag that lets the question tool run outside plan mode, and the UI's way onto a running server.
  const features = spawnSync(codex, ["features", "list"], { encoding: "utf8", timeout: 30_000 }).stdout;
  assert.match(features, /^default_mode_request_user_input\s/m, "the question tool's feature flag");
  const help = spawnSync(codex, ["--help"], { encoding: "utf8", timeout: 30_000 }).stdout;
  assert.match(help, /--remote <ADDR>/, "the UI attaches to a running app server");
  const serverHelp = spawnSync(codex, ["app-server", "--help"], { encoding: "utf8", timeout: 30_000 }).stdout;
  assert.match(serverHelp, /unix:\/\/PATH/, "the app server listens on a unix socket");
});
