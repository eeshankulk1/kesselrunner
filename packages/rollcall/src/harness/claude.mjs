// The Claude Code adapter: an interactive `claude` in the task's tmux window, started with a session id fixed at
// launch and a settings file whose hooks report to the task (worker-hook). rollcall's words go in as a bracketed
// paste and Enter (tmux.type), Esc stops a turn, and its transcript lives under ~/.claude/projects.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { dialogFlag, keyQuietMs } from "../delivery.mjs";
import { launchLines } from "../checkout.mjs";
import { BIN } from "../session.mjs";
import * as store from "../store.mjs";
import { TASK_ENV, capFlag, noBrowser, statusLine, wantsBrowser } from "../supervisor.mjs";
import * as tmux from "../tmux.mjs";
import { effortOk } from "./index.mjs";

export const name = "claude";
export const title = "Claude Code";
export const questionTool = "AskUserQuestion";
export const trustPrompt = "Claude Code's trust prompt";

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** `claude --permission-mode` values a worker takes from its supervisor; "default" and "plan" start it as a new session would. */
export const MODES = new Set(["acceptEdits", "auto", "bypassPermissions", "dontAsk"]);
export const bin = () => process.env.KESSELRUNNER_CLAUDE_BIN || process.env.DOTCLAUDE_CLAUDE_BIN || "claude";

export function available() {
  const r = spawnSync(bin(), ["--version"], { stdio: "ignore", timeout: 10_000 });
  return r.status === 0 ? { ok: true } : { ok: false, err: `${bin()} is not installed` };
}

/**
 * A worker starts on a model and effort named on its command line (`--model`, `--effort`), never on whatever
 * `/model` last saved to the owner's settings: one picked in a plain session once started a worker on a model
 * whose safeguards stopped it. A model is an alias or an id ("opus", "opus[1m]", "claude-opus-5-5").
 */
export const modelOk = (m) => typeof m === "string" && /^[a-z][\w.-]*(\[1m\])?$/i.test(m);
export const models = { ok: modelOk, map: (m) => (modelOk(m) && !/^(gpt|o\d|codex)/i.test(m) ? m : null) };

/**
 * Whether Claude Code trusts task `t`'s worktree, by its own record, or null where that cannot be read. It asks once
 * per repo, before any hook runs, so this is the one word on why a worker has not started. As Claude Code 2.1.314
 * checks it: the repo's main checkout, or the worktree's own root. A folder above a repo does not count.
 */
export function trusted(t) {
  let config;
  try { config = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json"), "utf8")); } catch { return null; }
  return [t.repo?.main, t.worktree].some((d) => config.projects?.[d]?.hasTrustDialogAccepted === true);
}

/**
 * The worker's settings file: its hooks report to the task's status log, AskUserQuestion goes to the
 * owner's picker in the supervisor, and the 1Password plugin stays off (its MCP server reads 1Password's
 * database, which raised a macOS prompt for every new worker). Its status line draws nothing that changes
 * with time, so it runs on the session's own events only (the longest refresh there is: an hour); the
 * browser servers start only where the worker can use them (wantsBrowser).
 */
export function launchSettings(t) {
  const { home: h, id } = t;
  const hook = (ev) => `node ${q(BIN)} worker-hook ${q(h)} ${q(id)} ${ev}`;
  const cmd = (ev) => [{ hooks: [{ type: "command", command: hook(ev), timeout: 10 }] }];
  // A dialog flag is cleared by the next tool result, and a worker at the cap hears so after each tool call;
  // testing for each flag in the shell keeps node off every tool call.
  const after = [
    { hooks: [{ type: "command", command: `[ -e ${q(dialogFlag(h, id))} ] && ${hook("clear")} || true`, timeout: 10 }] },
    { hooks: [{ type: "command", command: `[ -e ${q(capFlag(h, id))} ] && ${hook("cap")} || true`, timeout: 10 }] },
  ];
  return {
    enabledPlugins: { "1password@1password": false, ...(wantsBrowser(t) ? {} : noBrowser()) },
    statusLine: statusLine(3600),
    hooks: {
      SessionStart: cmd("session-start"),
      UserPromptSubmit: cmd("prompt-submit"),
      Stop: cmd("stop"),
      // A turn that ends on an API error (a usage limit among them) fires this instead of Stop.
      StopFailure: cmd("stop-failure"),
      SessionEnd: cmd("session-end"),
      // PermissionRequest fires as a permission prompt or a picker opens; the notification for one comes 6 s later,
      // and could raise the flag again over a dialog already answered. Only the elicitation has no hook of its own.
      PermissionRequest: cmd("dialog"),
      Notification: [{ matcher: "elicitation_dialog", hooks: [{ type: "command", command: hook("dialog"), timeout: 10 }] }],
      PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: hook("ask"), timeout: 10 }] }],
      PostToolUse: after,
      PostToolUseFailure: after,
    },
  };
}

/** The shell lines every worker's launch script starts with: its environment, then its worktree. */
export function preamble(t, { browser = false, files = null } = {}) {
  return [
    `# rollcall: the worker for task ${t.home}:${t.id}. Its tmux pane sources this file.`,
    "unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_PROJECT_DIR CLAUDE_ENV_FILE ROLLCALL_SESSION",
    `export ${TASK_ENV}=${q(`${t.home}:${t.id}`)}`,
    ...["ROLLCALL_HOME", "ROLLCALL_TMUX_SOCKET", "ROLLCALL_WATCHER"].filter((k) => process.env[k]).map((k) => `export ${k}=${q(process.env[k])}`),
    ...(browser ? [`export PLAYWRIGHT_MCP_OUTPUT_DIR=${q(files)}`] : []),
    // Its worktree's environment (ports and all), and a wait for a setup still running: the first turn finds it ready.
    ...launchLines(t, BIN),
    `cd ${q(t.worktree)} || exit 1`,
  ];
}

/**
 * Writes the worker's launch files (its settings, the first prompt, the script its pane sources) for a new
 * session, or with `resume` its last one again (or the one `session` names). Returns { script, session }.
 */
export function writeLaunch(t, { prompt, resume = false, session: pick = null, mode = null, name = null, model = null, effort = null }) {
  const dir = store.workerDir(t.home, t.id);
  const last = t.sessions?.at(-1);
  const session = resume && last ? pick ?? last.id : randomUUID();
  const settings = join(dir, "settings.json");
  const promptFile = join(dir, "prompt.txt");
  const script = join(dir, "launch.sh");
  writeFileSync(settings, JSON.stringify(launchSettings(t), null, 2));
  if (prompt) writeFileSync(promptFile, prompt.startsWith("-") ? ` ${prompt}` : prompt); // a leading "-" would read as a flag
  else rmSync(promptFile, { force: true });
  const permission = `${MODES.has(mode) ? ` --permission-mode ${mode}` : ""}${modelOk(model) ? ` --model ${q(model)}` : ""}${effortOk(effort) ? ` --effort ${effort}` : ""}`;
  const first = prompt ? ` "$(cat ${q(promptFile)})"` : "";
  // The browser servers refuse a path outside the folders they know, and the owner's screenshots go to the task's
  // own: Chrome DevTools reads Claude Code's folders (--add-dir), Playwright its output folder. --add-dir takes
  // every word up to the next flag, so it never stands last, before the prompt.
  const browser = wantsBrowser(t);
  const files = store.filesDir(t.home, t.id);
  if (browser) mkdirSync(files, { recursive: true });
  const addDir = browser ? ` --add-dir ${q(files)}` : "";
  const lines = [
    ...preamble(t, { browser, files }),
    resume
      ? `${q(bin())} --resume ${q(session)}${addDir} --settings ${q(settings)}${permission}${first}`
      : `${q(bin())} --session-id ${q(session)}${addDir} --settings ${q(settings)}${permission}${name ? ` -n ${q(name)}` : ""}${first}`,
  ];
  writeFileSync(script, `${lines.join("\n")}\n`);
  return { script, session };
}

/** A v2 worker is a background session the daemon may still run: stopped, so one conversation has one process. */
export function stopLegacy(session) {
  spawnSync(bin(), ["stop", session.slice(0, 8)], { stdio: "ignore", timeout: 30_000 });
}

/** rollcall's words, typed as the owner would: a bracketed paste, then Enter (which `before` may withhold). */
export const type = (t, text, opts) => tmux.type(t.home, t.id, text, opts);

/** Esc: Claude Code stops its turn. */
export const interrupt = (t) => tmux.interrupt(t.home, t.id);

/**
 * Typing goes into Claude Code's prompt box: never while a dialog is open (Enter would answer it), nor while the
 * owner just pressed a key in the window (it would land in what they are typing).
 */
export const takesTyping = (t, w, now = Date.now()) => !w.dialog && now - tmux.lastUsed(t.home, t.id) >= keyQuietMs();

/** The worker session's transcript, as its hooks reported it. */
export const transcriptOf = (w) => (w?.session ? store.readGlobal(w.session)?.transcript ?? null : null);

