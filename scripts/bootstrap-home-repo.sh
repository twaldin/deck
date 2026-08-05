#!/usr/bin/env bash
# Create the private home repository and its two structurally filtered branches.
set -euo pipefail

REMOTE="${DECK_HOME_GIT_REMOTE:?Set DECK_HOME_GIT_REMOTE to the private home repository}"
FULL_SOURCE="${1:?usage: bootstrap-home-repo.sh FULL_SOURCE PERSONAL_SOURCE}"
PERSONAL_SOURCE="${2:?usage: bootstrap-home-repo.sh FULL_SOURCE PERSONAL_SOURCE}"
for source in "$FULL_SOURCE" "$PERSONAL_SOURCE"; do
  [ -d "$source" ] || { echo "error: missing profile source: $source" >&2; exit 1; }
done
if find "$PERSONAL_SOURCE" -type f \( -name 'restricted-*' -o -path '*/secrets-map.md' \) -print -quit | grep -q .; then
  echo "error: personal source contains restricted project material" >&2
  exit 1
fi

gh repo view "$REMOTE" >/dev/null 2>&1 || gh repo create "$REMOTE" --private --description "Deck operator home profiles" >/dev/null
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
git init -q "$TEMP/repo"
git -C "$TEMP/repo" remote add origin "https://github.com/$REMOTE.git"

build_profile() {
  local name="$1" source="$2" item base
  git -C "$TEMP/repo" checkout -q --orphan "profile/$name"
  git -C "$TEMP/repo" rm -qr . 2>/dev/null || true
  for item in "$source"/* "$source"/.[!.]*; do
    [ -e "$item" ] || continue
    base="$(basename "$item")"
    case "$base" in .git|.env|.pi|AGENTS.md|data|state|wt|logs|run|questions|broker) continue ;; esac
    cp -a "$item" "$TEMP/repo/"
  done
  git -C "$TEMP/repo" add -A
  git -C "$TEMP/repo" commit -qm "build $name profile"
  git -C "$TEMP/repo" push -fu origin "profile/$name"
}

build_profile full "$FULL_SOURCE"
build_profile personal "$PERSONAL_SOURCE"
printf 'created %s with profile/full and profile/personal\n' "$REMOTE"
