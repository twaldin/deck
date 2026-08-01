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
# Must match deckV2Home() in src/home.ts (~/.deck), or the extension installs
# into a pi home no orchestrator session ever starts from.
DECK_V2_HOME_DIR="${DECK_V2_HOME:-$HOME/.deck}"
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

# deck: the worktree allocator CLI (repo cli/bin/deck). spawn shells out to it,
# so it must be on PATH wherever deck-v2 is.
DECK_SHIM="$BIN_TARGET/deck"
if [ -e "$DECK_SHIM" ] && [ ! -L "$DECK_SHIM" ]; then
  printf 'error: %s exists and is not a symlink; remove it by hand.\n' "$DECK_SHIM" >&2
  exit 1
fi
ln -sfn "$REPO_V2/../cli/bin/deck" "$DECK_SHIM"
printf 'installed deck CLI at %s\n' "$DECK_SHIM"

# smithers: a pinned PATH shim, never a global npm install. The version is read
# from src/smithers.ts — the one pin deck code shells out with — so shim and
# code cannot skew. bunx from a directory without a package.json can silently
# resolve a NEWER cached CLI, which is exactly what the pin prevents.
SMITHERS_VERSION="$(sed -n 's/^export const SMITHERS_VERSION = "\(.*\)";$/\1/p' "$REPO_V2/src/smithers.ts")"
if [ -z "$SMITHERS_VERSION" ]; then
  printf 'error: could not read SMITHERS_VERSION from %s/src/smithers.ts\n' "$REPO_V2" >&2
  exit 1
fi
SMITHERS_SHIM="$BIN_TARGET/smithers"
if [ -e "$SMITHERS_SHIM" ] && ! grep -q 'deck smithers shim' "$SMITHERS_SHIM" 2>/dev/null; then
  printf 'error: %s exists and is not the deck shim; remove it by hand.\n' "$SMITHERS_SHIM" >&2
  exit 1
fi
cat > "$SMITHERS_SHIM" <<EOF
#!/usr/bin/env bash
# deck smithers shim — pinned; generated by v2/install.sh from src/smithers.ts
exec bunx smithers-orchestrator@$SMITHERS_VERSION "\$@"
EOF
chmod +x "$SMITHERS_SHIM"
printf 'installed smithers shim (%s) at %s\n' "$SMITHERS_VERSION" "$SMITHERS_SHIM"

# Smithers runtime must be outside the development checkout. Copy only the
# workspace's static pack files; db, executions and logs are created here.
WORKFLOWS_SOURCE="${WORKFLOWS_SOURCE:-$(cd "$REPO_V2/../workflows" && pwd)}"
WORKSPACE_ROOT="$DECK_V2_HOME_DIR/state/smithers"
mkdir -p "$WORKSPACE_ROOT"
if [ -d "$WORKFLOWS_SOURCE/.smithers" ]; then
  for item in package.json bun.lock agents.ts agents ui; do
    [ -e "$WORKFLOWS_SOURCE/.smithers/$item" ] || continue
    [ -e "$WORKSPACE_ROOT/$item" ] || cp -a "$WORKFLOWS_SOURCE/.smithers/$item" "$WORKSPACE_ROOT/$item"
  done
fi
# Keep the old link name only for static compatibility. It is never the runtime
# workspace and no state is written through it.
WORKFLOWS_LINK="${WORKFLOWS_LINK:-$DECK_V2_HOME_DIR/workflows}"
if [ -L "$WORKFLOWS_LINK" ] || [ ! -e "$WORKFLOWS_LINK" ]; then
  mkdir -p "$(dirname "$WORKFLOWS_LINK")"
  ln -sfn "$WORKFLOWS_SOURCE" "$WORKFLOWS_LINK"
fi
if [ -f "$WORKSPACE_ROOT/package.json" ] && [ ! -d "$WORKSPACE_ROOT/node_modules" ]; then
  bun install --cwd "$WORKSPACE_ROOT"
fi
