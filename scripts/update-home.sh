#!/usr/bin/env bash
# Pull the configured Deck branch and run the same convergent Prime install path
# used by a fresh machine.
set -euo pipefail

REPO="${DECK_REPO:-$HOME/dev/deck}"
BRANCH="${DECK_BRANCH:-main}"
if [ ! -d "$REPO/.git" ]; then
  echo "error: no deck checkout at $REPO (set DECK_REPO=...)" >&2
  exit 1
fi

for prerequisite in bun curl git node npm python3 shasum tar; do
  command -v "$prerequisite" >/dev/null 2>&1 || {
    echo "error: $prerequisite is required before updating" >&2
    exit 1
  }
done

cd "$REPO"
git fetch origin "$BRANCH"
git checkout -B "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"

DECK_HOME_PROFILE="${DECK_HOME_PROFILE:-}" bash "$REPO/install.sh"

# Sync the machine's filtered home profile into the plain operator directory.
# Clone to a temporary directory. Never turn ~/.deck into a git checkout.
HOME_REPO="${DECK_HOME_REPO:-$HOME/.deck}"
PROFILE_MARKER="$HOME_REPO/.deck-profile"
if [ -n "${DECK_HOME_PROFILE:-}" ]; then
  HOME_PROFILE="$DECK_HOME_PROFILE"
  case "$HOME_PROFILE" in full|personal) ;; *) echo "home sync skipped: invalid DECK_HOME_PROFILE=$HOME_PROFILE" >&2; HOME_PROFILE="" ;; esac
elif [ -f "$PROFILE_MARKER" ]; then
  HOME_PROFILE="$(tr -d '[:space:]' < "$PROFILE_MARKER")"
  case "$HOME_PROFILE" in full|personal) ;; *) echo "home sync skipped: invalid $PROFILE_MARKER" >&2; HOME_PROFILE="" ;; esac
else
  echo "home sync skipped: no DECK_HOME_PROFILE and no $PROFILE_MARKER; refusing to guess" >&2
  HOME_PROFILE=""
fi
if [ -n "$HOME_PROFILE" ] && [ -n "${DECK_HOME_PROFILE:-}" ] && [ ! -e "$PROFILE_MARKER" ]; then
  printf '%s\n' "$HOME_PROFILE" > "$PROFILE_MARKER"
  chmod 600 "$PROFILE_MARKER"
fi
if [ -n "$HOME_PROFILE" ] && command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  TEMP_HOME="$(mktemp -d)"
  trap 'rm -rf "$TEMP_HOME"' EXIT
  HOME_REMOTE="${DECK_HOME_GIT_REMOTE:-}"
  if [ -z "$HOME_REMOTE" ]; then
    echo "home sync skipped: DECK_HOME_GIT_REMOTE is unset" >&2
  elif gh repo clone "$HOME_REMOTE" "$TEMP_HOME/repo" -- --branch "profile/$HOME_PROFILE" >/dev/null 2>&1; then
    if [ "$HOME_PROFILE" = "personal" ] && find "$TEMP_HOME/repo" -type f \( -name 'restricted-*' -o -path '*/secrets-map.md' \) -not -path '*/.git/*' -print -quit | grep -q .; then
      echo "error: restricted project material in personal home" >&2
      exit 1
    fi
    mkdir -p "$HOME_REPO"
    # Preserve live state, data, contract, and local secrets. Copy only profile files.
    for item in "$TEMP_HOME/repo"/* "$TEMP_HOME/repo"/.[!.]*; do
      [ -e "$item" ] || continue
      name="$(basename "$item")"
      case "$name" in .git|.prime|.env|.deck-profile|AGENTS.md|data|state|wt|logs|run|questions|broker) continue ;; esac
      cp -a "$item" "$HOME_REPO/"
    done
  else
    echo "home sync skipped: unable to clone $HOME_REMOTE profile/$HOME_PROFILE" >&2
  fi
else
  echo "home sync skipped: gh auth is not configured" >&2
fi


mkdir -p "$HOME/.deck/data/inbox"
echo "updated: $(git -C "$REPO" rev-parse --short HEAD)  home=$HOME/.deck"
echo "next: source ~/.deck/enter.sh && prime-conversation"
command -v deck-v2 >/dev/null && deck-v2 fleet 2>/dev/null | head -5 || true
