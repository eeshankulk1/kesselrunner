// Shared by the codex bridge and the delegate runner: parsing agents/*.md and
// escaping strings for the TOML both of them hand to Codex.

/** { front, body, get(key) } for an agent markdown file, or null when it has no frontmatter. */
export function parseAgent(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  const [, front, body] = m;
  const get = (key) => front.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"))?.[1]?.replace(/^(["'])(.*)\1$/, "$2");
  return { front, body, get };
}

/**
 * Escapes text for a TOML basic string: lossless for any input, valid both
 * single-line ("...") and multiline ("""..."""). Newlines and tabs stay raw so
 * multiline values remain readable; every other control character is escaped.
 */
export const escapeTomlBasic = (s) => s
  .replaceAll("\\", "\\\\")
  .replaceAll('"', '\\"')
  .replace(/\r/g, "\\r")
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
