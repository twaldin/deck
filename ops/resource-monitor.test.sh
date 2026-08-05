#!/usr/bin/env bash
set -euo pipefail

repo="${DECK_OPS_REPO:-$(git rev-parse --show-toplevel)}"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
home="$root/home"
fixture="$root/deck"
worktree="$root/linked-worktree"
mock_bin="$root/bin"
state="$root/state"
mkdir -p "$home" "$fixture/ops/launchd" "$fixture/broker/src" "$mock_bin" "$state"
cp "$repo/ops/install.sh" "$fixture/ops/install.sh"
cp "$repo/ops/resource-monitor" "$fixture/ops/resource-monitor"
cp "$repo/ops/launchd/"*.plist "$fixture/ops/launchd/"
printf '// fixture\n' > "$fixture/broker/src/main.ts"
git -C "$fixture" init -q
git -C "$fixture" add .
git -C "$fixture" -c user.name=test -c user.email=test@example.com commit -qm fixture
git -C "$fixture" worktree add --detach -q "$worktree" HEAD

cat > "$mock_bin/launchctl" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$MOCK_LOG"
label=${2:-${1:-}}
case "$1" in
  print)
    label=${2##*/}
    if grep -qx "$label" "$MOCK_LOADED" 2>/dev/null; then
      if grep -qx "$label" "$MOCK_RUNNING" 2>/dev/null; then printf 'state = running\n'; else printf 'state = not running\n'; fi
      exit 0
    fi
    exit 1
    ;;
  list)
    if grep -qx "$label" "$MOCK_LOADED" 2>/dev/null; then
      if grep -qx "$label" "$MOCK_RUNNING" 2>/dev/null; then printf '{\n  "PID" = 123;\n}\n'; else printf '{\n  "LastExitStatus" = 0;\n}\n'; fi
      exit 0
    fi
    exit 1
    ;;
  bootout|unload)
    label=ai.deck.broker
    case "$*" in *resource-monitor*) label=ai.deck.resource-monitor;; esac
    grep -vx "$label" "$MOCK_LOADED" > "$MOCK_LOADED.next" || true
    mv "$MOCK_LOADED.next" "$MOCK_LOADED"
    grep -vx "$label" "$MOCK_RUNNING" > "$MOCK_RUNNING.next" || true
    mv "$MOCK_RUNNING.next" "$MOCK_RUNNING"
    ;;
  bootstrap|load)
    case "$*" in *resource-monitor*) label=ai.deck.resource-monitor;; *) label=ai.deck.broker;; esac
    printf '%s\n' "$label" >> "$MOCK_LOADED"
    printf '%s\n' "$label" >> "$MOCK_RUNNING"
    ;;
esac
EOF
chmod +x "$mock_bin/launchctl"

cat > "$mock_bin/lsof" <<'EOF'
#!/bin/sh
set -eu
printf 'lsof %s\n' "$*" >> "$MOCK_LOG"
if [ "${MOCK_BUSY_ONCE:-}" = 1 ] && [ ! -e "$MOCK_LSOF_SEEN" ]; then
  : > "$MOCK_LSOF_SEEN"
  exit 0
fi
exit 1
EOF
chmod +x "$mock_bin/lsof"

run_install() {
  HOME="$home" PATH="$mock_bin:$PATH" MOCK_LOG="$state/log" MOCK_LOADED="$state/loaded" MOCK_RUNNING="$state/running" MOCK_LSOF_SEEN="$state/lsof-seen" "$fixture/ops/install.sh" "$@"
}
# REGRESSION: the old installer accepted a linked worktree as DECK_ROOT.
if HOME="$home" "$worktree/ops/install.sh" >/dev/null 2>"$state/worktree-error"; then
  echo 'expected linked worktree installer refusal' >&2
  exit 1
fi
grep -q 'linked worktree' "$state/worktree-error"

# REGRESSION: the old installer overwrote a live service without an explicit force flag.
printf 'ai.deck.broker\n' > "$state/loaded"
printf 'ai.deck.broker\n' > "$state/running"
if run_install --yes >"$state/loaded-output" 2>"$state/loaded-error"; then
  echo 'expected loaded, running service refusal' >&2
  exit 1
fi
grep -q 'ai.deck.broker is loaded and running' "$state/loaded-error"
grep -q -- '--force-service' "$state/loaded-error"
[ ! -e "$home/Library/LaunchAgents/ai.deck.broker.plist" ]

# REGRESSION: a deliberate broker restart must wait for both the old port and control socket.
: > "$state/log"
MOCK_BUSY_ONCE=1 run_install --yes --force-service >"$state/restart-output"
grep -q '^bootout gui/.*/ai.deck.broker$' "$state/log"
grep -q '^lsof -nP -iTCP:8377 -sTCP:LISTEN$' "$state/log"
grep -q "^lsof -nU -a -- $home/.deck/run/broker.sock$" "$state/log"
grep -q '^bootstrap gui/.* /.*ai.deck.broker.plist$' "$state/log"
awk '/bootout gui\/.+\/ai.deck.broker/{stop=NR} /^lsof /{wait=NR} /^bootstrap gui\/.+ \/.*ai.deck.broker.plist$/{start=NR} END { exit !(stop < wait && wait < start) }' "$state/log"
broker_plist="$home/Library/LaunchAgents/ai.deck.broker.plist"
fixture_real="$(cd "$fixture" && pwd -P)"
grep -Eq '@[A-Z_]+@' "$broker_plist" && exit 1
if ! grep -q "<string>$fixture_real/broker/src/main.ts</string>" "$broker_plist"; then
  cat "$broker_plist" >&2
  exit 1
fi
grep -Eq '<string>/[^:]+:' "$broker_plist"

# An unchanged loaded plist does not restart the service, even with --force-service.
: > "$state/log"
run_install --yes --force-service >"$state/idempotent-output"
if grep -Eq '^(bootout|unload|bootstrap|load) ' "$state/log"; then
  cat "$state/log" >&2
  exit 1
fi
grep -q 'is unchanged' "$state/idempotent-output"

# A missing daemon does not abort the installation of a remaining service.
rm "$fixture/broker/src/main.ts"
printf 'ai.deck.resource-monitor\n' > "$state/loaded"
printf 'ai.deck.resource-monitor\n' > "$state/running"
: > "$state/log"
if ! run_install --yes >"$state/missing-entrypoint-output" 2>&1; then
  cat "$state/missing-entrypoint-output" >&2
  exit 1
fi
grep -q 'skipped ai.deck.broker' "$state/missing-entrypoint-output"
grep -q 'ai.deck.resource-monitor.plist is unchanged' "$state/missing-entrypoint-output"

# The monitor default is a file inside its artifact directory, not the directory itself.
mkdir -p "$home/.deck/data"
printf 'old metric\n' > "$home/.deck/data/resource-monitor"
HOME="$home" DECK_RESOURCE_MONITOR_ONCE=1 "$fixture/ops/resource-monitor"
output="$home/.deck/data/resource-monitor/metrics.log"
[[ -s "$output" ]]
[[ -s "$home/.deck/data/resource-monitor.legacy" ]]
grep -Eq 'fd=[0-9]+ max=[0-9]+ vm.swapusage=' "$output"
if HOME="$home" DECK_RESOURCE_MONITOR_ONCE=1 DECK_RESOURCE_MONITOR_OUTPUT="$home/.deck/data/resource-monitor" "$fixture/ops/resource-monitor" >"$state/monitor-output" 2>"$state/monitor-error"; then
  echo 'expected directory-valued monitor output refusal' >&2
  exit 1
fi
grep -q 'must name a file' "$state/monitor-error"
