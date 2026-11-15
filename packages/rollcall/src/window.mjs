// A falcon supervisor's own window: the first of its home's tmux session, where its Claude Code runs. falcon
// opens it, parking (park.mjs) replaces it with a line saying the supervisor is parked, and it comes back here
// from Enter in that line, `falcon continue`, or news from its tasks (watch.mjs). Every way back
// asks comeBack: its conversation resumed, or a fresh supervisor once that conversation grew big.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BIN, P, currentSession } from "./session.mjs";
import * as store from "./store.mjs";
import { noBrowser, statusLine } from "./supervisor.mjs";
import * as tmux from "./tmux.mjs";

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * The supervisor's settings, on top of the owner's: it edits nothing and drives no browser, so the browser
 * MCP servers stay off; its status line (the tabs' fallback, when no watcher runs) refreshes every 30 s,
 * since its worker's hooks have the watcher redraw the tabs at once; Claude Code's recap when the owner
 * comes back stays off: each one re-reads the whole conversation, and the tabs and task list say where things
 * stand; and so do prompt suggestions, whose gray text in the prompt box reads like a draft the owner left.
 */
export const SUPERVISOR_SETTINGS = () => ({ enabledPlugins: noBrowser(), statusLine: statusLine(30), awaySummaryEnabled: false, promptSuggestionEnabled: false });

/**
 * A supervisor whose conversation reached this much of its context comes back as a fresh supervisor: each
 * turn re-reads the whole conversation (one began at 7% and grew to 82% over five days), and its task
 * records already hold what a fresh one needs. A fresh one starts near 7%.
 */
export const freshPct = () => { const v = Number(process.env.ROLLCALL_SUPERVISOR_FRESH_PCT); return Number.isFinite(v) && v > 0 ? v : 20; };

/**
 * A running supervisor that reaches this much of its context hands over to a fresh session on its home, picker
 * or not (watch.mjs): one reached 82% and paid for all of it on every wake. Higher than freshPct, since this
 * ends a conversation the owner may be in; coming back from parking starts a session anyway.
 */
export const supervisorMark = () => { const v = Number(process.env.ROLLCALL_SUPERVISOR_MARK_PCT); return Number.isFinite(v) && v > 0 ? v : 35; };

/** What a supervisor brought back by the owner (Enter in its parked tab, `falcon continue`) does first. */
export const backText = (h) =>
  `${P} Supervisor ${h} is back: it was parked while idle, and the owner brought it back. Run \`rollcall task list\` and tell the owner one line per open task, tagged as the /supervisor skill says, or "No open tasks."`;

/**
 * The supervisor's last conversation: { id, cwd, resumable } from its home's lock (following a session
 * sent to the background to its successor), else the one falcon last started. Resumable when Claude Code
 * saved it; cwd is where it ran, which `claude --resume` needs.
 */
export function lastSession(h) {
  const lock = store.readHomeFile(h, "lock");
  const f = store.readHomeFile(h, "falcon");
  const id = lock?.session ? (currentSession(lock.session)?.id ?? lock.session) : f?.session;
  if (!id) return null;
  const transcript = store.readGlobal(id)?.transcript;
  const saved = transcript && existsSync(transcript) ? transcript : null;
  const cwd = (saved && cwdOf(saved)) || (f?.session === id ? f.cwd : null);
  const resumable = !!saved || (!!cwd && existsSync(transcriptPath(cwd, id)));
  return { id, cwd, resumable };
}

/** Where Claude Code keeps a session's transcript: its project folder is the cwd with each other character a "-". */
const transcriptPath = (cwd, id) => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);

/** The cwd a transcript records (each entry carries it), from its first 64 KB. */
function cwdOf(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      try { const cwd = JSON.parse(line)?.cwd; if (typeof cwd === "string" && cwd) return cwd; } catch {}
    }
  } catch {} finally { if (fd !== undefined) closeSync(fd); }
  return null;
}

/** Session `id`'s context use in percent: what the status line recorded on home `h`, else what the band did. */
export function contextOf(h, id) {
  const c = store.readHomeFile(h, "context");
  return c?.session === id ? c.pct : store.readGlobal(id)?.context?.pct ?? null;
}

/**
 * How supervisor `h` comes back: { session, cwd, resume, pct }. Its last conversation resumed, in the folder it
 * ran in, unless Claude Code never saved it, that folder is gone (a worktree cleaned up), or it used freshPct
 * of its context or more: then a fresh supervisor starts (`/supervisor <h>`), there or in `fallback`.
 */
export function comeBack(h, fallback = process.cwd()) {
  const last = lastSession(h);
  const there = !!last?.cwd && existsSync(last.cwd);
  const pct = last ? contextOf(h, last.id) : null;
  const big = Number.isFinite(pct) && pct >= freshPct();
  const resume = !!last?.resumable && there && !big;
  return { session: resume ? last.id : randomUUID(), cwd: there ? last.cwd : fallback, resume, pct };
}

/**
 * Records that supervisor `h` comes back from parking now (back.json): its quiet time counts from here (park.mjs
 * supervisorDue), so no sweep parks it again before its first prompt reaches its transcript. Written before
 * parked.json is cleared, so whoever reads it unparked reads this too.
 */
export const markBack = (h) => store.writeHomeFile(h, "back", { at: Date.now() });

/**
 * Takes supervisor `h` out of parking, under its home's lock, so its watcher (watch.mjs), which brings it
 * back for news under the same lock, never does it too. Returns whether it was parked.
 */
export function unparkHome(h) {
  const r = store.withHomeLock(h, () => {
    const was = !!store.readHomeFile(h, "parked");
    if (was) markBack(h);
    store.writeHomeFile(h, "parked", null);
    return was;
  });
  store.pokeWatcher(h);
  return !!r?.out;
}

/**
 * Writes what the supervisor's window runs to start `back` (a comeBack, or a new supervisor): its settings and
 * the script its pane sources, where Claude Code starts on `/supervisor <h>` with a known session id, or its
 * conversation resumed with `prompt` (none: it waits for the owner). When Claude Code quits, the terminals
 * showing it go back to their own prompt (a failed start first says so); the workers keep running. Returns
 * the script's path.
 */
export function writeWindow(h, back, { prompt = null } = {}) {
  const dir = store.homeDir(h);
  const script = join(dir, "supervisor.sh");
  const settings = join(dir, "settings.json");
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(settings, JSON.stringify(SUPERVISOR_SETTINGS(), null, 2));
  store.writeHomeFile(h, "falcon", { session: back.session, cwd: back.cwd, at: Date.now() });
  let first = "";
  if (back.resume && prompt) {
    writeFileSync(promptFile, prompt.startsWith("-") ? ` ${prompt}` : prompt);
    store.writeHomeFile(h, "sent", { text: prompt, at: Date.now() });
    first = ` "$(cat ${q(promptFile)})"`;
  }
  const claude = q(process.env.KESSELRUNNER_CLAUDE_BIN || process.env.DOTCLAUDE_CLAUDE_BIN || "claude");
  const t = (args) => `tmux -L ${q(tmux.SOCKET())} ${args}`;
  const lines = [
    `# falcon: supervisor ${h}'s tmux window sources this file.`,
    "unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_PROJECT_DIR CLAUDE_ENV_FILE ROLLCALL_SESSION ROLLCALL_TASK",
    ...envExports(),
    `cd ${q(back.cwd)} || exit 1`,
    "started=$(date +%s)",
    back.resume
      ? `${claude} --resume ${q(back.session)} --settings ${q(settings)}${first}`
      : `${claude} --session-id ${q(back.session)} --settings ${q(settings)} -n ${q(h)} ${q(`/supervisor ${h}`)}`,
    "code=$?",
    `if [ "$code" -ne 0 ] && [ $(( $(date +%s) - started )) -lt 15 ]; then printf '\\n[falcon] Claude Code stopped (exit %s). Press Enter to close this tab.\\n' "$code"; read -r _; fi`,
    // Only the terminals on this window: one showing a worker stays where it is.
    `${t(`list-clients -t ${q(`=${tmux.sessionName(h)}`)} -F '#{client_name} #{window_name}'`)} 2>/dev/null | while read -r c w; do [ "$w" = ${q(h)} ] && ${t('detach-client -t "$c"')}; done`,
  ];
  writeFileSync(script, `${lines.join("\n")}\n`);
  return script;
}

/** rollcall's own knobs, for what a window runs: its pane's shell starts from the tmux server's environment. */
const envExports = () => ["ROLLCALL_HOME", "ROLLCALL_TMUX_SOCKET", "ROLLCALL_WATCHER", "KESSELRUNNER_CLAUDE_BIN", "DOTCLAUDE_CLAUDE_BIN"].filter((k) => process.env[k]).map((k) => `export ${k}=${q(process.env[k])}`);

const shellRun = (script) => [process.env.SHELL || "/bin/zsh", "-lic", `. ${q(script)}`];

/** Starts `back` in the supervisor's window, first in its home's session (made when there is none). Returns tmux's { ok, err }. */
export function startWindow(h, back, opts = {}) {
  const script = writeWindow(h, back, opts);
  const r = tmux.runInWindow(h, h, back.cwd, shellRun(script), { first: true });
  if (r.ok) tmux.setTabs(h, new Map([[h, tmux.supervisorTab(h)]]));
  return r;
}

/**
 * Parks the supervisor's window: its Claude Code stops (its conversation is saved), and the pane says so, in
 * any terminal that shows it. Enter there brings it back in place (`rollcall back`, then the script it writes).
 * `idle` is how long its conversation had been quiet; `open` how many tasks are open. Returns tmux's { ok, err }.
 */
export function parkWindow(h, { idle, open }) {
  const parked = join(store.homeDir(h), "parked.sh");
  const m = Math.max(1, Math.round(idle / 60_000));
  const quiet = m < 60 ? `${m} minutes` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
  const tasks = open ? `Its ${open === 1 ? "task carries" : `${open} tasks carry`} on, and it comes back by itself when one has news.` : "It has no open tasks.";
  const lines = [
    `# rollcall: supervisor ${h} is parked. Its tmux window sources this file; Enter brings it back here.`,
    ...envExports(),
    `printf '\\n  %s is parked: its Claude Code stopped after %s quiet, to free memory. %s\\n  Press Enter to bring it back here.\\n\\n' ${q(h)} ${q(quiet)} ${q(tasks)}`,
    "read -r _ || exit 0",
    `${q(process.execPath)} ${q(BIN)} back ${q(h)} || exit 1`,
    `. ${q(join(store.homeDir(h), "supervisor.sh"))}`,
  ];
  writeFileSync(parked, `${lines.join("\n")}\n`);
  const cwd = store.readHomeFile(h, "falcon")?.cwd;
  const r = tmux.runInWindow(h, h, cwd && existsSync(cwd) ? cwd : homedir(), shellRun(parked), { first: true });
  if (r.ok) tmux.setTabs(h, new Map([[h, tmux.supervisorTab(h, { parked: true })]]));
  return r;
}
