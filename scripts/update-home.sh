#!/usr/bin/env bash
# Pull latest deck main + reinstall shims/extension. Safe to re-run.
# Existing installs are the primary case. Private home sync needs `gh auth login`.
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

# Sync the machine's filtered home profile into the plain operator directory.
# Clone to a temporary directory. Never turn ~/.deck into a git checkout.
HOME_REPO="${DECK_HOME_REPO:-$HOME/.deck}"
HOME_PROFILE="${DECK_HOME_PROFILE:-personal}"
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  TEMP_HOME="$(mktemp -d)"
  trap 'rm -rf "$TEMP_HOME"' EXIT
  gh repo clone twaldin/deck-home "$TEMP_HOME/repo" -- --branch "profile/$HOME_PROFILE" >/dev/null
  if [ "$HOME_PROFILE" = "personal" ]; then
    if find "$TEMP_HOME/repo" -type f \( -name 'lindy-*' -o -path '*/secrets-map.md' \) -not -path '*/.git/*' -print -quit | grep -q .; then
      echo "error: Lindy material in personal home" >&2
      exit 1
    fi
  fi
  mkdir -p "$HOME_REPO"
  # Preserve live state, data, contract, and local secrets. Copy only profile files.
  for item in "$TEMP_HOME/repo"/* "$TEMP_HOME/repo"/.[!.]*; do
    [ -e "$item" ] || continue
    name="$(basename "$item")"
    case "$name" in .git|data|state|.env|AGENTS.md) continue ;; esac
    cp -a "$item" "$HOME_REPO/"
  done
else
  echo "home sync skipped: gh auth is not configured" >&2
fi

# Seed the operator contract on first update. Never overwrite captain edits.
# Use the repository shim directly because ~/.local/bin may not be on PATH yet.
# Use the bootstrap path so stripping, permissions, and DECK_V2_HOME stay aligned.
"$REPO/v2/bin/deck-v2" bootstrap >/dev/null

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
