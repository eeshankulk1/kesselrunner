// What the stream-mode Claude worker (claude/worker.mjs) assumes about the real Claude Code, checked against the one
// installed, so a CLI update that moves under rollcall fails a test first. The first test is offline: the flags the
// worker starts it with. The second runs one short turn on Haiku in a throwaway folder (a cent or so) and checks the
// message shapes the worker and conversation.mjs read: it runs only with ROLLCALL_CLAUDE_CONTRACT=live. Both skip
// where no claude CLI is installed (CI).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bin } from "../src/harness/claude.mjs";

const claude = process.env.ROLLCALL_CLAUDE_CONTRACT === "0" ? null : bin();
const real = !!claude && !/fake-claude/.test(claude) && spawnSync(claude, ["--version"], { stdio: "ignore", timeout: 15_000 }).status === 0;
const live = real && process.env.ROLLCALL_CLAUDE_CONTRACT === "live";

test("the installed Claude Code still takes the flags the stream worker starts it with", { skip: !real && "no claude CLI installed", timeout: 60_000 }, () => {
  const help = spawnSync(claude, ["--help"], { encoding: "utf8", timeout: 30_000 }).stdout ?? "";
  for (const f of ["--print", "--input-format", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--replay-user-messages", "--permission-prompt-tool", "--session-id", "--resume", "--settings", "--permission-mode", "--model", "--effort", "--add-dir"]) {
    assert.ok(help.includes(f), `claude --help no longer mentions ${f}`);
  }
});

test("one stream-mode turn has the shapes the worker reads: replay, partial blocks, a permission prompt over the pipe, the result", { skip: !live && "set ROLLCALL_CLAUDE_CONTRACT=live to run a real Haiku turn", timeout: 180_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rc-claude-contract-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "settings.json"), "{}");
  const session = randomUUID();
  const uuid = randomUUID();
  const child = spawn(claude, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--replay-user-messages", "--permission-prompt-tool", "stdio", "--session-id", session, "--settings", join(dir, "settings.json"), "--model", "haiku"], { cwd: dir, stdio: ["pipe", "pipe", "ignore"] });
  const seen = [];
  const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  let buf = "";
  const done = new Promise((resolve) => {
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        seen.push(m);
        if (m.type === "control_request" && m.request?.subtype === "can_use_tool") send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { behavior: "deny", message: "contract test: not now" } } });
        if (m.type === "result") { child.stdin.end(); resolve(); }
      }
    });
    child.on("exit", resolve);
  });
  send({ type: "user", uuid, session_id: session, parent_tool_use_id: null, message: { role: "user", content: "Use the Bash tool to run `touch made-by-test.txt`. If it is refused, reply with the single word REFUSED." } });
  await done;

  const init = seen.find((m) => m.type === "system" && m.subtype === "init");
  assert.equal(init?.session_id, session, "init names the session the worker fixed");
  assert.ok(seen.some((m) => m.type === "user" && m.isReplay && m.uuid === uuid), "the message comes back as a replay with its uuid");
  const ask = seen.find((m) => m.type === "control_request" && m.request?.subtype === "can_use_tool");
  assert.ok(ask, "a permission prompt comes over the pipe");
  assert.equal(ask.request.tool_name, "Bash");
  assert.equal(typeof ask.request.input?.command, "string");
  const start = seen.find((m) => m.type === "stream_event" && m.event?.type === "message_start");
  assert.equal(typeof start?.event?.message?.id, "string", "message_start carries the message id");
  const block = seen.find((m) => m.type === "stream_event" && m.event?.type === "content_block_start");
  assert.equal(typeof block?.event?.index, "number", "a block starts with its index");
  const text = seen.find((m) => m.type === "stream_event" && m.event?.type === "content_block_delta" && m.event?.delta?.type === "text_delta");
  assert.ok(text, "text streams as text_delta");
  const assistant = seen.find((m) => m.type === "assistant" && m.message?.content?.some((b) => b.type === "text"));
  assert.equal(typeof assistant?.message?.id, "string");
  const result = seen.find((m) => m.type === "result");
  assert.equal(typeof result?.duration_ms, "number");
  const usage = Object.values(result?.modelUsage ?? {})[0];
  assert.equal(typeof usage?.contextWindow, "number", "the result names the model's context window");
});
