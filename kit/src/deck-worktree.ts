import { z } from "zod";

const worktreeIdSchema = z.string().regex(/^wt:[A-Za-z0-9._-]+:[1-9][0-9]*$/);

const effortIdSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be safe for use in a git branch name");

const worktreeEntrySchema = z
	.object({
		id: worktreeIdSchema,
		repo: z.string().min(1),
		path: z.string().min(1),
		effort: effortIdSchema,
		branch: z.string().min(1),
		created: z.string().datetime({ offset: true }),
		state: z.enum(["active", "free"]),
	})
	.strict();

const allocateInputSchema = z
	.object({
		repo: z.string().min(1),
		effort: effortIdSchema,
		base: z.string().min(1).optional(),
	})
	.strict();

const allocatedWorktreeSchema = z
	.object({
		id: worktreeIdSchema,
		path: z.string().min(1),
		branch: z.string().min(1),
	})
	.strict();

const deckWorktreeOptionsSchema = z
	.object({
		command: z.string().min(1).default("deck"),
		cwd: z.string().min(1).optional(),
		timeoutMs: z.number().int().positive().default(300_000),
	})
	.strict();

const deckWorktreeRunOptionsSchema = z
	.object({
		signal: z
			.custom<AbortSignal>((value) => value instanceof AbortSignal, "signal must be an AbortSignal")
			.optional(),
		timeoutMs: z.number().int().positive().optional(),
	})
	.strict();

export type WorktreeEntry = z.infer<typeof worktreeEntrySchema>;
export type AllocateWorktreeInput = z.input<typeof allocateInputSchema>;
export type AllocatedWorktree = z.infer<typeof allocatedWorktreeSchema>;
export type DeckWorktreeOptions = z.input<typeof deckWorktreeOptionsSchema>;
export type DeckWorktreeRunOptions = z.input<typeof deckWorktreeRunOptionsSchema>;

export type DeckWorktreeFailureReason = "aborted" | "exit" | "spawn" | "timeout";

export class DeckWorktreeCommandError extends Error {
	readonly reason: DeckWorktreeFailureReason;
	readonly exitCode: number | null;
	readonly stderr: string;

	constructor(
		args: readonly string[],
		reason: DeckWorktreeFailureReason,
		exitCode: number | null,
		stderr: string,
	) {
		const status = exitCode === null ? reason : `exit ${exitCode}`;
		super(`deck ${args.join(" ")} failed (${status}): ${stderr || "no stderr"}`);
		this.name = "DeckWorktreeCommandError";
		this.reason = reason;
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

function isProcessGroupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

function signalProcessGroup(pgid: number, signal: "SIGKILL" | "SIGTERM"): void {
	try {
		process.kill(-pgid, signal);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
			try {
				process.kill(pgid, signal);
			} catch {
				// The process exited between liveness check and signal delivery.
			}
		}
	}
}

/** Typed, shell-free adapter over the shared `deck wt` allocator. */
export class DeckWorktree {
	readonly command: string;
	readonly cwd: string | undefined;
	readonly timeoutMs: number;

	constructor(options: DeckWorktreeOptions = {}) {
		const parsed = deckWorktreeOptionsSchema.parse(options);
		this.command = parsed.command;
		this.cwd = parsed.cwd;
		this.timeoutMs = parsed.timeoutMs;
	}

	async allocate(
		input: AllocateWorktreeInput,
		options: DeckWorktreeRunOptions = {},
	): Promise<AllocatedWorktree> {
		const parsed = allocateInputSchema.parse(input);
		const args = ["wt", "alloc", "--repo", parsed.repo, "--effort", parsed.effort];
		if (parsed.base !== undefined) {
			args.push("--base", parsed.base);
		}
		const stdout = await this.run(args, options);
		const fields = z.tuple([worktreeIdSchema, z.string().min(1), z.string().min(1)]).parse(stdout.split("\t"));
		return allocatedWorktreeSchema.parse({ id: fields[0], path: fields[1], branch: fields[2] });
	}

	async release(id: string, deleteBranch = false, options: DeckWorktreeRunOptions = {}): Promise<void> {
		const parsedId = worktreeIdSchema.parse(id);
		const args = ["wt", "release", parsedId];
		if (deleteBranch) {
			args.push("--delete-branch");
		}
		await this.run(args, options);
	}

	async list(options: DeckWorktreeRunOptions = {}): Promise<WorktreeEntry[]> {
		const stdout = await this.run(["wt", "ls", "--json"], options);
		return z.array(worktreeEntrySchema).parse(JSON.parse(stdout));
	}

	async reap(options: DeckWorktreeRunOptions = {}): Promise<number> {
		const stdout = await this.run(["wt", "reap"], options);
		const match = /^Reaped ([0-9]+) worktrees?\.$/.exec(stdout);
		if (match?.[1] === undefined) {
			throw new Error(`unexpected deck wt reap output: ${stdout}`);
		}
		return z.coerce.number().int().nonnegative().parse(match[1]);
	}

	private async run(args: string[], options: DeckWorktreeRunOptions): Promise<string> {
		const parsedOptions = deckWorktreeRunOptionsSchema.parse(options);
		const timeoutMs = parsedOptions.timeoutMs ?? this.timeoutMs;
		let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
		try {
			child = Bun.spawn([this.command, ...args], {
				cwd: this.cwd,
				env: process.env,
				detached: true,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (error) {
			throw new DeckWorktreeCommandError(
				args,
				"spawn",
				null,
				error instanceof Error ? error.message : String(error),
			);
		}

		let terminationReason: "aborted" | "timeout" | undefined;
		let escalationTimer: Timer | undefined;
		const terminate = (reason: "aborted" | "timeout") => {
			if (terminationReason !== undefined) {
				return;
			}
			terminationReason = reason;
			signalProcessGroup(child.pid, "SIGTERM");
			escalationTimer = setTimeout(() => {
				if (isProcessGroupAlive(child.pid)) {
					signalProcessGroup(child.pid, "SIGKILL");
				}
			}, 1_000);
		};
		const timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
		const abortListener = () => terminate("aborted");
		if (parsedOptions.signal?.aborted) {
			abortListener();
		} else {
			parsedOptions.signal?.addEventListener("abort", abortListener, { once: true });
		}

		let exitCode: number;
		let stdout: string;
		let stderr: string;
		try {
			[exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
		} finally {
			clearTimeout(timeoutTimer);
			clearTimeout(escalationTimer);
			parsedOptions.signal?.removeEventListener("abort", abortListener);
			if (terminationReason !== undefined && isProcessGroupAlive(child.pid)) {
				signalProcessGroup(child.pid, "SIGKILL");
			}
		}

		if (terminationReason !== undefined) {
			throw new DeckWorktreeCommandError(args, terminationReason, null, stderr.trim());
		}
		if (exitCode !== 0) {
			throw new DeckWorktreeCommandError(args, "exit", exitCode, stderr.trim());
		}
		return stdout.trim();
	}
}
