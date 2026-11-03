// Fast-forwards the kesselrunner core clone to origin/main. Safe by construction:
// fetch + fast-forward only, never resets, never touches a dirty tree or an
// unmerged branch. A feature branch whose change already landed upstream (true
// merge or squash merge) is switched back to main. Returns the lines worth
// reporting; an empty array means nothing happened.
import { execFileSync } from "node:child_process";

const FETCH_TIMEOUT_MS = 8000;

export function pull(repo) {
  const out = [];
  const say = (msg) => out.push(msg);

  function git(args, opts = {}) {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Never let git block session start on a credential/host-key prompt.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" },
      ...opts,
    }).trim();
  }

  function pullOnce() {
    try {
      git(["fetch", "--quiet", "origin", "main"], { timeout: FETCH_TIMEOUT_MS });
    } catch {
      return; // offline or slow network - try again after the throttle window
    }

    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch === "HEAD") return; // detached - not ours to fix

    if (branch === "main") {
      const [ahead, behind] = git([
        "rev-list", "--left-right", "--count", "main...origin/main",
      ]).split(/\s+/).map(Number);
      if (behind === 0) return;
      if (ahead > 0) {
        say(`local main has diverged from origin/main (${ahead} ahead, ${behind} behind) - resolve manually in ${repo}`);
        return;
      }
      try {
        // Untracked files never block a fast-forward; git aborts on its own if
        // a dirty tracked file would be overwritten.
        git(["merge", "--ff-only", "--quiet", "origin/main"]);
        say(`pulled ${behind} new commit${behind === 1 ? "" : "s"} from origin/main into the kesselrunner core`);
      } catch {
        say(`main is ${behind} behind origin/main but fast-forward failed (dirty tree?) - resolve manually in ${repo}`);
      }
      return;
    }

    // On a feature branch. If its commits landed in origin/main (true merge OR
    // squash merge - the normal flow here), switching to main loses nothing -
    // do it. Otherwise leave the branch alone but keep the local main ref fresh
    // so the eventual switch is a no-op pull.
    const base = git(["merge-base", "HEAD", "origin/main"]);
    const head = git(["rev-parse", "HEAD"]);

    // Zero commits of its own = a branch someone just created to start work on.
    // Never touch it, even if origin/main has moved on.
    let merged = false;
    if (head !== base) {
      try {
        git(["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
        merged = true;
      } catch {
        // Squash-merge detection: commit the branch's final tree onto the merge
        // base and ask git cherry whether an equivalent change already exists in
        // origin/main. "-" means yes -> the PR landed as a squash commit.
        try {
          const tree = git(["rev-parse", "HEAD^{tree}"]);
          const probe = git(["commit-tree", tree, "-p", base, "-m", "kesselrunner-sync squash probe"]);
          merged = git(["cherry", "origin/main", probe]).startsWith("-");
        } catch {}
      }
    }

    if (!merged) {
      try {
        // ff local main without checkout (hits the network again, so keep the timeout)
        git(["fetch", "--quiet", "origin", "main:main"], { timeout: FETCH_TIMEOUT_MS });
      } catch {}
      return;
    }

    const dirty = git(["status", "--porcelain", "--untracked-files=no"]) !== "";
    if (dirty) {
      say(`branch ${branch} is merged into origin/main but has uncommitted changes - not switching. Clean up and checkout main in ${repo}`);
      return;
    }

    try {
      git(["checkout", "--quiet", "main"]);
      git(["merge", "--ff-only", "--quiet", "origin/main"]);
      try {
        // -D not -d: a squash-merged branch is never an ancestor of main, but we
        // already verified its change landed before getting here.
        git(["branch", "--quiet", "-D", branch]);
      } catch {}
      say(`branch ${branch} was merged upstream - switched the kesselrunner core back to main and pulled`);
    } catch {
      say(`branch ${branch} is merged upstream but switching to main failed - resolve manually in ${repo}`);
    }
  }


  try { pullOnce(); } catch { /* offline, or not a git checkout: nothing to report */ }
  return out;
}
