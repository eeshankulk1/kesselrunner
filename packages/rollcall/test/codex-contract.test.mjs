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
