/** @jsxImportSource smithers-orchestrator */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderWorkflow } from "smithers-orchestrator/testing";

import pipeline, { buildApprovalStampMetadata, mergePathSchema, schemas } from "../pipeline.tsx";
import {
	falloutPrompt,
	implementPrompt,
	localFixPrompt,
	localReviewPrompt,
	standingRulesDigest,
	watchFixPrompt,
} from "../lib/prompts.ts";
import type { OutputRows, PipelineOutputFixtures } from "./output-fixtures.ts";

const validBrief = {
	ticket: "LIN-123",
	title: "Harden merge authorization",
	summary: "Bind merge authority to the approved commit",
	acceptanceCriteria: ["A moved head cannot enter the merge queue"],
	decisionLedger: [],
	killSwitch: { kind: "named" as const, name: "disable pipeline" },
	breakSignal: "merge queue rejection",
};

const baseInput = {
	ticket: "LIN-123",
	repo: "lindy-ai/lindy",
	worktree: "/tmp/lindy-wt",
	branch: "fm/lin-123",
	brief: validBrief,
	dryRun: false,
	wakeDryRun: true,
};
const originalDeckHome = process.env.DECK_V2_HOME;

const tempRoots: string[] = [];
const originalHome = process.env.HOME;
const originalDevWorkspaceOverride = process.env.DECK_DEV_WORKSPACE_OK;

beforeEach(() => {
	process.env.DECK_DEV_WORKSPACE_OK = "1";
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalDeckHome === undefined) delete process.env.DECK_V2_HOME;
	else process.env.DECK_V2_HOME = originalDeckHome;
	if (originalDevWorkspaceOverride === undefined) delete process.env.DECK_DEV_WORKSPACE_OK;
	else process.env.DECK_DEV_WORKSPACE_OK = originalDevWorkspaceOverride;
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type ApprovalReadyOutputFixtures = {
	[K in
		| "preflight"
		| "implementation"
		| "localReview"
		| "prRecord"
		| "reviewerRequest"
		| "watchPoll"
		| "readyPoll"]: OutputRows<K>;
};


function approvalReadyOutputs(baseBranch = "main", prNumber = 42): ApprovalReadyOutputFixtures {
	return {
		preflight: [
			{
				nodeId: "preflight",
				ok: true,
				openQuestions: [],
				briefDigest: "",
				resolvedReviewerModel: "deck/claude-fable-5",
			},
		],
		implementation: [
			{
				nodeId: "implement",
				commits: ["abc"],
				summary: "done",
				testEvidence: "green",
			},
		],
		localReview: [
			{
				nodeId: "local-review",
				round: 0,
				approved: true,
				blockingFindings: [],
				nits: [],
				summary: "approved",
			},
		],
		prRecord: [
			{
				nodeId: "push-pr",
				prNumber,
				url: `https://github.com/lindy-ai/lindy/pull/${prNumber}`,
				headSha: "abc123",
				baseBranch,
				watchSetRegistered: true,
				watchSetPath: "",
				receipt: "",
				createdAt: "2026-08-01T00:00:00.000Z",
			},
		],
		reviewerRequest: [
			{
				nodeId: "request-reviewers",
				skipped: false,
				requested: ["reviewer"],
				verified: ["reviewer"],
				source: "test",
				at: "2026-08-01T00:00:00.000Z",
				reviewerPrompt: "",
			},
		],
		watchPoll: [
			{
				nodeId: "r0-watch-poll",
				round: 0,
				poll: 0,
				headSha: "abc123",
				exitOk: true,
				disposition: "complete",
				actionable: false,
				ci: "green",
				unresolvedThreads: 0,
				unansweredComments: 0,
				reviewersToReRequest: [],
				reasons: [],
				rebaseRequired: false,
			},
		],
		readyPoll: [
			{
				nodeId: "r0-ready-poll",
				round: 0,
				poll: 0,
				ready: true,
				regressed: false,
				approvedBy: "reviewer",
				ci: "green",
				headSha: "abc123",
				reasons: [],
				migrationDetected: false,
				migrationFiles: [],
				at: "2026-08-01T00:00:00.000Z",
			},
		],
	};
}

function runGit(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync({
		cmd: ["git", ...args],
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed (${result.exitCode}): ${Buffer.from(result.stderr).toString("utf8")}`,
		);
	}
	return Buffer.from(result.stdout).toString("utf8").trim();
}

function commitFixtureFile(repo: string, file: string, content: string, message: string): string {
	fs.writeFileSync(path.join(repo, file), content);
	runGit(repo, "add", "--", file);
	runGit(repo, "commit", "--only", "-m", message, "--", file);
	return runGit(repo, "rev-parse", "HEAD");
}

function createImplementationRepo(root: string, publishPreexistingCommit: boolean): {
	repo: string;
	remoteBaseSha: string;
	preexistingSha: string;
} {
	const repo = path.join(root, "repo");
	const remote = path.join(root, "remote.git");
	fs.mkdirSync(repo, { recursive: true });
	runGit(root, "init", "--bare", remote);
	runGit(repo, "init", "--initial-branch=main");
	runGit(repo, "config", "user.name", "Deck Test");
	runGit(repo, "config", "user.email", "deck-test@example.com");
	runGit(repo, "config", "commit.gpgsign", "false");
	const remoteBaseSha = commitFixtureFile(repo, "base.txt", "base\n", "base");
	runGit(repo, "remote", "add", "origin", remote);
	runGit(repo, "push", "-u", "origin", "main");
	const preexistingSha = commitFixtureFile(repo, "unrelated.txt", "unrelated\n", "unrelated local work");
	if (publishPreexistingCommit) runGit(repo, "push", "origin", "main");
	runGit(repo, "switch", "-c", baseInput.branch);
	return { repo, remoteBaseSha, preexistingSha };
}

async function captureImplementationBaseline(input: typeof baseInput & {
	worktree: string;
	github: { git: string; gh: string };
	watchSetPath: string;
}) {
	const preflight = approvalReadyOutputs().preflight;
	const rendered = await renderWorkflow(pipeline, {
		input,
		outputs: { preflight } satisfies PipelineOutputFixtures,
		workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
	});
	const task = rendered.tasks.find((candidate) => candidate.nodeId === "implement-baseline");
	if (task?.computeFn === undefined) throw new Error("implement-baseline did not render");
	return schemas.implementationBaseline.parse(await task.computeFn());
}

async function computeImplementationReport(
	input: typeof baseInput & {
		worktree: string;
		github: { git: string; gh: string };
		watchSetPath: string;
	},
	baseline: { branch: string; headSha: string },
) {
	const ready = approvalReadyOutputs();
	const rendered = await renderWorkflow(pipeline, {
		input,
		outputs: {
			preflight: ready.preflight,
			implementationBaseline: [{ nodeId: "implement-baseline", ...baseline }],
			implementationSeat: [{
				nodeId: "implement-seat",
				summary: "implemented the focused change",
				testEvidence: "focused test passed",
			}],
			localReview: ready.localReview,
		} satisfies PipelineOutputFixtures,
		workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
	});
	const task = rendered.tasks.find((candidate) => candidate.nodeId === "implement");
	if (task?.computeFn === undefined) throw new Error("deterministic implement report did not render");
	return schemas.implementation.parse(await task.computeFn());
}

describe("standing-rules seat injection", () => {
	test("prepends the byte-bounded committed fallback to all five seat prompts", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "deck-standing-fallback-"));
		tempRoots.push(home);
		process.env.HOME = home;
		const prompts = [
			implementPrompt(validBrief, "/tmp/wt", "feature"),
			localReviewPrompt(validBrief, "/tmp/wt", "main", 1),
			localFixPrompt(["fix it"], "/tmp/wt", 1),
			watchFixPrompt({
				worktree: "/tmp/wt",
				branch: "feature",
				baseBranch: "main",
				repo: "lindy-ai/lindy",
				prNumber: 42,
				gh: "gh",
				pollJson: "{}",
				round: 0,
				afterPoll: 0,
			}),
			falloutPrompt({
				breakSignal: "signal",
				killSwitch: "switch",
				repo: "lindy-ai/lindy",
				prNumber: 42,
				landedSha: "abc",
				windowStart: "start",
				windowEnd: "end",
				probes: [],
			}),
		];
		for (const prompt of prompts) {
			expect(prompt.startsWith("--- STANDING-RULES")).toBe(true);
			expect(prompt).toContain("The \"make PR\" flow");
			expect(prompt).toContain(
				"Never run OptMem from a workflow seat or RLM child. Route decisions through the workflow's question result.",
			);
			expect(prompt).toContain("[CHAT SESSION] **Precedence:**");
			expect(prompt).toContain("Use Prime's native `rlm()` for bounded delegation when the seat is Prime.");
			expect(prompt).toContain("deck/gpt-5.6-luna at xhigh");
			expect(prompt).toContain("deck/claude-fable-5 at high");
			expect(prompt).toContain("A non-Prime seat has no delegation primitive");
			expect(prompt).toContain("OUTPUT-FACING BOUNDARY:");
			expect(prompt).toContain(
				"Internal paths, worktrees, workflow node names, run or task ids, model labels, and workflow or factory vocabulary are tool-context ONLY.",
			);
			expect(prompt).toContain(
				"PR text, comments, review replies, and queued question text must never expose that tool context.",
			);
		}
		expect(Buffer.byteLength(standingRulesDigest(), "utf8")).toBeLessThanOrEqual(8 * 1024);
	});

	test("leaves commit attribution to the deterministic workflow report", () => {
		const prompt = implementPrompt(validBrief, "/tmp/wt", "feature");
		expect(prompt).toContain('"summary":"Implemented the brief."');
		expect(prompt).not.toContain('"commits"');
	});

	test("labels every committed standing-rule obligation by actor", () => {
		const fallback = fs.readFileSync(new URL("../seed/standing-rules.md", import.meta.url), "utf8");
		const ruleBullets = fallback.split("\n").filter((line) => line.startsWith("- "));
		expect(ruleBullets.length).toBeGreaterThan(0);
		for (const rule of ruleBullets) {
			expect(rule).toMatch(/^- \[(?:CHAT SESSION|WORKFLOW SEAT)\]/);
		}
		expect(fallback).toContain(
			"[CHAT SESSION] **Precedence:** the Prime conversation discharges build,",
		);
		expect(fallback).toContain(
			"[WORKFLOW SEAT] Execute the delivery middle: implement in a worktree,",
		);
	});

	test("re-reads the live standing rules for every prompt build", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "deck-standing-live-"));
		tempRoots.push(home);
		process.env.HOME = home;
		const live = path.join(home, ".deck", "data", "ref", "distill", "STANDING-RULES.md");
		fs.mkdirSync(path.dirname(live), { recursive: true });
		fs.writeFileSync(live, "live doctrine alpha\n");
		expect(implementPrompt(validBrief, "/tmp/wt", "feature")).toContain("live doctrine alpha");
		expect(implementPrompt(validBrief, "/tmp/wt", "feature")).toContain(
			"ACTOR BOUNDARY (binding even when live standing rules predate actor labels)",
		);
		expect(implementPrompt(validBrief, "/tmp/wt", "feature")).toContain(
			"[CHAT SESSION] Discharge build, review, and deploy obligations only through ship, adopt, status, and queued questions",
		);
		expect(implementPrompt(validBrief, "/tmp/wt", "feature")).toContain(
			"Never run OptMem from a workflow seat or RLM child. Route decisions through the workflow's question result.",
		);
		fs.writeFileSync(live, "live doctrine beta\n");
		expect(implementPrompt(validBrief, "/tmp/wt", "feature")).toContain("live doctrine beta");
	});

	test("selects whole priority sections and names omitted sections when the live rules exceed budget", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "deck-standing-curated-"));
		tempRoots.push(home);
		process.env.HOME = home;
		const live = path.join(home, ".deck", "data", "ref", "distill", "STANDING-RULES.md");
		fs.mkdirSync(path.dirname(live), { recursive: true });
		fs.writeFileSync(
			live,
			[
				"## 12. Auth doctrine",
				`OMITTED-RULE-START ${"x".repeat(10_000)} OMITTED-RULE-END`,
				'## 1. The "make PR" flow (captain\'s target, binding)',
				"PRIORITY-RULE-COMPLETE",
			].join("\n"),
		);

		const digest = standingRulesDigest();
		expect(digest).toContain("PRIORITY-RULE-COMPLETE");
		expect(digest).toContain("TRUNCATED");
		expect(digest).toContain("Omitted sections: 12. Auth doctrine.");
		expect(digest).toContain("no rule was cut mid-rule");
		expect(digest).not.toContain("OMITTED-RULE-START");
		expect(digest).not.toContain("OMITTED-RULE-END");
	});

	test("bounds the truncation marker when omitted section names are numerous and long", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "deck-standing-marker-"));
		tempRoots.push(home);
		process.env.HOME = home;
		const live = path.join(home, ".deck", "data", "ref", "distill", "STANDING-RULES.md");
		fs.mkdirSync(path.dirname(live), { recursive: true });
		fs.writeFileSync(
			live,
			Array.from(
				{ length: 200 },
				(_, index) =>
					`## ${100 + index}. ${"long-section-name-".repeat(10)}${index}\ncomplete rule ${index}`,
			).join("\n"),
		);

		const digest = standingRulesDigest();
		expect(Buffer.byteLength(digest, "utf8")).toBeLessThanOrEqual(8 * 1024);
		expect(digest).toContain("TRUNCATED");
		expect(digest).toContain("additional omitted section(s)");
	});

	test("forbids raw watcher pushes and removes the manual git escape hatch", () => {
		const prompt = watchFixPrompt({
			worktree: "/tmp/wt",
			branch: "feature",
			baseBranch: "main",
			repo: "lindy-ai/lindy",
			prNumber: 42,
			gh: "gh",
			pollJson: '{"unresolvedThreads":1}',
			round: 0,
			afterPoll: 0,
		});
		expect(prompt).toContain("Return every commit you created as a full");
		expect(prompt).toContain("Pushes outside rebaseAndPush() are forbidden");
		expect(prompt).toContain("Never run git push");
		expect(prompt).toContain("Resolve the thread only after a plain commit on THIS branch addresses it");
		expect(prompt).toContain("reviewer/captain agreement to the no-code disposition");
		expect(prompt).toContain("Never infer agreement from silence");
		expect(prompt).toContain(
			"DECISION-CLASS BLOCKER: thread=<stable thread id or URL> | decision=<missing decision>",
		);
		expect(prompt).toContain("<REVIEW_COMMENT_ID>");
		expect(prompt).toContain("numeric `databaseId`");
		expect(prompt).toContain("Never run the review-reply template with the placeholder or with comment id 0");
		expect(prompt).not.toContain("post-review-reply.ts '' 'lindy-ai/lindy' 0");
		expect(prompt).toContain("Shape-only blocker result example");
		expect(prompt).toContain("An empty actions array is invalid");
		expect(prompt).not.toContain('"actions":[],"commits":[],"pushed":false,"reRequested":[],"summary":"No action required."');
		expect(prompt).not.toContain("If the helper is unavailable");
	});
	test("routes watch publication through a deterministic node and rejects a direct-push receipt", async () => {
		const deckHome = fs.mkdtempSync(path.join(os.tmpdir(), "deck-watch-publish-"));
		tempRoots.push(deckHome);
		process.env.DECK_V2_HOME = deckHome;
		const outputs = approvalReadyOutputs();
		outputs.watchPoll = [
			{
				nodeId: "r0-watch-poll",
				round: 0,
				poll: 0,
				headSha: "abc123",
				exitOk: false,
				disposition: "fix",
				actionable: true,
				ci: "red",
				unresolvedThreads: 1,
				unansweredComments: 0,
				reviewersToReRequest: ["reviewer"],
				reasons: ["feedback"],
				rebaseRequired: false,
			},
		];
		const guardedOutputs = {
			...outputs,
			watchBaseline: [
				{
					nodeId: "r0-watch-baseline",
					round: 0,
					afterPoll: 0,
					headSha: "abc123",
					valid: true,
					reason: "trusted",
				},
			],
			watchFix: [
				{
					nodeId: "r0-watch-fix",
					round: 0,
					afterPoll: 0,
					actions: ["git push"],
					commits: [],
					pushed: true,
					reRequested: [],
					summary: "violated boundary",
				},
			],
		} satisfies PipelineOutputFixtures;
		const rendered = await renderWorkflow(pipeline, {
			input: baseInput,
			outputs: guardedOutputs,
			workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
		});
		const publish = rendered.tasks.find((task) => task.nodeId === "r0-watch-publish");
		expect(publish).toBeDefined();
		await expect(publish?.computeFn?.()).rejects.toThrow(
			/direct push or reviewer re-request/,
		);
	});
	test("rejects an unreported commit added after the trusted watch baseline", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-watch-unreported-"));
		tempRoots.push(dir);
		process.env.DECK_V2_HOME = path.join(dir, "home");
		const git = path.join(dir, "git");
		const gh = path.join(dir, "gh");
		const foreignSha = "f".repeat(40);
		fs.writeFileSync(
			git,
			`#!/bin/sh\nif [ "$1" = "merge-base" ]; then exit 0; fi\nif [ "$1" = "rev-list" ]; then printf '%s\\n' '${foreignSha}'; exit 0; fi\nexit 0\n`,
		);
		fs.writeFileSync(gh, "#!/bin/sh\nprintf 'abc123\\n'\n");
		fs.chmodSync(git, 0o755);
		fs.chmodSync(gh, 0o755);
		const outputs = approvalReadyOutputs();
		outputs.watchPoll = [
			{
				nodeId: "r0-watch-poll",
				round: 0,
				poll: 0,
				headSha: "abc123",
				exitOk: false,
				disposition: "fix",
				actionable: true,
				ci: "red",
				unresolvedThreads: 1,
				unansweredComments: 0,
				reviewersToReRequest: [],
				reasons: ["feedback"],
				rebaseRequired: false,
			},
		];
		const rendered = await renderWorkflow(pipeline, {
			input: { ...baseInput, worktree: dir, github: { git, gh } },
			outputs: {
				...outputs,
				watchBaseline: [
					{
						nodeId: "r0-watch-baseline",
						round: 0,
						afterPoll: 0,
						headSha: "abc123",
						valid: true,
						reason: "trusted",
					},
				],
				watchFix: [
					{
						nodeId: "r0-watch-fix",
						round: 0,
						afterPoll: 0,
						actions: ["fixed feedback"],
						commits: [],
						pushed: false,
						reRequested: [],
						summary: "omitted a commit",
					},
				],
			} satisfies PipelineOutputFixtures,
			workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
		});
		const publish = rendered.tasks.find((task) => task.nodeId === "r0-watch-publish");
		await expect(publish?.computeFn?.()).rejects.toThrow(
			/refusing to allowlist or push unreported local commits/,
		);
	});
	test("re-requests eligible reviewers even when feedback produced no local commit", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-watch-rerequest-"));
		tempRoots.push(dir);
		process.env.DECK_V2_HOME = path.join(dir, "home");
		const log = path.join(dir, "commands.log");
		const git = path.join(dir, "git");
		const gh = path.join(dir, "gh");
		fs.writeFileSync(
			git,
			"#!/bin/sh\nif [ \"$1\" = \"merge-base\" ]; then exit 0; fi\nif [ \"$1\" = \"rev-list\" ]; then exit 0; fi\nexit 0\n",
		);
		fs.writeFileSync(
			gh,
			`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nprintf 'abc123\\n'\n`,
		);
		fs.chmodSync(git, 0o755);
		fs.chmodSync(gh, 0o755);
		const outputs = approvalReadyOutputs();
		outputs.watchPoll = [
			{
				nodeId: "r0-watch-poll",
				round: 0,
				poll: 0,
				headSha: "abc123",
				exitOk: false,
				disposition: "fix",
				actionable: true,
				ci: "red",
				unresolvedThreads: 1,
				unansweredComments: 0,
				reviewersToReRequest: ["reviewer"],
				reasons: ["feedback"],
				rebaseRequired: false,
			},
		];
		const rendered = await renderWorkflow(pipeline, {
			input: { ...baseInput, worktree: dir, github: { git, gh } },
			outputs: {
				...outputs,
				watchBaseline: [
					{
						nodeId: "r0-watch-baseline",
						round: 0,
						afterPoll: 0,
						headSha: "abc123",
						valid: true,
						reason: "trusted",
					},
				],
				watchFix: [
					{
						nodeId: "r0-watch-fix",
						round: 0,
						afterPoll: 0,
						actions: ["resolved feedback"],
						commits: [],
						pushed: false,
						reRequested: [],
						summary: "no code change",
					},
				],
			} satisfies PipelineOutputFixtures,
			workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
		});
		const publish = rendered.tasks.find((task) => task.nodeId === "r0-watch-publish");
		const receipt = schemas.watchPublish.parse(await publish?.computeFn?.());
		expect(receipt).toMatchObject({
			pushed: false,
			reRequested: ["reviewer"],
		});
		expect(fs.readFileSync(log, "utf8")).toContain("requested_reviewers");
	});
	test("reports only the commit added after the persisted seat baseline and allows honest initial publication", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-implementation-honest-"));
		tempRoots.push(dir);
		process.env.DECK_V2_HOME = path.join(dir, "home");
		const fixture = createImplementationRepo(dir, true);
		const gh = path.join(dir, "gh");
		const watchSetPath = path.join(dir, "watch-set.jsonl");
		const input = {
			...baseInput,
			worktree: fixture.repo,
			github: { git: "git", gh },
			watchSetPath,
		};
		const baseline = await captureImplementationBaseline(input);
		expect(baseline).toEqual({
			branch: baseInput.branch,
			headSha: fixture.preexistingSha,
		});
		const seatSha = commitFixtureFile(
			fixture.repo,
			"focused.txt",
			"focused observer debounce\n",
			"focused implementation",
		);
		const report = await computeImplementationReport(input, baseline);
		expect(report).toMatchObject({
			commits: [seatSha],
			baselineHeadSha: fixture.preexistingSha,
		});

		fs.writeFileSync(
			gh,
			`#!/bin/sh
case "$1:$2" in
  pr:list) printf '[]\\n' ;;
  pr:create) printf 'https://github.com/lindy-ai/lindy/pull/101\\n' ;;
  api:*) printf '%s\\n' '${seatSha}' ;;
  *) exit 64 ;;
esac
`,
		);
		fs.chmodSync(gh, 0o755);
		const ready = approvalReadyOutputs();
		const rendered = await renderWorkflow(pipeline, {
			input,
			outputs: {
				preflight: ready.preflight,
				implementation: [{ nodeId: "implement", ...report }],
				localReview: ready.localReview,
			} satisfies PipelineOutputFixtures,
			workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
		});
		const push = rendered.tasks.find((task) => task.nodeId === "push-pr");
		if (push?.computeFn === undefined) throw new Error("push-pr did not render");
		const receipt = schemas.prRecord.parse(await push.computeFn());
		expect(receipt).toMatchObject({
			prNumber: 101,
			headSha: seatSha,
			receipt: `pushed ${baseInput.branch}; PR #101`,
		});
		expect(fs.readFileSync(watchSetPath, "utf8")).toContain('"pr":101');
	});

	test("waits for local review and includes implementer fix commits in the final report", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-implementation-review-fix-"));
		tempRoots.push(dir);
		process.env.DECK_V2_HOME = path.join(dir, "home");
		const fixture = createImplementationRepo(dir, true);
		const input = {
			...baseInput,
			worktree: fixture.repo,
			github: { git: "git", gh: "gh" },
			watchSetPath: path.join(dir, "watch-set.jsonl"),
		};
		const baseline = await captureImplementationBaseline(input);
		const seatSha = commitFixtureFile(
			fixture.repo,
			"focused.txt",
			"focused change\n",
			"focused implementation",
		);
		const ready = approvalReadyOutputs();
		const beforeReview = await renderWorkflow(pipeline, {
			input,
			outputs: {
				preflight: ready.preflight,
				implementationBaseline: [{ nodeId: "implement-baseline", ...baseline }],
				implementationSeat: [{
					nodeId: "implement-seat",
					summary: "implemented the focused change",
					testEvidence: "focused test passed",
				}],
			} satisfies PipelineOutputFixtures,
			workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
		});
		expect(beforeReview.tasks.find((task) => task.nodeId === "implement")).toBeUndefined();
		const fixSha = commitFixtureFile(
			fixture.repo,
			"review-fix.txt",
			"review fix\n",
			"address local review",
		);

		const report = await computeImplementationReport(input, baseline);

		expect(report.commits).toEqual([seatSha, fixSha]);
	});

	test("derives the report from the captured local base when a new origin/main has unrelated history", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-implementation-new-remote-"));
		tempRoots.push(dir);
		process.env.DECK_V2_HOME = path.join(dir, "home");
		const fixture = createImplementationRepo(dir, true);
		const input = {
			...baseInput,
			worktree: fixture.repo,
			github: { git: "git", gh: "gh" },
			watchSetPath: path.join(dir, "watch-set.jsonl"),
		};
		const tree = runGit(fixture.repo, "write-tree");
		const unrelatedRemoteHead = runGit(
			fixture.repo,
			"commit-tree",
			tree,
			"-m",
			"new remote root",
		);
		runGit(
			fixture.repo,
			"update-ref",
			"refs/remotes/origin/main",
			unrelatedRemoteHead,
		);
		const baseline = await captureImplementationBaseline(input);
		expect(baseline.headSha).toBe(fixture.preexistingSha);
		expect(baseline.headSha).not.toBe(unrelatedRemoteHead);
		const seatSha = commitFixtureFile(
			fixture.repo,
			"focused.txt",
			"focused change\n",
			"focused implementation",
		);

		const report = await computeImplementationReport(input, baseline);

		expect(report.commits).toEqual([seatSha]);
		expect(report.baselineHeadSha).toBe(fixture.preexistingSha);
	});

	test("keeps initial publication fail-closed when the branch carried a foreign commit before the seat", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-implementation-contamination-"));
		tempRoots.push(dir);
		process.env.DECK_V2_HOME = path.join(dir, "home");
		const fixture = createImplementationRepo(dir, false);
		const input = {
			...baseInput,
			worktree: fixture.repo,
			github: { git: "git", gh: "/usr/bin/false" },
			watchSetPath: path.join(dir, "watch-set.jsonl"),
		};
		const baseline = await captureImplementationBaseline(input);
		const seatSha = commitFixtureFile(
			fixture.repo,
			"focused.txt",
			"focused change\n",
			"focused implementation",
		);
		const report = await computeImplementationReport(input, baseline);
		expect(report.commits).toEqual([seatSha]);

		const ready = approvalReadyOutputs();
		const rendered = await renderWorkflow(pipeline, {
			input,
			outputs: {
				preflight: ready.preflight,
				implementation: [{ nodeId: "implement", ...report }],
				localReview: ready.localReview,
			} satisfies PipelineOutputFixtures,
			workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
		});
		const push = rendered.tasks.find((task) => task.nodeId === "push-pr");
		if (push?.computeFn === undefined) throw new Error("push-pr did not render");
		let message = "";
		try {
			await push.computeFn();
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain("initial publication commit attribution mismatch");
		expect(message).toContain(`claimed by implementation: ${JSON.stringify([seatSha])}`);
		expect(message).toContain(
			`actually added in origin/main@${fixture.remoteBaseSha}..HEAD: ${JSON.stringify([
				fixture.preexistingSha,
				seatSha,
			])}`,
		);
		expect(message).toContain(`implementation capture base: ${fixture.preexistingSha}`);
		expect(message).toContain("refusing initial publication");
	});
	test("rejects initial publication when implementation commit attribution is incomplete", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-initial-publish-"));
		tempRoots.push(dir);
		process.env.DECK_V2_HOME = path.join(dir, "home");
		const git = path.join(dir, "git");
		const gh = path.join(dir, "gh");
		fs.writeFileSync(
			git,
			`#!/bin/sh\ncase "$1:$2" in rev-parse:HEAD) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n';; rev-parse:--verify) printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n';; rev-list:*) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n';; esac\n`,
		);
		fs.writeFileSync(gh, "#!/bin/sh\nexit 0\n");
		fs.chmodSync(git, 0o755);
		fs.chmodSync(gh, 0o755);
		const rendered = await renderWorkflow(pipeline, {
			input: { ...baseInput, worktree: dir, github: { git, gh } },
			outputs: approvalReadyOutputs(),
			workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
		});
		const push = rendered.tasks.find((task) => task.nodeId === "push-pr");
		await expect(push?.computeFn?.()).rejects.toThrow(
			/refusing initial publication/,
		);
	});




});

describe("commit-bound stamp", () => {
	test("attaches head, PR, and optional stack topology to the approval request", async () => {
		const metadata = buildApprovalStampMetadata({
			headSha: "abc123",
			prNumber: 42,
			headBranch: "fm/child",
			baseBranch: "fm/parent",
		});
		expect(metadata).toEqual({
			headSha: "abc123",
			prNumber: 42,
			stackTopology: { headBranch: "fm/child", baseBranch: "fm/parent" },
		});

		const deckHome = fs.mkdtempSync(path.join(os.tmpdir(), "deck-stamp-metadata-"));
		tempRoots.push(deckHome);
		process.env.DECK_V2_HOME = deckHome;
		const rendered = await renderWorkflow(pipeline, {
			input: { ...baseInput, baseBranch: "fm/parent", branch: "fm/child" },
			outputs: approvalReadyOutputs("fm/parent"),
			workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
		});
		const stamp = rendered.tasks.find((task) => task.nodeId === "r0-stamp");
		expect(stamp?.needsApproval).toBe(true);
		expect(stamp?.meta).toMatchObject(metadata);
	});

	test("refuses MQ when the named local branch is not at the approved PR head", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-merge-local-drift-"));
		tempRoots.push(dir);
		process.env.DECK_V2_HOME = path.join(dir, "home");
		const log = path.join(dir, "commands.log");
		const git = path.join(dir, "git");
		const gh = path.join(dir, "gh");
		const localHead = "d".repeat(40);
		fs.writeFileSync(
			git,
			`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nif [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ]; then printf 'fm/lin-123\\n'; fi\nif [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then printf '%s\\n' '${localHead}'; fi\n`,
		);
		fs.writeFileSync(
			gh,
			`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nif [ "$1" = "api" ] && [ "$3" = "--jq" ]; then printf 'abc123\\n'\nelif [ "$1" = "api" ]; then printf '%s\\n' '${JSON.stringify({ number: 42, html_url: "https://github.com/lindy-ai/lindy/pull/42", state: "open", draft: false, head: { ref: "fm/lin-123", sha: "abc123", repo: { full_name: "lindy-ai/lindy" } }, base: { ref: "main" } })}'\nelse printf 'queued\\n'; fi\n`,
		);
		fs.chmodSync(git, 0o755);
		fs.chmodSync(gh, 0o755);
		const rendered = await renderWorkflow(pipeline, {
			input: { ...baseInput, worktree: dir, github: { git, gh } },
			outputs: {
				...approvalReadyOutputs(),
				approvals: [
					{
						nodeId: "r0-stamp",
						approved: true,
						note: "ok",
						decidedBy: "captain",
						decidedAt: "2026-08-01T00:00:00.000Z",
					},
				],
				stampValidity: [
					{
						nodeId: "r0-stamp-validity",
						round: 0,
						stampedHead: "abc123",
						currentHead: "abc123",
						valid: true,
						checkedAt: "2026-08-01T00:00:00.000Z",
					},
				],
			} satisfies PipelineOutputFixtures,
			workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
		});
		const attempt = rendered.tasks.find((task) => task.nodeId === "r0-merge-head-check");
		await expect(attempt?.computeFn?.()).rejects.toThrow(
			/not approved PR state/,
		);
		expect(fs.readFileSync(log, "utf8")).not.toContain("pr merge");
	});

	test("persists a moved-head diff summary, skips MQ, and opens a fresh watch round", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-stamp-move-"));
		tempRoots.push(dir);
		process.env.DECK_V2_HOME = path.join(dir, "home");
		const log = path.join(dir, "commands.log");
		const git = path.join(dir, "git");
		const gh = path.join(dir, "gh");
		fs.writeFileSync(
			git,
			`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$1" in log) :;; rev-parse) printf 'fm/lin-123\\n';; esac\n`,
		);
		fs.writeFileSync(
			gh,
			`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$2" in\n  repos/lindy-ai/lindy/pulls/42)\n    if [ "$3" = "--jq" ]; then printf 'def456\\n'; else printf '%s\\n' '${JSON.stringify({ number: 42, html_url: "https://github.com/lindy-ai/lindy/pull/42", state: "open", draft: false, head: { ref: "fm/lin-123", sha: "def456", repo: { full_name: "lindy-ai/lindy" } }, base: { ref: "main" } })}'; fi;;\n  repos/lindy-ai/lindy/compare/abc123...def456) printf '%s\\n' '${JSON.stringify({ status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, files: [{ filename: "src/moved.ts" }] })}';;\n  *) printf '{}\\n';;\nesac\n`,
		);
		fs.chmodSync(git, 0o755);
		fs.chmodSync(gh, 0o755);
		const outputs = {
			...approvalReadyOutputs(),
			approvals: [
				{
					nodeId: "r0-stamp",
					approved: true,
					note: "ok",
					decidedBy: "captain",
					decidedAt: "2026-08-01T00:00:00.000Z",
				},
			],
			stampValidity: [
				{
					nodeId: "r0-stamp-validity",
					round: 0,
					stampedHead: "abc123",
					currentHead: "abc123",
					valid: true,
					checkedAt: "2026-08-01T00:00:00.000Z",
				},
			],
		} satisfies PipelineOutputFixtures;
		const rendered = await renderWorkflow(pipeline, {
			input: { ...baseInput, worktree: dir, github: { git, gh } },
			outputs,
			workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
		});
		const attempt = rendered.tasks.find((task) => task.nodeId === "r0-merge-head-check");
		const invalidation = schemas.mergeHeadCheck.parse(await attempt?.computeFn?.());
		expect(invalidation).toMatchObject({
			ok: false,
			expectedHead: "abc123",
			currentHead: "def456",
			mergePath: null,
		});
		expect(invalidation.diffSummary).toContain("src/moved.ts");
		expect(fs.readFileSync(log, "utf8")).not.toContain("pr merge");

		const rerendered = await renderWorkflow(pipeline, {
			input: { ...baseInput, worktree: dir, github: { git, gh } },
			outputs: {
				...outputs,
				mergeHeadCheck: [{ nodeId: "r0-merge-head-check", ...invalidation }],
			} satisfies PipelineOutputFixtures,
			workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
		});
		expect(rerendered.tasks.some((task) => task.nodeId === "r1-watch-poll")).toBe(true);
		expect(rerendered.tasks.some((task) => task.nodeId === "enqueue-merge")).toBe(false);

		const queueRendered = await renderWorkflow(pipeline, {
			input: {
				...baseInput,
				worktree: dir,
				github: { git, gh },
				limits: { landingPollSeconds: 0.001 },
			},
			outputs: {
				...outputs,
				mergeHeadCheck: [
					{
						nodeId: "r0-merge-head-check",
						round: 0,
						expectedHead: "abc123",
						currentHead: "abc123",
						ok: true,
						diffSummary: "head unchanged",
						checkedAt: "2026-08-01T00:00:00.000Z",
						submittedAt: "2026-08-01T00:00:00.000Z",
						receipt: "queued",
						alreadyLanded: false,
						mergePath: "github-merge-queue",
					},
				],
				mergeReceipt: [
					{
						nodeId: "enqueue-merge",
						round: 0,
						submittedAt: "2026-08-01T00:00:00.000Z",
						receipt: "queued",
						alreadyLanded: false,
						mergePath: "github-merge-queue",
					},
				],
				queuePoll: [
					{
						nodeId: "queue-poll",
						poll: 0,
						state: "open",
						baseBranch: "main",
						autoMergeRequest: true,
						ejected: false,
						reason: "queued",
					},
				],
			} satisfies PipelineOutputFixtures,
			workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
		});
		const queuePoll = queueRendered.tasks.find((task) => task.nodeId === "queue-poll");
		await expect(queuePoll?.computeFn?.()).rejects.toThrow(
			/re-submit invalidated by a moved head/,
		);
		expect(fs.readFileSync(log, "utf8")).not.toContain("pr merge");
	});
});

describe("merge receipt schema", () => {
	test("keeps the native GitHub merge path in the exact schema enum", () => {
		expect(mergePathSchema.options).toEqual([
			"github-merge-queue",
			"dry-run",
			"already-landed",
		]);
		for (const mergePath of mergePathSchema.options) {
			expect(
				schemas.mergeReceipt.safeParse({
					round: 0,
					submittedAt: "2026-08-01T00:00:00.000Z",
					receipt: "receipt",
					alreadyLanded: mergePath === "already-landed",
					mergePath,
				}).success,
			).toBe(true);
		}
		expect(
			schemas.mergeReceipt.safeParse({
				round: 0,
				submittedAt: "2026-08-01T00:00:00.000Z",
				receipt: "receipt",
				alreadyLanded: false,
				mergePath: "graphite",
			}).success,
		).toBe(false);
	});
});
