// A chat: cockpit's "new chat" (docs/plans/2026-11-09-new-chat.md in cockpit). A hosted home of kind `chat`
// (`runtime.json` { runtime: "host", kind: "chat" }): an ordinary Claude Code or Codex session the agent host runs, in
// a worktree and branch of its own, that does the work itself and starts tasks (hosted workers, as a hosted crew's)
// when work splits. A Codex model makes a Codex chat. Its session runs with chat-contract.md appended to Claude Code's
// system prompt, or as Codex's developer instructions. The record is
// `chat.json` in the home; its title starts as a draft from the first words, then a one-shot Haiku title, and the
// owner's rename always wins. A chat archives (by hand, or after ROLLCALL_CHAT_ARCHIVE_DAYS unused) and comes back
// when the owner writes to it. Terminal crews (falcon, /supervisor) never meet any of this.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { launchFile, readJson, writeJson } from "../claude/live.mjs";
import { once } from "../codex/rpc.mjs";
import { bin as codexBin, launchFile as codexLaunchFile, models as codexNames, modelFor, policyFor, writableRoots } from "../harness/codex.mjs";
import { defaultBranch, gitSync, locate, mainCheckout, repoKey } from "../git.mjs";
import { BIN } from "../session.mjs";
import { isOpen } from "../state.mjs";
import * as store from "../store.mjs";
import { agentRecord, callSync, runtimeOf } from "./client.mjs";

const CONTRACT = new URL("./chat-contract.md", import.meta.url);
export const CHAT_HOME = /^chat-[a-z0-9]{6}$/;
const DAY = 86400_000;

/** Whether home `h` is a chat (a hosted home of kind chat). */
export const isChat = (h) => !!h && store.readHomeFile(h, "runtime")?.kind === "chat";
export const readChat = (h) => store.readHomeFile(h, "chat");
const writeChat = (h, c) => { store.writeHomeFile(h, "chat", c); store.pokeWatcher(h); };

/** Changes `h`'s chat record under its home's lock: `fn(chat)` edits it in place; returns the record, or null. */
export function updateChat(h, fn) {
  const r = store.withHomeLock(h, () => {
    const c = readChat(h);
    if (!c) return null;
    const out = fn(c);
    if (out === false) return c;
    writeChat(h, c);
    return c;
  });
  return r?.out ?? null;
}

/** Days unused before a chat archives itself: ROLLCALL_CHAT_ARCHIVE_DAYS (fractions allowed), else 7. */
export const archiveDays = () => { const v = Number(process.env.ROLLCALL_CHAT_ARCHIVE_DAYS); return Number.isFinite(v) && v > 0 ? v : 7; };

/**
 * The models and modes a new chat offers (the snapshot's `chatOptions`). Codex's modes are its own presets, under the
 * names the Claude modes they match carry: Ask (it asks before it leaves the worktree's sandbox), Auto (Codex's auto
 * review decides each request, as Claude Code's classifier does in auto), Read only. Codex's Full Access has no Claude
 * mode in the chip and stays out.
 */
export const CLAUDE_MODES = [{ id: "default", label: "Ask" }, { id: "acceptEdits", label: "Accept edits" }, { id: "plan", label: "Plan" }, { id: "auto", label: "Auto" }];
export const CODEX_MODES = [{ id: "default", label: "Ask" }, { id: "auto", label: "Auto" }, { id: "read-only", label: "Read only" }];
const CLAUDE_MODELS = [{ id: "fable", label: "Fable", harness: "claude" }, { id: "opus", label: "Opus", harness: "claude" }, { id: "sonnet", label: "Sonnet", harness: "claude" }, { id: "haiku", label: "Haiku", harness: "claude" }];
/** Codex's models before its own list has been read (codexModels). */
const CODEX_FALLBACK = [{ id: "gpt-5.6-terra", label: "GPT-5.6 Terra", harness: "codex" }];
/** The modes a chat of `harness` takes. */
export const modesOf = (harness) => (harness === "codex" ? CODEX_MODES : CLAUDE_MODES);

/** Codex's models as its app server last listed them (`_machine/codex-models.json`), else the fallback. */
export function codexModels() {
  const c = store.readMachineFile("codex-models");
  return Array.isArray(c?.models) && c.models.length ? c.models : CODEX_FALLBACK;
}

/** Whether `model` names a Codex model: one Codex listed, or a name of Codex's shape. */
export const isCodexModel = (model) => typeof model === "string" && (codexNames.ok(model) || codexModels().some((m) => m.id === model));

/** How long a read of Codex's models lasts before the host reads them again. */
const MODELS_TTL = 6 * 3600_000;

/**
 * Reads Codex's model list from its app server (`model/list`, the picker's own list: hidden models left out, the
 * default first) into `_machine/codex-models.json`, at most once per MODELS_TTL unless `force`. Resolves to the list,
 * or null when Codex is not installed or does not answer (the last list, or the fallback, stays).
 * ROLLCALL_CODEX_MODELS=0 never reads it (test sandboxes: the Mac's own Codex must not start there).
 */
export async function refreshCodexModels({ force = false, env = process.env, now = Date.now() } = {}) {
  if (store.parseFlag(env.ROLLCALL_CODEX_MODELS) === false) return null;
  const b = codexBin(env);
  if (!b) return null;
  const last = store.readMachineFile("codex-models");
  if (!force && last?.at && now - last.at < MODELS_TTL) return last.models;
  try {
    const r = await once(b, "model/list", { limit: 100 }, { env, timeoutMs: 20_000 });
    const seen = new Set();
    const models = (r?.data ?? [])
      .filter((m) => m && !m.hidden && typeof (m.model ?? m.id) === "string")
      .sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault))
      .map((m) => ({ id: m.model ?? m.id, label: m.displayName || m.model || m.id, harness: "codex" }))
      .filter((m) => !seen.has(m.id) && seen.add(m.id));
    if (!models.length) return null;
    store.updateMachineFile("codex-models", () => ({ value: { at: now, models }, out: null }));
    return models;
  } catch { return null; }
}

/** `codex()`: whether the codex CLI is installed: its models are offered only then. */
export function chatOptions({ codex = () => false } = {}) {
  return {
    models: [...CLAUDE_MODELS, ...(codex() ? codexModels() : [])],
    defaultModel: "opus",
    modes: { claude: CLAUDE_MODES, codex: CODEX_MODES },
    defaultMode: { claude: "default", codex: "default" },
    modeFixed: { claude: false, codex: false },
    archiveAfterDays: archiveDays(),
  };
}

// ---------------------------------------------------------------- titles and branches

/** The draft title: the first line of the owner's words, up to 60 characters, cut at a word. */
export function draftTitle(text) {
  const line = String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const one = line.replace(/\s+/g, " ");
  if (one.length <= 60) return one || "New chat";
  const cut = one.slice(0, 57);
  const sp = cut.lastIndexOf(" ");
  return `${(sp >= 20 ? cut.slice(0, sp) : cut).replace(/[\s,.;:-]+$/, "")}...`;
}

/** A title as a branch name's last part: lowercase words joined by "-", 40 characters at most. */
export function slugOf(title) {
  const s = String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const cut = s.length > 40 ? s.slice(0, 40).replace(/-[^-]*$/, "") || s.slice(0, 40) : s;
  return cut.replace(/-+$/, "");
}

/** A title the model wrote, cleaned: one line, no quotes or trailing stop, 2 to 6 words kept to 60 characters. */
export function cleanTitle(raw) {
  let t = String(raw ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  t = t.replace(/^title:\s*/i, "").replace(/^["'`*]+|["'`*]+$/g, "").replace(/[.!]+$/, "").trim();
  if (!t) return null;
  const words = t.split(/\s+/).slice(0, 6);
  t = words.join(" ");
  return t.length > 60 ? draftTitle(t) : t;
}

/** Whether origin has branch `b`: its remote-tracking ref, else a quick ls-remote (3 s; offline counts as no). */
function originHas(dir, b) {
  if (gitSync(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`]).status === 0) return true;
  const r = gitSync(dir, ["ls-remote", "--heads", "origin", b], { timeout: 3000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes" } });
  return r.status === 0 && !!r.stdout.trim();
}

/**
 * Renames the chat's branch to `chat/<title slug>` (suffix -2, -3... when taken) while it has no upstream and origin
 * has no branch of that name. The worktree folder keeps its name (the running session's cwd). Returns the new branch,
 * or null when nothing changed.
 */
export function renameBranch(c, title) {
  if (!c?.worktree || !c.branch || !existsSync(c.worktree)) return null;
  const slug = slugOf(title);
  if (!slug) return null;
  const dir = c.worktree;
  if (gitSync(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).status === 0) return null;
  const current = gitSync(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout?.trim();
  if (current !== c.branch) return null; // the session moved it: leave it be
  if (originHas(dir, c.branch)) return null; // pushed without an upstream set
  const taken = (b) => gitSync(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).status === 0 || originHas(dir, b);
  let want = `chat/${slug}`;
  if (want === c.branch) return null;
  for (let n = 2; taken(want); n++) {
    if (n > 50) return null;
    want = `chat/${slug}-${n}`;
    if (want === c.branch) return null;
  }
  return gitSync(dir, ["branch", "-m", c.branch, want]).status === 0 ? want : null;
}

/**
 * Sets `h`'s title `by` "draft", "auto" or "owner"; an automatic one only while the title is still the draft. The
 * branch follows the title while unpushed. Returns the record, or null when the chat is gone.
 */
export function setTitle(h, title, by) {
  return updateChat(h, (c) => {
    if (by === "auto" && c.titleBy !== "draft") return false;
    c.title = title;
    c.titleBy = by;
    const b = renameBranch(c, title);
    if (b) c.branch = b;
    return true;
  });
}

/** The prompt the one-shot title model gets: the owner's first words, cut to 2000 characters. */
const titlePrompt = (text) => `Write a title of 2 to 6 words for a chat that starts with the message below. Reply with the title only: no quotes, no punctuation at the end.\n\nThe message:\n${String(text).slice(0, 2000)}`;

/**
 * The command that writes a title: $ROLLCALL_CHAT_TITLE_CMD (a stand-in in tests: the prompt on stdin, the title on
 * stdout), else Claude Code on Haiku in print mode, with no tools, no settings (so no hooks), and no session saved.
 */
export function titleCommand(env = process.env) {
  if (env.ROLLCALL_CHAT_TITLE_CMD) return [env.ROLLCALL_CHAT_TITLE_CMD, []];
  const bin = env.KESSELRUNNER_CLAUDE_BIN || env.DOTCLAUDE_CLAUDE_BIN || "claude";
  return [bin, ["-p", "--model", "haiku", "--tools", "", "--setting-sources", "", "--no-session-persistence", "--output-format", "text"]];
}

/** Runs the title command on `text`: resolves to the cleaned title, or null (a failure, or 60 s gone). */
export function writeTitle(text, { env = process.env, timeoutMs = 60_000 } = {}) {
  const [cmd, args] = titleCommand(env);
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const end = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try { child = spawn(cmd, args, { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "ignore"] }); } catch { end(null); return; }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} end(null); }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; if (out.length > 10_000) child.kill(); });
    child.on("error", () => end(null));
    child.on("exit", (code) => end(code === 0 ? cleanTitle(out) : null));
    child.stdin.on("error", () => {});
    child.stdin.end(titlePrompt(text));
  });
}

// ---------------------------------------------------------------- making one

const reason = (r) => (r.stderr || r.stdout || String(r.error?.message ?? "") || "git failed").trim().split("\n").filter(Boolean).at(-1)?.replace(/^fatal:\s*/, "") ?? "git failed";

/**
 * The chat's worktree: `<repo>/.claude/worktrees/<h>` on branch `branch` from origin's default branch, after a fetch
 * of at most 3 s (a failed one uses the local ref). { worktree, branch, repo, note }: worktree and branch null, and
 * `note` set, when git refuses (not a repo, a broken one): the chat then works in the folder itself.
 */
export function makeWorktree(h, folder, { branch = `chat/${h}` } = {}) {
  const info = locate(folder);
  if (!info) {
    const r = gitSync(folder, ["rev-parse", "--show-toplevel"]);
    return { worktree: null, branch: null, repo: null, note: `Working in the folder itself: ${r.status === 0 ? "git could not read it" : reason(r)}` };
  }
  const main = mainCheckout(info);
  const { key, name } = repoKey(info);
  const repo = { key, name, main };
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes" };
  let b = defaultBranch(info);
  gitSync(main, ["fetch", "--quiet", "--no-tags", "origin", ...(b ? [b] : [])], { env, timeout: 3000 });
  b ??= defaultBranch(info);
  const ok = (ref) => gitSync(main, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status === 0;
  const base = b && ok(`origin/${b}`) ? `origin/${b}` : b && ok(b) ? b : "HEAD";
  const path = join(main, ".claude", "worktrees", h);
  mkdirSync(dirname(path), { recursive: true });
  // --no-track: the branch has no upstream until the session pushes it (renameBranch reads that).
  const r = gitSync(main, ["worktree", "add", "--no-track", "-b", branch, path, base], { timeout: 120_000 });
  if (r.status !== 0) return { worktree: null, branch: null, repo, note: `Working in the folder itself: ${reason(r)}` };
  return { worktree: path, branch, repo, note: null };
}

/** What the chat contract names for each harness: the agent, and its tool for asking the owner. */
const CONTRACT_WORDS = { claude: { agent: "Claude Code", ask: "AskUserQuestion" }, codex: { agent: "Codex", ask: "request_user_input" } };

/**
 * The chat's instructions, written to its home: chat-contract.md with its place and harness filled in. Claude Code
 * appends it to its system prompt; Codex takes it as developer instructions.
 */
export function writeContract(h, c) {
  const where = c.worktree ? `your own worktree, ${c.worktree}, on your own branch (\`git branch --show-current\`; it starts as ${c.branch} and is renamed once the chat has a title, until you push it)` : `the folder ${c.folder} (no worktree of your own: ${c.note ?? "git refused one"})`;
  const words = CONTRACT_WORDS[c.harness] ?? CONTRACT_WORDS.claude;
  const text = readFileSync(CONTRACT, "utf8").replaceAll("{{where}}", where).replaceAll("{{home}}", h).replaceAll("{{agent}}", words.agent).replaceAll("{{ask}}", words.ask);
  const file = join(store.homeDir(h), "chat-contract.md");
  writeFileSync(file, text);
  return file;
}

/** A free chat home name (`chat-` and 6 lowercase base36), made now; null after 50 tries. */
export function reserveChatHome() {
  mkdirSync(dirname(store.homeDir("chat-x")), { recursive: true });
  for (let i = 0; i < 50; i++) {
    const n = Number.parseInt(randomBytes(4).toString("hex"), 16) % 36 ** 6;
    const h = `chat-${n.toString(36).padStart(6, "0")}`;
    try { mkdirSync(store.homeDir(h)); return h; } catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  return null;
}

/**
 * The launch file the host starts chat `h`'s own session from, in the home's worker folder: claude-launch.json, or
 * codex-launch.json for a Codex chat. `session` null keeps the one the launch names (and a Codex chat its thread).
 */
export function writeChatLaunch(h, c, { session = null, resume = false } = {}) {
  if (c.harness === "codex") { writeCodexChatLaunch(h, c, { session }); return; }
  const prev = readJson(launchFile(h, null));
  session ??= prev?.session ?? null;
  writeJson(launchFile(h, null), {
    ...(prev ?? {}),
    home: h, task: null, session, resume, settings: null, cwd: c.worktree ?? c.folder,
    bin: process.env.KESSELRUNNER_CLAUDE_BIN || process.env.DOTCLAUDE_CLAUDE_BIN || "claude",
    prompt: null, mode: c.mode && c.mode !== "default" ? c.mode : null, model: c.model ?? null, effort: null, addDir: [], name: c.title,
    appendPrompt: writeContract(h, c), view: "chat",
  });
}

/**
 * A Codex chat's launch (codex-launch.json), as harness/codex.mjs writes a worker's: the chat's mode as Codex's
 * approval policy and sandbox, its contract as developer instructions (`instructions`, read at each start).
 */
export function writeCodexChatLaunch(h, c, { session = null } = {}) {
  const f = codexLaunchFile(h, null);
  const prev = readJson(f);
  const cwd = c.worktree ?? c.folder;
  const on = modelFor({ model: c.model });
  writeJson(f, {
    home: h, task: null, session: session ?? prev?.session ?? randomUUID(), thread: session && session !== prev?.session ? null : prev?.thread ?? null,
    name: c.title, cwd, prompt: null, model: isCodexModel(c.model) ? c.model : on.model, effort: on.effort, mode: c.mode ?? "default", ...policyFor(c.mode),
    writableRoots: writableRoots({ home: h, id: null, worktree: cwd }), bin: codexBin(), view: "chat",
    questions: store.envFlag("ROLLCALL_CODEX_QUESTIONS") !== false, instructions: writeContract(h, c),
  });
}

/** The Claude Code mode a Codex chat's pick matches: the one its tasks' workers start in (start.mjs reads it). */
const claudeModeOf = (c) => (c?.harness === "codex" ? (c.mode === "auto" ? "auto" : "default") : c?.mode ?? null);

/**
 * Binds chat `h` to its Claude Code session `session`, as `rollcall supervise` binds a supervisor: the home's lock and
 * the session's record (`chat`, not `supervisor`: its hooks mark turns and bring task news, and its edits are allowed).
 * The record is written before the session runs; the session's hooks fill in the rest.
 */
export function bindChat(h, session) {
  if (!session) return;
  store.writeHomeFile(h, "lock", { session, at: Date.now(), chat: true });
  const g = store.readGlobal(session);
  // A Codex chat has no Claude Code hooks to record the mode its workers start in: the chat's pick says it.
  const c = readChat(h);
  const mode = c?.harness === "codex" ? { mode: claudeModeOf(c) } : {};
  store.writeGlobal({ id: session, startedAt: Date.now(), repos: [], firstPrompt: null, ...(g ?? {}), ...mode, supervisor: null, chat: { home: h, at: g?.chat?.at ?? Date.now() } });
}

/**
 * A new chat in `folder` (`chat.new`): its home, its worktree (or the folder itself, with `note`), its record, its
 * launch with the chat contract appended, and its session started in the host on the owner's own words. Returns once
 * the agent is started, never waiting on the first turn: { ok, home, chat, session } or { ok: false, code, err }.
 */
export async function newChat({ folder, text, attachments = [], model = "opus", mode = "default", title = null, now = Date.now() }) {
  const harness = isCodexModel(model) ? "codex" : "claude";
  const h = reserveChatHome();
  if (!h) return { ok: false, code: "failed", err: "could not find a free chat name" };
  store.writeHomeFile(h, "runtime", { runtime: "host", kind: "chat", at: now });
  const w = makeWorktree(h, folder);
  const c = {
    title: title ?? draftTitle(text), titleBy: title ? "owner" : "draft", folder, repo: w.repo, worktree: w.worktree, branch: w.branch,
    harness, model, mode, createdAt: now, lastUsedAt: now, archivedAt: null, archivedBy: null, note: w.note,
  };
  writeChat(h, c);
  const session = randomUUID();
  writeChatLaunch(h, c, { session });
  const r = callSync("chat-start", { ref: h, text, attachments }, { timeoutMs: 60_000 });
  if (!r.ok) {
    // Never started: no chat is left behind (the owner's words stay in their composer, to send again). One the host
    // did start (it answered too late) stays, with its home.
    const gone = !agentRecord(h, null) && dropChat(h, c);
    return { ok: false, code: r.error?.code === "bad-payload" ? "bad-payload" : "failed", err: r.error?.message ?? "the agent host did not start the chat", ...(gone ? {} : { home: h }) };
  }
  // The worktree's own setup (deps, env files), in the background, as a task's new worktree gets it.
  if (w.worktree) {
    try { const { checkoutFacts, startSetup } = await import("../runtime.mjs"); checkoutFacts(w.worktree); startSetup(w.worktree, { bin: BIN }); } catch {}
  }
  return { ok: true, home: h, chat: chatView(h), session: r.session ?? session };
}

/** Undoes a chat that never started: its worktree, its branch (nothing is on it yet) and its home. Whether it went. */
function dropChat(h, c) {
  if (c.worktree && c.repo?.main) {
    gitSync(c.repo.main, ["worktree", "remove", "--force", c.worktree]);
    if (c.branch) gitSync(c.repo.main, ["branch", "-D", c.branch]);
  }
  try { rmSync(store.homeDir(h), { recursive: true, force: true }); return true; } catch { return false; }
}

// ---------------------------------------------------------------- archive

/** Chat `h`'s open tasks. */
export const openTasks = (h) => store.listTasks(h).filter(isOpen);

/**
 * Whether chat `c` is due to archive itself at `now`: not archived, no open tasks, no turn running, no open request,
 * and unused for `days`.
 */
export function archiveDue(c, { open = 0, running = false, requests = 0 } = {}, now = Date.now(), days = archiveDays()) {
  if (!c || c.archivedAt || open > 0 || running || requests > 0) return false;
  return now - (c.lastUsedAt ?? c.createdAt ?? now) >= days * DAY;
}

/**
 * What a chat is doing that archiving would cut short, in the words a refusal gives, or null: "it is waiting on you"
 * (a request open), "it is working" (a turn running).
 */
export function busyWords({ running = false, requests = 0 } = {}) {
  if (requests > 0) return "it is waiting on you";
  if (running) return "it is working";
  return null;
}

/**
 * Archives chat `h` (`by` "owner" or "auto"): refused while it has open tasks, a turn runs or a request is open (`busy`,
 * the agent's { running, requests }). { ok, chat } or { ok: false, code, err }.
 */
export function archiveChat(h, by, now = Date.now(), busy = {}) {
  const n = openTasks(h).length;
  if (n) return { ok: false, code: "refused", err: `it has ${n} open task${n === 1 ? "" : "s"}` };
  const doing = busyWords(busy);
  if (doing) return { ok: false, code: "refused", err: doing };
  const c = updateChat(h, (x) => {
    if (x.archivedAt) return false;
    x.archivedAt = now;
    x.archivedBy = by;
    return true;
  });
  return c ? { ok: true, chat: c } : { ok: false, code: "not-found", err: `${h} is not a chat` };
}

/**
 * Unarchives chat `h`. A worktree gc removed comes back from origin's default branch on a new branch, and `note` says
 * so. Returns the record, or null when the chat is gone.
 */
export function unarchiveChat(h) {
  return updateChat(h, (c) => {
    if (!c.archivedAt) return false;
    c.archivedAt = null;
    c.archivedBy = null;
    if (c.worktree && !existsSync(c.worktree) && existsSync(c.folder)) {
      if (c.repo?.main) gitSync(c.repo.main, ["worktree", "prune"]);
      const taken = (b) => c.repo?.main && gitSync(c.repo.main, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).status === 0;
      let b = `chat/${h}`;
      for (let n = 2; taken(b) && n < 50; n++) b = `chat/${h}-${n}`;
      const w = makeWorktree(h, c.folder, { branch: b });
      if (w.worktree) {
        c.note = `The old worktree was cleaned up after its work landed: this is a new one from ${defaultBranchOf(c) ?? "the default branch"}, on ${b}.`;
        c.branch = b;
        c.worktree = w.worktree;
      } else {
        c.note = w.note;
        c.worktree = null;
        c.branch = null;
      }
      writeChatLaunch(h, c, { session: readJson(launchFile(h, null))?.session ?? null, resume: !!readJson(launchFile(h, null))?.resume });
    }
    return true;
  });
}

const defaultBranchOf = (c) => { const info = c.repo?.main ? locate(c.repo.main) : null; const b = info ? defaultBranch(info) : null; return b ? `origin/${b}` : null; };

/** The owner's words or a turn's end: the chat was used now. */
export function touchChat(h, now = Date.now()) {
  updateChat(h, (c) => { c.lastUsedAt = now; return true; });
}

// ---------------------------------------------------------------- what front ends read

/** Every hosted home's `chat`, as the snapshot shows it; null for a terminal crew. */
export function chatView(h) {
  if (runtimeOf(h) !== "host") return null;
  const a = agentRecord(h, null);
  const c = readChat(h);
  if (c) {
    return {
      title: c.title, titleBy: c.titleBy, folder: c.folder, folderName: basename(c.folder ?? "") || null, repo: c.repo ?? null,
      worktree: c.worktree ?? null, branch: c.branch ?? null, harness: a?.harness ?? c.harness ?? "claude", model: a?.model ?? c.model ?? null,
      mode: a?.mode ?? c.mode ?? null, createdAt: c.createdAt ?? null, lastUsedAt: c.lastUsedAt ?? null, archivedAt: c.archivedAt ?? null,
      archivedBy: c.archivedBy ?? null, note: c.note ?? null, busy: busyOf(a),
    };
  }
  // A hosted crew made before chats: titled by its name, in the folder it was started in (writeHostedLaunch's falcon.json).
  const folder = store.readHomeFile(h, "falcon")?.cwd ?? readJson(launchFile(h, null))?.cwd ?? null;
  const info = folder && existsSync(folder) ? locate(folder) : null;
  const rk = info ? repoKey(info) : null;
  const made = store.readHomeFile(h, "runtime")?.at ?? null;
  let used = a?.turnAt ?? a?.at ?? null;
  if (!used) { try { used = statSync(store.homeDir(h)).mtimeMs; } catch {} }
  return {
    title: h, titleBy: "name", folder, folderName: folder ? basename(folder) : null, repo: rk ? { key: rk.key, name: rk.name, main: mainCheckout(info) } : null,
    worktree: null, branch: null, harness: a?.harness ?? "claude", model: a?.model ?? null, mode: a?.mode ?? null,
    createdAt: made, lastUsedAt: used ?? made, archivedAt: null, archivedBy: null, note: null, busy: busyOf(a),
  };
}

/** What the chat's agent does now, from its record (agent.json): "waiting" (a request open), "working" (a turn runs, or open in a terminal: archive refuses both), or null. */
const busyOf = (a) => (a?.requests > 0 ? "waiting" : a?.state === "running" || a?.state === "terminal" ? "working" : null);

/** Every hosted home, as search sees them. */
const hostedHomes = () => store.listHomes().filter((h) => runtimeOf(h) === "host");

/** The plain text of a history item the search reads: the owner's words and the agent's replies, no tool output. */
const searchable = (item) => (item && (item.kind === "user" || item.kind === "assistant") && typeof item.text === "string" ? item.text : null);

/**
 * Chats whose title or history matches every word of `query` (case-insensitive), best first: title matches before
 * text matches, then the newest. Each `match` carries a snippet of about 120 characters around the first hit.
 */
export function searchChats(query, { limit = 30 } = {}) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const all = (s) => { const l = s.toLowerCase(); return words.every((w) => l.includes(w)); };
  const snippet = (s) => {
    const l = s.toLowerCase();
    const at = Math.min(...words.map((w) => l.indexOf(w)).filter((i) => i >= 0));
    const from = Math.max(0, at - 50);
    const flat = s.replace(/\s+/g, " ");
    const cut = s.slice(from, from + 120).replace(/\s+/g, " ").trim();
    return `${from > 0 ? "..." : ""}${cut}${from + 120 < flat.length ? "..." : ""}`;
  };
  const out = [];
  for (const h of hostedHomes()) {
    const c = chatView(h);
    if (!c) continue;
    const base = { home: h, title: c.title, folder: c.folder, folderName: c.folderName, archivedAt: c.archivedAt, lastUsedAt: c.lastUsedAt };
    if (all(c.title ?? "")) { out.push({ ...base, match: { in: "title", snippet: c.title, itemId: null } }); continue; }
    let text = "";
    try { text = readFileSync(join(store.homeDir(h), "workers", h, "history.jsonl"), "utf8"); } catch { continue; }
    // The latest version of each item: a streamed reply is written again as it grows.
    const items = new Map();
    for (const line of text.split("\n")) {
      if (!line.includes('"ev":"item"')) continue;
      try { const e = JSON.parse(line); if (e.item?.id) items.set(e.item.id, e.item); } catch {}
    }
    for (const item of items.values()) {
      const s = searchable(item);
      if (s && all(s)) { out.push({ ...base, match: { in: "text", snippet: snippet(s), itemId: item.id } }); break; }
    }
  }
  const rank = (r) => (r.match.in === "title" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)).slice(0, limit);
}

/** The history item a task made under chat `h` adds to it (a front end draws a card from the live task). */
export const taskItem = (h, tid, title, at = Date.now()) => ({ kind: "task", id: `task:${h}:${tid}`, at, ref: `${h}:${tid}`, title: String(title ?? "") });
