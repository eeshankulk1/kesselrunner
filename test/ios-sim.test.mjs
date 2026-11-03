// iosim's pure half: the accessibility-tree listing, element matching, and the
// naming that keeps it from deleting a simulator it did not create. No
// simulator, no AXe.
//   node --test test/ios-sim.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compact, devicesOf, find, isOurSim, pickDevice, simName, staleSims } from "../scripts/ios-sim/core.mjs";

const SIM = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ios-sim", "sim.mjs");
const node = (type, frame, extra = {}, children = []) => ({ type, frame: { x: frame[0], y: frame[1], width: frame[2], height: frame[3] }, enabled: true, AXLabel: null, AXUniqueId: null, AXValue: null, ...extra, children });

// Shaped like AXe 1.8.0's `describe-ui`: one application node in an array.
const TREE = [node("Application", [0, 0, 402, 874], { AXLabel: "App" }, [
  node("Group", [0, 0, 402, 874], { AXUniqueId: "transcript" }, [
    node("StaticText", [20, -300, 200, 20], { AXLabel: "Scrolled away" }),
    node("StaticText", [20, 100, 17, 20], { AXLabel: "•" }),
    node("StaticText", [40, 100, 200, 20], { AXLabel: "A bullet point" }),
    node("Slider", [380, 0, 10, 874], { AXLabel: "Vertical scroll bar, 3 pages", AXValue: "100%" }),
  ]),
  node("Button", [20, 780, 52, 52], { AXLabel: "Settings", AXUniqueId: "menu-settings" }, [
    node("Image", [30, 790, 32, 32], { AXLabel: "Gear", AXUniqueId: "gearshape" }),
    node("StaticText", [30, 790, 32, 32], { AXLabel: "Settings" }),
  ]),
  node("Button", [330, 780, 52, 52], { AXLabel: "Send", AXUniqueId: "arrow.up", enabled: false }),
  node("Image", [100, 400, 20, 20], { AXUniqueId: "chevron.forward" }),
  node("TextArea", [60, 740, 260, 40], { AXLabel: "Message", AXValue: "Hello there" }),
  node("Button", [300, 850, 200, 100], { AXLabel: "Half off the corner" }),
  node("Group", [0, 0, 10, 10]),
])];

test("the listing keeps what an agent acts on and drops the rest", () => {
  const { screen, lines, offScreen } = compact(TREE);
  assert.deepEqual(screen, { w: 402, h: 874 });
  assert.equal(offScreen, 1);
  assert.deepEqual(lines, [
    "Group #transcript @201,437",
    'StaticText "A bullet point" @140,110',
    'Button #menu-settings "Settings" @46,806',
    'Button #arrow.up "Send" (disabled) @356,806',
    'TextArea "Message" ="Hello there" @190,760',
    // The centre of the part on screen, so a tap at it lands on the element.
    'Button "Half off the corner" @351,862',
  ]);
});

test("--all lists everything, off-screen marked; grep filters lines", () => {
  const all = compact(TREE, { all: true }).lines;
  assert.ok(all.includes('StaticText "Scrolled away" @120,-290 (off-screen)'));
  assert.ok(all.includes('Image #gearshape "Gear" @46,806'));
  assert.deepEqual(compact(TREE, { grep: /settings/i }).lines, ['Button #menu-settings "Settings" @46,806']);
});

test("long labels are cut, a single --point node is listed", () => {
  const long = node("StaticText", [0, 0, 100, 20], { AXLabel: "x".repeat(200) });
  const [only] = compact(long, { all: true }).lines;
  assert.ok(only.length < 90 && only.includes("…"));
});

test("find matches on-screen elements by id, exact label, or text anywhere", () => {
  assert.equal(find(TREE, { id: "menu-settings" }).length, 1);
  assert.equal(find(TREE, { label: "Send" })[0].enabled, false);
  assert.equal(find(TREE, { label: "send" }).length, 0);
  assert.equal(find(TREE, { text: "hello THERE" })[0].type, "TextArea");
  assert.equal(find(TREE, { text: "scrolled away" }).length, 0);
});

test("only simulators iosim named are its own; stale ones are found by age", () => {
  const now = 1_800_000_000_000;
  const name = simName(now, 4242);
  assert.equal(name, "iosim-1800000000-4242");
  assert.ok(isOurSim(name));
  for (const other of ["iPhone 17 Pro", "Acme Capture", "iosim", "iosim-abc-1", "my-iosim-1-2", undefined]) assert.ok(!isOurSim(other));
  const devices = devicesOf({ devices: { "rt-26": [
    { name: simName(now - 7 * 3600 * 1000, 1), udid: "OLD", state: "Booted" },
    { name: simName(now - 60 * 1000, 2), udid: "FRESH", state: "Booted" },
    { name: "iPhone 17 Pro", udid: "MINE", state: "Booted" },
  ] } });
  assert.deepEqual(staleSims(devices, now, 6 * 3600).map((d) => d.udid), ["OLD"]);
});

test("pickDevice takes the newest runtime and the first device it supports", () => {
  const list = { runtimes: [
    { identifier: "rt-18-2", version: "18.2", name: "iOS 18.2", isAvailable: true, platform: "iOS", supportedDeviceTypes: [{ name: "iPhone 16 Pro", identifier: "dt-16p" }] },
    { identifier: "rt-26-3", version: "26.3", name: "iOS 26.3", isAvailable: true, platform: "iOS", supportedDeviceTypes: [{ name: "iPhone 17 Pro", identifier: "dt-17p" }, { name: "iPhone 16 Pro", identifier: "dt-16p" }] },
    { identifier: "rt-27-0", version: "27.0", name: "iOS 27.0", isAvailable: false, platform: "iOS", supportedDeviceTypes: [] },
    { identifier: "rt-tv", version: "99.0", name: "tvOS 99", isAvailable: true, platform: "tvOS", supportedDeviceTypes: [] },
  ] };
  const pick = pickDevice(list, ["iPhone 17 Pro", "iPhone 16 Pro"]);
  assert.deepEqual([pick.runtime.identifier, pick.deviceType, pick.deviceName], ["rt-26-3", "dt-17p", "iPhone 17 Pro"]);
  assert.equal(pickDevice(list, ["iPhone 16 Pro"], "18.2").runtime.identifier, "rt-18-2");
  assert.match(pickDevice(list, ["iPhone 4"]).error, /none of iPhone 4 on iOS 26.3/);
  assert.match(pickDevice(list, ["iPhone 17 Pro"], "12.0").error, /no available iOS runtime matching 12.0/);
});

test("the CLI: usage errors exit 3, the raw tree is refused, AXe missing is said plainly", () => {
  const cli = (args, env = {}) => spawnSync("node", [SIM, ...args], { encoding: "utf8", env: { ...process.env, IOSIM_AXE: "/nonexistent/axe", ...env } });
  assert.match(execFileSync("node", [SIM, "--help"], { encoding: "utf8" }), /iosim ui --udid U/);
  for (const args of [[], ["ui"], ["wait", "--udid", "U"], ["wait", "--udid", "U", "--id", "a", "--text", "b"], ["shot", "--udid", "U", "--out", "x.jpg"], ["at", "--udid", "U", "1"], ["ui", "--nope"]]) {
    assert.equal(cli(args).status, 3, `iosim ${args.join(" ")}`);
  }
  const raw = cli(["describe-ui", "--udid", "U"]);
  assert.equal(raw.status, 3);
  assert.match(raw.stderr, /use `iosim ui`/);
  const missing = cli(["tap", "--id", "x", "--udid", "U"]);
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /run `iosim install`/);
  assert.match(cli(["doctor"]).stdout, /not installed/);
  // An argument that merely says describe-ui is not the raw-tree command: it reaches AXe (missing here, so exit 3 for that reason).
  assert.match(cli(["type", "describe-ui", "--udid", "U"]).stderr, /run `iosim install`/);
});

test("install: a download that fails the checksum installs nothing and leaves nothing behind", () => {
  // A throwaway HOME and a curl that writes the wrong bytes: no network, and the real install is never touched.
  const box = mkdtempSync(join(tmpdir(), "iosim-test-"));
  try {
    const [home, bin] = [join(box, "home"), join(box, "bin")];
    mkdirSync(home);
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && echo "not the release" > "$2"; shift; done\n', { mode: 0o755 });
    const r = spawnSync("node", [SIM, "install"], { encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /checksum mismatch/);
    assert.deepEqual(readdirSync(join(home, ".local", "share", "kesselrunner", "axe")), []);
  } finally { rmSync(box, { recursive: true, force: true }); }
});
