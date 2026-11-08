// The agent host's test sandbox (host.test.mjs, host-supervisor.test.mjs): a store with home alpha and task t1, fake
// Claude and Codex launch files, and a host to start, stopped (with every fake it ran) when the test ends.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, socketFor } from "../src/host/client.mjs";
import { BIN, FIXTURES, sandbox, until } from "./helpers.mjs";

export const FAKE = join(FIXTURES, "fake-claude.mjs");
chmodSync(FAKE, 0o755);
export const FAKE_CODEX = join(FIXTURES, "fake-codex.mjs");
chmodSync(FAKE_CODEX, 0o755);

export const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
export const lines = (f) => { try { return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

/** A sandbox with home alpha and task t1 (worktree: the repo), a fake Claude launch file, and a host to start. */
export function setup(t, { env = {} } = {}) {
  const sb = sandbox(t);
  const h = "alpha";
  const dir = join(sb.home, "_supervisors", h, "workers", "t1");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(sb.home, "_supervisors", h, "tasks"), { recursive: true });
  const taskFile = join(sb.home, "_supervisors", h, "tasks", "t1.json");
  const task = (patch = {}) => writeFileSync(taskFile, JSON.stringify({ id: "t1", home: h, title: "Host test", state: "working", worktree: sb.main, repo: { main: sb.main, name: "repo", key: "repo" }, sessions: [], ...patch }));
  task();
  const settings = join(sb.root, "settings.json");
  writeFileSync(settings, "{}");
  const claudeDir = join(sb.root, "claude-config");
  const log = join(sb.root, "fake.jsonl");
  const launch = (patch = {}) => {
    const cfg = { home: h, task: "t1", session: randomUUID(), resume: false, settings, cwd: sb.main, bin: FAKE, prompt: null, mode: null, model: null, effort: null, addDir: [], name: null, view: "chat", ...patch };
    writeFileSync(join(dir, "claude-launch.json"), JSON.stringify(cfg));
    return cfg;
  };
  /** A Codex launch file, as harness/codex.mjs writes it, and the task's session for it. */
  const codexLaunch = (patch = {}) => {
    const cfg = { home: h, task: "t1", session: randomUUID(), thread: null, name: null, cwd: sb.main, prompt: null, model: null, effort: null, mode: "auto", view: "chat", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", writableRoots: [], bin: FAKE_CODEX, questions: true, ...patch };
    writeFileSync(join(dir, "codex-launch.json"), JSON.stringify(cfg));
    task({ sessions: [{ id: cfg.session, at: Date.now(), harness: "codex", thread: cfg.thread, hosted: true }] });
    return cfg;
  };
  const codexLog = join(sb.root, "fake-codex.jsonl");
  const hostEnv = { ...sb.env, FAKE_CLAUDE_LOG: log, FAKE_CODEX_LOG: codexLog, ROLLCALL_SNAPSHOTS: "0", CLAUDE_CONFIG_DIR: claudeDir, ...env };
  const procs = [];
  const sock = socketFor(sb.home);
  const x = {
    sb, h, dir, log, sock, claudeDir, task, launch, codexLaunch,
    codexCompat: () => readJson(join(dir, "codex.json")),
    codexFake: () => lines(codexLog),
    agent: () => readJson(join(dir, "agent.json")),
    compat: () => readJson(join(dir, "claude.json")),
    history: () => lines(join(dir, "history.jsonl")),
    fake: () => lines(log),
    /** What the host wrote to the fakes' stdin. */
    inputs: () => lines(log).filter((l) => l.in).map((l) => l.in),
    /** Starts `rollcall host` and waits until its socket answers. */
    async startHost() {
      const out = openSync(join(sb.root, `host-${procs.length}.log`), "w");
      const p = spawn(process.execPath, [BIN, "host"], { env: hostEnv, stdio: ["ignore", out, out] });
      closeSync(out);
      p.exited = new Promise((r) => p.on("exit", (code) => r(code)));
      procs.push(p);
      await until(async () => { try { const c = await connect({ sock }); c.close(); return true; } catch { return false; } });
      return p;
    },
    async client(onEvent = null) {
      const c = await connect({ sock, onEvent });
      t.after(() => c.close());
      return c;
    },
  };
  t.after(async () => {
    for (const p of procs) if (p.exitCode === null) { p.kill("SIGTERM"); await Promise.race([p.exited, new Promise((r) => setTimeout(r, 3000).unref())]); }
    for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
    for (const l of lines(log)) if (l.argv) { try { process.kill(l.pid, "SIGKILL"); } catch {} }
  });
  return x;
}

