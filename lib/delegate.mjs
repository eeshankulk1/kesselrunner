// Delegation backend: which harness runs the named agents (code-reviewer,
// test-runner, ...) that skills hand work to. "claude" = the Agent tool (the
// default); "codex" = `codex exec` on the user's ChatGPT/Codex plan, driven by
// scripts/delegate/run.mjs. The choice (and the Codex model/effort) lives in
// ~/.claude/settings.json under env, so it is also visible in Bash as
// $KESSELRUNNER_DELEGATE / $KESSELRUNNER_CODEX_MODEL / $KESSELRUNNER_CODEX_EFFORT.
// The DOTCLAUDE_* names from before the rename are still read when the new one is absent.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { knob, legacyKey } from "./legacy.mjs";
import { CLAUDE_DIR, isObj, readJsonObject, sh, writeJson } from "./reconcile.mjs";

export const BACKENDS = ["claude", "codex"];
const KEYS = { backend: "KESSELRUNNER_DELEGATE", model: "KESSELRUNNER_CODEX_MODEL", effort: "KESSELRUNNER_CODEX_EFFORT" };
const SHORT = { backend: "DELEGATE", model: "CODEX_MODEL", effort: "CODEX_EFFORT" };
const SETTINGS = join(CLAUDE_DIR, "settings.json");
const APP_BUNDLE_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";

/** settings.json, strictly: throws rather than letting a caller overwrite a file it could not parse. */
export function readSettings() {
  const settings = readJsonObject(SETTINGS);
  if (settings.env !== undefined && !isObj(settings.env)) throw new Error(`${SETTINGS}: env must be a JSON object`);
  return settings;
}

/** { backend, model, effort }: the live env wins over settings.json; unreadable settings count as unset. */
export function readDelegation(settings) {
  let env = {};
  try { env = (settings ?? readSettings()).env ?? {}; } catch {}
  const get = (key) => knob(SHORT[key]) || knob(SHORT[key], env) || undefined;
  const backend = [knob(SHORT.backend), knob(SHORT.backend, env)].find((b) => BACKENDS.includes(b)) ?? "claude";
  return { backend, model: get("model"), effort: get("effort") };
}

/** Sets settings.json env keys ({ NAME: value }) in one pass; an undefined value removes its key. A KESSELRUNNER_* key's old DOTCLAUDE_* twin goes either way. */
export function writeEnv(updates) {
  const settings = readSettings();
  const env = { ...(settings.env ?? {}) };
  for (const [name, value] of Object.entries(updates)) {
    if (value === undefined) delete env[name]; else env[name] = value;
    if (legacyKey(name)) delete env[legacyKey(name)];
  }
  if (Object.keys(env).length) settings.env = env; else delete settings.env;
  writeJson(SETTINGS, settings);
}

/** Writes the given keys ({ backend?, model?, effort? }) in one pass; undefined (or backend "claude") removes a key. */
export function writeDelegation(updates) {
  writeEnv(Object.fromEntries(Object.entries(updates).map(([key, value]) => [KEYS[key], (key === "backend" && value === "claude") || !value ? undefined : value])));
}

/** The Codex CLI: $KESSELRUNNER_CODEX_BIN / $CODEX_CLI_PATH, then PATH, then the ChatGPT desktop app bundle. */
export function findCodex() {
  const fromEnv = [knob("CODEX_BIN"), process.env.CODEX_CLI_PATH].find((c) => c && existsSync(c));
  if (fromEnv) return fromEnv;
  let onPath = null;
  try { onPath = sh("sh", ["-c", "command -v codex"]); } catch {}
  return [onPath, APP_BUNDLE_CODEX, join(homedir(), ".codex", "bin", "codex")].find((c) => c && existsSync(c)) ?? null;
}

/** { bin, version, problem }: problem is null when the codex backend can run, else a one-line reason. */
export function codexStatus() {
  const bin = findCodex();
  if (!bin) return { bin, version: null, problem: "Codex CLI not found (install the ChatGPT desktop app or `npm i -g @openai/codex`, or set KESSELRUNNER_CODEX_BIN)" };
  // `codex login status` reports on stderr and exits non-zero when logged out.
  const r = spawnSync(bin, ["login", "status"], { encoding: "utf8", timeout: 15_000 });
  if (r.error) return { bin, version: null, problem: `Codex CLI could not run (${r.error.message})` };
  const status = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
  if (!/logged in/i.test(status) || /not logged in/i.test(status)) {
    return { bin, version: null, problem: `Codex is not logged in (${status.split("\n")[0] || "unknown"}) - run \`${bin} login\`` };
  }
  let version = "codex";
  try { version = sh(bin, ["--version"], { timeout: 10_000 }); } catch {}
  return { bin, version, problem: null };
}

/** Codex's model catalog: [{ slug, name, description, efforts, defaultEffort, listed }]; empty when the CLI cannot render it. */
export function listCodexModels(bin = findCodex()) {
  if (!bin) return [];
  try {
    const raw = JSON.parse(sh(bin, ["debug", "models"], { timeout: 20_000 }));
    return (Array.isArray(raw) ? raw : raw.models ?? []).map((m) => ({
      slug: m.slug, name: m.display_name || m.slug, description: m.description || "",
      efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort ?? l),
      defaultEffort: m.default_reasoning_level, listed: m.visibility !== "hide",
    })).filter((m) => m.slug);
  } catch { return []; }
}
