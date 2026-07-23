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
	})
	.strict();

export type WorktreeEntry = z.infer<typeof worktreeEntrySchema>;
export type AllocateWorktreeInput = z.input<typeof allocateInputSchema>;
export type AllocatedWorktree = z.infer<typeof allocatedWorktreeSchema>;
export type DeckWorktreeOptions = z.input<typeof deckWorktreeOptionsSchema>;

export class DeckWorktreeCommandError extends Error {
	readonly exitCode: number;
	readonly stderr: string;

	constructor(args: readonly string[], exitCode: number, stderr: string) {
		super(`deck ${args.join(" ")} failed with exit ${exitCode}: ${stderr || "no stderr"}`);
		this.name = "DeckWorktreeCommandError";
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

/** Typed, shell-free adapter over the shared `deck wt` allocator. */
export class DeckWorktree {
	readonly command: string;
	readonly cwd: string | undefined;

	constructor(options: DeckWorktreeOptions = {}) {
		const parsed = deckWorktreeOptionsSchema.parse(options);
		this.command = parsed.command;
		this.cwd = parsed.cwd;
	}

	async allocate(input: AllocateWorktreeInput): Promise<AllocatedWorktree> {
		const parsed = allocateInputSchema.parse(input);
		const args = ["wt", "alloc", "--repo", parsed.repo, "--effort", parsed.effort];
		if (parsed.base !== undefined) {
			args.push("--base", parsed.base);
		}
		const stdout = await this.run(args);
		const fields = z.tuple([worktreeIdSchema, z.string().min(1), z.string().min(1)]).parse(stdout.split("\t"));
		return allocatedWorktreeSchema.parse({ id: fields[0], path: fields[1], branch: fields[2] });
	}

	async release(id: string, deleteBranch = false): Promise<void> {
		const parsedId = worktreeIdSchema.parse(id);
		const args = ["wt", "release", parsedId];
		if (deleteBranch) {
			args.push("--delete-branch");
		}
		await this.run(args);
	}

	async list(): Promise<WorktreeEntry[]> {
		const stdout = await this.run(["wt", "ls", "--json"]);
		return z.array(worktreeEntrySchema).parse(JSON.parse(stdout));
	}

	async reap(): Promise<number> {
		const stdout = await this.run(["wt", "reap"]);
		const match = /^Reaped ([0-9]+) worktrees?\.$/.exec(stdout);
		if (match?.[1] === undefined) {
			throw new Error(`unexpected deck wt reap output: ${stdout}`);
		}
		return z.coerce.number().int().nonnegative().parse(match[1]);
	}

	private async run(args: string[]): Promise<string> {
		const child = Bun.spawn([this.command, ...args], {
			cwd: this.cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) {
			throw new DeckWorktreeCommandError(args, exitCode, stderr.trim());
		}
		return stdout.trim();
	}
}
