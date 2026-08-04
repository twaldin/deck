#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
home="$root/home"
mkdir -p "$home"
output="$home/.deck/data/resource-monitor"
HOME="$home" DECK_RESOURCE_MONITOR_ONCE=1 DECK_RESOURCE_MONITOR_OUTPUT="$output" ./ops/resource-monitor
[[ -s "$output" ]]
grep -Eq 'fd=[0-9]+ max=[0-9]+ vm.swapusage=' "$output"

install_output="$root/plan"
HOME="$home" DECK_ROOT="$PWD" ./ops/install.sh >"$install_output"
grep -q 'No changes made' "$install_output"
