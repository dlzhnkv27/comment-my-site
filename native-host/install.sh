#!/bin/bash
# Installs the native helper that lets Comment My Site save screenshots straight to ~/Desktop.
# Safe to re-run. Remove with ./uninstall.sh.
set -euo pipefail

HOST_NAME="com.comment_my_site.saver"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$SCRIPT_DIR/../extension/manifest.json"
INSTALL_DIR="$HOME/Library/Application Support/CommentMySite"
HOST_PATH="$INSTALL_DIR/comment_my_site_host.py"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "Этот установщик рассчитан на macOS." >&2
  exit 1
fi

# Chrome starts native hosts with a minimal PATH, so pin the interpreter by absolute path.
PYTHON="$(command -v python3 || true)"
if [[ -z "$PYTHON" ]] || ! "$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)' 2>/dev/null; then
  echo "Нужен python3 (3.6+). Установите Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi
PYTHON="$("$PYTHON" -c 'import sys; print(sys.executable)')"

# The extension ID is derived from the "key" in manifest.json, so it is stable for unpacked installs.
EXT_ID="$("$PYTHON" - "$MANIFEST" <<'PY'
import base64, hashlib, json, sys
key = json.load(open(sys.argv[1]))["key"]
digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
print("".join(chr(ord("a") + int(c, 16)) for c in digest))
PY
)"

mkdir -p "$INSTALL_DIR"
{
  echo "#!$PYTHON"
  tail -n +2 "$SCRIPT_DIR/comment_my_site_host.py"
} > "$HOST_PATH"
chmod 755 "$HOST_PATH"

MANIFEST_JSON="$("$PYTHON" - "$HOST_NAME" "$HOST_PATH" "$EXT_ID" <<'PY'
import json, sys
name, path, ext_id = sys.argv[1:4]
print(json.dumps({
    "name": name,
    "description": "Comment My Site: saves exported screenshots to the Desktop",
    "path": path,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{ext_id}/"],
}, indent=2))
PY
)"

SUPPORT="$HOME/Library/Application Support"
BROWSERS=(
  "Google/Chrome"
  "Google/Chrome Beta"
  "Google/Chrome Dev"
  "Google/Chrome Canary"
  "Chromium"
  "BraveSoftware/Brave-Browser"
  "Microsoft Edge"
  "Vivaldi"
  "Arc/User Data"
  "Yandex/YandexBrowser"
)

installed=0
for browser in "${BROWSERS[@]}"; do
  base="$SUPPORT/$browser"
  [[ -d "$base" ]] || continue
  mkdir -p "$base/NativeMessagingHosts"
  printf '%s\n' "$MANIFEST_JSON" > "$base/NativeMessagingHosts/$HOST_NAME.json"
  echo "✓ $browser"
  installed=$((installed + 1))
done

if [[ $installed -eq 0 ]]; then
  echo "Не нашёл профиль Chrome/Chromium-браузера в $SUPPORT" >&2
  exit 1
fi

echo
echo "Готово. Помощник: $HOST_PATH"
echo "ID расширения:    $EXT_ID"
echo "Скриншоты будут сохраняться в ~/Desktop."
echo "При первом экспорте macOS может спросить, разрешить ли браузеру доступ к папке «Рабочий стол»."
