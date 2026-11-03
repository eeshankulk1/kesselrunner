# Changelog

All notable changes to kesselrunner and rollcall. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). kesselrunner (the root) and rollcall
(`packages/rollcall`) share one version number and one tag, `v<version>`.

<!--
Releasing (the owner):
1. In a task worktree: `scripts/release.sh bump <version>`. It sets the version in both
   package.json files and turns [Unreleased] below into the new version's entry. Fill the
   entry in, then ship it as an ordinary PR.
2. Once that PR has landed, on an up-to-date main: `scripts/release.sh tag`. It checks the
   versions and the entry, runs rollcall's `npm pack --dry-run`, tags `v<version>` locally,
   and prints the three steps left: push the tag, `gh release create`, and `npm publish`
   from packages/rollcall (needs the owner's npm login). Nothing publishes from CI.
-->

## [Unreleased]

## [0.1.0] - 2026-11-02

First public release. kesselrunner was called dotclaude until this version.

### Added
- **falcon and supervisor mode.** `falcon` opens a supervisor in a terminal tab: you talk to one
  session while each task runs in its own worker (a Claude Code session in a tmux window, in its
  own git worktree), with a clickable tab per task. Workers park when idle, come back when needed,
  and hand off to a fresh session when they run long. falcon checks for git, tmux, Claude Code,
  gh and Node before it starts and says how to get what is missing.
- **rollcall.** Awareness for parallel agent sessions on one machine: who else is in a repo, edit
  blocking in a shared checkout, file-overlap warnings, claims, messages, waits, and worktree
  cleanup once work lands. MIT, publishable on its own as the `rollcall` npm package.
- **Merge queue.** `rollcall queue` lands green PRs in the order they became ready, several at a
  time where it can, each batch tested as the tree that lands.
- **Ship chain skills.** `/pr-create` (checks scaled to the diff, worklog, PR, CI watch, merge and
  release steps on "ship it"), plus `/frontend-test`, `/ios-sim`, `/ship-ios-build`, `/ci-setup`,
  `/update-docs`, `/update-tests`, `/recap` and `/note`, and the agents they hand work to.
- **docsic memory.** Project state and notes carried across sessions, set up by install.
- **The overlay.** Your own instructions, settings, skills, guards and rules on top of the shared
  core, kept in a folder you own (`kesselrunner install --overlay <dir>`).
- **Install and sync.** A one-line install over plain git with no GitHub login; `kesselrunner
  sync` keeps `~/.claude` in step with the core, and `kesselrunner doctor` reports drift and
  missing tools.

### Changed
- Renamed from dotclaude. The `dotclaude` command, the `DOTCLAUDE_*` settings names and an
  install in `~/.dotclaude` keep working; the first sync moves state to the new names.

[Unreleased]: https://github.com/eeshankulk1/kesselrunner/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/eeshankulk1/kesselrunner/releases/tag/v0.1.0
