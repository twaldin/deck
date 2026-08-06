/**
 * Adopt-path safety checks: an existing PR may only be adopted when the live
 * PR record AND the local worktree both match what the run declared. Pure and
 * unit-testable; the pipeline feeds it fetchPrOverview + local git state.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execOrThrow, type ExecFn } from "./gh.ts";

export interface PrOverview {
	number: number;
	url: string;
	state: string;
	draft: boolean;
	headRefName: string;
	headSha: string;
	baseRefName: string;
	headRepoFullName: string;
}

export interface AdoptExpectation {
	repo: string; // owner/name the run declared
	branch: string; // head branch the run declared
	baseBranch: string; // base branch used by this run
	worktreeBranch: string; // git branch currently checked out in the worktree
	worktreeHead: string; // git rev-parse HEAD in the worktree
	worktreeStatus: string; // git status --porcelain output for the worktree
	worktreeOriginUrl: string; // git remote get-url origin for the worktree
	/** Local adversarial fixes may make the worktree a clean descendant of the PR head. */
	allowWorktreeAhead?: boolean;
	/** Result of git merge-base --is-ancestor when the heads differ. */
	worktreeIsDescendant?: boolean;
}

/** Extracts "owner/name" from a git remote URL (ssh, https, or git@ form); "" when unparseable. */
export function repoFromRemoteUrl(url: string): string {
	const match = /(?:[/:])([^/:]+\/[^/:]+?)(?:\.git)?\/?$/.exec(url.trim());
	return match ? match[1] : "";
}

/** Throws [escalate] on any mismatch; returns void when the PR is adoptable. */
export const KNOWN_SCRATCH_FILES = [".deck-deps-failed", ".deck-deps-failed.log", ".husky/_"] as const;

/** Remove dependency and hook scratch files before checking adopt cleanliness. */
export function cleanKnownScratchFiles(worktree: string, remove: (file: string) => void = (file) => {
	fs.rmSync(file, { force: true, recursive: true });
}): void {
	for (const file of KNOWN_SCRATCH_FILES) remove(path.join(worktree, file));
}

/**
 * Reconcile an adopted PR to the base GitHub reports. `main` is the default
 * run base, so a stack child may replace it with its actual non-main base.
 * Two different non-main bases remain unsafe to reconcile.
 */
export function reconcileAdoptBaseBranch(declaredBaseBranch: string | undefined, actualBaseBranch: string): string {
	if (actualBaseBranch === "") {
		throw new Error("[escalate] cannot adopt PR: GitHub did not report a base branch.");
	}
	if (
		declaredBaseBranch === undefined ||
		declaredBaseBranch === actualBaseBranch ||
		declaredBaseBranch === "main" ||
		actualBaseBranch === "main"
	) {
		return actualBaseBranch;
	}
	throw new Error(
		`[escalate] cannot adopt PR: it targets base "${actualBaseBranch}" but the run declared baseBranch "${declaredBaseBranch}".`,
	);
}

export function assertAdoptable(overview: PrOverview, expected: AdoptExpectation): void {
	const pr = `PR #${overview.number}`;
	if (overview.state !== "open") {
		throw new Error(`[escalate] cannot adopt ${pr}: state is "${overview.state}", not open.`);
	}
	if (overview.draft) {
		throw new Error(
			`[escalate] cannot adopt ${pr}: it is a draft — GitHub reports drafts as open, but the merge would fail because the PR is not ready for review. Mark it ready first.`,
		);
	}
	if (overview.headRepoFullName.toLowerCase() !== expected.repo.toLowerCase()) {
		throw new Error(
			`[escalate] cannot adopt ${pr}: its head lives in "${overview.headRepoFullName}", not "${expected.repo}" — a fork PR cannot be updated by pushing to origin, so adopting it would fix the wrong branch.`,
		);
	}
	if (overview.headRefName !== expected.branch) {
		throw new Error(
			`[escalate] cannot adopt ${pr}: its head branch is "${overview.headRefName}" but the run was given branch "${expected.branch}" — adopting the wrong PR would watch/stamp the wrong diff.`,
		);
	}
	if (overview.baseRefName !== expected.baseBranch) {
		throw new Error(
			`[escalate] cannot adopt ${pr}: it targets base "${overview.baseRefName}" but this run uses baseBranch "${expected.baseBranch}" — landing verification and merge would act on the wrong base.`,
		);
	}
	if (expected.worktreeBranch !== expected.branch) {
		throw new Error(
			`[escalate] cannot adopt ${pr}: the worktree has branch "${expected.worktreeBranch}" checked out, not "${expected.branch}" — the watch fixer and merge run in this worktree and would act on the wrong branch.`,
		);
	}
	if (expected.worktreeHead !== overview.headSha && expected.worktreeIsDescendant !== true) {
		throw new Error(
			`[escalate] cannot adopt ${pr}: worktree HEAD is ${expected.worktreeHead} but the PR head is ${overview.headSha} — the worktree is stale or diverged; sync it to the PR head first.`,
		);
	}
	const worktreeRepo = repoFromRemoteUrl(expected.worktreeOriginUrl);
	if (worktreeRepo.toLowerCase() !== expected.repo.toLowerCase()) {
		throw new Error(
			`[escalate] cannot adopt ${pr}: the worktree origin is "${expected.worktreeOriginUrl}" (${worktreeRepo || "unparseable"}), not "${expected.repo}" — the watch fixer and merge run in this worktree and would push to the wrong repository.`,
		);
	}
	if (expected.worktreeStatus.trim() !== "") {
		throw new Error(
			`[escalate] cannot adopt ${pr}: the worktree is not clean:\n${expected.worktreeStatus.trim()}\n— the watch fixer commits in this worktree and would push these unrelated changes into the PR. Clean or stash them first.`,
		);
	}
}

export type AdoptPushDecision = "proceed" | "push" | "escalate";

/** Decides whether adopt may continue, or may safely overwrite the PR branch. */
export function decideAdoptPush(args: {
	worktreeHead: string;
	prHead: string;
	isAncestor: boolean;
}): AdoptPushDecision {
	if (args.worktreeHead === args.prHead) return "proceed";
	return args.isAncestor ? "push" : "escalate";
}

export interface StackCarSpec {
	/** Ordered branch name, parent first. */
	branch: string;
	/** Optional assertion; omitted bases are derived from the preceding car. */
	baseBranch?: string;
	title?: string;
	body?: string;
}

export interface AdoptedPrLive {
	number: number;
	url: string;
	state: string;
	merged: boolean;
	draft: boolean;
	headRefName: string;
	headSha: string;
	baseRefName: string;
	headRepoFullName: string;
}

/** Durable parent-to-child state used by every stack stage. */
export interface StackCarRecord {
	prNumber: number;
	url: string;
	branch: string;
	baseBranch: string;
	headSha: string;
	landed: boolean;
}

export interface GhStackBranch {
	name: string;
	head: string;
	base: string;
	isCurrent: boolean;
	isMerged: boolean;
	isQueued: boolean;
	needsRebase: boolean;
	pr?: {
		number: number;
		url: string;
		state: string;
	};
}

export interface GhStackView {
	trunk: string;
	currentBranch: string;
	branches: GhStackBranch[];
}

const safeRef = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

function assertSafeRef(kind: string, ref: string): void {
	if (!safeRef.test(ref)) {
		throw new Error(`[escalate] unsafe ${kind} branch name "${ref}".`);
	}
}

/**
 * Normalize ordered create specs into an explicit parent-to-child topology.
 * Any caller-provided base is an assertion, never an alternate topology.
 */
export function normalizeStackSpecs(rootBaseBranch: string, specs: StackCarSpec[]): Array<Required<Pick<StackCarSpec, "branch" | "baseBranch">> & Pick<StackCarSpec, "title" | "body">> {
	if (specs.length === 0) throw new Error("[escalate] a stack needs at least one car.");
	assertSafeRef("root base", rootBaseBranch);
	const seen = new Set<string>();
	return specs.map((spec, index) => {
		assertSafeRef("stack", spec.branch);
		if (seen.has(spec.branch)) {
			throw new Error(`[escalate] stack branch "${spec.branch}" appears twice.`);
		}
		seen.add(spec.branch);
		const baseBranch = index === 0 ? rootBaseBranch : specs[index - 1].branch;
		if (spec.baseBranch !== undefined && spec.baseBranch !== baseBranch) {
			throw new Error(
				`[escalate] stack topology is broken at "${spec.branch}": base is "${spec.baseBranch}" but parent-first order requires "${baseBranch}".`,
			);
		}
		return { ...spec, baseBranch };
	});
}

/** Fetch existing PRs in the caller-declared order. No create/update API is used. */
export async function fetchAdoptedPrs(
	exec: ExecFn,
	repo: string,
	numbers: number[],
	gh = "gh",
): Promise<AdoptedPrLive[]> {
	const live: AdoptedPrLive[] = [];
	for (const number of numbers) {
		const result = await exec([gh, "api", `repos/${repo}/pulls/${number}`]);
		if (result.code !== 0) {
			throw new Error(
				`[escalate] cannot adopt PR #${number}: it does not exist in ${repo} or is unreadable: ${result.stderr.slice(0, 500)}`,
			);
		}
		const pr = JSON.parse(result.stdout) as Record<string, unknown>;
		const head = pr.head as Record<string, unknown> | undefined;
		const base = pr.base as Record<string, unknown> | undefined;
		live.push({
			number,
			url: String(pr.html_url ?? `https://github.com/${repo}/pull/${number}`),
			state: String(pr.state ?? "unknown"),
			merged: pr.merged === true,
			draft: pr.draft === true,
			headRefName: String(head?.ref ?? ""),
			headSha: String(head?.sha ?? ""),
			baseRefName: String(base?.ref ?? ""),
			headRepoFullName: String(
				(head?.repo as Record<string, unknown> | undefined)?.full_name ?? "",
			),
		});
	}
	return live;
}

/**
 * Validate an ordered existing stack against live GitHub topology. The PR
 * numbers are authoritative identity; their order must already be parent first.
 */
export function validateAdoptedStack(
	repo: string,
	rootBaseBranch: string,
	numbers: number[],
	live: AdoptedPrLive[],
): StackCarRecord[] {
	if (numbers.length === 0) throw new Error("[escalate] adoption needs at least one PR.");
	assertSafeRef("root base", rootBaseBranch);
	const seenNumbers = new Set<number>();
	const seenBranches = new Set<string>();
	let unlandedSeen = false;
	return numbers.map((number, index) => {
		if (seenNumbers.has(number)) {
			throw new Error(`[escalate] PR #${number} appears twice in the declared stack.`);
		}
		seenNumbers.add(number);
		const pr = live.find((candidate) => candidate.number === number);
		const label = `PR #${number}`;
		if (pr === undefined) throw new Error(`[escalate] cannot adopt ${label}: no live PR data.`);
		if (!pr.merged && pr.state !== "open") {
			throw new Error(`[escalate] cannot adopt ${label}: state is "${pr.state}" and it is not merged.`);
		}
		if (pr.merged && unlandedSeen) {
			throw new Error(`[escalate] cannot adopt ${label}: a landed PR appears above an unlanded parent.`);
		}
		if (!pr.merged) unlandedSeen = true;
		if (!pr.merged && pr.draft) {
			throw new Error(
				`[escalate] cannot adopt ${label}: it is a draft — mark it ready for review first.`,
			);
		}
		if (pr.headRepoFullName.toLowerCase() !== repo.toLowerCase()) {
			throw new Error(
				`[escalate] cannot adopt ${label}: its head lives in "${pr.headRepoFullName}", not "${repo}".`,
			);
		}
		assertSafeRef(`${label} head`, pr.headRefName);
		assertSafeRef(`${label} base`, pr.baseRefName);
		if (pr.headSha === "") {
			throw new Error(`[escalate] cannot adopt ${label}: GitHub did not report a head SHA.`);
		}
		if (seenBranches.has(pr.headRefName)) {
			throw new Error(
				`[escalate] cannot adopt ${label}: branch "${pr.headRefName}" appears twice in the stack.`,
			);
		}
		seenBranches.add(pr.headRefName);

		let expectedBase = rootBaseBranch;
		if (index > 0) {
			let parentIndex = index - 1;
			while (parentIndex >= 0) {
				const parent = live.find((candidate) => candidate.number === numbers[parentIndex]);
				if (parent?.merged !== true) {
					expectedBase = parent?.headRefName ?? "";
					break;
				}
				parentIndex -= 1;
			}
		}
		if (!pr.merged && pr.baseRefName !== expectedBase) {
			throw new Error(
				`[escalate] cannot adopt ${label}: base is "${pr.baseRefName}" but parent-first topology requires "${expectedBase}".`,
			);
		}
		return {
			prNumber: pr.number,
			url: pr.url,
			branch: pr.headRefName,
			baseBranch: pr.baseRefName,
			headSha: pr.headSha,
			landed: pr.merged,
		};
	});
}

export function parseGhStackView(raw: string): GhStackView {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("[escalate] gh stack view --json returned invalid JSON.");
	}
	if (parsed === null || typeof parsed !== "object") {
		throw new Error("[escalate] gh stack view --json returned no stack object.");
	}
	const value = parsed as Record<string, unknown>;
	if (typeof value.trunk !== "string" || typeof value.currentBranch !== "string" || !Array.isArray(value.branches)) {
		throw new Error("[escalate] gh stack view --json omitted trunk, currentBranch, or branches.");
	}
	const branches = value.branches.map((row, index) => {
		if (row === null || typeof row !== "object") {
			throw new Error(`[escalate] gh stack view branch ${index} is invalid.`);
		}
		const branch = row as Record<string, unknown>;
		if (typeof branch.name !== "string" || typeof branch.head !== "string") {
			throw new Error(`[escalate] gh stack view branch ${index} omitted name or head.`);
		}
		const pr = branch.pr;
		return {
			name: branch.name,
			head: branch.head,
			base: String(branch.base ?? ""),
			isCurrent: branch.isCurrent === true,
			isMerged: branch.isMerged === true,
			isQueued: branch.isQueued === true,
			needsRebase: branch.needsRebase === true,
			...(pr !== null && typeof pr === "object"
				? {
						pr: {
							number: Number((pr as Record<string, unknown>).number),
							url: String((pr as Record<string, unknown>).url ?? ""),
							state: String((pr as Record<string, unknown>).state ?? ""),
						},
					}
				: {}),
		};
	});
	return { trunk: value.trunk, currentBranch: value.currentBranch, branches };
}

export function assertGhStackMatches(
	view: GhStackView,
	rootBaseBranch: string,
	branches: string[],
): void {
	if (view.trunk !== rootBaseBranch) {
		throw new Error(
			`[escalate] gh stack trunk is "${view.trunk}", not declared root "${rootBaseBranch}".`,
		);
	}
	const actual = view.branches.map((branch) => branch.name);
	if (
		actual.length !== branches.length ||
		actual.some((branch, index) => branch !== branches[index])
	) {
		throw new Error(
			`[escalate] gh stack order ${JSON.stringify(actual)} does not match declared parent-first order ${JSON.stringify(branches)}.`,
		);
	}
}

/**
 * Adoption may only enter stack mode when this worktree is already tracking
 * the same native GitHub stack. Later checkout/rebase/push commands rely on
 * that local state; discovering it during rework is too late.
 */
export async function assertLocalStackTracking(
	exec: ExecFn,
	args: {
		gh: string;
		worktree: string;
		rootBaseBranch: string;
		cars: StackCarRecord[];
		/** Only the top may contain reviewed local fixes; pipeline separately proves it descends from the live top head. */
		allowTopAhead?: boolean;
	},
): Promise<GhStackView> {
	let raw: string;
	try {
		raw = await execOrThrow(exec, [args.gh, "stack", "view", "--json"], {
			cwd: args.worktree,
		});
	} catch (error) {
		const top = args.cars.at(-1);
		throw new Error(
			`[escalate] adopted stack is not locally tracked in this worktree. ` +
				`Check it out non-interactively with "gh stack checkout ${top?.url ?? top?.prNumber ?? "<top-pr>"}" before starting a new run. ` +
				`${String(error).slice(-500)}`,
		);
	}
	const view = parseGhStackView(raw);
	const branches = args.cars.map((car) => car.branch);
	assertGhStackMatches(view, args.rootBaseBranch, branches);
	const expectedTop = branches.at(-1);
	if (view.currentBranch !== expectedTop) {
		throw new Error(
			`[escalate] adopted stack worktree is on "${view.currentBranch}", not top car "${expectedTop}".`,
		);
	}
	args.cars.forEach((car, index) => {
		const localHead = view.branches[index]?.head;
		const topAheadAllowed =
			args.allowTopAhead === true && index === args.cars.length - 1;
		if (localHead !== car.headSha && !topAheadAllowed) {
			throw new Error(
				`[escalate] locally tracked branch "${car.branch}" is ${localHead ?? "missing"}, not live PR head ${car.headSha}; refusing to adopt or push stale stack state.`,
			);
		}
		const actualPr = view.branches[index]?.pr?.number;
		if (actualPr !== car.prNumber) {
			throw new Error(
				`[escalate] locally tracked branch "${car.branch}" belongs to PR #${actualPr ?? "none"}, not adopted PR #${car.prNumber}.`,
			);
		}
	});
	return view;
}

/**
 * Initialize a declared native stack only when needed, then submit it
 * non-interactively. `gh stack submit` updates existing PRs; adoption never
 * calls this helper, so existing numbered PRs cannot be duplicated.
 */
export async function submitStack(
	exec: ExecFn,
	args: {
		gh: string;
		repo: string;
		worktree: string;
		rootBaseBranch: string;
		specs: StackCarSpec[];
	},
): Promise<StackCarRecord[]> {
	const specs = normalizeStackSpecs(args.rootBaseBranch, args.specs);
	const branches = specs.map((spec) => spec.branch);
	const before = await exec([args.gh, "stack", "view", "--json"], { cwd: args.worktree });
	if (before.code === 2) {
		await execOrThrow(
			exec,
			[args.gh, "stack", "init", "--base", args.rootBaseBranch, ...branches],
			{ cwd: args.worktree },
		);
	} else if (before.code === 0) {
		assertGhStackMatches(parseGhStackView(before.stdout), args.rootBaseBranch, branches);
	} else {
		throw new Error(
			`[escalate] cannot inspect native stack before submit (exit ${before.code}): ${before.stderr.slice(0, 500)}`,
		);
	}
	await execOrThrow(
		exec,
		[args.gh, "stack", "submit", "--auto", "--open"],
		{ cwd: args.worktree },
	);
	const after = await execOrThrow(
		exec,
		[args.gh, "stack", "view", "--json"],
		{ cwd: args.worktree },
	);
	const view = parseGhStackView(after);
	assertGhStackMatches(view, args.rootBaseBranch, branches);
	const numbers = view.branches.map((branch) => branch.pr?.number ?? 0);
	if (numbers.some((number) => !Number.isInteger(number) || number <= 0)) {
		throw new Error("[escalate] gh stack submit completed without a PR number for every car.");
	}
	const live = await fetchAdoptedPrs(exec, args.repo, numbers, args.gh);
	const records = validateAdoptedStack(args.repo, args.rootBaseBranch, numbers, live);
	for (let index = 0; index < specs.length; index += 1) {
		if (records[index].branch !== specs[index].branch) {
			throw new Error(
				`[escalate] submitted PR #${records[index].prNumber} uses branch "${records[index].branch}", not declared branch "${specs[index].branch}".`,
			);
		}
	}
	return records;
}

/**
 * Rebase a stale car and every descendant with gh-stack's non-interactive
 * primitive, run the package test command once, then push the whole stack.
 */
export async function rebaseStackUpstack(
	exec: ExecFn,
	args: {
		gh: string;
		worktree: string;
		rootBaseBranch: string;
		branches: string[];
		fromBranch: string;
		testCommand: string;
	},
): Promise<string[]> {
	if (!args.branches.includes(args.fromBranch)) {
		throw new Error(`[escalate] cannot rebase unknown stack branch "${args.fromBranch}".`);
	}
	const result = await exec(
		[args.gh, "stack", "rebase", "--upstack", args.fromBranch, "--remote", "origin"],
		{ cwd: args.worktree },
	);
	if (result.code !== 0) {
		throw new Error(
			`[escalate] gh stack rebase --upstack failed (exit ${result.code}): ${result.stderr.slice(0, 1000)}`,
		);
	}
	await execOrThrow(exec, ["bash", "-lc", args.testCommand], { cwd: args.worktree });
	await execOrThrow(exec, [args.gh, "stack", "push"], { cwd: args.worktree });
	const view = parseGhStackView(
		await execOrThrow(exec, [args.gh, "stack", "view", "--json"], {
			cwd: args.worktree,
		}),
	);
	assertGhStackMatches(view, args.rootBaseBranch, args.branches);
	return [
		`rebased ${args.fromBranch} and every descendant with gh stack rebase --upstack`,
		"tested the rebased stack",
		"pushed the native stack with gh stack push",
	];
}

/** Prune merged cars only after the whole stack has landed. */
export async function syncStackPrune(
	exec: ExecFn,
	args: { gh: string; worktree: string },
): Promise<string> {
	await execOrThrow(exec, [args.gh, "stack", "sync", "--prune"], {
		cwd: args.worktree,
	});
	return "synchronized and pruned the landed stack with gh stack sync --prune";
}

export interface StackHeadStamp {
	prNumber: number;
	branch: string;
	baseBranch: string;
	headSha: string;
}

export interface StackHeadComparison extends StackHeadStamp {
	currentHead: string;
	ok: boolean;
}

/** Re-fetch every car before any enqueue; one mismatch invalidates all. */
export async function compareStackHeads(
	stamped: StackHeadStamp[],
	fetchHead: (prNumber: number) => Promise<string>,
): Promise<StackHeadComparison[]> {
	const comparisons: StackHeadComparison[] = [];
	for (const car of stamped) {
		const currentHead = await fetchHead(car.prNumber);
		comparisons.push({ ...car, currentHead, ok: currentHead === car.headSha });
	}
	return comparisons;
}

/** Only the lowest unlanded, not-already-submitted car may enter the queue. */
export function nextStackMergeCar(
	cars: StackHeadStamp[],
	states: Array<{ prNumber: number; landed: boolean; submitted: boolean }>,
): StackHeadStamp | undefined {
	for (const car of cars) {
		const state = states.find((candidate) => candidate.prNumber === car.prNumber);
		if (state === undefined) {
			throw new Error(`[escalate] merge state omitted PR #${car.prNumber}.`);
		}
		if (state.landed) continue;
		return state.submitted ? undefined : car;
	}
	return undefined;
}

/** Submit cars parent first after a successful stack-wide head comparison. */
export async function enqueueStackParentFirst(
	cars: StackHeadStamp[],
	enqueue: (prNumber: number) => Promise<string>,
): Promise<Array<{ prNumber: number; receipt: string }>> {
	const receipts: Array<{ prNumber: number; receipt: string }> = [];
	for (const car of cars) {
		receipts.push({ prNumber: car.prNumber, receipt: await enqueue(car.prNumber) });
	}
	return receipts;
}

export interface StackImplementationCar {
	branch: string;
	commits: string[];
}

/**
 * Verify the implementation agent's commit attribution independently for
 * every layer before gh-stack publishes anything.
 */
export async function verifyStackImplementation(
	exec: ExecFn,
	args: {
		git: string;
		worktree: string;
		rootBaseBranch: string;
		specs: StackCarSpec[];
		reported: StackImplementationCar[];
	},
): Promise<Array<{ branch: string; headSha: string; commits: string[] }>> {
	const specs = normalizeStackSpecs(args.rootBaseBranch, args.specs);
	if (
		args.reported.length !== specs.length ||
		args.reported.some((car, index) => car.branch !== specs[index].branch)
	) {
		throw new Error(
			`[escalate] implementation reported stack branches ${JSON.stringify(args.reported.map((car) => car.branch))}, but input declares ${JSON.stringify(specs.map((car) => car.branch))}.`,
		);
	}
	await execOrThrow(exec, [args.git, "fetch", "origin", args.rootBaseBranch], {
		cwd: args.worktree,
	});
	const currentBranch = (
		await execOrThrow(exec, [args.git, "branch", "--show-current"], {
			cwd: args.worktree,
		})
	).trim();
	const topBranch = specs[specs.length - 1].branch;
	if (currentBranch !== topBranch) {
		throw new Error(
			`[escalate] stack worktree is on "${currentBranch || "detached"}", not top car "${topBranch}".`,
		);
	}
	const verified: Array<{ branch: string; headSha: string; commits: string[] }> = [];
	for (let index = 0; index < specs.length; index += 1) {
		const spec = specs[index];
		const baseRef = index === 0 ? `origin/${args.rootBaseBranch}` : specs[index - 1].branch;
		const headSha = (
			await execOrThrow(exec, [args.git, "rev-parse", `${spec.branch}^{commit}`], {
				cwd: args.worktree,
			})
		).trim();
		const commits = (
			await execOrThrow(
				exec,
				[args.git, "rev-list", "--reverse", `${baseRef}..${spec.branch}`],
				{ cwd: args.worktree },
			)
		)
			.split("\n")
			.map((sha) => sha.trim())
			.filter(Boolean);
		const reported = await Promise.all(
			args.reported[index].commits.map((sha) =>
				execOrThrow(exec, [args.git, "rev-parse", "--verify", `${sha}^{commit}`], {
					cwd: args.worktree,
				}).then((value) => value.trim()),
			),
		);
		if (
			commits.length !== reported.length ||
			commits.some((sha, commitIndex) => sha !== reported[commitIndex])
		) {
			throw new Error(
				`[escalate] implementation reported commits ${JSON.stringify(reported)} for "${spec.branch}", but ${baseRef}..${spec.branch} is ${JSON.stringify(commits)}.`,
			);
		}
		verified.push({ branch: spec.branch, headSha, commits });
	}
	return verified;
}
