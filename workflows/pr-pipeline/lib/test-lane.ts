import { execOrThrow, type ExecFn } from "./gh.ts";

export const TEST_LANE_LOCK = "/tmp/deck-test-lane.lock";
export const LANE_WAIT_SECONDS = 1800;

/** Reserve one of two lanes. Reclaimers serialize on a sibling mkdir marker. */
export function testLaneCommand(command: string, lockPath = TEST_LANE_LOCK): string {
	const bounded = command.replace(/\bbun test\b/g, "bun test --no-orphans");
	const escapedLock = lockPath.replaceAll("'", `'\\''`);
	const escaped = bounded.replaceAll("'", `'\\''`);
	return `lock='${escapedLock}'; i=0; while :; do for slot in 0 1; do dir="$lock.$slot"; if mkdir "$dir" 2>/dev/null; then printf '%s\\n' "$$" > "$dir/pid"; trap 'rm -rf "$dir" 2>/dev/null || true' EXIT INT TERM; break 2; fi; reclaim="$dir.reclaim"; if mkdir "$reclaim" 2>/dev/null; then pid=$(cat "$dir/pid" 2>/dev/null || true); if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then rm -rf "$dir" 2>/dev/null || true; fi; rmdir "$reclaim" 2>/dev/null || true; fi; done; i=$((i+1)); if [ "$i" -ge ${LANE_WAIT_SECONDS} ]; then echo 'TEST-LANE-PRESSURE: test lanes stayed busy' >&2; exit 75; fi; sleep 1; done; bash -lc '${escaped}'`;
}

export async function runTestCommand(exec: ExecFn, worktree: string, command: string): Promise<string> {
	return execOrThrow(exec, ["bash", "-lc", testLaneCommand(command)], { cwd: worktree });
}
