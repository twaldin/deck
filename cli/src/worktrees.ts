import * as fs from "node:fs";
import * as path from "node:path";
import { EFFORT_FILES, effortDir, loadConfig, manifestSchema, ulid } from "@deck/core";
import { DeckError } from "@deck/core";
import { z } from "zod";
import { addWorktree, prepareBase, removeWorktree, resolveRepository } from "./git";
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
}

export async function allocateWorktree(request: AllocateRequest): Promise<WorktreeEntry> {
	const effort = effortIdSchema.parse(request.effort);
	const repo = await resolveRepository(request.repo);
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
		const reusable = state.entries.find((entry) => entry.repo === repo && entry.state === "free");
		const number = reusable === undefined ? nextSlotNumber(state, project) : entryNumber(reusable);
		const id = reusable?.id ?? `wt:${project}:${number}`;
		const worktreePath = reusable?.path ?? path.join(WORKTREE_POOL_DIR, `${project}-${number}`);
		if (fs.existsSync(worktreePath)) {
			throw new DeckError("E_STATE", `worktree slot path already exists: ${worktreePath}`);
		}

		const base = await prepareBase(repo, request.base);
		// Keep the entropy-bearing tail. The timestamp-bearing ULID prefix is a
		// poor discriminator for branches allocated in the same millisecond.
		const branch = `deck/${effort}/${ulid().slice(-8)}`;
		await addWorktree(repo, worktreePath, branch, base);

		const entry: WorktreeEntry = {
			id,
			repo,
			path: worktreePath,
			effort,
			branch,
			created: new Date().toISOString(),
			state: "active",
		};
		const nextState = reusable === undefined
			? worktreesStateSchema.parse({ v: 1, entries: [...state.entries, entry] })
			: replaceEntry(state, entry);

		try {
			writeWorktreesState(nextState);
		} catch (error) {
			try {
				await removeWorktree(repo, worktreePath, branch, true);
			} catch (rollbackError) {
				throw new DeckError(
					"E_IO",
					`state write failed and allocator rollback failed: ${errorMessage(error)}; ${errorMessage(rollbackError)}`,
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
		const released = { ...entry, state: "free" as const };
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
	return withStateLock(async () => {
		let state = readWorktreesState();
		const reaped: WorktreeEntry[] = [];
		for (const entry of state.entries) {
			if (entry.state !== "active" || !readEffortTerminalState(entry.effort)) {
				continue;
			}

			await removeWorktree(entry.repo, entry.path, entry.branch, false);
			const released = { ...entry, state: "free" as const };
			state = replaceEntry(state, released);
			// Commit each successful physical removal before proceeding. A later
			// repository failure cannot make already-removed slots appear active.
			writeWorktreesState(state);
			reaped.push(released);
		}
		return reaped;
	});
}

export function listWorktrees(): WorktreeEntry[] {
	return readWorktreesState().entries;
}
