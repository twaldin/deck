#!/usr/bin/env bash
set -euo pipefail

# Install Deck's hardened pi subagent extension and exact-name agent registry.
# INSTALL_TARGET is overridable for safe local testing.
INSTALL_TARGET="${INSTALL_TARGET:-$HOME/.pi/agent}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXTENSION_SOURCE="$REPO_ROOT/subagents/deck-subagents.ts"
LIB_SOURCE="$REPO_ROOT/subagents/lib"
PROVIDER_SOURCE="$REPO_ROOT/broker/pi/deck-provider.ts"
ZOD_SOURCE="$REPO_ROOT/broker/node_modules/zod"

if [[ ! -f "$EXTENSION_SOURCE" || ! -d "$LIB_SOURCE" || ! -f "$PROVIDER_SOURCE" ]]; then
  printf 'error: deck-subagents or Deck provider source is incomplete under %s\n' "$REPO_ROOT" >&2
  exit 1
fi
if [[ ! -d "$ZOD_SOURCE" ]]; then
  printf 'error: Deck provider dependencies are missing; run bun install --cwd %s/broker\n' "$REPO_ROOT" >&2
  exit 1
fi

link_tree() {
  local source="$1" destination="$2"
  mkdir -p "$destination"
  while IFS= read -r -d '' source_path; do
    local relative target
    relative="${source_path#"$source"/}"
    target="$destination/$relative"
    mkdir -p "$(dirname "$target")"
    # -n prevents following an existing symlink; -f makes reruns converge.
    ln -sfn "$source_path" "$target"
  done < <(find "$source" -type f -print0)
}

rm -rf "$INSTALL_TARGET/extensions/subagent" "$INSTALL_TARGET/extensions/deck-subagents"
mkdir -p "$INSTALL_TARGET/extensions/deck-subagents"
cp "$EXTENSION_SOURCE" "$INSTALL_TARGET/extensions/deck-subagents/index.ts"
cp -R "$LIB_SOURCE" "$INSTALL_TARGET/extensions/deck-subagents/lib"
# The child disables global discovery, so its explicitly loaded Deck provider
# and zod dependency must be installed beside the extension.
ln -sfn "$PROVIDER_SOURCE" "$INSTALL_TARGET/extensions/deck-provider.ts"
mkdir -p "$INSTALL_TARGET/extensions/node_modules"
ln -sfn "$ZOD_SOURCE" "$INSTALL_TARGET/extensions/node_modules/zod"
# The installed copy resolves its only package dependency beside the extension.
PI_PACKAGE_ROOT="$(node -e 'try { process.stdout.write(require.resolve("@earendil-works/pi-coding-agent/package.json")) } catch { process.exit(1) }' 2>/dev/null || true)"
if [[ -z "$PI_PACKAGE_ROOT" ]]; then
  PI_PACKAGE_ROOT="/Users/twaldin/.nvm/versions/node/v24.8.0/lib/node_modules/@earendil-works/pi-coding-agent/package.json"
fi
if [[ -f "$PI_PACKAGE_ROOT" ]]; then
  PACKAGE_ROOT="$(dirname "$PI_PACKAGE_ROOT")"
  DEPENDENCY_ROOT="$PACKAGE_ROOT/node_modules"
  mkdir -p "$INSTALL_TARGET/extensions/deck-subagents/node_modules"
  ln -sfn "$DEPENDENCY_ROOT/typebox" "$INSTALL_TARGET/extensions/deck-subagents/node_modules/typebox"
fi
AGENTS_SOURCE="$(cd "$(dirname "$0")" && pwd)/agents"
# The tool validates only this namespaced registry. The user-level links expose
# the same definitions to pi without allowing unrelated ambient agents to spawn.
link_tree "$AGENTS_SOURCE" "$INSTALL_TARGET/extensions/deck-subagents/agents"
link_tree "$AGENTS_SOURCE" "$INSTALL_TARGET/agents"
printf 'installed deck-subagents extension and Deck agents in %s\n' "$INSTALL_TARGET"
