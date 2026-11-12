// Effort levels: which ones each harness and each model takes, and the level a session runs on when no one picks
// one. Claude Code's levels per model come from its own model list (the `initialize` control request's `models`),
// which the agent host reads from a session it runs and keeps in `_machine/claude-models.json`; Codex's from its
// app server's `model/list` (host/chat.mjs refreshCodexModels, `_machine/codex-models.json`). Until a list has been
// read, a fallback stands in.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as store from "../store.mjs";

/** Claude Code's effort levels, lowest first (`--effort`, settings `effortLevel`). */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Codex's reasoning efforts, lowest first (`model_reasoning_effort`, `turn/start`'s `effort`). Codex has no `max`. */
export const CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
/** The levels a Codex model takes before Codex's own list has been read. */
const CODEX_FALLBACK = ["low", "medium", "high"];
/** What Claude Code's aliases resolve to, until its own list has been read: settings' modelSettings name the resolved id. */
const CLAUDE_RESOLVED = { fable: "claude-fable-5-2", opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };

/** The levels harness `h` takes at all, lowest first. */
export const effortsOf = (h) => (h === "codex" ? CODEX_EFFORTS : CLAUDE_EFFORTS);
/** Whether `e` is a level harness `h` takes. */
export const effortOk = (e, h = "claude") => typeof e === "string" && effortsOf(h).includes(e);

/**
 * `level` on a model that takes `efforts`: itself when it takes it, else the highest it takes below it (as Claude
 * Code does on a model switch), else its lowest; null when it takes none, or for no level.
 */
export function clampEffort(level, efforts, h = "claude") {
  if (!level || !efforts?.length) return null;
  if (efforts.includes(level)) return level;
  const order = effortsOf(h);
  const at = order.indexOf(level);
  const below = efforts.filter((e) => order.indexOf(e) < at);
  return below.length ? below.at(-1) : efforts[0];
}

/** `list` in harness `h`'s order, unknown levels left out. */
const ordered = (list, h) => effortsOf(h).filter((e) => list.includes(e));

// ---------------------------------------------------------------- Claude Code

/** How long a read of Claude Code's models lasts before the host reads them again. */
export const CLAUDE_MODELS_TTL = 6 * 3600_000;

/** Claude Code's models as a session last listed them, or null before the first read. */
export function claudeModels() {
  const c = store.readMachineFile("claude-models");
  return Array.isArray(c?.models) && c.models.length ? c.models : null;
}

/** Whether the host should read Claude Code's models again (none read, or the last read is older than the TTL). */
export function claudeModelsStale(now = Date.now()) {
  const c = store.readMachineFile("claude-models");
  return !(c?.at && Array.isArray(c.models) && c.models.length && now - c.at < CLAUDE_MODELS_TTL);
}

/**
 * Keeps Claude Code's model list (the `initialize` answer's `models`: `value`, `resolvedModel`, `displayName`,
 * `supportedEffortLevels`) as { id, resolved, label, efforts }. Returns the list, or null when it had none.
 */
export function rememberClaudeModels(raw, now = Date.now()) {
  if (!Array.isArray(raw)) return null;
  const models = raw
    .filter((m) => m && typeof m.value === "string")
    .map((m) => ({
      id: m.value, resolved: typeof m.resolvedModel === "string" ? m.resolvedModel : m.value, label: typeof m.displayName === "string" ? m.displayName : m.value,
      efforts: Array.isArray(m.supportedEffortLevels) ? ordered(m.supportedEffortLevels, "claude") : [],
    }));
  if (!models.length) return null;
  store.updateMachineFile("claude-models", () => ({ value: { at: now, models }, out: null }));
  return models;
}

/** Claude Code's entry for `model` (an alias, an id, or an id with a context suffix like `[1m]`), or null. */
function claudeEntry(model) {
  const list = claudeModels();
  if (!list) return null;
  const m = String(model ?? "default");
  const find = (x) => list.find((e) => e.id === x) ?? list.find((e) => e.resolved === x) ?? null;
  return find(m) ?? find(m.replace(/\[[^\]]*\]$/, ""));
}

/** The levels Claude model `model` takes: Claude Code's list says; a model it did not list, or before a read, takes all. */
export const claudeEfforts = (model) => claudeEntry(model)?.efforts ?? CLAUDE_EFFORTS;

/** The owner's Claude Code user settings (`settings.json` in CLAUDE_CONFIG_DIR, else ~/.claude). */
function claudeSettings(env) {
  try { return JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json"), "utf8")) ?? {}; } catch { return {}; }
}

/**
 * The level a new Claude session on `model` runs on when no one picks one, as Claude Code resolves it:
 * CLAUDE_CODE_EFFORT_LEVEL, else the owner's settings `modelSettings[<model>].effortLevel`, else `effortLevel`,
 * clamped to what the model takes. Claude Code does not say a model's own default, so with none of those it is null.
 */
export function claudeDefaultEffort(model, env = process.env) {
  const efforts = claudeEfforts(model);
  if (!efforts.length) return null;
  if (effortOk(env.CLAUDE_CODE_EFFORT_LEVEL, "claude")) return clampEffort(env.CLAUDE_CODE_EFFORT_LEVEL, efforts);
  const s = claudeSettings(env);
  const per = s.modelSettings && typeof s.modelSettings === "object" ? s.modelSettings : {};
  const m = String(model ?? "default");
  const resolved = claudeEntry(m)?.resolved ?? CLAUDE_RESOLVED[m] ?? m;
  const level = [per[resolved]?.effortLevel, per[m]?.effortLevel, s.effortLevel].find((e) => effortOk(e, "claude"));
  return clampEffort(level, efforts);
}

// ---------------------------------------------------------------- Codex

/** Codex's entry for `model` (null: its default, listed first) in `_machine/codex-models.json`, or null. */
function codexEntry(model) {
  const list = store.readMachineFile("codex-models")?.models;
  if (!Array.isArray(list) || !list.length) return null;
  return model ? list.find((e) => e.id === model) ?? null : list[0];
}

/** The levels Codex model `model` takes: Codex's own list says, else the fallback. */
export function codexEfforts(model) {
  const e = codexEntry(model)?.efforts;
  return Array.isArray(e) ? e : CODEX_FALLBACK;
}

/**
 * The level a new Codex session on `model` runs on when no one picks one: ROLLCALL_CODEX_EFFORT (clamped to what the
 * model takes), else Codex's `defaultReasoningEffort` for it; null when unknown.
 */
export function codexDefaultEffort(model, env = process.env) {
  const efforts = codexEfforts(model);
  if (!efforts.length) return null;
  if (effortOk(env.ROLLCALL_CODEX_EFFORT, "codex")) return clampEffort(env.ROLLCALL_CODEX_EFFORT, efforts, "codex");
  const d = codexEntry(model)?.defaultEffort;
  return effortOk(d, "codex") ? d : null;
}

/** Codex's `model/list` reasoning efforts (objects with `reasoningEffort`, or plain names), in Codex's order. */
export const codexListEfforts = (list) => (Array.isArray(list) ? ordered(list.map((x) => (typeof x === "string" ? x : x?.reasoningEffort)), "codex") : null);

// ---------------------------------------------------------------- either

/** The levels `model` takes on harness `h`, lowest first (`[]`: none). */
export const effortsFor = (h, model) => (h === "codex" ? codexEfforts(model) : claudeEfforts(model));
/** The level a new session on `model` runs on with none picked, or null. */
export const defaultEffortFor = (h, model, env = process.env) => (h === "codex" ? codexDefaultEffort(model, env) : claudeDefaultEffort(model, env));
