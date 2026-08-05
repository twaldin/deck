#!/usr/bin/env bash
set -euo pipefail

readonly UPSTREAM_INSTALLER="https://raw.githubusercontent.com/VictorTaelin/OptMem/main/install.sh"
readonly MEMO="${HOME}/.optmem/memo"

command -v curl >/dev/null 2>&1 || {
	printf 'ERROR: curl is required to install OptMem.\n' >&2
	exit 1
}

# This is the upstream command from the OptMem README. Re-running it updates the
# executable without replacing the append-only memory log.
curl -fsSL "${UPSTREAM_INSTALLER}" | sh

if [[ ! -x "${MEMO}" ]]; then
	printf 'ERROR: the upstream installer did not create executable %s.\n' "${MEMO}" >&2
	exit 1
fi

if ! "${MEMO}" wake >/dev/null; then
	printf 'ERROR: OptMem installed, but memo wake failed.\n' >&2
	exit 1
fi

cat <<'EOF'

OptMem is installed and `memo wake` succeeded.
The upstream installer printed its authoritative `## Memory` block above.
For a deck home, that block is already present verbatim in v2/seed/AGENTS.md.
For any other agent home, paste the complete block at the top of AGENTS.md.
EOF
