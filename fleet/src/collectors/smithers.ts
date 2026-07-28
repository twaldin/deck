import type { SmithersNode, SmithersRun, SourceDiagnostic } from "../types";
import type { CommandRunner } from "./backlog";

/**
 * Pinned CLI spec. The workspace pins smithers-orchestrator 0.30.0 and bun can
 * silently resolve a NEWER global build from a package.json-less dir, so we
 * always pin the version explicitly (see AGENTS.md "Version-skew trap").
 */
export const SMITHERS_SPEC = "smithers-orchestrator@0.30.0";
export const SMITHERS_RUN_LIMIT = 100;

/**
 * Read-only Smithers access is done exclusively through public CLI queries:
 *   `ps`      — list runs in a workspace
 *   `inspect` — a run's nodes + config.rootDir
 * These read the workspace store without starting a Gateway. We NEVER call
 * mutating or Gateway-lifecycle commands (up/cancel/gateway/monitor/ui), and
 * NEVER open the private sqlite db directly.
 */

interface PsRun {
	id: string;
	workflow: string;
	status: string;
	step: string | null;
	started: string | null;
}

export interface SmithersParseResult<T> {
	value: T;
	/** False means the top-level payload cannot be consumed at all. */
	valid: boolean;
	/** Non-null also covers partial payloads whose usable rows were retained. */
	detail: string | null;
}

/** Parse `smithers ps --json`, distinguishing valid-empty from malformed. */
export function parsePsJsonResult(stdout: string): SmithersParseResult<PsRun[]> {
	let payload: unknown;
	try {
		payload = JSON.parse(stdout);
	} catch {
		return { value: [], valid: false, detail: "invalid JSON" };
	}
	if (!isRecord(payload) || !Array.isArray(payload.runs)) {
		return { value: [], valid: false, detail: "expected an object with runs[]" };
	}
	const runs = payload.runs;
	const out: PsRun[] = [];
	let skipped = 0;
	for (const entry of runs) {
		if (!isRecord(entry)) {
			skipped++;
			continue;
		}
		const r = entry as Record<string, unknown>;
		const id = str(r.id);
		if (!id) {
			skipped++;
			continue;
		}
		out.push({
			id,
			workflow: str(r.workflow ?? r.workflowId) ?? "workflow",
			status: str(r.status ?? r.state ?? r.dbStatus) ?? "unknown",
			step: str(r.step),
			started: str(r.started),
		});
	}
	return {
		value: out,
		valid: true,
		detail: skipped ? `skipped ${skipped} malformed run entr${skipped === 1 ? "y" : "ies"}` : null,
	};
}

/** Backwards-compatible convenience parser. */
export function parsePsJson(stdout: string): PsRun[] {
	return parsePsJsonResult(stdout).value;
}

/** Parse `smithers inspect --json` for nodes + the durable rootDir. */
export function parseInspectJsonResult(
	stdout: string,
): SmithersParseResult<{ rootDir: string | null; nodes: SmithersNode[] }> {
	let payload: unknown;
	try {
		payload = JSON.parse(stdout);
	} catch {
		return { value: { rootDir: null, nodes: [] }, valid: false, detail: "invalid JSON" };
	}
	if (!isRecord(payload)) {
		return {
			value: { rootDir: null, nodes: [] },
			valid: false,
			detail: "expected an inspect object",
		};
	}
	const obj = payload;
	const issues: string[] = [];
	let config: Record<string, unknown> = {};
	if (obj.config !== undefined) {
		if (isRecord(obj.config)) config = obj.config;
		else issues.push("config is not an object");
	}
	const rootDir = str(config.rootDir);
	// Prefer nodes[]; fall back to the legacy steps[] alias.
	let rawNodes: unknown[] = [];
	if (obj.nodes !== undefined) {
		if (Array.isArray(obj.nodes)) rawNodes = obj.nodes;
		else issues.push("nodes is not an array");
	} else if (obj.steps !== undefined) {
		if (Array.isArray(obj.steps)) rawNodes = obj.steps;
		else issues.push("steps is not an array");
	}
	const nodes: SmithersNode[] = [];
	let skipped = 0;
	for (const entry of rawNodes) {
		if (!isRecord(entry)) {
			skipped++;
			continue;
		}
		const n = entry as Record<string, unknown>;
		const id = str(n.nodeId ?? n.id);
		if (!id) {
			skipped++;
			continue;
		}
		nodes.push({
			id,
			state: str(n.state) ?? "unknown",
			attempt: typeof n.attempt === "number" ? n.attempt : 0,
			label: str(n.label) ?? id,
		});
	}
	if (skipped) issues.push(`skipped ${skipped} malformed node entr${skipped === 1 ? "y" : "ies"}`);
	return {
		value: { rootDir, nodes },
		valid: true,
		detail: issues.length > 0 ? issues.join("; ") : null,
	};
}

/** Backwards-compatible convenience parser. */
export function parseInspectJson(stdout: string): { rootDir: string | null; nodes: SmithersNode[] } {
	return parseInspectJsonResult(stdout).value;
}

export interface SmithersResult {
	runs: SmithersRun[];
	diagnostics: SourceDiagnostic[];
}

/**
 * Collect Smithers runs across the configured workspaces. For each workspace:
 * `ps` to enumerate, then `inspect` per run to attach nodes + rootDir. Any
 * workspace whose `ps` fails is reported as a diagnostic and skipped; the
 * dashboard still renders everything else.
 */
export async function collectSmithers(
	workspaces: readonly string[],
	run: CommandRunner,
	signal?: AbortSignal,
): Promise<SmithersResult> {
	const workspaceResults = await mapConcurrent(workspaces, 4, async (workspace) => {
		const runs: SmithersRun[] = [];
		const diagnostics: SourceDiagnostic[] = [];
		const label = `smithers:${shortenPath(workspace)}`;
		// Include every status through the public CLI, but request one sentinel
		// row beyond our inspection ceiling so cap truncation is observable.
		const ps = await run(
			"bunx",
			[SMITHERS_SPEC, "ps", "--all", "--limit", String(SMITHERS_RUN_LIMIT + 1), "--json"],
			workspace,
			signal,
		).catch(() => null);
		if (!ps || ps.exitCode !== 0) {
			diagnostics.push({ source: label, ok: false, detail: `ps failed${ps ? ` (exit ${ps.exitCode})` : ""}` });
			return { runs, diagnostics };
		}
		const parsedPs = parsePsJsonResult(ps.stdout);
		if (!parsedPs.valid) {
			diagnostics.push({ source: label, ok: false, detail: `ps malformed: ${parsedPs.detail}` });
			return { runs, diagnostics };
		}
		const capped = parsedPs.value.length > SMITHERS_RUN_LIMIT;
		const psRuns = parsedPs.value.slice(0, SMITHERS_RUN_LIMIT);
		if (capped) {
			diagnostics.push({
				source: `${label}:ps`,
				ok: false,
				level: "warning",
				detail: `more than ${SMITHERS_RUN_LIMIT} runs; showing the newest ${SMITHERS_RUN_LIMIT}`,
			});
		}
		if (parsedPs.detail) {
			diagnostics.push({
				source: `${label}:ps`,
				ok: false,
				level: "warning",
				detail: `partial: ${parsedPs.detail}`,
			});
		}
		const inspected = await mapConcurrent(psRuns, 4, async (psRun) => {
			let rootDir: string | null = null;
			let nodes: SmithersNode[] = [];
			const inspectDiagnostics: SourceDiagnostic[] = [];
			const inspect = await run(
				"bunx",
				[SMITHERS_SPEC, "inspect", psRun.id, "--json"],
				workspace,
				signal,
			).catch(() => null);
			const inspectLabel = `${label}:inspect:${psRun.id}`;
			if (!inspect || inspect.exitCode !== 0) {
				inspectDiagnostics.push({
					source: inspectLabel,
					ok: false,
					level: "warning",
					detail: `inspect failed${inspect ? ` (exit ${inspect.exitCode})` : ""}`,
				});
			} else {
				const parsed = parseInspectJsonResult(inspect.stdout);
				if (!parsed.valid) {
					inspectDiagnostics.push({
						source: inspectLabel,
						ok: false,
						level: "warning",
						detail: `malformed: ${parsed.detail}`,
					});
				} else {
					rootDir = parsed.value.rootDir;
					nodes = parsed.value.nodes;
					if (parsed.detail) {
						inspectDiagnostics.push({
							source: inspectLabel,
							ok: false,
							level: "warning",
							detail: `partial: ${parsed.detail}`,
						});
					}
				}
			}
			return {
				run: { ...psRun, rootDir, workspace, nodes } satisfies SmithersRun,
				diagnostics: inspectDiagnostics,
			};
		});
		let attached = 0;
		for (const item of inspected) {
			runs.push(item.run);
			diagnostics.push(...item.diagnostics);
			if (item.run.rootDir) attached++;
		}
		diagnostics.push({
			source: label,
			ok: true,
			detail: `${psRuns.length} run${psRuns.length === 1 ? "" : "s"}${psRuns.length ? ` (${attached} with rootDir)` : ""}`,
		});
		return { runs, diagnostics };
	});

	return {
		runs: workspaceResults.flatMap((result) => result.runs),
		diagnostics: workspaceResults.flatMap((result) => result.diagnostics),
	};
}

/** Bounded, order-preserving async map for workspace/run inspection fan-out. */
async function mapConcurrent<T, R>(
	values: readonly T[],
	concurrency: number,
	mapper: (value: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(values.length);
	let next = 0;
	const workerCount = Math.min(Math.max(1, concurrency), values.length);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (next < values.length) {
				const index = next++;
				results[index] = await mapper(values[index]!);
			}
		}),
	);
	return results;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortenPath(p: string): string {
	const parts = p.split("/").filter(Boolean);
	return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}
