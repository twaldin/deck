#!/usr/bin/env bash
set -euo pipefail

AGENT_DIR="${HOME}/Library/LaunchAgents"
USER_UID="$(id -u)"
DOMAIN="gui/${USER_UID}"

LABELS=(
	"ai.deck.broker"
)

usage() {
	cat <<'EOF'
Usage: ./ops/uninstall.sh [--yes]

Without --yes, prints the removal plan and makes no changes.
EOF
}

service_loaded() {
	local label="$1"
	launchctl print "${DOMAIN}/${label}" >/dev/null 2>&1 || launchctl list "${label}" >/dev/null 2>&1
}

wait_until_unloaded() {
	local label="$1"
	local attempts=0

	# Legacy label removal is asynchronous; bound the wait before declaring the PLAN §5.2 resident daemon stopped.
	while service_loaded "${label}"; do
		attempts=$((attempts + 1))
		if (( attempts >= 300 )); then
			return 1
		fi
		sleep 0.1
	done
	return 0
}

print_plan() {
	local label destination

	printf 'Deck launchd removal plan (no changes yet):\n'
	for label in "${LABELS[@]}"; do
		destination="${AGENT_DIR}/${label}.plist"
		printf '  launchctl bootout %s/%s (fallback: launchctl unload -w %s, or launchctl remove %s if the plist is absent)\n' "${DOMAIN}" "${label}" "${destination}" "${label}"
		printf '  verify %s/%s is not loaded\n' "${DOMAIN}" "${label}"
		printf '  remove %s\n' "${destination}"
	done
	printf '  preserve logs under %s\n' "${HOME}/.deck/logs"
}

remove_agent() {
	local label="$1"
	local destination="${AGENT_DIR}/${label}.plist"

	if service_loaded "${label}"; then
		if launchctl bootout "${DOMAIN}/${label}"; then
			printf 'Booted out %s.\n' "${label}"
		else
			printf 'WARNING: launchctl bootout failed for %s; trying legacy removal.\n' "${label}" >&2
			if service_loaded "${label}"; then
				if [[ -f "${destination}" ]]; then
					if ! launchctl unload -w "${destination}"; then
						printf 'ERROR: unable to unload %s.\n' "${label}" >&2
						return 1
					fi
				elif ! launchctl remove "${label}"; then
					printf 'ERROR: unable to remove loaded label %s.\n' "${label}" >&2
					return 1
				fi
			fi
		fi
	else
		printf '%s is not loaded; continuing idempotently.\n' "${label}"
	fi

	if ! wait_until_unloaded "${label}"; then
		printf 'WARNING: %s is still loaded after 30 seconds; leaving %s unchanged and continuing.\n' "${DOMAIN}/${label}" "${destination}" >&2
		printf 'Run: launchctl bootout %s/%s\nThen: cd ~/dev/deck && ./ops/uninstall.sh --yes\n' "${DOMAIN}" "${label}" >&2
		return 1
	fi
	printf 'Status: %s/%s is not loaded.\n' "${DOMAIN}" "${label}"

	if [[ -e "${destination}" ]]; then
		if ! rm -f "${destination}"; then
			printf 'ERROR: unable to remove %s.\n' "${destination}" >&2
			return 1
		fi
		printf 'Removed %s.\n' "${destination}"
	else
		printf '%s is already absent.\n' "${destination}"
	fi
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

failed=false
for label in "${LABELS[@]}"; do
	if ! remove_agent "${label}"; then
		failed=true
	fi
done

if [[ "${failed}" == true ]]; then
	printf 'ERROR: one or more launchd labels still require manual removal.\n' >&2
	exit 1
fi
