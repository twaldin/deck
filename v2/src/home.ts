/**
 * deck-v2 home layout.
 *
 * The orchestrator's cwd never changes (report §3.2): identity, memory and
 * durable records always resolve to the same paths, so there is no per-project
 * home and no inherited-config sync. DECK_V2_HOME exists so tests never touch
 * the live home.
 *
 * Note this is deliberately NOT core/src/layout.ts (~/.deck, efforts/manifests/
 * leases). That layout serves the SPEC v0.3 router design; deck-v2 keeps the
 * fm2 shape (data/ + state/) because the status grammar and record layout are
 * what make fm2 rollback possible during the parallel-run period.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Resolved per call, not frozen at module load: DECK_V2_HOME is a test seam, and
 * a module-load constant bakes whichever value the first import happened to see
 * into every later caller.
 */
export function deckV2Home(): string {
	return process.env.DECK_V2_HOME ?? path.join(os.homedir(), "dev", "deck");
}

export function dataDir(): string {
	return path.join(deckV2Home(), "data");
}

export function stateDir(): string {
	return path.join(deckV2Home(), "state");
}

/** Machine short-name for machine-qualified refs. */
export const MACHINE = process.env.DECK_MACHINE ?? os.hostname().split(".")[0] ?? "local";

/** Durable fleet memory (report §3.2). Curated, never append-forever. */
export function memoryFiles() {
	return {
		captain: path.join(dataDir(), "captain.md"),
		learnings: path.join(dataDir(), "learnings.md"),
		projects: path.join(dataDir(), "projects.md"),
	} as const;
}

export function taskDataDir(id: string): string {
	return path.join(dataDir(), id);
}

/** Per-task durable records. */
export function taskFiles(id: string) {
	return {
		brief: path.join(taskDataDir(id), "brief.md"),
		report: path.join(taskDataDir(id), "report.md"),
	} as const;
}

/**
 * Per-task runtime records. `.status` is the append-only event log whose
 * grammar is unchanged from fm2 on purpose (report §10.3): fm2 can still read
 * everything deck writes, which is what makes Class-A rollback a marker flip
 * instead of a data migration.
 */
export function stateFiles(id: string) {
	return {
		status: path.join(stateDir(), `${id}.status`),
		meta: path.join(stateDir(), `${id}.meta`),
		queue: path.join(stateDir(), `${id}.queue`),
		lock: path.join(stateDir(), `${id}.lock`),
		claim: path.join(stateDir(), `${id}.side-effect.claim`),
		receipts: path.join(stateDir(), `${id}.receipts.jsonl`),
		sessions: path.join(stateDir(), `${id}.sessions`),
	} as const;
}

/** Wake-engine records. Cursors are identity-aware (report §6.2). */
export function wakeFiles() {
	return {
		cursors: path.join(stateDir(), ".wake-cursors.json"),
		baseline: path.join(stateDir(), ".wake-baseline.json"),
		queue: path.join(stateDir(), ".wake-queue.jsonl"),
	} as const;
}

/** Task ids are privacy-safe slugs; they become file names. */
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertTaskId(id: string): void {
	if (!TASK_ID_RE.test(id)) {
		throw new Error(
			`invalid task id ${JSON.stringify(id)}: use lowercase letters, digits and hyphens (max 64)`,
		);
	}
}

export function ensureHomeDirs(): void {
	for (const dir of [dataDir(), stateDir()]) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
}

export function ensureTaskDirs(id: string): void {
	assertTaskId(id);
	ensureHomeDirs();
	fs.mkdirSync(taskDataDir(id), { recursive: true, mode: 0o700 });
}
