import type { CommandRunner } from "./backlog";
import type { PaneState, TaskMeta } from "../types";

const PANE_STATES = new Set<PaneState>(["working", "idle", "blocked", "done"]);

/** Parse the read-only `herdr agent get` response into a comparable pane state. */
export function parsePaneState(text: string): PaneState {
	try {
		const value = JSON.parse(text) as { result?: { agent?: { agent_status?: unknown } } };
		const state = typeof value.result?.agent?.agent_status === "string"
			? value.result.agent.agent_status.toLowerCase()
			: "";
		return PANE_STATES.has(state as PaneState) ? state as PaneState : "unknown";
	} catch {
		return "unknown";
	}
}

/** Read live Herdr agent states for the task panes that advertise a Herdr backend. */
export async function collectPaneStates(
	metas: ReadonlyMap<string, TaskMeta>,
	run: CommandRunner,
	cwd: string,
	signal?: AbortSignal,
): Promise<Map<string, PaneState>> {
	const states = new Map<string, PaneState>();
	await Promise.all([...metas].map(async ([id, meta]) => {
		if (signal?.aborted || meta.backend?.toLowerCase() !== "herdr" || !meta.window) return;
		const result = await run("herdr", ["agent", "get", meta.window], cwd, signal);
		if (result && result.exitCode === 0) states.set(id, parsePaneState(result.stdout));
	}));
	return states;
}
