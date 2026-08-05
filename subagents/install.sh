#!/usr/bin/env bash
set -euo pipefail

# Install the Deck-patched pi subagent extension and Deck's user-level agent definitions.
# INSTALL_TARGET and EXTENSION_SOURCE are overridable for safe local testing.
INSTALL_TARGET="${INSTALL_TARGET:-$HOME/.pi/agent}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXTENSION_SOURCE="${EXTENSION_SOURCE:-$REPO_ROOT/subagents/extension}"


if [[ ! -d "$EXTENSION_SOURCE" ]]; then
  printf 'error: pi subagent example not found: %s\n' "$EXTENSION_SOURCE" >&2
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

rm -rf "$INSTALL_TARGET/extensions/subagent"
mkdir -p "$INSTALL_TARGET/extensions/subagent"
cp -R "$EXTENSION_SOURCE"/. "$INSTALL_TARGET/extensions/subagent/"
rm -f "$INSTALL_TARGET/extensions/subagent/activity.ts"
ln -sfn "$REPO_ROOT/v2/src/activity.ts" "$INSTALL_TARGET/extensions/subagent/activity.ts"
# The installed extension keeps its source-relative imports. Link the pi package
# dependencies beside that copied source so Node resolves them under pi.
PI_PACKAGE_ROOT="$(node -e 'try { process.stdout.write(require.resolve("@earendil-works/pi-coding-agent/package.json")) } catch { process.exit(1) }' 2>/dev/null || true)"
if [[ -z "$PI_PACKAGE_ROOT" ]]; then
  PI_PACKAGE_ROOT="/Users/twaldin/.nvm/versions/node/v24.8.0/lib/node_modules/@earendil-works/pi-coding-agent/package.json"
fi
if [[ -f "$PI_PACKAGE_ROOT" ]]; then
  PACKAGE_ROOT="$(dirname "$PI_PACKAGE_ROOT")"
  PACKAGE_SCOPE="$(dirname "$PACKAGE_ROOT")"
  DEPENDENCY_ROOT="$PACKAGE_ROOT/node_modules"
  mkdir -p "$INSTALL_TARGET/extensions/subagent/node_modules/@earendil-works"
  for package in pi-agent-core pi-ai pi-tui; do
    ln -sfn "$DEPENDENCY_ROOT/@earendil-works/$package" "$INSTALL_TARGET/extensions/subagent/node_modules/@earendil-works/$package"
  done
  ln -sfn "$PACKAGE_ROOT" "$INSTALL_TARGET/extensions/subagent/node_modules/@earendil-works/pi-coding-agent"
  ln -sfn "$DEPENDENCY_ROOT/typebox" "$INSTALL_TARGET/extensions/subagent/node_modules/typebox"
fi
link_tree "$(cd "$(dirname "$0")" && pwd)/agents" "$INSTALL_TARGET/agents"
printf 'installed pi subagent extension and Deck agents in %s\n' "$INSTALL_TARGET"
