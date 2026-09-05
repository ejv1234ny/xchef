#!/usr/bin/env bash
# Creates .env.toast (gitignored) by prompting for Toast Standard API credentials.
# Run from the repo root in Git Bash:  bash scripts/toast-env.sh
set -euo pipefail
cd "$(dirname "$0")/.."
echo "Toast Web → Integrations → Toast API access. Values are not echoed."
read -rp  "TOAST_CLIENT_ID: " TCID
read -rsp "TOAST_CLIENT_SECRET: " TCS; echo
read -rp  "TOAST_RESTAURANT_GUIDS (location GUID): " TGUID
[ -n "$TCID" ] && [ -n "$TCS" ] && [ -n "$TGUID" ] || { echo "all three values are required" >&2; exit 1; }
cat > .env.toast <<ENV
TOAST_API_ACCESS_URL=https://ws-api.toasttab.com
TOAST_CLIENT_ID=$TCID
TOAST_CLIENT_SECRET=$TCS
TOAST_RESTAURANT_GUIDS=$TGUID
ENV
unset TCID TCS TGUID
echo ".env.toast written ($(wc -l < .env.toast) lines). Next: tell Claude to continue."
