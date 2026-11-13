#!/usr/bin/env bash
# Offline checks of the delegation backend: setting round-trip, status/hook
# output, runner exit codes, and a full run against a fake `codex` binary that
# records what it was invoked with. Never touches the real ~/.claude or Codex.
#   bash test/delegate.sh
set -euo pipefail
CORE="$(cd "$(dirname "$0")/.." && pwd)"
SB="$(mktemp -d)"
# Scrub every kesselrunner/Codex knob (and the DOTCLAUDE_* names from before the rename) from the developer's own environment, then set ours.
unset $(env | sed -nE 's/^((KESSELRUNNER|DOTCLAUDE)_[A-Z_]*)=.*/\1/p') CODEX_CLI_PATH CLAUDE_CONFIG_DIR 2>/dev/null || true
export CLAUDE_CONFIG_DIR="$SB/claude" KESSELRUNNER_DELEGATE_LOG_DIR="$SB/logs"
mkdir -p "$CLAUDE_CONFIG_DIR/agents"
cp "$CORE/agents/code-reviewer.md" "$CLAUDE_CONFIG_DIR/agents/"
printf -- '---\nname: watcher\ndescription: x\ncodex_sandbox: read-only\ncodex_model: gpt-test\n---\nWatch things.\n' > "$CLAUDE_CONFIG_DIR/agents/watcher.md"
printf -- "---\nname: literal-edge\ndescription: x\n---\nInstructions contain ''' and must stay developer instructions.\n" > "$CLAUDE_CONFIG_DIR/agents/literal-edge.md"
printf -- '---\nname: sim-only\ndescription: x\ncodex: never\n---\nDrive the simulator.\n' > "$CLAUDE_CONFIG_DIR/agents/sim-only.md"
printf '{"model":"keep-me","env":{"KEEP_ME":"yes"}}\n' > "$CLAUDE_CONFIG_DIR/settings.json"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }
DC() { node "$CORE/bin/kesselrunner.mjs" "$@"; }
RUN() { node "$CORE/scripts/delegate/run.mjs" "$@"; }

# fake codex: records argv + stdin, honours -o, exits 0
FAKE="$SB/codex"; cat > "$FAKE" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo "codex-cli 9.9.9-fake"; exit 0;;
  login) echo "Logged in using ChatGPT" >&2; exit 0;;
  debug) echo '[{"slug":"gpt-fast","display_name":"Fast","default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"}],"visibility":"list"},{"slug":"gpt-hidden","supported_reasoning_levels":[{"effort":"low"}],"visibility":"hide"}]'; exit 0;;
esac
printf '%s\n' "$@" > "$FAKE_RECORD.argv"
echo "gh_token=${GH_TOKEN:+set}" > "$FAKE_RECORD.env"
cat > "$FAKE_RECORD.stdin"
out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
echo "## Code Review Results - fake verdict clean" > "$out"
echo "progress noise that must not reach the caller"
SH
chmod +x "$FAKE"; export FAKE_RECORD="$SB/record" KESSELRUNNER_CODEX_BIN="$FAKE"

# 1. default backend is claude; runner refuses with exit 2; hook is silent
[ "$(DC delegate)" = "delegation backend: claude (Agent tool)" ] || fail "default backend"
[ -z "$(RUN status --hook)" ] || fail "hook not silent on claude"
set +e; echo task | RUN code-reviewer >/dev/null 2>"$SB/err"; code=$?; set -e
[ "$code" = 2 ] && grep -q 'subagent_type: "code-reviewer"' "$SB/err" || fail "claude backend exit code"
set +e; RUN code-reviewer --unknown 2>"$SB/err"; code=$?; set -e
[ "$code" = 3 ] && grep -q 'unknown option "--unknown"' "$SB/err" || fail "runner unknown option"
set +e; RUN code-reviewer --prompt-file 2>"$SB/err"; code=$?; set -e
[ "$code" = 3 ] && grep -q -- '--prompt-file requires a value' "$SB/err" || fail "runner missing option value"
ok "claude backend: runner defers to the Agent tool"

# 1b. an agent's own `backend: codex` runs it on Codex while the switch stays on claude; the hook names it
printf -- '---\nname: solo\ndescription: x\nbackend: codex\n---\nWork alone.\n' > "$CLAUDE_CONFIG_DIR/agents/solo.md"
echo "solo task" > "$SB/solo.txt"
RUN solo --cwd "$SB" --prompt-file "$SB/solo.txt" > "$SB/solo.out" || fail "backend: codex agent did not run on Codex"
grep -q "solo task" "$FAKE_RECORD.stdin" && grep -q "fake verdict" "$SB/solo.out" || fail "backend: codex agent output"
RUN status --hook | grep -q "delegation backend: claude, except solo on codex (codex-cli 9.9.9-fake)" || fail "hook names the agent on codex"
RUN status | grep -q "on codex by their own frontmatter: solo" || fail "status names the agent on codex"
set +e; echo task | RUN code-reviewer >/dev/null 2>&1; code=$?; set -e
[ "$code" = 2 ] || fail "the other agents stay on the Agent tool"
ok "backend: codex moves one agent"

# 2. delegate codex writes settings env; doctor/status/hook report it
DC delegate codex | grep -q "now run on Codex (codex-cli 9.9.9-fake)" || fail "delegate codex"
node -e 'const s=require(process.argv[1]); if(s.model!=="keep-me"||s.env.KESSELRUNNER_DELEGATE!=="codex"||s.env.KEEP_ME!=="yes") throw 1' "$CLAUDE_CONFIG_DIR/settings.json" || fail "settings env"
RUN status --hook | grep -q "delegation backend: codex (codex-cli 9.9.9-fake, model config.toml default)" || fail "hook line"
RUN status | grep -q "backend: codex" || fail "status"
ok "delegate codex: setting written, hook announces it"

# 3. dry run: sandbox default + network, instructions via developer_instructions
echo task | RUN code-reviewer --cwd "$SB" --dry-run > "$SB/dry.json"
node -e '
const d=require(process.argv[1]);
if(d.sandbox!=="workspace-write") throw "sandbox";
if(!d.argv.includes("sandbox_workspace_write.network_access=true")) throw "network";
if(!d.argv.includes("--ephemeral")||!d.argv.includes("hooks")) throw "ephemeral/hooks";
' "$SB/dry.json" || fail "dry run"
git -C "$SB" init -q 2>/dev/null || true
echo task | RUN code-reviewer --cwd "$SB" --dry-run | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);if(!Array.isArray(d.extraWritableDirs))throw "extra dirs";if(d.extraWritableDirs.some(x=>x.startsWith(process.argv[1]+"/")))throw "cwd subdir added"})' "$SB" || fail "extra writable dirs"
ok "dry run shape"
echo task | RUN literal-edge --cwd "$SB" > /dev/null
grep -q '^developer_instructions="""' "$FAKE_RECORD.argv" && grep -qF "contain ''' and must stay" "$FAKE_RECORD.argv" || fail "instructions containing a TOML literal delimiter not passed intact"
ok "TOML literal edge stays in developer instructions"

# 4. real run through the fake binary: prompt on stdin, only the report comes back
printf 'Review these files:\n- a.js\n' | RUN code-reviewer --cwd "$SB" > "$SB/out" 2>"$SB/err"
grep -q "fake verdict clean" "$SB/out" || fail "report not printed"
grep -q "via codex: exit 0" "$SB/out" || fail "trailer missing"
! grep -q "progress noise" "$SB/out" || fail "codex progress leaked to caller"
grep -q "Review these files" "$FAKE_RECORD.stdin" || fail "prompt not passed on stdin"
grep -q "^-C$" "$FAKE_RECORD.argv" && grep -qx "$SB" "$FAKE_RECORD.argv" || fail "cwd not passed"
grep -q '^developer_instructions="""' "$FAKE_RECORD.argv" && grep -q "You are a thorough code reviewer" "$FAKE_RECORD.argv" || fail "agent body not in developer_instructions"
grep -q 'spawned non-interactively by Claude Code' "$FAKE_RECORD.argv" || fail "harness note missing"
grep -q "progress noise" "$SB/logs"/code-reviewer-*.log || fail "codex output not streamed to the log"
printf 'x' | GH_TOKEN=test-token-value RUN code-reviewer --cwd "$SB" > /dev/null
grep -qx "gh_token=set" "$FAKE_RECORD.env" || fail "GH_TOKEN not handed to the worker"
! grep -rq "test-token-value" "$SB/logs" "$FAKE_RECORD.argv" || fail "GH token leaked into argv or logs"
ok "codex run: stdin prompt, developer instructions, clean report"

# 5. frontmatter knobs + --prompt-file + env override
printf 'watch pr 1' > "$SB/p.txt"
RUN watcher --cwd "$SB" --prompt-file "$SB/p.txt" > /dev/null
grep -qx "read-only" "$FAKE_RECORD.argv" && grep -qx "gpt-test" "$FAKE_RECORD.argv" || fail "frontmatter sandbox/model"
grep -q "watch pr 1" "$FAKE_RECORD.stdin" || fail "prompt file"
KESSELRUNNER_CODEX_SANDBOX=danger-full-access RUN code-reviewer --cwd "$SB" --prompt-file "$SB/p.txt" > /dev/null
grep -qx "danger-full-access" "$FAKE_RECORD.argv" && ! grep -q "network_access" "$FAKE_RECORD.argv" || fail "env sandbox override"
ok "frontmatter and env knobs"

# 5a. `codex: never` in an agent's frontmatter: the runner defers to the Agent tool and never starts Codex
rm -f "$FAKE_RECORD.argv"
set +e; echo task | RUN sim-only --cwd "$SB" >/dev/null 2>"$SB/err"; code=$?; set -e
[ "$code" = 2 ] && grep -q 'subagent_type: "sim-only"' "$SB/err" && grep -q 'codex: never' "$SB/err" || fail "codex: never exit code"
[ ! -e "$FAKE_RECORD.argv" ] || fail "codex: never still started Codex"
grep -q '^codex: never$' "$CORE/agents/ios-driver.md" || fail "ios-driver must opt out of Codex (the sandbox cannot reach the simulator)"
printf -- '---\nname: pinned\ndescription: x\nbackend: claude\n---\nStay.\n' > "$CLAUDE_CONFIG_DIR/agents/pinned.md"
set +e; echo task | RUN pinned --cwd "$SB" >/dev/null 2>"$SB/err"; code=$?; set -e
[ "$code" = 2 ] && grep -q 'backend: claude' "$SB/err" || fail "backend: claude exit code"
RUN status --hook | grep -q "except pinned, sim-only (the Agent tool always)" || fail "hook names the agents kept on Claude"
ok "codex: never and backend: claude keep an agent on the Agent tool"

# 5b. model/effort: list, validate, persist, reach the runner, clear
models_out="$(DC delegate models)"
grep -q "gpt-fast" <<<"$models_out" || fail "models list"
! grep -q "gpt-hidden" <<<"$models_out" || fail "hidden model listed"
set +e; DC delegate codex --model nope 2>"$SB/err"; c1=$?; DC delegate codex --model gpt-fast --effort max 2>>"$SB/err"; c2=$?; set -e
[ "$c1" = 1 ] && [ "$c2" = 1 ] && grep -q "unknown Codex model" "$SB/err" && grep -q "not supported" "$SB/err" || fail "model validation"
DC delegate codex --model gpt-fast --effort low | grep -q "model: gpt-fast, effort: low" || fail "set model"
DC delegate | grep -q "model: gpt-fast, effort: low" || fail "show model"
RUN status --hook | grep -q "model gpt-fast" || fail "hook shows model"
RUN code-reviewer --cwd "$SB" --prompt-file "$SB/p.txt" > /dev/null
grep -qx "gpt-fast" "$FAKE_RECORD.argv" && grep -qx 'model_reasoning_effort="low"' "$FAKE_RECORD.argv" || fail "model not passed to codex"
RUN watcher --cwd "$SB" --prompt-file "$SB/p.txt" > /dev/null
grep -qx "gpt-test" "$FAKE_RECORD.argv" || fail "frontmatter model should beat the global pick"
DC delegate codex --model default --effort default > /dev/null
DC delegate | grep -q "model: (Codex config.toml default)" || fail "clear model"
ok "model and effort selection"

# 6. unknown agent, then back to claude
set +e; echo x | RUN nope --cwd "$SB" 2>"$SB/err"; code=$?; set -e
[ "$code" = 3 ] && grep -q 'no agent named "nope"' "$SB/err" || fail "unknown agent"
DC delegate claude | grep -q "Claude subagents" || fail "delegate claude"
node -e 'const s=require(process.argv[1]); if(s.env?.KESSELRUNNER_DELEGATE||s.env?.KEEP_ME!=="yes"||s.model!=="keep-me") throw 1' "$CLAUDE_CONFIG_DIR/settings.json" || fail "settings keys not preserved"
ok "errors and switching back"

# 7. the keys from before the rename: read when the new ones are absent, and a switch drops them
node -e 'const f=process.argv[1],s=require(f);s.env={...s.env,DOTCLAUDE_DELEGATE:"codex",DOTCLAUDE_CODEX_MODEL:"gpt-fast"};require("fs").writeFileSync(f,JSON.stringify(s))' "$CLAUDE_CONFIG_DIR/settings.json"
DC delegate | grep -q "^delegation backend: codex" || fail "old DOTCLAUDE_DELEGATE not read"
DC delegate | grep -q "model: gpt-fast" || fail "old DOTCLAUDE_CODEX_MODEL not read"
DC delegate claude > /dev/null
node -e 'const s=require(process.argv[1]); if(s.env?.DOTCLAUDE_DELEGATE||s.env?.KESSELRUNNER_DELEGATE||s.env?.DOTCLAUDE_CODEX_MODEL!=="gpt-fast"||s.env?.KEEP_ME!=="yes") throw 1' "$CLAUDE_CONFIG_DIR/settings.json" || fail "switch did not drop the old backend key"
unset KESSELRUNNER_CODEX_BIN; DOTCLAUDE_CODEX_BIN="$FAKE" DC delegate codex | grep -q "codex-cli 9.9.9-fake" || fail "old DOTCLAUDE_CODEX_BIN not read"
export KESSELRUNNER_CODEX_BIN="$FAKE"; DC delegate claude > /dev/null
ok "old DOTCLAUDE_* keys still work"
printf '%s' '{not-json}' > "$CLAUDE_CONFIG_DIR/settings.json"
set +e
DC delegate claude 2>"$SB/err"
code=$?
set -e
[ "$code" = 1 ] && grep -q "cannot parse" "$SB/err" && grep -q '{not-json}' "$CLAUDE_CONFIG_DIR/settings.json" || fail "malformed settings clobbered"
ok "malformed settings is not overwritten"

rm -rf "$SB"
echo "all passed"
