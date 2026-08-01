#!/usr/bin/env bash
set -euo pipefail
# Idempotent install/update. Private home sync requires: gh auth login.
REPO="${DECK_REPO:-$HOME/dev/deck}"
if [ ! -d "$REPO/.git" ]; then
  command -v gh >/dev/null || { echo "error: install gh and run gh auth login" >&2; exit 1; }
  gh repo clone twaldin/deck "$REPO"
fi
git -C "$REPO" fetch origin main
git -C "$REPO" checkout -B main origin/main
bash "$REPO/scripts/update-home.sh"
printf '\nInstall/update complete. Copy .env secrets by hand, start the broker, and accept pi trust prompts.\n'
