import * as path from "node:path";
import type { FleetTask, SmithersRun, SourceDiagnostic } from "./types";

/** Normalize a filesystem path for conservative identity comparison. */
export function normalizePath(p: string | null | undefined): string | null {
	if (!p) return null;
	// A relative root has no durable identity without its original base path.
	// Resolving it against the dashboard's cwd could create a false match.
	if (!path.isAbsolute(p)) return null;
	const resolved = path.resolve(p);
	// Drop a single trailing slash (resolve already collapses most cases).
	return resolved.length > 1 && resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
}

export interface CorrelationResult {
	tasks: FleetTask[];
	orphanRuns: SmithersRun[];
	diagnostics: SourceDiagnostic[];
}

/**
 * Correlate Smithers runs to fleet tasks CONSERVATIVELY: a run is attached to a
 * task only when the run's durable `rootDir` exactly equals that task's
 * `meta.worktree` (both normalized). This is the one durable launch-attribution
 * identifier both sides share; fuzzy matching on names/ids is deliberately
 * avoided to prevent false correlations. Every unmatched run — including runs
 * with no rootDir — is returned as an orphan for the separate Workflows section.
 */
export function correlateRuns(tasks: readonly FleetTask[], runs: readonly SmithersRun[]): CorrelationResult {
	const taskIdsByWorktree = new Map<string, string[]>();
	for (const task of tasks) {
		const worktree = normalizePath(task.meta?.worktree);
		if (!worktree) continue;
		const ids = taskIdsByWorktree.get(worktree) ?? [];
		ids.push(task.id);
		taskIdsByWorktree.set(worktree, ids);
	}

	// Only a unique durable path is safe to attribute. Duplicate paths are
	// ambiguous, so matching runs remain in the separate workflows section.
	const worktreeToTask = new Map<string, string>();
	const diagnostics: SourceDiagnostic[] = [];
	for (const [worktree, taskIds] of taskIdsByWorktree) {
		if (taskIds.length === 1) {
			worktreeToTask.set(worktree, taskIds[0]!);
		} else {
			diagnostics.push({
				source: "correlation",
				ok: false,
				level: "warning",
				detail: `duplicate worktree ${worktree} for tasks ${taskIds.join(", ")}; matching runs left uncorrelated`,
			});
		}
	}

	const runsByTask = new Map<string, SmithersRun[]>();
	const orphanRuns: SmithersRun[] = [];
	for (const run of runs) {
		const rootDir = normalizePath(run.rootDir);
		const taskId = rootDir ? worktreeToTask.get(rootDir) : undefined;
		if (taskId) {
			const list = runsByTask.get(taskId) ?? [];
			list.push(run);
			runsByTask.set(taskId, list);
		} else {
			orphanRuns.push(run);
		}
	}

	const correlated = tasks.map((task) => ({ ...task, runs: runsByTask.get(task.id) ?? [] }));
	return { tasks: correlated, orphanRuns, diagnostics };
}
