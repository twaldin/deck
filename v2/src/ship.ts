/**
 * Ship: the DEFAULT path from "effort ready" to "PR landed" for a profiled
 * project. It resolves the project's profile (config/projects.json) and starts
 * the pr-pipeline smithers workflow with profile-derived policy:
 *
 *   lindy-full -> adversarial review gate, push-pr, CI/review watch, durable
 *                 captain stamp park, MQ merge, landing + fallout evidence.
 *   yolo-ship  -> the SAME graph; the stamp park is skipped by the profile and
 *                 the merge fires on green. The adversarial review gate is NOT
 *                 skippable: push-pr renders only after local-review approves
 *                 (or a human approves the review-escalation park).
 *
 * Machine enforcement, not prompt hope: doctrine PR #26865 shipped without
 * adversarial review because a bare spawn opened the PR itself. Here the PR
 * open is a pipeline compute node behind the review gate, and spawn.ts refuses
 * bare ship spawns on profiled repos (see assertShipGoesThroughPipeline).
 */
import { spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { deckV2Home, stateDir } from "./home";
import { readMeta, updateMeta } from "./meta";
import { findProfile, type ProjectProfile } from "./projects";
import { SMITHERS_SPEC } from "./smithers";
import { smithersWorkspaceCwd, uiWarn, warnOnShadowWorkspace } from "./workspace";
import { claimWorktree, updateWorktreePid } from "./worktree-lock";

function pipelineWorkflowHash(dir: string): string {
	const hash = createHash("sha256");
	hash.update(fs.readFileSync(path.join(dir, "pipeline.tsx")));
	return hash.digest("hex");
}

export type ShipRequest = {
	/** Ticket / effort id; also seeds the smithers run id. */
	ticket: string;
	/** Profile id or repo name (config/projects.json). */
	profile: string;
	/** Absolute path to the task worktree (branch checked out). */
	worktree: string;
	branch: string;
	baseBranch?: string;
	title: string;
	summary: string;
	acceptance: string[];
	/** Fallout signal to watch after landing. */
	breakSignal?: string;
	/** Named kill-switch; omitted = explicit { kind: "none" }. */
	killSwitch?: string;
	blastRadius?: string;
	reviewers?: string[];
	/** Shell command that proves the deploy (done is evidence-gated). */
	deployEvidence?: string;
	skipReviewerRequest?: boolean;
	runId?: string;
	/** Simulate side effects. Default FALSE here: ship means ship. */
	dryRun?: boolean;
	/**
	 * Adopt an already-open PR: the pipeline skips greenfield implement only,
	 * runs local adversarial review, verifies the branch matches the PR head,
	 * seeds its PR record from gh (never creates a second PR), and enters the same
	 * continuous watch/ready/stamp loop as a normal ship.
	 */
	existingPr?: number;
	/** Extension UI seam for the shadow-workspace preflight. */
	warningContext?: { ui?: { notify?: (message: string, type?: "warning") => void } };
	warningFingerprints?: Set<string>;
};

/**
 * The pr-pipeline directory, resolved through the REAL location of this module
 * (the installed extension is a symlink farm; import.meta resolves against the
 * symlink). DECK_PIPELINE_DIR overrides for tests and odd layouts.
 */
export function pipelineDir(): string {
	const override = process.env.DECK_PIPELINE_DIR;
	if (override !== undefined) return override;
	const self = fs.realpathSync(fileURLToPath(import.meta.url));
	return path.resolve(
		path.dirname(self),
		"..",
		"..",
		"workflows",
		"pr-pipeline",
	);
}

/**
 * Map a ship request + its resolved profile onto the pipeline's input shape.
 * dryRun defaults FALSE: the pipeline's own default is dry-run (safe for a
 * bare `smithers up`), but `deck-v2 ship` is the ship command.
 */
export function buildPipelineInput(
	request: ShipRequest,
	profile: ProjectProfile,
): Record<string, unknown> {
	const input: Record<string, unknown> = {
		__smithersDurability: { entryWorkflowHash: pipelineWorkflowHash(pipelineDir()) },
		ticket: request.ticket,
		repo: profile.repo,
		worktree: request.worktree,
		branch: request.branch,
		profile: profile.id,
		models: profile.models,
		dryRun: request.dryRun === true,
		brief: {
			ticket: request.ticket,
			title: request.title,
			summary: request.summary,
			acceptanceCriteria: request.acceptance,
			decisionLedger: [],
			killSwitch:
				request.killSwitch === undefined
					? { kind: "none" }
					: { kind: "named", name: request.killSwitch },
			breakSignal:
				request.breakSignal ??
				"captain report + CI on the base branch after landing",
			...(request.blastRadius === undefined
				? {}
				: { blastRadius: request.blastRadius }),
			...(request.reviewers === undefined
				? {}
				: { suggestedReviewers: request.reviewers }),
		},
	};
	if (request.baseBranch !== undefined) input.baseBranch = request.baseBranch;
	if (request.existingPr !== undefined) input.existingPr = request.existingPr;
	// A yolo profile with no reviewers named would park every run at the
	// zero-candidates escalation; personal repos have no review bench, so the
	// skip is recorded explicitly unless reviewers are given.
	if (
		request.skipReviewerRequest === true ||
		(profile.yolo && (request.reviewers === undefined || request.reviewers.length === 0))
	) {
		input.github = { skipReviewerRequest: true };
	}
	// Done is evidence-gated. For a yolo repo with no deploy step, landing on
	// the base branch IS the deploy, so a git-log probe is honest evidence.
	// A stamp profile (lindy) has REAL deploys: no weak default there — the
	// pipeline's preflight fails closed until explicit evidence is configured.
	if (request.dryRun !== true && profile.yolo) {
		const commands: Record<string, string> = { test: profile.testCommand ?? "bun test" };
		if (request.deployEvidence !== undefined) {
			commands.deployEvidence = request.deployEvidence;
		} else if (request.existingPr !== undefined) {
			commands.deployEvidence = "printf 'adopted existing PR landing is the deploy evidence\\n'";
		} else {
			const base = request.baseBranch ?? "main";
			commands.deployEvidence = `git fetch origin ${base} && git log -1 --oneline origin/${base}`;
		}
		input.commands = commands;
	} else if (request.dryRun !== true && (request.deployEvidence !== undefined || request.existingPr !== undefined)) {
		input.commands = {
			test: profile.testCommand ?? "bun test",
			deployEvidence: request.deployEvidence ?? "printf 'adopted existing PR landing is the deploy evidence\\n'",
		};
	}
	return input;
}

export type ShipResult = {
	runId: string;
	pid: number;
	profile: string;
	pipeline: string;
	dryRun: boolean;
	inputPath: string;
	logPath: string;
	pipelineDir: string;
};

/**
 * Start the pipeline run, detached. The run is durable smithers state: watch it
 * with `smithers ps|why|inspect <runId>` from the pipeline directory; a stamp
 * park resumes with `smithers approve` + `up --resume true`.
 *
 * Async: child startup errors are emitted asynchronously, so a sync return
 * would report "started" for a process that never launched.
 */
export async function startShip(
	request: ShipRequest,
	home = deckV2Home(),
	spawn = spawnProcess,
): Promise<ShipResult> {
	const profile = findProfile(request.profile, home);
	if (profile === null) {
		throw new Error(
			`unknown project profile "${request.profile}": add it to config/projects.json (deck home) first`,
		);
	}
	if (
		request.existingPr !== undefined &&
		(!Number.isInteger(request.existingPr) || request.existingPr <= 0)
	) {
		throw new Error(
			`existingPr must be a positive PR number, got ${request.existingPr}`,
		);
	}
	if (request.acceptance.length === 0) {
		throw new Error(
			"ship needs at least one acceptance criterion (preflight fails closed without them)",
		);
	}
	const dir = pipelineDir();
	const workspaceCwd = smithersWorkspaceCwd(home);
	warnOnShadowWorkspace(
		home,
		request.warningContext === undefined
			? undefined
			: (message) => uiWarn(request.warningContext, message),
		request.warningFingerprints,
	);
	if (!fs.existsSync(path.join(dir, "pipeline.tsx"))) {
		throw new Error(
			`pr-pipeline not found at ${dir} (set DECK_PIPELINE_DIR if the layout differs)`,
		);
	}
	const runId =
		request.runId ??
		`${request.ticket.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-pipeline`;
	let releaseWorktreeLock: (() => void) | undefined;
	const input = buildPipelineInput(request, profile);
	// Keep the task-to-workflow join durable when the caller already created a
	// deck task with the ticket id. Smithers ps does not expose a unique worktree.
	try {
		updateMeta(request.ticket, { run_id: runId, worktree: request.worktree, kind: "ship" });
	} catch {
		// A ticket is not always a valid deck task id. The ship input remains the
		// durable fallback used by the observer.
	}

	const shipDir = path.join(stateDir(), "ship");
	fs.mkdirSync(shipDir, { recursive: true, mode: 0o700 });
	const inputPath = path.join(shipDir, `${runId}.input.json`);
	const logPath = path.join(shipDir, `${runId}.log`);
	fs.writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, {
		mode: 0o600,
	});

	const log = fs.openSync(logPath, "a");
	let child: ReturnType<typeof spawn>;
	// Child startup errors arrive asynchronously; without this wait, a launch
	// that never happened (bunx missing, spawn EPERM) would still print
	// "started" — a silent false positive on the default ship path.
	try {
		releaseWorktreeLock = claimWorktree(request.worktree, runId, process.pid, true);
		child = spawn(
			"bunx",
			[
				SMITHERS_SPEC,
				"up",
				path.join(dir, "pipeline.tsx"),
				"--input",
				JSON.stringify(input),
				"--run-id",
				runId,
			],
			{
				cwd: workspaceCwd,
				detached: true,
				stdio: ["ignore", log, log],
				env: { ...process.env },
			},
		);
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", () => resolve());
			child.once("error", (error) =>
				reject(
					new Error(
						`could not start the pipeline run (${error.message}); see ${logPath}`,
					),
				),
			);
		});
	} catch (error) {
		releaseWorktreeLock?.();
		throw error;
	} finally {
		fs.closeSync(log);
	}
	if (child.pid !== undefined) updateWorktreePid(request.worktree, runId, child.pid);
	// The Smithers run can park after this launcher exits. The observer releases
	// the lock only when the durable run reaches a terminal state.
	child.unref();

	return {
		runId,
		pid: child.pid ?? -1,
		profile: profile.id,
		pipeline: profile.pipeline,
		dryRun: input.dryRun === true,
		inputPath,
		logPath,
		pipelineDir: dir,
	};
}
