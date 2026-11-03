// `kesselrunner rules`: the switch for optional rules and the CLAUDE.md block it
// rewrites. Runs the CLI in a throwaway HOME whose overlay holds a fixture rule
// (the core ships the mechanism, not rules of its own).
// Offline: a toggle re-applies only the CLAUDE.md step of a sync, never a pull
// or an install.
//   node --test test/rules.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { enabledRules, listRules } from "../lib/rules.mjs";

const CORE = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const OVERLAY_TEXT = "# Personal\nI like tabs.";
const HEADING = "## Plain words (fixture)";
const RULE = `---\ndescription: Short words over long ones\n---\n${HEADING}\n\n1. Use the short word.\n2. Cut what you can.\n\n\`kesselrunner rules off plain\` turns it off.\n`;

/** A rules/ directory under `root` holding { name: text }. */
function rulesDir(root, files) {
  mkdirSync(join(root, "rules"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "rules", name), text);
  return root;
}

/** A throwaway HOME that has been synced once with an overlay: { home, claudeMd, settings }. */
function setup(settings) {
  const home = mkdtempSync(join(tmpdir(), "kesselrunner-rules-"));
  const overlay = join(home, "overlay");
  mkdirSync(overlay);
  writeFileSync(join(overlay, "CLAUDE.md"), `${OVERLAY_TEXT}\n`);
  rulesDir(overlay, { "plain.md": RULE });
  mkdirSync(join(home, ".claude", ".kesselrunner"), { recursive: true });
  writeFileSync(join(home, ".claude", ".kesselrunner", "state.json"), JSON.stringify({ core: CORE, overlay }));
  if (settings) writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings));
  return { home, claudeMd: join(home, ".claude", "CLAUDE.md"), settings: join(home, ".claude", "settings.json") };
}

function dc(home, ...args) {
  // Scrub the developer's own kesselrunner knobs (and their names from before the rename), as the shell suites do.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("KESSELRUNNER_") && !k.startsWith("DOTCLAUDE_") && k !== "CLAUDE_CONFIG_DIR"));
  return spawnSync(process.execPath, [join(CORE, "bin", "kesselrunner.mjs"), ...args], { encoding: "utf8", env: { ...env, HOME: home, npm_config_prefix: join(home, "npm") } });
}

const read = (p) => readFileSync(p, "utf8");
const rulesEnv = (s) => JSON.parse(read(s.settings)).env?.KESSELRUNNER_RULES;

/** The block as sync wrote it before optional rules existed: the core's text, then the overlay's. */
function blockWithoutRules(text) {
  const begin = text.split("\n")[0];
  assert.match(begin, /^<!-- kesselrunner:begin/);
  const core = read(join(CORE, "CLAUDE.md")).trim().replaceAll("{{KESSELRUNNER}}", CORE).replaceAll("{{DOCSIC}}", "docsic");
  return `${begin}\n\n${core}\n\n${OVERLAY_TEXT}\n\n<!-- kesselrunner:end -->\n`;
}

test("rules load from the core and the overlay with a name, a description, and a body without its frontmatter", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kesselrunner-rules-list-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const core = rulesDir(join(root, "core"), { "both.md": "---\ndescription: core's\n---\ncore body\n", "zcore.md": "no frontmatter\n", ".hidden.md": "x", "notes.txt": "x" });
  const overlay = rulesDir(join(root, "overlay"), { "both.md": "---\ndescription: overlay's\n---\noverlay body\n", "plain.md": RULE });
  assert.deepEqual(listRules(core).map((r) => r.name), ["both", "zcore"]);
  const all = listRules(core, overlay);
  assert.deepEqual(all.map((r) => r.name), ["both", "plain", "zcore"], "sorted by name, one entry per name");
  assert.deepEqual(all[0], { name: "both", description: "overlay's", body: "overlay body" }, "the overlay's wins on a shared name");
  assert.deepEqual(all[2], { name: "zcore", description: "", body: "no frontmatter" });
  const plain = all[1];
  assert.equal(plain.description, "Short words over long ones");
  assert.ok(plain.body.startsWith(HEADING));
  assert.ok(!plain.body.includes("description:"));
  assert.deepEqual(listRules(join(root, "none"), null), [], "a root without rules/ offers none");
});

test("the switched-on list is read from a comma-separated value", () => {
  assert.deepEqual(enabledRules({ KESSELRUNNER_RULES: " a, b ,," }), ["a", "b"]);
  assert.deepEqual(enabledRules({ KESSELRUNNER_RULES: "" }), []);
  assert.deepEqual(enabledRules({}), []);
  assert.deepEqual(enabledRules(undefined), []);
});

test("a rule is off until switched on, and with none on the block is the core's text plus the overlay's", () => {
  const s = setup();
  assert.match(dc(s.home, "rules").stdout, /^plain\s+off\s/m);
  assert.equal(dc(s.home, "rules", "off", "plain").status, 0);
  assert.equal(read(s.claudeMd), blockWithoutRules(read(s.claudeMd)));
});

test("on adds an overlay rule between the core's text and the overlay's; off restores the block byte for byte", () => {
  const s = setup();
  dc(s.home, "rules", "off", "plain");
  const before = read(s.claudeMd);

  const on = dc(s.home, "rules", "on", "plain");
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /rules on: plain/);
  assert.equal(rulesEnv(s), "plain");
  const text = read(s.claudeMd);
  const at = (needle) => { const i = text.indexOf(needle); assert.ok(i >= 0, `block has "${needle}"`); return i; };
  assert.ok(at("## Agents & Skills") < at(HEADING) && at(HEADING) < at(OVERLAY_TEXT) && at(OVERLAY_TEXT) < at("<!-- kesselrunner:end -->"));
  assert.ok(text.includes("`kesselrunner rules off plain` turns it off."));
  assert.ok(!text.includes("description: Short"), "frontmatter stays out of CLAUDE.md");
  assert.match(dc(s.home, "rules").stdout, /^plain\s+on\s/m);

  dc(s.home, "rules", "on", "plain"); // a second on changes nothing
  assert.equal(rulesEnv(s), "plain");
  assert.equal(read(s.claudeMd), text);

  assert.equal(dc(s.home, "rules", "off", "plain").status, 0);
  assert.equal(read(s.claudeMd), before);
  assert.equal(rulesEnv(s), "", "the choice stays recorded, so an overlay default cannot switch it back on");
});

test("a toggle keeps the user's own CLAUDE.md text, settings keys and env keys", () => {
  const s = setup({ model: "keep-me", env: { KEEP_ME: "yes" } });
  dc(s.home, "rules", "off", "plain");
  writeFileSync(s.claudeMd, `${read(s.claudeMd)}\nmy own rule\n`);
  assert.equal(dc(s.home, "rules", "on", "plain").status, 0);
  assert.ok(read(s.claudeMd).endsWith("<!-- kesselrunner:end -->\n\nmy own rule\n"));
  const settings = JSON.parse(read(s.settings));
  assert.equal(settings.model, "keep-me");
  assert.deepEqual(settings.env, { KEEP_ME: "yes", KESSELRUNNER_RULES: "plain" });
});

test("an unknown name or action is refused and nothing is written", () => {
  const s = setup();
  const bad = dc(s.home, "rules", "on", "nope");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown rule "nope" \(one of .*plain/);
  assert.equal(dc(s.home, "rules", "on").status, 1);
  assert.equal(dc(s.home, "rules", "maybe", "plain").status, 1);
  assert.ok(!existsSync(s.settings) && !existsSync(s.claudeMd));
});

test("a rule that is on but gone from the core and the overlay is skipped with a warning, reported by doctor, and cleared by off", () => {
  const s = setup({ env: { KESSELRUNNER_RULES: "gone,plain" } });
  const on = dc(s.home, "rules", "on", "plain");
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /warning: rule "gone" is switched on but in neither the core nor the overlay/);
  assert.ok(read(s.claudeMd).includes(HEADING));
  const doctor = dc(s.home, "doctor").stdout;
  assert.match(doctor, /^rules: gone, plain$/m);
  assert.match(doctor, /rule "gone" is switched on but in neither the core nor the overlay/);
  assert.equal(dc(s.home, "rules", "off", "gone").status, 0);
  assert.equal(rulesEnv(s), "plain");
});

test("the rules key from before the rename is read when the new one is absent", () => {
  assert.deepEqual(enabledRules({ DOTCLAUDE_RULES: "a,b" }), ["a", "b"]);
  assert.deepEqual(enabledRules({ DOTCLAUDE_RULES: "a", KESSELRUNNER_RULES: "b" }), ["b"]);
  assert.deepEqual(enabledRules({ DOTCLAUDE_RULES: "a", KESSELRUNNER_RULES: "" }), [], "an empty new key is a choice, not a gap");
});

test("a home set up before the rename: state moves, the old block is replaced, the old key gives way", () => {
  const s = setup({ env: { DOTCLAUDE_RULES: "plain", KEEP_ME: "yes" } });
  const claude = join(s.home, ".claude");
  mkdirSync(join(claude, ".dotclaude"));
  renameSync(join(claude, ".kesselrunner", "state.json"), join(claude, ".dotclaude", "state.json"));
  rmdirSync(join(claude, ".kesselrunner"));
  writeFileSync(s.claudeMd, "<!-- dotclaude:begin - old -->\nold text\n<!-- dotclaude:end -->\n\nmy own rule\n");
  assert.match(dc(s.home, "doctor").stdout, /^rules: plain$/m, "doctor reads the old state and key without moving anything");
  assert.ok(existsSync(join(claude, ".dotclaude", "state.json")));
  const off = dc(s.home, "rules", "off", "plain");
  assert.equal(off.status, 0, off.stderr);
  assert.ok(existsSync(join(claude, ".kesselrunner", "state.json")) && !existsSync(join(claude, ".dotclaude")));
  const md = read(s.claudeMd);
  assert.ok(!md.includes("dotclaude:") && !md.includes("old text"));
  assert.equal(md.split("<!-- kesselrunner:begin").length, 2);
  assert.ok(md.endsWith("<!-- kesselrunner:end -->\n\nmy own rule\n"));
  assert.deepEqual(JSON.parse(read(s.settings)).env, { KEEP_ME: "yes", KESSELRUNNER_RULES: "" });
});
