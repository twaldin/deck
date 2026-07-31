/**
 * GitHub adapters for real (non-dry-run) mode, plus pure parsers that are
 * unit-testable without network. All shell-outs go through the configurable
 * `gh`/`git` binaries so a crewmate can point this at gh-axi.
 */

import type { PrOverview } from "./adopt.ts";
import type {
	CheckRun,
	CommentActivity,
	ReviewApproval,
	ReviewerActivity,
	ReviewThread,
	WatchSnapshot,
} from "./types.ts";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type ExecFn = (argv: string[], options?: { cwd?: string }) => Promise<ExecResult>;

/** Default exec via Bun.spawn. Injectable for tests. */
export const bunExec: ExecFn = async (argv, options) => {
	const proc = Bun.spawn(argv, {
		cwd: options?.cwd,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
};

export async function execOrThrow(exec: ExecFn, argv: string[], options?: { cwd?: string }): Promise<string> {
	const result = await exec(argv, options);
	if (result.code !== 0) {
		throw new Error(`command failed (${result.code}): ${argv.join(" ")}\n${result.stderr.slice(0, 2000)}`);
	}
	return result.stdout;
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
		runs.push({
			name: str(raw.name),
			status: str(raw.status),
			conclusion: raw.conclusion === null ? null : str(raw.conclusion),
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
			comments.push({ author: login, isBot: isBotAuthor(author), createdAt: str(node.createdAt) });
		}
	}
	if (Array.isArray(reviewNodes)) {
		for (const node of reviewNodes) {
			if (!isRecord(node)) continue;
			const author = isRecord(node.author) ? node.author : null;
			const login = author !== null ? str(author.login) : "";
			if (login === "") continue;
			const submittedAt = str(node.submittedAt);
			// Review summaries count as comments too (they can carry asks).
			if (str(node.body) !== "") {
				comments.push({ author: login, isBot: isBotAuthor(author), createdAt: submittedAt });
			}
			const prior = latestByReviewer.get(login.toLowerCase());
			if (prior === undefined || submittedAt > prior.lastActivityAt) {
				latestByReviewer.set(login.toLowerCase(), {
					login,
					isBot: isBotAuthor(author),
					lastActivityAt: submittedAt,
					lastReviewState: str(node.state) !== "" ? str(node.state) : null,
				});
			}
		}
	}
	return { comments, reviewers: [...latestByReviewer.values()] };
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
      commits(last: 1) { nodes { commit { committedDate } } }
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(last: 1) { nodes { author { login __typename } } }
        }
      }
      reviews(first: 100) {
        nodes { author { login __typename } state submittedAt body }
      }
      comments(first: 100) {
        nodes { author { login __typename } createdAt }
      }
    }
  }
}`;

export async function fetchWatchSnapshot(ctx: GhContext, prNumber: number, selfLogins: string[]): Promise<WatchSnapshot> {
	const exec = ctx.exec ?? bunExec;
	const [owner, name] = ctx.repo.split("/");
	const gqlOut = await execOrThrow(exec, [
		ctx.gh, "api", "graphql",
		"-f", `query=${WATCH_QUERY}`,
		"-f", `owner=${owner}`,
		"-f", `name=${name}`,
		"-F", `number=${prNumber}`,
	]);
	const gql = JSON.parse(gqlOut) as Record<string, any>;
	const pr = gql?.data?.repository?.pullRequest ?? {};

	const requestedOut = await execOrThrow(exec, [
		ctx.gh, "api", `repos/${ctx.repo}/pulls/${prNumber}/requested_reviewers`,
	]);
	const requested = parseRequestedReviewers(JSON.parse(requestedOut));

	const headSha = str(pr.headRefOid);
	const checksOut = await execOrThrow(exec, [
		ctx.gh, "api", `repos/${ctx.repo}/commits/${headSha}/check-runs?per_page=100`,
	]);
	const checkRuns = parseCheckRuns(JSON.parse(checksOut));

	const lastPushAt = str(pr?.commits?.nodes?.[0]?.commit?.committedDate);
	const { comments, reviewers } = parseActivity(pr?.reviews?.nodes, pr?.comments?.nodes);

	return {
		headSha,
		lastPushAt,
		threads: parseReviewThreads(pr?.reviewThreads?.nodes),
		comments,
		reviewers,
		requestedReviewers: requested,
		checkRuns,
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
	const gql = JSON.parse(gqlOut) as Record<string, any>;
	const pr = gql?.data?.repository?.pullRequest ?? {};
	const headSha = str(pr.headRefOid);
	const checksOut = await execOrThrow(exec, [
		ctx.gh, "api", `repos/${ctx.repo}/commits/${headSha}/check-runs?per_page=100`,
	]);
	return {
		approvals: parseReviews(pr?.reviews?.nodes),
		checkRuns: parseCheckRuns(JSON.parse(checksOut)),
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
		commits = JSON.parse(search.stdout);
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
	return parseRequestedReviewers(JSON.parse(out));
}

/** Overview of an existing PR (adopt path: verify + seed, never create). */
export async function fetchPrOverview(ctx: GhContext, prNumber: number): Promise<PrOverview> {
	const exec = ctx.exec ?? bunExec;
	const out = await execOrThrow(exec, [ctx.gh, "api", `repos/${ctx.repo}/pulls/${prNumber}`]);
	const payload = JSON.parse(out) as {
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
export async function fetchHeadSha(ctx: GhContext, prNumber: number): Promise<string> {
	const exec = ctx.exec ?? bunExec;
	const out = await execOrThrow(exec, [
		ctx.gh, "api", `repos/${ctx.repo}/pulls/${prNumber}`, "--jq", ".head.sha",
	]);
	return out.trim();
}

/** Recent commit subjects on origin/main (landing verification). */
export async function fetchMainCommitSubjects(
	git: string,
	worktree: string,
	limit = 200,
	exec: ExecFn = bunExec,
): Promise<Array<{ sha: string; subject: string }>> {
	await execOrThrow(exec, [git, "fetch", "origin", "main"], { cwd: worktree });
	const out = await execOrThrow(
		exec,
		[git, "log", "origin/main", `--max-count=${limit}`, "--format=%H%x09%s"],
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
