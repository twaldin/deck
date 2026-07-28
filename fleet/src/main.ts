/**
 * Public module surface for @deck/fleet. Import collectors, model, renderer,
 * and diff engine here so other surfaces (e.g. a future herdr plugin) can reuse
 * the data layer independently of the terminal renderer.
 */
export * from "./types";
export * from "./config";
export { collectFleetState, parseMeta, parseStatusTail } from "./collectors/fleet";
export {
	collectBacklog,
	parseTasksAxiList,
	parseBacklogMarkdown,
	splitToonRow,
	MAX_BACKLOG_BYTES,
	type CommandRunner,
} from "./collectors/backlog";
export {
	collectSmithers,
	parsePsJson,
	parseInspectJson,
	SMITHERS_SPEC,
	SMITHERS_RUN_LIMIT,
} from "./collectors/smithers";
export { collectBroker, type BrokerConfig, type BrokerAuth, DEFAULT_BROKER_ENDPOINT } from "./collectors/broker";
export { makeSubprocessRunner } from "./collectors/runner";
export { correlateRuns, normalizePath } from "./correlate";
export { isLiveRun } from "./run-state";
export { buildModel, type BuildModelDeps } from "./model";
export { renderModel, truncate, age, type RenderOptions } from "./render";
export { diffFrame, FramePainter, type DiffFrame } from "./diff";
export { fitFrame } from "./viewport";
export { runTui, renderFrame, type TuiIo } from "./tui";
export { runCli } from "./cli";
