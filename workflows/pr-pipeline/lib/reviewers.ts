/**
 * Reviewer selection for the post-push request-reviewers stage.
 *
 * Pure logic only (unit-testable, no network): CODEOWNERS parsing/matching
 * for the touched paths, recent-author frequency ranking as the fallback
 * (lindy CODEOWNERS may be thin), and hard exclusions (self, excluded
 * approvers such as ali, bots). The gh shell-outs live in gh.ts.
 */

export interface CodeownersRule {
	pattern: string;
	owners: string[];
}

/** Parse CODEOWNERS content into ordered rules (later rules win per file). */
export function parseCodeowners(content: string): CodeownersRule[] {
	const rules: CodeownersRule[] = [];
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const [pattern, ...ownerTokens] = line.split(/\s+/);
		const owners = ownerTokens
			// Only user handles: `@login`. Team slugs (`@org/team`) and emails
			// cannot go into the reviewers[] user request.
			.filter((token) => token.startsWith("@") && !token.includes("/"))
			.map((token) => token.slice(1));
		if (pattern !== undefined && owners.length > 0) rules.push({ pattern, owners });
	}
	return rules;
}

/**
 * CODEOWNERS pattern -> matcher regex (GitHub CODEOWNERS semantics, which
 * deviate from gitignore: `docs/*` owns only DIRECT children, never nested).
 */
function patternToRegex(pattern: string): RegExp {
	// Anchored to the repo root when it starts with `/` or contains a
	// non-trailing slash.
	const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");
	let p = pattern.replace(/^\//, "");
	const dirOnly = p.endsWith("/");
	if (dirOnly) p = p.slice(0, -1);
	const lastSegment = p.split("/").pop() ?? "";
	// A trailing-slash pattern or a plain path (could name a directory) owns
	// its descendants; a wildcard last segment matches at its own depth only.
	const ownsDescendants = dirOnly || lastSegment === "**" || !/[*?]/.test(lastSegment);
	const body = p
		.split("/")
		.map((segment) =>
			segment === "**"
				? "\u0000"
				: segment
						.replace(/[.+^${}()|[\]\\]/g, "\\$&")
						.replace(/\*/g, "[^/]*")
						.replace(/\?/g, "[^/]"),
		)
		.join("/")
		// `**/` matches ZERO or more directories.
		.replace(/\u0000\//g, "(?:.*/)?")
		.replace(/\/\u0000/g, "(?:/.*)?")
		.replace(/\u0000/g, ".*");
	const prefix = anchored ? "^" : "^(?:.*/)?";
	const suffix = ownsDescendants ? "(?:/.*)?$" : "$";
	return new RegExp(`${prefix}${body}${suffix}`);
}

/** Owners for the touched files: last matching rule wins per file, union across files. */
export function codeownersFor(rules: CodeownersRule[], files: string[]): string[] {
	const owners = new Set<string>();
	for (const file of files) {
		for (let i = rules.length - 1; i >= 0; i--) {
			if (patternToRegex(rules[i].pattern).test(file)) {
				for (const owner of rules[i].owners) owners.add(owner);
				break;
			}
		}
	}
	return [...owners];
}

export interface ReviewerSelectionInput {
	/** Already-resolved logins from the brief / input config; all are requested. */
	explicit: string[];
	/** CODEOWNERS owners of the touched paths. */
	codeowners: string[];
	/** One login per recent commit on the touched files; repeats carry frequency. */
	recentAuthors: string[];
	/** Never requested: selfLogins, excludedApprovers, and the configured denylist. */
	exclude: string[];
	/** Auto-derived reviewer target (explicit entries can exceed it). */
	max?: number;
}

export interface ReviewerSelection {
	reviewers: string[];
	source: "explicit" | "codeowners" | "recent-authors" | "mixed" | "none";
}

export function selectReviewers(input: ReviewerSelectionInput): ReviewerSelection {
	const max = input.max ?? 2;
	const excluded = new Set(input.exclude.map((login) => login.toLowerCase()));
	const chosen: string[] = [];
	const chosenSet = new Set<string>();
	const sources = new Set<ReviewerSelection["source"]>();

	const eligible = (login: string): boolean =>
		login !== "" &&
		!login.endsWith("[bot]") &&
		!excluded.has(login.toLowerCase()) &&
		!chosenSet.has(login.toLowerCase());

	const take = (login: string, source: "explicit" | "codeowners" | "recent-authors") => {
		chosen.push(login);
		chosenSet.add(login.toLowerCase());
		sources.add(source);
	};

	for (const login of input.explicit) {
		if (eligible(login)) take(login, "explicit");
	}
	for (const login of input.codeowners) {
		if (chosen.length >= max) break;
		if (eligible(login)) take(login, "codeowners");
	}
	if (chosen.length < max) {
		const freq = new Map<string, number>();
		for (const login of input.recentAuthors) {
			if (!eligible(login)) continue;
			freq.set(login, (freq.get(login) ?? 0) + 1);
		}
		const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([login]) => login);
		for (const login of ranked) {
			if (chosen.length >= max) break;
			if (eligible(login)) take(login, "recent-authors");
		}
	}

	const source: ReviewerSelection["source"] =
		sources.size === 0 ? "none" : sources.size === 1 ? [...sources][0] : "mixed";
	return { reviewers: chosen, source };
}

// ---------------------------------------------------------------------------
// Stage orchestration (adapters injected -> unit-testable without gh)
// ---------------------------------------------------------------------------

export interface ReviewerRequestAdapters {
	fetchChangedFiles: () => Promise<string[]>;
	fetchCodeowners: () => Promise<string | null>;
	fetchRecentAuthors: (files: string[]) => Promise<string[]>;
	resolveLogin: (nameOrLogin: string) => Promise<string | null>;
	/** Return true only when the login is a collaborator who can be requested. */
	isCollaborator: (login: string) => Promise<boolean>;
	/** Record a non-fatal reviewer skip for operators. */
	logSkip?: (login: string, reason: string) => void;
	requestReviewers: (logins: string[]) => Promise<void>;
	fetchRequestedReviewers: () => Promise<string[]>;
}

export interface ReviewerRequestConfig {
	/** Names or logins from the brief / input config. */
	explicit: string[];
	exclude: string[];
	max: number;
}

export interface ReviewerRequestResult {
	skipped: boolean;
	requested: string[];
	verified: string[];
	skippedNonCollaborators?: string[];
	source: string;
	at: string;
}

/**
 * The full request-reviewers stage: select (CODEOWNERS -> recent-author
 * frequency), request, then VERIFY via the requested_reviewers read (GH
 * review requests silently no-op on plausible-but-wrong logins). Throws
 * `[escalate]` on: an unresolvable explicit entry, zero candidates, or a
 * silently dropped login. The only empty-reviewer path is the caller's
 * explicit skip, which never reaches this function.
 */
export async function executeReviewerRequest(
	config: ReviewerRequestConfig,
	adapters: ReviewerRequestAdapters,
): Promise<ReviewerRequestResult> {
	const files = await adapters.fetchChangedFiles();
	const owners = codeownersFor(parseCodeowners((await adapters.fetchCodeowners()) ?? ""), files);
	const recentAuthors = await adapters.fetchRecentAuthors(files);
	const explicit: string[] = [];
	const unresolved: string[] = [];
	for (const entry of config.explicit) {
		const login = await adapters.resolveLogin(entry);
		if (login === null) unresolved.push(entry);
		else explicit.push(login);
	}
	if (unresolved.length > 0) {
		throw new Error(
			`[escalate] explicit reviewer(s) did not resolve to a GH login: ${unresolved.join(", ")}. ` +
				`Fix the names against the roster (name->login lookup found nothing).`,
		);
	}
	const selection = selectReviewers({
		explicit,
		codeowners: owners,
		recentAuthors,
		exclude: config.exclude,
		// Validate every eligible candidate, then stop after max collaborators.
		max: Number.MAX_SAFE_INTEGER,
	});
	const collaborators: string[] = [];
	const skippedNonCollaborators: string[] = [];
	for (const login of selection.reviewers) {
		if (collaborators.length >= config.max) break;
		if (await adapters.isCollaborator(login)) collaborators.push(login);
		else {
			skippedNonCollaborators.push(login);
			adapters.logSkip?.(login, "not a repository collaborator");
		}
	}
	if (collaborators.length === 0) {
		throw new Error(
			`[escalate] no reviewer candidates; no collaborator reviewer candidates: ${skippedNonCollaborators.join(", ")}. ` +
				`A PR never proceeds unreviewed: set github.reviewers, or set ` +
				`github.skipReviewerRequest=true on a new run to skip explicitly.`,
		);
	}
	await adapters.requestReviewers(collaborators);
	const live = new Set((await adapters.fetchRequestedReviewers()).map((login) => login.toLowerCase()));
	const missing = collaborators.filter((login) => !live.has(login.toLowerCase()));
	if (missing.length > 0) {
		throw new Error(
			`[escalate] review request silently no-op'd for: ${missing.join(", ")} ` +
				`(requested_reviewers verification). Check the logins against the roster.`,
		);
	}
	return {
		skipped: false,
		requested: collaborators,
		verified: collaborators,
		skippedNonCollaborators,
		source: selection.source,
		at: new Date().toISOString(),
	};
}
