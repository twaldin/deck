import { createHash } from "node:crypto";
import { z } from "zod";
import type {
	AdapterFact,
	AdapterPollResult,
	JsonValue,
	SourceAdapter,
	TargetPollAdapter,
	WatchTarget,
} from "./adapters";
import { watchTargetSchema } from "./adapters";
import { runBoundedCommand, type BoundedCommandOptions, type CommandResult } from "./process-group";

const prReferenceSchema = z.object({
	owner: z.string().min(1),
	repo: z.string().min(1),
	number: z.number().int().positive(),
});
type PrReference = z.infer<typeof prReferenceSchema>;

const checkRunSchema = z.object({
	__typename: z.literal("CheckRun"),
	databaseId: z.number().int().nonnegative().nullable(),
	name: z.string(),
	status: z.string(),
	conclusion: z.string().nullable(),
	startedAt: z.string().nullable(),
	completedAt: z.string().nullable(),
	detailsUrl: z.string().nullable(),
});
const statusContextSchema = z.object({
	__typename: z.literal("StatusContext"),
	id: z.string().min(1),
	context: z.string(),
	state: z.string(),
	createdAt: z.string(),
	targetUrl: z.string().nullable(),
});
const reviewSchema = z.object({
	databaseId: z.number().int().nonnegative().nullable(),
	id: z.string().min(1),
	state: z.string(),
	submittedAt: z.string().nullable(),
	updatedAt: z.string(),
	body: z.string(),
	url: z.string(),
	author: z.object({ login: z.string() }).nullable(),
});
const commentSchema = z.object({
	databaseId: z.number().int().nonnegative().nullable(),
	id: z.string().min(1),
	createdAt: z.string(),
	updatedAt: z.string(),
	body: z.string(),
	url: z.string(),
	author: z.object({ login: z.string() }).nullable(),
});
const graphQlResponseSchema = z.object({
	data: z.object({
		repository: z.object({
			pullRequest: z.object({
				url: z.string(),
				updatedAt: z.string(),
				commits: z.object({
					nodes: z.array(z.object({
						commit: z.object({
							statusCheckRollup: z.object({
								contexts: z.object({
									nodes: z.array(z.discriminatedUnion("__typename", [checkRunSchema, statusContextSchema])),
								}),
							}).nullable(),
						}),
					})),
				}),
				reviews: z.object({ nodes: z.array(reviewSchema) }),
				comments: z.object({ nodes: z.array(commentSchema) }),
			}).nullable(),
		}),
	}),
});

const ghCursorSchema = z.object({
	checks: z.record(z.string(), z.string()),
	reviews: z.record(z.string(), z.string()),
	comments: z.record(z.string(), z.string()),
});
type GhCursor = z.infer<typeof ghCursorSchema>;

export type CommandRunner = (
	command: string,
	args: string[],
	options: BoundedCommandOptions,
) => Promise<CommandResult>;

const CI_RED_STATE: Record<string, true> = {
	failure: true,
	failed: true,
	error: true,
	timed_out: true,
	cancelled: true,
	action_required: true,
	stale: true,
};
const CI_GREEN_STATE: Record<string, true> = {
	success: true,
	successful: true,
	neutral: true,
	skipped: true,
};

const QUERY = `query DeckWatchedPr($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      url updatedAt
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { databaseId name status conclusion startedAt completedAt detailsUrl }
        ... on StatusContext { id context state createdAt targetUrl }
      } } } } } }
      reviews(last: 100) { nodes { databaseId id state submittedAt updatedAt body url author { login } } }
      comments(last: 100) { nodes { databaseId id createdAt updatedAt body url author { login } } }
    }
  }
}`;

export interface GhAdapterOptions {
	deadlineMs: number;
	outputCapBytes: number;
	runner?: CommandRunner;
}

export class GhAdapter implements SourceAdapter {
	readonly source = "gh";
	private readonly options: GhAdapterOptions;

	constructor(options: GhAdapterOptions) {
		this.options = options;
	}

	supports(target: WatchTarget): boolean {
		return target.source === this.source && target.kind === "pr";
	}

	bind(target: WatchTarget): TargetPollAdapter {
		const parsedTarget = watchTargetSchema.parse(target);
		if (!this.supports(parsedTarget)) {
			throw new Error(`gh adapter cannot poll ${parsedTarget.source}:${parsedTarget.kind}`);
		}
		return new GhTargetAdapter(parsedTarget, parsePrReference(parsedTarget.reference), this.options);
	}
}

class GhTargetAdapter implements TargetPollAdapter {
	readonly source = "gh";
	readonly target: WatchTarget;
	private readonly reference: PrReference;
	private readonly options: GhAdapterOptions;

	constructor(target: WatchTarget, reference: PrReference, options: GhAdapterOptions) {
		this.target = target;
		this.reference = reference;
		this.options = options;
	}

	async pollCmd(cursor: JsonValue | undefined, signal?: AbortSignal): Promise<AdapterPollResult> {
		const previous = cursor === undefined
			? ghCursorSchema.parse({ checks: {}, reviews: {}, comments: {} })
			: ghCursorSchema.parse(cursor);
		const runner = this.options.runner ?? runBoundedCommand;
		const result = await runner("gh", [
			"api",
			"graphql",
			"-f",
			`query=${QUERY}`,
			"-f",
			`owner=${this.reference.owner}`,
			"-f",
			`repo=${this.reference.repo}`,
			"-F",
			`number=${this.reference.number}`,
		], {
			deadlineMs: this.options.deadlineMs,
			outputCapBytes: this.options.outputCapBytes,
			signal,
		});
		const decoded: unknown = JSON.parse(result.stdout);
		const response = graphQlResponseSchema.parse(decoded);
		const pullRequest = response.data.repository.pullRequest;
		if (pullRequest === null) {
			throw new Error(`GitHub PR not found: ${this.target.reference}`);
		}
		return buildResult(this.reference, pullRequest, previous);
	}
}

function buildResult(
	reference: PrReference,
	pullRequest: NonNullable<z.infer<typeof graphQlResponseSchema>["data"]["repository"]["pullRequest"]>,
	previous: GhCursor,
): AdapterPollResult {
	const facts: AdapterFact[] = [];
	const next = ghCursorSchema.parse({ checks: {}, reviews: {}, comments: {} });
	const prKey = `${reference.owner}/${reference.repo}#${reference.number}`;
	for (const commitNode of pullRequest.commits.nodes) {
		for (const check of commitNode.commit.statusCheckRollup?.contexts.nodes ?? []) {
			const checkId = check.__typename === "CheckRun"
				? String(check.databaseId ?? check.name)
				: check.id;
			const version = check.__typename === "CheckRun"
				? check.completedAt ?? check.startedAt ?? contentVersion(check)
				: contentVersion({ state: check.state, createdAt: check.createdAt, targetUrl: check.targetUrl });
			next.checks[checkId] = version;
			if (previous.checks[checkId] === version) {
				continue;
			}
			const name = check.__typename === "CheckRun" ? check.name : check.context;
			const rawState = check.__typename === "CheckRun" ? check.conclusion ?? check.status : check.state;
			const url = check.__typename === "CheckRun" ? check.detailsUrl : check.targetUrl;
			facts.push({
				plane: "fact",
				type: "fact.pr.ci_state",
				actor: "router:gh",
				data: {
					pr: prKey,
					pr_url: pullRequest.url,
					check_id: checkId,
					name,
					state: normalizeCiState(rawState),
					raw_state: rawState,
					url,
				},
				idem: {
					source: "gh",
					external_id: `pr:${prKey}:check:${checkId}`,
					version,
				},
			});
		}
	}
	for (const review of pullRequest.reviews.nodes) {
		const reviewId = String(review.databaseId ?? review.id);
		const version = review.updatedAt || review.submittedAt || contentVersion(review);
		next.reviews[reviewId] = version;
		if (previous.reviews[reviewId] === version) {
			continue;
		}
		facts.push(reviewFact(prKey, pullRequest.url, "review", reviewId, version, {
			state: review.state,
			author: review.author?.login ?? null,
			body: review.body.slice(0, 2_000),
			url: review.url,
		}));
	}
	for (const comment of pullRequest.comments.nodes) {
		const commentId = String(comment.databaseId ?? comment.id);
		const version = comment.updatedAt || contentVersion(comment);
		next.comments[commentId] = version;
		if (previous.comments[commentId] === version) {
			continue;
		}
		facts.push(reviewFact(prKey, pullRequest.url, "comment", commentId, version, {
			author: comment.author?.login ?? null,
			body: comment.body.slice(0, 2_000),
			url: comment.url,
		}));
	}
	return { facts, cursor: next };
}

function reviewFact(
	prKey: string,
	prUrl: string,
	kind: "review" | "comment",
	externalId: string,
	version: string,
	data: Record<string, unknown>,
): AdapterFact {
	return {
		plane: "fact",
		type: "fact.pr.review",
		actor: "router:gh",
		data: { pr: prKey, pr_url: prUrl, kind, ...data },
		idem: {
			source: "gh",
			external_id: `pr:${prKey}:${kind}:${externalId}`,
			version,
		},
	};
}

export function parsePrReference(reference: string): PrReference {
	const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(reference);
	const short = /^([^/]+)\/([^#:\s]+)[#:]([1-9]\d*)$/.exec(reference);
	const match = url ?? short;
	if (match === null) {
		throw new Error(`unsupported GitHub PR reference: ${reference}`);
	}
	return prReferenceSchema.parse({ owner: match[1], repo: match[2], number: Number(match[3]) });
}

function normalizeCiState(raw: string): "red" | "green" | "pending" {
	const state = raw.toLowerCase();
	if (CI_RED_STATE[state] === true) {
		return "red";
	}
	if (CI_GREEN_STATE[state] === true) {
		return "green";
	}
	return "pending";
}

function contentVersion(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
