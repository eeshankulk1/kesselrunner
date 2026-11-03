// Test kit: throwaway git repos (a bare origin plus a clone) under $TMPDIR, a
// private ROLLCALL_HOME, and fake agent sessions whose "harness" is a
// long-lived `sleep` process, so liveness and crashes are real process facts.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BIN = fileURLToPath(new URL("../bin/rollcall.mjs", import.meta.url));
export const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** The developer's environment minus anything that would leak into a test: rollcall knobs, harness vars, git overrides. */
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ROLLCALL_|CLAUDE|CODEX_|GIT_)/.test(k)) continue;
    env[k] = v;
  }
  return {
    // No caffeinate, power or disk checks from a test's watcher (a test turns them on with fakes).
    ...env, ROLLCALL_AWAKE: "0", ROLLCALL_MACHINE_FACTS: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    ...extra,
  };
}

export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() }).trim();
}

export function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** origin.git (bare) + repo/ (clone on main with src/a.js, src/b.js, README.md), and a private ROLLCALL_HOME. */
export function sandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rollcall-test-")));
  const origin = join(root, "origin.git");
  const main = join(root, "repo");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, main);
  git(main, "symbolic-ref", "HEAD", "refs/heads/main");
  for (const f of ["src/a.js", "src/b.js", "README.md"]) write(join(main, f), `${f}\n`);
  git(main, "add", ".");
  git(main, "commit", "-qm", "init");
  git(main, "push", "-q", "-u", "origin", "main");
  const home = join(root, "home");
  const procs = [];
  const sb = {
    root, origin, main, home,
    // Most suites exercise sessions sharing the main checkout, so the worktrees-only guard is off
    // unless a test turns it back on; background gc stays off (worktree.test.mjs runs gc directly).
    // ROLLCALL_TMUX_SOCKET: a private tmux server, never the real supervisors' one. No home's watcher starts by
    // itself: it would drain the queue a test reads (a test turns it on, or runs `watch <home>` itself).
    env: cleanEnv({ ROLLCALL_HOME: home, ROLLCALL_FETCH_MINUTES: "999", ROLLCALL_WAIT_POLL_MS: "100", ROLLCALL_MAIN_EDITS: "allow", ROLLCALL_GC: "0", ROLLCALL_WATCHER: "0", ROLLCALL_TMUX_SOCKET: `rollcall-test-${process.pid}` }),
    /** A new worktree of the repo at <main>/.claude/worktrees/<name> on branch <name>. */
    worktree(name) {
      const path = join(main, ".claude", "worktrees", name);
      git(main, "worktree", "add", "-q", path, "-b", name);
      return path;
    },
    /** A second clone, standing in for "someone else merging a PR". */
    otherClone() {
      const path = mkdtempSync(join(root, "other-"));
      git(root, "clone", "-q", origin, path); // into the fresh empty dir
      return path;
    },
    session(cwd = main, opts = {}) {
      const h = opts.harness ?? spawn("sleep", ["600"], { stdio: "ignore" });
      procs.push(h);
      return new Session(sb, cwd, h, opts.id);
    },
    track(p) { procs.push(p); return p; },
  };
  t.after(() => {
    for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
    if (!process.env.ROLLCALL_KEEP_SANDBOX) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); // a detached fetch may still be writing
  });
  return sb;
}

export class Session {
  constructor(sb, cwd, harness, id) {
    this.sb = sb;
    this.cwd = cwd;
    this.harness = harness;
    this.id = id ?? randomUUID();
    this.env = { ...sb.env, ROLLCALL_HARNESS_PID: String(harness.pid) };
  }
  get short() { return this.id.slice(0, 8); }

  payload(event, extra) {
    return {
      session_id: this.id, transcript_path: join(this.sb.root, "transcripts", `${this.id}.jsonl`),
      cwd: this.cwd, permission_mode: "default", hook_event_name: event, ...extra,
    };
  }
  hook(arg, event, extra = {}, env = {}) { return runHook(arg, this.payload(event, extra), { ...this.env, ...env }); }

  start(source = "startup") { return this.hook("session-start", "SessionStart", { source, model: "claude-test" }); }
  prompt(prompt) { return this.hook("prompt-submit", "UserPromptSubmit", { prompt }); }
  pre(file, tool = "Edit", env) { return this.hook("pre-tool-use", "PreToolUse", { tool_name: tool, tool_input: editInput(tool, file), tool_use_id: randomUUID() }, env); }
  post(file, tool = "Edit", env) {
    return this.hook("post-tool-use", "PostToolUse", {
      tool_name: tool, tool_input: editInput(tool, file), tool_response: { filePath: file, success: true }, tool_use_id: randomUUID(),
    }, env);
  }
  /** A successful edit: PreToolUse, the write itself, PostToolUse. Returns both hook results. */
  edit(file, text = `edited by ${this.short}\n`) {
    const pre = this.pre(file);
    if (denied(pre)) return { pre, post: null };
    write(file, text);
    return { pre, post: this.post(file) };
  }
  bash(command = "ls") {
    return this.hook("post-tool-use", "PostToolUse", {
      tool_name: "Bash", tool_input: { command, description: "test" }, tool_response: { stdout: "", stderr: "", interrupted: false }, tool_use_id: randomUUID(),
    });
  }
  /** PreToolUse for a Bash command (the git guard). */
  bashPre(command, extra = {}, env = {}) {
    return this.hook("pre-tool-use", "PreToolUse", { tool_name: "Bash", tool_input: { command, description: "test" }, tool_use_id: randomUUID(), ...extra }, env);
  }
  stop() { return this.hook("stop", "Stop", { stop_hook_active: false }); }
  end(reason = "prompt_input_exit") { return this.hook("session-end", "SessionEnd", { reason }); }
  /** Kills the harness with no SessionEnd, and waits until it is reaped (a zombie still answers kill -0). */
  crash() {
    if (this.harness.exitCode !== null || this.harness.signalCode !== null) return Promise.resolve();
    const gone = new Promise((res) => this.harness.once("exit", res));
    this.harness.kill("SIGKILL");
    return gone;
  }

  cli(args, opts = {}) {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      cwd: opts.cwd ?? this.cwd, encoding: "utf8", input: opts.input, env: { ...this.env, ROLLCALL_SESSION: this.id, ...opts.env },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  /** `rollcall <args>` as a background process (like a background Bash tool call). */
  cliAsync(args, opts = {}) {
    const p = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd ?? this.cwd, env: { ...this.env, ROLLCALL_SESSION: this.id, ...opts.env }, stdio: ["ignore", "pipe", "pipe"],
    });
    this.sb.track(p);
    let stdout = "";
    p.stdout.on("data", (d) => { stdout += d; });
    const exited = new Promise((res) => p.on("exit", (code) => res({ code, stdout })));
    return { proc: p, exited, output: () => stdout };
  }
}

function editInput(tool, file) {
  if (tool === "Write") return { file_path: file, content: "x\n" };
  if (tool === "MultiEdit") return { file_path: file, edits: [{ old_string: "a", new_string: "b" }] };
  if (tool === "NotebookEdit") return { notebook_path: file, new_source: "x", cell_id: "c1", edit_mode: "replace" };
  return { file_path: file, old_string: "a", new_string: "b", replace_all: false };
}

/** Pipes a payload into `rollcall hook <arg>`, like the harness does. */
export function runHook(arg, payload, env, input = JSON.stringify(payload), cwd = undefined) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [BIN, "hook", arg], { input, encoding: "utf8", env, cwd });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json, ms, context: json?.hookSpecificOutput?.additionalContext ?? null };
}

export const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === "deny";
export const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? "";

export async function until(fn, { timeout = 10_000, every = 50 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await sleep(every);
  }
}
