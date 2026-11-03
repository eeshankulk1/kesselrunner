// Finds git commands in a shell command line that would change a checkout's
// files, branch or index, and the directory each one runs in. Deliberately
// conservative: anything it cannot read for certain (a `cd "$DIR"`, a word
// built by `$(...)`, quoting that does not balance) makes it report nothing,
// so the worst case is a missed block, never a false one.
// Also finds what deleting commands (rm, find -delete...) can reach, for the
// temp-folder guard (temp.mjs). There a target it cannot read comes back as
// "anywhere", since the guard only runs on commands naming the Claude temp root.
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

const MUTATING = new Set([
  "checkout", "switch", "reset", "restore", "clean", "stash", "rebase", "merge", "pull",
  "commit", "cherry-pick", "revert", "am", "apply", "rm", "mv", "bisect",
]);
const dryRun = (rest) => rest.some((t) => t === "--dry-run" || /^-[A-Za-z]*n[A-Za-z]*$/.test(t));
// Read-only forms of otherwise mutating subcommands (`rest` = the words after the subcommand).
const READ_ONLY = {
  stash: (rest) => ["list", "show"].includes(rest[0]),
  apply: (rest) => rest.some((t) => ["--check", "--stat", "--numstat", "--summary"].includes(t)),
  clean: dryRun, rm: dryRun, mv: dryRun,
  commit: (rest) => rest.includes("--dry-run"),
  bisect: (rest) => ["log", "view", "visualize", "help"].includes(rest[0]),
};
// git global options that take a separate value.
const VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

const SEP = Symbol("sep"), OPEN = Symbol("open"), CLOSE = Symbol("close");
// Stands in for the output of $(...) or `...` inside a word: its value is unknown.
const DYNAMIC = "\u0000";
const QUOTED = "\u0001";

/** Skips the bodies of the heredocs redirected on the line ending at `nl`, in order; returns where parsing resumes. */
function skipBodies(cmd, nl, heredocs) {
  let pos = nl;
  for (const h of heredocs) {
    for (let start = pos + 1; ; ) {
      if (start > cmd.length) return cmd.length;
      const next = cmd.indexOf("\n", start);
      const stop = next === -1 ? cmd.length : next;
      const line = cmd.slice(start, stop);
      if ((h.tabs ? line.replace(/^\t+/, "") : line) === h.delim) { pos = stop; break; }
      if (next === -1) return cmd.length;
      start = next + 1;
    }
  }
  return pos;
}

/**
 * Words (strings) and SEP/OPEN/CLOSE markers, read the way the shell reads
 * them, or null when the quoting does not balance. `$(...)` and backticks open
 * a nested context with their own quote state (so `"$(cat <<'EOF' ...)"`
 * parses correctly); `(`/`)` mark subshells; heredoc bodies are skipped as data.
 */
function lex(cmd) {
  const out = [];
  const stack = [{ quote: null, tick: false }];
  // Nested `case ... esac` blocks at their opening depth: { expect, depth }. `expect` means the
  // next same-depth `)` ends a pattern list (`a) ...`), not a subshell - it does not open one either,
  // so it must not be treated as a mutation boundary.
  const cases = [];
  // An in-progress `case <subject> in` keyword match: { stage: 1 (saw case, want subject) | 2 (want "in"), depth }.
  // Not reset by a nested $(...)/`...` (a dynamic subject is legal), only by a real separator.
  let pending = null;
  let word = null, plain = null; // `plain` mirrors `word` with quoted characters masked
  let heredocs = [], delimNext = null;
  const add = (c, quoted) => { word = (word ?? "") + c; plain = (plain ?? "") + (quoted ? QUOTED : c); };
  const active = () => (cases.length && cases.at(-1).depth === stack.length ? cases.at(-1) : null);
  const end = () => {
    if (word === null) return;
    if (delimNext !== null) { heredocs.push({ tabs: delimNext, delim: word }); delimNext = null; }
    else {
      const m = /(?<!<)<<(-?)([^<]*)$/.exec(plain); // an unquoted `<<` (not `<<<`) starts a heredoc
      if (m) {
        const delim = word.slice(m.index + 2 + m[1].length);
        if (delim) heredocs.push({ tabs: m[1] === "-", delim }); else delimNext = m[1] === "-";
      }
    }
    const bare = word === plain; // unquoted: could be a real keyword, not just a same-spelled argument
    if (pending && pending.depth === stack.length) {
      if (pending.stage === 1) pending.stage = 2;
      else { if (bare && word === "in") cases.push({ expect: true, depth: stack.length }); pending = null; }
    } else if (bare && word === "case") pending = { stage: 1, depth: stack.length };
    if (bare && word === "esac") { const a = active(); if (a) cases.pop(); }
    out.push(word);
    word = plain = null;
  };
  const open = (ctx) => { add(DYNAMIC, false); end(); out.push(OPEN); stack.push(ctx); };
  const close = () => { end(); out.push(CLOSE); if (stack.length > 1) stack.pop(); };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const ctx = stack.at(-1);
    if (ctx.quote === "'") { if (c === "'") ctx.quote = null; else add(c, true); continue; }
    if (ctx.quote === '"') {
      if (c === '"') ctx.quote = null;
      else if (c === "\\" && i + 1 < cmd.length) add(cmd[++i], true);
      else if (c === "$" && cmd[i + 1] === "(") { i++; open({ quote: null, tick: false }); }
      else if (c === "`") open({ quote: null, tick: true });
      else add(c, true);
      continue;
    }
    if (c === "'" || c === '"') { ctx.quote = c; word ??= ""; plain ??= ""; }
    else if (c === "\\" && i + 1 < cmd.length) { if (cmd[i + 1] === "\n") i++; else add(cmd[++i], true); }
    else if (c === "$" && cmd[i + 1] === "(") { i++; open({ quote: null, tick: false }); }
    else if (c === "`") { if (ctx.tick) close(); else open({ quote: null, tick: true }); }
    else if (c === "(") { end(); out.push(OPEN); stack.push({ quote: null, tick: false }); }
    // A pattern-list terminator, not a subshell close - unless this `)` is what ends "esac" itself
    // (e.g. `esac)` with no space), which really does close an enclosing subshell/`$(...)`. Like `;`,
    // it starts a new command list (the arm's body), so it is a SEP too.
    else if (c === ")" && active()?.expect && !(word === "esac" && plain === "esac")) {
      end();
      const a = active();
      if (a) a.expect = false;
      out.push(SEP);
    }
    else if (c === ")") close();
    else if (c === "\n") { end(); out.push(SEP); pending = null; i = skipBodies(cmd, i, heredocs); heredocs = []; }
    else if (c === ";" && cmd[i + 1] === ";") { end(); i++; const a = active(); if (a) a.expect = true; out.push(SEP); pending = null; }
    else if (c === ";" || c === "&" || c === "|") { end(); out.push(SEP); pending = null; }
    else if (c === " " || c === "\t" || c === "\r") end();
    // A `#` at the start of a word (unquoted, not glued to prior text) starts a comment: everything to
    // the end of the line is inert, not a command - so its content can never trigger or hide a mutation.
    else if (c === "#" && word === null) { const nl = cmd.indexOf("\n", i); i = (nl === -1 ? cmd.length : nl) - 1; }
    else add(c, false);
  }
  if (stack.length > 1 || stack[0].quote) return null;
  end();
  return out;
}

const expand = (p) => (p === "~" ? homedir() : p.startsWith("~/") ? homedir() + p.slice(1) : p);
const knowable = (p) => !/[$*?[\u0000]/.test(p);
/** Where `cd p` / `git -C p` lands from `base`, or null (unknown) when either is not a literal path. */
function move(base, p) {
  if (!knowable(p)) return null;
  const e = expand(p);
  if (isAbsolute(e)) return resolve(e);
  return base === null ? null : resolve(base, e);
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{", "time"]);
/** `w` with each `$NAME` / `${NAME}` that `vars` knows replaced by its value. */
const substitute = (w, vars) => w.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, a, b) => vars[a ?? b] ?? m);

/**
 * Each simple command in `cmd` as { dir, words, vars }: the directory it runs in (`cd` followed; null once
 * unknown), its words after any FOO=bar, env or command prefix, and the variables a plain assignment set
 * before it (`S=/x; rm "$S/y"`). Null when the quoting does not balance.
 */
function commands(cmd, cwd) {
  const items = lex(cmd);
  if (!items) return null;
  const found = [], saved = [], vars = {};
  let dir = cwd, prev = cwd, seg = [];
  const flush = () => {
    const s = seg;
    seg = [];
    let i = 0;
    while (i < s.length && ASSIGN.test(s[i])) i++; // FOO=bar prefixes
    const assigns = i === s.length ? s : s[i] === "export" && s.slice(i + 1).every((w) => ASSIGN.test(w)) ? s.slice(i + 1) : null;
    if (assigns) {
      for (const a of assigns) { const eq = a.indexOf("="); vars[a.slice(0, eq)] = substitute(a.slice(eq + 1), vars); }
      return;
    }
    while (KEYWORDS.has(s[i])) i++; // `do rm ...`, `then git reset ...`
    if (s[i] === "env" || s[i] === "command") i++;
    const words = s.slice(i);
    if (words[0] === "cd") {
      const arg = words[1];
      const next = arg === "-" ? prev : move(dir, arg ?? "~");
      prev = dir;
      dir = next;
      return;
    }
    found.push({ dir, words, vars: { ...vars } });
  };
  for (const it of items) {
    if (it === SEP) flush();
    else if (it === OPEN) { flush(); saved.push([dir, prev]); }
    else if (it === CLOSE) { flush(); if (saved.length) [dir, prev] = saved.pop(); }
    else seg.push(it);
  }
  flush();
  return found;
}

/** [{ dir, sub }] for each checkout-changing git invocation in `cmd`, run from `cwd`. */
export function gitMutations(cmd, cwd) {
  const found = [];
  for (const { dir, words: s } of commands(cmd, cwd) ?? []) {
    if (!s[0] || basename(s[0]) !== "git") continue;
    let where = dir, j = 1;
    for (; j < s.length && s[j].startsWith("-"); j++) {
      const eq = s[j].indexOf("=");
      const opt = eq > 0 ? s[j].slice(0, eq) : s[j];
      const value = eq > 0 ? s[j].slice(eq + 1) : VALUED.has(opt) ? s[++j] : null;
      if ((opt === "-C" || opt === "--work-tree") && value != null) where = move(where, value);
    }
    const sub = s[j], rest = s.slice(j + 1);
    if (where === null || !MUTATING.has(sub)) continue;
    if (rest.includes("-h") || rest.includes("--help") || READ_ONLY[sub]?.(rest)) continue;
    found.push({ dir: where, sub });
  }
  return found;
}

const DELETERS = new Set(["rm", "rmdir", "unlink", "trash", "srm"]);
const deleter = (w) => DELETERS.has(basename(w ?? ""));
/** The words after the options (`rm -rf -- a b` -> a, b). */
const operands = (ws) => { const k = ws.indexOf("--"); return k === -1 ? ws.filter((w) => !w.startsWith("-")) : [...ws.slice(0, k).filter((w) => !w.startsWith("-")), ...ws.slice(k + 1)]; };
/** find's start paths: the words before its first expression. */
function startPaths(ws) {
  let i = 0;
  while (/^-[HLPEXdsx]+$/.test(ws[i] ?? "")) i++;
  const paths = [];
  for (; i < ws.length && !/^[-(!]/.test(ws[i]); i++) paths.push(ws[i]);
  return paths.length ? paths : ["."];
}
/** Where a deletion of `t` from `dir` can reach: the path itself, the folder above its first glob or variable, or null (anywhere). */
function reach(dir, t) {
  const e = expand(t);
  const at = (p) => (isAbsolute(p) ? resolve(p) : dir === null ? null : resolve(dir, p));
  const k = e.search(/[$*?[\u0000]/);
  if (k === -1) return at(e);
  if (/(^|\/)\.\.(\/|$)/.test(e.slice(k))) return null;
  const known = e.slice(0, e.lastIndexOf("/", k) + 1);
  if (!known && /[$\u0000]/.test(e[0])) return null; // a variable or $(...) may expand to any path
  return at(known || ".");
}

/**
 * Where each deleting command in `cmd` can reach (see reach), run from `cwd`: rm and its kin, `find -delete`
 * or `-exec rm`, and null for deletions whose targets the line does not show (xargs rm, a script's rmtree).
 */
export function deletions(cmd, cwd) {
  const out = [];
  for (const { dir, words, vars } of commands(cmd, cwd) ?? []) {
    let targets;
    if (deleter(words[0])) targets = operands(words.slice(1));
    else if (basename(words[0] ?? "") === "find" && words.some((w, i) => w === "-delete" || (/^-(exec|execdir|ok|okdir)$/.test(w) && deleter(words[i + 1])))) targets = startPaths(words.slice(1));
    else if ((basename(words[0] ?? "") === "xargs" && words.some(deleter)) || basename(words[0] ?? "") === "rimraf" || words.some((w) => /\b(rmtree|rmSync|rimraf)\(/.test(w))) { out.push(null); continue; }
    else continue;
    for (const t of targets) out.push(reach(dir, substitute(t, vars)));
  }
  return out;
}
