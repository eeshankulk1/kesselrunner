#!/usr/bin/env node
// prod-read: read a project's live production without changing it and without
// printing a secret. It reads the `production` block of the project's
// .claude/test-manifest.json (services on Railway, Vercel, or the project's own
// commands), runs a fixed, read-only CLI call per command, and prints a short
// summary. Every byte printed passes a redactor first (private keys, URL
// passwords, bearer tokens, secret-named values, long token-like strings), and
// output is capped at 400 lines of 2,000 characters.
//
//   node read.mjs services                                  (the services and the errors/database/notes fields; no CLI calls)
//   node read.mjs status [service]                          (every service when none is named)
//   node read.mjs deploys <service> [--limit N]             (recent deployments; default 10, max 50)
//   node read.mjs logs <service> [--since 1h] [--lines N] [--filter Q] [--errors] [--http] [--build]
//                                                           (default 200 lines, max 1000; --http and --build are Railway only)
//   node read.mjs vars <service>                            (variable NAMES only, never values)
//   --repo DIR on any command reads that repo's manifest instead of the current one's.
//
// Railway and Vercel CLIs run in the main checkout (joined with the service's
// `dir`), since a task worktree has no project link. A `command` service runs
// the manifest's own status/logs/vars strings with sh -c.
//
// Exit codes: 0 ok; 1 a provider command failed, or its output could not be
// read safely; 3 usage error, no manifest, no `production` block, unknown
// service or provider.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_LINE = 2000;
const MAX_LINES = 400;
const ERR_TAIL = 20;
const TIMEOUT_MS = 90_000;
const SECRET_WORDS = "secret|token|password|passwd|api[_-]?key|private|credential|auth";
const SECRET_KEY = new RegExp(SECRET_WORDS, "i");
const PROVIDERS = ["railway", "vercel", "command"];

class Exit extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const usage = (message) => new Exit(3, message);

/** Hide anything that looks like a credential. Errs on hiding too much. */
export function redact(text) {
  let s = String(text);
  // PEM blocks, across lines (or across literal \n inside a JSON string).
  s = s.replace(/-----BEGIN [^-\r\n]*-----[\s\S]*?-----END [^-\r\n]*-----/g, "[redacted private key]");
  // scheme://user:pass@host keeps the scheme and the host.
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/"'<>]+:[^\s@"'<>]*@/gi, "$1[redacted]@");
  // Well-known token shapes shorter than the long-string rule below: JWTs, Stripe, GitHub, Slack, AWS keys.
  s = s.replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, "[redacted]");
  s = s.replace(/\b(?:[sprw]k_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16})/g, "[redacted]");
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  s = s.replace(/(authorization["']?[ \t]*[:=][ \t]*["']?)[^"'\r\n,}]+/gi, "$1[redacted]");
  // "key": "value" with a secret-sounding key.
  s = s.replace(/"((?:[^"\\\r\n]|\\.)*)"([ \t]*:[ \t]*)"((?:[^"\\\r\n]|\\.)*)"/g,
    (m, k, sep) => (SECRET_KEY.test(k) ? `"${k}"${sep}"[redacted]"` : m));
  // key=value and key: value with a secret-sounding key.
  s = s.replace(new RegExp(`([A-Za-z0-9_.-]*(?:${SECRET_WORDS})[A-Za-z0-9_.-]*)([ \\t]*[=:][ \\t]*)("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;&"'}]+)`, "gi"),
    (m, k, sep, v) => (v === "[redacted]" || v === '"[redacted]"' ? m : `${k}${sep}[redacted]`));
  // Long token-like strings: 40+ characters holding a 16+ character piece (between / _ -) that mixes upper
  // case, lower case and digits. A file path of words and lower-case ids stays readable.
  s = s.replace(/[A-Za-z0-9+/=_-]{40,}/g, (m) => (m.split(/[/_-]/).some((p) => p.length >= 16 && mixed(p) === 3) ? "[redacted]" : m));
  return s;
}

const mixed = (s) => Number(/[a-z]/.test(s)) + Number(/[A-Z]/.test(s)) + Number(/\d/.test(s));

/** Cut long lines, keep the last MAX_LINES lines. */
export function cap(text) {
  let lines = String(text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  lines = lines.map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}...[cut]` : l));
  if (lines.length > MAX_LINES) {
    const dropped = lines.length - MAX_LINES;
    lines = [`[${dropped} earlier lines dropped; showing the last ${MAX_LINES}]`, ...lines.slice(-MAX_LINES)];
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

const safe = (text) => cap(redact(text));

function helpText() {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
  const end = src.findIndex((l) => !l.startsWith("//"));
  return `${src.slice(0, end).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")}\n`;
}

// ---- arguments ----

const VALUE_OPTS = ["repo", "since", "lines", "filter", "limit"];
const FLAG_OPTS = ["errors", "http", "build"];
const ALLOWED = {
  services: [],
  status: [],
  deploys: ["limit"],
  logs: ["since", "lines", "filter", "errors", "http", "build"],
  vars: [],
};

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    if (!a.startsWith("-")) { pos.push(a); continue; }
    let key = a.slice(2);
    let value;
    const eq = key.indexOf("=");
    if (a.startsWith("--") && eq >= 0) { value = key.slice(eq + 1); key = key.slice(0, eq); }
    if (VALUE_OPTS.includes(key)) {
      if (value === undefined) {
        if (i + 1 >= argv.length) throw usage(`--${key} needs a value`);
        value = argv[++i];
      }
      if (value === "") throw usage(`--${key} needs a value`);
      opts[key] = value;
    } else if (FLAG_OPTS.includes(key) && value === undefined) {
      opts[key] = true;
    } else {
      throw usage(`unknown option ${a}`);
    }
  }
  const [cmd, service, ...extra] = pos;
  if (cmd === "help") return { help: true };
  if (!cmd) throw usage("no command given (services, status, deploys, logs, vars)");
  if (!(cmd in ALLOWED)) throw usage(`unknown command "${cmd}" (services, status, deploys, logs, vars)`);
  if (extra.length) throw usage(`unexpected arguments: ${extra.join(" ")}`);
  if (cmd === "services" && service) throw usage("services takes no service name");
  if (["deploys", "logs", "vars"].includes(cmd) && !service) throw usage(`${cmd} needs a service name`);
  for (const k of Object.keys(opts)) {
    if (k !== "repo" && !ALLOWED[cmd].includes(k)) throw usage(`--${k} does not apply to ${cmd}`);
  }
  if (opts.lines !== undefined) opts.lines = int(opts.lines, "--lines", 1000);
  if (opts.limit !== undefined) opts.limit = int(opts.limit, "--limit", 50);
  return { cmd, service, opts };
}

function int(v, name, max) {
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > max) throw usage(`${name} must be a whole number from 1 to ${max}`);
  return Number(v);
}

// ---- repo, manifest, services ----

function git(dir, ...args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0 ? r.stdout.trim() : null;
}

function locate(repoOpt) {
  const start = resolve(repoOpt ?? process.cwd());
  if (repoOpt && !existsSync(start)) throw usage(`--repo ${repoOpt} does not exist`);
  const top = git(start, "rev-parse", "--show-toplevel") ?? (repoOpt ? start : null);
  if (!top) throw usage("not inside a git repo (pass --repo DIR)");
  const common = git(top, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const main = common && basename(common) === ".git" ? dirname(common) : top;
  return { top, main };
}

function loadProduction(top) {
  const file = join(top, ".claude", "test-manifest.json");
  if (!existsSync(file)) throw usage(`no manifest at ${file}`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw usage(`${file} is not valid JSON: ${e.message}`); }
  const prod = manifest?.production;
  if (!prod || typeof prod !== "object") throw usage(`${file} has no "production" block`);
  if (!Array.isArray(prod.services) || !prod.services.length) throw usage(`${file}: production.services is empty`);
  return prod;
}

function normalize(s) {
  return {
    ...s,
    service: s.service ?? s.name,
    project: s.project ?? s.name,
    environment: s.environment ?? "production",
  };
}

function findService(prod, name) {
  const s = prod.services.find((x) => x?.name === name);
  if (!s) throw usage(`unknown service "${name}" (have: ${prod.services.map((x) => x?.name).join(", ")})`);
  return checkProvider(s);
}

function checkProvider(s) {
  if (!PROVIDERS.includes(s.provider)) throw usage(`service "${s.name}" has unknown provider "${s.provider}" (railway, vercel, command)`);
  return normalize(s);
}

function cwdFor(svc, main) {
  const dir = svc.dir ? join(main, svc.dir) : main;
  if (!existsSync(dir)) throw usage(`service "${svc.name}": dir ${dir} does not exist in the main checkout`);
  return dir;
}

// ---- running a provider CLI ----

const shown = (cmd, args) => [cmd, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  if (r.error || r.status !== 0) {
    const why = r.error?.code === "ENOENT" ? `${cmd} is not installed or not on PATH`
      : r.error?.code === "ETIMEDOUT" ? `timed out after ${TIMEOUT_MS / 1000}s`
      : r.error ? r.error.message
      : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
    const tail = redact(r.stderr ?? "").split("\n").filter((l) => l.trim()).slice(-ERR_TAIL);
    throw new Exit(1, [...tail, `prod-read: command failed (${why}): ${shown(cmd, args)} (in ${cwd})`].join("\n"));
  }
  return r.stdout ?? "";
}

const sh = (script, cwd) => run("sh", ["-c", script], cwd);

function commandScript(svc, key) {
  const script = svc[key];
  if (typeof script !== "string" || !script.trim()) throw usage(`service "${svc.name}" (provider command) has no "${key}" command in the manifest`);
  return script;
}

// ---- summaries ----

const FIELDS = {
  status: ["status", "state", "readyState", "deploymentStatus", "latestDeployment.status", "deployment.status"],
  id: ["id", "deploymentId", "uid", "latestDeployment.id", "deployment.id"],
  created: ["createdAt", "created", "latestDeployment.createdAt", "deployment.createdAt", "updatedAt"],
  url: ["url", "staticUrl", "deploymentUrl", "latestDeployment.staticUrl"],
  target: ["target"],
  message: ["meta.commitMessage", "meta.githubCommitMessage", "commitMessage", "latestDeployment.meta.commitMessage"],
};

function parse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function get(o, path) {
  return path.split(".").reduce((v, k) => (v && typeof v === "object" ? v[k] : undefined), o);
}

function pick(o, names) {
  for (const n of names) {
    const v = get(o, n);
    if (v !== undefined && v !== null && v !== "" && typeof v !== "object") return v;
  }
  return undefined;
}

function when(v) {
  if (typeof v === "number" || /^\d{10,13}$/.test(String(v))) {
    const n = Number(v);
    const d = new Date(n > 1e11 ? n : n * 1000);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return String(v);
}

function line(o, keys) {
  const parts = [];
  for (const k of keys) {
    let v = pick(o, FIELDS[k]);
    if (v === undefined) continue;
    if (k === "created") v = when(v);
    if (k === "message") v = String(v).split("\n")[0].slice(0, 80);
    parts.push(`${k}=${v}`);
  }
  return parts.join("  ");
}

const compact = (text) => {
  const j = parse(text);
  return j === undefined ? String(text).trim() : JSON.stringify(j);
};

function listOf(j) {
  if (Array.isArray(j)) return j;
  for (const k of ["deployments", "items", "data", "edges"]) {
    if (Array.isArray(j?.[k])) return j[k].map((e) => e?.node ?? e);
  }
  return undefined;
}

function summarizeOne(text, keys) {
  const j = parse(text);
  if (j && typeof j === "object" && !Array.isArray(j)) {
    const l = line(j, keys);
    if (l) return l;
  }
  return compact(text);
}

function summarizeList(text, keys, limit) {
  const j = parse(text);
  const list = j === undefined ? undefined : listOf(j);
  if (!list) return [compact(text)];
  if (!list.length) return ["(none)"];
  return list.slice(0, limit).map((o) => (o && typeof o === "object" ? line(o, keys) || JSON.stringify(o) : String(o)));
}

/** Variable names from a provider's JSON; null when the output cannot be read as names. */
function namesFrom(text, provider) {
  const j = parse(text);
  if (j === undefined || j === null || typeof j !== "object") return null;
  let list = Array.isArray(j) ? j : null;
  if (!list && provider === "vercel") list = ["envs", "env", "environmentVariables", "variables"].map((k) => j[k]).find(Array.isArray) ?? null;
  if (!list) return provider === "railway" ? Object.keys(j).sort() : null;
  const names = [];
  for (const item of list) {
    const n = item && typeof item === "object" ? (item.name ?? item.key) : undefined;
    if (typeof n !== "string" || !n) return null;
    names.push(n);
  }
  return [...new Set(names)].sort();
}

// ---- commands ----

const DEPLOY_KEYS = ["id", "status", "created", "url", "message"];
const header = (svc) => {
  const where = svc.provider === "railway" ? `service=${svc.service}  environment=${svc.environment}`
    : svc.provider === "vercel" ? `project=${svc.project}  environment=${svc.environment}`
    : ["status", "logs", "vars", "deploys"].filter((k) => typeof svc[k] === "string").join(", ");
  return `${svc.name}  ${svc.provider}  ${where}${svc.dir ? `  dir=${svc.dir}` : ""}`;
};

function services(prod) {
  const out = prod.services.map((s) => header(PROVIDERS.includes(s?.provider) ? normalize(s) : { ...s, provider: s?.provider ?? "?" }));
  for (const k of ["errors", "database", "notes"]) {
    if (prod[k] !== undefined) out.push(`${k}: ${typeof prod[k] === "string" ? prod[k] : JSON.stringify(prod[k])}`);
  }
  return out;
}

function deployList(svc, cwd, limit) {
  if (svc.provider === "railway") {
    const text = run("railway", ["deployment", "list", "-s", svc.service, "-e", svc.environment, "--limit", String(limit), "--json"], cwd);
    return summarizeList(text, DEPLOY_KEYS, limit);
  }
  if (svc.provider === "vercel") {
    const text = run("vercel", ["ls", svc.project, "--environment", svc.environment, "-F", "json", "--non-interactive"], cwd);
    return summarizeList(text, DEPLOY_KEYS, limit);
  }
  return sh(commandScript(svc, "deploys"), cwd).split("\n");
}

function status(svc, cwd) {
  const out = [`== ${header(svc)}`];
  if (svc.provider === "railway") {
    const text = run("railway", ["service", "status", "-s", svc.service, "-e", svc.environment, "--json"], cwd);
    out.push(summarizeOne(text, ["status", "id", "created", "url"]));
    out.push("recent deployments:", ...deployList(svc, cwd, 5).map((l) => `  ${l}`));
  } else if (svc.provider === "vercel") {
    out.push("recent deployments:", ...deployList(svc, cwd, 5).map((l) => `  ${l}`));
  } else {
    out.push(sh(commandScript(svc, "status"), cwd).replace(/\n$/, ""));
  }
  return out;
}

function logs(svc, cwd, o) {
  const lines = o.lines ?? 200;
  if (svc.provider === "railway") {
    const args = ["logs", "-s", svc.service, "-e", svc.environment, "--lines", String(lines)];
    if (o.since) args.push(`--since=${o.since}`);
    const filter = o.errors ? (o.filter ? `(${o.filter}) AND @level:error` : "@level:error") : o.filter;
    if (filter) args.push(`--filter=${filter}`);
    if (o.http) args.push("--http");
    if (o.build) args.push("--build");
    return run("railway", args, cwd);
  }
  if (svc.provider === "vercel") {
    if (o.http || o.build) throw usage("--http and --build are Railway only");
    const args = ["logs", "--project", svc.project, "--environment", svc.environment, "--no-follow", "--no-branch", "-n", String(lines)];
    if (o.since) args.push(`--since=${o.since}`);
    if (o.filter) args.push(`--query=${o.filter}`);
    if (o.errors) args.push("--level", "error");
    args.push("--non-interactive");
    return run("vercel", args, cwd);
  }
  if (Object.keys(o).some((k) => k !== "repo")) throw usage(`service "${svc.name}" runs the manifest's logs command; --since, --lines, --filter, --errors, --http and --build do not apply`);
  return sh(commandScript(svc, "logs"), cwd);
}

function vars(svc, cwd) {
  let argv;
  if (svc.provider === "railway") argv = ["railway", ["variable", "list", "-s", svc.service, "-e", svc.environment, "--json"]];
  else if (svc.provider === "vercel") argv = ["vercel", ["env", "ls", svc.environment, "-F", "json", "--non-interactive"]];
  if (argv) {
    const names = namesFrom(run(argv[0], argv[1], cwd), svc.provider);
    if (!names) throw new Exit(1, `prod-read: the output of ${shown(...argv)} could not be read as variable names, so nothing from it was printed`);
    return names;
  }
  const text = redact(sh(commandScript(svc, "vars"), cwd));
  // Only an identifier, alone or before whitespace, = or :, counts as a name: the continuation line of a multi-line value does not.
  const names = text.split("\n").map((l) => l.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]{0,127})(?:\s|[=:]|$)/)?.[1]).filter(Boolean);
  return [...new Set(names)].sort();
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) return { stdout: helpText(), stderr: "", code: 0 };
  const { cmd, service, opts } = parsed;
  const { top, main: mainCheckout } = locate(opts.repo);
  const prod = loadProduction(top);
  if (cmd === "services") return { stdout: services(prod).join("\n"), stderr: "", code: 0 };

  if (cmd === "status" && !service) {
    const out = [];
    const errs = [];
    let code = 0;
    for (const s of prod.services) {
      const svc = checkProvider(s);
      try {
        out.push(...status(svc, cwdFor(svc, mainCheckout)));
      } catch (e) {
        if (!(e instanceof Exit) || e.code !== 1) throw e;
        out.push(`== ${header(svc)}`, "(failed; see stderr)");
        errs.push(e.message);
        code = 1;
      }
    }
    return { stdout: out.join("\n"), stderr: errs.join("\n"), code };
  }

  const svc = findService(prod, service);
  const cwd = cwdFor(svc, mainCheckout);
  if (cmd === "status") return { stdout: status(svc, cwd).join("\n"), stderr: "", code: 0 };
  if (cmd === "deploys") return { stdout: deployList(svc, cwd, opts.limit ?? 10).join("\n"), stderr: "", code: 0 };
  if (cmd === "logs") return { stdout: logs(svc, cwd, opts), stderr: "", code: 0 };
  return { stdout: vars(svc, cwd).join("\n"), stderr: "", code: 0 };
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  let result;
  try {
    result = main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    result = { stdout: "", stderr: e.code === 3 ? `prod-read: ${e.message}` : e.message, code: e.code };
  }
  if (result.stdout) process.stdout.write(safe(result.stdout));
  if (result.stderr) process.stderr.write(safe(result.stderr));
  process.exitCode = result.code;
}
