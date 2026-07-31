/**
 * request-reviewers stage: CODEOWNERS parsing/matching, recent-author
 * frequency fallback, hard exclusions (ali is never a reviewer), and the
 * gh adapters against a mocked exec (request POST + the silent-no-op
 * verification read).
 */

import { describe, expect, test } from "bun:test";

import {
	fetchCodeowners,
	fetchRequestedReviewers,
	requestReviewers,
	resolveReviewerLogin,
	type ExecFn,
} from "../lib/gh.ts";
import {
	codeownersFor,
	executeReviewerRequest,
	parseCodeowners,
	selectReviewers,
	type ReviewerRequestAdapters,
} from "../lib/reviewers.ts";

// ---------------------------------------------------------------------------
// CODEOWNERS parsing + matching
// ---------------------------------------------------------------------------

describe("parseCodeowners", () => {
	test("parses rules, skipping comments, blanks, teams, and emails", () => {
		const rules = parseCodeowners(
			[
				"# comment",
				"",
				"*.ts @Swader @bgar324",
				"/packages/api/ @sghmk12 @lindy-ai/backend-team docs@lindy.ai",
				"docs/ # no owners",
			].join("\n"),
		);
		expect(rules).toEqual([
			{ pattern: "*.ts", owners: ["Swader", "bgar324"] },
			{ pattern: "/packages/api/", owners: ["sghmk12"] },
		]);
	});
});

describe("codeownersFor", () => {
	const rules = parseCodeowners(
		["* @fallback", "*.ts @tsowner", "/packages/api/ @apiowner", "src/**/*.test.ts @testowner"].join(
			"\n",
		),
	);

	test("last matching rule wins per file", () => {
		expect(codeownersFor(rules, ["src/deep/a.test.ts"])).toEqual(["testowner"]);
		expect(codeownersFor(rules, ["src/feature.ts"])).toEqual(["tsowner"]);
	});

	test("directory pattern owns everything beneath it", () => {
		expect(codeownersFor(rules, ["packages/api/deep/handler.py"])).toEqual(["apiowner"]);
	});

	test("catch-all applies when nothing more specific matches", () => {
		expect(codeownersFor(rules, ["README.md"])).toEqual(["fallback"]);
	});

	test("unions owners across files", () => {
		expect(codeownersFor(rules, ["src/feature.ts", "packages/api/x.py"]).sort()).toEqual([
			"apiowner",
			"tsowner",
		]);
	});

	test("no rules -> no owners (thin CODEOWNERS case)", () => {
		expect(codeownersFor([], ["src/feature.ts"])).toEqual([]);
	});

	// GitHub CODEOWNERS semantics, NOT gitignore: `docs/*` owns direct
	// children only; `**/` matches zero or more directories.
	test("single-star directory pattern does NOT own nested files", () => {
		const r = parseCodeowners("docs/* @docsowner");
		expect(codeownersFor(r, ["docs/getting-started.md"])).toEqual(["docsowner"]);
		expect(codeownersFor(r, ["docs/build-app/troubleshooting.md"])).toEqual([]);
	});

	test("** matches zero directories", () => {
		expect(codeownersFor(rules, ["src/a.test.ts"])).toEqual(["testowner"]);
	});

	test("unanchored extension pattern does not own descendants of a matching directory", () => {
		const r = parseCodeowners("*.ts @tsowner");
		expect(codeownersFor(r, ["weird.ts/readme.md"])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// selectReviewers
// ---------------------------------------------------------------------------

describe("selectReviewers", () => {
	test("codeowners first, recent authors fill the remainder by frequency", () => {
		const result = selectReviewers({
			explicit: [],
			codeowners: ["Swader"],
			recentAuthors: ["bgar324", "sghmk12", "bgar324"],
			exclude: [],
			max: 2,
		});
		expect(result.reviewers).toEqual(["Swader", "bgar324"]);
		expect(result.source).toBe("mixed");
	});

	test("recent-author fallback ranks by commit frequency", () => {
		const result = selectReviewers({
			explicit: [],
			codeowners: [],
			recentAuthors: ["a", "b", "b", "b", "c", "c"],
			exclude: [],
			max: 2,
		});
		expect(result.reviewers).toEqual(["b", "c"]);
		expect(result.source).toBe("recent-authors");
	});

	test("never selects ali (excluded approver), case-insensitive", () => {
		const result = selectReviewers({
			explicit: ["Ali"],
			codeowners: ["ALI"],
			recentAuthors: ["ali", "ali", "ali", "Swader"],
			exclude: ["ali"],
			max: 2,
		});
		expect(result.reviewers).toEqual(["Swader"]);
	});

	test("never selects self or bots", () => {
		const result = selectReviewers({
			explicit: [],
			codeowners: ["twaldin"],
			recentAuthors: ["dependabot[bot]", "twaldin", "bgar324"],
			exclude: ["twaldin"],
			max: 2,
		});
		expect(result.reviewers).toEqual(["bgar324"]);
	});

	test("explicit reviewers take priority and dedupe against other sources", () => {
		const result = selectReviewers({
			explicit: ["sghmk12"],
			codeowners: ["sghmk12", "Swader"],
			recentAuthors: [],
			exclude: [],
			max: 2,
		});
		expect(result.reviewers).toEqual(["sghmk12", "Swader"]);
	});

	test("empty candidates -> none (the caller escalates; never a silent empty request)", () => {
		const result = selectReviewers({
			explicit: [],
			codeowners: [],
			recentAuthors: [],
			exclude: ["ali"],
			max: 2,
		});
		expect(result.reviewers).toEqual([]);
		expect(result.source).toBe("none");
	});
});

// ---------------------------------------------------------------------------
// gh adapters against a mocked exec
// ---------------------------------------------------------------------------

function mockExec(handler: (argv: string[]) => { code: number; stdout: string } | undefined): {
	exec: ExecFn;
	calls: string[][];
} {
	const calls: string[][] = [];
	const exec: ExecFn = async (argv) => {
		calls.push(argv);
		const result = handler(argv) ?? { code: 1, stdout: "" };
		return { code: result.code, stdout: result.stdout, stderr: "" };
	};
	return { exec, calls };
}

const ctx = (exec: ExecFn) => ({ gh: "gh", repo: "lindy-ai/lindy", exec });

describe("fetchCodeowners", () => {
	test("falls back through the well-known paths and returns raw content", async () => {
		const { exec } = mockExec((argv) => {
			const path = argv[2] ?? "";
			if (path.endsWith("contents/CODEOWNERS")) return { code: 0, stdout: "* @Swader\n" };
			return undefined; // .github/CODEOWNERS 404s first
		});
		expect(await fetchCodeowners(ctx(exec))).toBe("* @Swader\n");
	});

	test("returns null when no CODEOWNERS exists anywhere", async () => {
		const { exec } = mockExec(() => undefined);
		expect(await fetchCodeowners(ctx(exec))).toBeNull();
	});
});

describe("requestReviewers + verification (the silent no-op trap)", () => {
	test("POSTs each reviewer and the verification read returns the live list", async () => {
		const { exec, calls } = mockExec((argv) => {
			if (argv.includes("-X")) return { code: 0, stdout: "{}" };
			return { code: 0, stdout: JSON.stringify({ users: [{ login: "Swader" }] }) };
		});
		await requestReviewers(ctx(exec), 42, ["Swader", "ghost-login"]);
		const post = calls[0];
		expect(post).toContain("repos/lindy-ai/lindy/pulls/42/requested_reviewers");
		expect(post).toContain("reviewers[]=Swader");
		expect(post).toContain("reviewers[]=ghost-login");

		// The verification read exposes the silently dropped login:
		const live = await fetchRequestedReviewers(ctx(exec), 42);
		expect(live).toEqual(["Swader"]);
		expect(live).not.toContain("ghost-login");
	});
});

describe("resolveReviewerLogin (gh-reviewer-lookup pattern)", () => {
	test("verifies a real login directly via /users", async () => {
		const { exec } = mockExec((argv) => {
			if (argv[2] === "users/Swader") return { code: 0, stdout: "Swader\n" };
			return undefined;
		});
		expect(await resolveReviewerLogin(ctx(exec), "Swader")).toBe("Swader");
	});

	test("falls back to commit-author name search for a display name (filtered in TS, not jq)", async () => {
		const commits = JSON.stringify([
			{ commit: { author: { name: "Someone Else" } }, author: { login: "other" } },
			{ commit: { author: { name: "Benjamin G" } }, author: { login: "bgar324" } },
		]);
		const { exec, calls } = mockExec((argv) => {
			if ((argv[2] ?? "").startsWith("repos/lindy-ai/lindy/commits"))
				return { code: 0, stdout: commits };
			return undefined;
		});
		expect(await resolveReviewerLogin(ctx(exec), "Benjamin G")).toBe("bgar324");
		// A display name with a space never hits /users/<mangled path>:
		expect(calls.some((argv) => (argv[2] ?? "").startsWith("users/"))).toBe(false);
	});

	test("returns null when nothing resolves", async () => {
		const { exec } = mockExec(() => undefined);
		expect(await resolveReviewerLogin(ctx(exec), "Nobody Known")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// executeReviewerRequest (the full stage against mocked adapters)
// ---------------------------------------------------------------------------

function adapters(overrides: Partial<ReviewerRequestAdapters> = {}): ReviewerRequestAdapters {
	return {
		fetchChangedFiles: async () => ["src/feature.ts"],
		fetchCodeowners: async () => null,
		fetchRecentAuthors: async () => ["Swader", "Swader", "bgar324"],
		resolveLogin: async (entry) => entry,
		requestReviewers: async () => {},
		fetchRequestedReviewers: async () => ["Swader", "bgar324"],
		...overrides,
	};
}

const config = { explicit: [], exclude: ["twaldin", "ali"], max: 2 };

describe("executeReviewerRequest", () => {
	test("happy path: selects, requests, verifies", async () => {
		const requested: string[][] = [];
		const result = await executeReviewerRequest(config, adapters({
			requestReviewers: async (logins) => {
				requested.push(logins);
			},
		}));
		expect(requested).toEqual([["Swader", "bgar324"]]);
		expect(result.verified).toEqual(["Swader", "bgar324"]);
		expect(result.skipped).toBe(false);
	});

	test("escalates on zero candidates (never a silent unreviewed PR)", async () => {
		expect(
			executeReviewerRequest(config, adapters({ fetchRecentAuthors: async () => [] })),
		).rejects.toThrow(/\[escalate\] no reviewer candidates/);
	});

	test("escalates when GH silently drops a requested login", async () => {
		expect(
			executeReviewerRequest(
				config,
				adapters({ fetchRequestedReviewers: async () => ["Swader"] }),
			),
		).rejects.toThrow(/silently no-op'd for: bgar324/);
	});

	test("escalates on an unresolvable explicit reviewer instead of dropping it", async () => {
		expect(
			executeReviewerRequest(
				{ ...config, explicit: ["Ghost Person"] },
				adapters({ resolveLogin: async () => null }),
			),
		).rejects.toThrow(/Ghost Person/);
	});

	test("never requests ali even when ali dominates recent authors", async () => {
		const requested: string[][] = [];
		await executeReviewerRequest(
			config,
			adapters({
				fetchRecentAuthors: async () => ["ali", "ali", "ali", "Swader", "bgar324"],
				requestReviewers: async (logins) => {
					requested.push(logins);
				},
			}),
		);
		expect(requested[0]).toEqual(["Swader", "bgar324"]);
		expect(requested[0]).not.toContain("ali");
	});
});
