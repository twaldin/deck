import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";

const commandSchema = z.object({
	command: z.string().min(1),
	args: z.array(z.string()),
});

export type ProcessFailureReason = "deadline" | "output-cap" | "spawn" | "exit";

export class ProcessFailure extends Error {
	readonly reason: ProcessFailureReason;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;

	constructor(
		reason: ProcessFailureReason,
		message: string,
		result: { exitCode?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string } = {},
	) {
		super(message);
		this.reason = reason;
		this.exitCode = result.exitCode ?? null;
		this.signal = result.signal ?? null;
		this.stdout = result.stdout ?? "";
		this.stderr = result.stderr ?? "";
	}
}

export interface ProcessGroup {
	child: ChildProcessWithoutNullStreams;
	pid: number;
	pgid: number;
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface SpawnGroupOptions {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
}

/** Bun's Node-compatible detached spawn calls setsid(2) on macOS/Linux (SPEC §5.5.2). */
export function spawnProcessGroup(
	command: string,
	args: string[],
	options: SpawnGroupOptions = {},
): ProcessGroup {
	const parsed = commandSchema.parse({ command, args });
	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawn(parsed.command, parsed.args, {
			cwd: options.cwd,
			env: options.env,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		throw new ProcessFailure("spawn", error instanceof Error ? error.message : String(error));
	}
	if (child.pid === undefined) {
		child.once("error", () => undefined);
		throw new ProcessFailure("spawn", `spawn did not return a pid for ${parsed.command}`);
	}
	const { promise: exited, resolve } = Promise.withResolvers<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>();
	child.once("exit", (code, signal) => {
		resolve({ code, signal });
	});
	return { child, pid: child.pid, pgid: child.pid, exited };
}

export function isProcessGroupAlive(pgid: number): boolean {
	if (!Number.isInteger(pgid) || pgid <= 0) {
		return false;
	}
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

/** TERM the whole group, wait the grace, KILL survivors, and await the leader reap. */
export async function killProcessGroup(
	pgid: number,
	exited?: Promise<unknown>,
	graceMs = 5_000,
): Promise<void> {
	if (isProcessGroupAlive(pgid)) {
		try {
			process.kill(-pgid, "SIGTERM");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
				throw error;
			}
		}
	}
	const deadline = Date.now() + graceMs;
	while (isProcessGroupAlive(pgid) && Date.now() < deadline) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now())));
		await promise;
	}
	if (isProcessGroupAlive(pgid)) {
		try {
			process.kill(-pgid, "SIGKILL");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
				throw error;
			}
		}
	}
	if (exited !== undefined) {
		await exited;
	}
}

export interface BoundedCommandOptions extends SpawnGroupOptions {
	deadlineMs: number;
	outputCapBytes: number;
	killGraceMs?: number;
	signal?: AbortSignal;
	onSpawn?: (group: ProcessGroup) => void;
	onExit?: (group: ProcessGroup) => void;
}

export interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** Spawn one bounded poll in an isolated process group (SPEC §5.5.1). */
export async function runBoundedCommand(
	command: string,
	args: string[],
	options: BoundedCommandOptions,
): Promise<CommandResult> {
	const group = spawnProcessGroup(command, args, options);
	try {
		options.onSpawn?.(group);
	} catch (error) {
		await killProcessGroup(group.pgid, group.exited, options.killGraceMs ?? 5_000);
		options.onExit?.(group);
		throw error;
	}
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	let capturedBytes = 0;
	let failure: ProcessFailureReason | null = null;
	let terminating: Promise<void> | null = null;
	const terminate = (reason: ProcessFailureReason): void => {
		if (failure !== null) {
			return;
		}
		failure = reason;
		terminating = killProcessGroup(group.pgid, group.exited, options.killGraceMs ?? 5_000);
	};
	const capture = (target: Buffer[], raw: Buffer): void => {
		const remaining = Math.max(0, options.outputCapBytes - capturedBytes);
		if (remaining > 0) {
			target.push(raw.subarray(0, remaining));
			capturedBytes += Math.min(raw.byteLength, remaining);
		}
		if (raw.byteLength > remaining) {
			terminate("output-cap");
		}
	};
	group.child.stdout.on("data", (raw: Buffer) => {
		capture(stdoutChunks, raw);
	});
	group.child.stderr.on("data", (raw: Buffer) => {
		capture(stderrChunks, raw);
	});
	const timer = setTimeout(() => {
		terminate("deadline");
	}, options.deadlineMs);
	const abort = (): void => {
		terminate("deadline");
	};
	options.signal?.addEventListener("abort", abort, { once: true });
	let result: { code: number | null; signal: NodeJS.Signals | null };
	try {
		result = await group.exited;
		if (terminating !== null) {
			await terminating;
		}
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		options.onExit?.(group);
	}
	const stdout = Buffer.concat(stdoutChunks).toString("utf8");
	const stderr = Buffer.concat(stderrChunks).toString("utf8");
	if (failure === "deadline") {
		throw new ProcessFailure("deadline", `poll exceeded ${options.deadlineMs}ms deadline`, { stdout, stderr });
	}
	if (failure === "output-cap") {
		throw new ProcessFailure("output-cap", `poll exceeded ${options.outputCapBytes} byte output cap`, {
			stdout,
			stderr,
		});
	}
	if (result.code !== 0) {
		throw new ProcessFailure("exit", `poll exited ${result.code ?? result.signal ?? "unknown"}`, {
			exitCode: result.code,
			signal: result.signal,
			stdout,
			stderr,
		});
	}
	return { stdout, stderr, exitCode: result.code };
}

