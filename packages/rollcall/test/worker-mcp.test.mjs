// Done when: a front end registers extra MCP servers for workers (`worker.mcp`), each worker start (fresh and resumed,
// Claude Code and Codex, hosted and in tmux) carries them with the agent's ref, name and harness in their environment,
// and a front end asks the owner on an agent's behalf through the host (`ask`, `ask.withdraw`): the question shows on
// the agent's feed like its own, the agent never sees it, and the asker hears the label picked, or why none came.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BIN, until } from "./helpers.mjs";
import { readJson, setup } from "./host-helpers.mjs";
import { claudeConfig, codexConfig, codexOverrides } from "../src/worker-mcp.mjs";

const ref = "alpha:t1";
const NODE = process.execPath;
/** A host answer without its call framing's `id`. */
const unframed = ({ id, ...r }) => r;

/** `rollcall api do worker.mcp <payload>` in `env`: the printed JSON. */
const mcp = (env, payload) => {
  const r = spawnSync(NODE, [BIN, "api", "do", "worker.mcp", JSON.stringify(payload)], { env, encoding: "utf8" });
  return JSON.parse(r.stdout);
};
/** The --mcp-config document a fake Claude's argv line names. */
const mcpOf = (argv) => { const i = argv.indexOf("--mcp-config"); return i < 0 ? null : JSON.parse(readFileSync(argv[i + 1], "utf8")); };

test("worker.mcp: validates, registers, replaces, lists and removes", (t) => {
  const x = setup(t);
  const env = x.hostEnv;
  assert.equal(mcp(env, { name: "Bad Name", command: NODE }).error.code, "bad-payload");
  assert.equal(mcp(env, { name: "web", command: "node" }).error.code, "bad-payload", "a relative command");
  assert.equal(mcp(env, { name: "web", command: "/no/such/file" }).error.code, "bad-payload");
  assert.equal(mcp(env, { name: "web", command: join(x.sb.root, "settings.json") }).error.code, "bad-payload", "not executable");
  assert.equal(mcp(env, { name: "web", command: NODE, args: [1] }).error.code, "bad-payload");
  assert.equal(mcp(env, { name: "web", command: NODE, env: { "A-B": "x" } }).error.code, "bad-payload");
  const r = mcp(env, { name: "web", command: NODE, args: ["helper.js"], env: { SOCK: "/tmp/s" } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(statSync(join(x.sb.home, "_machine", "worker-mcp.json")).mode & 0o777, 0o600, "owner-only: an env value may be a secret");
  assert.equal(mcp(env, { name: "web", command: NODE, args: ["\ud800"] }).error.code, "bad-payload", "a lone surrogate has no TOML spelling");
  assert.deepEqual(Object.keys(r.result.servers), ["web"]);
  assert.deepEqual(r.result.servers.web.args, ["helper.js"]);
  const again = mcp(env, { name: "web", command: NODE, args: ["other.js"] });
  assert.deepEqual(again.result.servers.web.args, ["other.js"], "a second register replaces");
  assert.deepEqual(again.result.servers.web.env, {});
  assert.deepEqual(Object.keys(mcp(env, { list: true }).result.servers), ["web"]);
  assert.deepEqual(mcp(env, { name: "web", remove: true }).result, { servers: {}, removed: true });
  assert.equal(mcp(env, { name: "web", remove: true }).result.removed, false);
  assert.equal(readJson(join(x.sb.home, "_machine", "worker-mcp.json")), null, "an empty list leaves no file");
});

test("worker.mcp: the shapes Claude Code and Codex take", () => {
  const s = [{ name: "web", command: "/bin/x", args: ["a"], env: { ROLLCALL_AGENT: "alpha:t1", Q: "say \"hi\"" } }];
  assert.deepEqual(claudeConfig(s), { mcpServers: { web: { type: "stdio", command: "/bin/x", args: ["a"], env: s[0].env } } });
  assert.deepEqual(codexConfig(s), { "mcp_servers.web": { command: "/bin/x", args: ["a"], env: s[0].env, tool_timeout_sec: 120 } });
  assert.deepEqual(codexOverrides(codexConfig(s)), ["-c", `mcp_servers.web={ command = "/bin/x", args = ["a"], env = { ROLLCALL_AGENT = "alpha:t1", Q = "say \\"hi\\"" }, tool_timeout_sec = 120 }`]);
});

test("host: a Claude agent gets the servers at each start, fresh and resumed, with its ref, name and harness", async (t) => {
  const x = setup(t, { env: { ROLLCALL_HOST_PARK_MS: "60000" } });
  assert.equal(mcp(x.hostEnv, { name: "web", command: NODE, args: ["one.js"], env: { SOCK: "/tmp/s", ROLLCALL_AGENT: "spoofed" } }).ok, true);
  x.launch();
  await x.startHost();
  const c = await x.client();
  assert.equal((await c.call("start", { ref })).ok, true);
  await until(() => x.fake().some((l) => l.argv?.includes("-p")));
  const first = x.fake().find((l) => l.argv?.includes("-p")).argv;
  assert.equal(first[first.indexOf("--mcp-config") + 2], "--session-id", "the session's flag follows --mcp-config");
  const cfg = mcpOf(first);
  assert.deepEqual(cfg.mcpServers.web, { type: "stdio", command: NODE, args: ["one.js"], env: { SOCK: "/tmp/s", ROLLCALL_AGENT: ref, ROLLCALL_AGENT_NAME: "yoda", ROLLCALL_HARNESS: "claude" } });
  assert.ok(!first.includes("--strict-mcp-config"));
  assert.equal((readJson(join(x.dir, "claude-launch.json")).mcpConfig), undefined, "the launch file keeps no servers");
  // A server changed while it runs reaches the resumed session.
  mcp(x.hostEnv, { name: "web", command: NODE, args: ["two.js"] });
  assert.equal((await c.call("park", { ref })).parked, true);
  await until(() => x.agent()?.state === "parked");
  await c.call("say", { ref, text: "back" });
  await until(() => x.fake().filter((l) => l.argv?.includes("-p")).length === 2);
  const second = x.fake().filter((l) => l.argv?.includes("-p"))[1].argv;
  assert.ok(second.includes("--resume"));
  assert.deepEqual(mcpOf(second).mcpServers.web.args, ["two.js"]);
  // No server: no flag.
  mcp(x.hostEnv, { name: "web", remove: true });
  assert.equal((await c.call("open", { ref })).ok, true);
  await until(() => x.agent()?.state === "idle");
  const term = await c.call("terminal", { ref, pid: process.pid });
  assert.equal(term.ok, true, JSON.stringify(term));
  assert.ok(!term.argv.includes("--mcp-config"));
  await c.call("terminal-done", { ref });
});

test("host codex: the thread starts with one config key per server and a longer tool timeout", async (t) => {
  const x = setup(t);
  assert.equal(mcp(x.hostEnv, { name: "web", command: NODE, args: ["one.js"] }).ok, true);
  x.codexLaunch();
  await x.startHost();
  const c = await x.client();
  const r = await c.call("start", { ref, harness: "codex" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const start = x.codexFake().find((l) => l.in?.method === "thread/start").in.params;
  assert.deepEqual(start.config["mcp_servers.web"], { command: NODE, args: ["one.js"], env: { ROLLCALL_AGENT: ref, ROLLCALL_AGENT_NAME: "yoda", ROLLCALL_HARNESS: "codex" }, tool_timeout_sec: 120 });
  assert.equal(start.config.mcp_servers, undefined, "the owner's own servers stay");
  assert.equal(readJson(join(x.dir, "codex-launch.json"))["mcp_servers.web"], undefined);
  // The resumed thread gets them too.
  assert.equal((await c.call("park", { ref })).parked, true);
  await until(() => x.agent()?.state === "parked");
  await c.call("say", { ref, text: "back" });
  await until(() => x.codexFake().some((l) => l.in?.method === "thread/resume"));
  assert.ok(x.codexFake().find((l) => l.in?.method === "thread/resume").in.params.config["mcp_servers.web"]);
});

const prompt = { header: "Browser", text: "Allow Claude to use github.com?", options: [{ label: "Allow once" }, { label: "Always allow", description: "github.com from now on" }, { label: "Deny" }] };

test("host ask: a front end's question opens on the agent's feed, the first answer goes back to the asker, never to the agent", async (t) => {
  const x = setup(t);
  x.launch();
  await x.startHost();
  const events = [];
  const sub = await x.client((e) => events.push(e));
  await sub.call("subscribe", { refs: [ref] });
  const c = await x.client();
  await c.call("start", { ref });
  assert.equal((await c.call("ask", { ref, prompt: { text: "" }, timeoutMs: 5000 })).error.code, "bad-payload");
  assert.equal((await c.call("ask", { ref: "alpha:t9", prompt, timeoutMs: 5000 })).error.code, "not-found");
  const asking = c.call("ask", { ref, prompt, timeoutMs: 60_000 }, 60_000);
  await until(() => events.some((e) => e.ev === "request"));
  const req = events.find((e) => e.ev === "request").request;
  assert.match(req.id, /^rq-/);
  assert.equal(req.kind, "question");
  assert.equal(req.from, "front end");
  assert.equal(req.ref, ref);
  assert.deepEqual(req.questions[0].options.map((o) => o.label), ["Allow once", "Always allow", "Deny"]);
  assert.equal(req.questions[0].header, "Browser");
  // It is on the feed and in the history like the agent's own, but the agent waits on nothing.
  assert.ok((await c.call("state", { ref })).agent.requests.some((r) => r.id === req.id));
  assert.ok((await c.call("history", { ref })).requests.some((r) => r.id === req.id));
  await until(() => x.agent()?.requests === 0);
  assert.equal(x.agent().state, "idle");
  const other = await x.client();
  const [a1, a2] = await Promise.all([
    c.call("answer", { ref, request: req.id, answers: { [req.questions[0].question]: "Always allow" }, by: "mac" }),
    other.call("answer", { request: req.id, answers: { [req.questions[0].question]: "Deny" }, by: "phone" }),
  ]);
  assert.equal([a1, a2].filter((r) => r.ok).length, 1, JSON.stringify([a1, a2]));
  const won = a1.ok ? "Always allow" : "Deny";
  assert.deepEqual(unframed(await asking), { ok: true, request: req.id, answer: won });
  const closed = events.find((e) => e.ev === "closed" && e.id === req.id);
  assert.deepEqual(closed.reply, { answer: won });
  assert.ok(!x.inputs().some((m) => JSON.stringify(m).includes(won)), "nothing went to the agent");
  assert.equal(x.agent().state, "idle");
});

test("host ask: a timeout, a withdraw, a no-wait ask and a dropped asker each close the question", async (t) => {
  const x = setup(t);
  x.launch();
  await x.startHost();
  const events = [];
  const sub = await x.client((e) => events.push(e));
  await sub.call("subscribe", { refs: [ref] });
  const c = await x.client();
  const late = await c.call("ask", { ref, prompt, timeoutMs: 1000 });
  assert.equal(late.ok, true);
  assert.equal(late.answer, null);
  assert.equal(late.reason, "timeout");
  assert.equal(x.history().find((e) => e.ev === "closed" && e.id === late.request).how, "cancelled");
  // wait: false answers at once; the closed event carries the reply.
  const quick = await c.call("ask", { ref, prompt, timeoutMs: 60_000, wait: false });
  assert.match(quick.request, /^rq-/);
  assert.equal(quick.answer, undefined);
  const w = await c.call("ask.withdraw", { request: quick.request });
  assert.equal(w.withdrawn, true);
  assert.equal(w.request, quick.request);
  assert.deepEqual(events.find((e) => e.ev === "closed" && e.id === quick.request).reply, { answer: null, reason: "withdrawn" });
  assert.equal((await c.call("ask.withdraw", { request: quick.request })).error.code, "not-found");
  // A waiting ask withdrawn from another connection, and one dismissed with no pick.
  const asking = c.call("ask", { ref, prompt, timeoutMs: 60_000 }, 60_000);
  await until(() => events.filter((e) => e.ev === "request").length === 3);
  const third = events.filter((e) => e.ev === "request")[2].request.id;
  assert.equal((await sub.call("answer", { request: third, allow: false })).ok, true);
  assert.deepEqual(unframed(await asking), { ok: true, request: third, answer: null, reason: "declined" });
  // The asker's connection goes: its question goes too.
  const gone = await x.client();
  void gone.call("ask", { ref, prompt, timeoutMs: 60_000 }, 60_000).catch(() => {});
  await until(() => events.filter((e) => e.ev === "request").length === 4);
  const fourth = events.filter((e) => e.ev === "request")[3].request.id;
  gone.close();
  await until(() => events.some((e) => e.ev === "closed" && e.id === fourth));
  assert.equal(events.find((e) => e.ev === "closed" && e.id === fourth).reply.reason, "withdrawn");
  assert.equal((await c.call("state", { ref })).agent.requests.length, 0);
});

test("host ask: a question open when the host restarts closes, as no asker is left to hear it", async (t) => {
  const x = setup(t);
  x.launch();
  const first = await x.startHost();
  const c = await x.client();
  await c.call("start", { ref });
  const quick = await c.call("ask", { ref, prompt, timeoutMs: 60_000, wait: false });
  first.kill("SIGKILL");
  await first.exited;
  await x.startHost();
  const c2 = await x.client();
  const page = await c2.call("history", { ref });
  assert.ok(!page.requests.some((r) => r.id === quick.request));
  assert.equal(x.history().find((e) => e.ev === "closed" && e.id === quick.request)?.by, "host restart");
});
