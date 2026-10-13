#!/bin/bash
# Removes the native helper installed by install.sh.
set -euo pipefail

HOST_NAME="com.comment_my_site.saver"
SUPPORT="$HOME/Library/Application Support"

for manifest in "$SUPPORT"/*/NativeMessagingHosts/"$HOST_NAME.json" \
                "$SUPPORT"/*/*/NativeMessagingHosts/"$HOST_NAME.json"; do
  [[ -f "$manifest" ]] || continue
  rm -f "$manifest"
  echo "✓ удалён $manifest"
done

rm -rf "$SUPPORT/CommentMySite"
echo "Помощник удалён. Расширение будет сохранять файлы через диалог «Сохранить как»."
