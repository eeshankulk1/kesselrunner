// Extra MCP servers for workers (the `worker.mcp` action): stdio servers a front end registers by name, kept per machine
// in `_machine/worker-mcp.json`, and added each time a worker's process starts, fresh or resumed, so a server
// registered or changed later reaches an agent at its next start. Each server's environment also names the agent it
// serves (ROLLCALL_AGENT, ROLLCALL_AGENT_NAME, ROLLCALL_HARNESS). The owner's own MCP servers stay: Claude Code gets
// these through --mcp-config (never --strict-mcp-config), Codex through one config key per server.
import { accessSync, chmodSync, constants, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import * as store from "./store.mjs";

const FILE = "worker-mcp";
export const NAME = /^[a-z0-9-]{1,40}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
/** What rollcall sets in each server's environment itself: a registered value under these names is replaced. */
export const AGENT_ENV = ["ROLLCALL_AGENT", "ROLLCALL_AGENT_NAME", "ROLLCALL_HARNESS"];
/** Codex waits this long for one tool call of these servers (its default is 60 s): a browser step can take a while. */
export const CODEX_TOOL_TIMEOUT_SEC = 120;

const fail = (code, message) => ({ ok: false, code, message });

/** The registered servers: { <name>: { command, args, env, at } }. */
export function listServers() {
  const v = store.readMachineFile(FILE);
  return v && v.servers && typeof v.servers === "object" ? v.servers : {};
}

/** Whether `p` is an absolute path to an executable file. */
function executable(p) {
  if (typeof p !== "string" || !isAbsolute(p)) return false;
  try { if (!statSync(p).isFile()) return false; accessSync(p, constants.X_OK); return true; } catch { return false; }
}

/**
 * Registers or replaces server `p.name` ({ name, command, args?, env? }), or removes it ({ name, remove: true }).
 * { ok, servers, removed? } or { ok: false, code, message }.
 */
export function updateServer(p, now = Date.now()) {
  const name = p?.name;
  if (typeof name !== "string" || !NAME.test(name)) return fail("bad-payload", "name is 1 to 40 lowercase letters, digits or -");
  let entry = null;
  if (p.remove !== true) {
    if (!executable(p.command)) return fail("bad-payload", "command is an absolute path to an executable file");
    const args = p.args ?? [];
    // Well-formed text only: a lone surrogate has no TOML spelling, so it would break Codex's config.
    const text = (x) => typeof x === "string" && x.length <= 4000 && x.isWellFormed();
    if (!Array.isArray(args) || args.length > 50 || !args.every(text)) return fail("bad-payload", "args is a list of strings");
    const env = p.env ?? {};
    if (!env || typeof env !== "object" || Array.isArray(env)) return fail("bad-payload", "env is an object of strings");
    const pairs = Object.entries(env);
    if (pairs.length > 50 || pairs.some(([k, v]) => !ENV_KEY.test(k) || !text(v))) return fail("bad-payload", "env maps variable names to strings");
    entry = { command: p.command, args, env, at: now };
  }
  const r = store.updateMachineFile(FILE, (v) => {
    const servers = { ...(v?.servers ?? {}) };
    const had = name in servers;
    if (entry) servers[name] = entry;
    else delete servers[name];
    return { value: Object.keys(servers).length ? { servers } : null, out: { servers, had } };
  });
  if (!r) return fail("busy", "the server list stayed locked; try again");
  // Owner-only, like the --mcp-config files made from it: a server's environment may carry a secret.
  try { chmodSync(join(store.home(), "_machine", `${FILE}.json`), 0o600); } catch {}
  return { ok: true, servers: r.out.servers, ...(entry ? {} : { removed: r.out.had }) };
}

/**
 * The servers as one agent gets them: each one's environment plus the agent's ref (as the host's history and requests
 * carry it), the name the owner knows it by, and its harness.
 */
export function serversFor({ ref, name = null, harness }) {
  return Object.entries(listServers()).map(([n, s]) => ({
    name: n, command: s.command, args: Array.isArray(s.args) ? s.args : [],
    env: { ...(s.env ?? {}), ROLLCALL_AGENT: String(ref), ROLLCALL_AGENT_NAME: String(name ?? ref), ROLLCALL_HARNESS: harness },
  }));
}

/** Claude Code's --mcp-config document for `servers` (serversFor). */
export const claudeConfig = (servers) => ({ mcpServers: Object.fromEntries(servers.map((s) => [s.name, { type: "stdio", command: s.command, args: s.args, env: s.env }])) });

/**
 * Writes the --mcp-config file for one agent's start at `file` (owner-only: a server's environment may carry a secret),
 * or removes it when no server is registered. Returns the path, or null.
 */
export function writeClaudeConfig(file, agent) {
  const servers = serversFor({ ...agent, harness: "claude" });
  if (!servers.length) { rmSync(file, { force: true }); return null; }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(claudeConfig(servers), null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
  return file;
}

/**
 * The servers as Codex's thread config takes them: one dotted key per server (`mcp_servers.<name>`), so the owner's
 * own [mcp_servers] in config.toml stay (a whole `mcp_servers` table would replace them).
 */
export const codexConfig = (servers) => Object.fromEntries(servers.map((s) => [`mcp_servers.${s.name}`, { command: s.command, args: s.args, env: s.env, tool_timeout_sec: CODEX_TOOL_TIMEOUT_SEC }]));

/** A value as TOML (an inline table for an object): JSON strings are TOML basic strings. */
const toml = (v) => (Array.isArray(v) ? `[${v.map(toml).join(", ")}]`
  : v && typeof v === "object" ? `{ ${Object.entries(v).map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${toml(x)}`).join(", ")} }`
    : JSON.stringify(v).replace(/\x7f/g, "\\u007f"));

/** codexConfig's keys as the Codex CLI's `-c key=value` arguments (the terminal's `codex resume`). */
export const codexOverrides = (config) => Object.entries(config ?? {}).flatMap(([k, v]) => ["-c", `${k}=${toml(v)}`]);
