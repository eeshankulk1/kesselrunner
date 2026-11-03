#!/usr/bin/env bash
# kesselrunner one-line install (public repo, plain git over https, no GitHub login):
#
#   curl -fsSL https://raw.githubusercontent.com/eeshankulk1/kesselrunner/main/install.sh | bash
#
# Extra args pass through to `kesselrunner install`, e.g. `| bash -s -- --overlay ~/notes/harness`.
# Env: KESSELRUNNER_DIR (default ~/.kesselrunner), KESSELRUNNER_REPO (default eeshankulk1/kesselrunner:
# an owner/name on GitHub, or any URL or path git can clone). The DOTCLAUDE_* names from before the
# rename still work. A private fork needs git credentials of its own (e.g. `gh auth setup-git`).
set -euo pipefail

DEFAULT_REPO="eeshankulk1/kesselrunner"
REPO="${KESSELRUNNER_REPO:-${DOTCLAUDE_REPO:-$DEFAULT_REPO}}"
case "$REPO" in
  */*/*|*:*|/*|.*) URL="$REPO" ;;              # a URL or a path: as given
  */*) URL="https://github.com/$REPO.git" ;;     # owner/name on GitHub
  *) echo "KESSELRUNNER_REPO should be owner/name, a URL or a path (got $REPO)" >&2; exit 1 ;;
esac
DIR="${KESSELRUNNER_DIR:-${DOTCLAUDE_DIR:-$HOME/.kesselrunner}}"
# A core cloned before the rename, to the old default, is updated in place rather than cloned again.
if [ -z "${KESSELRUNNER_DIR:-}${DOTCLAUDE_DIR:-}" ] && [ ! -e "$DIR" ] && [ -d "$HOME/.dotclaude/.git" ]; then DIR="$HOME/.dotclaude"; fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "kesselrunner needs $1: $2" >&2; exit 1; }; }
on_mac() { [ "$(uname -s)" = Darwin ]; }
if on_mac; then need git "xcode-select --install"; need node "brew install node"; else need git "https://git-scm.com/downloads"; need node "Node 20 or newer, https://nodejs.org"; fi
need npm "it comes with Node, https://nodejs.org"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "kesselrunner needs Node 20 or newer (found $(node -v))" >&2; exit 1; }
# gh is only for the PR steps (and falcon checks it again at its start): warn, never stop.
if ! command -v gh >/dev/null 2>&1; then
  echo "note: the GitHub CLI (gh) is missing; the PR steps need it: $(on_mac && echo "brew install gh" || echo "https://cli.github.com"), then gh auth login" >&2
fi

# Never stop on a credential prompt: a public repo needs none.
export GIT_TERMINAL_PROMPT=0
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only --quiet
else
  git clone --quiet "$URL" "$DIR"
fi

node "$DIR/bin/kesselrunner.mjs" install "$@"
