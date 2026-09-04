#!/usr/bin/env bash
# Launches the community Toast MCP server (read-only) for Claude Code to
# inspect real Toast payloads during development. Not used by the app.
#
# Repo: https://github.com/BusyBee3333/toast-mcp-2026-complete  (MIT, unofficial,
# "contract-verified, live-unverified"). Review the source before trusting it
# with credentials — it runs locally and never sends secrets to the model.
#
# Config: create .env.toast in the repo root (gitignored via .env*):
#   TOAST_API_ACCESS_URL=https://ws-api.toasttab.com
#   TOAST_CLIENT_ID=...
#   TOAST_CLIENT_SECRET=...
#   TOAST_RESTAURANT_GUIDS=<location guid>
# Without .env.toast it starts in demo mode with synthetic data.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${TOAST_MCP_DIR:-$HOME/.cache/toast-mcp-community}"

if [ ! -f "$DIR/dist/src/main.js" ]; then
  echo "[toast-mcp] installing to $DIR" >&2
  git clone --depth 1 https://github.com/BusyBee3333/toast-mcp-2026-complete "$DIR" >&2
  (cd "$DIR" && npm ci >&2 && npm run build >&2)
fi

if [ -f "$ROOT/.env.toast" ]; then
  set -a; . "$ROOT/.env.toast"; set +a
  export TOAST_MCP_MODE=live
else
  export TOAST_MCP_MODE=demo
fi
exec node "$DIR/dist/src/main.js"
