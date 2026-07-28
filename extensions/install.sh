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
EXTENSIONS_DIR="$INSTALL_TARGET/extensions"
DEST="$EXTENSIONS_DIR/deck-idle-compaction"

mkdir -p "$EXTENSIONS_DIR"

# Migrate away from the flat layout an earlier revision of README.md told
# operators to create. Leaving those entries behind is not harmless: because pi
# discovers `extensions/*.ts`, a stale flat entry keeps failing (broken sibling
# import, or the policy file rejected as its own extension) even after this
# installer has written the good directory next to it.
#
# Only remove entries we can prove are ours: a symlink resolving into this
# repository's extensions/src. Anything else is user-owned, so stop and report
# it rather than silently deleting a file whose provenance we do not know.
for stale in "$EXTENSIONS_DIR/deck-idle-compaction.ts" "$EXTENSIONS_DIR/idle-compaction-policy.ts"; do
  if [ -L "$stale" ]; then
    resolved="$(cd "$(dirname "$stale")" && readlink "$stale")"
    case "$resolved" in
      /*) ;;
      *) resolved="$EXTENSIONS_DIR/$resolved" ;;
    esac
    resolved_dir="$(cd "$(dirname "$resolved")" 2>/dev/null && pwd || true)"
    if [ "$resolved_dir" = "$SOURCE_DIR" ]; then
      rm -f "$stale"
      printf 'removed stale flat extension entry %s\n' "$stale"
      continue
    fi
  fi
  if [ -e "$stale" ] || [ -L "$stale" ]; then
    printf 'error: %s exists but is not a symlink into %s.\n' "$stale" "$SOURCE_DIR" >&2
    printf '       pi would load it as its own extension. Remove it by hand, then rerun.\n' >&2
    exit 1
  fi
done

mkdir -p "$DEST"
# -n prevents following an existing symlink; -f makes reruns converge.
ln -sfn "$SOURCE_DIR/idle-compaction.ts" "$DEST/index.ts"
ln -sfn "$SOURCE_DIR/idle-compaction-policy.ts" "$DEST/idle-compaction-policy.ts"

printf 'installed Deck idle-compaction pi extension in %s\n' "$DEST"
