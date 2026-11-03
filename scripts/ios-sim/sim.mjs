#!/usr/bin/env node
// iosim: drive an iOS simulator from an agent. A thin layer over AXe
// (https://github.com/cameroncooke/AXe, taps and typing through the
// simulator's accessibility and HID interfaces) and `xcrun simctl`, shaped
// for an agent's context: the accessibility tree comes back as a few KB of
// one-line elements instead of AXe's ~0.5 MB of JSON, screenshots come with
// a small copy to look at, and the only simulators it deletes are the ones
// it created.
//
//   iosim doctor                                   is AXe installed, and where
//   iosim install                                  download the pinned AXe release (checksum-verified; no brew, no sudo)
//   iosim new [--device NAME] [--runtime VERSION]  create and boot a throwaway simulator; prints its UDID
//   iosim delete --udid U                          delete a simulator iosim created (refuses any other)
//   iosim ui --udid U [--all] [--grep REGEX]       what is on screen, one element per line
//   iosim at --udid U X Y                          the element a tap at X,Y would land on
//   iosim wait --udid U (--id ID | --label L | --text T) [--gone] [--timeout S]
//   iosim shot --udid U --out FILE.png [--width W] screenshot, plus FILE.small.png (default: 1 px per screen point)
//   iosim tap|type|swipe|batch|button|key|key-combo|gesture|touch|drag|... --udid U   passed to AXe as is
//   iosim help <axe command>                       AXe's own help for that command
//
// Exit codes: 0 done; 1 the thing asked for did not happen (wait timed out,
// AXe failed); 3 usage, or AXe / the simulator is not there.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { compact, devicesOf, find, flatten, isOurSim, pickDevice, simName, staleSims } from "./core.mjs";

// The AXe release this was written against. Bump both together.
const AXE_VERSION = "1.8.0";
const AXE_SHA256 = "7b76340b72e90d0f211bc7c4636f15009076eff07acef2f2b632b175debd8834";
const AXE_URL = `https://github.com/cameroncooke/AXe/releases/download/v${AXE_VERSION}/AXe-macOS-v${AXE_VERSION}-universal.tar.gz`;
const AXE_DIR = join(homedir(), ".local", "share", "kesselrunner", "axe", AXE_VERSION);
const LEGACY_AXE_DIR = join(homedir(), ".local", "share", "dotclaude", "axe", AXE_VERSION);
const DEVICES = ["iPhone 17 Pro", "iPhone 16 Pro", "iPhone 17", "iPhone 16"];
// A run that died before its teardown leaves its simulator behind; the next `new` removes those.
const STALE_AFTER_S = 6 * 3600;

function die(msg, code = 3) { process.stderr.write(`iosim: ${msg}\n`); process.exit(code); }
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...opts });
const simctl = (...args) => run("xcrun", ["simctl", ...args]);

/** $IOSIM_AXE, then the pinned copy `iosim install` put down, then `axe` on PATH. */
function findAxe() {
  if (process.env.IOSIM_AXE) return existsSync(process.env.IOSIM_AXE) ? process.env.IOSIM_AXE : null;
  for (const dir of [AXE_DIR, LEGACY_AXE_DIR]) { // the second: where it went before the rename
    const pinned = join(dir, "axe");
    if (existsSync(pinned)) return pinned;
  }
  try { return run("sh", ["-c", "command -v axe"]).trim() || null; } catch { return null; }
}
function axeOrDie() {
  return findAxe() ?? die("AXe is not installed - run `iosim install` (a checksum-verified download into ~/.local/share/kesselrunner/axe)");
}

function parseFlags(argv, spec) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!Object.hasOwn(spec, arg)) { if (arg.startsWith("--")) die(`unknown option "${arg}"`); rest.push(arg); continue; }
    if (spec[arg] === Boolean) { flags[arg.slice(2)] = true; continue; }
    const value = argv[++i];
    if (value === undefined) die(`${arg} requires a value`);
    flags[arg.slice(2)] = value;
  }
  return { flags, rest };
}

/** { tree } or { error }. AXe has nothing to say for a moment after a launch or a transition: try again. */
function readTree(udid, point) {
  const axe = findAxe();
  if (!axe) return { error: "AXe is not installed - run `iosim install`" };
  let last = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt) sleep(700);
    const r = spawnSync(axe, ["describe-ui", "--udid", udid, ...(point ? ["--point", point] : [])], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0 && r.stdout.trim()) {
      try { return { tree: JSON.parse(r.stdout) }; } catch { last = "AXe printed something that is not JSON"; continue; }
    }
    last = (r.stderr || r.stdout || "").trim().split("\n")[0] || `axe exited ${r.status}`;
  }
  return { error: last };
}
function tree(udid, point) {
  axeOrDie();
  const r = readTree(udid, point);
  return r.tree ?? die(`could not read the screen: ${r.error}. Is the simulator booted and an app in front? A screenshot (iosim shot) shows what is.`, 1);
}

const commands = {
  doctor() {
    const axe = findAxe();
    if (!axe) { console.log(`AXe: not installed (pinned ${AXE_VERSION}) - run \`iosim install\``); process.exit(3); }
    let version = "unknown";
    try { version = run(axe, ["--version"]).trim(); } catch {}
    console.log(`AXe: ${version} at ${axe}${axe.startsWith(AXE_DIR) || version.includes(AXE_VERSION) ? "" : ` (iosim was written against ${AXE_VERSION})`}`);
    try { console.log(`Xcode: ${run("xcodebuild", ["-version"]).trim().split("\n")[0]}`); } catch { die("xcodebuild is not available - install Xcode"); }
  },

  install() {
    const bin = join(AXE_DIR, "axe");
    if (existsSync(bin)) { console.log(`AXe ${AXE_VERSION} is already at ${bin}`); return; }
    // Staged beside the install path, not in tmpdir: the final rename must stay on one volume.
    mkdirSync(dirname(AXE_DIR), { recursive: true });
    const tmp = mkdtempSync(join(dirname(AXE_DIR), ".iosim-install-"));
    // Failures in here throw (the caller turns that into exit 1) instead of
    // calling die: die exits on the spot, and the finally that removes the
    // staging directory, unverified download included, would never run.
    try {
      const tarball = join(tmp, "axe.tar.gz");
      try { run("curl", ["-fsSL", "--max-time", "120", "-o", tarball, AXE_URL]); } catch (e) { throw new Error(`download failed: ${AXE_URL}\n${String(e.stderr ?? e.message).trim()}`); }
      const sha = createHash("sha256").update(readFileSync(tarball)).digest("hex");
      if (sha !== AXE_SHA256) throw new Error(`checksum mismatch for ${AXE_URL}: got ${sha}, pinned ${AXE_SHA256}. Nothing was installed.`);
      const unpacked = join(tmp, "unpacked");
      mkdirSync(unpacked);
      run("tar", ["-xzf", tarball, "-C", unpacked]);
      run(join(unpacked, "axe"), ["--version"]);
      // Two installs at once: the loser's rename fails because the winner's verified copy is already there.
      try { renameSync(unpacked, AXE_DIR); } catch (e) { if (!["ENOTEMPTY", "EEXIST"].includes(e.code) || !existsSync(bin)) throw e; }
    } finally { rmSync(tmp, { recursive: true, force: true }); }
    console.log(`AXe ${AXE_VERSION} installed at ${bin}`);
  },

  new(argv) {
    const { flags } = parseFlags(argv, { "--device": String, "--runtime": String });
    const now = Date.now();
    for (const old of staleSims(devicesOf(JSON.parse(simctl("list", "-j", "devices"))), now, STALE_AFTER_S)) {
      try { simctl("delete", old.udid); process.stderr.write(`iosim: removed leftover simulator ${old.name}\n`); } catch {}
    }
    const pick = pickDevice(JSON.parse(simctl("list", "-j", "runtimes")), flags.device ? [flags.device] : DEVICES, flags.runtime);
    if (pick.error) die(pick.error);
    const udid = simctl("create", simName(now, process.pid), pick.deviceType, pick.runtime.identifier).trim();
    simctl("boot", udid);
    simctl("bootstatus", udid, "-b");
    process.stderr.write(`iosim: ${pick.deviceName}, ${pick.runtime.name}\n`);
    console.log(udid);
  },

  delete(argv) {
    const { flags } = parseFlags(argv, { "--udid": String });
    if (!flags.udid) die("delete needs --udid");
    const device = devicesOf(JSON.parse(simctl("list", "-j", "devices"))).find((d) => d.udid === flags.udid);
    if (!device) { console.log(`no simulator ${flags.udid} (already gone)`); return; }
    if (!isOurSim(device.name)) die(`"${device.name}" was not created by iosim - not deleting it`);
    simctl("delete", flags.udid);
    console.log(`deleted ${device.name}`);
  },

  ui(argv) {
    const { flags } = parseFlags(argv, { "--udid": String, "--all": Boolean, "--grep": String });
    if (!flags.udid) die("ui needs --udid");
    let grep = null;
    if (flags.grep) { try { grep = new RegExp(flags.grep, "i"); } catch (e) { die(`--grep: ${e.message}`); } }
    const { screen, lines, offScreen } = compact(tree(flags.udid), { all: flags.all, grep });
    const notes = [screen ? `screen ${screen.w}x${screen.h}` : null, `${lines.length} element${lines.length === 1 ? "" : "s"}`,
      grep ? `matching /${flags.grep}/i` : null, !flags.all && offScreen ? `${offScreen} off-screen not listed` : null].filter(Boolean);
    console.log(`# ${notes.join(", ")}`);
    if (lines.length) console.log(lines.join("\n"));
  },

  at(argv) {
    const { flags, rest } = parseFlags(argv, { "--udid": String });
    const [x, y] = rest.map(Number);
    if (!flags.udid || !Number.isFinite(x) || !Number.isFinite(y) || rest.length !== 2) die("usage: iosim at --udid U X Y");
    const { lines } = compact(tree(flags.udid, `${x},${y}`), { all: true });
    console.log(lines[0] ?? `nothing with a label or id at ${x},${y}`);
  },

  wait(argv) {
    const { flags } = parseFlags(argv, { "--udid": String, "--id": String, "--label": String, "--text": String, "--gone": Boolean, "--timeout": String });
    const target = ["id", "label", "text"].filter((k) => flags[k] !== undefined);
    if (!flags.udid || target.length !== 1) die("usage: iosim wait --udid U (--id ID | --label LABEL | --text TEXT) [--gone] [--timeout SECONDS]");
    const timeout = Number(flags.timeout ?? 10);
    if (!Number.isFinite(timeout) || timeout <= 0) die("--timeout must be a number of seconds");
    const what = `${target[0]} ${JSON.stringify(flags[target[0]])}`;
    const deadline = Date.now() + timeout * 1000;
    for (;;) {
      const hits = find(tree(flags.udid), { [target[0]]: flags[target[0]] });
      if (flags.gone ? !hits.length : hits.length) { console.log(flags.gone ? `gone: ${what}` : `found: ${what} @${hits[0].cx},${hits[0].cy}`); return; }
      if (Date.now() >= deadline) die(`timed out after ${timeout}s: ${what} is ${flags.gone ? "still on screen" : "not on screen"} (iosim ui lists what is)`, 1);
      sleep(400);
    }
  },

  shot(argv) {
    const { flags } = parseFlags(argv, { "--udid": String, "--out": String, "--width": String });
    if (!flags.udid || !flags.out) die("usage: iosim shot --udid U --out FILE.png [--width W]");
    if (flags.width !== undefined && !(Number.isInteger(Number(flags.width)) && Number(flags.width) >= 100)) die("--width must be a whole number of pixels, 100 or more");
    const full = resolve(flags.out);
    if (!full.endsWith(".png")) die("--out must end in .png");
    const small = full.replace(/\.png$/, ".small.png");
    mkdirSync(dirname(full), { recursive: true });
    try { simctl("io", flags.udid, "screenshot", "--type=png", full); } catch (e) { die(`screenshot failed: ${String(e.stderr ?? e.message).trim().split("\n").pop()}`, 1); }
    // By default the small copy is as wide as the screen is in points, so a
    // position in it is the x,y a tap takes.
    const points = flags.width === undefined ? flatten(readTree(flags.udid).tree).screen?.w : null;
    const width = Number(flags.width ?? points ?? 400);
    try { run("sips", ["--resampleWidth", String(width), full, "--out", small]); } catch (e) { die(`could not downscale ${full}: ${e.message}`, 1); }
    console.log(`look at: ${small}${points ? " (1 px = 1 pt: a position in it is the x,y to tap)" : ""}\nfull size: ${full}`);
  },
};

const [command, ...argv] = process.argv.slice(2);
// `iosim help tap` is AXe's help for tap; `iosim help` is this file's header.
if (!command || command === "-h" || command === "--help" || (command === "help" && !argv.length)) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 22).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(command ? 0 : 3);
}
if (Object.hasOwn(commands, command)) {
  try { commands[command](argv); } catch (e) { die(String(e.stderr || e.message).trim(), 1); }
} else {
  // Everything else is an AXe command (tap, type, swipe, batch, ...).
  if (command === "describe-ui") die("describe-ui prints the raw tree (~0.5 MB) - use `iosim ui`, `iosim at` or `iosim wait`");
  const r = spawnSync(axeOrDie(), [command, ...argv], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
