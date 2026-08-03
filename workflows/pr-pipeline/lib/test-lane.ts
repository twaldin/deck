import { execOrThrow, type ExecFn } from "./gh.ts";

export const TEST_LANE_LOCK = "/tmp/deck-test-lane.lock";
export const FD_PRESSURE_LIMIT = 150_000;
export const FD_PRESSURE_RETRIES = 10;

/** Shell wrapper for two cross-run test lanes. mkdir is atomic on macOS, and
 * the lock directory is removed by the trap when the test exits. */
export function testLaneCommand(command: string): string {
	const bounded = command.replace(/^bun test\b/, "bun test --max-concurrency 2");
	const escaped = bounded.replaceAll("'", `'\\''`);
	return `lock='${TEST_LANE_LOCK}'; i=0; while :; do for slot in 0 1; do if mkdir "$lock.$slot" 2>/dev/null; then trap 'rmdir "$lock.$slot" 2>/dev/null || true' EXIT INT TERM; break 2; fi; done; i=$((i+1)); if [ "$i" -ge 120 ]; then echo 'TEST-LANE-PRESSURE: test lanes stayed busy' >&2; exit 75; fi; sleep 1; done; for attempt in $(seq 1 ${FD_PRESSURE_RETRIES}); do files=$(sysctl -n kern.num_files 2>/dev/null || echo 0); case "$files" in ''|*[!0-9]*) files=0;; esac; if [ "$files" -le ${FD_PRESSURE_LIMIT} ]; then break; fi; if [ "$attempt" -eq ${FD_PRESSURE_RETRIES} ]; then echo 'FD-PRESSURE: kern.num_files remained above ${FD_PRESSURE_LIMIT}' >&2; exit 75; fi; sleep 60; done; sh -lc '${escaped}'`; 
}

export async function runTestCommand(exec: ExecFn, worktree: string, command: string): Promise<string> {
	return execOrThrow(exec, ["sh", "-lc", testLaneCommand(command)], { cwd: worktree });
}
