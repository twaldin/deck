import { z } from "zod";
import {
	type Bucket,
	type CiState,
	type PrItem,
	type ReviewDecision,
} from "./schema";

/**
 * Everything the poller needs from GitHub, behind an interface so the diff
 * engine and GitHub merge queue-resolution tests run against mocks, never the live API.
 */
export interface GithubClient {
	/** All open PRs matching one search bucket (already-deduped nodes). */
	searchOpenPrs(query: string): Promise<RawPr[]>;
	/** Point lookup for a PR that fell out of the open search. */
	lookupPr(repo: string, number: number): Promise<PrLookup | null>;
	/**
	 * Search the repository's DEFAULT BRANCH for a squash commit whose headline
	 * carries the "(#N)" suffix GitHub merge queue/GitHub squash-merges append. GitHub
	 * commit search only indexes the default branch, which is exactly the
	 * landing target we need to check.
	 *
	 * MUST throw on API failure (auth, rate limit, network): null means
	 * "confirmed absent", never "could not check" — conflating the two turns
	 * transient API errors into false closed-without-landing alarms.
	 */
	findSquashCommit(repo: string, number: number): Promise<string | null>;
}

export interface RawPr {
	url: string;
	repo: string;
	number: number;
	title: string;
	author: string;
	isDraft: boolean;
	ci: CiState;
	reviewDecision: ReviewDecision;
	requestedReviewers: string[];
	baseRef: string;
	headRef: string;
	updatedAt: string;
}

export interface PrLookup {
	state: "open" | "closed" | "merged";
	mergedAt: string | null;
}

const searchNodeSchema = z.object({
	__typename: z.string().optional(),
	url: z.string(),
	number: z.number(),
	title: z.string(),
	isDraft: z.boolean(),
	updatedAt: z.string(),
	baseRefName: z.string(),
	headRefName: z.string(),
	author: z.object({ login: z.string() }).nullable(),
	repository: z.object({ nameWithOwner: z.string() }),
	reviewDecision: z.string().nullable(),
	reviewRequests: z.object({
		nodes: z.array(
			z.object({
				requestedReviewer: z
					.union([z.object({ login: z.string() }), z.object({ name: z.string() }), z.object({}).strict()])
					.nullable(),
			}),
		),
	}),
	commits: z.object({
		nodes: z.array(
			z.object({
				commit: z.object({
					statusCheckRollup: z.object({ state: z.string() }).nullable(),
				}),
			}),
		),
	}),
});

const searchResponseSchema = z.object({
	data: z.object({
		search: z.object({
			pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
			nodes: z.array(z.unknown()),
		}),
	}),
});

const lookupResponseSchema = z.object({
	data: z.object({
		repository: z
			.object({
				pullRequest: z
					.object({
						state: z.enum(["OPEN", "CLOSED", "MERGED"]),
						mergedAt: z.string().nullable(),
					})
					.nullable(),
			})
			.nullable(),
	}),
});

const commitSearchResponseSchema = z.object({
	items: z.array(
		z.object({
			sha: z.string(),
			commit: z.object({ message: z.string() }),
		}),
	),
});

const SEARCH_QUERY = `
query($q: String!, $cursor: String) {
	search(query: $q, type: ISSUE, first: 50, after: $cursor) {
		pageInfo { hasNextPage endCursor }
		nodes {
			... on PullRequest {
				__typename
				url
				number
				title
				isDraft
				updatedAt
				baseRefName
				headRefName
				author { login }
				repository { nameWithOwner }
				reviewDecision
				reviewRequests(first: 20) {
					nodes {
						requestedReviewer {
							... on User { login }
							... on Team { name }
						}
					}
				}
				commits(last: 1) {
					nodes { commit { statusCheckRollup { state } } }
				}
			}
		}
	}
}`;

const LOOKUP_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
	repository(owner: $owner, name: $name) {
		pullRequest(number: $number) { state mergedAt }
	}
}`;

function mapCi(rollup: string | null): CiState {
	switch (rollup) {
		case "SUCCESS":
			return "passing";
		case "FAILURE":
		case "ERROR":
			return "failing";
		case "PENDING":
		case "EXPECTED":
			return "pending";
		default:
			return "none";
	}
}

function mapReviewDecision(decision: string | null): ReviewDecision {
	switch (decision) {
		case "APPROVED":
			return "approved";
		case "CHANGES_REQUESTED":
			return "changes-requested";
		case "REVIEW_REQUIRED":
			return "review-required";
		default:
			return "none";
	}
}

/**
 * gh subprocess failure; carries any JSON stdout payload so callers can
 * distinguish GraphQL NOT_FOUND (well-formed data payload) from
 * transport/auth failures.
 */
export class GhError extends Error {
	readonly payload: unknown;

	constructor(message: string, payload: unknown) {
		super(message);
		this.payload = payload;
	}
}

async function runGh(args: string[], stdin?: string): Promise<string> {
	const processHandle = Bun.spawn(["gh", ...args], {
		stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
		processHandle.exited,
	]);
	if (exitCode !== 0) {
		let payload: unknown = null;
		try {
			payload = JSON.parse(stdout);
		} catch {
			// not JSON — transport-level failure
		}
		throw new GhError(`gh ${args[0]} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`, payload);
	}
	return stdout;
}

async function graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
	const body = JSON.stringify({ query, variables });
	const stdout = await runGh(["api", "graphql", "--input", "-"], body);
	return JSON.parse(stdout);
}

/** Real client: shells out to `gh` and rides the ambient gh login. */
export class GhCliClient implements GithubClient {
	async searchOpenPrs(query: string): Promise<RawPr[]> {
		const out: RawPr[] = [];
		let cursor: string | null = null;
		for (;;) {
			const raw = await graphql(SEARCH_QUERY, { q: query, cursor });
			const parsed = searchResponseSchema.parse(raw);
			for (const node of parsed.data.search.nodes) {
				const pr = searchNodeSchema.safeParse(node);
				if (!pr.success) {
					continue; // non-PR node (issue) or partially-permissioned result
				}
				const data = pr.data;
				const reviewers: string[] = [];
				for (const request of data.reviewRequests.nodes) {
					const reviewer = request.requestedReviewer;
					if (reviewer !== null && "login" in reviewer) {
						reviewers.push(reviewer.login);
					} else if (reviewer !== null && "name" in reviewer) {
						reviewers.push(`team:${reviewer.name}`);
					}
				}
				out.push({
					url: data.url,
					repo: data.repository.nameWithOwner,
					number: data.number,
					title: data.title,
					author: data.author?.login ?? "ghost",
					isDraft: data.isDraft,
					ci: mapCi(data.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null),
					reviewDecision: mapReviewDecision(data.reviewDecision),
					requestedReviewers: reviewers.sort(),
					baseRef: data.baseRefName,
					headRef: data.headRefName,
					updatedAt: data.updatedAt,
				});
			}
			const page = parsed.data.search.pageInfo;
			if (!page.hasNextPage || page.endCursor === null) {
				return out;
			}
			cursor = page.endCursor;
		}
	}

	async lookupPr(repo: string, number: number): Promise<PrLookup | null> {
		const [owner, name] = repo.split("/");
		// Errors propagate: a failed lookup must fail the poll, not report
		// "vanished". Only a well-formed "this PR/repo does not exist" response
		// returns null. gh exits non-zero on GraphQL NOT_FOUND errors, so
		// distinguish that case by parsing its stdout payload.
		let raw: unknown;
		try {
			raw = await graphql(LOOKUP_QUERY, { owner, name, number });
		} catch (error) {
			if (error instanceof GhError && error.payload !== null) {
				const parsedError = lookupResponseSchema.safeParse(error.payload);
				if (parsedError.success) {
					// Valid response shape with repository/pullRequest null: genuinely gone.
					raw = error.payload;
				} else {
					throw error;
				}
			} else {
				throw error;
			}
		}
		const parsed = lookupResponseSchema.parse(raw);
		const pr = parsed.data.repository?.pullRequest ?? null;
		if (pr === null) {
			return null;
		}
		const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open";
		return { state, mergedAt: pr.mergedAt };
	}

	async findSquashCommit(repo: string, number: number): Promise<string | null> {
		// GitHub commit search only indexes the default branch — exactly the
		// question we are asking ("did (#N) land on main?"). Errors propagate
		// (see interface contract). Paginated: null is only returned after every
		// page has been inspected, so "confirmed absent" really is confirmed.
		const query = encodeURIComponent(`repo:${repo} "(#${number})"`);
		const perPage = 50;
		const maxPages = 10; // 500 commits mentioning (#N); far beyond any real case
		for (let page = 1; page <= maxPages; page += 1) {
			const stdout = await runGh(["api", `/search/commits?q=${query}&per_page=${perPage}&page=${page}`]);
			const parsed = commitSearchResponseSchema.parse(JSON.parse(stdout));
			const sha = pickSquashCommit(
				parsed.items.map((item) => ({ sha: item.sha, message: item.commit.message })),
				number,
			);
			if (sha !== null) {
				return sha;
			}
			if (parsed.items.length < perPage) {
				return null;
			}
		}
		return null;
	}
}

/**
 * Pure matcher, exported for tests: a squash-landing commit's headline (first
 * line) ends with "(#N)". Body mentions of #N (e.g. "reverts #N", stack
 * references) do not count.
 */
export function pickSquashCommit(
	commits: Array<{ sha: string; message: string }>,
	number: number,
): string | null {
	const suffix = `(#${number})`;
	for (const commit of commits) {
		const headline = commit.message.split("\n", 1)[0] ?? "";
		if (headline.trimEnd().endsWith(suffix)) {
			return commit.sha;
		}
	}
	return null;
}

/** Build the two search queries for a login across the configured scopes. */
export function buildSearchQueries(login: string, scopes: string[]): { bucket: Bucket; query: string }[] {
	const scopeExpr = scopes.join(" ");
	return [
		{ bucket: "my-pr", query: `is:pr is:open author:${login} archived:false ${scopeExpr}`.trim() },
		{ bucket: "review-owed", query: `is:pr is:open review-requested:${login} archived:false ${scopeExpr}`.trim() },
	];
}

/** Merge bucketed search results into canonical PrItems keyed by url. */
export function mergeBuckets(results: Array<{ bucket: Bucket; prs: RawPr[] }>): Map<string, PrItem> {
	const items = new Map<string, PrItem>();
	for (const { bucket, prs } of results) {
		for (const pr of prs) {
			const existing = items.get(pr.url);
			if (existing !== undefined) {
				if (!existing.buckets.includes(bucket)) {
					existing.buckets.push(bucket);
					existing.buckets.sort();
				}
				continue;
			}
			items.set(pr.url, {
				url: pr.url,
				repo: pr.repo,
				number: pr.number,
				title: pr.title,
				author: pr.author,
				state: "open",
				isDraft: pr.isDraft,
				buckets: [bucket],
				ci: pr.ci,
				reviewDecision: pr.reviewDecision,
				requestedReviewers: pr.requestedReviewers,
				baseRef: pr.baseRef,
				headRef: pr.headRef,
				updatedAt: pr.updatedAt,
			});
		}
	}
	return items;
}
