// The Claude Code adapter: `rollcall claude-worker` in the task's tmux window (claude/worker.mjs), which runs Claude
// Code with a session id fixed at launch and a settings file whose hooks report to the task (worker-hook), in one of
// two views: the chat (Claude Code's stream mode, which front ends read and answer) or the terminal (the real CLI).
// In the chat rollcall's words, interrupts and answers go through the worker's socket; in the terminal they go as
// keys, as before: a bracketed paste and Enter (tmux.type), Esc to stop a turn. Its transcript lives under
// ~/.claude/projects either way. ROLLCALL_STREAM=0 starts the plain CLI with no worker process around it.
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { dialogFlag, keyQuietMs, received } from "../delivery.mjs";
import * as live from "../claude/live.mjs";
import { launchLines } from "../checkout.mjs";
import { BIN } from "../session.mjs";
import * as store from "../store.mjs";
import { TASK_ENV, capFlag, noBrowser, statusLine, wantsBrowser } from "../supervisor.mjs";
import * as tmux from "../tmux.mjs";
import { callSync } from "../host/client.mjs";

/** The agent host runs (or would resume) the task's worker: nothing is ever typed into a window for it. */
const hosted = (t) => !!t.sessions?.at(-1)?.hosted;
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
 * Marks task `t`'s worktree as trusted, the way Claude Code records the owner's yes to its trust question
 * (`projects[<folder>].hasTrustDialogAccepted` in its config), for the terminal escape hatch (`rollcall open`). A hosted
 * agent never meets that question (stream mode skips it), so the escape hatch would be the first to ask, where Enter
 * means "No, exit" and the CLI ends. Only a folder rollcall made: a task's worktree under its repo's
 * `.claude/worktrees/`, or the one folder of tasks with no repo; never a folder the owner opened. The config is read
 * again just before an atomic rename, and only that one key changes. true: written; false: not ours, or trusted
 * already; null: the config could not be read or written (the CLI then asks, as before).
 */
export function trustWorktree(t) {
  const dir = t?.worktree;
  const main = t?.repo?.main;
  const ours = !!dir && (main ? dir !== main && dir.startsWith(join(main, ".claude", "worktrees") + "/") : dir === store.machineFolder());
  if (!ours || trusted(t) !== false) return false;
  let file = join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");
  try {
    file = realpathSync(file);
    const config = JSON.parse(readFileSync(file, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) return null;
    config.projects ??= {};
    config.projects[dir] = { ...(config.projects[dir] ?? {}), hasTrustDialogAccepted: true };
    const tmp = `${file}.rollcall-${process.pid}-${randomUUID().slice(0, 8)}`;
    writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: statSync(file).mode & 0o777 });
    renameSync(tmp, file);
    return true;
  } catch { return null; }
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
export function writeLaunch(t, { prompt, resume = false, session: pick = null, mode = null, name = null, model = null, effort = null, hosted = false }) {
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
  if (live.streamOn() || hosted) {
    // The worker process keeps the view it last showed (a front end's choice) across a resume.
    const was = resume ? live.readJson(live.launchFile(t.home, t.id)) : null;
    live.writeJson(live.launchFile(t.home, t.id), {
      home: t.home, task: t.id, session, resume: !!resume, settings, cwd: t.worktree, bin: bin(),
      prompt: prompt ? promptFile : null, mode: MODES.has(mode) ? mode : null, model: modelOk(model) ? model : null,
      effort: effortOk(effort) ? effort : null, addDir: browser ? [files] : [], name: name ?? null,
      // Stream mode (-p) skips Claude Code's trust question: a repo it has not trusted starts in the real CLI, which asks.
      // The agent host has no terminal view (until its escape hatch): a hosted worker always runs in the chat.
      view: hosted ? "chat" : trusted(t) === false ? "terminal" : live.VIEWS.includes(was?.view) ? was.view : live.defaultView(),
    });
    writeFileSync(script, `${[...preamble(t, { browser, files }), `${q(process.execPath)} ${q(BIN)} claude-worker ${q(t.home)} ${q(t.id)}`].join("\n")}\n`);
    return { script, session };
  }
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

/**
 * rollcall's words to the worker as its next prompt. In the chat they go through its stream (taken at once, or
 * queued into the running turn as words typed mid-turn are), and the worker taking them is the receipt. In the
 * terminal they are typed as the owner would: a bracketed paste, then Enter (which `before` may withhold).
 */
export function type(t, text, opts) {
  if (!live.inChat(t.home, t.id)) {
    if (!hosted(t)) return tmux.type(t.home, t.id, text, opts);
    // A hosted worker whose host is down: the call starts the host, which wakes it on its session.
    const { body, attachments } = live.attachmentsIn(String(text));
    const r = callSync("say", { ref: `${t.home}:${t.id}`, text: body, attachments, from: "rollcall" });
    if (!r.ok) return { ok: false, err: r.error?.message ?? "the agent host refused" };
    received(t, String(text));
    return { ok: true, how: r.how };
  }
  // Files the owner attached ride as a last line (live.withAttachments): in the chat the images go in as images.
  const { body, attachments } = live.attachmentsIn(String(text));
  const r = live.send(t.home, t.id, { op: "say", text: body, attachments, from: "rollcall" });
  if (!r.ok) return { ok: false, err: r.err ?? "the worker refused" };
  received(t, String(text));
  return { ok: true, how: r.how };
}

/** Stops the worker's turn: the stream's interrupt in the chat, Esc in the terminal. */
export function interrupt(t) {
  if (!live.inChat(t.home, t.id)) return hosted(t) ? callSync("interrupt", { ref: `${t.home}:${t.id}` }).interrupted === true : tmux.interrupt(t.home, t.id);
  return live.send(t.home, t.id, { op: "interrupt" }).ok === true;
}

/**
 * Typing goes into Claude Code's prompt box: never while a dialog is open (Enter would answer it), nor while the
 * owner just pressed a key in the window (it would land in what they are typing).
 */
export const takesTyping = (t, w, now = Date.now()) => live.inChat(t.home, t.id) || hosted(t) || (!w.dialog && now - tmux.lastUsed(t.home, t.id) >= keyQuietMs());

/** The worker session's transcript, as its hooks reported it. */
export const transcriptOf = (w) => (w?.session ? store.readGlobal(w.session)?.transcript ?? null : null);

