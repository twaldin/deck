#!/usr/bin/env bash
set -euo pipefail

# Deck-home bootstrap. Run on the durable operator host.
#   curl -fsSL https://raw.githubusercontent.com/OWNER/deck/main/install.sh | bash
# or from a clone: ./install.sh
# Never copies secrets. Broker login is interactive and separate.

if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
else
  # piped curl | bash — clone then re-exec
  REPO="${DECK_REPO:-$HOME/dev/deck}"
  if [ ! -d "$REPO/.git" ]; then
    command -v git >/dev/null || { echo "error: git required" >&2; exit 1; }
    if [ -z "${DECK_REPO_URL:-}" ] || [[ "$DECK_REPO_URL" == *"<owner>"* || "$DECK_REPO_URL" == *"OWNER"* ]]; then
      echo "error: set DECK_REPO_URL to your deck repository URL" >&2
      exit 1
    fi
    git clone "$DECK_REPO_URL" "$REPO"
  fi
  git -C "$REPO" fetch origin main
  git -C "$REPO" checkout main
  git -C "$REPO" pull --ff-only origin main
  exec bash "$REPO/install.sh"
fi

command -v bun >/dev/null || { echo "error: bun is required (https://bun.sh)" >&2; exit 1; }

bun install --cwd "$REPO/v2"
bun install --cwd "$REPO/broker"
bun install --cwd "$REPO/cli"

bash "$REPO/v2/install.sh"
bun "$REPO/v2/bin/deck-v2" bootstrap
if [ -n "${DECK_HOME_PROFILE:-}" ]; then
  case "$DECK_HOME_PROFILE" in
    full|personal) printf '%s\n' "$DECK_HOME_PROFILE" > "$HOME/.deck/.deck-profile"; chmod 600 "$HOME/.deck/.deck-profile" ;;
    *) echo "error: DECK_HOME_PROFILE must be full or personal" >&2; exit 1 ;;
  esac
else
  echo "Home sync is disabled until DECK_HOME_PROFILE is set to full or personal."
fi

# glass entry + inbox
mkdir -p "$HOME/.deck/data/inbox"
ENTER="$HOME/.deck/enter.sh"
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
echo "deck home=$(pwd) pi=$(command -v pi)"
EOF
chmod +x "$ENTER"

# PATH: local bin after nvm in interactive shells
if ! grep -q 'deck local bin after nvm' "$HOME/.bashrc" 2>/dev/null; then
  printf '\n# deck local bin after nvm\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.bashrc"
fi

chmod +x "$REPO/update.sh" 2>/dev/null || true

cat <<EOF

Done. Code: $REPO
Home: $HOME/.deck

Next (interactive, personal accounts only):

  1. Broker (user systemd or):  bun --cwd $REPO/broker src/main.ts
     login:  bun $REPO/broker/src/cli.ts login anthropic
  2. herdr server (user unit or): herdr server
  3. Glass:  herdr --remote <user>@<host>
     then:   source ~/.deck/enter.sh && pi

Keep updated:  $REPO/update.sh
Laptop agents: cat $REPO/docs/LAPTOP-AGENTS.md

Never put work credentials, production tokens, or restricted checkouts on this host.
EOF
