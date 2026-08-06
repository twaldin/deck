#!/usr/bin/env bash
set -euo pipefail
# Refresh an existing Deck installation. Use install.sh for first-time setup.
REPO="${DECK_REPO:-$HOME/dev/deck}"
BRANCH="${DECK_BRANCH:-main}"
if [ ! -d "$REPO/.git" ]; then
  echo "error: no deck checkout at $REPO; clone it and run install.sh first" >&2
  exit 1
fi
DECK_REPO="$REPO" DECK_BRANCH="$BRANCH" bash "$REPO/scripts/update-home.sh"
printf '\nUpdate complete. No services or review-gate pollers were started.\n'
