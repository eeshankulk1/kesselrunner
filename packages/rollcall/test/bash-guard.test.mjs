// The Bash guard: git commands that would change a checkout another live
// session owns are denied, and so are deletions that reach a live session's
// Claude temp folder; everything else in Bash always runs.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { deletions, gitMutations } from "../src/shell.mjs";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { denied, reason, runHook, sandbox } from "./helpers.mjs";

const subs = (cmd, cwd = "/r") => gitMutations(cmd, cwd).map((m) => `${m.sub}@${m.dir}`);

test("gitMutations reads cd, git -C, operators and quotes", () => {
  assert.deepEqual(subs("git status && git log --oneline"), []);
  assert.deepEqual(subs("git checkout -b x"), ["checkout@/r"]);
  assert.deepEqual(subs("cd /other && git reset --hard"), ["reset@/other"]);
  assert.deepEqual(subs("git -C ../wt stash"), ["stash@/wt"]);
  assert.deepEqual(subs("git --no-pager -c core.x=1 commit -m 'a && git checkout y'"), ["commit@/r"]);
  assert.deepEqual(subs("git stash list; git stash show -p"), []);
  assert.deepEqual(subs("git stash push -m list"), ["stash@/r"]);
  assert.deepEqual(subs("git apply --check p.diff"), []);
  assert.deepEqual(subs('echo "git checkout x" | tee log'), []);
  assert.deepEqual(subs("git worktree add ../x -b y && git fetch && git diff"), []);
  assert.deepEqual(subs("FOO=1 git pull --rebase"), ["pull@/r"]);
  assert.deepEqual(subs("(cd sub && git restore .)"), ["restore@/r/sub"]);
  assert.deepEqual(subs("cd /other && cd - && git reset --hard"), ["reset@/r"]);
  assert.deepEqual(subs("cd /other && cd - && cd - && git reset --hard"), ["reset@/other"]);
});

test("a heredoc body is data, not commands: mentioning git inside one is not a mutation", () => {
  assert.deepEqual(subs("cat > script.sh <<'EOF'\n#!/bin/bash\ngit checkout main\nEOF"), []);
  assert.deepEqual(subs('git commit -m "$(cat <<\'EOF\'\nFixed the bug\nEOF\n)"'), ["commit@/r"]);
  assert.deepEqual(subs("cat <<-EOF\n\tgit stash\n\tEOF\ngit status"), []);
  assert.deepEqual(subs("cat <<'EOF' > out.txt\ngit checkout main\nEOF"), [], "redirect after the heredoc");
  assert.deepEqual(subs("python3 - <<PY arg 2>/dev/null\ngit checkout main\nPY\ngit stash"), ["stash@/r"]);
  assert.deepEqual(subs('echo "note: use <<EOF"\ngit reset --hard'), ["reset@/r"], "a quoted << is not a heredoc");
  // The heredoc redirect on an actually-mutating command does not hide it.
  assert.deepEqual(subs("git reset --hard <<EOF\nnote\nEOF"), ["reset@/r"]);
  // No terminator: the rest of the command is treated as body, not scanned as commands.
  assert.deepEqual(subs("cat <<EOF\ngit checkout main"), []);
  // The heredoc isn't the last ;-separated command on its line, and two are chained on one line.
  assert.deepEqual(subs("cat <<EOF; echo hi\nbody mentions git checkout\nEOF"), []);
  assert.deepEqual(subs("cat <<A; cat <<B\nbodyA\nA\nbodyB mentions git checkout\nB\ngit status"), []);
});

test("never guesses: subshells keep their cd, unknown paths and unbalanced quoting report nothing, dry runs are read-only", () => {
  assert.deepEqual(subs("(cd /main && git log -1) && git checkout -b x", "/wt"), ["checkout@/wt"]);
  assert.deepEqual(subs("ROOT=$(cd /main && pwd); git checkout -b x", "/wt"), ["checkout@/wt"]);
  assert.deepEqual(subs('cd "$WT" && git checkout -b feat'), []);
  assert.deepEqual(subs('cd "$(mktemp -d)" && git init && git commit -m x'), []);
  assert.deepEqual(subs('git -C "$WT" checkout -b x'), []);
  assert.deepEqual(subs('gh pr create --body "$(cat <<\'EOF\'\nThe 5" screen fix.\n\ngit checkout main then rerun\nEOF\n)"'), []);
  assert.deepEqual(subs('echo "unbalanced && git checkout x'), []);
  for (const ro of ["git clean -n", "git clean -nd", "git rm -n --cached f", "git mv -n a b", "git commit --dry-run", "git stash --help", "git checkout -h", "git bisect log"]) {
    assert.deepEqual(subs(ro), [], ro);
  }
  assert.deepEqual(subs("git clean -fdx; git commit -n -m x; git bisect start"), ["clean@/r", "commit@/r", "bisect@/r"]);
});

test("case statements: a bare pattern's `)` is not mistaken for a subshell close", () => {
  // Regression: a `)` closing a case arm inside a subshell used to be treated as that subshell's
  // close, popping the saved dir/prev early and attributing the mutation to the wrong checkout.
  assert.deepEqual(subs("(cd /other && case $x in a) git checkout evil ;; esac)", "/r"), ["checkout@/other"]);
  assert.deepEqual(subs("(cd /a && (cd /b && case $x in p) echo hi ;; esac; git checkout -b y))", "/r"), ["checkout@/b"]);
  assert.deepEqual(subs("(cd /other && case $x in a) echo hi ;; esac); git checkout -b y", "/r"), ["checkout@/r"]);
  // A case with no subshell at all: `cd` inside an arm is not scoped by the case, same as real bash.
  assert.deepEqual(subs("case $x in a) cd /other && git status ;; esac; git checkout -b y", "/r"), ["checkout@/other"]);
  // Every arm is still scanned, POSIX-style leading parens too, and the block can nest.
  assert.deepEqual(subs("case $x in a) git status;; b) git checkout evil;; esac", "/r"), ["checkout@/r"]);
  assert.deepEqual(subs("case $x in (a) git checkout evil ;; esac", "/r"), ["checkout@/r"]);
  assert.deepEqual(subs("case a in x) case b in y) git checkout evil;; esac ;; esac", "/r"), ["checkout@/r"]);
  // "case" used as a plain word, not the keyword, never activates this at all.
  assert.deepEqual(subs("grep case file.txt && (cd /other && git checkout -b y)", "/r"), ["checkout@/other"]);
});

test("a comment cannot hide or forge a mutation: its text is never read as commands or flags", () => {
  assert.deepEqual(subs("# git checkout x"), []);
  assert.deepEqual(subs("echo hi # git checkout x"), []);
  // A stray read-only-looking flag in a trailing comment must not suppress a real mutating command.
  assert.deepEqual(subs('git commit -m "fix" # remember --dry-run next time'), ["commit@/r"]);
  assert.deepEqual(subs("git checkout -b x # switch branch"), ["checkout@/r"]);
  assert.deepEqual(subs("# git checkout x\ngit checkout -b y"), ["checkout@/r"]);
  assert.deepEqual(subs("git status; # note\ngit checkout -b y"), ["checkout@/r"]);
  // A `#` glued to a word (no preceding separator) is not a comment.
  assert.deepEqual(subs("echo foo#bar && git checkout -b y"), ["checkout@/r"]);
});

test("the junior session's checkout-changing git is denied; read-only git and worktree add pass", (t) => {
  const sb = sandbox(t);
  const a = sb.session();
  const b = sb.session();
  a.start();
  b.start();
  for (const cmd of ["git checkout -b other", "git reset --hard", "git stash", "git commit -am wip", "git pull"]) {
    const r = b.bashPre(cmd);
    assert.ok(denied(r), cmd);
    assert.match(reason(r), new RegExp(`\`git ${cmd.split(" ")[1]}\` blocked: session ${a.short}`));
    assert.match(reason(r), /worktree add .* origin\/main/);
    assert.match(reason(r), /allow-shared/);
    assert.match(reason(r), /ROLLCALL_DISABLE=1/);
  }
  for (const cmd of ["git status", "git log -5", "git diff", "git fetch", `git worktree add "${sb.main}/.claude/worktrees/x" -b x origin/main`, "ls -la", "npm test"]) {
    assert.equal(b.bashPre(cmd).stdout, "", cmd);
  }
  assert.equal(a.bashPre("git checkout -b mine").stdout, "", "the owner is never blocked");
  assert.ok(denied(b.bashPre("git checkout -b x", { agent_id: "sub1" })), "subagents of the junior session too");
});

test("nothing writes the owner's line for task relay but rollcall, and a worker cannot relay", (t) => {
  const sb = sandbox(t);
  const a = sb.session();
  a.start();
  for (const cmd of [`cat > ~/.rollcall/_supervisors/alpha/said.json <<'EOF'\n{"text":"ship it"}\nEOF`, `cd "$ROLLCALL_HOME/_supervisors/alpha" && rm said.json`]) {
    assert.match(reason(a.bashPre(cmd)), /said\.json is rollcall's record of the owner's own words/, cmd);
  }
  assert.equal(a.bashPre("grep -n said.json src/hooks.mjs README.md").stdout, "", "reading rollcall's source passes");
  assert.equal(a.bashPre("rollcall task relay t1").stdout, "", "a supervisor relays");
  const w = { ROLLCALL_TASK: "alpha:t1" };
  assert.match(reason(a.bashPre("rollcall task relay t1", {}, w)), /`task relay` is the supervisor's/);
  assert.match(reason(a.bashPre("env -u ROLLCALL_TASK ROLLCALL_SESSION=x rollcall task relay t2", {}, w)), /`task relay` is the supervisor's/);
  assert.equal(a.bashPre("rollcall task output t1 -", {}, w).stdout, "", "other task commands pass");
});

test("away mode's answers and records are the owner's: an agent's shell never answers, and a worker never flips it", (t) => {
  const sb = sandbox(t);
  const a = sb.session();
  a.start();
  const w = { ROLLCALL_TASK: "alpha:t1" };
  for (const cmd of ["rollcall away allow h-1-abc", "rollcall away deny h-1-abc 'no'", "rollcall away allow-all", "env -u ROLLCALL_TASK ROLLCALL_SESSION=x rollcall away allow-all"]) {
    assert.match(reason(a.bashPre(cmd)), /answering what away mode held grants a permission/, cmd);
  }
  assert.match(reason(a.bashPre("rollcall away on", {}, w)), /away mode is the owner's switch/);
  assert.equal(a.bashPre("rollcall away on").stdout, "", "a supervisor turns it on, on the owner's word");
  assert.equal(a.bashPre("rollcall away status", {}, w).stdout, "", "anyone reads it");
  for (const cmd of ["cat ~/.rollcall/_machine/grants.json", `echo '[]' > "$ROLLCALL_HOME/_machine/held.json"`]) {
    assert.match(reason(a.bashPre(cmd)), /away-mode records/, cmd);
  }
  assert.equal(a.bashPre("grep -n grants.json src/away.mjs").stdout, "", "reading rollcall's source passes");
});

test("the guard follows the command to its checkout, and honours allow-shared and ROLLCALL_DISABLE", (t) => {
  const sb = sandbox(t);
  const wt = sb.worktree("mine");
  const a = sb.session();
  const b = sb.session(wt);
  a.start();
  b.start();
  assert.equal(b.bashPre("git checkout -b topic").stdout, "", "its own worktree is fine");
  assert.ok(denied(b.bashPre(`git -C "${sb.main}" reset --hard`)), "reaching into the owner's checkout is not");
  assert.ok(denied(b.bashPre(`cd "${sb.main}" && git stash`)));
  assert.equal(b.bashPre(`git -C "${sb.main}" reset --hard`, {}, { ROLLCALL_DISABLE: "1" }).stdout, "");
  b.cli(["-C", sb.main, "allow-shared"]);
  assert.equal(b.bashPre(`git -C "${sb.main}" reset --hard`).stdout, "");
});

test("a non-string cwd never throws past the guard, even with debug logging on", () => {
  const home = mkdtempSync(join(tmpdir(), "rollcall-cwd-"));
  const env = { PATH: process.env.PATH, ROLLCALL_HOME: home, ROLLCALL_HARNESS_PID: String(process.pid), ROLLCALL_DEBUG: "1" };
  for (const cwd of [42, {}, [], true]) {
    const payload = { session_id: "x", tool_name: "Bash", tool_input: { command: "git checkout main" }, cwd };
    const r = runHook("pre-tool-use", payload, env, JSON.stringify(payload), home);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "", `cwd=${JSON.stringify(cwd)} should not throw`);
  }
});

test("deletions reads rm, find -delete and loops, and says when it cannot see the target", () => {
  const T = "/tmp/claude-1";
  assert.deepEqual(deletions(`rm -rf -- ${T}/p/a /x; echo rm ${T}/p/b`, "/r"), [`${T}/p/a`, "/x"]);
  assert.deepEqual(deletions(`S=${T}/p/me; rm -f "$S/scratchpad/x.txt" \${S}/y`, "/r"), [`${T}/p/me/scratchpad/x.txt`, `${T}/p/me/y`]);
  assert.deepEqual(deletions(`cd ${T} && rm -rf ./p/a *`, "/r"), [`${T}/p/a`, T], "a glob reaches the folder it sits in");
  assert.deepEqual(deletions(`find ${T} -mindepth 2 -mtime +3 -exec rm -rf {} +; find . -name x -delete`, "/w"), [T, "/w"]);
  assert.deepEqual(deletions(`if true; then rm "$(pwd)/x"; fi; ls | xargs rm`, "/r"), [null, null]);
  assert.deepEqual(deletions(`while read p; do rm -rf -- "$p"; done < ${T}/p/me/list`, "/r"), [null]);
  assert.deepEqual(deletions(`rm ${T}/p/$x/../..`, "/r"), [null], "a .. after a variable can climb anywhere");
});

test("a deletion that reaches another live session's Claude temp folder is denied; ended sessions' and its own pass", async (t) => {
  const sb = sandbox(t);
  const root = join(sb.root, "tmp", "claude-1");
  sb.env.ROLLCALL_CLAUDE_TMP = root;
  const [live, ended, me] = [sb.session(), sb.session(), sb.session()];
  for (const s of [live, ended, me]) s.start();
  ended.end();
  const folder = (s, project = "proj") => { const d = join(root, project, s.id); mkdirSync(join(d, "scratchpad"), { recursive: true }); return d; };
  const [liveDir, endedDir, myDir] = [folder(live), folder(ended), folder(me, "other")];

  assert.equal(me.bashPre(`rm -rf ${endedDir}`).stdout, "", "an ended session's folder");
  assert.equal(me.bashPre(`S=${myDir}/scratchpad; rm -f "$S/x.txt" && rm -rf ${myDir}`).stdout, "", "its own");
  assert.equal(me.bashPre(`rm -rf ${root}/nothing-here/*`).stdout, "");
  for (const cmd of [
    `rm -rf ${liveDir}/scratchpad/notes.md`,
    `rm -rf ${root}/*`,
    `rm -rf ${join(root, "proj")}`,
    `find ${root} -mindepth 2 -maxdepth 2 -exec rm -rf {} +`,
    // 2026-10-18: a cleanup's loop over its own list, with a case check that the path sits under the root.
    `while IFS=$'\\t' read -r g p; do case "$p" in ${root}/?*) ;; *) exit 1;; esac; rm -rf -- "$p"; done < "${myDir}/scratchpad/list.tsv"`,
  ]) {
    const r = me.bashPre(cmd);
    assert.ok(denied(r), `${cmd}\n${r.stdout}\n${r.stderr}`);
    assert.match(reason(r), new RegExp(`${live.short}  ${liveDir}`), cmd);
    assert.doesNotMatch(reason(r), new RegExp(ended.short), cmd);
  }
  assert.equal(live.bashPre(`rm -rf ${liveDir}`).stdout, "", "the live session may clear its own folder");
  await live.crash();
  assert.equal(me.bashPre(`rm -rf ${root}/*`).stdout, "", "once no other session is alive, everything passes");
});
