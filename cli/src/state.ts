import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { dlopen, FFIType, type Library } from "bun:ffi";
import { DECK_HOME, WORKTREES_STATE, DeckError } from "./core";
import { z } from "zod";
import { type WorktreesState, worktreesStateSchema } from "./schema";

/**
 * Worktree pool paths are runtime state under ~/.deck/wt/ (SPEC §0 layout).
 * The CLI owns this additional pool directory and its allocator lock.
 */
export const WORKTREE_POOL_DIR = path.join(DECK_HOME, "wt");
export const WORKTREES_LOCK = `${WORKTREES_STATE}.lock`;

const EMPTY_STATE: WorktreesState = { v: 1, entries: [] };
const nodeErrorSchema = z.object({ code: z.string() }).passthrough();
const durableManifestSchema = z.object({
	version: z.literal(1),
	home: z.string(),
	host: z.string(),
	entries: z.array(z.string()),
}).passthrough();

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

function worktreesStoragePath(): string {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(WORKTREES_STATE);
	} catch (error) {
		if (hasNodeErrorCode(error, "ENOENT")) return WORKTREES_STATE;
		throw new DeckError("E_IO", `cannot inspect ${WORKTREES_STATE}: ${ioMessage(error)}`);
	}
	if (!stat.isSymbolicLink()) return WORKTREES_STATE;
	const target = path.resolve(path.dirname(WORKTREES_STATE), fs.readlinkSync(WORKTREES_STATE));
	const durableRoot = path.dirname(target);
	try {
		const manifest = durableManifestSchema.parse(
			JSON.parse(fs.readFileSync(path.join(durableRoot, ".deck-durable.json"), "utf8")),
		);
		if (
			target !== path.join(durableRoot, "worktrees.json") ||
			manifest.home !== path.resolve(DECK_HOME) ||
			manifest.host !== os.hostname() ||
			!manifest.entries.includes("worktrees.json")
		) {
			throw new Error("ownership does not match this Deck home and host");
		}
		return target;
	} catch (error) {
		throw new DeckError(
			"E_IO",
			`refusing unowned worktree registry link ${WORKTREES_STATE} -> ${fs.readlinkSync(WORKTREES_STATE)}: ${ioMessage(error)}`,
		);
	}
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
		text = fs.readFileSync(worktreesStoragePath(), "utf8");
	} catch (error) {
		if (hasNodeErrorCode(error, "ENOENT")) {
			return EMPTY_STATE;
		}
		if (error instanceof DeckError) throw error;
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

	const storagePath = worktreesStoragePath();
	const temporary = `${storagePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	let descriptor: number | undefined;
	let directoryDescriptor: number | undefined;
	try {
		descriptor = fs.openSync(temporary, "wx", 0o600);
		fs.writeFileSync(descriptor, `${JSON.stringify(validated, null, "\t")}\n`);
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = undefined;
		fs.renameSync(temporary, storagePath);
		directoryDescriptor = fs.openSync(path.dirname(storagePath), "r");
		fs.fsyncSync(directoryDescriptor);
		fs.closeSync(directoryDescriptor);
		directoryDescriptor = undefined;
	} catch (error) {
		if (descriptor !== undefined) {
			fs.closeSync(descriptor);
		}
		if (directoryDescriptor !== undefined) {
			fs.closeSync(directoryDescriptor);
		}
		fs.rmSync(temporary, { force: true });
		throw new DeckError("E_IO", `cannot atomically write ${WORKTREES_STATE}: ${ioMessage(error)}`);
	}
}

const LOCK_EXCLUSIVE = 2;
const LOCK_NONBLOCKING = 4;
const FLOCK_SYMBOLS = {
	flock: {
		args: [FFIType.i32, FFIType.i32],
		returns: FFIType.i32,
	},
} as const;


async function acquireStateLock(): Promise<number> {
	let descriptor: number;
	try {
		descriptor = fs.openSync(WORKTREES_LOCK, "a", 0o600);
		fs.chmodSync(WORKTREES_LOCK, 0o600);
	} catch (error) {
		throw new DeckError("E_IO", `cannot prepare allocator lock: ${ioMessage(error)}`);
	}

	const libraryPath = process.platform === "darwin"
		? "/usr/lib/libSystem.B.dylib"
		: process.platform === "linux"
			? "libc.so.6"
			: undefined;
	if (libraryPath === undefined) {
		fs.closeSync(descriptor);
		throw new DeckError("E_IO", `allocator locking is unsupported on ${process.platform}`);
	}

	let library: Library<typeof FLOCK_SYMBOLS>;
	try {
		library = dlopen(libraryPath, FLOCK_SYMBOLS);
	} catch (error) {
		fs.closeSync(descriptor);
		throw new DeckError("E_IO", `cannot load allocator locking primitive: ${ioMessage(error)}`);
	}

	const deadline = Date.now() + 300_000;
	try {
		while (library.symbols.flock(descriptor, LOCK_EXCLUSIVE | LOCK_NONBLOCKING) !== 0) {
			if (Date.now() >= deadline) {
				throw new DeckError("E_IO", `timed out waiting for allocator lock ${WORKTREES_LOCK}`);
			}
			await Bun.sleep(25);
		}
		return descriptor;
	} catch (error) {
		fs.closeSync(descriptor);
		throw error;
	} finally {
		library.close();
	}
}

/**
 * Exclusive allocator section. The kernel lock belongs to this process and
 * its open descriptor, so process death and reboot release it automatically.
 */
export async function withStateLock<T>(operation: () => Promise<T>): Promise<T> {
	ensureAllocatorDirs();
	const descriptor = await acquireStateLock();
	try {
		return await operation();
	} finally {
		try {
			fs.closeSync(descriptor);
		} catch (error) {
			throw new DeckError("E_IO", `cannot release allocator lock: ${ioMessage(error)}`);
		}
	}
}
