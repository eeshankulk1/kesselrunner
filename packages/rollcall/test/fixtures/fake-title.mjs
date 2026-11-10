#!/usr/bin/env node
// A stand-in for the one-shot title model (host/chat.mjs titleCommand, $ROLLCALL_CHAT_TITLE_CMD): reads the prompt on
// stdin, waits $FAKE_TITLE_MS, prints $FAKE_TITLE (default "Hello File Commit") and logs the prompt to $FAKE_TITLE_LOG.
import { appendFileSync } from "node:fs";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  if (process.env.FAKE_TITLE_LOG) appendFileSync(process.env.FAKE_TITLE_LOG, `${JSON.stringify({ prompt: input })}\n`);
  setTimeout(() => { process.stdout.write(`"${process.env.FAKE_TITLE ?? "Hello File Commit"}."\n`); process.exit(0); }, Number(process.env.FAKE_TITLE_MS) || 0);
});
