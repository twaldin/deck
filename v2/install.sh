#!/usr/bin/env bash
set -euo pipefail

# Install the deck-v2 pi extension and the deck-v2 CLI.
# INSTALL_TARGET is overridable so tests never touch live ~/.pi.
#
# The extension is a DIRECTORY, not a flat symlink. pi discovers both
# `extensions/*.ts` and `extensions/*/index.ts`; a flat symlink resolves its
# relative sibling imports next to the SYMLINK rather than the real source, so
# the imports fail, and a flat sibling dropped beside it gets loaded as its own
# extension and rejected. The whole extension must live inside one directory
# where only index.ts is an entrypoint.
#
# deck-v2's extension imports ../*.ts from the v2 package, so the directory
# holds a symlink to the repo source tree instead of copies: one source of
# truth, and an edit is live without reinstalling.
# Default target is the ORCHESTRATOR HOME's own .pi, not the global ~/.pi/agent:
# these tools operate one home's fleet, so scoping them there keeps an unrelated
# pi session in another directory from loading a fleet-control extension.
# Override INSTALL_TARGET=$HOME/.pi/agent for a global install.
DECK_V2_HOME_DIR="${DECK_V2_HOME:-$HOME/deck}"
INSTALL_TARGET="${INSTALL_TARGET:-$DECK_V2_HOME_DIR/.pi}"
REPO_V2="$(cd "$(dirname "$0")" && pwd)"
EXTENSIONS_DIR="$INSTALL_TARGET/extensions"
DEST="$EXTENSIONS_DIR/deck-v2"

mkdir -p "$EXTENSIONS_DIR"

# Refuse to clobber anything we cannot prove is ours.
if [ -e "$DEST" ] && [ ! -L "$DEST" ] && [ ! -d "$DEST" ]; then
  printf 'error: %s exists and is neither our directory nor a symlink.\n' "$DEST" >&2
  exit 1
fi

# A stale flat entry keeps failing even after a good directory exists beside it,
# because pi discovers extensions/*.ts too. Only remove one we can prove is ours.
stale="$EXTENSIONS_DIR/deck-v2.ts"
if [ -L "$stale" ]; then
  resolved="$(readlink "$stale")"
  case "$resolved" in
    "$REPO_V2"/*) rm -f "$stale"; printf 'removed stale flat entry %s\n' "$stale" ;;
    *) printf 'error: %s is a symlink we do not own.\n' "$stale" >&2; exit 1 ;;
  esac
elif [ -e "$stale" ]; then
  printf 'error: %s exists but is not our symlink; remove it by hand.\n' "$stale" >&2
  exit 1
fi

# pi resolves an extension's relative imports against the SYMLINK's directory,
# not the real file, so `index.ts -> .../src/extension/index.ts` cannot find
# `../events`. Verified: it fails with "Cannot find module '../events'".
#
# So the installed directory reproduces the source layout one level down:
#   deck-v2/extension/index.ts -> real src/extension/index.ts
#   deck-v2/<module>.ts        -> real src/<module>.ts
# `../events` from extension/index.ts then resolves to deck-v2/events.ts, which
# is the real module. Only extension/index.ts is nested, so pi finds exactly one
# entrypoint: pi discovers `*/index.ts`, not `*/*/index.ts`.
rm -rf "$DEST"
mkdir -p "$DEST/extension"
ln -sfn "$REPO_V2/src/extension/index.ts" "$DEST/extension/index.ts"
for module in "$REPO_V2"/src/*.ts; do
  name="$(basename "$module")"
  # index.ts is deliberately skipped: DEST/index.ts is the generated entrypoint
  # shim below, and symlinking it here would make the shim's redirect write
  # straight through the link into the repo's own src/index.ts.
  [ "$name" = "index.ts" ] && continue
  ln -sfn "$module" "$DEST/$name"
done
# The entrypoint pi loads. Re-exporting keeps the single-entrypoint rule while
# the real code stays in extension/index.ts next to its siblings.
rm -f "$DEST/index.ts"
printf 'export { default } from "./extension/index.ts";\n' > "$DEST/index.ts"

printf 'installed deck-v2 pi extension in %s\n' "$DEST"

# CLI: a shim on PATH pointing at the repo bin, so both faces run one source.
BIN_TARGET="${BIN_TARGET:-$HOME/.local/bin}"
mkdir -p "$BIN_TARGET"
ln -sfn "$REPO_V2/bin/deck-v2" "$BIN_TARGET/deck-v2"
printf 'installed deck-v2 CLI at %s/deck-v2\n' "$BIN_TARGET"
