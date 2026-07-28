import { collectBacklog, type CommandRunner } from "./collectors/backlog";
import { collectBroker, type BrokerConfig, DEFAULT_BROKER_ENDPOINT } from "./collectors/broker";
import { collectFleetState } from "./collectors/fleet";
import { collectSmithers } from "./collectors/smithers";
import type { FleetConfig } from "./config";
import { correlateRuns } from "./correlate";
import { isLiveRun } from "./run-state";
import type { BacklogEntry, FleetTask, SourceDiagnostic } from "./types";
import type { FleetModel } from "./types";

export interface BuildModelDeps {
	run: CommandRunner;
	/** Injectable clock so model assembly is deterministic in tests. */
	now: () => number;
	broker?: BrokerConfig;
}

/**
 * Assemble a {@link FleetModel} from all collectors. Pure orchestration: it
 * fans out to the (read-only) collectors, joins tasks to their backlog entry
 * and correlated runs, and gathers per-source diagnostics. Any single failing
 * source degrades to a diagnostic without aborting the whole model.
 */
export async function buildModel(
	config: FleetConfig,
	deps: BuildModelDeps,
	signal?: AbortSignal,
): Promise<FleetModel> {
	const brokerConfig: BrokerConfig = deps.broker ?? { endpoint: DEFAULT_BROKER_ENDPOINT, auth: null };

	const [fleetState, backlog, smithers, broker] = await Promise.all([
		collectFleetState(config.fmHome, signal),
		collectBacklog(config.fmHome, deps.run, signal),
		collectSmithers(config.smithersWorkspaces, deps.run, signal),
		collectBroker(brokerConfig),
	]);

	const backlogById = new Map<string, BacklogEntry>(backlog.entries.map((entry) => [entry.id, entry]));

	// Task universe = every state slug, unioned with backlog ids so queued
	// tasks with no live agent still show up.
	const ids = new Set<string>(fleetState.ids);
	for (const entry of backlog.entries) ids.add(entry.id);

	const baseTasks: FleetTask[] = [...ids].sort().map((id) => ({
		id,
		meta: fleetState.metas.get(id) ?? null,
		status: fleetState.statuses.get(id) ?? null,
		backlog: backlogById.get(id) ?? null,
		runs: [],
	}));

	const { tasks, orphanRuns, diagnostics: correlationDiagnostics } = correlateRuns(baseTasks, smithers.runs);

	const diagnostics: SourceDiagnostic[] = [
		{ source: `FM_HOME (${config.fmHome})`, ok: fleetState.ok, detail: fleetState.detail },
		...fleetState.diagnostics,
		{ source: `backlog:${backlog.source}`, ok: backlog.ok, detail: backlog.detail },
		...smithers.diagnostics,
		...correlationDiagnostics,
		broker.diagnostic,
	];

	return {
		fmHome: config.fmHome,
		generatedAtMs: deps.now(),
		tasks: sortTasks(tasks),
		orphanRuns,
		diagnostics,
	};
}

/**
 * Sort tasks so the operationally interesting ones float up: active/attention
 * states first, then tasks with live runs, then everything else by id.
 */
function sortTasks(tasks: readonly FleetTask[]): FleetTask[] {
	return [...tasks].sort((a, b) => {
		const pa = taskPriority(a);
		const pb = taskPriority(b);
		if (pa !== pb) return pa - pb;
		return a.id.localeCompare(b.id);
	});
}

function taskPriority(task: FleetTask): number {
	const state = task.status?.state;
	if (state === "needs-decision" || state === "blocked" || state === "failed") return 0;
	if (state === "working" || task.runs.some(isLiveRun)) return 1;
	if (state === "paused") return 2;
	if (task.meta) return 3; // has a live agent home
	if (task.backlog?.state === "in_flight") return 3;
	if (task.backlog?.state === "queued") return 4;
	return 5; // done / held / unknown
}
