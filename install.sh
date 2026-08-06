#!/usr/bin/env bash
set -euo pipefail

# Deck-home bootstrap. Run once from a clone; use update.sh for later updates.
# Never copies secrets, starts resident services, or starts the review gate.

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

for prerequisite in bun curl git python3; do
  command -v "$prerequisite" >/dev/null || {
    echo "error: $prerequisite is required" >&2
    exit 1
  }
done

bun install --frozen-lockfile --cwd "$REPO/v2"
bun install --frozen-lockfile --cwd "$REPO/broker"
bun install --frozen-lockfile --cwd "$REPO/cli"

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

# Plain-session entrypoint and inbox.
mkdir -p "$HOME/.deck/data/inbox"
ENTER="$HOME/.deck/enter.sh"
cat > "$ENTER" <<'EOF'
#!/usr/bin/env bash
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

# Put Deck's generated command shims on PATH in interactive Bash shells.
if ! grep -q 'deck local bin' "$HOME/.bashrc" 2>/dev/null; then
  printf '\n# deck local bin\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.bashrc"
fi

chmod +x "$REPO/update.sh" 2>/dev/null || true

cat <<EOF

Done. Code: $REPO
Home: $HOME/.deck

Start a standalone session:

  source $HOME/.deck/enter.sh
  pi

In pi, run /login and configure your own provider subscription or API key,
then use /model to select it. The Deck broker is optional for the plain session;
configure it only when you want Deck's broker-backed models:

  bun $REPO/broker/src/cli.ts login anthropic
  bun --cwd $REPO/broker src/main.ts

No resident service or review-gate poller was started. See $REPO/ops/README.md
for optional services. Keep updated with $REPO/update.sh.

Never put work credentials, production tokens, or restricted checkouts on this host.
EOF
