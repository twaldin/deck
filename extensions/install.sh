#!/usr/bin/env bash
set -euo pipefail

# Install Deck's pi extensions as DIRECTORY extensions.
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
NATIVE_DEST="$EXTENSIONS_DIR/deck-native-compaction"

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

# The questions extension moved into deck-v2 (v2/install.sh), which installs
# into the ORCHESTRATOR home's own .pi — a global install here put ask_captain
# and /questions into every pi session on the machine, including worker `pi -p`
# sessions, each one a competing question surface. Remove an install of ours;
# leave anything we cannot prove is ours.
QUESTIONS_DEST="$EXTENSIONS_DIR/deck-questions"
if [ -L "$QUESTIONS_DEST/index.ts" ]; then
  case "$(readlink "$QUESTIONS_DEST/index.ts")" in
    */extensions/src/questions.ts)
      rm -rf "$QUESTIONS_DEST"
      printf 'removed retired deck-questions extension from %s (now part of deck-v2)\n' "$EXTENSIONS_DIR"
      ;;
    *)
      printf 'warning: %s is not ours; leaving it in place\n' "$QUESTIONS_DEST" >&2
      ;;
  esac
fi

mkdir -p "$DEST"
# -n prevents following an existing symlink; -f makes reruns converge.
ln -sfn "$SOURCE_DIR/idle-compaction.ts" "$DEST/index.ts"
ln -sfn "$SOURCE_DIR/idle-compaction-policy.ts" "$DEST/idle-compaction-policy.ts"

mkdir -p "$NATIVE_DEST"
ln -sfn "$SOURCE_DIR/native-compaction.ts" "$NATIVE_DEST/index.ts"

printf 'installed Deck idle-compaction pi extension in %s\n' "$DEST"
printf 'installed Deck native-compaction pi extension in %s\n' "$NATIVE_DEST"
# `typebox` needs no vendoring here: pi provides it to extensions itself.
