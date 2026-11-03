// A stand-in agent harness. It runs each command it reads (one JSON line on
// stdin: { cmd, input }) through `sh -c`, the way Claude Code runs hooks and
// Bash tool calls, so rollcall's process-ancestry lookups see a real harness
// above them. Replies with one JSON line: { code, stdout, stderr }.
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { cmd, input = "" } = JSON.parse(line);
  const r = spawnSync("sh", ["-c", cmd], { input, encoding: "utf8" });
  process.stdout.write(`${JSON.stringify({ code: r.status, stdout: r.stdout, stderr: r.stderr })}\n`);
}
