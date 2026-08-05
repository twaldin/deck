/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
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

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalDeckHome === undefined) delete process.env.DECK_V2_HOME;
	else process.env.DECK_V2_HOME = originalDeckHome;
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function approvalReadyOutputs(baseBranch = "main", prNumber = 42) {
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
				"Never run OptMem from a worker or subagent. Route decisions through the workflow's question result.",
			);
		}
		expect(Buffer.byteLength(standingRulesDigest(), "utf8")).toBeLessThanOrEqual(4_300);
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
			"Never run OptMem from a worker or subagent. Route decisions through the workflow's question result.",
		);
		fs.writeFileSync(live, "live doctrine beta\n");
		expect(implementPrompt(validBrief, "/tmp/wt", "feature")).toContain("live doctrine beta");
	});

	test("forbids raw watcher pushes and removes the manual git escape hatch", () => {
		const prompt = watchFixPrompt({
			worktree: "/tmp/wt",
			branch: "feature",
			baseBranch: "main",
			repo: "lindy-ai/lindy",
			prNumber: 42,
			gh: "gh",
			pollJson: "{}",
			round: 0,
			afterPoll: 0,
		});
		expect(prompt).toContain("Return every commit you created as a full");
		expect(prompt).toContain("Pushes outside rebaseAndPush() are forbidden");
		expect(prompt).toContain("Never run git push");
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
		};
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
			},
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
			},
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
			},
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
		};
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
			},
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
			},
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
