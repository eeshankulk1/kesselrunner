// Workers live in tmux: one tmux session per supervisor home (`sv-<home>`) on rollcall's own tmux server
// (socket "rollcall", so the owner's own tmux is never touched), one window per task named for it, and the
// supervisor itself in a window named for its home when `falcon` opened it (the status bar is the tabs). A
// window runs an interactive login shell that sources the worker's launch script, then stays a shell
// when Claude exits, so a pane back at a bare shell is a dead worker, and resuming replaces the pane.
// Windows are found by exact name and addressed by id: tmux resolves a missing name to some other window.
import { spawnSync } from "node:child_process";

export const SOCKET = () => process.env.ROLLCALL_TMUX_SOCKET || "rollcall";
const SHELLS = /^-?(zsh|bash|sh|fish|dash|ksh|tcsh|csh|login)$/;
// Variables a worker must not inherit from the session that happened to start the tmux server: Claude
// Code refuses to start inside another Claude Code session, and rollcall's own knobs belong to that session.
const INHERITED = /^(CLAUDE|ROLLCALL_|TMUX|ANTHROPIC_CUSTOM|CODEX_)/;

export const sessionName = (h) => `sv-${h}`;

export function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!INHERITED.test(k) || k === "ROLLCALL_TMUX_SOCKET" || k === "ROLLCALL_HOME" || k === "ROLLCALL_WATCHER") env[k] = v;
  return env;
}

/** Runs tmux on rollcall's server: { ok, out, err }. */
export function tmux(args, { input, timeout = 5000 } = {}) {
  const r = spawnSync("tmux", ["-L", SOCKET(), ...args], { encoding: "utf8", input, timeout, env: cleanEnv(), stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout ?? "").trimEnd(), err: (r.stderr ?? "").trim() || (r.error ? String(r.error.message) : "") };
}

export const available = () => spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

/** Whether this process runs inside rollcall's tmux server ($TMUX names its socket first). */
export const inside = (env = process.env) => !!env.TMUX && env.TMUX.split(",")[0].split("/").pop() === SOCKET();

// One listing of a home's windows answers every question about them in a call: the status line and the
// watcher ask about each task, and each question was a tmux process of its own. A listing is kept
// LISTING_MS, so the long-lived watcher sees a change on its next look; whatever changes the windows here
// drops it.
const LISTING_MS = 1000;
const FIELDS = ["window_id", "window_name", "pane_id", "pane_current_command", "pane_dead", "@tab", "@tab_style", "@tab_back", "@falcon_dress"];
const listings = new Map();

/** The home's windows: [{ id, name, pane, cmd, dead, tab, style, back, dress }], or null without its tmux session. */
function listing(h, opts) {
  const kept = listings.get(h);
  if (kept && Date.now() - kept.at < LISTING_MS) return kept.rows;
  const r = tmux(["list-windows", "-t", `=${sessionName(h)}`, "-F", FIELDS.map((f) => `#{${f}}`).join("\t")], opts);
  const rows = r.ok
    ? r.out.split("\n").filter(Boolean).map((line) => {
      const [id, name, pane, cmd, dead, tab, style, back, dress] = line.split("\t");
      return { id, name, pane, cmd, dead, tab, style, back, dress };
    })
    : null;
  listings.set(h, { at: Date.now(), rows });
  return rows;
}

/** Forgets the kept listings (of home `h`, or all): the next question asks tmux again. */
export function forget(h) {
  if (h === undefined) listings.clear(); else listings.delete(h);
  clientList = null;
}

/** The task's window: { id, pane, cmd, alive } (alive: the pane's foreground process is not a shell), or null. */
export function windowOf(h, task) {
  const w = listing(h)?.find((x) => x.name === task);
  return w ? { id: w.id, pane: w.pane, cmd: w.cmd, alive: w.dead !== "1" && !!w.cmd && !SHELLS.test(w.cmd) } : null;
}

/** Every window in a home's tmux session, by name. */
export const windows = (h) => new Map((listing(h) ?? []).map((w) => [w.name, w.id]));

/**
 * Runs `argv` in the window named `name` (a task's, or with `first` the supervisor's own, which goes in
 * front): a new window (and the home's tmux session, the first time), or the existing one's pane replaced
 * (`respawn-pane -k` ends whatever ran there). Returns { ok, err }.
 */
export function runInWindow(h, name, cwd, argv, { first = false } = {}) {
  const s = sessionName(h);
  const w = windowOf(h, name);
  forget(h);
  if (w) return tmux(["respawn-pane", "-k", "-t", w.pane, "-c", cwd, "--", ...argv]);
  if (tmux(["has-session", "-t", `=${s}`]).ok) return tmux(["new-window", "-d", ...(first ? ["-b", "-t", `=${s}:^`] : ["-t", `=${s}:`]), "-n", name, "-c", cwd, "--", ...argv]);
  const made = tmux(["new-session", "-d", "-s", s, "-n", name, "-x", "220", "-y", "50", "-c", cwd, "--", ...argv]);
  if (made.ok) dress();
  return made;
}

// ---------------------------------------------------------------- the tab bar

// Bumped when the options below change, so a server started by an older rollcall is dressed again.
const DRESS = "2";

/**
 * rollcall's tmux server draws its status bar as tabs: one per window, the supervisor's first, each
 * clicked to show it (tmux's own mouse binding). A window's tab reads its @tab options, which the
 * supervisor's status line keeps current (setTabs); @tab_back marks the way back, on tabs not shown now.
 * Claude Code asks for focus events inside tmux; a window keeps its name whatever runs in it, and links
 * (the clickable mod's) reach the terminal.
 */
export function dress(opts = {}) {
  const options = [
    ["focus-events", "on"], ["allow-rename", "off"], ["automatic-rename", "off"], ["history-limit", "20000"],
    ["mouse", "on"], ["status", "on"], ["status-position", "bottom"], ["status-interval", "5"], ["status-justify", "left"],
    ["status-style", "bg=default,fg=default"], ["status-left", ""], ["status-right", ""], ["window-status-separator", " "],
    ["window-status-format", "#[#{@tab_style}] #{@tab_back}#{?@tab,#{@tab},#W} #[default]"],
    ["window-status-current-format", "#[#{@tab_style}]#[bold,underscore] #{?@tab,#{@tab},#W} #[default]"],
    ["@falcon_dress", DRESS],
  ];
  const cmds = options.flatMap(([k, v]) => [";", "set-option", "-g", k, v]);
  // Fixed slots, so dressing again replaces them instead of adding more: links, and truecolor for the
  // tasks' colors (a tab is drawn in its task's dot color).
  cmds.push(";", "set-option", "-s", "terminal-features[90]", "*:hyperlinks", ";", "set-option", "-s", "terminal-features[91]", "*:RGB");
  return tmux(cmds.slice(1), opts).ok;
}

/**
 * Sets each window's tab from `tabs` (window name -> { tab, style, back }), changing only what differs, and
 * dresses the server first when an older rollcall started it. One tmux call to read, one to write. Returns
 * the names of the home's windows (so the caller knows which tasks have a tab), or null without a session.
 */
export function setTabs(h, tabs) {
  // The status line calls this under a 3 s hook budget: each tmux call gets one second.
  const quick = { timeout: 1000 };
  const rows = listing(h, quick);
  if (!rows) return null;
  const cmds = [];
  const names = new Set();
  let dressed = true;
  for (const { id, name, tab, style, back, dress: version } of rows) {
    names.add(name);
    if (version !== DRESS) dressed = false;
    const want = tabs.get(name);
    if (!want) continue;
    const now = { "@tab": tab, "@tab_style": style, "@tab_back": back };
    for (const [opt, val] of [["@tab", want.tab], ["@tab_style", want.style ?? ""], ["@tab_back", want.back ?? ""]]) {
      // An argument ending in ";" ends the command in tmux; a backslash before it keeps a title's own ";" - but only while another
      // command follows it (the last argument is read differently), hence the no-op appended below.
      if (now[opt] !== val) cmds.push(";", "set-option", "-w", "-t", id, opt, val.endsWith(";") ? `${val.slice(0, -1)}\\;` : val);
    }
  }
  if (!dressed) dress(quick);
  if (cmds.length) { tmux([...cmds.slice(1), ";", "show-options", "-gqv", "@falcon_dress"], quick); forget(h); }
  return names;
}

/** The supervisor's own tab: its name (and "parked" while it is), and a way back from the others. */
export const supervisorTab = (h, { parked = false } = {}) => ({ tab: parked ? `${h} · parked` : h, style: "bold", back: "◀ " });

// The terminals on rollcall's server, kept like a listing: the watcher asks whether one shows each task.
let clientList = null;
function allClients() {
  if (clientList && Date.now() - clientList.at < LISTING_MS) return clientList.rows;
  const r = tmux(["list-clients", "-F", "#{client_name}\t#{session_name}\t#{window_id}\t#{client_activity}\t#{client_flags}"]);
  const rows = r.ok ? r.out.split("\n").filter(Boolean).map((l) => {
    const [name, session, window, activity, flags = ""] = l.split("\t");
    return { name, session, window, activity: Number(activity) * 1000 || 0, focused: flags.split(",").includes("focused") };
  }) : [];
  clientList = { at: Date.now(), rows };
  return rows;
}

/** The terminals showing this home's tmux session now. */
export const clients = (h) => allClients().filter((c) => c.session === sessionName(h)).map((c) => c.name);

/** When the owner last used a terminal that shows window `name` now (a key, a click, a scroll), in ms; 0 with none. */
export function lastUsed(h, name) {
  const w = windowOf(h, name);
  return w ? Math.max(0, ...allClients().filter((c) => c.window === w.id).map((c) => c.activity)) : 0;
}

/** Shows window `name` in every terminal on this home's session: a click on its tab, done for the owner. */
export function select(h, name) {
  const w = windowOf(h, name);
  return w ? tmux(["select-window", "-t", w.id]).ok : false;
}

/** Ends the task's window, worker and all. */
export function killWindow(h, task) {
  const w = windowOf(h, task);
  forget(h);
  return w ? tmux(["kill-window", "-t", w.id]).ok : true;
}

// Claude Code's prompt box, in a capture with its colors: a rule, then the mark and whatever the box holds. Past
// prompts carry the same mark and a picker's chosen option an indented one, so only the rule above says it is the
// box; a picker hides the box altogether. Gray or dim text there is its own hint, not the owner's.
const BOX = /^(?:\x1b\[[0-9;]*m)*[❯>]\s?(.*)$/u;
const COLORS = /\x1b\[[0-9;]*m/g;
const RULE = /^─{3,}/;
const HINT = /^(?:\x1b\[[0-9;]*m)*\x1b\[(?:2|90|38;5;24\d)m/;
const BOX_LINES = 14;

/**
 * Whether a colored capture of a Claude Code pane shows words in its prompt box. The one thing rollcall still reads
 * off a screen: no hook reports a draft, and typing over one sends the owner's half-written words. It only holds
 * typing back, so a wrong read costs a late line.
 */
export function draftIn(text) {
  const lines = String(text).split("\n").filter((l) => l.replace(COLORS, "").trim()).slice(-BOX_LINES);
  for (let i = lines.length - 1; i > 0; i--) {
    const m = BOX.exec(lines[i]);
    if (m && RULE.test(lines[i - 1].replace(COLORS, ""))) return !!m[1].replace(COLORS, "").trim() && !HINT.test(m[1]);
  }
  return false;
}

/** Whether the owner left words in window `name`'s prompt box: typing there would send them with whatever is typed. */
export function draft(h, name) {
  const w = windowOf(h, name);
  return w ? draftIn(tmux(["capture-pane", "-e", "-p", "-t", w.pane]).out) : false;
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Types `text` into the task's pane as the owner would, then Enter: a bracketed paste, so line breaks stay
 * inside one prompt. `before` is asked just before Enter, which it can withhold. Returns { ok, err }: that the keys
 * left, not that they arrived (delivery.mjs takes the receipt).
 */
export function type(h, task, text, { before = null } = {}) {
  const w = windowOf(h, task);
  if (!w) return { ok: false, err: "no window" };
  const buf = `rc-${process.pid}-${Date.now()}`;
  // No control characters: an ESC could close the bracketed paste early and the rest would run as keystrokes.
  const clean = String(text).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  const loaded = tmux(["load-buffer", "-b", buf, "-"], { input: clean });
  if (!loaded.ok) return loaded;
  const pasted = tmux(["paste-buffer", "-p", "-d", "-b", buf, "-t", w.pane]);
  if (!pasted.ok) return pasted;
  pause(250);
  if (before && !before()) return { ok: false, err: "a dialog opened as it was typed" };
  return tmux(["send-keys", "-t", w.pane, "Enter"]);
}

/** Esc: Claude Code stops its turn. */
export function interrupt(h, task) {
  const w = windowOf(h, task);
  return w ? tmux(["send-keys", "-t", w.pane, "Escape"]).ok : false;
}

/** Whether a terminal shows the task's window right now (the owner attached to it). */
export function viewed(h, task) {
  const w = windowOf(h, task);
  return !!w && allClients().some((c) => c.window === w.id);
}

/**
 * Whether the owner is looking at the task's window now: a terminal shows it and has the focus. The Cockpit app
 * keeps a terminal attached to every task it has opened, so one that shows a window is not enough: t19's question
 * stayed in its window, unseen, while the owner was in the supervisor's. tmux counts a terminal focused until the
 * terminal says it lost the focus, so one that never reports focus still counts (rollcall turns focus-events on).
 */
export function watched(h, task) {
  const w = windowOf(h, task);
  return !!w && watching(allClients(), w.id);
}

/** Whether one of `clients` (allClients' rows) shows window `id` with the focus. */
export const watching = (clients, id) => clients.some((c) => c.window === id && c.focused);

/**
 * The command that shows the task's window in a terminal: a grouped tmux session of its own (so two tabs
 * can watch two tasks), gone when that terminal detaches or closes.
 */
export function attachCommand(h, task) {
  const view = `${sessionName(h)}-${task}-view`;
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  return `tmux -L ${q(SOCKET())} new-session -A -t ${q(`=${sessionName(h)}`)} -s ${q(view)} \\; set-option destroy-unattached on \\; select-window -t ${q(`=${view}:=${task}`)}`;
}
