import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DeckError } from "../errors";
import { lockMetadataSchema } from "./schemas";

const LOCK_RETRY_MS = 10;
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 120_000;
const nodeErrorSchema = z.object({ code: z.string().optional() }).loose();

export function ensurePrivateDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
}

export function fsyncDirectory(dir: string): void {
	let descriptor: number | null = null;
	try {
		descriptor = fs.openSync(dir, fs.constants.O_RDONLY);
		fs.fsyncSync(descriptor);
	} catch (error) {
		throw ioError(`cannot fsync directory ${dir}`, error);
	} finally {
		if (descriptor !== null) {
			fs.closeSync(descriptor);
		}
	}
}

export function parseJsonFile<T>(file: string, schema: z.ZodType<T>): T {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		throw ioError(`cannot read ${file}`, error);
	}

	try {
		const decoded: unknown = JSON.parse(raw);
		return schema.parse(decoded);
	} catch (error) {
		throw ioError(`invalid state in ${file}`, error);
	}
}

export function atomicWriteJson<T>(file: string, value: T, schema: z.ZodType<T>, temporaryFile?: string): T {
	const parsed = schema.parse(value);
	const tmp = temporaryFile ?? `${file}.tmp`;
	ensurePrivateDir(path.dirname(file));
	let descriptor: number | null = null;
	try {
		descriptor = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY, 0o600);
		fs.writeFileSync(descriptor, `${JSON.stringify(parsed)}\n`, "utf8");
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = null;
		fs.renameSync(tmp, file);
		fs.chmodSync(file, 0o600);
		fsyncDirectory(path.dirname(file));
		return parsed;
	} catch (error) {
		throw ioError(`cannot atomically write ${file}`, error);
	} finally {
		if (descriptor !== null) {
			fs.closeSync(descriptor);
		}
	}
}

export function atomicWriteJsonLines<T>(file: string, values: T[], schema: z.ZodType<T>): T[] {
	const parsed = values.map((value) => schema.parse(value));
	const tmp = `${file}.tmp`;
	const contents = parsed.length === 0
		? ""
		: `${parsed.map((value) => JSON.stringify(value)).join("\n")}\n`;
	ensurePrivateDir(path.dirname(file));
	let descriptor: number | null = null;
	try {
		descriptor = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY, 0o600);
		fs.writeFileSync(descriptor, contents, "utf8");
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = null;
		fs.renameSync(tmp, file);
		fs.chmodSync(file, 0o600);
		fsyncDirectory(path.dirname(file));
		return parsed;
	} catch (error) {
		throw ioError(`cannot atomically rewrite ${file}`, error);
	} finally {
		if (descriptor !== null) {
			fs.closeSync(descriptor);
		}
	}
}

/**
 * Append one pre-serialized JSONL record with exactly one write(2), then fsync.
 * O_APPEND provides record placement; a short write is an I/O failure and is
 * never retried because a retry could splice another writer into the record.
 */
export function appendJsonLine<T>(file: string, value: T, schema: z.ZodType<T>, sync = true): T {
	const parsed = schema.parse(value);
	const bytes = Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
	appendBytes(file, bytes, sync);
	return parsed;
}

export function appendQuarantinedLine(file: string, line: Buffer): void {
	const suffix = line.length > 0 && line[line.length - 1] === 0x0a ? Buffer.alloc(0) : Buffer.from("\n");
	appendBytes(file, Buffer.concat([line, suffix]), true);
}

/**
 * Repair only the final JSONL record while no writer can append. A malformed
 * suffix is copied to the bad file before truncation; a valid record missing
 * its final newline is terminated so the next O_APPEND record cannot join it.
 */
export function repairTrailingJsonLine<T>(file: string, badFile: string, schema: z.ZodType<T>): void {
	if (!fs.existsSync(file)) {
		ensurePrivateDir(path.dirname(file));
		fs.writeFileSync(file, "", { mode: 0o600 });
		return;
	}
	const bytes = fs.readFileSync(file);
	let logicalEnd = bytes.length;
	while (logicalEnd > 0 && (bytes[logicalEnd - 1] === 0x0a || bytes[logicalEnd - 1] === 0x0d)) {
		logicalEnd -= 1;
	}
	if (logicalEnd === 0) {
		return;
	}

	const content = bytes.subarray(0, logicalEnd).toString("utf8");
	const lines = content.split("\n");
	const terminated = bytes[bytes.length - 1] === 0x0a;
	let malformedLast = false;
	for (let index = 0; index < lines.length; index += 1) {
		const rawLine = lines[index];
		if (rawLine === undefined) {
			continue;
		}
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		let decoded: unknown;
		try {
			decoded = JSON.parse(line);
		} catch (error) {
			if (index !== lines.length - 1) {
				throw new DeckError("E_IO", `malformed non-trailing JSONL record in ${file}`, {
					line: index + 1,
					cause: error instanceof Error ? error.message : String(error),
				});
			}
			malformedLast = true;
			continue;
		}
		try {
			schema.parse(decoded);
		} catch (error) {
			if (index !== lines.length - 1 || terminated) {
				throw new DeckError("E_IO", `schema-invalid durable JSONL record in ${file}`, {
					line: index + 1,
					cause: error instanceof Error ? error.message : String(error),
				});
			}
			malformedLast = true;
		}
	}

	if (!malformedLast) {
		if (bytes[bytes.length - 1] !== 0x0a) {
			appendBytes(file, Buffer.from("\n"), true);
		}
		return;
	}

	const previousNewline = bytes.lastIndexOf(0x0a, logicalEnd - 1);
	const badStart = previousNewline < 0 ? 0 : previousNewline + 1;
	appendQuarantinedLine(badFile, bytes.subarray(badStart, logicalEnd));
	let descriptor: number | null = null;
	try {
		descriptor = fs.openSync(file, fs.constants.O_WRONLY);
		fs.ftruncateSync(descriptor, badStart);
		fs.fsyncSync(descriptor);
	} catch (error) {
		throw ioError(`cannot truncate quarantined suffix in ${file}`, error);
	} finally {
		if (descriptor !== null) {
			fs.closeSync(descriptor);
		}
	}
}

function appendBytes(file: string, bytes: Buffer, sync: boolean): void {
	ensurePrivateDir(path.dirname(file));
	let descriptor: number | null = null;
	try {
		descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
		const written = fs.writeSync(descriptor, bytes, 0, bytes.length, null);
		if (written !== bytes.length) {
			throw new DeckError("E_IO", `short append to ${file}`, { expected: bytes.length, written });
		}
		if (sync) {
			fs.fsyncSync(descriptor);
		}
		fs.chmodSync(file, 0o600);
	} catch (error) {
		if (error instanceof DeckError) {
			throw error;
		}
		throw ioError(`cannot append ${file}`, error);
	} finally {
		if (descriptor !== null) {
			fs.closeSync(descriptor);
		}
	}
}

export function readJsonLines<T>(file: string, schema: z.ZodType<T>): T[] {
	if (!fs.existsSync(file)) {
		return [];
	}

	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		throw ioError(`cannot read ${file}`, error);
	}

	const records: T[] = [];
	const lines = raw.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined || line.length === 0) {
			continue;
		}
		try {
			const decoded: unknown = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
			records.push(schema.parse(decoded));
		} catch (error) {
			throw new DeckError("E_IO", `invalid JSONL record in ${file}`, {
				line: index + 1,
				cause: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return records;
}

/**
 * Node and Bun expose no dependency-free flock API. This is the SPEC §4.2
 * fallback: O_CREAT|O_EXCL creates the lockfile and contenders retry. A live
 * holder is never timed out; only a dead holder or malformed stale lock is
 * removed. A recovery lock closes the stale-removal/acquisition race.
 */
export function withExclusiveLock<T>(lockFile: string, fn: () => T): T {
	ensurePrivateDir(path.dirname(lockFile));
	const deadline = Date.now() + LOCK_WAIT_MS;
	const nonce = randomBytes(16).toString("hex");
	const recoveryFile = `${lockFile}.recovery`;

	while (true) {
		clearAbandonedRecovery(recoveryFile);
		if (fs.existsSync(recoveryFile)) {
			assertLockDeadline(lockFile, deadline);
			sleepSync(LOCK_RETRY_MS);
			continue;
		}

		let descriptor: number;
		try {
			descriptor = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) {
				throw ioError(`cannot acquire ${lockFile}`, error);
			}
			clearStaleLock(lockFile, recoveryFile);
			assertLockDeadline(lockFile, deadline);
			sleepSync(LOCK_RETRY_MS);
			continue;
		}

		if (fs.existsSync(recoveryFile)) {
			fs.closeSync(descriptor);
			try {
				fs.unlinkSync(lockFile);
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT")) {
					throw ioError(`cannot yield ${lockFile} to recovery`, error);
				}
			}
			assertLockDeadline(lockFile, deadline);
			sleepSync(LOCK_RETRY_MS);
			continue;
		}

		try {
			const metadata = lockMetadataSchema.parse({ pid: process.pid, acquired: Date.now(), nonce });
			fs.writeFileSync(descriptor, `${JSON.stringify(metadata)}\n`, "utf8");
			fs.fsyncSync(descriptor);
		} catch (error) {
			fs.closeSync(descriptor);
			try {
				fs.unlinkSync(lockFile);
			} catch {
				// The original initialization failure is the actionable error.
			}
			throw ioError(`cannot initialize ${lockFile}`, error);
		}

		try {
			return fn();
		} finally {
			fs.closeSync(descriptor);
			releaseOwnedLock(lockFile, nonce);
		}
	}
}

function clearStaleLock(lockFile: string, recoveryFile: string): void {
	let recoveryDescriptor: number | null = null;
	const recoveryNonce = randomBytes(16).toString("hex");
	try {
		recoveryDescriptor = fs.openSync(
			recoveryFile,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
			0o600,
		);
		const metadata = lockMetadataSchema.parse({
			pid: process.pid,
			acquired: Date.now(),
			nonce: recoveryNonce,
		});
		fs.writeFileSync(recoveryDescriptor, `${JSON.stringify(metadata)}\n`, "utf8");
		fs.fsyncSync(recoveryDescriptor);
	} catch (error) {
		if (recoveryDescriptor !== null) {
			fs.closeSync(recoveryDescriptor);
			try {
				fs.unlinkSync(recoveryFile);
			} catch {
				// Preserve the initialization error; stale recovery handles residue.
			}
		}
		if (hasErrorCode(error, "EEXIST")) {
			return;
		}
		throw ioError(`cannot coordinate stale recovery for ${lockFile}`, error);
	}

	try {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(lockFile);
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) {
				return;
			}
			throw ioError(`cannot inspect ${lockFile}`, error);
		}

		const age = Date.now() - stat.mtimeMs;
		let removable = false;
		try {
			const metadata = parseJsonFile(lockFile, lockMetadataSchema);
			try {
				process.kill(metadata.pid, 0);
			} catch (error) {
				removable = hasErrorCode(error, "ESRCH");
			}
		} catch {
			removable = age >= LOCK_STALE_MS;
		}
		// Store callbacks are synchronous and bounded; age also defeats PID reuse after reboot.
		removable = removable || age >= LOCK_STALE_MS;

		if (removable) {
			try {
				fs.unlinkSync(lockFile);
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT")) {
					throw ioError(`cannot clear stale ${lockFile}`, error);
				}
			}
		}
	} finally {
		if (recoveryDescriptor !== null) {
			fs.closeSync(recoveryDescriptor);
		}
		releaseOwnedLock(recoveryFile, recoveryNonce);
	}
}

function clearAbandonedRecovery(recoveryFile: string): void {
	if (!fs.existsSync(recoveryFile)) {
		return;
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(recoveryFile);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return;
		}
		throw ioError(`cannot inspect ${recoveryFile}`, error);
	}
	let removable = false;
	try {
		const metadata = parseJsonFile(recoveryFile, lockMetadataSchema);
		try {
			process.kill(metadata.pid, 0);
		} catch (error) {
			removable = hasErrorCode(error, "ESRCH");
		}
	} catch {
		removable = Date.now() - stat.mtimeMs >= LOCK_STALE_MS;
	}
	if (removable) {
		try {
			fs.unlinkSync(recoveryFile);
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) {
				throw ioError(`cannot clear abandoned ${recoveryFile}`, error);
			}
		}
	}
}

function releaseOwnedLock(lockFile: string, nonce: string): void {
	let decoded: unknown;
	try {
		decoded = JSON.parse(fs.readFileSync(lockFile, "utf8"));
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return;
		}
		throw ioError(`cannot inspect owned lock ${lockFile}`, error);
	}
	const metadata = lockMetadataSchema.parse(decoded);
	if (metadata.nonce === nonce) {
		try {
			fs.unlinkSync(lockFile);
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) {
				throw ioError(`cannot release ${lockFile}`, error);
			}
		}
	}
}

function assertLockDeadline(lockFile: string, deadline: number): void {
	if (Date.now() >= deadline) {
		throw new DeckError("E_IO", `timed out acquiring ${lockFile}`, { timeout_ms: LOCK_WAIT_MS });
	}
}

function sleepSync(milliseconds: number): void {
	const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
	Atomics.wait(signal, 0, 0, milliseconds);
}

function hasErrorCode(error: unknown, code: string): boolean {
	const parsed = nodeErrorSchema.safeParse(error);
	return parsed.success && parsed.data.code === code;
}

function ioError(message: string, cause: unknown): DeckError {
	if (cause instanceof DeckError) {
		return cause;
	}
	return new DeckError("E_IO", message, { cause: cause instanceof Error ? cause.message : String(cause) });
}
