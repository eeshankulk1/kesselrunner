// The harness was called dotclaude; it is kesselrunner now. reconcile has already
// moved ~/.claude/.dotclaude to ~/.claude/.kesselrunner (carryLegacyState, before
// state is read), replaced the old CLAUDE.md block, swapped the hook commands it
// owns and pointed ~/.claude/dotclaude at ~/.claude/kesselrunner. This carries
// what needs the user's own choices kept:
//   1. the global npm link: the old package name owns the bins, so npm would refuse
//      to link the new one over them; unlink it and reconcile links kesselrunner
//   2. the mods: <mod>@dotclaude -> <mod>@kesselrunner with the user's on/off kept,
//      and the dotclaude marketplace dropped (settings.json and Claude Code's registry)
//   3. env: each DOTCLAUDE_* key the user set (not one sync applied) gets its
//      KESSELRUNNER_* twin; the old key goes only when the new one holds the same value
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { ENV_PREFIX, LEGACY_ENV_PREFIX, LEGACY_NAME } from "../lib/legacy.mjs";
import { isObj, readJsonObject } from "../lib/reconcile.mjs";

const NEW = "kesselrunner";
const LEAF = "\u0000"; // how state.applied joins an object key and its child (applyDefaults)

export default function ({ claudeDir, state, readJson, writeJson, sh, log }) {
  // 1. npm: <root>/dotclaude is a link to this core when `npm install -g <core>` put it there.
  let root = null;
  try { root = sh("npm", ["root", "-g"]); } catch {}
  if (root) {
    let st = null; try { st = lstatSync(join(root, LEGACY_NAME)); } catch {}
    if (st?.isSymbolicLink()) {
      try { sh("npm", ["uninstall", "-g", "--silent", LEGACY_NAME], { timeout: 60_000 }); log.change(`unlinked the ${LEGACY_NAME} npm package (kesselrunner takes its bins)`); }
      catch (e) { log.warn(`could not unlink the ${LEGACY_NAME} npm package: ${String(e.stderr || e.message).split("\n")[0]}`); }
    }
  }

  const p = join(claudeDir, "settings.json");
  const s = readJsonObject(p); // throws on a malformed file: this migration then retries next sync
  const applied = (state.applied ??= {});
  let changed = false;
  const renameApplied = (from, to) => {
    if (!(from in applied)) return;
    if (!(to in applied)) applied[to] = applied[from];
    delete applied[from];
  };

  // 2. Mods: the value the user has (true, or false for one switched off) moves with the key.
  if (isObj(s.enabledPlugins)) {
    for (const key of Object.keys(s.enabledPlugins)) {
      const m = key.match(new RegExp(`^(.+)@${LEGACY_NAME}$`));
      if (!m) continue;
      const next = `${m[1]}@${NEW}`;
      if (!(next in s.enabledPlugins)) s.enabledPlugins[next] = s.enabledPlugins[key];
      delete s.enabledPlugins[key];
      renameApplied(`enabledPlugins${LEAF}${key}`, `enabledPlugins${LEAF}${next}`);
      changed = true;
      log.change(`settings: ${key} -> ${next}`);
    }
  }
  for (const key of Object.keys(applied)) {
    const m = key.match(new RegExp(`^enabledPlugins${LEAF}(.+)@${LEGACY_NAME}$`));
    if (m) renameApplied(key, `enabledPlugins${LEAF}${m[1]}@${NEW}`);
  }
  if (isObj(s.extraKnownMarketplaces) && LEGACY_NAME in s.extraKnownMarketplaces) {
    delete s.extraKnownMarketplaces[LEGACY_NAME];
    if (!Object.keys(s.extraKnownMarketplaces).length) delete s.extraKnownMarketplaces;
    changed = true;
    log.change(`settings: removed extraKnownMarketplaces.${LEGACY_NAME}`);
  }
  delete applied[`extraKnownMarketplaces${LEAF}${LEGACY_NAME}`];

  // 3. Env: a key sync applied (an overlay default) is left to applyDefaults, which follows the overlay.
  if (isObj(s.env)) {
    for (const [key, value] of Object.entries(s.env)) {
      if (!key.startsWith(LEGACY_ENV_PREFIX) || `env${LEAF}${key}` in applied) continue;
      const next = ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length);
      if (!(next in s.env)) { s.env[next] = value; changed = true; log.change(`settings: env.${key} -> env.${next}`); }
      if (s.env[next] === value) { delete s.env[key]; changed = true; }
      else log.warn(`settings: env.${key} and env.${next} differ; ${next} wins, ${key} is left for you to remove`);
    }
  }
  if (changed) writeJson(p, s);

  // Claude Code's own registry still lists the old marketplace; its plugins are no longer enabled.
  const known = readJson(join(claudeDir, "plugins", "known_marketplaces.json"), {});
  if (isObj(known) && LEGACY_NAME in known && existsSync(join(claudeDir, "plugins"))) {
    try { sh("claude", ["plugin", "marketplace", "remove", LEGACY_NAME], { timeout: 30_000 }); log.change(`removed the ${LEGACY_NAME} marketplace from Claude Code`); }
    catch { log.warn(`could not remove the ${LEGACY_NAME} marketplace from Claude Code; run: claude plugin marketplace remove ${LEGACY_NAME}`); }
  }
}
