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
 * The orchestrator's home is NOT a code checkout.
 *
 * fm2 conflated the two: FM_HOME was the repo you also developed the fleet
 * tooling in. That breaks three ways, and the third is the one that gives it
 * away:
 *   - the orchestrator loads the REPO's AGENTS.md, which is project memory
 *     (build, test, architecture notes) — the wrong document for its job, and
 *     there is no room for a second one
 *   - live data/ and state/ sit inside a working tree that a crew may rebase or
 *     check out from under them
 *   - a crew working ON the tooling shares a directory with the orchestrator's
 *     running state
 *
 * So the home is its own plain directory. The repo becomes an ordinary project
 * it dispatches against, and the contract arrives by symlink so editing it stays
 * a normal repo commit.
 *
 * Resolved per call, not frozen at module load: a module-load constant bakes
 * whichever value the first import happened to see into every later caller.
 */
export function deckV2Home(): string {
	return process.env.DECK_V2_HOME ?? path.join(os.homedir(), ".deck");
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

/**
 * Intake records, written by the deck-intake poller (intake/ in the repo).
 * `events.jsonl` is append-only; reconcile consumes it with the same
 * identity-aware cursor discipline as `.status` files.
 */
export function intakeFiles() {
	return {
		events: path.join(deckV2Home(), "intake", "events.jsonl"),
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

/**
 * Refuse a home that is inside a git working tree.
 *
 * This is the structural guard for the split above: without it, the natural
 * drift is to point the home back at a checkout and re-create fm2's problem.
 * A symlinked AGENTS.md is fine — a link into a repo does not make the home one.
 */
export function assertHomeIsNotACheckout(home = deckV2Home()): void {
	if (process.env.DECK_V2_ALLOW_REPO_HOME === "1") return;
	// Canonicalize first. path.resolve does not follow symlinks, so a home that is
	// a symlink pointing INTO a checkout walked the link's own parents and never
	// saw the repo's .git — the guard passed and live state landed in a working
	// tree anyway. For a home that does not exist yet, resolve the nearest
	// existing ancestor and re-append the rest.
	let dir = realpathOrNearest(path.resolve(home));
	for (;;) {
		if (fs.existsSync(path.join(dir, ".git"))) {
			throw new Error(
				`refusing to use ${home} as the orchestrator home: it is inside the git working tree at ${dir}.\n` +
					"The orchestrator's home is a plain directory, not a code checkout: a checkout brings its own AGENTS.md " +
					"(project memory, not the orchestrator contract) and lets a crew rebase live state out from under it.\n" +
					"Run `deck-v2 bootstrap` to create a proper home, or set DECK_V2_ALLOW_REPO_HOME=1 if you truly mean this.",
			);
		}
		const parent = path.dirname(dir);
		if (parent === dir) return;
		dir = parent;
	}
}

/**
 * Canonical path for a location that may not exist yet: realpath the deepest
 * existing ancestor, then re-append the missing segments.
 */
function realpathOrNearest(target: string): string {
	const missing: string[] = [];
	let dir = target;
	for (;;) {
		try {
			return path.join(fs.realpathSync(dir), ...missing.reverse());
		} catch {
			const parent = path.dirname(dir);
			if (parent === dir) return target;
			missing.push(path.basename(dir));
			dir = parent;
		}
	}
}

/**
 * Refuse a home that is another fleet's home.
 *
 * The two systems stay apart only because they use different state directories,
 * and nothing structural enforced that: the old system's watcher globs every
 * `*.status` in its own state dir, so sharing one directory means both systems act
 * on the same task — two owners, conflicting orders. This makes the one rule that
 * matters a check instead of a comment.
 */
export function assertHomeIsNotAnotherFleet(home = deckV2Home()): void {
	const resolved = realpathOrNearest(path.resolve(home));
	// The old system is identifiable by its own layout: a state/ dir alongside the
	// bin/ of fleet scripts that own it.
	const looksLikeLegacyFleet =
		fs.existsSync(path.join(resolved, "state")) &&
		fs.existsSync(path.join(resolved, "bin", "fm-watch.sh"));
	if (looksLikeLegacyFleet) {
		throw new Error(
			`refusing to use ${home} as the orchestrator home: it is the previous fleet's home.\n` +
				"Both systems would then act on the same task records, and the previous one cannot be told " +
				"to skip deck-owned tasks — it has no notion of ownership and watches every status file in " +
				"its state directory. Keep the homes separate.",
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
