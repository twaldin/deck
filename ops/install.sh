#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CANONICAL_ROOT="$(git -C "${SCRIPT_DIR}/.." rev-parse --show-toplevel)"
CANONICAL_ROOT="$(cd "${CANONICAL_ROOT}" && pwd -P)"
DECK_ROOT="${DECK_ROOT:-${CANONICAL_ROOT}}"
BUN_BIN_DIR=""
LAUNCHD_DIR="${SCRIPT_DIR}/launchd"
AGENT_DIR="${HOME}/Library/LaunchAgents"
LOG_DIR="${HOME}/.deck/logs"
# The gateway serves the LIVE run workspace, which is separate from the source
# checkout it loads workflow modules from.
GATEWAY_WORKSPACE="${HOME}/.deck/state/smithers"
USER_UID="$(id -u)"
DOMAIN="gui/${USER_UID}"
BROKER_SOCKET="${HOME}/.deck/run/broker.sock"

LABELS=(
	"ai.deck.broker"
	"ai.deck.resource-monitor"
	"ai.deck.smithers-gateway"
)
ENTRYPOINTS=(
	"${DECK_ROOT}/broker/src/main.ts"
	"${DECK_ROOT}/ops/resource-monitor"
	"${DECK_ROOT}/workflows/.smithers/gateway.ts"
)

usage() {
	cat <<'EOF'
Usage: ./ops/install.sh [--yes] [--force-service]

Without --yes, prints the installation plan and makes no changes.
--force-service restarts a loaded, running service only when its plist changes.
EOF
}

fail() {
	printf 'ERROR: %s\n' "$*" >&2
	exit 1
}

validate_deck_root() {
	local resolved_root

	if [[ "$(git -C "${CANONICAL_ROOT}" rev-parse --absolute-git-dir)" != "$(git -C "${CANONICAL_ROOT}" rev-parse --path-format=absolute --git-common-dir)" ]]; then
		fail "refusing to install from linked worktree ${CANONICAL_ROOT}; launchd plists must reference a canonical checkout, not a disposable worktree."
	fi
	if [[ "${CANONICAL_ROOT}" =~ [\&\<\>\|] ]] || [[ "${LOG_DIR}" =~ [\&\<\>\|] ]]; then
		fail "installer paths cannot contain &, <, >, or |."
	fi
	local bun_path
	bun_path="$(command -v bun)" || fail "bun is required on PATH to render the broker plist."
	BUN_BIN_DIR="$(cd "$(dirname "${bun_path}")" && pwd -P)"
	if [[ "${BUN_BIN_DIR}" =~ [\&\<\>\|] ]]; then
		fail "bun path cannot contain &, <, >, or |."
	fi
	if [[ ! -d "${DECK_ROOT}" ]]; then
		fail "DECK_ROOT ${DECK_ROOT} does not exist."
	fi
	resolved_root="$(cd "${DECK_ROOT}" && pwd -P)"
	if [[ "${resolved_root}" != "${CANONICAL_ROOT}" ]]; then
		fail "refusing DECK_ROOT ${resolved_root}; it must be the canonical installer checkout ${CANONICAL_ROOT}. Launchd plists must not reference another checkout or a worktree."
	fi
	DECK_ROOT="${resolved_root}"
}

service_loaded() {
	local label="$1"
	launchctl print "${DOMAIN}/${label}" >/dev/null 2>&1 || launchctl list "${label}" >/dev/null 2>&1
}

service_running() {
	local label="$1" status

	status="$(launchctl print "${DOMAIN}/${label}" 2>/dev/null || true)"
	if [[ "${status}" =~ state[[:space:]]*=[[:space:]]*not[[:space:]]+running ]]; then
		return 1
	fi
	if [[ "${status}" =~ state[[:space:]]*=[[:space:]]*running ]]; then
		return 0
	fi
	status="$(launchctl list "${label}" 2>/dev/null || true)"
	if [[ "${status}" =~ \"LastExitStatus\" ]] && [[ ! "${status}" =~ \"PID\" ]]; then
		return 1
	fi
	# An unknown state is unsafe to overwrite. Require explicit force instead.
	return 0
}

wait_until_unloaded() {
	local label="$1" attempts=0

	while service_loaded "${label}"; do
		attempts=$((attempts + 1))
		if (( attempts >= 300 )); then
			return 1
		fi
		sleep 0.1
	done
}

broker_endpoint_busy() {
	lsof -nP -iTCP:8377 -sTCP:LISTEN >/dev/null 2>&1 || lsof -nU -a -- "${BROKER_SOCKET}" >/dev/null 2>&1
}

service_pid() {
	launchctl print "${DOMAIN}/$1" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }'
}

broker_endpoint_has_foreign_owner() {
	local broker_pid owner
	broker_pid="$(service_pid ai.deck.broker)"
	while IFS= read -r owner; do
		[[ -z "${owner}" || "${owner}" == "${broker_pid}" ]] || return 0
	done < <( { lsof -t -nP -iTCP:8377 -sTCP:LISTEN 2>/dev/null; lsof -t -nU -a -- "${BROKER_SOCKET}" 2>/dev/null; } | sort -u )
	return 1
}

wait_for_broker_release() {
	local attempts=0

	while broker_endpoint_busy; do
		attempts=$((attempts + 1))
		if (( attempts >= 300 )); then
			return 1
		fi
		sleep 0.1
	done
}

stop_agent() {
	local label="$1" destination="$2"

	if launchctl bootout "${DOMAIN}/${label}"; then
		printf 'Booted out %s.\n' "${label}"
	elif wait_until_unloaded "${label}"; then
		printf '%s stopped after launchctl bootout returned an error.\n' "${label}"
	else
		printf 'WARNING: launchctl bootout failed for %s; trying legacy unload.\n' "${label}" >&2
		if ! launchctl unload "${destination}"; then
			printf 'ERROR: unable to stop %s.\n' "${label}" >&2
			return 1
		fi
	fi
	if ! wait_until_unloaded "${label}"; then
		printf 'ERROR: %s remained loaded after 30 seconds.\n' "${DOMAIN}/${label}" >&2
		return 1
	fi
}

bootstrap_agent() {
	local label="$1" destination="$2"

	if service_loaded "${label}"; then
		printf '%s is already loaded; leaving the service unchanged.\n' "${label}"
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

restart_agent() {
	local label="$1" destination="$2"

	stop_agent "${label}" "${destination}"
	if [[ "${label}" == "ai.deck.broker" ]] && ! wait_for_broker_release; then
		printf 'ERROR: broker is stopped and was not restarted because port 8377 or %s remained in use after 30 seconds. Free the endpoint, then re-run ./ops/install.sh --yes --force-service.\n' "${BROKER_SOCKET}" >&2
		return 1
	fi
	bootstrap_agent "${label}" "${destination}"
}

render_plist() {
	local source="$1" rendered="$2"
	sed \
		-e "s|@DECK_ROOT@|${DECK_ROOT}|g" \
		-e "s|@LOG_DIR@|${LOG_DIR}|g" \
		-e "s|@BUN_PATH@|${BUN_BIN_DIR}|g" \
		-e "s|@GATEWAY_WORKSPACE@|${GATEWAY_WORKSPACE}|g" \
		"${source}" > "${rendered}"
}

print_plan() {
	local index label source destination entrypoint

	printf 'Deck launchd installation plan (no changes yet):\n'
	printf '  canonical checkout: %s\n' "${DECK_ROOT}"
	printf '  create %s and %s with mode 0700\n' "${HOME}/.deck" "${LOG_DIR}"
	printf '  create %s if needed\n' "${AGENT_DIR}"

	for index in "${!LABELS[@]}"; do
		label="${LABELS[$index]}"
		source="${LAUNCHD_DIR}/${label}.plist"
		destination="${AGENT_DIR}/${label}.plist"
		entrypoint="${ENTRYPOINTS[$index]}"
		if [[ -f "${entrypoint}" ]]; then
			printf '  copy %s to %s when changed\n' "${source}" "${destination}"
			printf '  launchctl bootstrap %s %s (fallback: launchctl load -w %s) when not loaded\n' "${DOMAIN}" "${destination}" "${destination}"
			printf '  loaded, running services with changed plists require --force-service\n'
		else
			printf '  WARNING: skip %s because %s is missing\n' "${label}" "${entrypoint}"
		fi
	done
}

confirm=false
force_service=false
while (( $# > 0 )); do
	case "$1" in
		--yes)
			confirm=true
			;;
		--force-service)
			force_service=true
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
	shift
done

validate_deck_root
print_plan
if [[ "${confirm}" != true ]]; then
	printf '\nNo changes made. Re-run with --yes to apply this plan.\n'
	exit 0
fi

rendered_files=()
restart_services=()
cleanup() {
	if (( ${#rendered_files[@]} )); then
		rm -f "${rendered_files[@]}"
	fi
}
trap cleanup EXIT

# Check every live service before copying any plist, so a rejected install changes nothing.
for index in "${!LABELS[@]}"; do
	label="${LABELS[$index]}"
	entrypoint="${ENTRYPOINTS[$index]}"
	source="${LAUNCHD_DIR}/${label}.plist"
	destination="${AGENT_DIR}/${label}.plist"
	restart_services[index]=false

	if [[ ! -f "${entrypoint}" ]]; then
		continue
	fi
	[[ -f "${source}" ]] || fail "source plist ${source} is missing."
	rendered="$(mktemp)"
	rendered_files[index]="${rendered}"
	render_plist "${source}" "${rendered}"
	if service_loaded "${label}" && ! cmp -s "${rendered}" "${destination}"; then
		if [[ "${label}" == "ai.deck.broker" ]] && ! command -v lsof >/dev/null; then
			fail "lsof is required to verify broker endpoint release; no services were changed."
		fi
		if [[ "${label}" == "ai.deck.broker" ]] && broker_endpoint_has_foreign_owner; then
			fail "port 8377 or ${BROKER_SOCKET} is held by a process other than the launchd broker; no services were changed."
		fi
		if service_running "${label}" && [[ "${force_service}" != true ]]; then
			fail "${label} is loaded and running with a changed plist; refusing to restart it. Re-run with --yes --force-service to restart this live service deliberately."
		fi
		restart_services[index]=true
	fi
done

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
	rendered="${rendered_files[$index]}"

	if ! cmp -s "${rendered}" "${destination}"; then
		install -m 0644 "${rendered}" "${destination}"
		printf 'Installed %s.\n' "${destination}"
	else
		printf '%s is unchanged.\n' "${destination}"
	fi

	if [[ "${restart_services[$index]}" == true ]]; then
		restart_agent "${label}" "${destination}"
	else
		bootstrap_agent "${label}" "${destination}"
	fi
done
