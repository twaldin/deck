#!/usr/bin/env bun
/**
 * Read-only PR pipeline evidence harness.
 *
 * Raw captures contain private PR data and are therefore refused inside this
 * repository. `sanitize` converts them into identifier-free structural cases
 * suitable for committed, deterministic tests.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	bunExec,
	execOrThrow,
	fetchPrApprovalsAndCi,
	fetchWatchSnapshot,
	parseCheckRuns,
	type ExecFn,
} from "../lib/gh.ts";
import { evaluateWatchExit, failedCheckRuns } from "../lib/watch.ts";
import type {
	CheckRun,
	CiClassification,
	ReviewApproval,
	WatchExitVerdict,
	WatchReviewPolicy,
	WatchSnapshot,
} from "../lib/types.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(WORKFLOW_DIR, "../..");
const CANONICAL_REPO_ROOT = canonicalPath(REPO_ROOT);
const FIXED_HEAD_TIME = Date.parse("2026-01-01T00:00:00.000Z");
const SUCCESS_CONCLUSIONS = new Set(["neutral", "skipped", "success"]);
const FAILURE_CONCLUSIONS = new Set([
	"action_required", "cancelled", "failure", "stale", "startup_failure", "timed_out",
]);

/** Locked SPEC.md step 4 policy used by this captain-corpus harness. */
export const CAPTAIN_REVIEW_POLICY: WatchReviewPolicy = {
	requireHuman: true,
	requiredBots: [{
		login: "claude",
		approvalCommentPattern: "^\\*\\*Claude finished .+ task in .+\\*\\*",
		approvalCheckPattern: "claude.*review",
	}],
};
const LINDY_REPOSITORY = "lindy-ai/lindy";

export type ActorKind = "self" | "human" | "bot" | "claude" | "linear";
export type CommentSignal = "finding" | "claude-approved" | "claude-error" | "linear-banner" | "empty";

interface RawMetadata {
	number: number;
	state: string;
	isDraft: boolean;
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	mergeStateStatus: string;
	reviewDecision: string | null;
	baseRefName: string;
	headRefOid: string;
	author: { login: string };
}

export interface RawPrCapture {
	capturedAt: string;
	metadata: RawMetadata;
	selfLogins: string[];
	watchSnapshot: WatchSnapshot;
	approvals: ReviewApproval[];
	/** A real transient observation supplied separately from the live capture. */
	transientUnknownObserved: boolean;
}

export interface RawCorpus {
	schemaVersion: 1;
	repository: string;
	readOnly: true;
	capturedAt: string;
	pullRequests: RawPrCapture[];
}

interface StructuralActor {
	id: string;
	kind: ActorKind;
	/** CODEOWNER cannot be inferred from a review author alone. Never guess. */
	codeowner: "unknown";
}

interface StructuralComment {
	id: string;
	authorId: string;
	source: "issue_comment" | "review" | "review_comment";
	threadId?: string;
	afterHeadSeconds: number;
	signal: CommentSignal;
	actionable: boolean;
}

interface StructuralRun {
	id: string;
	checkSuiteId: string;
	head: "current" | `stale-${number}`;
	status: string;
	conclusion: string | null;
	createdAfterHeadSeconds: number;
	startedAfterHeadSeconds: number | null;
	jobs: Array<{
		id: string;
		status: string;
		conclusion: string | null;
		startedAfterHeadSeconds: number | null;
		completedAfterHeadSeconds: number | null;
	}>;
}

export interface StructuralFixture {
	schemaVersion: 1;
	caseId: string;
	situationTags: string[];
	real: {
		state: string;
		isDraft: boolean;
		mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
		mergeStateStatus: string;
		transientMergeableObservation: "UNKNOWN" | null;
		reviewDecision: string | null;
		behindBy: number;
		requiredChecks: { configured: number; observed: number };
	};
	headAgeSeconds: number;
	actors: StructuralActor[];
	threads: Array<{ id: string; resolved: boolean; lastAuthorId: string | null }>;
	comments: StructuralComment[];
	reviews: Array<{
		actorId: string;
		state: string;
		afterHeadSeconds: number;
		onCurrentHead: boolean;
	}>;
	requestedReviewerIds: string[];
	checks: Array<{
		id: string;
		contextId: string;
		workflowId: string;
		status: string;
		conclusion: string | null;
		startedAfterHeadSeconds: number | null;
		completedAfterHeadSeconds: number | null;
		appId: string | null;
		checkSuiteId: string | null;
	}>;
	ci: {
		rulesBranchRelation: "base" | "stack-parent";
		graceSeconds: number;
		requiredContexts: Array<{ contextId: string; appId: string | null }>;
		currentRuns: StructuralRun[];
		staleActiveRuns: StructuralRun[];
		statuses: Array<{
			id: string;
			contextId: string;
			state: string;
			createdAfterHeadSeconds: number;
			updatedAfterHeadSeconds: number;
		}>;
	};
}

const SAFE_STRUCTURAL_ENUMS = new Set([
	"OPEN", "CLOSED",
	"MERGEABLE", "CONFLICTING", "UNKNOWN",
	"BEHIND", "BLOCKED", "CLEAN", "DIRTY", "DRAFT", "HAS_HOOKS", "UNSTABLE",
	"APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING", "REVIEW_REQUIRED",
	"completed", "in_progress", "pending", "queued", "requested", "waiting",
	"action_required", "cancelled", "failure", "neutral", "skipped", "stale", "startup_failure", "success", "timed_out",
	"error", "expected",
	"issue_comment", "review", "review_comment",
	"finding", "claude-approved", "claude-error", "linear-banner", "empty",
	"self", "human", "bot", "claude", "linear", "unknown",
	"base", "stack-parent", "current",
	"approved", "changes-requested", "review-required", "empty-review-decision",
	"merge-conflict", "transient-unknown-observed", "unresolved-thread", "changes-requested-with-approval",
]);
const SAFE_STRUCTURAL_KEYS = new Set([
	"schemaVersion", "caseId", "situationTags", "real", "state", "isDraft",
	"mergeable", "mergeStateStatus", "transientMergeableObservation", "reviewDecision",
	"behindBy", "requiredChecks", "configured", "observed", "headAgeSeconds",
	"actors", "id", "kind", "codeowner", "threads", "resolved", "lastAuthorId",
	"comments", "authorId", "source", "threadId", "afterHeadSeconds", "signal",
	"actionable", "reviews", "actorId", "onCurrentHead", "requestedReviewerIds",
	"checks", "contextId", "workflowId", "status", "conclusion",
	"startedAfterHeadSeconds", "completedAfterHeadSeconds", "appId", "checkSuiteId",
	"ci", "rulesBranchRelation", "graceSeconds", "requiredContexts", "currentRuns",
	"staleActiveRuns", "statuses", "head", "createdAfterHeadSeconds",
	"updatedAfterHeadSeconds", "jobs",
]);
const SAFE_SYNTHETIC_ID = /^(?:app|bot|case|check|claude|comment|human|job|other|required|run|status|stale|suite|thread|workflow)(?:-[a-z0-9]+)+$/;

/**
 * Final fail-closed boundary: committed fixture leaves may only be booleans,
 * bounded structural numbers, null, known enums, or generated synthetic ids.
 */
export function assertPublicStructuralFixture(value: unknown): asserts value is StructuralFixture {
	const visit = (candidate: unknown, path: string): void => {
		if (candidate === null || typeof candidate === "boolean") return;
		if (typeof candidate === "number") {
			if (!Number.isSafeInteger(candidate) || Math.abs(candidate) > 1_000_000_000) {
				throw new Error(`unsafe structural number at ${path}`);
			}
			return;
		}
		if (typeof candidate === "string") {
			const syntheticSlot = /\.(?:caseId|id|actorId|authorId|lastAuthorId|threadId|contextId|workflowId|appId|checkSuiteId|head)$/.test(path)
				|| /\.requestedReviewerIds\[\d+\]$/.test(path);
			if (!SAFE_STRUCTURAL_ENUMS.has(candidate)
				&& !(syntheticSlot && SAFE_SYNTHETIC_ID.test(candidate))) {
				throw new Error(`unsafe structural string at ${path}`);
			}
			return;
		}
		if (Array.isArray(candidate)) {
			candidate.forEach((child, index) => visit(child, `${path}[${index}]`));
			return;
		}
		if (typeof candidate !== "object" || candidate === undefined) {
			throw new Error(`unsafe structural value at ${path}`);
		}
		for (const [key, child] of Object.entries(candidate)) {
			if (!SAFE_STRUCTURAL_KEYS.has(key)) throw new Error(`unsafe structural key at ${path}.${key}`);
			visit(child, `${path}.${key}`);
		}
	};
	visit(value, "$");
}

export interface DryRunRow {
	caseId: string;
	prNumber?: number;
	realState: string;
	classification: string;
	node: string;
	action: string;
	verdict: "correct" | "wrong" | "hangs" | "crashes";
	failures: string[];
}

function usage(): never {
	throw new Error([
		"Usage:",
		"  bun scripts/pr-state-dry-run.ts capture --repo owner/name --self login --out /outside/repo/raw.json [--transient-unknown 1,2] <pr>...",
		"  bun scripts/pr-state-dry-run.ts sanitize --raw /outside/repo/raw.json --out-dir tests/fixtures/lindy-prs",
		"  bun scripts/pr-state-dry-run.ts report --raw /outside/repo/raw.json [--json]",
		"  bun scripts/pr-state-dry-run.ts report --fixtures tests/fixtures/lindy-prs [--json]",
	].join("\n"));
}

function valueAfter(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index < 0 ? undefined : args[index + 1];
}
function pathEntryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function canonicalPath(path: string): string {
	let existing = resolve(path);
	const missing: string[] = [];
	while (!pathEntryExists(existing)) {
		const parent = dirname(existing);
		if (parent === existing) break;
		missing.unshift(basename(existing));
		existing = parent;
	}
	if (!pathEntryExists(existing)) return resolve(existing, ...missing);
	const stat = lstatSync(existing);
	if (stat.isSymbolicLink()) {
		const target = resolve(dirname(existing), readlinkSync(existing));
		return canonicalPath(resolve(target, ...missing));
	}
	return resolve(realpathSync(existing), ...missing);
}

function insideRepo(path: string): boolean {
	const relation = relative(CANONICAL_REPO_ROOT, canonicalPath(path));
	return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

const readOnlyExec: ExecFn = async (argv, options) => {
	if (basename(argv[0] ?? "") !== "gh") throw new Error(`capture only permits gh reads: ${argv.join(" ")}`);
	if (argv.some((arg) => arg === "-X" || arg === "--method" || arg.startsWith("--method="))) {
		throw new Error(`capture rejected a mutating gh invocation: ${argv.join(" ")}`);
	}
	const command = argv[1];
	if (command !== "api" && !(command === "pr" && argv[2] === "view")) {
		throw new Error(`capture rejected non-read gh command: ${argv.join(" ")}`);
	}
	return bunExec(argv, options);
};

async function fetchMetadata(repo: string, prNumber: number): Promise<RawMetadata> {
	const out = await execOrThrow(readOnlyExec, [
		"gh", "pr", "view", String(prNumber), "--repo", repo, "--json",
		"number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,baseRefName,headRefOid,author",
	]);
	const value = JSON.parse(out) as RawMetadata;
	value.reviewDecision = value.reviewDecision || null;
	return value;
}


async function fetchAllCheckRuns(repo: string, headSha: string): Promise<CheckRun[]> {
	const all: CheckRun[] = [];
	for (let page = 1; ; page++) {
		const out = await execOrThrow(readOnlyExec, [
			"gh",
			"api",
			`repos/${repo}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100&page=${page}`,
		]);
		const batch = parseCheckRuns(JSON.parse(out));
		all.push(...batch);
		if (batch.length < 100) return all;
	}
}
function reviewActivityFingerprint(approvals: ReviewApproval[]): string {
	const latest = new Map<string, ReviewApproval>();
	for (const review of approvals) {
		const key = review.login.toLowerCase();
		const prior = latest.get(key);
		if (prior === undefined || review.submittedAt > prior.submittedAt) latest.set(key, review);
	}
	return [...latest.values()]
		.map((review) => `${review.login.toLowerCase()}:${review.state}:${review.submittedAt}`)
		.sort()
		.join("|");
}

function snapshotReviewFingerprint(snapshot: WatchSnapshot): string {
	return snapshot.reviewers
		.map((reviewer) => `${reviewer.login.toLowerCase()}:${reviewer.lastReviewState ?? ""}:${reviewer.lastActivityAt}`)
		.sort()
		.join("|");
}

export function assertCaptureCollectionsComplete(
	snapshot: WatchSnapshot,
	approvals: ReviewApproval[],
	checkRunsPaginated = false,
): void {
	const possibleTruncation = [
		["reviews", approvals.length],
		["comments", snapshot.comments.length],
		["review threads", snapshot.threads.length],
		["check runs", checkRunsPaginated ? 0 : snapshot.checkRuns.length],
		["current workflow runs", snapshot.ciEvidence?.currentRuns.length ?? 0],
		["stale workflow runs", snapshot.ciEvidence?.staleActiveRuns.length ?? 0],
		["commit statuses", snapshot.ciEvidence?.statuses.length ?? 0],
		["workflow jobs", Math.max(0, ...(snapshot.ciEvidence?.currentRuns ?? []).map((run) => run.jobs.length))],
	].find(([, count]) => (count as number) >= 100);
	if (possibleTruncation !== undefined) {
		throw new Error(`${possibleTruncation[0]} reached the GitHub page cap; refusing a possibly truncated capture`);
	}
}

async function capturePr(
	repo: string,
	prNumber: number,
	selfLogins: string[],
	transientUnknown: Set<number>,
): Promise<RawPrCapture> {
	if (repo !== LINDY_REPOSITORY) {
		throw new Error(`this evidence corpus harness is scoped to ${LINDY_REPOSITORY}`);
	}
	const ctx = { gh: "gh", repo, exec: readOnlyExec };
	for (let attempt = 1; attempt <= 3; attempt++) {
		const before = await fetchMetadata(repo, prNumber);
		const approvalState = await fetchPrApprovalsAndCi(ctx, prNumber);
		const capturedSnapshot = await fetchWatchSnapshot(ctx, prNumber, selfLogins);
		const checkRunsPaginated = capturedSnapshot.checkRuns.length >= 100;
		const watchSnapshot: WatchSnapshot = capturedSnapshot.checkRuns.length < 100
			? capturedSnapshot
			: { ...capturedSnapshot, checkRuns: await fetchAllCheckRuns(repo, capturedSnapshot.headSha) };
		const after = await fetchMetadata(repo, prNumber);
		const moved = before.headRefOid !== after.headRefOid
			|| before.state !== after.state
			|| before.baseRefName !== after.baseRefName
			|| before.mergeable !== after.mergeable
			|| before.mergeStateStatus !== after.mergeStateStatus
			|| before.reviewDecision !== after.reviewDecision
			|| watchSnapshot.headSha !== after.headRefOid
			|| approvalState.headSha !== after.headRefOid
			|| reviewActivityFingerprint(approvalState.approvals) !== snapshotReviewFingerprint(watchSnapshot);
		if (moved) {
			if (attempt === 3) throw new Error(`PR #${prNumber} changed during all three capture attempts`);
			continue;
		}
		const coherentWatchSnapshot: WatchSnapshot = {
			...watchSnapshot,
			reviewDecision: after.reviewDecision,
		};
		assertCaptureCollectionsComplete(coherentWatchSnapshot, approvalState.approvals, checkRunsPaginated);
		if (after.state.toUpperCase() !== "OPEN") throw new Error(`PR #${prNumber} is not open`);
		return {
			capturedAt: new Date().toISOString(),
			metadata: after,
			selfLogins,
			watchSnapshot: coherentWatchSnapshot,
			approvals: approvalState.approvals,
			transientUnknownObserved: transientUnknown.has(prNumber),
		};
	}
	throw new Error(`unreachable capture failure for PR #${prNumber}`);
}

async function captureCorpus(args: string[]): Promise<RawCorpus> {
	const repo = valueAfter(args, "--repo");
	const self = valueAfter(args, "--self");
	const out = valueAfter(args, "--out");
	if (repo === undefined || self === undefined || out === undefined) usage();
	const safeOut = canonicalPath(out);
	if (insideRepo(safeOut)) throw new Error("raw PR captures are private and MUST be written outside the repository");
	const transientUnknown = new Set((valueAfter(args, "--transient-unknown") ?? "")
		.split(",").filter(Boolean).map(Number));
	const flagsWithValues = new Set(["--repo", "--self", "--out", "--transient-unknown"]);
	const positional: string[] = [];
	for (let index = 1; index < args.length; index++) {
		const arg = args[index]!;
		if (flagsWithValues.has(arg)) { index++; continue; }
		if (!arg.startsWith("--")) positional.push(arg);
	}
	const prs = positional.map(Number);
	if (prs.length === 0 || prs.some((value) => !Number.isSafeInteger(value) || value <= 0)) usage();
	const pullRequests: RawPrCapture[] = [];
	for (const prNumber of prs) pullRequests.push(await capturePr(repo, prNumber, [self], transientUnknown));
	const corpus: RawCorpus = {
		schemaVersion: 1,
		repository: repo,
		readOnly: true,
		capturedAt: new Date().toISOString(),
		pullRequests,
	};
	await mkdir(dirname(safeOut), { recursive: true });
	if (canonicalPath(out) !== safeOut || insideRepo(safeOut)) {
		throw new Error("raw capture output path changed or entered the repository during capture");
	}
	await Bun.write(safeOut, `${JSON.stringify(corpus, null, 2)}\n`);
	await chmod(safeOut, 0o600);
	return corpus;
}

function secondsAfter(iso: string | null | undefined, headTime: number): number | null {
	if (iso === null || iso === undefined || iso === "") return null;
	const timestamp = Date.parse(iso);
	return Number.isFinite(timestamp) ? Math.floor((timestamp - headTime) / 1000) : null;
}

function actorKind(login: string, bot: boolean, selfLogins: Set<string>): ActorKind {
	const lower = login.toLowerCase();
	if (selfLogins.has(lower)) return "self";
	if (lower === "claude") return "claude";
	if (lower === "linear[bot]") return "linear";
	return bot ? "bot" : "human";
}

function commentSignal(body: string | undefined): CommentSignal {
	const value = body?.trim() ?? "";
	if (value === "") return "empty";
	if (/^\*\*Claude finished .+ task in .+\*\*/i.test(value)) return "claude-approved";
	if (/^\*\*Claude encountered an error/i.test(value)) return "claude-error";
	return "finding";
}

function sanitizeCapture(raw: RawPrCapture, index: number): StructuralFixture {
	const snapshot = raw.watchSnapshot;
	const evidence = snapshot.ciEvidence;
	if (evidence === undefined) throw new Error("raw snapshot has no exact-head CI evidence");
	const headTime = Date.parse(snapshot.lastPushAt);
	if (!Number.isFinite(headTime)) throw new Error("raw snapshot has invalid lastPushAt");
	const self = new Set(raw.selfLogins.map((login) => login.toLowerCase()));
	const actorIds = new Map<string, string>();
	const actors: StructuralActor[] = [];
	const actorId = (login: string, bot = false): string => {
		const key = login.toLowerCase();
		const prior = actorIds.get(key);
		if (prior !== undefined) return prior;
		const kind = actorKind(login, bot, self);
		const id = kind === "self" ? "self" : `${kind}-${actors.filter((actor) => actor.kind === kind).length + 1}`;
		actorIds.set(key, id);
		actors.push({ id, kind, codeowner: "unknown" });
		return id;
	};
	for (const login of raw.selfLogins) actorId(login);

	const threadIds = new Map(snapshot.threads.map((thread, threadIndex) => [thread.id, `thread-${threadIndex + 1}`]));
	const contextIds = new Map<string, string>();
	const contextId = (name: string): string => {
		const prior = contextIds.get(name);
		if (prior !== undefined) return prior;
		const requiredIndex = evidence.requiredContexts.findIndex((entry) => entry.context === name);
		const id = requiredIndex >= 0 ? `required-${requiredIndex + 1}` : `other-${contextIds.size + 1}`;
		contextIds.set(name, id);
		return id;
	};
	for (const required of evidence.requiredContexts) contextId(required.context);
	const appIds = new Map<number, string>();
	const appId = (id: number | null | undefined): string | null => {
		if (id === null || id === undefined) return null;
		if (!appIds.has(id)) appIds.set(id, `app-${appIds.size + 1}`);
		return appIds.get(id)!;
	};
	const suiteIds = new Map<number, string>();
	const suiteId = (id: number | null | undefined): string | null => {
		if (id === null || id === undefined) return null;
		if (!suiteIds.has(id)) suiteIds.set(id, `suite-${suiteIds.size + 1}`);
		return suiteIds.get(id)!;
	};
	const workflows = new Map<string, string>();
	const workflowId = (run: CheckRun): string => {
		const key = run.workflowName ?? run.name;
		if (!workflows.has(key)) workflows.set(key, `workflow-${workflows.size + 1}`);
		return workflows.get(key)!;
	};
	const staleHeads = new Map<string, `stale-${number}`>();
	const run = (value: typeof evidence.currentRuns[number], runIndex: number): StructuralRun => ({
		id: `run-${runIndex + 1}`,
		checkSuiteId: suiteId(value.checkSuiteId)!,
		head: value.headSha === snapshot.headSha ? "current" : (() => {
			if (!staleHeads.has(value.headSha)) staleHeads.set(value.headSha, `stale-${staleHeads.size + 1}`);
			return staleHeads.get(value.headSha)!;
		})(),
		status: value.status,
		conclusion: value.conclusion,
		createdAfterHeadSeconds: secondsAfter(value.createdAt, headTime) ?? 0,
		startedAfterHeadSeconds: secondsAfter(value.startedAt, headTime),
		jobs: value.jobs.map((job, jobIndex) => ({
			id: `job-${runIndex + 1}-${jobIndex + 1}`,
			status: job.status,
			conclusion: job.conclusion,
			startedAfterHeadSeconds: secondsAfter(job.startedAt, headTime),
			completedAfterHeadSeconds: secondsAfter(job.completedAt, headTime),
		})),
	});
	const observedRequired = evidence.requiredContexts.filter((required) =>
		snapshot.checkRuns.some((check) => check.name === required.context &&
			(required.integrationId === null || check.appId === required.integrationId)) ||
		evidence.statuses.some((status) => required.integrationId === null && status.context === required.context));
	for (const comment of snapshot.comments) actorId(comment.author, comment.isBot);
	for (const reviewer of snapshot.reviewers) actorId(reviewer.login, reviewer.isBot);
	for (const review of raw.approvals) actorId(review.login, review.isBot);
	for (const login of snapshot.requestedReviewers) actorId(login);
	const tags = new Set<string>();
	tags.add(raw.metadata.reviewDecision === null ? "empty-review-decision" : raw.metadata.reviewDecision.toLowerCase().replaceAll("_", "-"));
	if (raw.metadata.mergeable === "CONFLICTING" || raw.metadata.mergeStateStatus === "DIRTY") tags.add("merge-conflict");
	if (raw.transientUnknownObserved) tags.add("transient-unknown-observed");
	if (snapshot.threads.some((thread) => !thread.isResolved)) tags.add("unresolved-thread");
	if (raw.approvals.some((review) => !review.isBot && review.state === "APPROVED") &&
		raw.approvals.some((review) => !review.isBot && review.state === "CHANGES_REQUESTED")) {
		tags.add("changes-requested-with-approval");
	}
	return {
		schemaVersion: 1,
		caseId: `case-${String(index + 1).padStart(2, "0")}`,
		situationTags: [...tags].sort(),
		real: {
			state: raw.metadata.state,
			isDraft: raw.metadata.isDraft,
			mergeable: raw.metadata.mergeable,
			mergeStateStatus: raw.metadata.mergeStateStatus,
			transientMergeableObservation: raw.transientUnknownObserved ? "UNKNOWN" : null,
			reviewDecision: raw.metadata.reviewDecision,
			behindBy: snapshot.behindBy,
			requiredChecks: { configured: evidence.requiredContexts.length, observed: observedRequired.length },
		},
		headAgeSeconds: evidence.currentHeadAgeSeconds,
		actors,
		threads: snapshot.threads.map((thread) => ({
			id: threadIds.get(thread.id)!, resolved: thread.isResolved,
			lastAuthorId: thread.lastCommenter === null ? null : actorId(thread.lastCommenter),
		})),
		comments: snapshot.comments.map((comment, commentIndex) => {
			const signal = commentSignal(comment.body);
			const structuralThreadId = comment.threadId === undefined
				? undefined
				: threadIds.get(comment.threadId);
			return {
				id: `comment-${commentIndex + 1}`,
				authorId: actorId(comment.author, comment.isBot),
				source: comment.source ?? "issue_comment",
				...(structuralThreadId === undefined ? {} : { threadId: structuralThreadId }),
				afterHeadSeconds: secondsAfter(comment.createdAt, headTime) ?? 0,
				signal,
				actionable: actorKind(comment.author, comment.isBot, self) !== "self" && signal !== "linear-banner",
			};
		}),
		reviews: raw.approvals.map((review) => ({
			actorId: actorId(review.login, review.isBot),
			state: review.state,
			afterHeadSeconds: secondsAfter(review.submittedAt, headTime) ?? 0,
			onCurrentHead: (review as ReviewApproval & { headSha?: string }).headSha !== undefined
				? (review as ReviewApproval & { headSha?: string }).headSha === snapshot.headSha
				: review.submittedAt >= snapshot.lastPushAt,
		})),
		requestedReviewerIds: snapshot.requestedReviewers.map((login) => actorId(login)),
		checks: snapshot.checkRuns.map((check, checkIndex) => ({
			id: `check-${checkIndex + 1}`,
			contextId: contextId(check.name),
			workflowId: workflowId(check),
			status: check.status,
			conclusion: check.conclusion,
			startedAfterHeadSeconds: secondsAfter(check.startedAt, headTime),
			completedAfterHeadSeconds: secondsAfter(check.completedAt, headTime),
			appId: appId(check.appId),
			checkSuiteId: suiteId(check.checkSuiteId),
		})),
		ci: {
			rulesBranchRelation: evidence.rulesBranch === raw.metadata.baseRefName ? "base" : "stack-parent",
			graceSeconds: evidence.graceSeconds,
			requiredContexts: evidence.requiredContexts.map((required) => ({
				contextId: contextId(required.context), appId: appId(required.integrationId),
			})),
			currentRuns: evidence.currentRuns.map(run),
			staleActiveRuns: evidence.staleActiveRuns.map((value, runIndex) => run(value, evidence.currentRuns.length + runIndex)),
			statuses: evidence.statuses.map((status, statusIndex) => ({
				id: `status-${statusIndex + 1}`,
				contextId: contextId(status.context),
				state: status.state,
				createdAfterHeadSeconds: secondsAfter(status.createdAt, headTime) ?? 0,
				updatedAfterHeadSeconds: secondsAfter(status.updatedAt, headTime) ?? 0,
			})),
		},
	};
}

async function sanitizeCorpus(rawPath: string, outDir: string): Promise<StructuralFixture[]> {
	if (insideRepo(rawPath)) throw new Error("sanitizer refuses raw input stored inside the repository");
	const corpus = await Bun.file(resolve(rawPath)).json() as RawCorpus;
	const fixtures = corpus.pullRequests.map(sanitizeCapture);
	for (const fixture of fixtures) assertPublicStructuralFixture(fixture);
	await mkdir(resolve(outDir), { recursive: true });
	for (const name of await readdir(resolve(outDir))) {
		if (/^case-\d+\.json$/.test(name)) await rm(resolve(outDir, name));
	}
	for (const fixture of fixtures) {
		await Bun.write(resolve(outDir, `${fixture.caseId}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
	}
	return fixtures;
}

function atOffset(seconds: number | null): string | null {
	return seconds === null ? null : new Date(FIXED_HEAD_TIME + seconds * 1000).toISOString();
}

function canonicalBody(signal: CommentSignal): string {
	switch (signal) {
		case "claude-approved": return "**Claude finished synthetic task in 1m**";
		case "claude-error": return "**Claude encountered an error after 1m**";
		case "linear-banner": return "<!-- linear-linkback -->";
		case "finding": return "synthetic review finding";
		case "empty": return "";
	}
}

export function rehydrateFixture(fixture: StructuralFixture): {
	watchSnapshot: WatchSnapshot;
	approvals: ReviewApproval[];
	selfLogins: string[];
} {
	const actor = new Map(fixture.actors.map((entry) => [entry.id, entry]));
	const login = (id: string): string => {
		const kind = actor.get(id)?.kind;
		if (kind === "self") return "pr-author";
		if (kind === "claude") return "claude";
		if (kind === "linear") return "linear[bot]";
		return id;
	};
	const bot = (id: string): boolean => ["bot", "claude", "linear"].includes(actor.get(id)?.kind ?? "");
	const context = new Map<string, string>();
	for (const required of fixture.ci.requiredContexts) context.set(required.contextId, required.contextId);
	for (const check of fixture.checks) context.set(check.contextId, check.contextId);
	for (const status of fixture.ci.statuses) context.set(status.contextId, status.contextId);
	const appNumber = new Map<string, number>();
	const appId = (id: string | null): number | null => {
		if (id === null) return null;
		if (!appNumber.has(id)) appNumber.set(id, 100 + appNumber.size);
		return appNumber.get(id)!;
	};
	const suiteNumber = new Map<string, number>();
	const suiteId = (id: string | null): number | null => {
		if (id === null) return null;
		if (!suiteNumber.has(id)) suiteNumber.set(id, 1000 + suiteNumber.size);
		return suiteNumber.get(id)!;
	};
	const headSha = "current-head";
	const run = (value: StructuralRun, index: number) => ({
		id: 2000 + index,
		checkSuiteId: suiteId(value.checkSuiteId)!,
		headSha: value.head === "current" ? headSha : value.head,
		status: value.status,
		conclusion: value.conclusion,
		createdAt: atOffset(value.createdAfterHeadSeconds)!,
		updatedAt: atOffset(value.createdAfterHeadSeconds)!,
		startedAt: atOffset(value.startedAfterHeadSeconds),
		url: `https://example.invalid/run-${index}`,
		jobs: value.jobs.map((job, jobIndex) => ({
			id: 3000 + index * 100 + jobIndex,
			name: job.id,
			status: job.status,
			conclusion: job.conclusion,
			startedAt: atOffset(job.startedAfterHeadSeconds),
			completedAt: atOffset(job.completedAfterHeadSeconds),
			url: `https://example.invalid/job-${index}-${jobIndex}`,
		})),
	});
	const allRuns = [...fixture.ci.currentRuns, ...fixture.ci.staleActiveRuns];
	const runById = new Map(allRuns.map((value, index) => [value.id, run(value, index)]));
	const latestReviews = new Map<string, typeof fixture.reviews[number]>();
	for (const review of fixture.reviews) {
		const prior = latestReviews.get(review.actorId);
		if (prior === undefined || review.afterHeadSeconds > prior.afterHeadSeconds) latestReviews.set(review.actorId, review);
	}
	return {
		selfLogins: ["pr-author"],
		watchSnapshot: {
			headSha,
			reviewDecision: fixture.real.reviewDecision,
			mergeable: fixture.real.mergeable,
			mergeStateStatus: fixture.real.mergeStateStatus,
			behindBy: fixture.real.behindBy,
			lastPushAt: atOffset(0)!,
			threads: fixture.threads.map((thread) => ({
				id: thread.id,
				isResolved: thread.resolved,
				lastCommenter: thread.lastAuthorId === null ? null : login(thread.lastAuthorId),
			})),
			comments: fixture.comments.map((comment) => ({
				id: comment.id,
				source: comment.source,
				threadId: comment.threadId,
				author: login(comment.authorId),
				isBot: bot(comment.authorId),
				createdAt: atOffset(comment.afterHeadSeconds)!,
				body: canonicalBody(comment.signal),
			})),
			reviewers: [...latestReviews.values()].map((review) => ({
				login: login(review.actorId),
				isBot: bot(review.actorId),
				lastActivityAt: atOffset(review.afterHeadSeconds)!,
				lastReviewState: review.state || null,
				headSha: review.onCurrentHead ? headSha : "stale-head",
			})),
			requestedReviewers: fixture.requestedReviewerIds.map(login),
			checkRuns: fixture.checks.map((check, index) => ({
				id: 4000 + index,
				name: context.get(check.contextId)!,
				workflowName: check.workflowId,
				status: check.status,
				conclusion: check.conclusion,
				startedAt: atOffset(check.startedAfterHeadSeconds),
				completedAt: atOffset(check.completedAfterHeadSeconds),
				detailsUrl: `https://example.invalid/check-${index}`,
				appId: appId(check.appId),
				checkSuiteId: suiteId(check.checkSuiteId),
			})),
			ciEvidence: {
				requiredContexts: fixture.ci.requiredContexts.map((required) => ({
					context: context.get(required.contextId)!, integrationId: appId(required.appId),
				})),
				rulesBranch: fixture.ci.rulesBranchRelation === "base" ? "base" : "stack-parent",
				graceSeconds: fixture.ci.graceSeconds,
				currentHeadAgeSeconds: fixture.headAgeSeconds,
				currentRuns: fixture.ci.currentRuns.map((value) => runById.get(value.id)!),
				staleActiveRuns: fixture.ci.staleActiveRuns.map((value) => runById.get(value.id)!),
				statuses: fixture.ci.statuses.map((status, index) => ({
					id: 5000 + index,
					context: context.get(status.contextId)!,
					state: status.state,
					createdAt: atOffset(status.createdAfterHeadSeconds)!,
					updatedAt: atOffset(status.updatedAfterHeadSeconds)!,
					targetUrl: `https://example.invalid/status-${index}`,
				})),
			},
		},
		approvals: fixture.reviews.map((review) => ({
			login: login(review.actorId),
			isBot: bot(review.actorId),
			state: review.state,
			submittedAt: atOffset(review.afterHeadSeconds)!,
			headSha: review.onCurrentHead ? headSha : "stale-head",
		})),
	};
}

function newestCheck(candidates: CheckRun[]): CheckRun | undefined {
	return candidates.sort((a, b) =>
		(b.completedAt ?? b.startedAt ?? "").localeCompare(a.completedAt ?? a.startedAt ?? "")
		|| (b.id ?? 0) - (a.id ?? 0)
	)[0];
}

function requiredFailure(snapshot: WatchSnapshot): boolean {
	const evidence = snapshot.ciEvidence;
	if (evidence === undefined) return false;
	const suites = new Set(evidence.currentRuns.map((run) => run.checkSuiteId));
	return evidence.requiredContexts.some((required) => {
		const check = newestCheck(snapshot.checkRuns.filter((candidate) =>
			candidate.name === required.context
			&& (required.integrationId === null || candidate.appId === required.integrationId)
			&& candidate.checkSuiteId !== null
			&& candidate.checkSuiteId !== undefined
			&& suites.has(candidate.checkSuiteId)
		));
		if (check !== undefined) return check.status === "completed" && FAILURE_CONCLUSIONS.has((check.conclusion ?? "").toLowerCase());
		return required.integrationId === null && evidence.statuses
			.filter((status) => status.context === required.context)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id)
			.slice(0, 1)
			.some((status) => ["error", "failure"].includes(status.state));
	});
}

/**
 * Independent desired classifier, mirroring the mature CI-truth evidence
 * discipline. Required exact-head contexts decide CI when configured; when
 * none are configured, observed exact-head optional checks still decide.
 */
export function expectedCiClassification(snapshot: WatchSnapshot): CiClassification {
	const evidence = snapshot.ciEvidence;
	if (evidence === undefined) return snapshot.checkRuns.length === 0 ? "NOT_TRIGGERED" : "WORKFLOW_BROKEN";
	if (evidence.requiredContexts.length === 0) {
		if (failedCheckRuns(snapshot.checkRuns).length > 0
			|| evidence.statuses.some((status) => ["error", "failure"].includes(status.state.toLowerCase()))) {
			return "TERMINAL_FAILURE";
		}
		if (snapshot.checkRuns.some((check) => check.status !== "completed")) return "RUNNER_QUEUED";
		if (snapshot.checkRuns.length > 0) return "TERMINAL_SUCCESS";
		if (evidence.statuses.some((status) => status.state.toLowerCase() === "pending")) return "RUNNER_QUEUED";
		if (evidence.statuses.length > 0) return "TERMINAL_SUCCESS";
	}

	const currentSuites = new Set(evidence.currentRuns.map((run) => run.checkSuiteId));
	const observed = evidence.requiredContexts.map((required) => {
		const check = newestCheck(snapshot.checkRuns.filter((candidate) =>
			candidate.name === required.context
			&& candidate.checkSuiteId !== null
			&& candidate.checkSuiteId !== undefined
			&& currentSuites.has(candidate.checkSuiteId)
			&& (required.integrationId === null || candidate.appId === required.integrationId)
		));
		if (check !== undefined) return { check };
		if (required.integrationId !== null) return {};
		const status = evidence.statuses
			.filter((candidate) => candidate.context === required.context)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id)[0];
		return status === undefined ? {} : { status };
	});
	if (observed.some((item) =>
		item.check !== undefined
			? item.check.status === "completed" && FAILURE_CONCLUSIONS.has((item.check.conclusion ?? "").toLowerCase())
			: item.status !== undefined && ["error", "failure"].includes(item.status.state.toLowerCase())
	)) return "TERMINAL_FAILURE";
	if (observed.some((item) =>
		item.check !== undefined
			&& item.check.status === "in_progress"
			&& item.check.startedAt !== null
			&& item.check.startedAt !== undefined
	)) return "RUNNING";
	const allSucceeded = evidence.requiredContexts.length > 0
		&& observed.length === evidence.requiredContexts.length
		&& observed.every((item) =>
			item.check !== undefined
				? item.check.status === "completed" && SUCCESS_CONCLUSIONS.has((item.check.conclusion ?? "").toLowerCase())
				: item.status !== undefined && item.status.state.toLowerCase() === "success"
		);
	if (allSucceeded) return "TERMINAL_SUCCESS";
	if (observed.some((item) =>
		item.check !== undefined
			? ["pending", "queued", "waiting"].includes(item.check.status)
			: item.status !== undefined && item.status.state.toLowerCase() === "pending"
	)) return "RUNNER_QUEUED";

	const activeCurrent = evidence.currentRuns.filter((run) =>
		["in_progress", "pending", "queued", "requested", "waiting"].includes(run.status)
	);
	if (activeCurrent.some((run) => run.jobs.some((job) =>
		["pending", "queued", "waiting"].includes(job.status)
	))) return "RUNNER_QUEUED";
	if (activeCurrent.length > 0) {
		const jobless = activeCurrent.every((run) => run.jobs.length === 0);
		const hasStartedJob = activeCurrent.some((run) =>
			run.jobs.some((job) => job.status === "in_progress" && job.startedAt !== null)
		);
		if (evidence.currentHeadAgeSeconds <= evidence.graceSeconds && (jobless || hasStartedJob)) return "STARTING";
		const staleActive = evidence.staleActiveRuns.some((run) =>
			["in_progress", "pending", "queued", "requested", "waiting"].includes(run.status)
		);
		if (jobless && staleActive) return "STALE_RUN_BLOCKED";
		return "EXPECTED_STUCK";
	}
	if (evidence.currentRuns.length > 0) return "WORKFLOW_BROKEN";
	return evidence.requiredContexts.length === 0 ? "NO_REQUIRED_CHECKS" : "NOT_TRIGGERED";
}
function hasHumanApproval(
	approvals: ReviewApproval[],
	selfLogins: string[],
	lastPushAt: string,
	headSha: string,
): boolean {
	const self = new Set(selfLogins.map((login) => login.toLowerCase()));
	const latest = new Map<string, ReviewApproval>();
	for (const review of approvals) {
		const key = review.login.toLowerCase();
		const reviewHead = (review as ReviewApproval & { headSha?: string }).headSha;
		if (reviewHead === undefined ? review.submittedAt < lastPushAt : reviewHead !== headSha) continue;
		if (review.isBot || self.has(key)) continue;
		const prior = latest.get(key);
		if (prior === undefined || review.submittedAt > prior.submittedAt) latest.set(key, review);
	}
	return [...latest.values()].some((review) => review.state === "APPROVED");
}

function hasClaudeApproval(snapshot: WatchSnapshot): boolean {
	const latestComment = snapshot.comments
		.filter((comment) =>
			comment.isBot
			&& comment.author.toLowerCase() === "claude"
			&& comment.createdAt >= snapshot.lastPushAt
		)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
	if (latestComment !== undefined) {
		return /^\*\*Claude finished .+ task in .+\*\*/i.test(latestComment.body ?? "");
	}
	if (snapshot.reviewers.some((reviewer) => {
		const reviewHead = (reviewer as typeof reviewer & { headSha?: string }).headSha;
		return reviewer.isBot
			&& reviewer.login.toLowerCase() === "claude"
			&& reviewer.lastReviewState === "APPROVED"
			&& (reviewHead === undefined
				? reviewer.lastActivityAt >= snapshot.lastPushAt
				: reviewHead === snapshot.headSha);
	})) return true;
	return snapshot.checkRuns.some((check) =>
		/claude.*review/i.test(check.name)
		&& check.status === "completed"
		&& SUCCESS_CONCLUSIONS.has((check.conclusion ?? "").toLowerCase())
	);
}

function expectedRecentCommentKinds(snapshot: WatchSnapshot, selfLogins: string[]): Set<"human_comment" | "bot_comment"> {
	const self = new Set(selfLogins.map((login) => login.toLowerCase()));
	const cutoff = snapshot.comments.reduce(
		(latest, comment) =>
			self.has(comment.author.toLowerCase()) && comment.createdAt > latest
				? comment.createdAt
				: latest,
		snapshot.lastPushAt,
	);
	const kinds = new Set<"human_comment" | "bot_comment">();
	for (const comment of snapshot.comments) {
		if (comment.createdAt <= cutoff || self.has(comment.author.toLowerCase())) continue;
		if (comment.author.toLowerCase() === "linear[bot]" && /^<!--\s*linear-linkback\s*-->\s*$/i.test(comment.body ?? "")) continue;
		if (comment.isBot && comment.author.toLowerCase() === "claude") kinds.add("bot_comment");
		else if (!comment.isBot) kinds.add("human_comment");
	}
	return kinds;
}

function route(verdict: WatchExitVerdict): { node: string; action: string } {
	const triggers = verdict.triggers ?? [];
	if (verdict.rebaseRequired) return {
		node: triggers.some((trigger) => trigger.kind !== "merge_conflict")
			? "r0-watch-fix -> r0-watch-poll -> r0-watch-baseline -> r0-watch-fix -> r0-watch-publish"
			: "r0-watch-fix",
		action: triggers.some((trigger) => trigger.kind !== "merge_conflict")
			? `bounded rebase; carry ${[...new Set(triggers.filter((trigger) => trigger.kind !== "merge_conflict").map((trigger) => trigger.kind))].join(", ")} into the next watch seat`
			: "bounded rebase, test, push, and re-poll",
	};
	if (triggers.length > 0 || verdict.actionable) return {
		node: "r0-watch-baseline -> r0-watch-fix -> r0-watch-publish",
		action: triggers.length > 0
			? `wake a seat for ${[...new Set(triggers.map((trigger) => trigger.kind))].join(", ")}`
			: "wake the legacy aggregate fixer",
	};
	if (verdict.terminalEscalation || verdict.disposition === "escalate") {
		return { node: "r0-watch-escalation", action: "surface terminal CI evidence to the captain" };
	}
	if (verdict.exitOk) {
		return {
			node: "r0-ready-poll -> r0-stamp",
			action: "verify readiness, then offer the captain's stamp while CI watch continues",
		};
	}
	return { node: "r0-watch-poll", action: "poll again without waking a seat" };
}

function classification(verdict: WatchExitVerdict): string {
	if (verdict.ciClassification !== undefined) return verdict.ciClassification;
	const legacy: Record<string, string> = {
		green: "TERMINAL_SUCCESS", red: "TERMINAL_FAILURE", "will-be-green": "RUNNING", none: "NOT_TRIGGERED",
	};
	return legacy[verdict.ci] ?? verdict.ci;
}

export function analyzeSnapshot(args: {
	caseId: string;
	prNumber?: number;
	real: StructuralFixture["real"];
	watchSnapshot: WatchSnapshot;
	surveyUnknown?: boolean;
	approvals: ReviewApproval[];
	selfLogins: string[];
}): DryRunRow {
	try {
		const verdict = evaluateWatchExit(args.watchSnapshot, {
			selfLogins: args.selfLogins,
			handledTriggerIds: [],
			reviewPolicy: CAPTAIN_REVIEW_POLICY,
		});
		const actual = route(verdict);
		const failures: string[] = [];
		const actualClassification = classification(verdict);
		const expectedClassification = expectedCiClassification(args.watchSnapshot);
		if (actualClassification !== expectedClassification) {
			failures.push("CI evidence taxonomy does not match exact-head required-check truth");
		}
		const triggerKinds = new Set((verdict.triggers ?? []).map((trigger) => trigger.kind));
		const conflict = args.real.mergeable === "CONFLICTING" || args.real.mergeStateStatus === "DIRTY";
		if (conflict && (!verdict.rebaseRequired || !triggerKinds.has("merge_conflict"))) failures.push("merge conflict does not produce a rebase trigger");
		if (!conflict && verdict.rebaseRequired) failures.push("mergeable PR is rebased solely because it is behind base");
		if (requiredFailure(args.watchSnapshot) && !triggerKinds.has("failed_ci")) failures.push("terminal required-CI failure does not wake a seat");
		for (const kind of expectedRecentCommentKinds(args.watchSnapshot, args.selfLogins)) {
			if (!triggerKinds.has(kind)) failures.push(`new ${kind.replace("_", " ")} does not wake a seat`);
		}
		const noChecksHang = actualClassification === "NOT_TRIGGERED"
			&& !verdict.terminalEscalation
			&& verdict.disposition === "wait";
		if (noChecksHang) failures.push("CI not triggered is an unbounded silent poll");
		const handled = evaluateWatchExit(args.watchSnapshot, {
			selfLogins: args.selfLogins,
			handledTriggerIds: (verdict.triggers ?? []).map((trigger) => trigger.id),
			reviewPolicy: CAPTAIN_REVIEW_POLICY,
		});
		const currentHumanApproved = hasHumanApproval(
			args.approvals,
			args.selfLogins,
			args.watchSnapshot.lastPushAt,
			args.watchSnapshot.headSha,
		);
		const githubReviewSatisfied = args.real.reviewDecision === "APPROVED";
		const bothApproved = githubReviewSatisfied
			&& currentHumanApproved
			&& hasClaudeApproval(args.watchSnapshot);
		if (handled.humanApprovedBy !== null && !currentHumanApproved) {
			failures.push("a human approval outside the current head can satisfy the approval gate");
		}
		if (!githubReviewSatisfied && handled.exitOk) {
			failures.push(`${args.real.reviewDecision ?? "empty review decision"} can reach the stamp after triggers are handled`);
		}
		if (bothApproved && !handled.exitOk && !handled.terminalEscalation) failures.push("human + Claude approval does not make the captain's stamp available");
		if (githubReviewSatisfied && !bothApproved && handled.exitOk) failures.push("watch exits without both human and Claude approval");
		let displayedClassification = actualClassification;
		let displayedNode = actual.node;
		let displayedAction = actual.action;
		if (args.surveyUnknown) {
			const unknownSnapshot: WatchSnapshot = {
				...args.watchSnapshot,
				mergeable: "UNKNOWN",
				mergeStateStatus: "UNKNOWN",
				behindBy: args.watchSnapshot.behindBy,
			};
			const unknownVerdict = evaluateWatchExit(unknownSnapshot, {
				selfLogins: args.selfLogins,
				handledTriggerIds: [],
				reviewPolicy: CAPTAIN_REVIEW_POLICY,
			});
			const unknownRoute = route(unknownVerdict);
			if (unknownVerdict.ciClassification !== "MERGEABILITY_STALE" || unknownVerdict.rebaseRequired) {
				failures.push("transient UNKNOWN mergeability is not treated as stale evidence");
			}
			displayedClassification = `${classification(unknownVerdict)} → ${actualClassification}`;
			displayedNode = `UNKNOWN: ${unknownRoute.node}; refreshed: ${actual.node}`;
			displayedAction = `UNKNOWN: ${unknownRoute.action}; refreshed: ${actual.action}`;
		}
		return {
			caseId: args.caseId,
			...(args.prNumber === undefined ? {} : { prNumber: args.prNumber }),
			realState: `${args.surveyUnknown ? "UNKNOWN→" : ""}${args.real.mergeable}/${args.real.reviewDecision ?? "∅"}/${expectedClassification} checks=${args.real.requiredChecks.observed}/${args.real.requiredChecks.configured}`,
			classification: displayedClassification,
			node: displayedNode,
			action: displayedAction,
			verdict: noChecksHang ? "hangs" : failures.length === 0 ? "correct" : "wrong",
			failures,
		};
	} catch (error) {
		return {
			caseId: args.caseId,
			...(args.prNumber === undefined ? {} : { prNumber: args.prNumber }),
			realState: `${args.surveyUnknown ? "UNKNOWN→" : ""}${args.real.mergeable}/${args.real.reviewDecision ?? "∅"}/unknown checks=${args.real.requiredChecks.observed}/${args.real.requiredChecks.configured}`,
			classification: "CRASH",
			node: "evaluateWatchExit",
			action: error instanceof Error ? error.message : String(error),
			verdict: "crashes",
			failures: ["watch evaluator crashes on captured GitHub state"],
		};
	}
}

export function analyzeFixture(fixture: StructuralFixture): DryRunRow {
	const hydrated = rehydrateFixture(fixture);
	return analyzeSnapshot({
		caseId: fixture.caseId,
		real: fixture.real,
		surveyUnknown: fixture.situationTags.includes("transient-unknown-observed"),
		...hydrated,
	});
}

function structuralReal(raw: RawPrCapture): StructuralFixture["real"] {
	const evidence = raw.watchSnapshot.ciEvidence!;
	const observed = evidence.requiredContexts.filter((required) =>
		raw.watchSnapshot.checkRuns.some((check) => check.name === required.context &&
			(required.integrationId === null || check.appId === required.integrationId)) ||
		evidence.statuses.some((status) => required.integrationId === null && status.context === required.context));
	return {
		state: raw.metadata.state,
		isDraft: raw.metadata.isDraft,
		mergeable: raw.metadata.mergeable,
		mergeStateStatus: raw.metadata.mergeStateStatus,
		transientMergeableObservation: raw.transientUnknownObserved ? "UNKNOWN" : null,
		reviewDecision: raw.metadata.reviewDecision,
		behindBy: raw.watchSnapshot.behindBy,
		requiredChecks: { configured: evidence.requiredContexts.length, observed: observed.length },
	};
}

export function failureRanking(rows: DryRunRow[]): Array<{ failure: string; count: number; cases: string[] }> {
	const grouped = new Map<string, string[]>();
	for (const row of rows) for (const failure of new Set(row.failures)) {
		const cases = grouped.get(failure) ?? [];
		cases.push(row.prNumber === undefined ? row.caseId : `#${row.prNumber}`);
		grouped.set(failure, cases);
	}
	return [...grouped].map(([failure, cases]) => ({ failure, count: cases.length, cases }))
		.sort((a, b) => b.count - a.count || a.failure.localeCompare(b.failure));
}

export function renderMarkdown(rows: DryRunRow[]): string {
	const escape = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
	return [
		"| PR/case | real state (mergeable/review/checks) | deck classification | node | deck action | verdict |",
		"|---|---|---|---|---|---|",
		...rows.map((row) => `| ${row.prNumber === undefined ? row.caseId : `#${row.prNumber}`} | ${escape(row.realState)} | ${row.classification} | \`${row.node}\` | ${escape(row.action)} | **${row.verdict}**${row.failures.length > 0 ? ` — ${escape(row.failures.join("; "))}` : ""} |`),
		"",
		"### Failure modes by affected case count",
		...failureRanking(rows).map((item, index) => `${index + 1}. **${item.count}/${rows.length}** — ${item.failure} (${item.cases.join(", ")})`),
	].join("\n");
}

async function loadStructuralFixtures(directory: string): Promise<StructuralFixture[]> {
	const names = (await readdir(resolve(directory))).filter((name) => /^case-\d+\.json$/.test(name)).sort();
	return Promise.all(names.map((name) => Bun.file(resolve(directory, name)).json() as Promise<StructuralFixture>));
}

async function report(args: string[]): Promise<void> {
	const rawPath = valueAfter(args, "--raw");
	const fixturesPath = valueAfter(args, "--fixtures");
	let rows: DryRunRow[];
	if (rawPath !== undefined) {
		if (insideRepo(rawPath)) throw new Error("raw report input must live outside the repository");
		const corpus = await Bun.file(resolve(rawPath)).json() as RawCorpus;
		rows = corpus.pullRequests.map((raw, index) => analyzeSnapshot({
			caseId: `case-${String(index + 1).padStart(2, "0")}`,
			prNumber: raw.metadata.number,
			real: structuralReal(raw),
			surveyUnknown: raw.transientUnknownObserved,
			watchSnapshot: raw.watchSnapshot,
			approvals: raw.approvals,
			selfLogins: raw.selfLogins,
		}));
	} else if (fixturesPath !== undefined) {
		rows = (await loadStructuralFixtures(fixturesPath)).map(analyzeFixture);
	} else usage();
	console.log(args.includes("--json")
		? JSON.stringify({ rows, failures: failureRanking(rows) }, null, 2)
		: renderMarkdown(rows));
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	switch (args[0]) {
		case "capture":
			await captureCorpus(args);
			return;
		case "sanitize": {
			const raw = valueAfter(args, "--raw");
			const outDir = valueAfter(args, "--out-dir");
			if (raw === undefined || outDir === undefined) usage();
			await sanitizeCorpus(raw, outDir);
			return;
		}
		case "report":
			await report(args);
			return;
		default:
			usage();
	}
}

if (import.meta.main) await main();
