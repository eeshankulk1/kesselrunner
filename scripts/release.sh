#!/usr/bin/env bash
# Release steps for kesselrunner and rollcall (one version, one tag). See the comment at the top of CHANGELOG.md.
#
#   scripts/release.sh bump <version>   set the version in both package.json files and open its CHANGELOG entry
#   scripts/release.sh tag              on an up-to-date main: check, tag v<version> locally, print what is left
#
# It never pushes and never publishes: the push, the GitHub release and `npm publish` are printed for the owner.
set -euo pipefail

REPO_SLUG="eeshankulk1/kesselrunner"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RC="$ROOT/packages/rollcall"
die() { echo "release: $*" >&2; exit 1; }
version_of() { node -p "require(process.argv[1]).version" "$1/package.json"; }

case "${1:-}" in
  bump)
    V="${2:-}"
    [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "usage: scripts/release.sh bump <x.y.z>"
    grep -q "^## \[$V\]" "$ROOT/CHANGELOG.md" && die "CHANGELOG.md already has an entry for $V"
    grep -q "^## \[Unreleased\]" "$ROOT/CHANGELOG.md" || die "CHANGELOG.md has no [Unreleased] heading"
    for d in "$ROOT" "$RC"; do
      node -e 'const f=process.argv[1],v=process.argv[2],fs=require("fs");const j=JSON.parse(fs.readFileSync(f));j.version=v;fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$d/package.json" "$V"
    done
    PREV="$(git -C "$ROOT" describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
    node - "$ROOT/CHANGELOG.md" "$V" "$(date +%F)" "$PREV" "$REPO_SLUG" <<'EOF'
const [f, v, day, prev, slug] = process.argv.slice(2);
const fs = require("fs");
let s = fs.readFileSync(f, "utf8");
s = s.replace(/^## \[Unreleased\]\n/m, `## [Unreleased]\n\n## [${v}] - ${day}\n`);
const links = `[Unreleased]: https://github.com/${slug}/compare/v${v}...HEAD\n` +
  `[${v}]: https://github.com/${slug}/${prev ? `compare/${prev}...v${v}` : `releases/tag/v${v}`}\n`;
s = s.replace(/^\[Unreleased\]: .*\n/m, links);
fs.writeFileSync(f, s);
EOF
    echo "release: $V set in package.json and packages/rollcall/package.json, and CHANGELOG.md has its heading."
    echo "Write the entry under ## [$V], then ship it as a PR. Once it lands: scripts/release.sh tag"
    ;;
  tag)
    V="$(version_of "$ROOT")"
    [ "$(version_of "$RC")" = "$V" ] || die "package.json says $V but packages/rollcall/package.json says $(version_of "$RC")"
    [ "$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)" = main ] || die "run it on main, after the version PR landed"
    [ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] || die "the checkout has uncommitted changes"
    git -C "$ROOT" fetch --quiet origin main
    [ "$(git -C "$ROOT" rev-parse HEAD)" = "$(git -C "$ROOT" rev-parse origin/main)" ] || die "main is not at origin/main: pull first"
    git -C "$ROOT" rev-parse -q --verify "refs/tags/v$V" >/dev/null && die "tag v$V already exists"
    NOTES="$(mktemp "${TMPDIR:-/tmp}/kesselrunner-notes.XXXXXX")"
    awk -v v="$V" '$0 ~ "^## \\[" v "\\]" {on=1; next} on && /^## \[/ {exit} on && /^\[[^]]+\]: / {exit} on {print}' "$ROOT/CHANGELOG.md" > "$NOTES"
    grep -q '[^[:space:]]' "$NOTES" || die "CHANGELOG.md has no entry text under ## [$V]"
    (cd "$RC" && npm pack --dry-run --json >/dev/null 2>&1) || die "npm pack --dry-run failed in packages/rollcall"
    (cd "$RC" && npm pack --dry-run 2>&1 | sed -n 's/^npm notice //p' | grep -E "^(name|version|filename|total files):")
    git -C "$ROOT" tag -a "v$V" -m "v$V"
    echo
    echo "release: tagged v$V here; release notes in $NOTES. Left for you, in order:"
    echo "  git -C \"$ROOT\" push origin v$V"
    echo "  gh release create v$V --repo $REPO_SLUG --title v$V --notes-file \"$NOTES\""
    echo "  cd \"$RC\" && npm publish"
    ;;
  *) die "usage: scripts/release.sh bump <x.y.z> | tag" ;;
esac
