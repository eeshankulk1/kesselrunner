// Claim scopes: small glob dialect over repo-relative paths.
//   *  any run within one path segment     ?  one character
//   ** any number of segments               {a,b}  alternatives
// A pattern with no wildcard names a file or a directory (and everything in it).
const cache = new Map();

const esc = (c) => (/[.+^$()|[\]\\{}]/.test(c) ? `\\${c}` : c);

function expandBraces(g) {
  const m = /\{([^{}]*)\}/.exec(g);
  if (!m) return [g];
  return m[1].split(",").flatMap((alt) => expandBraces(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length)));
}

function compile(g) {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      i++;
      if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += esc(c);
  }
  return re;
}

export function globToRegExp(glob) {
  const g = String(glob).trim().replace(/^\.\//, "").replace(/^\/+/, "");
  const patterns = expandBraces(g).flatMap((p) => {
    if (/[*?]/.test(p)) return [p];
    const base = p.replace(/\/+$/, "");
    return [base, `${base}/**`];
  });
  return new RegExp(`^(?:${patterns.map(compile).join("|")})$`);
}

/** True when `rel` falls inside any of the scope patterns. */
export function matchScope(scopes, rel) {
  return (scopes ?? []).some((s) => {
    let re = cache.get(s);
    if (!re) cache.set(s, (re = globToRegExp(s)));
    return re.test(rel);
  });
}
