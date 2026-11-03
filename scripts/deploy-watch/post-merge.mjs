#!/usr/bin/env node
// PostToolUse hook (matcher: Bash). Deterministic post-merge follow-ups: when a
// `gh pr merge` command succeeds, inject instructions telling the main agent to
// (1) spawn the deploy-watcher agent in the background to watch
// whatever the merge triggered, and (2) verify docs rode the merge, running the
// /update-docs drift sweep if the PR changed code without touching docs/.
// Fires only on confirmed merges (gh prints "Merged pull request #N"); a failed
// merge command injects nothing. Always exits 0 - this hook is best-effort.

import { contextOutput, isMain, readPayload } from "../../lib/hook-io.mjs";

/** The follow-up to inject after a PostToolUse payload, or null (scripts/hooks runs it beside rollcall's hook). */
export function check(input) {
  if (!input || typeof input !== "object") return null;
  // Both harnesses document tool_input.command as a string; the array branch is
  // purely defensive (some shell tools use argv arrays), not observed behavior.
  const rawCommand = input.tool_input?.command;
  const command = Array.isArray(rawCommand) ? rawCommand.join(" ") : rawCommand || "";

  // Only react to gh pr merge (any flag order, possibly chained with &&).
  if (!/\bgh\s+pr\s+merge\b/.test(command)) return null;

  // Confirm the merge actually happened from gh's own output. The Bash
  // tool_response shape varies ({stdout,stderr} or {type:"text",text}); check all.
  const resp = input.tool_response || {};
  const output = typeof resp === "string"
    ? resp
    : [resp.stdout, resp.stderr, resp.text, resp.output]
        .filter((s) => typeof s === "string")
        .join("\n");
  const merged = output.match(/Merged pull request (?:[\w./-]+)?#(\d+)/i);
  if (!merged) return null;

  const prNumber = merged[1];
  const repoFlag = command.match(/--repo[= ]([\w.-]+\/[\w.-]+)/)?.[1];
  const where = repoFlag
    ? `repo ${repoFlag}`
    : `the repo at ${input.cwd || "the current working directory"}`;

  const context = [
    `[deploy-watch] PR #${prNumber} in ${where} was just merged.`,
    `Deterministic follow-up (do this now, before anything else): spawn the deploy-watcher agent in the background (per "Delegation" in the global instructions: the Agent tool, or the Codex backend when configured) to watch any CI/CD or deployment triggered by this merge.`,
    `Tell it the repo (${repoFlag || "resolve with `gh repo view --json nameWithOwner` in the cwd"}) and PR #${prNumber}. Continue your other work while it runs, and relay its report to the user when it returns.`,
    `Skip the launch only if a deploy-watcher is already watching this exact merge.`,
    ``,
    `[docs-sync] Also verify docs rode this merge. If PR #${prNumber} shipped via /pr-create this session, its docs gate already ran - say so and move on. Otherwise check \`gh pr view ${prNumber}${repoFlag ? ` --repo ${repoFlag}` : ""} --json files -q '.files[].path'\`: if the PR changed code but nothing under docs/, run /update-docs sync in that repo and ship the result as a docs-only PR (branch docs/post-merge-${prNumber}). Docs-only or config-only PRs need no follow-up.`,
  ].join("\n");

  return context;
}

if (isMain(import.meta.url)) {
  try {
    const context = check(await readPayload());
    if (context) process.stdout.write(contextOutput("PostToolUse", context));
  } catch {
    // Silence: never block the tool loop.
  }
  process.exit(0);
}
