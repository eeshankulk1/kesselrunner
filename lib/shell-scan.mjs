// The shell lexer the PreToolUse guards share (lib/guards.mjs hands it to each guard's check() as `kit`).
// It reads a command line the way a shell would - quotes, redirections, `$(...)`,
// `bash -c`, heredocs, text piped or fed to a shell - so a guard sees the call inside
// `cd x && ...`, a wrapper or a pipeline. It runs nothing and expands nothing.

// Programs that run a string argument (or stdin) as a shell command line.
export const SHELL = /(^|\/)((ba|z|da|k|mk|pdk|c|tc|a|ya|s)?sh|fish|eval|env|watch|su|script|parallel)$/;
export const runsText = (cmd) => cmd.some((w) => SHELL.test(w.t)) || /^(\.|source)$/.test(cmd[0].t);
const REDIR = /&>>?|[<>]{1,2}[&|]?/y;
const ansi = (s) => s.replace(/\\(x[0-9a-f]{1,2}|u[0-9a-f]{1,4}|U[0-9a-f]{1,8}|[0-7]{1,3}|[\s\S])/gi, (_, e) => // the body of $'...'
  /^[xuU]./.test(e) ? (parseInt(e.slice(1), 16) > 0x10ffff ? "\ufffd" : String.fromCodePoint(parseInt(e.slice(1), 16))) : /^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: "\n", t: "\t" })[e] ?? e);

/**
 * Splits shell source into simple commands: arrays of words, each
 * {t: text with quotes resolved, dyn: built from a `$`, backtick or `<(...)`
 * expansion, proc: a `<(...)` or `>(...)`, split: the shell may rewrite it into
 * other words (an unquoted expansion, brace or glob), doc: a heredoc body no
 * shell reads, kept as a one-word command}.
 * Commands inside `$(...)`, backticks, subshells, `sh -c '...'` strings and
 * text piped or fed to a shell are returned too.
 */
export function scan(src, cmds = [], depth = 0, seen = new Set()) { // seen: words already rescanned as shell text, at any depth
  if (depth > 8) throw new Error("nested too deep");
  let i = 0;
  const run = (close, fed = false) => { // fed: the command being read takes its stdin from a pipe
    let cmd = [], line = [], cur = null, heredocs = [];
    const word = () => (cur ??= { t: "", dyn: false, proc: false, split: false });
    const endWord = () => { if (cur) { cmd.push(cur); line.push(cur); cur = null; } };
    const endCmd = () => {
      endWord();
      if (!cmd.length) return false;
      // A shell runs its own string arguments; one reading a pipe also runs what any earlier command printed (`echo '...' | sh`).
      const texts = runsText(cmd) ? [cmd, ...(fed ? cmds : [])].flat().filter((w) => /\s/.test(w.t) && !seen.has(w)) : [];
      cmds.push(cmd);
      for (const w of texts) { seen.add(w); scan(w.t, cmds, depth + 1, seen); }
      cmd = [];
      return true;
    };
    const expand = (quoted) => { // at "$" or "`"
      word().dyn = true;
      if (!quoted) cur.split = true;
      if (src[i] === "`") { i++; run("`"); }
      else if (src[i + 1] === "(") { i += 2; run(")"); }
      else { cur.t += "$"; i++; }
    };
    const readHeredocs = () => { // at the newline that starts the bodies
      for (const { delim, strip, quoted } of heredocs) {
        const lines = [];
        while (i < src.length) {
          const end = src.indexOf("\n", i + 1);
          const text = src.slice(i + 1, end < 0 ? src.length : end);
          i = end < 0 ? src.length : end;
          if ((strip ? text.replace(/^\t+/, "") : text) === delim) break;
          lines.push(text);
        }
        const body = { t: lines.join("\n"), dyn: false, proc: false, split: false, doc: true };
        // A body runs when a shell reads it, or when an unquoted delimiter lets `$(...)` expand. Otherwise it stays in the
        // list as a word, for a shell further down the pipeline (`cat <<EOF |`, then `sh` on a later line).
        if (line.some((w) => SHELL.test(w.t) || /^(\.|source)$/.test(w.t)) || (!quoted && /\$\(|`/.test(body.t))) { seen.add(body); scan(body.t, cmds, depth + 1, seen); }
        else cmds.push([body]);
      }
      heredocs = [];
    };
    while (i < src.length) {
      const c = src[i];
      if (c === close) { endCmd(); i++; return; }
      if (c === "\\") { if (src[i + 1] !== "\n") word().t += src[i + 1] ?? ""; i += 2; }
      else if (c === "'") {
        const end = src.indexOf("'", i + 1);
        word().t += src.slice(i + 1, end < 0 ? src.length : end);
        i = end < 0 ? src.length : end + 1;
      } else if (c === '"') {
        word(); i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === "\\") { if (src[i + 1] !== "\n") cur.t += src[i + 1] ?? ""; i += 2; }
          else if (src[i] === "$" || src[i] === "`") expand(true);
          else cur.t += src[i++];
        }
        i++;
      } else if (c === "$" && src[i + 1] === "'") { // ANSI-C quoting: $'\x67ws'
        let j = i + 2;
        while (j < src.length && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
        word().t += ansi(src.slice(i + 2, j));
        i = j + 1;
      } else if (c === "$" && src[i + 1] === '"') i++; // locale quoting: $"..." is "..."
      else if (c === "$" || c === "`") expand(false);
      else if (c === "#" && !cur) { while (i < src.length && src[i] !== "\n") i++; }
      else if (src.startsWith("<<<", i)) { endWord(); i += 3; } // here-string: its word stays an argument, so a shell's is rescanned
      else if (c === "<" && src[i + 1] === "<") {
        endWord();
        const m = /^<<(-?)[ \t]*([^\s;&|()<>]+)/.exec(src.slice(i));
        if (m) heredocs.push({ delim: m[2].replace(/['"\\]/g, ""), strip: !!m[1], quoted: /['"\\]/.test(m[2]) });
        i += m ? m[0].length : 2;
      } else if ((c === "<" || c === ">") && src[i + 1] === "(") { word().dyn = word().proc = true; i += 2; run(")"); } // process substitution
      else if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) { // a redirection ends the word: `+send>x` runs `+send`
        endWord();
        REDIR.lastIndex = i;
        i += REDIR.exec(src)[0].length;
      } else if (c === "\n") { if (endCmd()) fed = false; readHeredocs(); line = []; i++; } // a newline right after `|` continues the pipeline
      else if (c === "(") {
        // Mid-command it is no subshell (a function definition, an array, a zsh glob): scan inside and leave an uncheckable word.
        if (cur || cmd.length) word().dyn = true;
        i++;
        run(")", fed);
        fed = false; // what follows a subshell is not fed by the pipe before it
      } else if (";&|)".includes(c)) {
        endCmd();
        fed = c === "|" ? src[i + 1] !== "|" && src[i - 1] !== "|" : c === "&" && src[i - 1] === "|"; // only `|` and `|&` feed the next command
        i++;
      }
      else if (/\s/.test(c)) { endWord(); i++; }
      else {
        // Brace expansion and globs rewrite a word as well; `{`, `{}` and `{x}` expand to themselves.
        if ("*?[".includes(c) || (c === "{" && /^\{[^\s;]{0,200}(,|\.\.)/.test(src.slice(i)))) word().split = true;
        word().t += c; i++;
      }
    }
    endCmd();
  };
  run(null);
  return cmds;
}

/** A PreToolUse `tool_input.command` as one command line. An argv array (Codex) is quoted word by word, so an argument holding spaces stays one word. */
export function commandText(c) {
  return Array.isArray(c) ? c.map((a) => (/^[\w@%+=:,./-]+$/.test(String(a)) ? a : `'${String(a).replaceAll("'", "'\\''")}'`)).join(" ") : typeof c === "string" ? c : "";
}
