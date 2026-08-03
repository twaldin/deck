import { execOrThrow, type ExecFn } from "./gh.ts";

export const TEST_LANE_LOCK = "/tmp/deck-test-lane.lock";
export const FD_PRESSURE_RATIO = 0.9;
export const FD_PRESSURE_RETRIES = 10;
export const LANE_WAIT_SECONDS = 1800;

/** Check host pressure before reserving one of the two test lanes. */
export function testLaneCommand(command: string): string {
	const bounded = command.replace(/\bbun test\b/g, "bun test --max-concurrency 2");
	const escaped = bounded.replaceAll("'", `'\\''`);
	return `for attempt in $(seq 1 ${FD_PRESSURE_RETRIES}); do files=$(sysctl -n kern.num_files 2>/dev/null || echo 0); max=$(sysctl -n kern.maxfiles 2>/dev/null || echo 0); case "$files:$max" in ''|*[!0-9:]*|*:0) files=0; max=1;; esac; if [ "$files" -lt $((max * 90 / 100)) ]; then break; fi; if [ "$attempt" -eq ${FD_PRESSURE_RETRIES} ]; then echo 'FD-PRESSURE: open files remain above 90% of kern.maxfiles' >&2; exit 75; fi; sleep 60; done; lock='${TEST_LANE_LOCK}'; i=0; while :; do for slot in 0 1; do dir="$lock.$slot"; if mkdir "$dir" 2>/dev/null; then printf '%s\\n' "$$" > "$dir/pid"; trap 'rm -rf "$dir" 2>/dev/null || true' EXIT INT TERM; break 2; fi; pid=$(cat "$dir/pid" 2>/dev/null || true); if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$dir" 2>/dev/null || true; fi; done; i=$((i+1)); if [ "$i" -ge ${LANE_WAIT_SECONDS} ]; then echo 'TEST-LANE-PRESSURE: test lanes stayed busy' >&2; exit 75; fi; sleep 1; done; bash -lc '${escaped}'`;
}

export async function runTestCommand(exec: ExecFn, worktree: string, command: string): Promise<string> {
	return execOrThrow(exec, ["bash", "-lc", testLaneCommand(command)], { cwd: worktree });
}
