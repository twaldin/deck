#!/usr/bin/env bash
set -euo pipefail

# Personal deck-home bootstrap. Run on the PERSONAL host (deckbox) from a deck
# checkout. Installs deps, the pi extension + CLI shims, and creates ~/.deck.
# It never touches secrets: broker login is a separate, deliberate step, and
# no state is ever copied from another host (see docs/personal-home.md).

REPO="$(cd "$(dirname "$0")" && pwd -P)"

command -v bun >/dev/null || { echo "error: bun is required (https://bun.sh)" >&2; exit 1; }

bun install --cwd "$REPO/v2"
bun install --cwd "$REPO/broker"
bun install --cwd "$REPO/cli"

bash "$REPO/v2/install.sh"
bun "$REPO/v2/bin/deck-v2" bootstrap

cat <<'EOF'

Done. Next steps (manual, in order — docs/personal-home.md has details):

  1. start the broker:   bun --cwd <repo>/broker src/main.ts
  2. log in with PERSONAL accounts only:
                         bun <repo>/broker/src/cli.ts login anthropic
  3. herdr server:       herdr server   (glass in via `herdr --remote deckbox`)
  4. ensure ~/.local/bin is on PATH, then verify: deck-v2 fleet

Never put Lindy keys, prod-readonly credentials, or company checkouts on this
host. State in ~/.deck stays on this host; deck code syncs via git only.
EOF
