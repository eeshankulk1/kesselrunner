#!/usr/bin/env node
// kesselrunner - install and keep in sync a shared Claude Code setup.
//
//   kesselrunner install [--overlay <dir>] [--force]   first-time setup (also converts a symlinked ~/.claude)
//   kesselrunner sync [--quiet]                         pull the core, then reconcile ~/.claude (idempotent)
//   kesselrunner doctor                                 report drift without changing anything
//   kesselrunner delegate [claude|codex] [--model M] [--effort E]   which backend runs the named agents; codex = your Codex plan
//   kesselrunner delegate models                        list the Codex models and reasoning efforts you can pick
//   kesselrunner rules [on|off <name>...]               optional rules (the core's and the overlay's rules/): list them, or switch one on or off
//
// The SessionStart hook runs `sync --quiet` (throttled), so users rarely type any of this.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pull } from "../lib/pull.mjs";
import { CLAUDE_DIR, STATE_DIR, carryLegacyState, readJson, readState, reconcile, reconcileClaudeMd, unlinkedCoreBins } from "../lib/reconcile.mjs";
import { knob } from "../lib/legacy.mjs";
import { BACKENDS, agentOverrides, codexStatus, findCodex, listCodexModels, readDelegation, readSettings, writeDelegation, writeEnv } from "../lib/delegate.mjs";
import { RULES_KEY, enabledRules, listRules } from "../lib/rules.mjs";
import { check as checkTools } from "../packages/rollcall/src/needs.mjs";

const CORE = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const THROTTLE_MS = Number(knob("SYNC_THROTTLE_MS")) || 15 * 60 * 1000;

const [cmd = "help", ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);
const opt = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };

function makeLog(quiet) {
  const changes = [], warns = [];
  return {
    changes, warns,
    change: (m) => changes.push(m),
    warn: (m) => warns.push(m),
    flush(prefix = "[kesselrunner]") {
      if (quiet) {
        if (changes.length || warns.length) console.log(`${prefix} ${[...changes, ...warns.map((w) => `warning: ${w}`)].join("; ")}`);
        return;
      }
      for (const c of changes) console.log(`  ${c}`);
      for (const w of warns) console.log(`  warning: ${w}`);
      if (!changes.length && !warns.length) console.log("  already in sync");
    },
  };
}

/** One sync at a time; a lock older than 2 minutes is stale. */
function withLock(fn) {
  const lock = join(STATE_DIR, "sync.lock");
  mkdirSync(dirname(lock), { recursive: true });
  try { mkdirSync(lock); } catch {
    if (Date.now() - statSync(lock).mtimeMs < 2 * 60 * 1000) return null;
    rmSync(lock, { recursive: true, force: true }); mkdirSync(lock);
  }
  return Promise.resolve().then(fn).finally(() => rmSync(lock, { recursive: true, force: true }));
}

async function sync({ quiet }) {
  const stamp = join(STATE_DIR, "last-sync");
  if (quiet) {
    try { if (Date.now() - Number(readFileSync(stamp, "utf8")) < THROTTLE_MS) return; } catch {}
  }
  await withLock(async () => {
    mkdirSync(dirname(stamp), { recursive: true });
    writeFileSync(stamp, String(Date.now()));
    const pulled = pull(CORE);
    // Reconcile in a fresh process so a pull that changed this code takes effect now.
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "reconcile", ...(quiet ? ["--quiet"] : [])], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
    const out = [...pulled, ...(r.stdout ? [r.stdout.trim()] : [])].filter(Boolean);
    if (quiet) { if (out.length) console.log(`[kesselrunner] ${out.join("; ").replace(/\[kesselrunner\] /g, "")}`); }
    else { for (const p of pulled) console.log(`  ${p}`); if (r.stdout) process.stdout.write(r.stdout); }
  });
}

/**
 * Old layout: ~/.claude was a symlink to the core checkout, so runtime state
 * (sessions, history, transcripts, plugin caches) lives inside the repo dir.
 * Move everything git does not track into a real ~/.claude and drop the link.
 */
function unlinkLegacyClaudeDir(force) {
  let st; try { st = lstatSync(CLAUDE_DIR); } catch { return false; }
  if (!st.isSymbolicLink()) return false;
  const target = realpathSync(CLAUDE_DIR);
  if (!force) {
    let running = "";
    try { running = execFileSync("pgrep", ["-x", "claude"], { encoding: "utf8" }).trim(); } catch {}
    if (running) {
      console.error("Claude Code is running. Quit every Claude Code session first (it writes into ~/.claude), then re-run. --force skips this check.");
      process.exit(1);
    }
  }
  console.log(`converting symlinked ~/.claude (-> ${target}) into a real directory`);
  const tracked = new Set(execFileSync("git", ["-C", target, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean));
  const trackedTop = new Set([...tracked].map((p) => p.split("/")[0]));
  const staging = `${CLAUDE_DIR}.kesselrunner-migrating`;
  mkdirSync(staging);
  const move = (rel) => {
    const from = join(target, rel), to = join(staging, rel);
    mkdirSync(dirname(to), { recursive: true });
    const s = lstatSync(from);
    // Relative links would dangle after the move; re-point them absolutely.
    if (s.isSymbolicLink()) { symlinkSync(resolve(dirname(from), readlinkSync(from)), to); unlinkSync(from); }
    else renameSync(from, to);
    console.log(`  moved ${rel}`);
  };
  for (const name of readdirSync(target)) {
    if (name === ".git") continue;
    if (!trackedTop.has(name)) { move(name); continue; }
    // A partly tracked dir (plugins/, skills/): move the untracked children.
    if (lstatSync(join(target, name)).isDirectory()) {
      for (const child of readdirSync(join(target, name))) {
        const rel = `${name}/${child}`;
        if (![...tracked].some((t) => t === rel || t.startsWith(rel + "/"))) move(rel);
      }
    }
  }
  // settings.json was the live user settings: keep it as the starting point.
  if (existsSync(join(target, "settings.json"))) writeFileSync(join(staging, "settings.json"), readFileSync(join(target, "settings.json")));
  unlinkSync(CLAUDE_DIR);
  renameSync(staging, CLAUDE_DIR);
  return true;
}

async function install() {
  const overlayArg = opt("--overlay");
  const overlay = overlayArg ? resolve(overlayArg.replace(/^~(?=\/)/, homedir())) : undefined;
  if (overlay && !existsSync(overlay)) { console.error(`overlay not found: ${overlay}`); process.exit(1); }
  unlinkLegacyClaudeDir(flag("--force"));
  mkdirSync(CLAUDE_DIR, { recursive: true });
  // Puts `kesselrunner` and `rollcall` on PATH (npm links the folder; updates arrive via git pull).
  try { execFileSync("npm", ["install", "-g", "--silent", CORE], { stdio: "ignore" }); } catch { console.log("  warning: could not put `kesselrunner` on PATH via npm; run it as node <core>/bin/kesselrunner.mjs"); }
  const log = makeLog(false);
  await reconcile({ core: CORE, overlay: overlay ?? readState().overlay ?? null, log });
  log.flush();
  console.log(`\nkesselrunner installed from ${CORE}${overlay ? ` with overlay ${overlay}` : ""}.\nStart a new Claude Code session. Updates arrive automatically; \`kesselrunner sync\` forces one.`);
}

/** Which backend runs the named agents, and for codex which model/effort. `codex` is verified before it is written. */
function delegate(backend) {
  const fail = (msg) => { console.error(msg); process.exit(1); };
  const given = {};
  const args = rest.slice(1);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg !== "--model" && arg !== "--effort") fail(`unknown option "${arg}"`);
    if (backend !== "codex") fail(`${arg} is only valid with \`kesselrunner delegate codex\``);
    if (arg in given) fail(`duplicate option "${arg}"`);
    const value = args[++i];
    if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
    given[arg] = value;
  }
  const current = readDelegation();
  const codexLine = ({ model, effort }) => `model: ${model ?? "(Codex config.toml default)"}, effort: ${effort ?? "(model default)"} - change with kesselrunner delegate codex --model M --effort E; list with kesselrunner delegate models`;

  if (!backend) {
    if (current.backend !== "codex") return console.log("delegation backend: claude (Agent tool)");
    const codex = codexStatus();
    return console.log(`delegation backend: codex (${codex.problem ? `unusable: ${codex.problem}` : codex.version})\n${codexLine(current)}`);
  }
  if (backend === "models") {
    const models = listCodexModels(findCodex());
    if (!models.length) fail(codexStatus().problem ?? "could not read the model catalog (codex debug models)");
    console.log(models.filter((m) => m.listed).map((m) => `${m.slug.padEnd(16)} ${m.name.padEnd(14)} efforts: ${m.efforts.join(", ")} (default ${m.defaultEffort})${m.description ? `\n${"".padEnd(31)}${m.description}` : ""}`).join("\n"));
    return console.log(`\n"default" for --model or --effort clears the override. ${codexLine(current)}`);
  }
  if (!BACKENDS.includes(backend)) fail(`unknown backend "${backend}" (one of ${BACKENDS.join(", ")}, or "models")`);
  if (backend === "claude") {
    writeDelegation({ backend }); // the Codex model pick stays for the next switch back
    return console.log("named agents now run as Claude subagents (the Agent tool). Takes effect in new Claude Code sessions.");
  }

  const codex = codexStatus();
  if (codex.problem) fail(codex.problem);
  const pick = (flag, cur) => (!(flag in given) ? cur : given[flag] === "default" ? undefined : given[flag]);
  const model = pick("--model", current.model), effort = pick("--effort", current.effort);
  if (model || effort) {
    const models = listCodexModels(codex.bin);
    const m = model ? models.find((x) => x.slug === model) : null;
    if (model && models.length && !m) fail(`unknown Codex model "${model}" - see kesselrunner delegate models`);
    const efforts = m?.efforts ?? [...new Set(models.flatMap((x) => x.efforts))];
    if (effort && efforts.length && !efforts.includes(effort)) fail(`effort "${effort}" is not supported by ${model ?? "the configured model"} (${efforts.join(", ")})`);
  }
  writeDelegation({ backend, model, effort });
  console.log(`named agents now run on Codex (${codex.version}) via scripts/delegate/run.mjs. ${codexLine({ model, effort })}\nTakes effect in new Claude Code sessions.`);
}

/** The overlay the last sync recorded, while it still exists. */
function overlayDir() {
  const o = readState().overlay;
  return o && existsSync(o) ? o : null;
}

function rules(action, names) {
  const fail = (msg) => { console.error(msg); process.exit(1); };
  const all = listRules(CORE, overlayDir());
  const on = enabledRules(readSettings().env);
  const offered = all.map((r) => r.name).join(", ") || "none";
  if (!action) {
    if (!all.length) return console.log("neither the core nor the overlay has optional rules");
    console.log(all.map((r) => `${r.name.padEnd(12)} ${on.includes(r.name) ? "on " : "off"}  ${r.description}`).join("\n"));
    return console.log("\nSwitch with kesselrunner rules on|off <name>. Takes effect in new Claude Code sessions.");
  }
  if (action !== "on" && action !== "off") fail(`unknown action "${action}" (kesselrunner rules [on|off <name>...])`);
  if (!names.length) fail(`name a rule: kesselrunner rules ${action} <name> (one of ${offered})`);
  // off also takes a name that is on but no longer offered, so a stale one can be cleared
  const known = new Set([...all.map((r) => r.name), ...(action === "off" ? on : [])]);
  const unknown = names.find((n) => !known.has(n));
  if (unknown) fail(`unknown rule "${unknown}" (one of ${offered})`);
  const next = action === "on" ? [...new Set([...on, ...names])] : on.filter((n) => !names.includes(n));
  // Written even when empty: a recorded choice is what stops an overlay's default from switching a rule back on.
  writeEnv({ [RULES_KEY]: next.join(",") });
  const log = makeLog(false);
  reconcileClaudeMd({ core: CORE, log });
  for (const w of log.warns) console.log(`warning: ${w}`);
  console.log(`rules on: ${next.join(", ") || "(none)"}. Takes effect in new Claude Code sessions.`);
}

function doctor() {
  const state = readState();
  const issues = [];
  let st; try { st = lstatSync(CLAUDE_DIR); } catch {}
  if (!st) issues.push("~/.claude does not exist - run kesselrunner install");
  else if (st.isSymbolicLink()) issues.push("~/.claude is still a symlink - run kesselrunner install");
  if (!state.core) issues.push("never synced - run kesselrunner install");
  const warnings = [];
  const dirty = (() => { try { return execFileSync("git", ["-C", CORE, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(); } catch { return ""; } })();
  // Not broken, just not updatable: a warning, not an issue (expected while developing the core).
  if (dirty) warnings.push(`core checkout has uncommitted changes (sync will not fast-forward until they are committed or stashed):\n${dirty}`);
  for (const kind of ["skills", "agents"]) {
    const dir = join(CLAUDE_DIR, kind);
    if (!existsSync(dir)) continue;
    for (const n of readdirSync(dir)) {
      try { if (lstatSync(join(dir, n)).isSymbolicLink() && !existsSync(join(dir, n))) issues.push(`broken link ${kind}/${n}`); } catch {}
    }
  }
  let settings = null;
  try { settings = readSettings(); } catch (e) { issues.push(`settings.json is invalid (sync will not touch it until fixed): ${e.message}`); }
  if (settings) {
    const have = new Set(Object.values(settings.hooks ?? {}).flat().flatMap((e) => (e.hooks ?? []).map((h) => h.command)));
    for (const c of state.hookCommands ?? []) if (!have.has(c)) issues.push(`hook missing from settings.json: ${c}`);
  }
  // The programs falcon checks for at its start. Sync and the hooks need git, Node and Claude Code;
  // tmux and gh only matter to falcon and the PR steps, so those are warnings here.
  const tools = checkTools().missing;
  for (const m of tools) (["git", "node", "claude"].includes(m.name) ? issues : warnings).push(m.line);
  const want = readJson(join(CORE, "package.json")).kesselrunner?.docsic;
  let docsic = ""; try { docsic = execFileSync("sh", ["-c", "command -v docsic"], { encoding: "utf8" }).trim(); } catch {}
  if (want && !docsic) issues.push(`docsic not on PATH (want ${want})`);
  for (const name of unlinkedCoreBins(CORE)) issues.push(`${name} not on PATH (the global npm link does not point at this core)`);
  const { backend } = readDelegation(settings ?? {});
  const own = agentOverrides(backend).map((o) => `${o.name} on ${o.backend}`);
  const codex = backend === "codex" || own.some((o) => o.endsWith(" on codex")) ? codexStatus() : null;
  if (codex?.problem) issues.push(`${backend === "codex" ? "delegation backend is codex" : "an agent's frontmatter picks codex"} but ${codex.problem}`);
  const rulesOn = enabledRules(settings?.env);
  const offered = new Set(listRules(CORE, overlayDir()).map((r) => r.name));
  for (const name of rulesOn) if (!offered.has(name)) issues.push(`rule "${name}" is switched on but in neither the core nor the overlay - run kesselrunner rules off ${name}`);
  console.log(`core: ${CORE}\noverlay: ${state.overlay ?? "(none)"}\nlast sync: ${state.lastSync ?? "never"}\nmigrations: ${(state.migrations ?? []).join(", ") || "(none)"}\ndelegation: ${backend}${codex && !codex.problem ? ` (${codex.version})` : ""}${own.length ? `; by their own frontmatter: ${own.join(", ")}` : ""}\nrules: ${rulesOn.join(", ") || "(none)"}\ntools: ${tools.length ? `${tools.length} missing (below)` : `git, tmux, Claude Code, gh (logged in), Node ${process.versions.node}`}`);
  if (warnings.length) console.log(`\n${warnings.map((w) => `warning: ${w}`).join("\n")}`);
  console.log(issues.length ? `\n${issues.map((i) => `- ${i}`).join("\n")}\n\nMost of these are fixed by: kesselrunner sync` : "\nno issues");
  process.exitCode = issues.length ? 1 : 0;
}

// State from before the rename moves first, so nothing below reads or writes the old dir (doctor only reads, and readState falls back).
if (!["doctor", "help", "reconcile"].includes(cmd)) carryLegacyState(); // reconcile carries (and reports) it itself

switch (cmd) {
  case "install": await install(); break;
  case "sync": await sync({ quiet: flag("--quiet") }); break;
  case "reconcile": { // internal: the post-pull half of sync, run in a fresh process
    const log = makeLog(flag("--quiet"));
    try { await reconcile({ core: CORE, log }); } catch (e) { log.warn(`reconcile failed: ${e.message}`); }
    log.flush();
    break;
  }
  case "doctor": doctor(); break;
  case "delegate":
    try { delegate(rest[0]); } catch (error) { console.error(`[kesselrunner] ${error.message}`); process.exitCode = 1; }
    break;
  case "rules":
    try { rules(rest[0], rest.slice(1)); } catch (error) { console.error(`[kesselrunner] ${error.message}`); process.exitCode = 1; }
    break;
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 9).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
