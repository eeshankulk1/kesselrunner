# Contributing

Bug reports, ideas and pull requests are welcome.

- **Bugs and ideas:** open an issue. For a bug, say what you ran, what you expected and what happened.
- **Pull requests:** fork the repo, branch from `main`, and open a PR against `main`. Keep each PR to one change. CI runs the tests on your PR after the maintainer approves the run.
- **Tests:** each suite and the command that runs it are listed in `.claude/test-manifest.json` (most are `node --test test/<name>.test.mjs`; rollcall's is `npm test` in `packages/rollcall`). They need Node 20+, git and tmux.
- **Docs:** if your change alters what a doc says, update that doc in the same PR. `docs/architecture.md` lists them all.

Only the maintainer can merge. By sending a PR you agree to license your work under the [MIT license](../LICENSE).
