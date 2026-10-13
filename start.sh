#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1; then
  VIEWER_NODE="$(command -v node)"
else
  VIEWER_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [[ ! -x "$VIEWER_NODE" ]]; then
  echo "请安装 Node.js 22.12+，然后运行 pnpm install && pnpm build && pnpm start。" >&2
  exit 1
fi
export PATH="$(dirname "$VIEWER_NODE"):$PATH"
if [[ ! -d node_modules ]]; then
  echo "请先在本目录运行 pnpm install（或 npm install）。" >&2
  exit 1
fi
# Always build from the current sources; an existing dist may belong to an older version.
"$VIEWER_NODE" node_modules/typescript/bin/tsc --noEmit
"$VIEWER_NODE" node_modules/vite/bin/vite.js build
VIEWER_SANDBOX_FLAGS=()
if [[ "$(uname -s)" == "Linux" ]]; then
  VIEWER_ELECTRON="$("$VIEWER_NODE" -p "require('electron')")"
  VIEWER_SANDBOX="$(dirname "$VIEWER_ELECTRON")/chrome-sandbox"
  if [[ ! -u "$VIEWER_SANDBOX" ]] || [[ "$(stat -c '%u' "$VIEWER_SANDBOX" 2>/dev/null || echo unknown)" != "0" ]]; then
    # Skip the unconfigured SUID helper; Chromium still uses its namespace sandbox.
    VIEWER_SANDBOX_FLAGS+=(--disable-setuid-sandbox)
  fi
fi
exec "$VIEWER_NODE" node_modules/electron/cli.js . "${VIEWER_SANDBOX_FLAGS[@]}" "$@"
