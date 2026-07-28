import type { SmithersRun } from "./types";

const LIVE_RUN_STATES = new Set([
	"running",
	"waiting-approval",
	"waiting-event",
	"waiting-timer",
	"paused",
]);

/**
 * Whether a Smithers run still represents live operational work.
 *
 * Waiting and paused runs remain live; finished/failed/cancelled runs are
 * history and must not inflate the dashboard's active-task summary.
 */
export function isLiveRun(run: SmithersRun | string): boolean {
	const state = typeof run === "string" ? run : run.status;
	return LIVE_RUN_STATES.has(state.trim().toLowerCase());
}
