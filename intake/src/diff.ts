import type { GithubClient } from "./github";
import type { DiffChange, IntakeState, PrItem, RemovalResolution } from "./schema";

/**
 * Diff two intake snapshots. Pure except for removal resolution, which needs
 * the GithubClient to run the Graphite closed-PR check (SPEC of this tool:
 * closed+unmerged is NOT closed-without-landing until the squash-commit
 * search on the default branch comes back empty).
 */
export async function diffStates(
	previous: IntakeState,
	current: IntakeState,
	login: string,
	client: GithubClient,
): Promise<DiffChange[]> {
	const changes: DiffChange[] = [];

	const previousItems = previous.items;
	const currentItems = current.items;

	// New items.
	for (const [url, item] of Object.entries(currentItems)) {
		if (previousItems[url] !== undefined) {
			continue;
		}
		changes.push({
			kind: "new",
			url,
			buckets: item.buckets,
			reviewRequested: item.buckets.includes("review-owed"),
			title: item.title,
		});
	}

	// Disappeared items — resolve WHY before reporting.
	for (const [url, item] of Object.entries(previousItems)) {
		if (currentItems[url] !== undefined) {
			continue;
		}
		const resolution = await resolveRemoval(item, client);
		changes.push({ kind: "removed", url, resolution, title: item.title });
	}

	// State changes on retained items.
	for (const [url, item] of Object.entries(currentItems)) {
		const before = previousItems[url];
		if (before === undefined) {
			continue;
		}
		if (before.ci !== item.ci) {
			changes.push({ kind: "ci", url, from: before.ci, to: item.ci });
		}
		if (before.reviewDecision !== item.reviewDecision) {
			changes.push({ kind: "review-decision", url, from: before.reviewDecision, to: item.reviewDecision });
		}
		const added = item.requestedReviewers.filter((reviewer) => !before.requestedReviewers.includes(reviewer));
		const removed = before.requestedReviewers.filter((reviewer) => !item.requestedReviewers.includes(reviewer));
		if (added.length > 0 || removed.length > 0) {
			changes.push({ kind: "reviewers", url, added, removed, selfRequested: added.includes(login) });
		}
		if (!sameBuckets(before.buckets, item.buckets)) {
			changes.push({
				kind: "buckets",
				url,
				from: before.buckets,
				to: item.buckets,
				reviewRequested: !before.buckets.includes("review-owed") && item.buckets.includes("review-owed"),
			});
		}
	}

	return changes;
}

function sameBuckets(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * GRAPHITE TRAP: a PR that fell out of the open search must be looked up
 * point-wise. state=closed, merged=false is resolved by searching the default
 * branch for the squash commit "(#N)"; only an empty search may be reported
 * as closed-without-landing. Three confirmed repros of the misread.
 */
export async function resolveRemoval(item: PrItem, client: GithubClient): Promise<RemovalResolution> {
	const lookup = await client.lookupPr(item.repo, item.number);
	if (lookup === null) {
		return "vanished";
	}
	if (lookup.state === "merged") {
		return "merged";
	}
	if (lookup.state === "open") {
		// Still open, just no longer in any search bucket (e.g. review request
		// withdrawn). Never a closed-without-landing.
		return "descoped";
	}
	const squashSha = await client.findSquashCommit(item.repo, item.number);
	if (squashSha !== null) {
		return "landed-squash";
	}
	return "closed-without-landing";
}

/** Flag current items whose URL is not in the tracked set. */
export function untrackedChanges(current: IntakeState, tracked: Set<string>): DiffChange[] {
	const changes: DiffChange[] = [];
	for (const [url, item] of Object.entries(current.items)) {
		if (!tracked.has(normalizePrUrl(url))) {
			changes.push({ kind: "untracked", url, title: item.title });
		}
	}
	return changes;
}

/** Canonicalize a PR URL for tracked-set comparison. */
export function normalizePrUrl(url: string): string {
	return url.trim().replace(/[/]+$/, "").toLowerCase();
}

/**
 * One compact machine-parseable line per change (tab-separated):
 *   <kind>\t<signal>\t<url>\t<detail...>
 * <kind> is always the stable schema kind, so column shapes are decidable
 * from column 1 alone. <signal> is "REVIEW-REQUESTED" when the polled login
 * was newly asked for review (the high-signal wake condition), else "-".
 * Watchers wake on: cut -f2 == REVIEW-REQUESTED (or any output at all).
 */
export function formatChangeLine(change: DiffChange): string {
	switch (change.kind) {
		case "new": {
			const signal = change.reviewRequested ? "REVIEW-REQUESTED" : "-";
			return `new\t${signal}\t${change.url}\t${change.buckets.join(",")}\t${change.title}`;
		}
		case "removed":
			return `removed\t-\t${change.url}\t${change.resolution}\t${change.title}`;
		case "ci":
			return `ci\t-\t${change.url}\t${change.from}->${change.to}`;
		case "review-decision":
			return `review-decision\t-\t${change.url}\t${change.from}->${change.to}`;
		case "reviewers": {
			const signal = change.selfRequested ? "REVIEW-REQUESTED" : "-";
			const parts = [
				...change.added.map((reviewer) => `+${reviewer}`),
				...change.removed.map((reviewer) => `-${reviewer}`),
			];
			return `reviewers\t${signal}\t${change.url}\t${parts.join(",")}`;
		}
		case "buckets": {
			const signal = change.reviewRequested ? "REVIEW-REQUESTED" : "-";
			return `buckets\t${signal}\t${change.url}\t${change.from.join(",")}->${change.to.join(",")}`;
		}
		case "untracked":
			return `untracked\t-\t${change.url}\t${change.title}`;
	}
}
