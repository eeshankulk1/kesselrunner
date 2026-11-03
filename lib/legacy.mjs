// The harness was called dotclaude before it became kesselrunner. A machine set
// up before the rename still has the old names in places (settings.json env, the
// state dir, the CLAUDE.md markers, hook commands); this file names them so the
// new code can read them and migrations/003 can carry them over.
export const LEGACY_NAME = "dotclaude";
export const ENV_PREFIX = "KESSELRUNNER_";
export const LEGACY_ENV_PREFIX = "DOTCLAUDE_";

/** An env knob by its short name (CODEX_SANDBOX): KESSELRUNNER_<name>, else the old DOTCLAUDE_<name>. */
export const knob = (name, env = process.env) => env[ENV_PREFIX + name] ?? env[LEGACY_ENV_PREFIX + name];

/** The old name of a KESSELRUNNER_* key, or undefined for any other key. */
export const legacyKey = (key) => (key.startsWith(ENV_PREFIX) ? LEGACY_ENV_PREFIX + key.slice(ENV_PREFIX.length) : undefined);
