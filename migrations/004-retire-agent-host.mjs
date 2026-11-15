// rollcall no longer has an agent host (the background process that ran hosted chats and crews for a front end) or a
// front-end interface. A host an older rollcall started may still run from code that is gone: it is stopped (SIGTERM,
// which parks its agents and saves their sessions). Then what only it used moves out of rollcall's store, kept, not
// deleted: `_host/`, every supervisor home it ran (one with `runtime.json`), and its machine files. They land in
// `<store>/_retired/agent-host/`, so the terminal Falcon no longer lists those homes as supervisors.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MACHINE_FILES = ["worker-mcp.json", "clients", "notices.jsonl", "api-requests.json", "claude-models.json", "codex-models.json"];

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

/** Stops a running agent host; throws when it does not stop, so the migration runs again next sync. */
function stopHost(root, log) {
  const pid = readJson(join(root, "_host", "host.json"))?.pid;
  if (!Number.isInteger(pid) || !alive(pid)) return;
  // A pid reused by another process since: only a rollcall host is ours to stop.
  const cmd = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "";
  if (!/rollcall/.test(cmd) || !/\shost(\s|$)/.test(cmd)) return;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 60 && alive(pid); i++) sleep(250);
  if (alive(pid)) throw new Error(`rollcall's old agent host (pid ${pid}) did not stop`);
  log.change(`stopped rollcall's old agent host (pid ${pid})`);
}

export default function ({ log }) {
  const root = process.env.ROLLCALL_HOME || join(homedir(), ".rollcall");
  if (!existsSync(root)) return;
  stopHost(root, log);
  const dest = join(root, "_retired", "agent-host");
  const moved = [];
  const move = (from, to) => {
    if (!existsSync(from)) return;
    // Something already waits at the destination (an earlier partial run): keep both.
    if (existsSync(to)) to = `${to}-${Date.now()}`;
    mkdirSync(join(to, ".."), { recursive: true });
    renameSync(from, to);
    moved.push(to.slice(dest.length + 1));
  };
  move(join(root, "_host"), join(dest, "_host"));
  let homes = [];
  try { homes = readdirSync(join(root, "_supervisors"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  for (const h of homes) {
    if (readJson(join(root, "_supervisors", h, "runtime.json"))?.runtime === "host") move(join(root, "_supervisors", h), join(dest, "supervisors", h));
  }
  for (const f of MACHINE_FILES) move(join(root, "_machine", f), join(dest, "machine", f));
  if (moved.length) log.change(`moved what rollcall's old agent host used to ${dest}: ${moved.join(", ")}`);
}
