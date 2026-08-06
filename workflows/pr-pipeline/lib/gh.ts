/**
 * GitHub adapters for real (non-dry-run) mode, plus pure parsers that are
 * unit-testable without network. All shell-outs go through the configurable
 * `gh`/`git` binaries so a crewmate can point this at gh-axi.
 */

import type { PrOverview } from "./adopt.ts";
import { signedCommentBody } from "./comments.ts";
import type {
	CheckRun,
	CiEvidence,
	CommentActivity,
	CommitStatusEvidence,
	RequiredStatusContext,
	ReviewApproval,
	ReviewerActivity,
	ReviewThread,
	WatchSnapshot,
	WorkflowJobEvidence,
	WorkflowRunEvidence,
} from "./types.ts";

const ACTIVE_WORKFLOW_STATUSES: Record<string, true> = {
	in_progress: true,
	pending: true,
	queued: true,
	requested: true,
	waiting: true,
};

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type ExecFn = (argv: string[], options?: { cwd?: string; stdin?: string }) => Promise<ExecResult>;

/**
 * Environment that keeps tool output MACHINE readable.
 *
 * `gh` colorizes and paginates when it believes a human is watching, and a
 * pipeline launched from a pane inherits exactly that belief. A single leading
 * escape byte turns every `JSON.parse` here into `Unrecognized token '\u001b'`
 * — which is how an adopt run died at `fetchPrOverview`.
 */
const MACHINE_ENV = {
	NO_COLOR: "1",
	CLICOLOR: "0",
	CLICOLOR_FORCE: "0",
	GH_FORCE_TTY: "",
	GH_PAGER: "cat",
	PAGER: "cat",
} as const;

/** Default exec via Bun.spawn. Injectable for tests. */
export const bunExec: ExecFn = async (argv, options) => {
	const proc = Bun.spawn(argv, {
		cwd: options?.cwd,
		env: { ...process.env, ...MACHINE_ENV },
		stdout: "pipe",
		stderr: "pipe",
		stdin: options?.stdin === undefined ? "ignore" : new Blob([options.stdin]),
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
};

export async function execOrThrow(exec: ExecFn, argv: string[], options?: { cwd?: string; stdin?: string }): Promise<string> {
	const result = await exec(argv, options);
	if (result.code !== 0) {
		throw new Error(`command failed (${result.code}): ${argv.join(" ")}\n${result.stderr.slice(0, 2000)}`);
	}
	return result.stdout;
}

// Belt and braces with MACHINE_ENV: a wrapper binary on PATH can still colorize
// whatever the environment says. ANSI must be removed BEFORE looking for the
// start of the JSON, because a CSI sequence contains a literal `[` and would
// otherwise be mistaken for the opening bracket of an array.
const ANSI = /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;
const JSON_START = /[[{]/;

/** Parse tool output as JSON, tolerating a decorated prefix. */
export function parseToolJson<T>(out: string, what: string): T {
	const clean = out.replace(ANSI, "").trim();
	const at = clean.search(JSON_START);
	if (at < 0) {
		throw new Error(`${what} returned no JSON: ${clean.slice(0, 200)}`);
	}
	try {
		return JSON.parse(clean.slice(at)) as T;
	} catch (error) {
		throw new Error(
			`${what} returned unparseable JSON (${error instanceof Error ? error.message : String(error)}): ${clean.slice(0, 200)}`,
		);
	}
}

/** Post an issue or pull-request comment with the configured signature. */
export async function postComment(
	ctx: { gh: string; repo: string; exec: ExecFn },
	project: string | undefined,
	issueNumber: number,
	body: string,
): Promise<void> {
	await execOrThrow(ctx.exec, [
		ctx.gh,
		"api",
		"-X",
		"POST",
		`repos/${ctx.repo}/issues/${issueNumber}/comments`,
		"-F",
		"body=@-",
	], { stdin: signedCommentBody(project, body) });
}

/** Post a reply to a pull-request review comment through the same signer. */
export async function postReviewReply(
	ctx: { gh: string; repo: string; exec: ExecFn },
	project: string | undefined,
	commentId: number,
	body: string,
): Promise<void> {
	await execOrThrow(ctx.exec, [
		ctx.gh,
		"api",
		"-X",
		"POST",
		`repos/${ctx.repo}/pulls/comments/${commentId}/replies`,
		"-F",
		"body=@-",
	], { stdin: signedCommentBody(project, body) });
}

// ---------------------------------------------------------------------------
// Pure parsers (unit-tested; consume raw GH API payloads)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function isBotAuthor(author: Record<string, unknown> | null): boolean {
	if (author === null) return true;
	const typename = str(author.__typename ?? author.type);
	if (typename.toLowerCase() === "bot") return true;
	return str(author.login).endsWith("[bot]");
}

/** GraphQL pullRequest.reviewThreads.nodes -> ReviewThread[]. */
export function parseReviewThreads(nodes: unknown): ReviewThread[] {
	if (!Array.isArray(nodes)) return [];
	const threads: ReviewThread[] = [];
	for (const node of nodes) {
		if (!isRecord(node)) continue;
		const comments = isRecord(node.comments) && Array.isArray(node.comments.nodes) ? node.comments.nodes : [];
		const last = comments.length > 0 ? comments[comments.length - 1] : null;
		const lastAuthor = isRecord(last) && isRecord(last.author) ? str(last.author.login) : null;
		threads.push({
			id: str(node.id),
			isResolved: node.isResolved === true,
			lastCommenter: lastAuthor !== null && lastAuthor !== "" ? lastAuthor : null,
		});
	}
	return threads;
}

/** REST check-runs payload -> CheckRun[]. */
export function parseCheckRuns(payload: unknown): CheckRun[] {
	if (!isRecord(payload) || !Array.isArray(payload.check_runs)) return [];
	const runs: CheckRun[] = [];
	for (const raw of payload.check_runs) {
		if (!isRecord(raw)) continue;
		const workflowName = isRecord(raw.check_suite) ? str(raw.check_suite.workflow_name) : "";
		const suiteId = isRecord(raw.check_suite) ? Number(raw.check_suite.id) : Number.NaN;
		const appId = isRecord(raw.app) ? Number(raw.app.id) : Number.NaN;
		const completedAt = raw.completed_at === null ? null : str(raw.completed_at);
		const startedAt = raw.started_at === null ? null : str(raw.started_at);
		const detailsUrl = raw.details_url === null ? null : str(raw.details_url);
		const id = Number(raw.id);
		runs.push({
			...(str(raw.head_sha) !== "" ? { headSha: str(raw.head_sha) } : {}),
			...(Number.isFinite(id) ? { id } : {}),
			name: str(raw.name),
			...(workflowName !== "" ? { workflowName } : {}),
			status: str(raw.status),
			conclusion: raw.conclusion === null ? null : str(raw.conclusion),
			...(startedAt !== "" ? { startedAt } : {}),
			...(completedAt !== "" ? { completedAt } : {}),
			...(detailsUrl !== "" ? { detailsUrl } : {}),
			...(Number.isFinite(appId) ? { appId } : {}),
			...(isRecord(raw.app) && str(raw.app.slug) !== "" ? { appSlug: str(raw.app.slug) } : {}),
			...(Number.isFinite(suiteId) ? { checkSuiteId: suiteId } : {}),
		});
	}
	return runs;
}

/** GraphQL reviews.nodes -> ReviewApproval[] (all states, latest-wins done downstream). */
export function parseReviews(nodes: unknown): ReviewApproval[] {
	if (!Array.isArray(nodes)) return [];
	const reviews: ReviewApproval[] = [];
	for (const node of nodes) {
		if (!isRecord(node)) continue;
		const author = isRecord(node.author) ? node.author : null;
		reviews.push({
			login: author !== null ? str(author.login) : "",
			isBot: isBotAuthor(author),
			state: str(node.state),
			submittedAt: str(node.submittedAt),
			...(isRecord(node.commit) && str(node.commit.oid) !== "" ? { headSha: str(node.commit.oid) } : {}),
		});
	}
	return reviews.filter((review) => review.login !== "");
}

/** GraphQL reviews + issue comments -> CommentActivity[] + ReviewerActivity[]. */
export function parseActivity(
	reviewNodes: unknown,
	commentNodes: unknown,
): { comments: CommentActivity[]; reviewers: ReviewerActivity[] } {
	const comments: CommentActivity[] = [];
	const latestByReviewer = new Map<string, ReviewerActivity>();

	if (Array.isArray(commentNodes)) {
		for (const node of commentNodes) {
			if (!isRecord(node)) continue;
			const author = isRecord(node.author) ? node.author : null;
			const login = author !== null ? str(author.login) : "";
			if (login === "") continue;
			comments.push({
				...(str(node.id) !== "" ? { id: str(node.id) } : {}),
				...(str(node.url) !== "" ? { url: str(node.url) } : {}),
				source: "issue_comment",
				author: login,
				isBot: isBotAuthor(author),
				createdAt: str(node.createdAt),
				body: str(node.body),
			});
		}
	}
	if (Array.isArray(reviewNodes)) {
		for (const node of reviewNodes) {
			if (!isRecord(node)) continue;
			const author = isRecord(node.author) ? node.author : null;
			const login = author !== null ? str(author.login) : "";
			if (login === "") continue;
			const submittedAt = str(node.submittedAt);
			if (str(node.body) !== "") {
				comments.push({
					...(str(node.id) !== "" ? { id: str(node.id) } : {}),
					...(str(node.url) !== "" ? { url: str(node.url) } : {}),
					source: "review",
					author: login,
					isBot: isBotAuthor(author),
					createdAt: submittedAt,
					body: str(node.body),
				});
			}
			const prior = latestByReviewer.get(login.toLowerCase());
			if (prior === undefined || submittedAt > prior.lastActivityAt) {
				latestByReviewer.set(login.toLowerCase(), {
					login,
					isBot: isBotAuthor(author),
					lastActivityAt: submittedAt,
					...(isRecord(node.commit) && str(node.commit.oid) !== "" ? { headSha: str(node.commit.oid) } : {}),
					lastReviewState: str(node.state) !== "" ? str(node.state) : null,
				});
			}
		}
	}
	return { comments, reviewers: [...latestByReviewer.values()] };
}

/** Inline review comments are watch triggers too; keep stable thread/REST ids. */
export function parseThreadComments(nodes: unknown): CommentActivity[] {
	if (!Array.isArray(nodes)) return [];
	const comments: CommentActivity[] = [];
	for (const thread of nodes) {
		if (!isRecord(thread) || !isRecord(thread.comments) || !Array.isArray(thread.comments.nodes)) continue;
		for (const node of thread.comments.nodes) {
			if (!isRecord(node)) continue;
			const author = isRecord(node.author) ? node.author : null;
			const login = author !== null ? str(author.login) : "";
			if (login === "") continue;
			const databaseId = Number(node.databaseId);
			comments.push({
				...(str(node.id) !== "" ? { id: str(node.id) } : {}),
				...(Number.isFinite(databaseId) ? { databaseId } : {}),
				...(str(node.url) !== "" ? { url: str(node.url) } : {}),
				source: "review_comment",
				threadId: str(thread.id),
				author: login,
				isBot: isBotAuthor(author),
				createdAt: str(node.createdAt),
				body: str(node.body),
			});
		}
	}
	return comments;
}

/** requested_reviewers REST payload -> logins. */
export function parseRequestedReviewers(payload: unknown): string[] {
	if (!isRecord(payload) || !Array.isArray(payload.users)) return [];
	return payload.users
		.map((user) => (isRecord(user) ? str(user.login) : ""))
		.filter((login) => login !== "");
}

// ---------------------------------------------------------------------------
// Real-mode fetchers (thin shells around gh; not unit-tested, integration only)
// ---------------------------------------------------------------------------

export interface GhContext {
	gh: string;
	repo: string; // owner/name
	exec?: ExecFn;
}

const WATCH_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      headRefName
      mergeable
      mergeStateStatus
      baseRefOid
      baseRefName
      reviewDecision
      commits(last: 1) { nodes { commit { committedDate } } }
      reviewThreads(last: 100) {
        nodes {
          id
          isResolved
          comments(last: 100) {
            nodes { id databaseId url createdAt body author { login __typename } }
          }
        }
      }
      reviews(last: 100) {
        nodes { id url author { login __typename } state submittedAt body commit { oid } }
      }
      comments(last: 100) {
        nodes { id url author { login __typename } createdAt body }
      }
    }
  }
}`;

export async function fetchBranchCheckRuns(ctx: GhContext, branch: string): Promise<CheckRun[]> {
	const exec = ctx.exec ?? bunExec;
	const endpoint = `repos/${ctx.repo}/commits/${encodeURIComponent(branch)}/check-runs?per_page=100`;
	const runs: CheckRun[] = [];
	for (let page = 1; ; page += 1) {
		const out = await execOrThrow(exec, [
			ctx.gh,
			"api",
			page === 1 ? endpoint : `${endpoint}&page=${page}`,
		]);
		const payload: unknown = parseToolJson(out, "gh");
		if (!isRecord(payload) || !Array.isArray(payload.check_runs)) {
			throw new Error(`GitHub returned invalid check-run page ${page} for ${branch}`);
		}
		runs.push(...parseCheckRuns(payload));
		if (payload.check_runs.length < 100) return runs;
	}
}

async function fetchCommitStatuses(ctx: GhContext, headSha: string): Promise<CommitStatusEvidence[]> {
	const exec = ctx.exec ?? bunExec;
	const endpoint = `repos/${ctx.repo}/commits/${headSha}/status?per_page=100`;
	const statuses: CommitStatusEvidence[] = [];
	for (let page = 1; ; page += 1) {
		const out = await execOrThrow(exec, [
			ctx.gh,
			"api",
			page === 1 ? endpoint : `${endpoint}&page=${page}`,
		]);
		const payload: unknown = parseToolJson(out, "gh");
		if (!isRecord(payload) || !Array.isArray(payload.statuses)) {
			throw new Error(`GitHub returned invalid commit-status page ${page} for ${headSha}`);
		}
		statuses.push(...parseCommitStatuses(payload));
		if (payload.statuses.length < 100) return statuses;
	}
}

async function fetchPullWorkflowRuns(ctx: GhContext, branch: string): Promise<RawWorkflowRun[]> {
	const exec = ctx.exec ?? bunExec;
	const endpoint = `repos/${ctx.repo}/actions/runs?branch=${encodeURIComponent(branch)}&event=pull_request&per_page=100`;
	const runs: RawWorkflowRun[] = [];
	for (let page = 1; ; page += 1) {
		const out = await execOrThrow(exec, [
			ctx.gh,
			"api",
			page === 1 ? endpoint : `${endpoint}&page=${page}`,
		]);
		const payload: unknown = parseToolJson(out, "gh");
		if (!isRecord(payload) || !Array.isArray(payload.workflow_runs)) {
			throw new Error(`GitHub returned invalid workflow-run page ${page} for ${branch}`);
		}
		runs.push(...parseWorkflowRuns(payload));
		if (payload.workflow_runs.length < 100) return runs;
	}
}
export function parseRequiredContexts(payload: unknown): RequiredStatusContext[] {
	const rules = Array.isArray(payload)
		? payload
		: isRecord(payload) && Array.isArray(payload.rules)
			? payload.rules
			: [];
	const contexts: RequiredStatusContext[] = [];
	for (const rule of rules) {
		if (!isRecord(rule) || str(rule.type) !== "required_status_checks" || !isRecord(rule.parameters)) continue;
		const checks = Array.isArray(rule.parameters.required_status_checks)
			? rule.parameters.required_status_checks
			: [];
		for (const check of checks) {
			if (!isRecord(check) || str(check.context) === "") continue;
			const integrationId = check.integration_id === null || check.integration_id === undefined
				? null
				: Number(check.integration_id);
			contexts.push({
				context: str(check.context),
				integrationId: integrationId !== null && Number.isFinite(integrationId)
					? integrationId
					: null,
			});
		}
	}
	return [...new Map(contexts.map((context) => [
		`${context.context}:${context.integrationId ?? "any"}`,
		context,
	])).values()];
}

export function parseCommitStatuses(payload: unknown): CommitStatusEvidence[] {
	if (!isRecord(payload) || !Array.isArray(payload.statuses)) return [];
	return payload.statuses.flatMap((status) => {
		if (!isRecord(status)) return [];
		const id = Number(status.id);
		if (!Number.isFinite(id) || str(status.context) === "") return [];
		return [{
			id,
			context: str(status.context),
			state: str(status.state),
			createdAt: str(status.created_at),
			updatedAt: str(status.updated_at),
			targetUrl: status.target_url === null ? null : str(status.target_url),
		}];
	});
}

interface RawWorkflowRun {
	id: number;
	checkSuiteId: number;
	headSha: string;
	status: string;
	conclusion: string | null;
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	url: string;
	pullRequests: Array<{ number: number; baseRef: string; headSha: string }>;
}

function parseWorkflowRuns(payload: unknown): RawWorkflowRun[] {
	if (!isRecord(payload) || !Array.isArray(payload.workflow_runs)) return [];
	return payload.workflow_runs.flatMap((run) => {
		if (!isRecord(run)) return [];
		const id = Number(run.id);
		const checkSuiteId = Number(run.check_suite_id);
		if (!Number.isFinite(id) || !Number.isFinite(checkSuiteId)) return [];
		const pulls = Array.isArray(run.pull_requests) ? run.pull_requests : [];
		return [{
			id,
			checkSuiteId,
			headSha: str(run.head_sha),
			status: str(run.status),
			conclusion: run.conclusion === null ? null : str(run.conclusion),
			createdAt: str(run.created_at),
			updatedAt: str(run.updated_at),
			startedAt: run.run_started_at === null ? null : str(run.run_started_at),
			url: str(run.html_url),
			pullRequests: pulls.flatMap((pull) => {
				if (!isRecord(pull)) return [];
				const number = Number(pull.number);
				const baseRef = isRecord(pull.base) ? str(pull.base.ref) : "";
				const headSha = isRecord(pull.head) ? str(pull.head.sha) : "";
				return Number.isFinite(number) ? [{ number, baseRef, headSha }] : [];
			}),
		}];
	});
}

function parseWorkflowJobs(payload: unknown): WorkflowJobEvidence[] {
	if (!isRecord(payload) || !Array.isArray(payload.jobs)) return [];
	return payload.jobs.flatMap((job) => {
		if (!isRecord(job)) return [];
		const id = Number(job.id);
		if (!Number.isFinite(id)) return [];
		const steps = Array.isArray(job.steps)
			? job.steps.flatMap((step) => !isRecord(step) ? [] : [{
					name: str(step.name),
					status: str(step.status),
					conclusion: step.conclusion === null ? null : str(step.conclusion),
				}])
			: [];
		return [{
			id,
			name: str(job.name),
			status: str(job.status),
			conclusion: job.conclusion === null ? null : str(job.conclusion),
			startedAt: job.started_at === null ? null : str(job.started_at),
			completedAt: job.completed_at === null ? null : str(job.completed_at),
			url: str(job.html_url),
			steps,
		}];
	});
}

export async function resolveRequiredContexts(
	ctx: Required<GhContext>,
	startingBranch: string,
): Promise<{ requiredContexts: RequiredStatusContext[]; rulesBranch: string }> {
	const [owner] = ctx.repo.split("/");
	const visited = new Set<string>();
	let branch = startingBranch;
	while (branch !== "" && !visited.has(branch)) {
		visited.add(branch);
		// The rulesets API is a paid feature: a private repo on a free plan answers
		// 403 "Upgrade to GitHub Pro ... to enable this feature". That means the
		// repo CANNOT have rulesets, not that the read failed, and treating it as
		// an error killed the watch poll outright.
		//
		// Match that response and nothing else. A bare 403 or 404 is an auth,
		// scope, or wrong-repo problem, and "no required contexts" is exactly the
		// answer that lets a merge proceed on observed checks alone — so every
		// other failure stays fatal rather than silently widening the gate.
		const rules = await ctx.exec([
			ctx.gh,
			"api",
			`repos/${ctx.repo}/rules/branches/${encodeURIComponent(branch)}`,
		]);
		if (rules.code !== 0) {
			const planLimited = /Upgrade to GitHub Pro[\s\S]*enable this feature/i.test(rules.stderr);
			if (!planLimited) {
				throw new Error(`command failed (${rules.code}): ${ctx.gh} api rules/branches\n${rules.stderr.slice(0, 2000)}`);
			}
			return { requiredContexts: [], rulesBranch: branch };
		}
		const requiredContexts = parseRequiredContexts(parseToolJson(rules.stdout, "gh"));
		if (requiredContexts.length > 0) return { requiredContexts, rulesBranch: branch };
		const parentsOut = await execOrThrow(ctx.exec, [
			ctx.gh,
			"api",
			`repos/${ctx.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`,
		]);
		const parents = parseToolJson(parentsOut, "gh");
		if (!Array.isArray(parents)) throw new Error(`GitHub returned invalid parent PR data for ${branch}`);
		const matching = parents.filter((candidate) =>
			isRecord(candidate)
			&& isRecord(candidate.head)
			&& str(candidate.head.ref) === branch
			&& isRecord(candidate.head.repo)
			&& str(candidate.head.repo.full_name).toLowerCase() === ctx.repo.toLowerCase()
		);
		if (matching.length === 0) return { requiredContexts: [], rulesBranch: branch };
		if (matching.length > 1) throw new Error(`Multiple open PRs use ${branch} as their head`);
		const parent = matching[0];
		branch = isRecord(parent) && isRecord(parent.base) ? str(parent.base.ref) : "";
	}
	if (branch === "") return { requiredContexts: [], rulesBranch: startingBranch };
	throw new Error(`PR parent cycle detected at ${branch}`);
}

async function fetchWorkflowJobs(
	ctx: Required<GhContext>,
	runId: number,
): Promise<WorkflowJobEvidence[]> {
	const endpoint = `repos/${ctx.repo}/actions/runs/${runId}/jobs?per_page=100`;
	const jobs: WorkflowJobEvidence[] = [];
	for (let page = 1; ; page += 1) {
		const out = await execOrThrow(ctx.exec, [
			ctx.gh,
			"api",
			page === 1 ? endpoint : `${endpoint}&page=${page}`,
		]);
		const payload: unknown = parseToolJson(out, "gh");
		if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
			throw new Error(`GitHub returned invalid workflow-job page ${page} for run ${runId}`);
		}
		jobs.push(...parseWorkflowJobs(payload));
		if (payload.jobs.length < 100) return jobs;
	}
}

async function workflowEvidence(
	ctx: Required<GhContext>,
	runs: RawWorkflowRun[],
): Promise<WorkflowRunEvidence[]> {
	return Promise.all(runs.map(async (run) => {
		const parsedJobs = await fetchWorkflowJobs(ctx, run.id);
		const jobs = await Promise.all(parsedJobs.map(async (job) => {
			if (!["failure", "cancelled", "timed_out"].includes((job.conclusion ?? "").toLowerCase())) return job;
			try {
				const log = await execOrThrow(ctx.exec, [
					ctx.gh,
					"api",
					`repos/${ctx.repo}/actions/jobs/${job.id}/logs`,
				]);
				return { ...job, logExcerpt: log.slice(-32_000) };
			} catch {
				return job;
			}
		}));
		const { pullRequests: _pullRequests, ...evidence } = run;
		return { ...evidence, jobs };
	}));
}

export async function fetchWatchSnapshot(ctx: GhContext, prNumber: number, _selfLogins: string[]): Promise<WatchSnapshot> {
	const exec = ctx.exec ?? bunExec;
	const concreteCtx: Required<GhContext> = { ...ctx, exec };
	const [owner, name] = ctx.repo.split("/");
	const gqlOut = await execOrThrow(exec, [
		ctx.gh, "api", "graphql",
		"-f", `query=${WATCH_QUERY}`,
		"-f", `owner=${owner}`,
		"-f", `name=${name}`,
		"-F", `number=${prNumber}`,
	]);
	const gql = parseToolJson(gqlOut, "gh") as Record<string, any>;
	const pr = gql?.data?.repository?.pullRequest ?? {};
	const headSha = str(pr.headRefOid);
	const headRef = str(pr.headRefName);
	const baseRef = str(pr.baseRefName);
	if (headSha === "" || headRef === "" || baseRef === "") {
		throw new Error(`GitHub returned an incomplete identity for PR #${prNumber}`);
	}

	const [
		requestedOut,
		checkRuns,
		statuses,
		workflowRuns,
		requiredResolution,
	] = await Promise.all([
		execOrThrow(exec, [
			ctx.gh,
			"api",
			`repos/${ctx.repo}/pulls/${prNumber}/requested_reviewers`,
		]),
		fetchBranchCheckRuns(concreteCtx, headSha),
		fetchCommitStatuses(concreteCtx, headSha),
		fetchPullWorkflowRuns(concreteCtx, headRef),
		resolveRequiredContexts(concreteCtx, baseRef),
	]);
	const requested = parseRequestedReviewers(parseToolJson(requestedOut, "gh"));
	const currentRawRuns = workflowRuns.filter((run) =>
		run.headSha === headSha
		&& run.pullRequests.some((pull) =>
			pull.number === prNumber
			&& pull.baseRef === baseRef
			&& pull.headSha === headSha
		)
	);
	const currentIds = new Set(currentRawRuns.map((run) => run.id));
	const staleActiveRawRuns = workflowRuns.filter((run) =>
		!currentIds.has(run.id) && ACTIVE_WORKFLOW_STATUSES[run.status] === true
	);
	const [currentRuns, staleActiveRuns] = await Promise.all([
		workflowEvidence(concreteCtx, currentRawRuns),
		workflowEvidence(concreteCtx, staleActiveRawRuns),
	]);

	let behindBy = 0;
	try {
		const compareOut = await execOrThrow(exec, [
			ctx.gh,
			"api",
			`repos/${ctx.repo}/compare/${encodeURIComponent(baseRef)}...${headSha}`,
		]);
		const parsedCompare = parseToolJson<Record<string, unknown>>(compareOut, "gh");
		const parsedBehindBy = Number(parsedCompare.behind_by ?? 0);
		if (Number.isFinite(parsedBehindBy)) behindBy = parsedBehindBy;
	} catch {
		// Compare is supplementary. A force-push can briefly make it 404; the
		// exact-head identity and GitHub mergeability response remain primary.
		behindBy = 0;
	}

	const lastPushAt = str(pr?.commits?.nodes?.[0]?.commit?.committedDate);
	const lastPushMs = Date.parse(lastPushAt);
	const graceSeconds = 150;
	const currentHeadAgeSeconds = Number.isFinite(lastPushMs)
		? Math.max(0, Math.floor((Date.now() - lastPushMs) / 1000))
		: graceSeconds + 1;
	const { comments, reviewers } = parseActivity(pr?.reviews?.nodes, pr?.comments?.nodes);
	const threadComments = parseThreadComments(pr?.reviewThreads?.nodes);
	const ciEvidence: CiEvidence = {
		requiredContexts: requiredResolution.requiredContexts,
		rulesBranch: requiredResolution.rulesBranch,
		graceSeconds,
		currentHeadAgeSeconds,
		currentRuns,
		staleActiveRuns,
		statuses,
	};

	return {
		headSha,
		mergeable: pr.mergeable === "MERGEABLE" || pr.mergeable === "CONFLICTING" ? pr.mergeable : "UNKNOWN",
		mergeStateStatus: str(pr.mergeStateStatus),
		behindBy,
		lastPushAt,
		threads: parseReviewThreads(pr?.reviewThreads?.nodes),
		comments: [...comments, ...threadComments],
		reviewers,
		reviewDecision: str(pr.reviewDecision) || null,
		requestedReviewers: requested,
		checkRuns,
		ciEvidence,
	};
}

export async function fetchChangedFiles(ctx: GhContext, prNumber: number): Promise<string[]> {
	const exec = ctx.exec ?? bunExec;
	const out = await execOrThrow(exec, [
		ctx.gh, "api", `repos/${ctx.repo}/pulls/${prNumber}/files?per_page=100`, "--paginate",
		"--jq", ".[].filename",
	]);
	return out.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

export async function fetchPrApprovalsAndCi(ctx: GhContext, prNumber: number): Promise<{
	approvals: ReviewApproval[];
	checkRuns: CheckRun[];
	headSha: string;
}> {
	const exec = ctx.exec ?? bunExec;
	const [owner, name] = ctx.repo.split("/");
	const gqlOut = await execOrThrow(exec, [
		ctx.gh, "api", "graphql",
		"-f", `query=${WATCH_QUERY}`,
		"-f", `owner=${owner}`,
		"-f", `name=${name}`,
		"-F", `number=${prNumber}`,
	]);
	const gql = parseToolJson(gqlOut, "gh") as Record<string, any>;
	const pr = gql?.data?.repository?.pullRequest ?? {};
	const headSha = str(pr.headRefOid);
	const checkRuns = await fetchBranchCheckRuns({ ...ctx, exec }, headSha);
	return {
		approvals: parseReviews(pr?.reviews?.nodes),
		checkRuns,
		headSha,
	};
}

/** Raw CODEOWNERS content, or null when the repo has none (lindy's may be thin). */
export async function fetchCodeowners(ctx: GhContext): Promise<string | null> {
	const exec = ctx.exec ?? bunExec;
	for (const path of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
		const result = await exec([
			ctx.gh, "api", `repos/${ctx.repo}/contents/${path}`,
			"-H", "Accept: application/vnd.github.raw+json",
		]);
		if (result.code === 0) return result.stdout;
	}
	return null;
}

/**
 * One login per recent commit touching the given files (repeats = frequency).
 * Uses the commits API so we get LOGINS, not display names - the
 * gh-reviewer-lookup lesson: git log gives names, only the API author.login
 * is requestable.
 */
export async function fetchRecentAuthors(
	ctx: GhContext,
	files: string[],
	perFile = 15,
): Promise<string[]> {
	const exec = ctx.exec ?? bunExec;
	const authors: string[] = [];
	// ponytail: serial per-file fetch capped at 20 files; parallelize if PRs outgrow it
	for (const file of files.slice(0, 20)) {
		const result = await exec([
			ctx.gh, "api",
			`repos/${ctx.repo}/commits?path=${encodeURIComponent(file)}&per_page=${perFile}`,
			"--jq", ".[].author.login // empty",
		]);
		if (result.code !== 0) continue;
		for (const line of result.stdout.split("\n")) {
			const login = line.trim();
			if (login !== "") authors.push(login);
		}
	}
	return authors;
}

/**
 * Name-or-login -> verified login (gh-reviewer-lookup pattern). An entry that
 * already IS a login verifies via /users; otherwise search recent commit
 * authors by display name and take the commit's author.login.
 */
export async function resolveReviewerLogin(
	ctx: GhContext,
	nameOrLogin: string,
): Promise<string | null> {
	const exec = ctx.exec ?? bunExec;
	// Only a plausible login goes to /users (a display name with spaces would
	// mangle the URL path).
	if (/^[A-Za-z0-9-]+$/.test(nameOrLogin)) {
		const direct = await exec([ctx.gh, "api", `users/${nameOrLogin}`, "--jq", ".login"]);
		if (direct.code === 0 && direct.stdout.trim() !== "") return direct.stdout.trim();
	}
	// Filter in TS, not jq: the name is untrusted input to a jq program.
	const search = await exec([ctx.gh, "api", `repos/${ctx.repo}/commits?per_page=100`]);
	if (search.code !== 0) return null;
	const needle = nameOrLogin.toLowerCase();
	let commits: unknown;
	try {
		commits = parseToolJson(search.stdout, "gh");
	} catch {
		return null;
	}
	if (!Array.isArray(commits)) return null;
	for (const commit of commits) {
		if (!isRecord(commit) || !isRecord(commit.commit)) continue;
		const authorMeta = isRecord(commit.commit.author) ? commit.commit.author : null;
		const name = authorMeta !== null ? str(authorMeta.name).toLowerCase() : "";
		if (name === "" || !name.includes(needle)) continue;
		const login = isRecord(commit.author) ? str(commit.author.login) : "";
		if (login !== "") return login;
	}
	return null;
}

/** Check repository collaboration before requesting a review. */
export async function isCollaborator(ctx: GhContext, login: string): Promise<boolean> {
	const exec = ctx.exec ?? bunExec;
	const result = await exec([ctx.gh, "api", `repos/${ctx.repo}/collaborators/${login}`]);
	if (result.code === 0) return true;
	if (/\b404\b|not found/i.test(`${result.stderr}\n${result.stdout}`)) return false;
	throw new Error(`collaborator check failed for ${login}: ${result.stderr || result.stdout || `exit ${result.code}`}`);
}

/** POST review requests. GH silently drops unknown logins - always verify after. */
export async function requestReviewers(
	ctx: GhContext,
	prNumber: number,
	reviewers: string[],
): Promise<void> {
	const exec = ctx.exec ?? bunExec;
	await execOrThrow(exec, [
		ctx.gh, "api", "-X", "POST", `repos/${ctx.repo}/pulls/${prNumber}/requested_reviewers`,
		...reviewers.flatMap((login) => ["-f", `reviewers[]=${login}`]),
	]);
}

/** Live requested_reviewers logins (the silent-no-op verification read). */
export async function fetchRequestedReviewers(ctx: GhContext, prNumber: number): Promise<string[]> {
	const exec = ctx.exec ?? bunExec;
	const out = await execOrThrow(exec, [
		ctx.gh, "api", `repos/${ctx.repo}/pulls/${prNumber}/requested_reviewers`,
	]);
	return parseRequestedReviewers(parseToolJson(out, "gh"));
}

/** Overview of an existing PR (adopt path: verify + seed, never create). */
export async function fetchPrOverview(ctx: GhContext, prNumber: number): Promise<PrOverview> {
	const exec = ctx.exec ?? bunExec;
	const out = await execOrThrow(exec, [ctx.gh, "api", `repos/${ctx.repo}/pulls/${prNumber}`]);
	const payload = parseToolJson(out, "gh") as {
		number: number;
		html_url: string;
		state: string;
		draft?: boolean;
		head: { ref: string; sha: string; repo: { full_name: string } | null };
		base: { ref: string };
	};
	return {
		number: payload.number,
		url: payload.html_url,
		state: payload.state,
		draft: payload.draft === true,
		headRefName: payload.head.ref,
		headSha: payload.head.sha,
		baseRefName: payload.base.ref,
		// head.repo is null when the fork was deleted - that PR is not adoptable
		// either way, so an empty name fails the same-repo check downstream.
		headRepoFullName: payload.head.repo?.full_name ?? "",
	};
}

/** Current head SHA of the PR (stamp-validity check). */
export interface PrLifecycle {
	state: "open" | "closed";
	merged: boolean;
	autoMergeRequest: boolean;
	baseBranch: string;
}

/** Read queue state. `merged` is intentionally not used to prove landing. */
export async function fetchPrLifecycle(ctx: GhContext, prNumber: number): Promise<PrLifecycle> {
	const exec = ctx.exec ?? bunExec;
	const out = await execOrThrow(exec, [ctx.gh, "api", `repos/${ctx.repo}/pulls/${prNumber}`]);
	const payload = parseToolJson(out, "gh") as { state?: unknown; merged?: unknown; auto_merge?: unknown; base?: { ref?: unknown } };
	return {
		state: payload.state === "closed" ? "closed" : "open",
		merged: payload.merged === true,
		autoMergeRequest: payload.auto_merge !== null && payload.auto_merge !== undefined,
		baseBranch: str(payload.base?.ref),
	};
}

export async function fetchHeadSha(ctx: GhContext, prNumber: number): Promise<string> {
	const exec = ctx.exec ?? bunExec;
	const out = await execOrThrow(exec, [
		ctx.gh, "api", `repos/${ctx.repo}/pulls/${prNumber}`, "--jq", ".head.sha",
	]);
	return out.trim();
}

/** Recent commit subjects on the PR base branch (landing verification). */
export async function fetchBaseCommitSubjects(
	git: string,
	worktree: string,
	baseBranch: string,
	limit = 200,
	exec: ExecFn = bunExec,
): Promise<Array<{ sha: string; subject: string }>> {
	await execOrThrow(exec, [git, "fetch", "origin", baseBranch], { cwd: worktree });
	const out = await execOrThrow(
		exec,
		[git, "log", `origin/${baseBranch}`, `--max-count=${limit}`, "--format=%H%x09%s"],
		{ cwd: worktree },
	);
	return out
		.split("\n")
		.filter((line) => line.includes("\t"))
		.map((line) => {
			const [sha, ...rest] = line.split("\t");
			return { sha, subject: rest.join("\t") };
		});
}
