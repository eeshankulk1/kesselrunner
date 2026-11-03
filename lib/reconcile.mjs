// Brings ~/.claude in line with the kesselrunner core (+ the optional personal
// overlay). Idempotent: running it twice changes nothing the second time.
// ~/.claude stays the user's own directory - kesselrunner only ever touches:
//   - symlinks it created in skills/ and agents/, and ~/.claude/kesselrunner -> core
//   - the marked block in CLAUDE.md
//   - settings.json keys it applied (a key the user changed since is left alone)
//   - hook entries it owns
//   - the docsic install, its MCP registration, and ~/.docsic/config.json keys it applied
//   - the global npm link of the core that puts its bins (kesselrunner, rollcall) on PATH
//   - on macOS, the kesselrunner Copy app behind the clickable mod's copy links
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preToolMatcher } from "./guards.mjs";
import { LEGACY_NAME } from "./legacy.mjs";
import { enabledRules, listRules, ruleSection } from "./rules.mjs";
import { ensureCopyHelper } from "../scripts/copy-helper/install.mjs";

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const STATE_DIR = join(CLAUDE_DIR, ".kesselrunner");
export const STATE_PATH = join(STATE_DIR, "state.json");
// Where state lived before the rename; carryLegacyState moves it.
const LEGACY_STATE_DIR = join(CLAUDE_DIR, `.${LEGACY_NAME}`);
const DOCSIC_PKG = "@eeshkulk/docsic";

export function readJson(p, fallback = {}) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
}
/**
 * For user-owned object files (settings.json): {} when the file is missing,
 * but throws when it exists and cannot be parsed or is not an object, so a
 * caller never "repairs" a file it could not read by overwriting it.
 */
export function readJsonObject(p) {
  let raw;
  try { raw = readFileSync(p, "utf8"); } catch (e) { if (e.code === "ENOENT") return {}; throw e; }
  let v;
  try { v = JSON.parse(raw); } catch (e) { throw new Error(`cannot parse ${p}: ${e.message}`); }
  if (!isObj(v)) throw new Error(`${p} must contain a JSON object`);
  return v;
}
export function writeJson(p, v) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
}
export function readState() { return readJson(STATE_PATH, null) ?? readJson(join(LEGACY_STATE_DIR, "state.json"), {}); }
export function writeState(s) { writeJson(STATE_PATH, s); }

/**
 * Moves ~/.claude/.dotclaude (state from before the rename: applied keys, hook
 * ownership, migrations run) into ~/.claude/.kesselrunner. Runs before anything
 * reads or writes state. sync.lock stays: the old sync process that may have
 * started this one still holds it, and removes it itself. An entry the new dir
 * already has wins. The old dir goes once it is empty.
 */
export function carryLegacyState() {
  let names; try { names = readdirSync(LEGACY_STATE_DIR); } catch { return false; }
  mkdirSync(STATE_DIR, { recursive: true });
  let moved = false;
  for (const name of names) {
    if (name === "sync.lock") continue;
    const from = join(LEGACY_STATE_DIR, name), to = join(STATE_DIR, name);
    if (existsSync(to)) rmSync(from, { recursive: true, force: true });
    else { renameSync(from, to); moved = true; }
  }
  try { rmdirSync(LEGACY_STATE_DIR); } catch {}
  return moved;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const inside = (p, root) => !!root && (p === root || p.startsWith(root + "/"));

export function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

/** {{KESSELRUNNER}} (or its old name {{DOTCLAUDE}}, which an overlay may still use) -> core dir, {{OVERLAY}} -> overlay dir (empty without one), {{DOCSIC}} -> docsic bin, {{PRE_TOOL_MATCHER}} -> the PreToolUse matcher, in any string of a JSON value or text. */
function substitute(v, vars) {
  if (typeof v === "string") return v.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  if (Array.isArray(v)) return v.map((x) => substitute(x, vars));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, vars)]));
  return v;
}

function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in a ? deepMerge(a[k], v) : v;
  return out;
}

// ---------------------------------------------------------------- links

/**
 * Symlink every entry of each source dir into dest. A same-named entry that is
 * not a kesselrunner link belongs to the user and is never replaced. Links into a
 * managed root whose target is gone (or no longer offered) are pruned.
 */
function linkAll(sources, dest, roots, filter, log) {
  mkdirSync(dest, { recursive: true });
  const wanted = new Map();
  for (const src of sources) {
    if (!src || !existsSync(src)) continue;
    for (const name of readdirSync(src)) if (!name.startsWith(".") && filter(name)) wanted.set(name, join(src, name)); // later sources win
  }
  for (const [name, target] of wanted) {
    const p = join(dest, name);
    let st = null;
    try { st = lstatSync(p); } catch {}
    if (st && !st.isSymbolicLink()) { log.warn(`${p} is your own file; not linking kesselrunner's ${name}`); continue; }
    if (st) {
      const cur = resolve(dest, readlinkSync(p));
      if (cur === target) continue;
      if (!roots.some((r) => inside(cur, r))) { log.warn(`${p} links somewhere else; not replacing`); continue; }
      unlinkSync(p);
    }
    symlinkSync(target, p);
    log.change(`linked ${name}`);
  }
  for (const name of readdirSync(dest)) {
    const p = join(dest, name);
    let st; try { st = lstatSync(p); } catch { continue; }
    if (!st.isSymbolicLink()) continue;
    const cur = resolve(dest, readlinkSync(p));
    if (roots.some((r) => inside(cur, r)) && wanted.get(name) !== cur) { unlinkSync(p); log.change(`unlinked ${name}`); }
  }
}

// ---------------------------------------------------------------- settings

/**
 * "Defaults the user can override": a desired value is written when the key is
 * absent or still holds what kesselrunner applied last time. Objects are handled
 * one level down (enabledPlugins.x, autoMode.environment) so a user's own
 * plugin or env var never blocks kesselrunner's. Keys kesselrunner stops wanting are
 * removed only if untouched.
 */
function applyDefaults(target, desired, applied, log, label) {
  let changed = false;
  const leaves = {};
  for (const [k, v] of Object.entries(desired)) {
    if (k === "hooks") continue;
    if (isObj(v)) for (const [k2, v2] of Object.entries(v)) leaves[`${k}\u0000${k2}`] = v2;
    else leaves[k] = v;
  }
  const get = (path) => { const [a, b] = path.split("\u0000"); return b === undefined ? target[a] : target[a]?.[b]; };
  const set = (path, v) => {
    const [a, b] = path.split("\u0000");
    if (b === undefined) { if (v === undefined) delete target[a]; else target[a] = v; return; }
    if (v === undefined) { if (isObj(target[a])) { delete target[a][b]; if (!Object.keys(target[a]).length) delete target[a]; } return; }
    if (!isObj(target[a])) target[a] = {};
    target[a][b] = v;
  };
  for (const [path, v] of Object.entries(leaves)) {
    const cur = get(path);
    if (same(cur, v)) { applied[path] = v; continue; }
    if (cur === undefined || (path in applied && same(cur, applied[path]))) {
      set(path, v); applied[path] = v; changed = true;
      log.change(`${label}: set ${path.replace("\u0000", ".")}`);
    }
  }
  for (const path of Object.keys(applied)) {
    if (path in leaves) continue;
    if (same(get(path), applied[path])) { set(path, undefined); changed = true; log.change(`${label}: removed ${path.replace("\u0000", ".")}`); }
    delete applied[path];
  }
  return changed;
}

const hookCommands = (hooks) => Object.values(hooks ?? {}).flat().flatMap((e) => (e.hooks ?? []).map((h) => h.command));

/** Hook entries are owned wholesale: drop every command kesselrunner added before, then add the current set. */
function applyHooks(settings, desired, state, log) {
  const owned = new Set([...(state.hookCommands ?? []), ...hookCommands(desired)]);
  const before = JSON.stringify(settings.hooks ?? {});
  const hooks = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    const kept = entries.map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !owned.has(h.command)) })).filter((e) => e.hooks.length);
    if (kept.length) hooks[event] = kept;
  }
  for (const [event, entries] of Object.entries(desired ?? {})) hooks[event] = [...(hooks[event] ?? []), ...entries];
  state.hookCommands = hookCommands(desired);
  if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
  if (JSON.stringify(settings.hooks ?? {}) !== before) { log.change("settings: hooks updated"); return true; }
  return false;
}

// ---------------------------------------------------------------- CLAUDE.md

const BEGIN = "<!-- kesselrunner:begin - generated by `kesselrunner sync` from the kesselrunner core and your overlay. Edits inside this block are overwritten; write your own instructions after the end marker. -->";
const END = "<!-- kesselrunner:end -->";
// The markers before the rename: a block between them is replaced, never kept beside the new one.
const MARKERS = [["<!-- kesselrunner:begin", END], [`<!-- ${LEGACY_NAME}:begin`, `<!-- ${LEGACY_NAME}:end -->`]];

/** The optional rules that are switched on, as CLAUDE.md sections; a name the core has no file for is skipped with a warning. */
function ruleSections(core, overlay, settings, log) {
  const on = enabledRules(settings.env);
  const rules = listRules(core, overlay);
  for (const name of on) if (!rules.some((r) => r.name === name)) log.warn(`rule "${name}" is switched on but in neither the core nor the overlay (kesselrunner rules off ${name})`);
  return rules.filter((r) => on.includes(r.name)).map(ruleSection);
}

/** The block is the core's instructions, then the optional rules that are on, then the overlay's. */
function applyClaudeMd(core, overlay, rules, vars, log) {
  const read = (p) => (p && existsSync(p) ? readFileSync(p, "utf8").trim() : null);
  const parts = [read(join(core, "CLAUDE.md")), ...rules, read(overlay && join(overlay, "CLAUDE.md"))].filter((t) => t !== null);
  const block = `${BEGIN}\n\n${substitute(parts.join("\n\n"), vars)}\n\n${END}`;
  const p = join(CLAUDE_DIR, "CLAUDE.md");
  const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
  let next = cur.trim() ? `${block}\n\n${cur}` : `${block}\n`;
  for (const [b, e] of MARKERS) {
    const i = cur.indexOf(b), j = cur.indexOf(e, i);
    if (i >= 0 && j > i) { next = cur.slice(0, i) + block + cur.slice(j + e.length); break; }
  }
  if (next === cur) return;
  writeFileSync(p, next);
  log.change("CLAUDE.md: block updated");
}

// ---------------------------------------------------------------- docsic

let npmPrefix;
const globalBinDir = () => {
  if (npmPrefix === undefined) { try { npmPrefix = sh("npm", ["prefix", "-g"]); } catch { npmPrefix = null; } }
  return npmPrefix && join(npmPrefix, "bin");
};

function docsicBin() {
  const dir = globalBinDir();
  return dir && existsSync(join(dir, "docsic")) ? join(dir, "docsic") : null;
}

/** Names in the core's package.json `bin` that the global npm bin dir does not link to this core. */
export function unlinkedCoreBins(core) {
  const dir = globalBinDir();
  if (!dir) return [];
  const real = (p) => { try { return realpathSync(p); } catch { return null; } };
  return Object.entries(readJson(join(core, "package.json")).bin ?? {})
    .filter(([name, rel]) => real(join(dir, name)) !== real(join(core, rel)))
    .map(([name]) => name);
}

/** Puts every core bin on PATH: `npm install -g <core>` links the folder, so later git pulls update them in place. */
function ensureCoreBins(core, log) {
  const missing = unlinkedCoreBins(core);
  if (!missing.length) return;
  try {
    sh("npm", ["install", "-g", "--silent", core], { timeout: 60_000 });
    log.change(`linked ${missing.join(", ")} onto PATH`);
  } catch { log.warn(`could not link ${missing.join(", ")} onto PATH via npm install -g`); }
}

/** Installs the pinned docsic globally and registers its MCP server with Claude Code. */
function ensureDocsic(version, log) {
  let installed = null;
  try { installed = JSON.parse(sh("npm", ["ls", "-g", DOCSIC_PKG, "--json", "--depth=0"])).dependencies?.[DOCSIC_PKG]?.version ?? null; } catch {}
  if (installed !== version) {
    try {
      sh("npm", ["install", "-g", `${DOCSIC_PKG}@${version}`], { timeout: 180_000 });
      log.change(`docsic ${installed ?? "(none)"} -> ${version}`);
    } catch (e) { log.warn(`could not install ${DOCSIC_PKG}@${version}: ${String(e.stderr || e.message).split("\n")[0]}`); }
  }
  const bin = docsicBin();
  if (!bin) return "docsic";
  try { sh("claude", ["mcp", "get", "docsic"]); } catch {
    try { sh("claude", ["mcp", "add", "--scope", "user", "docsic", "--", bin, "serve"]); log.change("registered docsic MCP server with Claude Code"); }
    catch { log.warn("could not register the docsic MCP server (is the claude CLI on PATH?)"); }
  }
  return bin;
}

// ---------------------------------------------------------------- migrations

/** migrations/NNN-name.mjs run once each, in order; the applied list lives in state. */
async function runMigrations(core, overlay, state, log) {
  const dir = join(core, "migrations");
  if (!existsSync(dir)) return;
  state.migrations = state.migrations ?? [];
  for (const f of readdirSync(dir).filter((f) => /^\d+-.*\.mjs$/.test(f)).sort()) {
    const id = f.replace(/\.mjs$/, "");
    if (state.migrations.includes(id)) continue;
    try {
      const mod = await import(pathToFileURL(join(dir, f)).href);
      await mod.default({ claudeDir: CLAUDE_DIR, core, overlay, state, readJson, writeJson, sh, log });
      state.migrations.push(id);
      log.change(`migration ${id}`);
    } catch (e) {
      log.warn(`migration ${id} failed, will retry next sync: ${e.message}`);
      return; // later migrations may depend on this one
    }
  }
}

// ---------------------------------------------------------------- entry

export async function reconcile({ core, overlay, log }) {
  if (carryLegacyState()) log.change(`moved ~/.claude/.${LEGACY_NAME} to ~/.claude/.kesselrunner`);
  const state = readState();
  // Links into a previous core/overlay location are ours too (the core moved, e.g. a re-clone).
  const previous = [state.core, state.overlay].filter(Boolean);
  state.core = core;
  if (overlay !== undefined) state.overlay = overlay;
  overlay = state.overlay && existsSync(state.overlay) ? state.overlay : null;
  const manifest = readJson(join(core, "package.json")).kesselrunner ?? {};

  await runMigrations(core, overlay, state, log);

  const roots = [...new Set([core, overlay, ...previous].filter(Boolean))];
  // ~/.claude/kesselrunner -> core: a stable path for skills and agents to cite core docs and scripts.
  const coreLink = join(CLAUDE_DIR, "kesselrunner");
  let cl = null; try { cl = lstatSync(coreLink); } catch {}
  if (!cl || (cl.isSymbolicLink() && readlinkSync(coreLink) !== core)) {
    if (cl) unlinkSync(coreLink);
    symlinkSync(core, coreLink);
    log.change("linked ~/.claude/kesselrunner");
  }
  // ~/.claude/dotclaude, the link's name before the rename, which older files still cite: kept, pointing at the new one.
  const legacyLink = join(CLAUDE_DIR, LEGACY_NAME);
  let ll = null; try { ll = lstatSync(legacyLink); } catch {}
  if (ll?.isSymbolicLink() && readlinkSync(legacyLink) !== "kesselrunner") {
    unlinkSync(legacyLink);
    symlinkSync("kesselrunner", legacyLink);
    log.change(`linked ~/.claude/${LEGACY_NAME} -> kesselrunner`);
  }
  linkAll([join(core, "skills"), overlay && join(overlay, "skills")], join(CLAUDE_DIR, "skills"), roots, () => true, log);
  linkAll([join(core, "agents"), overlay && join(overlay, "agents")], join(CLAUDE_DIR, "agents"), roots, (n) => n.endsWith(".md"), log);

  const vars = {
    KESSELRUNNER: core, DOTCLAUDE: core,
    OVERLAY: overlay ?? "",
    DOCSIC: manifest.docsic ? ensureDocsic(manifest.docsic, log) : "docsic",
    PRE_TOOL_MATCHER: await preToolMatcher(core, overlay),
  };
  ensureCoreBins(core, log);
  ensureCopyHelper(log);

  const settingsPath = join(CLAUDE_DIR, "settings.json");
  const settings = readJsonObject(settingsPath); // a malformed settings.json aborts the sync instead of being replaced
  const desired = substitute(deepMerge(readJson(join(core, "settings.core.json")), overlay ? readJson(join(overlay, "settings.json")) : {}), vars);
  state.applied = state.applied ?? {};
  const a = applyHooks(settings, desired.hooks, state, log);
  const b = applyDefaults(settings, desired, state.applied, log, "settings");
  if (a || b) writeJson(settingsPath, settings);

  const docsicPath = join(process.env.DOCSIC_HOME || join(homedir(), ".docsic"), "config.json");
  const docsicCfg = readJson(docsicPath, {});
  const docsicDesired = deepMerge(manifest.docsicConfig ?? {}, overlay ? readJson(join(overlay, "docsic.json")) : {});
  state.docsicApplied = state.docsicApplied ?? {};
  if (applyDefaults(docsicCfg, docsicDesired, state.docsicApplied, log, "docsic config")) writeJson(docsicPath, docsicCfg);

  applyClaudeMd(core, overlay, ruleSections(core, overlay, settings, log), vars, log);

  state.lastSync = new Date().toISOString();
  writeState(state);
}

/** The CLAUDE.md step of reconcile on its own: what `kesselrunner rules on|off` re-applies, with no pull and nothing else touched. */
export function reconcileClaudeMd({ core, log }) {
  const state = readState();
  const overlay = state.overlay && existsSync(state.overlay) ? state.overlay : null;
  const manifest = readJson(join(core, "package.json")).kesselrunner ?? {};
  const vars = { KESSELRUNNER: core, DOTCLAUDE: core, OVERLAY: overlay ?? "", DOCSIC: (manifest.docsic && docsicBin()) || "docsic" };
  applyClaudeMd(core, overlay, ruleSections(core, overlay, readJsonObject(join(CLAUDE_DIR, "settings.json")), log), vars, log);
}
