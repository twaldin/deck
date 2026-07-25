import { z } from "zod";
import type { ShadowIssue } from "./firstmate.ts";

export interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export type CommandRunner = (command: readonly string[]) => Promise<CommandResult>;

const MAX_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;
const CommandOutputSchema = z.string().refine(
	(value) => Buffer.byteLength(value, "utf8") <= MAX_COMMAND_OUTPUT_BYTES,
	`command output exceeds ${MAX_COMMAND_OUTPUT_BYTES} UTF-8 bytes`,
);

const CommandResultSchema = z.object({
	stdout: CommandOutputSchema,
	stderr: CommandOutputSchema,
	exitCode: z.number().int(),
});

const CheckSchema = z
	.object({
		name: z.string().min(1).optional(),
		context: z.string().min(1).optional(),
		conclusion: z.string().nullable().optional(),
		status: z.string().min(1).nullable().optional(),
		state: z.string().min(1).nullable().optional(),
	})
	.passthrough()
	.superRefine((check, context) => {
		if (
			(check.conclusion ?? "") === "" &&
			(check.status ?? "") === "" &&
			(check.state ?? "") === ""
		) {
			context.addIssue({ code: "custom", message: "check has no conclusion, status, or state" });
		}
	});

const ReviewSchema = z
	.object({
		state: z.string().min(1),
		author: z.object({ login: z.string().min(1) }).nullable().optional(),
		submittedAt: z.string().min(1).nullable().optional(),
	})
	.passthrough();

const GhPrSchema = z.object({
	state: z.string().min(1),
	statusCheckRollup: z.array(CheckSchema),
	reviews: z.array(ReviewSchema),
	updatedAt: z.iso.datetime().transform((value) => Date.parse(value)),
	mergeStateStatus: z.string().min(1).nullable().optional(),
});

export const PrFactSchema = z.object({
	url: z.string().url(),
	state: z.string().min(1),
	checksRollup: z.enum(["passing", "failing", "pending", "none"]),
	failingChecks: z.array(z.string()),
	reviewDecision: z.string().optional(),
	updatedAtMs: z.number().finite().nonnegative(),
	mergeStateStatus: z.string().optional(),
});

export type PrFact = z.infer<typeof PrFactSchema>;

const FAILURE_STATES: Record<string, true> = {
	FAILURE: true,
	ERROR: true,
};

const PENDING_STATES: Record<string, true> = {
	PENDING: true,
	QUEUED: true,
	IN_PROGRESS: true,
};

const PASSING_STATES: Record<string, true> = {
	SUCCESS: true,
	NEUTRAL: true,
};

interface CommandOutputReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(reason?: unknown): Promise<void>;
	releaseLock(): void;
}

async function readCommandOutput(
	reader: CommandOutputReader,
	streamName: string,
): Promise<string> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const chunks: string[] = [];
	let bytesRead = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) {
				chunks.push(decoder.decode());
				return chunks.join("");
			}
			if (chunk.value === undefined) {
				throw new Error(`${streamName} returned a chunk without bytes`);
			}
			bytesRead += chunk.value.byteLength;
			if (bytesRead > MAX_COMMAND_OUTPUT_BYTES) {
				await reader.cancel(`${streamName} exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes`);
				throw new Error(`${streamName} exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes`);
			}
			chunks.push(decoder.decode(chunk.value, { stream: true }));
		}
	} finally {
		reader.releaseLock();
	}
}

export const defaultCommandRunner: CommandRunner = async (command) => {
	const child = Bun.spawn([...command], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdoutReader = child.stdout.getReader();
	const stderrReader = child.stderr.getReader();
	const completion = Promise.all([
		child.exited,
		readCommandOutput(stdoutReader, "gh stdout"),
		readCommandOutput(stderrReader, "gh stderr"),
	]).then(([exitCode, stdout, stderr]) =>
		CommandResultSchema.parse({ stdout, stderr, exitCode }),
	);
	const deadline = Promise.withResolvers<CommandResult>();
	const timer = setTimeout(() => {
		const timeout = new Error("gh pr view exceeded its 20 second deadline");
		try {
			child.kill("SIGKILL");
		} catch {
			// The child may have exited while an inherited output pipe remained open.
		}
		void stdoutReader.cancel(timeout).catch(() => undefined);
		void stderrReader.cancel(timeout).catch(() => undefined);
		deadline.reject(timeout);
	}, 20_000);
	try {
		return await Promise.race([completion, deadline.promise]);
	} catch (error) {
		try {
			child.kill("SIGKILL");
		} catch {
			// A completed child needs no cleanup.
		}
		void stdoutReader.cancel(error).catch(() => undefined);
		void stderrReader.cancel(error).catch(() => undefined);
		const reapDeadline = Promise.withResolvers<void>();
		const reapTimer = setTimeout(reapDeadline.resolve, 1_000);
		try {
			await Promise.race([child.exited.then(() => undefined), reapDeadline.promise]);
		} finally {
			clearTimeout(reapTimer);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
};

function checkState(check: z.infer<typeof CheckSchema>): string {
	return (check.conclusion || check.state || check.status || "").toUpperCase();
}

function deriveReviews(reviews: readonly z.infer<typeof ReviewSchema>[]): string | undefined {
	const latestByReviewer = new Map<string, string>();
	for (const [index, review] of reviews.entries()) {
		const reviewer = review.author?.login ?? `unknown-reviewer-${index}`;
		const state = review.state.toUpperCase();
		if (state === "APPROVED" || state === "CHANGES_REQUESTED") {
			latestByReviewer.set(reviewer, state);
		} else if (state === "DISMISSED") {
			latestByReviewer.delete(reviewer);
		}
	}
	const decisions = [...latestByReviewer.values()];
	if (decisions.includes("CHANGES_REQUESTED")) {
		return "CHANGES_REQUESTED";
	}
	if (decisions.includes("APPROVED")) {
		return "APPROVED";
	}
	return undefined;
}

export async function pollPr(
	url: string,
	run: CommandRunner = defaultCommandRunner,
	issues: ShadowIssue[] = [],
): Promise<PrFact | null> {
	const source = `github:${url}`;
	try {
		const rawResult = await run([
			"gh",
			"pr",
			"view",
			url,
			"--json",
			"state,statusCheckRollup,reviews,updatedAt,mergeStateStatus",
		]);
		const result = CommandResultSchema.parse(rawResult);
		if (result.exitCode !== 0) {
			throw new Error(`gh exited ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`);
		}
		const parsedJson: unknown = JSON.parse(result.stdout);
		const gh = GhPrSchema.parse(parsedJson);
		const states = gh.statusCheckRollup.map(checkState);
		const failingChecks = gh.statusCheckRollup
			.filter((check) => FAILURE_STATES[checkState(check)] === true)
			.map((check) => check.name ?? check.context ?? "unnamed check");
		let checksRollup: PrFact["checksRollup"];
		if (states.length === 0) {
			checksRollup = "none";
		} else if (states.some((state) => FAILURE_STATES[state] === true)) {
			checksRollup = "failing";
		} else if (states.some((state) => PENDING_STATES[state] === true)) {
			checksRollup = "pending";
		} else if (states.every((state) => PASSING_STATES[state] === true)) {
			checksRollup = "passing";
		} else {
			checksRollup = "pending";
		}
		return PrFactSchema.parse({
			url,
			state: gh.state.toUpperCase(),
			checksRollup,
			failingChecks,
			reviewDecision: deriveReviews(gh.reviews),
			updatedAtMs: gh.updatedAt,
			mergeStateStatus: gh.mergeStateStatus?.toUpperCase(),
		});
	} catch (error) {
		issues.push({
			source,
			message: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}
