#!/usr/bin/env bash
set -euo pipefail

# Install Deck's idle-compaction pi extension as a DIRECTORY extension.
# INSTALL_TARGET is intentionally overridable so tests never touch live ~/.pi.
#
# Why a directory and not a single symlinked file: pi discovers
# `extensions/*.ts` AND `extensions/*/index.ts`. A lone
# `extensions/deck-idle-compaction.ts` symlink resolves its relative
# `./idle-compaction-policy` import next to the SYMLINK, not next to the real
# source, so the import fails. Dropping a flat sibling symlink beside it is
# worse: pi then discovers that sibling as its own top-level extension and
# rejects it ("does not export a valid factory"). Both files must live inside
# one extension directory, where only `index.ts` is an entrypoint.
INSTALL_TARGET="${INSTALL_TARGET:-$HOME/.pi/agent}"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)/src"
DEST="$INSTALL_TARGET/extensions/deck-idle-compaction"

mkdir -p "$DEST"
# -n prevents following an existing symlink; -f makes reruns converge.
ln -sfn "$SOURCE_DIR/idle-compaction.ts" "$DEST/index.ts"
ln -sfn "$SOURCE_DIR/idle-compaction-policy.ts" "$DEST/idle-compaction-policy.ts"

printf 'installed Deck idle-compaction pi extension in %s\n' "$DEST"
