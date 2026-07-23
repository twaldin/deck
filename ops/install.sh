#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
LAUNCHD_DIR="${SCRIPT_DIR}/launchd"
AGENT_DIR="${HOME}/Library/LaunchAgents"
LOG_DIR="${HOME}/.deck/logs"
DECK_ROOT="${HOME}/dev/deck"
USER_UID="$(id -u)"
DOMAIN="gui/${USER_UID}"

LABELS=(
	"ai.deck.broker"
	"ai.deck.router"
)
ENTRYPOINTS=(
	"${DECK_ROOT}/broker/src/main.ts"
	"${DECK_ROOT}/router/src/main.ts"
)

usage() {
	cat <<'EOF'
Usage: ./ops/install.sh [--yes]

Without --yes, prints the installation plan and makes no changes.
EOF
}

service_loaded() {
	local label="$1"
	launchctl print "${DOMAIN}/${label}" >/dev/null 2>&1 || launchctl list "${label}" >/dev/null 2>&1
}

print_plan() {
	local index label source destination entrypoint

	printf 'Deck launchd installation plan (no changes yet):\n'
	printf '  create %s and %s with mode 0700\n' "${HOME}/.deck" "${LOG_DIR}"
	printf '  create %s if needed\n' "${AGENT_DIR}"

	for index in "${!LABELS[@]}"; do
		label="${LABELS[$index]}"
		source="${LAUNCHD_DIR}/${label}.plist"
		destination="${AGENT_DIR}/${label}.plist"
		entrypoint="${ENTRYPOINTS[$index]}"
		if [[ -f "${entrypoint}" ]]; then
			printf '  copy %s to %s\n' "${source}" "${destination}"
			printf '  launchctl bootstrap %s %s (fallback: launchctl load -w %s)\n' "${DOMAIN}" "${destination}" "${destination}"
			printf '  verify %s/%s is loaded\n' "${DOMAIN}" "${label}"
		else
			printf '  WARNING: skip %s because %s is missing\n' "${label}" "${entrypoint}"
		fi
	done
}

bootstrap_agent() {
	local label="$1"
	local destination="$2"

	if service_loaded "${label}"; then
		printf '%s is already loaded; leaving the running service unchanged.\n' "${label}"
	elif launchctl bootstrap "${DOMAIN}" "${destination}"; then
		printf 'Bootstrapped %s.\n' "${label}"
	else
		printf 'WARNING: launchctl bootstrap failed for %s; trying legacy load -w.\n' "${label}" >&2
		if ! launchctl load -w "${destination}" && ! service_loaded "${label}"; then
			printf 'ERROR: unable to load %s.\n' "${label}" >&2
			return 1
		fi
	fi

	if ! service_loaded "${label}"; then
		printf 'ERROR: status check did not find %s loaded.\n' "${DOMAIN}/${label}" >&2
		return 1
	fi
	printf 'Status: %s/%s is loaded.\n' "${DOMAIN}" "${label}"
}

confirm=false
if (( $# > 1 )); then
	usage >&2
	exit 2
fi
if (( $# == 1 )); then
	case "$1" in
		--yes)
			confirm=true
			;;
		--help|-h)
			usage
			exit 0
			;;
		*)
			usage >&2
			exit 2
			;;
	esac
fi

print_plan
if [[ "${confirm}" != true ]]; then
	printf '\nNo changes made. Re-run with --yes to apply this plan.\n'
	exit 0
fi

# State directories stay private even though launchd owns the resident processes (SPEC §0, PLAN §5.2).
mkdir -p "${HOME}/.deck" "${LOG_DIR}" "${AGENT_DIR}"
chmod 0700 "${HOME}/.deck" "${LOG_DIR}"

for index in "${!LABELS[@]}"; do
	label="${LABELS[$index]}"
	entrypoint="${ENTRYPOINTS[$index]}"
	source="${LAUNCHD_DIR}/${label}.plist"
	destination="${AGENT_DIR}/${label}.plist"

	if [[ ! -f "${entrypoint}" ]]; then
		printf 'WARNING: skipped %s because %s is missing.\n' "${label}" "${entrypoint}" >&2
		continue
	fi
	if [[ ! -f "${source}" ]]; then
		printf 'ERROR: source plist %s is missing.\n' "${source}" >&2
		exit 1
	fi

	install -m 0644 "${source}" "${destination}"
	bootstrap_agent "${label}" "${destination}"
done
