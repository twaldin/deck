import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { stateDir } from "./home";
import { appendStatus } from "./events";
import { SMITHERS_SPEC } from "./smithers";

const execFile = promisify(execFileCallback);

export type RecutRun = {
	id: string;
	workflow?: string;
	status?: string;
	state?: string;
	step?: string;
	rootDir?: string;
};
export type RecutInput = Record<string, unknown>;
export type RecutResult = { oldRunId: string; newRunId: string; mode: "stamp" | "safe-boundary" };
export type RecutOptions = {
	runs: readonly RecutRun[];
	pipelineDir: string;
	inspect: (runId: string) => Promise<unknown>;
	cancel: (runId: string) => Promise<void>;
	start: (runId: string, input: RecutInput) => Promise<void>;
	syncWorktree?: (input: RecutInput) => Promise<void>;
	recordDir?: string;
};

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "finished"]);
const APPROVAL = new Set(["waiting-approval", "waiting-human"]);

export function pipelineHash(pipelineDir: string): string {
	const hash = createHash("sha256");
	const root = path.join(pipelineDir, "pipeline.tsx");
	hash.update(fs.readFileSync(root));
	return hash.digest("hex");
}

function findHash(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const row = value as Record<string, unknown>;
	const durability = row.config && typeof row.config === "object" ? (row.config as Record<string, unknown>).__smithersDurability : undefined;
	if (durability && typeof durability === "object") {
		const hash = (durability as Record<string, unknown>).entryWorkflowHash;
		if (typeof hash === "string") return hash;
	}
	for (const candidate of Object.values(row)) {
		const nested = findHash(candidate);
		if (nested !== undefined) return nested;
	}
	return undefined;
}

function nextRunId(oldId: string, used: Set<string>): string {
	const match = /^(.*)-v(\d+)$/.exec(oldId);
	const base = match?.[1] ?? oldId;
	let version = Number(match?.[2] ?? 1) + 1;
	let id = `${base}-v${version}`;
	while (used.has(id)) id = `${base}-v${++version}`;
	return id;
}

function ledgerPath(dir: string): string { return path.join(dir, ".recuts.json"); }
function readLedger(dir: string): Record<string, string> {
	try { return JSON.parse(fs.readFileSync(ledgerPath(dir), "utf8")) as Record<string, string>; } catch { return {}; }
}
function writeLedger(dir: string, ledger: Record<string, string>): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = ledgerPath(dir);
	fs.writeFileSync(`${target}.tmp`, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(`${target}.tmp`, target);
}

function inputFor(dir: string, runId: string): RecutInput | null {
	try { return JSON.parse(fs.readFileSync(path.join(dir, `${runId}.input.json`), "utf8")) as RecutInput; } catch { return null; }
}

/** Re-cut stale live pipeline runs once for each pipeline content hash. */
export async function recutChangedRuns(options: RecutOptions): Promise<RecutResult[]> {
	const current = pipelineHash(options.pipelineDir);
	const recordDir = options.recordDir ?? path.join(stateDir(), "ship");
	const ledger = readLedger(recordDir);
	const used = new Set(options.runs.map((run) => run.id));
	const results: RecutResult[] = [];
	for (const run of options.runs) {
		const state = (run.state ?? run.status ?? "").toLowerCase();
		if (run.workflow !== undefined && !["pr-pipeline", "lindy-pr-pipeline"].includes(run.workflow)) continue;
		if (TERMINAL.has(state)) continue;
		const recorded = findHash(await options.inspect(run.id));
		if (recorded === undefined || recorded === current || ledger[run.id] === current) continue;
		const input = inputFor(recordDir, run.id);
		if (input === null) continue;
		const mode = APPROVAL.has(state) ? "stamp" : "safe-boundary";
		// A running run is recut only at a named watch/fix boundary. Unknown steps
		// are left for the next poll instead of risking a mid-node duplicate.
		if (mode === "safe-boundary" && !/(watch-poll|ready-poll)$/i.test(run.step ?? "")) continue;
		await options.syncWorktree?.(input);
		const newRunId = nextRunId(run.id, used);
		used.add(newRunId);
		await options.cancel(run.id);
		const nextInput = { ...input };
		await options.start(newRunId, nextInput);
		fs.writeFileSync(path.join(recordDir, `${newRunId}.input.json`), `${JSON.stringify(nextInput, null, 2)}\n`, { mode: 0o600 });
		ledger[run.id] = current;
		writeLedger(recordDir, ledger);
		const evidence = { oldRunId: run.id, newRunId, pipelineHash: current, mode };
		fs.appendFileSync(path.join(recordDir, "recuts.jsonl"), `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
		if (typeof input.ticket === "string") appendStatus(input.ticket, "working", `pipeline drift recut: ${run.id} -> ${newRunId}`);
		results.push({ oldRunId: run.id, newRunId, mode });
	}
	return results;
}

/** Default worktree preparation. It never destroys commits ahead of the PR head. */
export async function reconcileRecuts(workspace: string, pipeline: string, runs: readonly RecutRun[]): Promise<RecutResult[]> {
	const shipDir = path.join(stateDir(), "ship");
	return recutChangedRuns({
		runs,
		pipelineDir: pipeline,
		inspect: async (runId) => {
			const result = await execFile("bunx", [SMITHERS_SPEC, "inspect", runId, "--format", "json"], { cwd: workspace });
			return JSON.parse(result.stdout);
		},
		cancel: async (runId) => { await execFile("bunx", [SMITHERS_SPEC, "cancel", runId], { cwd: workspace }); },
		start: async (runId, input) => {
			await new Promise<void>((resolve, reject) => {
				const child = spawn("bunx", [SMITHERS_SPEC, "up", "pipeline.tsx", "--input", JSON.stringify(input), "--run-id", runId], { cwd: pipeline, detached: true, stdio: "ignore" });
				child.once("spawn", () => { child.unref(); resolve(); });
				child.once("error", reject);
			});
		},
		syncWorktree: syncAdoptWorktree,
		recordDir: shipDir,
	});
}

export async function syncAdoptWorktree(input: RecutInput): Promise<void> {
	const worktree = typeof input.worktree === "string" ? input.worktree : undefined;
	const pr = typeof input.existingPr === "number" ? input.existingPr : undefined;
	if (worktree === undefined || pr === undefined) return;
	await execFile("git", ["fetch", "origin", `pull/${pr}/head:refs/remotes/origin/pr-${pr}`], { cwd: worktree });
	const { stdout: ahead } = await execFile("git", ["rev-list", "--count", `refs/remotes/origin/pr-${pr}..HEAD`], { cwd: worktree });
	if (Number(ahead.trim()) > 0) return;
	await execFile("git", ["reset", "--hard", `refs/remotes/origin/pr-${pr}`], { cwd: worktree });
}
