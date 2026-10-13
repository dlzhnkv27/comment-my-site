#!/bin/bash
# Builds a zip to share with colleagues: the extension, the Desktop helper and a short guide.
# Usage: tools/package.sh [output-dir]   (default: ~/Desktop)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$HOME/Desktop}"
VERSION="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/extension/manifest.json")"
NAME="Comment My Site"
ZIP="$OUT_DIR/comment-my-site-$VERSION.zip"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/$NAME"

mkdir -p "$PKG/native-host"
cp -R "$ROOT/extension" "$PKG/extension"
cp "$ROOT/native-host/install.sh" "$ROOT/native-host/uninstall.sh" "$ROOT/native-host/comment_my_site_host.py" "$PKG/native-host/"
cp "$ROOT/tools/package-readme.md" "$PKG/README.md"
find "$PKG" \( -name '.DS_Store' -o -name '__pycache__' \) -prune -exec rm -rf {} +

rm -f "$ZIP"
(cd "$STAGE" && zip -qrX "$ZIP" "$NAME")
echo "$ZIP"
