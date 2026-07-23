import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { DECK_HOME, WORKTREES_STATE } from "@deck/core";
import { DeckError } from "@deck/core";
import { z } from "zod";
import { type WorktreesState, worktreesStateSchema } from "./schema";

/**
 * Worktree pool paths are runtime state under ~/.deck/wt/ (SPEC §0 layout).
 * WORKTREES_STATE remains sourced from @deck/core; only the CLI owns this
 * additional pool directory and its allocator lock.
 */
export const WORKTREE_POOL_DIR = path.join(DECK_HOME, "wt");
export const WORKTREES_LOCK = `${WORKTREES_STATE}.lock`;

const EMPTY_STATE: WorktreesState = { v: 1, entries: [] };
const nodeErrorSchema = z.object({ code: z.string() }).passthrough();

function hasNodeErrorCode(error: unknown, code: string): boolean {
	const parsed = nodeErrorSchema.safeParse(error);
	return parsed.success && parsed.data.code === code;
}

function ioMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export function ensureAllocatorDirs(): void {
	try {
		for (const directory of [DECK_HOME, WORKTREE_POOL_DIR]) {
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
			fs.chmodSync(directory, 0o700);
		}
	} catch (error) {
		throw new DeckError("E_IO", `cannot create worktree state directories: ${ioMessage(error)}`);
	}
}

export function readWorktreesState(): WorktreesState {
	let text: string;
	try {
		text = fs.readFileSync(WORKTREES_STATE, "utf8");
	} catch (error) {
		if (hasNodeErrorCode(error, "ENOENT")) {
			return EMPTY_STATE;
		}
		throw new DeckError("E_IO", `cannot read ${WORKTREES_STATE}: ${ioMessage(error)}`);
	}

	try {
		return worktreesStateSchema.parse(JSON.parse(text));
	} catch (error) {
		throw new DeckError("E_IO", `invalid ${WORKTREES_STATE}: ${ioMessage(error)}`);
	}
}

/** Atomic 0600 JSON replacement. Caller must hold WORKTREES_LOCK. */
export function writeWorktreesState(state: WorktreesState): void {
	let validated: WorktreesState;
	try {
		validated = worktreesStateSchema.parse(state);
	} catch (error) {
		throw new DeckError("E_IO", `refusing to write invalid worktree state: ${ioMessage(error)}`);
	}

	const temporary = `${WORKTREES_STATE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(temporary, "wx", 0o600);
		fs.writeFileSync(descriptor, `${JSON.stringify(validated, null, "\t")}\n`);
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = undefined;
		fs.renameSync(temporary, WORKTREES_STATE);
		fs.chmodSync(WORKTREES_STATE, 0o600);
	} catch (error) {
		if (descriptor !== undefined) {
			fs.closeSync(descriptor);
		}
		fs.rmSync(temporary, { force: true });
		throw new DeckError("E_IO", `cannot atomically write ${WORKTREES_STATE}: ${ioMessage(error)}`);
	}
}

async function acquireStateLock(): Promise<number> {
	const deadline = Date.now() + 30_000;
	while (true) {
		try {
			return fs.openSync(WORKTREES_LOCK, "wx", 0o600);
		} catch (error) {
			if (!hasNodeErrorCode(error, "EEXIST")) {
				throw new DeckError("E_IO", `cannot acquire allocator lock: ${ioMessage(error)}`);
			}
			if (Date.now() >= deadline) {
				throw new DeckError("E_IO", `timed out waiting for allocator lock ${WORKTREES_LOCK}`);
			}
			await Bun.sleep(25);
		}
	}
}

/**
 * Exclusive allocator section. The lock is intentionally never broken by a
 * waiter: deleting a lock owned by a slow fetch would violate PLAN §5.8's
 * single-allocator invariant.
 */
export async function withStateLock<T>(operation: () => Promise<T>): Promise<T> {
	ensureAllocatorDirs();
	const descriptor = await acquireStateLock();
	try {
		return await operation();
	} finally {
		try {
			fs.closeSync(descriptor);
			fs.rmSync(WORKTREES_LOCK);
		} catch (error) {
			throw new DeckError("E_IO", `cannot release allocator lock: ${ioMessage(error)}`);
		}
	}
}
