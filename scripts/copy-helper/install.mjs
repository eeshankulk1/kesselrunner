#!/usr/bin/env node
// Builds and registers "kesselrunner Copy.app", the macOS helper behind the
// clickable mod's copy links. In Claude Code's classic view a click reaches
// the terminal, never Claude Code, and a terminal can only open a link; so the
// mod links each code block as kesselrunner-copy://<id>, and macOS opens this app
// for that scheme, which copies the text the mod saved under the id.
//
// `kesselrunner sync` calls ensureCopyHelper on macOS. It rebuilds only when the
// handler's sources changed (their hash sits in the bundle as `stamp`).
//   node scripts/copy-helper/install.mjs [--force]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEME = "kesselrunner-copy";
export const APP = join(homedir(), "Library", "Application Support", "kesselrunner", "kesselrunner Copy.app");
// Before the rename: the app's old home and scheme. The new app also opens the old scheme (a session
// that loaded the clickable mod before the rename still draws it), and the old app is removed.
export const LEGACY_SCHEME = "dotclaude-copy";
export const LEGACY_APP = join(homedir(), "Library", "Application Support", "dotclaude", "dotclaude Copy.app");
const SRC = dirname(fileURLToPath(import.meta.url));
const SOURCES = ["handler.applescript", "copy.sh", "install.mjs"];
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/** The hash of what the app is built from: a change to any of it rebuilds the app. */
export function sourceStamp(src = SRC) {
  const h = createHash("sha256");
  for (const name of SOURCES) h.update(readFileSync(join(src, name)));
  return h.digest("hex").slice(0, 16);
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
const builtStamp = (app) => { try { return readFileSync(join(app, "Contents", "Resources", "stamp"), "utf8").trim(); } catch { return null; } };

/** Compiles the applet into `app`: the handler, copy.sh beside it, the URL scheme and no Dock icon, signed ad hoc. */
function build(app, stamp) {
  run("osacompile", ["-o", app, join(SRC, "handler.applescript")]);
  const resources = join(app, "Contents", "Resources");
  copyFileSync(join(SRC, "copy.sh"), join(resources, "copy.sh"));
  chmodSync(join(resources, "copy.sh"), 0o755);
  writeFileSync(join(resources, "stamp"), `${stamp}\n`);
  const plist = join(app, "Contents", "Info.plist");
  run("plutil", ["-replace", "CFBundleIdentifier", "-string", "dev.kesselrunner.copy", plist]);
  run("plutil", ["-replace", "CFBundleName", "-string", "kesselrunner Copy", plist]);
  run("plutil", ["-replace", "LSUIElement", "-bool", "YES", plist]);
  run("plutil", ["-replace", "CFBundleURLTypes", "-json", JSON.stringify([{ CFBundleURLName: "kesselrunner copy link", CFBundleURLSchemes: [SCHEME, LEGACY_SCHEME] }]), plist]);
  // Editing Info.plist voids osacompile's signature; Apple silicon will not launch an app without one.
  run("codesign", ["--force", "--deep", "--sign", "-", app]);
}

/**
 * Builds the app when it is missing or older than its sources, then registers its scheme. macOS only,
 * and only for the account's own home: a throwaway HOME (test/sandbox.sh) would register an app that
 * is deleted with it, and macOS could keep sending copy links there.
 */
export function ensureCopyHelper(log, { force = false, app = APP, legacyApp = LEGACY_APP } = {}) {
  let staging = null;
  try {
    if (process.platform !== "darwin" || homedir() !== userInfo().homedir) return;
    const stamp = sourceStamp();
    if (!force && existsSync(app) && builtStamp(app) === stamp) return removeLegacyApp(legacyApp, log);
    // Build beside the final app, so the swap below is a same-volume rename.
    mkdirSync(dirname(app), { recursive: true });
    staging = mkdtempSync(join(dirname(app), ".build-"));
    const fresh = join(staging, "kesselrunner Copy.app");
    build(fresh, stamp);
    // Keep the old app until the new one is in place: a failed rename puts it back.
    const old = join(staging, "previous.app");
    const hadOld = existsSync(app);
    if (hadOld) renameSync(app, old);
    try {
      renameSync(fresh, app);
    } catch (e) {
      if (hadOld) renameSync(old, app);
      throw e;
    }
    run(LSREGISTER, ["-f", app]);
    log.change(`built kesselrunner Copy.app (copy links for the clickable mod)`);
    removeLegacyApp(legacyApp, log);
  } catch (e) {
    log.warn(`could not build kesselrunner Copy.app: ${String(e.stderr || e.message).split("\n")[0]}`);
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}

/** Unregisters and deletes "dotclaude Copy.app" (and its folder once empty); only after the new app is in place. */
function removeLegacyApp(legacyApp, log) {
  if (!legacyApp || !existsSync(legacyApp)) return;
  try { run(LSREGISTER, ["-u", legacyApp]); } catch {}
  rmSync(legacyApp, { recursive: true, force: true });
  try { rmdirSync(dirname(legacyApp)); } catch {}
  log.change("removed dotclaude Copy.app (kesselrunner Copy.app opens its links)");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const log = { change: (m) => console.log(m), warn: (m) => { console.error(m); process.exitCode = 1; } };
  ensureCopyHelper(log, { force: process.argv.includes("--force") });
  if (!process.exitCode) console.log(`${APP} handles ${SCHEME}:// links`);
}
