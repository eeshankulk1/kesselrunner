#!/usr/bin/env bash
# End-to-end check of install/sync in a throwaway HOME and npm prefix.
# Real network (installs docsic from npm). Never touches the real ~/.claude.
#   bash test/sandbox.sh
set -euo pipefail
CORE="$(cd "$(dirname "$0")/.." && pwd)"
SB="$(mktemp -d)"
# Scrub every kesselrunner/Codex knob (and the DOTCLAUDE_* names from before the rename) from the developer's own environment, then set ours.
unset $(env | sed -nE 's/^((KESSELRUNNER|DOTCLAUDE)_[A-Z_]*)=.*/\1/p') CODEX_CLI_PATH CLAUDE_CONFIG_DIR 2>/dev/null || true
export HOME="$SB/home" npm_config_prefix="$SB/npm" KESSELRUNNER_SYNC_THROTTLE_MS=1
export PATH="$SB/npm/bin:$PATH"
mkdir -p "$HOME"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }
DC() { node "$CORE/bin/kesselrunner.mjs" "$@"; }

# overlay fixture
OV="$SB/overlay"; mkdir -p "$OV/skills/mine"
printf '# Personal\nI like tabs.\n' > "$OV/CLAUDE.md"
printf -- '---\nname: mine\ndescription: x\n---\n' > "$OV/skills/mine/SKILL.md"
printf '{ "model": "opus", "theme": "dark" }\n' > "$OV/settings.json"
printf '{ "hub": { "root": "%s/hub", "sync": "none" } }\n' "$SB" > "$OV/docsic.json"
mkdir -p "$OV/hooks/pre-tool-use"; printf 'export const tools = /^Read$/;\nexport function check() { return null; }\n' > "$OV/hooks/pre-tool-use/fixture.mjs"
mkdir -p "$OV/rules"; printf -- '---\ndescription: a fixture rule\n---\n## Fixture rule (plain)\nWrite plainly.\n' > "$OV/rules/plain.md"

# 1. fresh install
DC install --overlay "$OV" > "$SB/install.log" 2>&1 || { cat "$SB/install.log"; fail "install"; }
C="$HOME/.claude"
[ -L "$C/skills/pr-create" ] || fail "core skill not linked"
[ -L "$C/skills/mine" ] || fail "overlay skill not linked"
[ -L "$C/agents/code-reviewer.md" ] || fail "agent not linked"
[ "$(readlink "$C/kesselrunner")" = "$CORE" ] || fail "~/.claude/kesselrunner link"
grep -q "kesselrunner:begin" "$C/CLAUDE.md" && grep -q "I like tabs" "$C/CLAUDE.md" || fail "CLAUDE.md block"
node -e '
const s=require(process.argv[1]);
const cmds=Object.values(s.hooks).flat().flatMap(e=>e.hooks.map(h=>h.command));
if(!cmds.some(c=>c.includes("bin/kesselrunner.mjs\" sync"))) throw "sync hook";
if(!cmds.some(c=>/docsic" hook session-start/.test(c))) throw "docsic hook";
if(!cmds.some(c=>/packages\/rollcall\/bin\/rollcall.mjs" hook session-start/.test(c))) throw "rollcall hook";
if(!cmds.some(c=>c.endsWith(`scripts/hooks/pre-tool-use.mjs" "${process.argv[3]}"`))||!cmds.some(c=>/scripts\/hooks\/post-tool-use.mjs"$/.test(c))) throw "tool hooks";
if(cmds.some(c=>c.includes("{{"))) throw "unsubstituted var";
if(!s.hooks.PreToolUse[0].matcher.split("|").includes("^Read$")) throw "overlay guard tools missing from the PreToolUse matcher";
if(s.model!=="opus"||s.theme!=="dark") throw "overlay settings";
if(!s.enabledPlugins["playwright@claude-plugins-official"]) throw "core plugins";
if(s.extraKnownMarketplaces?.kesselrunner?.source?.path!==process.argv[2]) throw "mods marketplace path";
if(!s.enabledPlugins["rollcall-band@kesselrunner"]||!s.enabledPlugins["pr-band@kesselrunner"]) throw "core mods";
' "$C/settings.json" "$CORE" "$OV" || fail "settings.json"
# every mod the marketplace lists by path is in the checkout the setting points at
node -e '
const fs=require("fs"),core=process.argv[1];
for(const p of require(core+"/.claude-plugin/marketplace.json").plugins)
  if(typeof p.source==="string"&&!fs.existsSync(core+"/"+p.source+"/.claude-plugin/plugin.json")) throw p.name;
' "$CORE" || fail "marketplace lists a mod that is not in the repo"
node -e 'const c=require(process.argv[1]); if(c.distill!=="auto"||!c.hub) throw 1' "$HOME/.docsic/config.json" || fail "docsic config"
[ -x "$SB/npm/bin/docsic" ] || fail "docsic not installed"
[ -x "$SB/npm/bin/rollcall" ] || fail "rollcall not on PATH"
[ -x "$SB/npm/bin/iosim" ] || fail "iosim not on PATH"
[ -x "$SB/npm/bin/falcon" ] || fail "falcon not on PATH"
ok "fresh install"

# 2. idempotent
DC sync | grep -q "already in sync" || fail "second sync changed something"
ok "second sync is a no-op"

# 3. user edits survive; user's own CLAUDE.md text survives
node -e 'const f=process.argv[1],s=require(f);s.model="sonnet";s.myKey=1;require("fs").writeFileSync(f,JSON.stringify(s))' "$C/settings.json"
printf '\nmy own rule\n' >> "$C/CLAUDE.md"
printf '{ "model": "haiku", "theme": "dark" }\n' > "$OV/settings.json"   # overlay changes its default
DC sync > /dev/null
node -e 'const s=require(process.argv[1]); if(s.model!=="sonnet"||s.myKey!==1) throw 1' "$C/settings.json" || fail "user override lost"
grep -q "my own rule" "$C/CLAUDE.md" || fail "user CLAUDE.md text lost"
ok "user edits win over kesselrunner defaults"

# 4. removed from core/overlay -> pruned; user's own same-name skill untouched
rm -rf "$OV/skills/mine"; mkdir -p "$C/skills/own"; DC sync > /dev/null
[ ! -e "$C/skills/mine" ] || fail "stale overlay link kept"
[ -d "$C/skills/own" ] || fail "user skill removed"
ok "stale links pruned, user skills kept"

# 5. optional rules (the overlay's fixture): off by default; on adds a section the next sync keeps; off restores the block; an off holds against an overlay default
cp "$C/CLAUDE.md" "$SB/claude-before.md"
! grep -q "Fixture rule (plain)" "$C/CLAUDE.md" || fail "a rule is on by default"
DC rules on plain > /dev/null || fail "rules on"
grep -q "Fixture rule (plain)" "$C/CLAUDE.md" || fail "rule not added to CLAUDE.md"
grep -q "my own rule" "$C/CLAUDE.md" || fail "rules on lost the user's CLAUDE.md text"
DC sync | grep -q "already in sync" || fail "sync after rules on changed something"
DC rules off plain > /dev/null || fail "rules off"
cmp -s "$C/CLAUDE.md" "$SB/claude-before.md" || fail "rules off did not restore CLAUDE.md"
printf '{ "model": "haiku", "theme": "dark", "env": { "KESSELRUNNER_RULES": "plain" } }\n' > "$OV/settings.json"   # overlay switches it on by default
DC sync > /dev/null
cmp -s "$C/CLAUDE.md" "$SB/claude-before.md" || fail "an overlay default overrode rules off"
node -e 'const f=process.argv[1],s=require(f);delete s.env.KESSELRUNNER_RULES;require("fs").writeFileSync(f,JSON.stringify(s))' "$C/settings.json"
DC sync > /dev/null
grep -q "Fixture rule (plain)" "$C/CLAUDE.md" || fail "overlay default did not switch the rule on"
ok "optional rules: on, off, and an overlay default"

# 6. legacy layout: ~/.claude symlinked to a core checkout holding runtime state
H2="$SB/home2"; mkdir -p "$H2"
LEG="$SB/legacy-core"; git clone -q "$CORE" "$LEG"
mkdir -p "$LEG/projects/p1" "$LEG/sessions"; echo t > "$LEG/projects/p1/t.jsonl"; echo h > "$LEG/history.jsonl"
ln -s "$SB/elsewhere-skill" "$LEG/skills/thirdparty"; mkdir -p "$SB/elsewhere-skill"
printf '{ "model": "legacy-model", "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "node \\"$HOME/.claude/scripts/memory-kernel/session-start.mjs\\"" }, { "type": "command", "command": "node \\"$HOME/.claude/scripts/codex-bridge/generate.mjs\\"" } ] } ] } }\n' > "$LEG/settings.json"
ln -s "$LEG" "$H2/.claude"
HOME="$H2" node "$CORE/bin/kesselrunner.mjs" install --force > "$SB/legacy.log" 2>&1 || { cat "$SB/legacy.log"; fail "legacy install"; }
C2="$H2/.claude"
[ -d "$C2" ] && [ ! -L "$C2" ] || fail "~/.claude still a symlink"
[ -f "$C2/projects/p1/t.jsonl" ] && [ -f "$C2/history.jsonl" ] || fail "runtime state not moved"
[ "$(readlink "$C2/skills/thirdparty")" = "$SB/elsewhere-skill" ] || fail "third-party skill link not re-pointed"
[ ! -e "$LEG/history.jsonl" ] || fail "runtime state left in core"
node -e '
const s=require(process.argv[1]);
const cmds=Object.values(s.hooks).flat().flatMap(e=>e.hooks.map(h=>h.command));
if(cmds.some(c=>c.includes("memory-kernel")||c.includes(".claude/scripts/"))) throw "legacy hook kept";
if(s.model!=="legacy-model") throw "user model lost";
' "$C2/settings.json" || fail "legacy settings"
ok "symlinked ~/.claude converted, runtime state kept, legacy hooks removed"

HOME="$H2" node "$CORE/bin/kesselrunner.mjs" doctor > "$SB/doctor.log" || { cat "$SB/doctor.log"; fail "doctor"; }
grep -q "^delegation: claude" "$SB/doctor.log" || fail "doctor delegation line"
grep -q "^rules: (none)" "$SB/doctor.log" || fail "doctor rules line"
grep -q "^tools: " "$SB/doctor.log" || fail "doctor tools line"
ok "doctor clean"

# 7. a malformed settings.json is reported, never overwritten by sync
printf '{ "model": ' > "$C/settings.json"
DC sync > "$SB/bad.log" 2>&1 || true
[ "$(cat "$C/settings.json")" = '{ "model": ' ] || fail "sync overwrote a malformed settings.json"
! DC doctor > "$SB/doctor-bad.log" && grep -q "settings.json is invalid" "$SB/doctor-bad.log" || fail "doctor did not report malformed settings"
ok "malformed settings.json left alone and reported"
# 8. the switch from dotclaude: a home installed by the last commit before the rename, then the old
# SessionStart hook's own sync (old code in memory) pulls this commit and reconciles in a fresh process.
# The new code is the committed HEAD, as in case 6. Needs the history (CI checks out with fetch-depth 0).
ADDED="$(git -C "$CORE" log --format=%H --diff-filter=A -1 -- bin/kesselrunner.mjs 2>/dev/null || true)"
if [ -z "$ADDED" ] || ! git -C "$CORE" rev-parse -q --verify "$ADDED^" > /dev/null; then
  echo "skip - rename upgrade (no commit from before the rename in this clone)"
else
  ORIGIN="$SB/origin.git"; git init -q --bare -b main "$ORIGIN"
  git -C "$CORE" push -q "$ORIGIN" "$ADDED^:refs/heads/main"
  K="$SB/core3"; git clone -q "$ORIGIN" "$K"; K="$(cd "$K" && pwd -P)"
  H3="$SB/home3"; P3="$SB/npm3"; C3="$H3/.claude"; mkdir -p "$H3" "$P3/lib/node_modules" "$P3/bin"
  # docsic from case 1, so this home needs no second download
  cp -R "$SB/npm/lib/node_modules/@eeshkulk" "$P3/lib/node_modules/" && cp -P "$SB/npm/bin/docsic" "$P3/bin/"
  run3() { HOME="$H3" npm_config_prefix="$P3" PATH="$P3/bin:$PATH" CODEX_HOME="$H3/.codex" DOTCLAUDE_SYNC_THROTTLE_MS=1 "$@"; }
  OV3="$SB/overlay3"; mkdir -p "$OV3/rules"
  printf '# Personal\nOverlay three.\n' > "$OV3/CLAUDE.md"
  cp "$OV/rules/plain.md" "$OV3/rules/"
  # an overlay that still says {{DOTCLAUDE}} and sets a DOTCLAUDE_* default (brain/harness may, until it is updated)
  printf '{ "env": { "DOTCLAUDE_RULES": "plain" }, "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node \\"{{DOTCLAUDE}}/overlay-hook.mjs\\"" } ] } ] } }\n' > "$OV3/settings.json"
  run3 node "$K/bin/dotclaude.mjs" install --overlay "$OV3" > "$SB/old-install.log" 2>&1 || { cat "$SB/old-install.log"; fail "install at the commit before the rename"; }
  [ -f "$C3/.dotclaude/state.json" ] && [ -L "$P3/lib/node_modules/dotclaude" ] || fail "old install did not leave the old layout"
  # the user's own choices under the old names
  node -e '
const f=process.argv[1],s=require(f);
s.enabledPlugins["clickable@dotclaude"]=false;
s.env={...s.env,DOTCLAUDE_CODEX_ADD_DIRS:"/a:/b",DOTCLAUDE_CODEX_MODEL:"m-old",KESSELRUNNER_CODEX_MODEL:"m-new"};
require("fs").writeFileSync(f,JSON.stringify(s));' "$C3/settings.json"
  printf '\nmy own rule\n' >> "$C3/CLAUDE.md"
  run3 node "$K/scripts/codex-bridge/generate.mjs" > /dev/null 2>&1 || fail "old codex-bridge"
  grep -q "GENERATED by dotclaude codex-bridge" "$H3/.codex/AGENTS.md" || fail "old bridge marker missing"
  git -C "$CORE" push -q -f "$ORIGIN" HEAD:refs/heads/main
  run3 node "$K/bin/dotclaude.mjs" sync --quiet > "$SB/switch.log" 2>&1 || { cat "$SB/switch.log"; fail "the switch sync"; }
  [ -f "$K/bin/kesselrunner.mjs" ] || { cat "$SB/switch.log"; fail "the old sync did not pull the rename"; }
  grep -q "migration 003-rename-to-kesselrunner" "$SB/switch.log" || { cat "$SB/switch.log"; fail "migration 003 did not run in the switch"; }
  [ -f "$C3/.kesselrunner/state.json" ] || fail "state not carried"
  [ -z "$(ls -A "$C3/.dotclaude" 2>/dev/null)" ] || fail "old state dir still holds something"
  node -e '
const st=require(process.argv[1]);
const m=st.migrations;
for(const id of ["001-retire-memory-kernel","002-drop-claude-dir-script-hooks","003-rename-to-kesselrunner"]) if(m.filter(x=>x===id).length!==1) throw "migration "+id+" ran "+m.filter(x=>x===id).length+" times";
' "$C3/.kesselrunner/state.json" || fail "state migrations"
  [ "$(readlink "$C3/kesselrunner")" = "$K" ] || fail "~/.claude/kesselrunner link"
  [ "$(readlink "$C3/dotclaude")" = "kesselrunner" ] && [ -f "$C3/dotclaude/bin/kesselrunner.mjs" ] || fail "~/.claude/dotclaude link"
  [ "$(grep -c "kesselrunner:begin" "$C3/CLAUDE.md")" = 1 ] && ! grep -q "dotclaude:begin\|dotclaude:end" "$C3/CLAUDE.md" || fail "CLAUDE.md block duplicated or old markers kept"
  grep -q "my own rule" "$C3/CLAUDE.md" && grep -q "Overlay three" "$C3/CLAUDE.md" && grep -q "Fixture rule (plain)" "$C3/CLAUDE.md" || fail "CLAUDE.md lost text or the overlay rule"
  node -e '
const s=require(process.argv[1]),core=process.argv[2];
const cmds=Object.values(s.hooks).flat().flatMap(e=>e.hooks.map(h=>h.command));
if(cmds.some(c=>c.includes("dotclaude.mjs"))) throw "old hook command kept";
if(!cmds.some(c=>c.includes("bin/kesselrunner.mjs\" sync"))) throw "new sync hook";
if(new Set(cmds).size!==cmds.length) throw "duplicate hook commands";
if(!cmds.includes("node \""+core+"/overlay-hook.mjs\"")) throw "overlay {{DOTCLAUDE}} hook";
if(cmds.some(c=>c.includes("{{"))) throw "unsubstituted var";
const keys=Object.keys(s.enabledPlugins);
if(keys.some(k=>k.endsWith("@dotclaude"))) throw "old plugin keys";
if(s.enabledPlugins["clickable@kesselrunner"]!==false) throw "a mod switched off came back on";
if(s.enabledPlugins["rollcall-band@kesselrunner"]!==true||s.enabledPlugins["pr-band@kesselrunner"]!==true) throw "mods";
if(s.extraKnownMarketplaces.dotclaude||s.extraKnownMarketplaces.kesselrunner?.source?.path!==core) throw "marketplace";
const e=s.env;
if(e.KESSELRUNNER_CODEX_ADD_DIRS!=="/a:/b"||"DOTCLAUDE_CODEX_ADD_DIRS" in e) throw "user env key not carried";
if(e.KESSELRUNNER_CODEX_MODEL!=="m-new"||e.DOTCLAUDE_CODEX_MODEL!=="m-old") throw "differing env keys must both stay";
if(e.DOTCLAUDE_RULES!=="plain") throw "overlay default key is sync-owned and stays until the overlay renames it";
' "$C3/settings.json" "$K" || fail "settings after the switch"
  [ -x "$P3/bin/kesselrunner" ] && [ ! -e "$P3/lib/node_modules/dotclaude" ] || fail "npm link not moved to kesselrunner"
  [ "$(cd "$P3/bin" && realpath dotclaude)" = "$K/bin/dotclaude.mjs" ] || fail "dotclaude command"
  run3 dotclaude doctor > "$SB/doctor3.log" || { cat "$SB/doctor3.log"; fail "doctor through the old command"; }
  run3 node "$K/scripts/codex-bridge/generate.mjs" > /dev/null 2>&1 || fail "new codex-bridge"
  ! grep -rq "GENERATED by dotclaude codex-bridge" "$H3/.codex" && grep -q "GENERATED by kesselrunner codex-bridge" "$H3/.codex/AGENTS.md" || fail "codex files under the old marker not regenerated"
  run3 kesselrunner sync | grep -q "already in sync" || fail "sync after the switch changed something"
  [ ! -e "$C3/.dotclaude" ] || fail "empty old state dir kept"
  ok "switch from dotclaude: state, link, CLAUDE.md, hooks, env, mods, npm and codex carried"
fi
# 9. install.sh, the documented one-line install: plain git, no gh, from an origin given as a path; then
# again over the same clone, which it pulls instead of cloning.
O4="$SB/origin4.git"; git init -q --bare -b main "$O4"; git -C "$CORE" push -q "$O4" HEAD:refs/heads/main
H4="$SB/home4"; P4="$SB/npm4"; K4="$SB/core4"; mkdir -p "$H4" "$P4/lib/node_modules" "$P4/bin"
cp -R "$SB/npm/lib/node_modules/@eeshkulk" "$P4/lib/node_modules/" && cp -P "$SB/npm/bin/docsic" "$P4/bin/"
run4() { HOME="$H4" npm_config_prefix="$P4" PATH="$P4/bin:$PATH" KESSELRUNNER_REPO="$O4" KESSELRUNNER_DIR="$K4" bash "$CORE/install.sh" "$@"; }
run4 --overlay "$OV" > "$SB/install4.log" 2>&1 || { cat "$SB/install4.log"; fail "install.sh"; }
[ "$(git -C "$K4" rev-parse HEAD)" = "$(git -C "$CORE" rev-parse HEAD)" ] || fail "install.sh did not clone the origin"
[ "$(readlink "$H4/.claude/kesselrunner")" = "$(cd "$K4" && pwd -P)" ] || [ "$(readlink "$H4/.claude/kesselrunner")" = "$K4" ] || fail "install.sh: ~/.claude/kesselrunner link"
[ -x "$P4/bin/kesselrunner" ] && [ -x "$P4/bin/falcon" ] || fail "install.sh: commands not on PATH"
run4 > "$SB/install4b.log" 2>&1 || { cat "$SB/install4b.log"; fail "install.sh over an existing clone"; }
KESSELRUNNER_REPO="nope" bash "$CORE/install.sh" > /dev/null 2>&1 && fail "install.sh took a bare word as the repo"
ok "install.sh: clone over plain git, then a pull over the same clone"
[ -n "${KEEP_SB:-}" ] && echo "kept $SB" || rm -rf "$SB"
echo "all passed"
