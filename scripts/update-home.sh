#!/usr/bin/env bash
# Pull latest deck v2 + reinstall shims/extension. Safe to re-run.
# Does NOT overwrite ~/.deck/AGENTS.md, broker store, or state.
set -euo pipefail

REPO="${DECK_REPO:-$HOME/dev/deck}"
if [ ! -d "$REPO/.git" ]; then
  echo "error: no deck checkout at $REPO (set DECK_REPO=...)" >&2
  exit 1
fi

cd "$REPO"
git fetch origin v2
git checkout v2
git pull --ff-only origin v2

bun install --cwd "$REPO/v2"
bun install --cwd "$REPO/broker"
bun install --cwd "$REPO/cli"
bash "$REPO/v2/install.sh"

# enter.sh for glass shells (PATH after nvm)
ENTER="$HOME/.deck/enter.sh"
if [ ! -f "$ENTER" ]; then
  mkdir -p "$HOME/.deck"
  cat > "$ENTER" <<'EOF'
#!/usr/bin/env bash
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 24 >/dev/null 2>&1 || true
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
cd "$HOME/.deck" || exit 1
echo "deck home=$(pwd) pi=$(command -v pi) tip=$(git -C "${DECK_REPO:-$HOME/dev/deck}" rev-parse --short HEAD 2>/dev/null)"
EOF
  chmod +x "$ENTER"
fi

mkdir -p "$HOME/.deck/data/inbox"
echo "updated: $(git -C "$REPO" rev-parse --short HEAD)  home=$HOME/.deck"
echo "next: source ~/.deck/enter.sh && pi"
command -v deck-v2 >/dev/null && deck-v2 fleet 2>/dev/null | head -5 || true
