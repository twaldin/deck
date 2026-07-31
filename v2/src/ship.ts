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
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { deckV2Home, stateDir } from "./home";
import { findProfile, type ProjectProfile } from "./projects";
import { SMITHERS_SPEC } from "./smithers";

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
	runId?: string;
	/** Simulate side effects. Default FALSE here: ship means ship. */
	dryRun?: boolean;
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
	return path.resolve(path.dirname(self), "..", "..", "workflows", "pr-pipeline");
}

/**
 * Map a ship request + its resolved profile onto the pipeline's input shape.
 * dryRun defaults FALSE: the pipeline's own default is dry-run (safe for a
 * bare `smithers up`), but `deck-v2 ship` is the ship command.
 */
export function buildPipelineInput(request: ShipRequest, profile: ProjectProfile): Record<string, unknown> {
	const input: Record<string, unknown> = {
		ticket: request.ticket,
		repo: profile.repo,
		worktree: request.worktree,
		branch: request.branch,
		profile: profile.id,
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
				request.breakSignal ?? "captain report + CI on the base branch after landing",
			...(request.blastRadius === undefined ? {} : { blastRadius: request.blastRadius }),
			...(request.reviewers === undefined ? {} : { suggestedReviewers: request.reviewers }),
		},
	};
	if (request.baseBranch !== undefined) input.baseBranch = request.baseBranch;
	// A yolo profile with no reviewers named would park every run at the
	// zero-candidates escalation; personal repos have no review bench, so the
	// skip is recorded explicitly unless reviewers are given.
	if (profile.yolo && (request.reviewers === undefined || request.reviewers.length === 0)) {
		input.github = { skipReviewerRequest: true };
	}
	// Done is evidence-gated. For a yolo repo with no deploy step, landing on
	// the base branch IS the deploy, so a git-log probe is honest evidence.
	// A stamp profile (lindy) has REAL deploys: no weak default there — the
	// pipeline's preflight fails closed until explicit evidence is configured.
	if (request.deployEvidence !== undefined) {
		input.commands = { deployEvidence: request.deployEvidence };
	} else if (request.dryRun !== true && profile.yolo) {
		const base = request.baseBranch ?? "main";
		input.commands = {
			deployEvidence: `git fetch origin ${base} && git log -1 --oneline origin/${base}`,
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
 */
export function startShip(request: ShipRequest, home = deckV2Home()): ShipResult {
	const profile = findProfile(request.profile, home);
	if (profile === null) {
		throw new Error(
			`unknown project profile "${request.profile}": add it to config/projects.json (deck home) first`,
		);
	}
	if (request.acceptance.length === 0) {
		throw new Error("ship needs at least one acceptance criterion (preflight fails closed without them)");
	}
	const dir = pipelineDir();
	if (!fs.existsSync(path.join(dir, "pipeline.tsx"))) {
		throw new Error(`pr-pipeline not found at ${dir} (set DECK_PIPELINE_DIR if the layout differs)`);
	}
	const runId =
		request.runId ?? `${request.ticket.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-pipeline`;
	const input = buildPipelineInput(request, profile);

	const shipDir = path.join(stateDir(), "ship");
	fs.mkdirSync(shipDir, { recursive: true, mode: 0o700 });
	const inputPath = path.join(shipDir, `${runId}.input.json`);
	const logPath = path.join(shipDir, `${runId}.log`);
	fs.writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });

	const log = fs.openSync(logPath, "a");
	const [cmd, ...spec] = ["bunx", SMITHERS_SPEC];
	const child = spawnProcess(
		cmd as string,
		[...spec, "up", "pipeline.tsx", "--input", JSON.stringify(input), "--run-id", runId],
		{
			cwd: dir,
			detached: true,
			stdio: ["ignore", log, log],
			env: { ...process.env },
		},
	);
	child.on("error", () => {});
	child.unref();
	fs.closeSync(log);

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
