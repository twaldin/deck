import { buildSearchQueries, mergeBuckets, type GithubClient } from "./github";
import { diffStates, formatChangeLine, normalizePrUrl, untrackedChanges } from "./diff";
import type { DiffChange, IntakeState } from "./schema";

export interface PollConfig {
	login: string;
	/** GitHub search scope qualifiers, e.g. ["org:example-org", "user:example-user"]. */
	scopes: string[];
	tracked: Set<string> | null;
}

export interface PollResult {
	state: IntakeState;
	changes: DiffChange[];
	untracked: DiffChange[];
	newReviewRequests: Set<string>;
}

/** One poll: search both buckets, diff against previous state, flag untracked. */
export async function poll(
	previous: IntakeState,
	config: PollConfig,
	client: GithubClient,
	now: () => Date = () => new Date(),
): Promise<PollResult> {
	const queries = buildSearchQueries(config.login, config.scopes);
	const results = [];
	for (const { bucket, query } of queries) {
		results.push({ bucket, prs: await client.searchOpenPrs(query) });
	}
	const items = mergeBuckets(results);

	const state: IntakeState = {
		v: 1,
		generatedAt: now().toISOString(),
		items: Object.fromEntries([...items.entries()].sort(([a], [b]) => a.localeCompare(b))),
	};

	const changes = await diffStates(previous, state, config.login, client);
	const untracked = config.tracked === null ? [] : untrackedChanges(state, config.tracked);

	const newReviewRequests = new Set<string>();
	for (const change of changes) {
		if (change.kind === "new" && change.reviewRequested) {
			newReviewRequests.add(change.url);
		}
		if (change.kind === "buckets" && change.reviewRequested) {
			newReviewRequests.add(change.url);
		}
		if (change.kind === "reviewers" && change.selfRequested) {
			newReviewRequests.add(change.url);
		}
	}

	return { state, changes, untracked, newReviewRequests };
}

export { formatChangeLine, normalizePrUrl };
