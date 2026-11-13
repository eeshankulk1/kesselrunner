// kesselrunner's per-event hook entries (scripts/hooks/) as Claude Code runs them: one process per PreToolUse or
// PostToolUse call runs the guards, deploy-watch and rollcall, each on the tools it names. The guards here are
// fixtures in a throwaway overlay (lib/guards.mjs has the contract); real ones live in a user's overlay.
//   node --test test/hooks.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { guardFiles, preToolMatcher } from "../lib/guards.mjs";

const PRE = fileURLToPath(new URL("../scripts/hooks/pre-tool-use.mjs", import.meta.url));
const POST = fileURLToPath(new URL("../scripts/hooks/post-tool-use.mjs", import.meta.url));
const SETTINGS = JSON.parse(readFileSync(new URL("../settings.core.json", import.meta.url), "utf8"));
const CORE = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

// Fixture guards, in file-name order: one that throws, one whose file does not load, a shell guard that reads the
// command through the kit's lexer, and one on file and browser tools.
const GUARDS = {
  "a-crash.mjs": `export function check() { throw new Error("boom"); }\n`,
  "b-broken.mjs": `export const = ;\n`,
  "c-shell.mjs": `export function check(payload, kit) {
  const cmds = kit.scan(kit.commandText(payload.tool_input?.command));
  return cmds.some((c) => c.some((w) => w.t === "forbidden")) ? \`[fixture-shell] Blocked: forbidden (core \${kit.core})\` : null;
}\n`,
  "d-files.mjs": `export const tools = /^(Read|Edit)$|^mcp__.*browser/;
export function check(payload) { return String(payload.tool_input?.file_path ?? "").endsWith(".secret") ? "[fixture-files] Blocked: a secret" : null; }\n`,
};
/** A directory holding hooks/pre-tool-use/<name> for each { name: source }. */
function guardDir(root, files) {
  mkdirSync(join(root, "hooks", "pre-tool-use"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "hooks", "pre-tool-use", name), text);
  return root;
}

/** A repo with an origin (so rollcall guards its main checkout) and a private rollcall store. */
function world(t) {
  const root = mkdtempSync(join(tmpdir(), "dc-hooks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("remote", "add", "origin", "https://example.com/acme/app.git");
  writeFileSync(join(repo, "a.txt"), "a\n");
  const overlay = guardDir(join(root, "overlay with space"), GUARDS);
  const env = { PATH: process.env.PATH, HOME: root, ROLLCALL_HOME: join(root, "rc"), ROLLCALL_GC: "0", ROLLCALL_PARK: "0", ROLLCALL_FETCH_MINUTES: "999", ROLLCALL_HARNESS_PID: String(process.pid) };
  const run = (hook, payload, extra = {}, args = hook === PRE ? [overlay] : []) => {
    const r = spawnSync(process.execPath, [hook, ...args], { input: JSON.stringify({ session_id: "s1", cwd: repo, ...payload }), env: { ...env, ...extra }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  return { repo, overlay, run };
}

test("settings.core.json runs one process per tool event, on rollcall's tools and every tool a guard names", async (t) => {
  const [pre, ...morePre] = SETTINGS.hooks.PreToolUse;
  const [post, ...morePost] = SETTINGS.hooks.PostToolUse;
  assert.deepEqual([morePre, morePost], [[], []]);
  assert.match(pre.hooks[0].command, /scripts\/hooks\/pre-tool-use\.mjs" "\{\{OVERLAY\}\}"$/);
  assert.match(post.hooks[0].command, /scripts\/hooks\/post-tool-use\.mjs"$/);
  assert.equal(pre.matcher, "{{PRE_TOOL_MATCHER}}", "sync fills it in from the guards it finds");
  const root = mkdtempSync(join(tmpdir(), "dc-matcher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const overlay = guardDir(root, GUARDS);
  // Claude Code's rule: a matcher of letters, digits, _ and | lists exact tool names; any other character makes
  // it a regex, tested unanchored.
  const on = (matcher, tool) => /^[\w|]+$/.test(matcher) ? matcher.split("|").includes(tool) : new RegExp(matcher).test(tool);
  const bare = await preToolMatcher(CORE, null);
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]) assert.ok(on(bare, tool), `rollcall's ${tool}`);
  for (const tool of ["Read", "Monitor", "mcp__plugin_playwright_playwright__browser_navigate"]) assert.ok(!on(bare, tool), `${tool}: no guard names it`);
  for (const tool of ["Agent", "Task"]) assert.ok(on(bare, tool), `${tool}: the core's agent-model guard`);
  const matcher = await preToolMatcher(CORE, overlay);
  for (const tool of ["Bash", "Monitor", "Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "mcp__plugin_playwright_playwright__browser_navigate"]) assert.ok(on(matcher, tool), tool);
  for (const tool of ["TodoWrite", "BashOutput", "ReadMcpResourceTool", "Glob", "Grep", "mcp__x__WriteFile"]) assert.ok(!on(matcher, tool), `${tool}: nothing names it`);
  assert.equal(matcher.split("^(Bash|Monitor)$").length, 2, "two guards on the default tools add them once");
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "AskUserQuestion"]) assert.ok(on(post.matcher, tool), tool);
  assert.ok(!on(post.matcher, "TodoWrite"));
});

test("guards: the core's and the overlay's, by file name, the overlay's replacing a core one of the same name", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dc-guards-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const core = guardDir(join(root, "core"), { "b.mjs": "", "d.mjs": "", "notes.txt": "", ".hidden.mjs": "" });
  const overlay = guardDir(join(root, "overlay"), { "a.mjs": "", "d.mjs": "", "c.js": "" });
  const g = (dir, f) => join(dir, "hooks", "pre-tool-use", f);
  assert.deepEqual(guardFiles(core, overlay), [g(overlay, "a.mjs"), g(core, "b.mjs"), g(overlay, "c.js"), g(overlay, "d.mjs")]);
  assert.deepEqual(guardFiles(core, null), [g(core, "b.mjs"), g(core, "d.mjs")]);
  assert.deepEqual(guardFiles(join(root, "none"), null), []);
});

test("PreToolUse: a guard denies and its deny skips rollcall; one that crashes or does not load allows and the rest still run; ROLLCALL_DISABLE stops rollcall's part only", (t) => {
  const w = world(t);
  const SHELL_DENY = new RegExp(`^\\[fixture-shell\\] Blocked: forbidden \\(core ${CORE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)$`);
  const bad = { tool_name: "Bash", tool_input: { command: "cd x && echo ok | forbidden --now" } };
  assert.match(w.run(PRE, bad).permissionDecisionReason, SHELL_DENY, "read through the kit's lexer, with the core named; the guards before it allowed");
  assert.equal(w.run(PRE, { tool_name: "Bash", tool_input: { command: "echo forbidden-not" } }), null);
  assert.equal(w.run(PRE, { tool_name: "Bash", tool_input: { command: "ls -la" } }), null);
  assert.equal(w.run(PRE, { tool_name: "Glob", tool_input: { pattern: "*" } }), null, "a tool nothing names");
  // An edit in the main checkout of a repo with an origin is rollcall's to refuse.
  const edit = { tool_name: "Edit", tool_input: { file_path: join(w.repo, "a.txt"), old_string: "a", new_string: "b" } };
  assert.match(w.run(PRE, edit).permissionDecisionReason, /^\[rollcall\] Edit blocked: agents work in a worktree/);
  assert.equal(w.run(PRE, edit, { ROLLCALL_DISABLE: "1" }), null);
  // A guard's deny is final: rollcall, which would refuse this edit too, adds nothing.
  const secret = { tool_name: "Edit", tool_input: { file_path: join(w.repo, "a.secret"), old_string: "a", new_string: "b" } };
  assert.equal(w.run(PRE, secret).permissionDecisionReason, "[fixture-files] Blocked: a secret");
  assert.match(w.run(PRE, bad, { ROLLCALL_DISABLE: "1" }).permissionDecisionReason, SHELL_DENY);
  assert.equal(w.run(PRE, { tool_name: "Bash" }), null, "a payload with no command");
  // Only the tools each guard names: a tool whose name merely contains one of them reaches none.
  const writeFile = { tool_name: "mcp__x__WriteFile", tool_input: { path: join(w.repo, "a.txt") } };
  assert.equal(w.run(PRE, writeFile), null, "rollcall never sees MCP tools");
  assert.equal(w.run(PRE, { tool_name: "TodoWrite", tool_input: { todos: [] } }), null);
  assert.equal(w.run(PRE, { ...bad, tool_name: "mcp__x__RunBash" }), null, "a guard without tools sees Bash and Monitor only");
  assert.match(w.run(PRE, { ...bad, tool_name: "Monitor" }).permissionDecisionReason, SHELL_DENY);
  assert.equal(w.run(PRE, { tool_name: "Read", tool_input: { file_path: "/x/a.secret" } }).permissionDecisionReason, "[fixture-files] Blocked: a secret");
  assert.equal(w.run(PRE, { tool_name: "mcp__plugin_playwright_playwright__browser_file_upload", tool_input: { file_path: "/x/a.secret" } }).permissionDecisionReason, "[fixture-files] Blocked: a secret");
  assert.equal(w.run(PRE, { tool_name: "Write", tool_input: { file_path: join(w.repo, "b.secret"), content: "" } }, { ROLLCALL_DISABLE: "1" }), null, "Write is not a tool the files guard names");
  // A command with no tool name is a shell call, as each guard read it alone.
  assert.match(w.run(PRE, { tool_input: bad.tool_input }).permissionDecisionReason, SHELL_DENY);
  // Without an overlay (sync writes an empty argument) only the core's guards run: none of them reads Bash.
  assert.equal(w.run(PRE, bad, {}, [""]), null);
  assert.equal(w.run(PRE, bad, {}, []), null);
  const r = spawnSync(process.execPath, [PRE, w.overlay], { input: "not json", encoding: "utf8" });
  assert.deepEqual([r.status, r.stdout], [0, ""], "a payload it does not understand is let through, silently");
});

test("PostToolUse: deploy-watch's follow-up to a merge, nothing for other commands", (t) => {
  const w = world(t);
  const merged = w.run(POST, { tool_name: "Bash", tool_input: { command: "gh pr merge 7 --squash" }, tool_response: { stdout: "✓ Merged pull request #7" } });
  assert.equal(merged.hookEventName, "PostToolUse");
  assert.match(merged.additionalContext, /^\[deploy-watch\] PR #7 in the repo at .* was just merged\./);
  assert.equal(w.run(POST, { tool_name: "Bash", tool_input: { command: "gh pr merge 7" }, tool_response: { stderr: "merge failed" } }), null);
  assert.equal(w.run(POST, { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "" } }), null);
  assert.equal(w.run(POST, { tool_name: "Edit", tool_input: { file_path: join(w.repo, "a.txt") }, tool_response: { success: true } }), null);
});

test("the core's agent-model guard: an agent with no model of its own needs one named; test, review and docs work goes to the named agents", (t) => {
  const w = world(t);
  const home = join(w.repo, "..");
  mkdirSync(join(home, ".claude", "agents"), { recursive: true });
  mkdirSync(join(w.repo, ".claude", "agents"), { recursive: true });
  writeFileSync(join(home, ".claude", "agents", "code-reviewer.md"), "---\nname: code-reviewer\nmodel: sonnet\n---\nbody\n");
  writeFileSync(join(home, ".claude", "agents", "bare.md"), "---\nname: bare\n---\nbody\n");
  writeFileSync(join(home, ".claude", "agents", "inherits.md"), "---\nname: inherits\nmodel: inherit\n---\nbody\n");
  writeFileSync(join(w.repo, ".claude", "agents", "local.md"), "---\nname: local\nmodel: \"haiku\"\n---\nbody\n");
  const agent = (input, tool = "Agent") => w.run(PRE, { tool_name: tool, tool_input: { prompt: "p", ...input } }, { ROLLCALL_DISABLE: "1" })?.permissionDecisionReason ?? null;
  const NO_MODEL = /^\[kesselrunner\] Agent call refused: (general-purpose|Explore|Plan|bare|inherits) has no model of its own/;
  const WORK = /^\[kesselrunner\] Agent call refused: ".*" is test, review or docs work/;
  assert.match(agent({ subagent_type: "general-purpose", description: "Implement retry" }), NO_MODEL);
  assert.match(agent({ description: "Implement retry" }), NO_MODEL, "no type is general-purpose");
  assert.match(agent({ description: "Implement retry" }, "Task"), NO_MODEL, "the tool's old name");
  assert.equal(agent({ subagent_type: "general-purpose", model: "opus", description: "Implement retry" }), null);
  for (const description of ["Review the auth diff", "Verify fix in browser", "Run the unit tests", "Test login flow", "Update docs for gc", "Second code review"]) {
    assert.match(agent({ subagent_type: "general-purpose", model: "sonnet", description }), WORK, description);
  }
  for (const description of ["Implement retry with tests", "Testing harness rewrite", "Document parser plan", "Add tests to parser"]) {
    assert.equal(agent({ subagent_type: "general-purpose", model: "opus", description }), null, description);
  }
  assert.match(agent({ subagent_type: "Explore", description: "Find gc callers" }), NO_MODEL);
  assert.equal(agent({ subagent_type: "Explore", model: "sonnet", description: "Find gc callers" }), null);
  assert.match(agent({ subagent_type: "Plan", description: "Plan it" }), NO_MODEL);
  assert.equal(agent({ subagent_type: "code-reviewer", description: "Review the auth diff" }), null, "a named agent with its own model");
  assert.equal(agent({ subagent_type: "code-reviewer", model: "opus", description: "Second review" }), null, "a named agent may be stepped up");
  assert.equal(agent({ subagent_type: "local", description: "x" }), null, "the project's own agents count");
  assert.match(agent({ subagent_type: "bare", description: "x" }), NO_MODEL);
  assert.match(agent({ subagent_type: "inherits", description: "x" }), NO_MODEL);
  assert.equal(agent({ subagent_type: "bare", model: "sonnet", description: "x" }), null);
  assert.equal(agent({ subagent_type: "fork", description: "Review the diff" }), null, "a fork runs on the session's model by design");
  assert.equal(agent({ subagent_type: "vercel:deployment-expert", description: "x" }), null, "an agent it cannot see");
  assert.equal(w.run(PRE, { tool_input: { command: "ls" } }, { ROLLCALL_DISABLE: "1" }), null, "a shell payload reaches the guard and passes");
});
