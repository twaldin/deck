#!/usr/bin/env bash
set -euo pipefail

# Install Deck's vendored Ponytail pi extension and skills. INSTALL_TARGET is
# intentionally overridable so tests never need to touch the live ~/.pi/agent.
INSTALL_TARGET="${INSTALL_TARGET:-$HOME/.pi/agent}"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$INSTALL_TARGET/extensions/ponytail"

mkdir -p "$DEST" "$DEST/skills" "$INSTALL_TARGET/skills"
# Copy, rather than link, so a checkout can be removed without breaking pi.
# rsync makes repeated installs converge and removes stale vendored files.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$SOURCE_DIR/pi-extension/" "$DEST/"
  mkdir -p "$DEST/skills"
  rsync -a --delete "$SOURCE_DIR/hooks/" "$DEST/hooks/"
  for skill in "$SOURCE_DIR"/skills/*; do
    rsync -a --delete "$skill/" "$DEST/skills/$(basename "$skill")/"
    rsync -a --delete "$skill/" "$INSTALL_TARGET/skills/$(basename "$skill")/"
  done
else
  rm -rf "$DEST" "$INSTALL_TARGET/skills/ponytail" "$INSTALL_TARGET/skills/ponytail-review" "$INSTALL_TARGET/skills/ponytail-audit" "$INSTALL_TARGET/skills/ponytail-debt" "$INSTALL_TARGET/skills/ponytail-gain" "$INSTALL_TARGET/skills/ponytail-help"
  mkdir -p "$DEST" "$DEST/hooks" "$DEST/skills"
  cp -R "$SOURCE_DIR/pi-extension/." "$DEST/"
  cp -R "$SOURCE_DIR/hooks/." "$DEST/hooks/"
  for skill in "$SOURCE_DIR"/skills/*; do
    name="$(basename "$skill")"
    mkdir -p "$INSTALL_TARGET/skills/$name" "$DEST/skills/$name"
    cp -R "$skill/." "$INSTALL_TARGET/skills/$name/"
    cp -R "$skill/." "$DEST/skills/$name/"
  done
fi
printf 'installed Deck Ponytail pi extension and skills in %s\n' "$INSTALL_TARGET"
