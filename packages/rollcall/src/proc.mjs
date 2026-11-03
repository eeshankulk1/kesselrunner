// Process facts: is a pid alive, and which harness process (Claude Code, Codex)
// sits above this one. Ancestry costs one `ps` per level on macOS, so it runs
// once per session (SessionStart) and in the CLI, never on the edit hot path.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { uptime } from "node:os";
import { basename } from "node:path";

const childProcess = () => createRequire(import.meta.url)("node:child_process");

/** Fire-and-forget: starts a detached background process, never waits, never throws. */
export function spawnDetached(cmd, args, opts = {}) {
  try {
    const child = childProcess().spawn(cmd, args, { detached: true, stdio: "ignore", ...opts });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

const WRAPPERS = new Set([
  "sh", "bash", "zsh", "dash", "fish", "ksh", "mksh", "tcsh", "csh",
  "env", "nice", "nohup", "timeout", "gtimeout", "time", "script", "xargs",
]);

/**
 * When process `pid` started, in ms (whole seconds), or null when it is gone or ps cannot say. In UTC, so a
 * change of time zone leaves a running process the same one.
 */
export function startOf(pid) {
  try {
    const out = childProcess().execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000, env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    }).trim();
    const at = Date.parse(`${out} UTC`);
    return Number.isFinite(at) ? at : null;
  } catch { return null; }
}

// ps can read a process's start a moment off from the boot it came after.
const BOOT_SLACK_MS = 5_000;

/**
 * Whether process `pid` runs, and with `start` (its startOf when it was recorded) whether it can still be that
 * process: one that started before this boot is gone, whatever runs under its id now, and ids get reused at once
 * after a reboot. It spawns nothing, so every hook can ask it. A record with no start goes by the id.
 */
export function pidAlive(pid, start) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== "EPERM") return false; }
  return !start || start >= Date.now() - uptime() * 1000 - BOOT_SLACK_MS;
}

/**
 * pidAlive, and that it is that very process: ids also come round on a Mac that stays up. This runs `ps`, a third of
 * a hook's time, so it is for what a reused id would hold for days (a supervisor's name, a watcher, a lander), never on
 * a hook's way. A process ps cannot read goes by pidAlive.
 */
export function sameProcess(pid, start) {
  if (!pidAlive(pid, start)) return false;
  if (!start) return true;
  const now = startOf(pid);
  return now === null || now === start;
}

function procInfo(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = s.lastIndexOf(")");
    return { name: s.slice(s.indexOf("(") + 1, close), ppid: Number(s.slice(close + 2).split(" ")[1]) };
  } catch {}
  try {
    const out = childProcess().execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000,
    }).trim();
    const m = /^(\d+)\s+(.+)$/.exec(out);
    return m ? { ppid: Number(m[1]), name: basename(m[2].trim()).replace(/^-/, "") } : null;
  } catch { return null; }
}

/** { pid, name } from `pid` upward, lazily (one `ps` per step on macOS), stopping before init. */
export function* ancestry(pid = process.ppid, max = 24) {
  for (let n = 0; pid > 1 && n < max; n++) {
    const info = procInfo(pid);
    if (!info) return;
    yield { pid, name: info.name };
    pid = info.ppid;
  }
}

/**
 * The harness that ran this hook: the first ancestor that is not a shell or
 * wrapper. `ancestors` are the pids above it, used to recognise a harness
 * running inside another session (a nested `claude -p`, a delegated worker).
 * ROLLCALL_HARNESS_PID overrides detection for unusual launchers and tests.
 */
export function findHarness() {
  const forced = Number(process.env.ROLLCALL_HARNESS_PID);
  if (Number.isInteger(forced) && forced > 1) return { pid: forced, name: "", ancestors: [], start: startOf(forced) };
  const chain = [...ancestry()];
  const i = chain.findIndex((p) => !WRAPPERS.has(p.name));
  if (i < 0) return null;
  return { pid: chain[i].pid, name: chain[i].name, ancestors: chain.slice(i + 1).map((p) => p.pid), start: startOf(chain[i].pid) };
}
