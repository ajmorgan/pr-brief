#!/usr/bin/env bash
# sync-viewer.sh — refresh the vendored copy of xor (the editor) in viewer/.
#
# The editor is developed in $SRC (default ~/code/web/editor) and vendored
# here so the skill is portable: source + the built vendor/editor.js, no
# node_modules. Run after changing the editor; commit the result.
#
#   scripts/sync-viewer.sh [source-dir]          pull: editor source → viewer/
#   scripts/sync-viewer.sh --push [source-dir]   push: viewer/ → editor source (the vendored copy is the one being edited)
set -euo pipefail
SK="$(cd "$(dirname "$0")/.." && pwd)"
PUSH=0; if [ "${1:-}" = "--push" ]; then PUSH=1; shift; fi
SRC="${1:-$HOME/code/web/editor}"
DST="$SK/viewer"

if [ "$PUSH" = 1 ]; then
  [ -f "$DST/index.html" ] || { echo "no viewer at $DST" >&2; exit 1; }
  mkdir -p "$SRC"
  rsync -a --delete --exclude node_modules --exclude .playwright-mcp --exclude .DS_Store --exclude VENDORED --exclude .gitignore "$DST/" "$SRC/"
  echo "editor at $SRC replaced from $DST (node_modules kept)"
  exit 0
fi
[ -f "$SRC/index.html" ] || { echo "no editor at $SRC" >&2; exit 1; }
[ -f "$SRC/vendor/editor.js" ] || { echo "vendor/editor.js missing in $SRC — run 'npm run build' there first" >&2; exit 1; }

mkdir -p "$DST"
rsync -a --delete \
  --exclude node_modules --exclude .playwright-mcp --exclude .DS_Store --exclude .gitignore \
  "$SRC/" "$DST/"

# stamp: where it came from, when, and a hash of the tree so drift is detectable
hash="$(cd "$DST" && find . -type f ! -name VENDORED -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-16)"
printf 'source: %s\nsynced: %s\ntree: %s\n' "$SRC" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$hash" > "$DST/VENDORED"
echo "viewer synced from $SRC (tree $hash)"
