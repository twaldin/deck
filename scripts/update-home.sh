#!/usr/bin/env bash
# Pull latest deck main + reinstall shims/extension. Safe to re-run.
# Does NOT overwrite ~/.deck/AGENTS.md, broker store, or state.
set -euo pipefail

REPO="${DECK_REPO:-$HOME/dev/deck}"
BRANCH="${DECK_BRANCH:-main}"
if [ ! -d "$REPO/.git" ]; then
  echo "error: no deck checkout at $REPO (set DECK_REPO=...)" >&2
  exit 1
fi

cd "$REPO"
git fetch origin "$BRANCH"
git checkout -B "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"

bun install --cwd "$REPO/v2"
bun install --cwd "$REPO/broker"
bun install --cwd "$REPO/cli"
bash "$REPO/v2/install.sh"

# Seed the operator contract on first update. Never overwrite captain edits.
# Use the bootstrap path so stripping, permissions, and DECK_V2_HOME stay aligned.
deck-v2 bootstrap >/dev/null

# enter.sh for glass shells (PATH after nvm)
ENTER="$HOME/.deck/enter.sh"
mkdir -p "$HOME/.deck"
# Always refresh enter.sh so PATH + silent .env load stay current.
cat > "$ENTER" <<'EOF'
#!/usr/bin/env bash
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 24 >/dev/null 2>&1 || true
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
# Home secrets (LINEAR_API_KEY, …). chmod 600. Never commit.
if [ -f "$HOME/.deck/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HOME/.deck/.env"
  set +a
fi
cd "$HOME/.deck" || exit 1
echo "deck home=$(pwd) pi=$(command -v pi) tip=$(git -C "${DECK_REPO:-$HOME/dev/deck}" rev-parse --short HEAD 2>/dev/null)"
EOF
chmod +x "$ENTER"

mkdir -p "$HOME/.deck/data/inbox"
echo "updated: $(git -C "$REPO" rev-parse --short HEAD)  home=$HOME/.deck"
echo "next: source ~/.deck/enter.sh && pi"
command -v deck-v2 >/dev/null && deck-v2 fleet 2>/dev/null | head -5 || true
