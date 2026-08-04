import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { EFFORT_FILES, effortDir, loadConfig, manifestSchema, ulid, DeckError } from "./core";
import { z } from "zod";
import { addWorktree, prepareBase, removeWorktree, resolveRepository, validateBranchName } from "./git";
import { classifyIdleWorktree, excludeWorktreePool, worktreeDirty, worktreeTtlMs } from "./worktree-reaper";
import {
	type WorktreeEntry,
	type WorktreesState,
	effortIdSchema,
	worktreesStateSchema,
} from "./schema";
import {
	WORKTREE_POOL_DIR,
	readWorktreesState,
	withStateLock,
	writeWorktreesState,
} from "./state";

const admissionLimitSchema = z.number().int().positive();
const nodeErrorSchema = z.object({ code: z.string() }).passthrough();

function projectName(repo: string): string {
	const basename = path.basename(repo).replace(/\.git$/, "");
	const sanitized = basename
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (sanitized.length === 0) {
		throw new DeckError("E_ARG", `cannot derive a project name from repository ${repo}`);
	}
	return sanitized;
}

function entryNumber(entry: WorktreeEntry): number {
	const separator = entry.id.lastIndexOf(":");
	return Number.parseInt(entry.id.slice(separator + 1), 10);
}

function nextSlotNumber(state: WorktreesState, project: string): number {
	let highest = 0;
	const prefix = `wt:${project}:`;
	for (const entry of state.entries) {
		if (entry.id.startsWith(prefix)) {
			highest = Math.max(highest, entryNumber(entry));
		}
	}
	return highest + 1;
}

function replaceEntry(state: WorktreesState, replacement: WorktreeEntry): WorktreesState {
	return worktreesStateSchema.parse({
		v: 1,
		entries: state.entries.map((entry) => (entry.id === replacement.id ? replacement : entry)),
	});
}

const DEPS_READY = ".deck-deps-ready";
const DEPS_FAILED = ".deck-deps-failed";

function dependencyInstall(repo: string): { command: string; enabled: boolean } {
	const home = process.env.DECK_V2_HOME ?? path.join(process.env.HOME ?? process.cwd(), ".deck");
	try {
		const profiles = JSON.parse(fs.readFileSync(path.join(home, "config", "projects.json"), "utf8")) as unknown;
		if (Array.isArray(profiles)) {
			const profile = profiles.find((p) => p && typeof p === "object" && (p as Record<string, unknown>).primary === repo) as Record<string, unknown> | undefined;
			if (profile?.depsWarm === false) return { command: "", enabled: false };
			if (typeof profile?.installCommand === "string") return { command: profile.installCommand, enabled: true };
		}
	} catch { /* absent or invalid profile: use lockfile inference */ }
		if (fs.existsSync(path.join(repo, "pnpm-lock.yaml"))) return { command: "pnpm install --prefer-offline", enabled: true };
	if (fs.existsSync(path.join(repo, "bun.lock")) || fs.existsSync(path.join(repo, "bun.lockb"))) return { command: "bun install", enabled: true };
	return { command: "", enabled: false };
}

/** Best effort only. Never link node_modules: package-manager layouts and bins are checkout-specific. */
export function warmDependencies(worktree: string, repo: string): void {
	const install = dependencyInstall(repo);
	if (!install.enabled) return;
	for (const marker of [DEPS_READY, DEPS_FAILED]) {
		try { fs.rmSync(path.join(worktree, marker)); } catch { /* absent */ }
	}
	const ready = path.join(worktree, DEPS_READY);
	const failed = path.join(worktree, DEPS_FAILED);
	const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
	const command = `{ if sh -lc ${shellQuote(install.command)} >${shellQuote(`${failed}.log`)} 2>&1; then printf 'ready\\n' >${shellQuote(ready)}; else tail -c 4000 ${shellQuote(`${failed}.log`)} >${shellQuote(failed)}; fi; rm -f ${shellQuote(`${failed}.log`)}; }`;
	try {
		const child = spawn("sh", ["-lc", command], {
			cwd: worktree,
			detached: true,
			stdio: "ignore",
			env: process.env,
		});
		child.on("error", (error) => {
			try { fs.writeFileSync(failed, `${errorMessage(error)}\n`); } catch { /* best effort marker */ }
		});
		child.unref();
	} catch (error) {
		fs.writeFileSync(failed, `${errorMessage(error)}\n`);
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export interface AllocateRequest {
	repo: string;
	effort: string;
	base?: string;
	branch?: string;
	desc?: string;
}

export async function allocateWorktree(request: AllocateRequest): Promise<WorktreeEntry> {
	const effortResult = effortIdSchema.safeParse(request.effort);
	if (!effortResult.success) {
		throw new DeckError("E_ARG", `invalid effort id: ${z.prettifyError(effortResult.error)}`);
	}
	const effort = effortResult.data;
	const resolvedRepo = await resolveRepository(request.repo);
	const repo = resolvedRepo.identity;
	return withStateLock(async () => {
		const state = readWorktreesState();
		const config = loadConfig();
		const limitResult = admissionLimitSchema.safeParse(config.admission.maxWorktreesGlobal);
		if (!limitResult.success) {
			throw new DeckError("E_IO", "config admission.maxWorktreesGlobal must be a positive integer");
		}

		const active = state.entries.filter((entry) => entry.state === "active").length;
		if (active >= limitResult.data) {
			throw new DeckError(
				"E_ADMISSION",
				`worktree admission limit reached (${active}/${limitResult.data})`,
				{ active, limit: limitResult.data },
			);
		}

		const project = projectName(repo);
		const reusable = state.entries.find(
			(entry) => entry.repo === repo && entry.state === "free" && !fs.existsSync(entry.path),
		);
		let number = reusable === undefined ? nextSlotNumber(state, project) : entryNumber(reusable);
		let worktreePath = reusable?.path ?? path.join(WORKTREE_POOL_DIR, `${project}-${number}`);
		while (reusable === undefined && fs.existsSync(worktreePath)) {
			number += 1;
			worktreePath = path.join(WORKTREE_POOL_DIR, `${project}-${number}`);
		}
		const id = reusable?.id ?? `wt:${project}:${number}`;

		// Keep the entropy-bearing tail. The timestamp-bearing ULID prefix is a
		// poor discriminator for branches allocated in the same millisecond.
		const branch = request.branch ?? `deck/${effort}/${ulid().slice(-8)}`;
		await validateBranchName(repo, branch);
		const base = await prepareBase(resolvedRepo.context, request.base);
		const entry: WorktreeEntry = {
			id,
			repo,
			path: worktreePath,
			effort,
			branch,
			...(request.desc === undefined ? {} : { desc: request.desc }),
			created: new Date().toISOString(),
			state: "active",
		};
		const reservedState = reusable === undefined
			? worktreesStateSchema.parse({ v: 1, entries: [...state.entries, entry] })
			: replaceEntry(state, entry);

		// Journal the slot before Git crosses the filesystem boundary. A killed
		// allocator leaves a discoverable active record for release/reap rather
		// than an untracked branch and worktree.
		writeWorktreesState(reservedState);
		try {
			await addWorktree(repo, worktreePath, branch, base);
			fs.chmodSync(worktreePath, 0o700);
			warmDependencies(worktreePath, repo);
		} catch (error) {
			try {
				await removeWorktree(repo, worktreePath, branch, fs.existsSync(worktreePath));
				const failed: WorktreeEntry = { ...entry, state: "free" };
				writeWorktreesState(replaceEntry(reservedState, failed));
			} catch (rollbackError) {
				throw new DeckError(
					"E_IO",
					`worktree creation failed and allocator rollback failed: ${errorMessage(error)}; ${errorMessage(rollbackError)}`,
				);
			}
			throw error;
		}
		return entry;
	});
}

export async function releaseWorktree(id: string, deleteBranch: boolean): Promise<WorktreeEntry> {
	return withStateLock(async () => {
		const state = readWorktreesState();
		const entry = state.entries.find((candidate) => candidate.id === id);
		if (entry === undefined) {
			throw new DeckError("E_ARG", `unknown worktree id: ${id}`);
		}
		if (entry.state !== "active") {
			throw new DeckError("E_STATE", `worktree ${id} is already free`);
		}

		await removeWorktree(entry.repo, entry.path, entry.branch, deleteBranch);
		const released: WorktreeEntry = { ...entry, state: "free" };
		writeWorktreesState(replaceEntry(state, released));
		return released;
	});
}

function readEffortTerminalState(effort: string): boolean {
	const manifestPath = path.join(effortDir(effort), EFFORT_FILES.manifest);
	let text: string;
	try {
		text = fs.readFileSync(manifestPath, "utf8");
	} catch (error) {
		const parsed = nodeErrorSchema.safeParse(error);
		if (parsed.success && parsed.data.code === "ENOENT") {
			return true;
		}
		throw new DeckError("E_IO", `cannot read ${manifestPath}: ${errorMessage(error)}`);
	}

	let manifest;
	try {
		manifest = manifestSchema.parse(JSON.parse(text));
	} catch (error) {
		throw new DeckError("E_IO", `invalid ${manifestPath}: ${errorMessage(error)}`);
	}
	if (manifest.effort_id !== effort) {
		throw new DeckError("E_IO", `${manifestPath} contains effort_id ${manifest.effort_id}, expected ${effort}`);
	}
	return manifest.stage === "done" || manifest.stage === "abandoned";
}

export async function reapWorktrees(): Promise<WorktreeEntry[]> {
	excludeWorktreePool(WORKTREE_POOL_DIR);
	return withStateLock(async () => {
		let state = readWorktreesState();
		const reaped: WorktreeEntry[] = [];
		const failures: string[] = [];
		for (const entry of state.entries) {
			if (entry.state !== "active") {
				continue;
			}
			const crashedReservation = !fs.existsSync(entry.path);
			try {
				if (!crashedReservation && !readEffortTerminalState(entry.effort)) {
					continue;
				}
				if (!crashedReservation && classifyIdleWorktree(entry, Date.now(), worktreeTtlMs(), worktreeDirty(entry.path), true) !== "reap") continue;
				if (!(crashedReservation && !fs.existsSync(entry.repo))) {
					await removeWorktree(entry.repo, entry.path, entry.branch, crashedReservation);
				}
			} catch (error) {
				failures.push(`${entry.id}: ${errorMessage(error)}`);
				continue;
			}
			const released: WorktreeEntry = { ...entry, state: "free" };
			state = replaceEntry(state, released);
			// Commit each successful physical removal before proceeding. A later
			// repository failure cannot make already-removed slots appear active.
			writeWorktreesState(state);
			reaped.push(released);
		}
		if (failures.length > 0) {
			throw new DeckError(
				"E_IO",
				`reaped ${reaped.length} worktree${reaped.length === 1 ? "" : "s"}; ${failures.length} failed: ${failures.join("; ")}`,
				{ reaped: reaped.map((entry) => entry.id), failures },
			);
		}
		return reaped;
	});
}

export function listWorktrees(): WorktreeEntry[] {
	return readWorktreesState().entries;
}
