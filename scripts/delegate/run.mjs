#!/usr/bin/env node
// Delegation runner: runs one of the named agents (~/.claude/agents/<name>.md)
// on the Codex backend, i.e. as a non-interactive `codex exec` on the user's
// Codex plan, instead of as a Claude Code subagent. The agent's markdown body
// becomes Codex developer instructions; the task prompt (stdin or --prompt-file)
// is the user turn; only the agent's final message is printed, so the caller's
// context stays as clean as with the Agent tool. Codex's own output streams to
// a log file whose path is printed at start and on the trailer line.
//
//   node run.mjs <agent> [--cwd DIR] [--prompt-file F] [--sandbox MODE] [--dry-run]   (prompt on stdin unless --prompt-file)
//   node run.mjs status [--hook]                                                       (which backend is configured)
//
// The backend is the global switch (`kesselrunner delegate`), unless the
// agent's frontmatter picks its own: `backend: codex` runs it here even when
// the switch says claude; `backend: claude` (or the older `codex: never`)
// keeps it on the Agent tool.
//
// Exit codes: 0 done; 2 use the Agent tool (this agent's backend is
// "claude"); 3 usage / missing agent / Codex unavailable; otherwise Codex's
// own exit code (with Codex status 2 remapped to 1 because 2 is reserved for
// the Agent fallback).
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeTomlBasic, parseAgent } from "../../lib/agents.mjs";
import { agentBackend, agentOverrides, codexStatus, readDelegation } from "../../lib/delegate.mjs";
import { knob } from "../../lib/legacy.mjs";
import { CLAUDE_DIR, inside } from "../../lib/reconcile.mjs";

// Codex sandbox for the worker. Default: writes confined to the repo it was
// pointed at (plus temp and the dirs below), network on (gh, npm, localhost
// dev servers). KESSELRUNNER_CODEX_SANDBOX (or an agent's `codex_sandbox:`
// frontmatter) overrides it: "danger-full-access" lifts the sandbox,
// "read-only" forbids writes.
const DEFAULT_SANDBOX = "workspace-write";
const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];
// Outside-the-repo dirs that ordinary builds and test runs write to, added as
// extra writable roots under workspace-write so xcodebuild, simulators, and
// package managers work without lifting the sandbox. Only existing dirs are
// passed; KESSELRUNNER_CODEX_ADD_DIRS (colon-separated) adds more. Writable dirs
// are not enough for the iOS simulator: the macOS sandbox also blocks the XPC
// connection to CoreSimulatorService, so simulator suites need
// danger-full-access (or the caller re-runs them on a Claude subagent).
const BUILD_DIRS = [
  "Library/Developer/Xcode/DerivedData", "Library/Developer/CoreSimulator", "Library/Developer/XCTestDevices", "Library/Logs/CoreSimulator",
  "Library/Caches", ".npm", ".cache", ".pnpm-store", ".yarn", ".bun",
].map((d) => join(homedir(), d));
const CORE = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

function die(msg, code = 3) { process.stderr.write(`[delegate] ${msg}\n`); process.exit(code); }

function parseArgs(argv) {
  const valueFlags = { "--cwd": "cwd", "--prompt-file": "promptFile", "--sandbox": "sandbox" };
  const options = { dryRun: false, hook: false };
  let agentName;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--hook") options.hook = true;
    else if (arg in valueFlags) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) die(`${arg} requires a value`);
      options[valueFlags[arg]] = value;
    } else if (arg.startsWith("--")) die(`unknown option "${arg}"`);
    else if (agentName) die(`unexpected argument "${arg}"`);
    else agentName = arg;
  }
  const isStatus = !agentName || agentName === "status";
  if (options.hook && !isStatus) die("--hook is only valid with status");
  if (isStatus && (options.cwd || options.promptFile || options.sandbox || options.dryRun)) die("agent options require an agent name");
  return { agentName, isStatus, ...options };
}

const { agentName, isStatus, cwd: cwdArg, promptFile, sandbox: sandboxArg, dryRun, hook } = parseArgs(process.argv.slice(2));
const delegation = readDelegation();

// ------------------------------------------------------------------ status
if (isStatus) {
  const overrides = agentOverrides(delegation.backend);
  const onCodex = overrides.filter((o) => o.backend === "codex").map((o) => o.name);
  const onClaude = overrides.filter((o) => o.backend === "claude").map((o) => o.name);
  const codex = delegation.backend === "codex" || onCodex.length ? codexStatus() : null;
  if (hook) {
    // SessionStart hook: one line of context when any named agent runs on Codex, silence otherwise.
    const how = `see ${join(CORE, "docs", "delegation.md")}`;
    if (delegation.backend === "codex") console.log(codex.problem
      ? `[kesselrunner] delegation backend is set to codex but unusable: ${codex.problem}. Falling back to Claude subagents (the Agent tool) this session.`
      : `[kesselrunner] delegation backend: codex (${codex.version}, model ${delegation.model ?? "config.toml default"}). Run named agents through scripts/delegate/run.mjs instead of the Agent tool${onClaude.length ? `, except ${onClaude.join(", ")} (the Agent tool always)` : ""} - ${how}.`);
    else if (codex) console.log(codex.problem
      ? `[kesselrunner] ${onCodex.join(", ")} ${onCodex.length > 1 ? "are" : "is"} set to run on codex but codex is unusable: ${codex.problem}. Spawn ${onCodex.length > 1 ? "them" : "it"} with the Agent tool this session.`
      : `[kesselrunner] delegation backend: claude, except ${onCodex.join(", ")} on codex (${codex.version}): run ${onCodex.length > 1 ? "those" : "that one"} through scripts/delegate/run.mjs instead of the Agent tool - ${how}.`);
    process.exit(0);
  }
  if (delegation.backend === "codex") {
    console.log(`backend: codex${codex.bin ? ` (${codex.version ?? "unusable"}, ${codex.bin})` : ""}${codex.problem ? `\nproblem: ${codex.problem}` : ""}${onClaude.length ? `\non claude by their own frontmatter: ${onClaude.join(", ")}` : ""}`);
    process.exit(codex.problem ? 3 : 0);
  }
  console.log(`backend: claude (Agent tool)${onCodex.length ? `\non codex by their own frontmatter: ${onCodex.join(", ")}${codex?.problem ? ` (unusable: ${codex.problem})` : ""}` : ""}`);
  if (!agentName) console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 21).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}

// --------------------------------------------------------------------- run
if (!/^[\w-]+$/.test(agentName)) die(`invalid agent name "${agentName}"`);
const agentPath = join(CLAUDE_DIR, "agents", `${agentName}.md`);
if (!existsSync(agentPath)) die(`no agent named "${agentName}" in ${dirname(agentPath)}`);
let agent;
try { agent = parseAgent(readFileSync(agentPath, "utf8")); } catch (error) { die(`could not read ${agentPath}: ${error.message}`); }
if (!agent) die(`${agentPath} has no frontmatter`);
// The agent's own pick beats the global switch: an agent that cannot do its job in a Codex worker (ios-driver
// needs the simulator, which the sandbox cannot reach) stays on Claude, and one can move to Codex alone.
const own = agentBackend(agent);
if ((own ?? delegation.backend) !== "codex") {
  die(own ? `${agentName} always runs as a Claude subagent (frontmatter \`${agent.get("backend") ? "backend: claude" : "codex: never"}\`) - spawn it with the Agent tool (subagent_type: "${agentName}") instead`
    : `delegation backend is "${delegation.backend}" - spawn ${agentName} with the Agent tool (subagent_type: "${agentName}") instead`, 2);
}

const { bin, problem } = codexStatus();
if (problem) die(`${problem}. Spawn ${agentName} with the Agent tool instead.`);

const cwd = resolve(cwdArg ?? process.cwd());
let root;
try { if (!statSync(cwd).isDirectory()) throw new Error(); root = realpathSync(cwd); } catch { die(`--cwd is not a directory: ${cwd}`); }
const sandbox = sandboxArg ?? agent.get("codex_sandbox") ?? knob("CODEX_SANDBOX") ?? DEFAULT_SANDBOX;
if (!SANDBOXES.includes(sandbox)) die(`unknown sandbox "${sandbox}" (one of ${SANDBOXES.join(", ")})`);
// Agent frontmatter (this agent needs a bigger/smaller model) beats the user's global pick.
const model = agent.get("codex_model") ?? delegation.model;
const effort = agent.get("codex_effort") ?? delegation.effort;

let task;
try {
  task = (promptFile ? readFileSync(promptFile, "utf8") : dryRun && process.stdin.isTTY ? "" : readFileSync(0, "utf8")).trim();
} catch (error) {
  die(`could not read prompt${promptFile ? ` file ${promptFile}` : " from stdin"}: ${error.message}`);
}
if (!task && !dryRun) die("empty task prompt (pass it on stdin or with --prompt-file)");

const harnessNote = `You are the "${agentName}" agent of a shared coding harness (kesselrunner), spawned non-interactively by Claude Code and running on Codex. There is no user to ask: make reasonable decisions, never wait for input. Where the instructions name Claude Code tools, use the Codex equivalent: "Edit/Write tool" = edit the files directly; "Read/Grep/Glob" = read and search files; "Agent tool" is unavailable - do that work yourself. Your final message is consumed by the calling agent verbatim: return exactly the report the instructions ask for, nothing else.`;
const instructions = `${harnessNote}\n\n${agent.body.trim()}`;

const logDir = knob("DELEGATE_LOG_DIR") || join(tmpdir(), "kesselrunner-delegate");
mkdirSync(logDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const lastMessageFile = join(logDir, `${agentName}-${stamp}.md`);
const logFile = join(logDir, `${agentName}-${stamp}.log`);

// Extra writable roots: the git common dir (a worktree's metadata lives in the
// main repo's .git, outside the checkout), build/cache dirs, and user extras.
// Only existing directories outside the workspace, which -C already covers.
function gitCommonDir(dir) {
  try { return resolve(dir, execFileSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); } catch { return null; }
}
function realDir(dir) {
  try { const abs = realpathSync(resolve(dir)); return statSync(abs).isDirectory() ? abs : null; } catch { return null; }
}
const extraDirs = sandbox !== "workspace-write" ? [] : [...new Set(
  [gitCommonDir(cwd), ...BUILD_DIRS, ...(knob("CODEX_ADD_DIRS") ?? "").split(":")]
    .map((d) => d && realDir(d))
    .filter((d) => d && !inside(d, root)),
)];

// Non-interactive: nothing can answer an approval prompt, so none are requested.
const argv = [
  "exec", "--skip-git-repo-check", "--ephemeral", "--color", "never",
  "--disable", "hooks", // the worker must not re-run kesselrunner sync / codex-bridge / docsic hooks
  "-C", cwd, "--sandbox", sandbox, "-c", 'approval_policy="never"',
  ...(sandbox === "workspace-write" ? ["-c", "sandbox_workspace_write.network_access=true"] : []),
  ...extraDirs.flatMap((d) => ["--add-dir", d]),
  // A TOML basic string keeps the instructions byte-for-byte in Codex's developer role.
  "-c", `developer_instructions="""\n${escapeTomlBasic(instructions)}\n"""`,
  ...(model ? ["-m", model] : []),
  ...(effort ? ["-c", `model_reasoning_effort="${escapeTomlBasic(effort)}"`] : []),
  "-o", lastMessageFile, "-",
];
const shownArgv = argv.map((a) => (a.startsWith("developer_instructions=") ? `developer_instructions=<${instructions.length} chars>` : a));

if (dryRun) {
  console.log(JSON.stringify({ bin, argv: shownArgv, cwd, sandbox, extraWritableDirs: extraDirs, model: model ?? "(config.toml default)", effort: effort ?? "(config.toml default)", promptChars: task.length, logFile }, null, 2));
  process.exit(0);
}

process.stderr.write(`[delegate] ${agentName} -> codex (${sandbox}) in ${cwd}; live log: ${logFile}\n`);
const started = Date.now();
// Codex's output streams straight into the log so a caller can tail it mid-run.
const logFd = openSync(logFile, "w");
writeSync(logFd, `$ ${bin} ${shownArgv.join(" ")}\n\n`);
// gh keeps its token in the macOS keychain, which the sandbox cannot reach, so
// the worker's gh calls would 401. Resolve the token here, outside the sandbox,
// and hand it over in the environment only (never argv, never the log).
function ghToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return {};
  try { const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim(); return token ? { GH_TOKEN: token } : {}; } catch { return {}; }
}
const r = spawnSync(bin, argv, { input: task, cwd, env: { ...process.env, ...ghToken(), KESSELRUNNER_CORE: CORE, DOTCLAUDE_CORE: CORE }, stdio: ["pipe", logFd, logFd] });
closeSync(logFd);

const minutes = ((Date.now() - started) / 60000).toFixed(1);
let report = null;
try { report = readFileSync(lastMessageFile, "utf8").trim(); } catch {}
if (report) {
  process.stdout.write(`${report}\n`);
} else {
  let tail = "";
  try { tail = readFileSync(logFile, "utf8").split("\n").slice(-40).join("\n"); } catch {}
  process.stdout.write(`[delegate] ${agentName} produced no final message${r.error ? ` (${r.error.message})` : ""}.\n--- last output\n${tail}\n`);
}
// Exit code 2 is reserved for the caller's "use the Agent tool" fallback.
const code = r.status === 2 ? 1 : (r.status ?? 1);
process.stdout.write(`\n[delegate] ${agentName} via codex: exit ${code}, ${minutes} min, log ${logFile}\n`);
process.exit(code);
