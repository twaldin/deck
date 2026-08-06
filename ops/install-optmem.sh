#!/usr/bin/env bash
set -euo pipefail

readonly OPTMEM_REVISION="1fb164cf39028047781f72ac3bb1e5a691c1dcb0"
readonly UPSTREAM_INSTALLER="https://raw.githubusercontent.com/VictorTaelin/OptMem/${OPTMEM_REVISION}/install.sh"
readonly MUTABLE_MEMO_URL="https://raw.githubusercontent.com/VictorTaelin/OptMem/main/memo"
readonly PINNED_MEMO_URL="https://raw.githubusercontent.com/VictorTaelin/OptMem/${OPTMEM_REVISION}/memo"
readonly MEMO="${HOME}/.optmem/memo"

command -v curl >/dev/null 2>&1 || {
	printf 'ERROR: curl is required to install OptMem.\n' >&2
	exit 1
}
# Run the pinned upstream installer after replacing its one mutable payload URL
# with the same pinned revision. Re-running updates the executable without
# replacing the append-only memory log.
installer="$(curl -fsSL "${UPSTREAM_INSTALLER}")"
installer="${installer/"${MUTABLE_MEMO_URL}"/"${PINNED_MEMO_URL}"}"
printf '%s\n' "${installer}" | sh

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
