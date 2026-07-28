#!/usr/bin/env bash
set -euo pipefail

# Install the pi subagent extension and Deck's user-level agent definitions.
# INSTALL_TARGET is intentionally overridable for safe local testing.
INSTALL_TARGET="${INSTALL_TARGET:-$HOME/.pi/agent}"
if [[ -z "${EXTENSION_SOURCE:-}" ]]; then
  PI_PACKAGE_ROOT="$(node -e 'try { process.stdout.write(require.resolve("@earendil-works/pi-coding-agent/package.json")) } catch { process.exit(1) }' 2>/dev/null || true)"
  if [[ -n "$PI_PACKAGE_ROOT" ]]; then
    EXTENSION_SOURCE="$(dirname "$PI_PACKAGE_ROOT")/examples/extensions/subagent"
  else
    EXTENSION_SOURCE="/Users/twaldin/.nvm/versions/node/v24.8.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent"
  fi
fi

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

link_tree "$EXTENSION_SOURCE" "$INSTALL_TARGET/extensions/subagent"
link_tree "$(cd "$(dirname "$0")" && pwd)/agents" "$INSTALL_TARGET/agents"
printf 'installed pi subagent extension and Deck agents in %s\n' "$INSTALL_TARGET"
