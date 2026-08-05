#!/usr/bin/env bash
set -euo pipefail
# Update an existing deck installation. Private home sync requires: gh auth login.
REPO="${DECK_REPO:-$HOME/dev/deck}"
if [ ! -d "$REPO/.git" ]; then
  echo "error: no deck checkout at $REPO; run install.sh first" >&2
  exit 1
fi
git -C "$REPO" fetch origin main
git -C "$REPO" checkout -B main origin/main
bash "$REPO/scripts/update-home.sh"
printf '\nUpdate complete. Copy .env secrets by hand, start the broker, and accept pi trust prompts.\n'
