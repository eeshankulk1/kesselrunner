#!/usr/bin/env node
// rollcall - awareness for parallel agent sessions on one machine.
// `rollcall hook <event>` is the hook entry point; `worker-hook` and `statusline` are the
// supervisor's (a worker's launch settings, Claude Code's status line).
// Everything else is the CLI.
const argv = process.argv.slice(2);
const HOOKS = new Set(["hook", "worker-hook", "statusline"]);

if (HOOKS.has(argv[0])) {
  // Hooks fail open: disabled, crashed, or slow all end in exit 0 with no output,
  // so rollcall can never block or stall a session because of its own bug.
  const quiet = () => process.exit(0);
  const debug = (e) => { if (process.env.ROLLCALL_DEBUG) process.stderr.write(`rollcall: ${e?.stack ?? e}\n`); };
  process.on("uncaughtException", (e) => { debug(e); quiet(); });
  process.on("unhandledRejection", (e) => { debug(e); quiet(); });
  const { disabled, hookAnswer } = await import("../src/entry.mjs");
  if (disabled()) quiet();
  // Every hook answers within its budget or not at all.
  setTimeout(quiet, Number(process.env.ROLLCALL_HOOK_BUDGET_MS) || 3000).unref();
  try {
    let raw = "";
    if (!process.stdin.isTTY) for await (const chunk of process.stdin) raw += chunk;
    const payload = raw.trim() ? JSON.parse(raw) : {};
    if (argv[0] === "statusline") {
      const out = (await import("../src/watch.mjs")).statusline(payload);
      if (out) process.stdout.write(out);
    } else if (argv[0] === "worker-hook") {
      const [, home, task, event] = argv;
      const [{ workerHook }, { recordAsk }] = await Promise.all([import("../src/supervisor.mjs"), import("../src/task.mjs")]);
      const out = workerHook(home, task, event, payload, { recordAsk });
      if (out) process.stdout.write(out);
    } else {
      const out = await hookAnswer(argv[1], payload);
      if (out) process.stdout.write(out);
    }
  } catch (e) { debug(e); process.exitCode = 0; }
} else {
  const { main } = await import("../src/cli.mjs");
  process.exitCode = await main(argv);
}
