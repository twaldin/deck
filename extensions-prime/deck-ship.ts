import { execFile } from "node:child_process";
import * as path from "node:path";
import { Type } from "typebox";
import { startShip, type ShipRequest, type ShipResult } from "../v2/src/ship";
import { SMITHERS_SPEC } from "../v2/src/smithers";
import { smithersWorkspaceCwd } from "../v2/src/workspace";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
};

type ToolContext = {
	ui?: { notify?: (message: string, type?: "warning") => void };
};

type ToolDefinition = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ToolContext,
	): Promise<ToolResult>;
};

export interface DeckShipApi {
	registerTool(tool: ToolDefinition): void;
}

export interface DeckShipDependencies {
	start(request: ShipRequest): Promise<ShipResult>;
	readStatus(args: string[], signal: AbortSignal | undefined): Promise<string>;
}

const text = (body: string, details: Record<string, unknown> = {}): ToolResult => ({
	content: [{ type: "text", text: body }],
	details,
});

const SHIP_PROPERTIES = {
	ticket: Type.String({ description: "Ticket / effort id; seeds the Smithers run id", minLength: 1 }),
	profile: Type.String({ description: "Project profile id (lindy, deck, ...)", minLength: 1 }),
	worktree: Type.String({ description: "Path to the task worktree", minLength: 1 }),
	branch: Type.String({ description: "Committed branch to ship", minLength: 1 }),
	title: Type.String({ description: "Brief title", minLength: 1 }),
	summary: Type.String({ description: "Brief summary", minLength: 1 }),
	acceptance: Type.Array(Type.String({ minLength: 1 }), {
		description: "Concrete, checkable brief acceptance criteria",
		minItems: 1,
	}),
	base: Type.Optional(Type.String({ description: "Base branch; profile default when omitted" })),
	break_signal: Type.Optional(Type.String({ description: "Fallout signal to watch after landing" })),
	kill_switch: Type.Optional(Type.String({ description: "Named kill-switch; omitted means none" })),
	blast_radius: Type.Optional(Type.String()),
	reviewers: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	deploy_evidence: Type.Optional(Type.String({ description: "Shell command that proves the deploy" })),
	run_id: Type.Optional(Type.String({ description: "Explicit Smithers run id" })),
	dry_run: Type.Optional(Type.Boolean({ description: "Simulate side effects; default false" })),
	skip_reviewer_request: Type.Optional(Type.Boolean()),
} as const;

function shipRequest(params: Record<string, unknown>, ctx: ToolContext, existingPr?: number): ShipRequest {
	return {
		ticket: params.ticket as string,
		profile: params.profile as string,
		worktree: path.resolve(params.worktree as string),
		branch: params.branch as string,
		title: params.title as string,
		summary: params.summary as string,
		acceptance: (params.acceptance as string[]) ?? [],
		...(params.base === undefined ? {} : { baseBranch: params.base as string }),
		...(params.break_signal === undefined ? {} : { breakSignal: params.break_signal as string }),
		...(params.kill_switch === undefined ? {} : { killSwitch: params.kill_switch as string }),
		...(params.blast_radius === undefined ? {} : { blastRadius: params.blast_radius as string }),
		...(params.reviewers === undefined ? {} : { reviewers: params.reviewers as string[] }),
		...(params.deploy_evidence === undefined ? {} : { deployEvidence: params.deploy_evidence as string }),
		...(params.run_id === undefined ? {} : { runId: params.run_id as string }),
		...(params.dry_run === true ? { dryRun: true } : {}),
		...(params.skip_reviewer_request === true ? { skipReviewerRequest: true } : {}),
		...(existingPr === undefined ? {} : { existingPr }),
		warningContext: ctx,
		warningFingerprints: new Set<string>(),
	};
}

function shipStarted(result: ShipResult, verb: "ship" | "adopt"): ToolResult {
	return text(
		`${verb} ${result.runId} started (pid ${result.pid}) — profile ${result.profile} (${result.pipeline})${result.dryRun ? " [DRY RUN]" : ""}\n` +
			`input: ${result.inputPath}\nlog: ${result.logPath}\n` +
			`watch from ${result.pipelineDir}: smithers ps; smithers why ${result.runId}\n` +
			"The detached pr-pipeline owns review, PR state, CI, approval and merge.",
		{ ...result },
	);
}

function defaultReadStatus(args: string[], signal: AbortSignal | undefined): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile(
		"bunx",
		[SMITHERS_SPEC, ...args, "--format", "json"],
		{
			cwd: smithersWorkspaceCwd(),
			timeout: 15_000,
			maxBuffer: 4_000_000,
			signal,
		},
		(error, stdout) => {
			if (error !== null) reject(error);
			else resolve(stdout);
		},
	);
	return promise;
}

const defaultDependencies: DeckShipDependencies = {
	start: (request) => startShip(request),
	readStatus: defaultReadStatus,
};

/** Register only factory dispatch, adoption and read-only Smithers state. */
export function registerDeckShip(
	agent: DeckShipApi,
	dependencies: DeckShipDependencies = defaultDependencies,
): void {
	agent.registerTool({
		name: "ship",
		label: "Ship",
		description:
			"Start the detached pr-pipeline for a validated effort brief. The pipeline owns review, PR creation, CI, approval and merge.",
		parameters: Type.Object(SHIP_PROPERTIES),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return shipStarted(await dependencies.start(shipRequest(params, ctx)), "ship");
		},
	});

	agent.registerTool({
		name: "adopt",
		label: "Adopt PR",
		description:
			"Adopt an existing PR into the same detached pr-pipeline. It never opens a second PR and still runs the pipeline's review and landing gates.",
		parameters: Type.Object({
			...SHIP_PROPERTIES,
			existing_pr: Type.Integer({ minimum: 1, description: "Existing GitHub PR number" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return shipStarted(
				await dependencies.start(shipRequest(params, ctx, params.existing_pr as number)),
				"adopt",
			);
		},
	});

	agent.registerTool({
		name: "status",
		label: "Factory Status",
		description: "Read Smithers' durable run state. This tool never resumes, retries, approves or mutates a run.",
		parameters: Type.Object({
			run_id: Type.Optional(
				Type.String({ description: "Smithers run id; omit to list runs", minLength: 1, maxLength: 200 }),
			),
		}),
		async execute(_id, params, signal) {
			const runId = params.run_id === undefined ? undefined : String(params.run_id).trim();
			if (runId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(runId)) {
				throw new Error("status run_id must be a Smithers run id, not an option or path");
			}
			const args = runId === undefined ? ["ps", "--all"] : ["inspect", runId];
			const output = (await dependencies.readStatus(args, signal)).trim();
			if (output === "") throw new Error("Smithers returned no run state");
			let state: unknown = output;
			try {
				state = JSON.parse(output);
			} catch {
				// Preserve diagnostics from a compatible CLI even if its human format changed.
			}
			return text(typeof state === "string" ? state : JSON.stringify(state, null, 2), {
				...(runId === undefined ? {} : { runId }),
				state,
			});
		},
	});
}

export default function deckShip(agent: DeckShipApi): void {
	registerDeckShip(agent);
}
