import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseWatchSet,
	readEffortActivity,
	readWatcherLiveness,
	type ShadowIssue,
} from "../src/firstmate.ts";
import { pollPr, type CommandRunner, type CommandResult } from "../src/poll.ts";
import { DivergenceReportSchema } from "../src/report.ts";
import { main, runShadow } from "../src/shadow.ts";

const NOW_MS = 2_000_000_000_000;
const FAILING_URL = "https://github.com/lindy-ai/lindy/pull/101";
const MERGED_URL = "https://github.com/lindy-ai/lindy/pull/102";
const MALFORMED_URL = "https://github.com/lindy-ai/lindy/pull/103";
const MALFORMED_CHECK_URL = "https://github.com/lindy-ai/lindy/pull/104";
const tempHomes: string[] = [];

interface PollDerivationCase {
	number: number;
	checks: Array<{
		name: string;
		conclusion?: string;
		state?: string;
		status?: string;
	}>;
	reviews: Array<{ state: string; author: { login: string } }>;
	expected: "passing" | "failing" | "pending" | "none";
	reviewDecision: string | undefined;
}

function createHome(): string {
	const home = mkdtempSync(join(tmpdir(), "deck-shadow-"));
	tempHomes.push(home);
	return home;
}

function writeFixture(): string {
	const home = createHome();
	mkdirSync(join(home, "data"), { recursive: true });
	mkdirSync(join(home, "state"), { recursive: true });
	writeFileSync(
		join(home, "data", "backlog.md"),
		[
			"# Backlog",
			"",
			"## In flight",
			"- [ ] alpha - Ship alpha safely (repo: lindy) (kind: ship) (since: 2026-07-20)",
			`  - failing PR ${FAILING_URL}`,
			"  - linked ticket REL-1234",
			"",
			"## Queued",
			"- [ ] ignored - Not in flight (repo: lindy) (kind: scout)",
		].join("\n"),
	);
	writeFileSync(
		join(home, "state", "alpha.meta"),
		[`window=firstmate:fm-alpha`, "kind=ship", `pr=${MERGED_URL}`, "pr_head=abcdef123456"].join(
			"\n",
		),
	);
	writeFileSync(
		join(home, "state", "alpha.pr-poll"),
		[`${MALFORMED_URL}`, "lindy-ai", "lindy", "103"].join("\n") + "\n",
	);
	const statusPath = join(home, "state", "alpha.status");
	writeFileSync(
		statusPath,
		[
			"working: line one",
			"working: line two",
			"working: line three",
			"working: line four",
			"working: line five",
			"working: line six",
		].join("\n") + "\n",
	);
	const oldStatusMs = NOW_MS - 2 * 60 * 60 * 1_000;
	utimesSync(statusPath, oldStatusMs / 1_000, oldStatusMs / 1_000);
	const staleEndedAtSec = (NOW_MS - 10 * 60 * 1_000) / 1_000;
	writeFileSync(
		join(home, "state", ".watch-cycle-exits.log"),
		[
			"beacon_age=31",
			"watcher_pid=11",
			"origin=started",
			`started_at=${staleEndedAtSec - 30}`,
			"arm_pid=10",
			"exit_code=0",
			"signal=none",
			"reason=actionable-heartbeat",
			"lock_before=lock-before",
			"lock_after=lock-after",
			"successor=successor",
			`ended_at=${staleEndedAtSec}`,
		].join("\t") + "\n",
	);
	return home;
}

function ghJson(url: string): CommandResult {
	if (url === FAILING_URL) {
		return {
			stdout: JSON.stringify({
				state: "OPEN",
				statusCheckRollup: [
					{ __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
					{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
				],
				reviews: [],
				updatedAt: new Date(NOW_MS - 1_000).toISOString(),
				mergeStateStatus: "BLOCKED",
			}),
			stderr: "",
			exitCode: 0,
		};
	}
	if (url === MERGED_URL) {
		return {
			stdout: JSON.stringify({
				state: "MERGED",
				statusCheckRollup: [],
				reviews: [{ state: "APPROVED", author: { login: "reviewer" } }],
				updatedAt: new Date(NOW_MS - 2_000).toISOString(),
				mergeStateStatus: "UNKNOWN",
			}),
			stderr: "",
			exitCode: 0,
		};
	}
	return { stdout: "{malformed gh json", stderr: "", exitCode: 0 };
}

const runner: CommandRunner = async (command) => {
	const url = command[3];
	if (url === undefined) {
		throw new Error("test runner received no PR URL");
	}
	expect(command).toEqual([
		"gh",
		"pr",
		"view",
		url,
		"--json",
		"state,statusCheckRollup,reviews,updatedAt,mergeStateStatus",
	]);
	return ghJson(url);
};

afterEach(() => {
	for (const home of tempHomes.splice(0)) {
		rmSync(home, { recursive: true, force: true });
	}
});

describe("firstmate read-only parsing", () => {
	test("parses backlog, meta, pr-poll, status tail, and watcher liveness", () => {
		const home = writeFixture();
		const issues: ShadowIssue[] = [];
		const watchSet = parseWatchSet(home, issues);
		expect(watchSet).toHaveLength(1);
		expect(watchSet[0]).toEqual({
			effortId: "alpha",
			description: "Ship alpha safely",
			repo: "lindy",
			kind: "ship",
			since: "2026-07-20",
			prUrls: [FAILING_URL, MERGED_URL, MALFORMED_URL],
			linearIds: ["REL-1234"],
		});
		const activity = readEffortActivity(home, "alpha", issues);
		expect(activity.statusMtimeMs).toBeCloseTo(NOW_MS - 2 * 60 * 60 * 1_000, -2);
		expect(activity.statusTail?.split("\n")).toEqual([
			"working: line two",
			"working: line three",
			"working: line four",
			"working: line five",
			"working: line six",
		]);
		expect(readWatcherLiveness(home, issues, NOW_MS)).toEqual({
			latestEndedAtMs: NOW_MS - 10 * 60 * 1_000,
			beaconAgeSec: 31,
			ageSinceLatestMs: 10 * 60 * 1_000,
		});
		expect(issues).toEqual([]);
	});

	test("skips missing and malformed files without throwing", async () => {
		const emptyHome = createHome();
		const issues: ShadowIssue[] = [];
		expect(parseWatchSet(emptyHome, issues)).toEqual([]);
		expect(readEffortActivity(emptyHome, "missing", issues)).toEqual({
			statusMtimeMs: null,
			statusTail: null,
		});
		expect(readWatcherLiveness(emptyHome, issues, NOW_MS)).toEqual({
			latestEndedAtMs: null,
			beaconAgeSec: null,
			ageSinceLatestMs: null,
		});
		expect(await pollPr(MALFORMED_URL, runner, issues)).toBeNull();
		expect(
			await pollPr(
				MALFORMED_CHECK_URL,
				async () => ({
					stdout: JSON.stringify({
						state: "OPEN",
						statusCheckRollup: [{}],
						reviews: [],
						updatedAt: new Date(NOW_MS).toISOString(),
						mergeStateStatus: "CLEAN",
					}),
					stderr: "",
					exitCode: 0,
				}),
				issues,
			),
		).toBeNull();
		const sources = issues.map((issue) => issue.source);
		expect(sources.some((source) => source.endsWith("data/backlog.md"))).toBe(true);
		// A missing optional file (.status) is expected, not an issue (ENOENT is silent).
		expect(sources.some((source) => source.endsWith("state/missing.status"))).toBe(false);
		expect(sources.some((source) => source.endsWith("state/.watch-cycle-exits.log"))).toBe(
			true,
		);
		expect(sources).toContain(`github:${MALFORMED_URL}`);
		expect(sources).toContain(`github:${MALFORMED_CHECK_URL}`);
	});

	test("ignores unindented references and rejects state path aliases", () => {
		const home = createHome();
		mkdirSync(join(home, "data"), { recursive: true });
		mkdirSync(join(home, "state"), { recursive: true });
		writeFileSync(
			join(home, "data", "backlog.md"),
			[
				"## In flight",
				"- [ ] alpha - Alpha (repo: lindy) (kind: ship)",
				`  - watched ${FAILING_URL}`,
				`global note that must not attach ${MERGED_URL}`,
				"- [ ] foo/../alpha - Aliased (repo: lindy) (kind: scout)",
				`  - watched ${MALFORMED_URL}`,
			].join("\n"),
		);
		writeFileSync(join(home, "state", "alpha.meta"), "kind=ship\n");
		const issues: ShadowIssue[] = [];
		const watchSet = parseWatchSet(home, issues);
		expect(watchSet[0]?.prUrls).toEqual([FAILING_URL]);
		expect(watchSet[1]?.prUrls).toEqual([MALFORMED_URL]);
		expect(watchSet.flatMap((effort) => effort.prUrls)).not.toContain(MERGED_URL);
		expect(issues.some((issue) => issue.message.includes("safe state filename"))).toBe(true);
	});

	test("skips blank and overflowing watch-cycle values", () => {
		const home = createHome();
		mkdirSync(join(home, "state"), { recursive: true });
		const path = join(home, "state", ".watch-cycle-exits.log");
		const issues: ShadowIssue[] = [];
		writeFileSync(path, "ended_at=\tbeacon_age=31\n");
		expect(readWatcherLiveness(home, issues, NOW_MS).latestEndedAtMs).toBeNull();
		writeFileSync(path, `ended_at=${"9".repeat(309)}\tbeacon_age=31\n`);
		expect(readWatcherLiveness(home, issues, NOW_MS).latestEndedAtMs).toBeNull();
		expect(issues).toHaveLength(2);
	});

	test("rejects malformed URL suffixes, duplicate ids, duplicate meta keys, and invalid UTF-8", () => {
		const home = createHome();
		mkdirSync(join(home, "data"), { recursive: true });
		mkdirSync(join(home, "state"), { recursive: true });
		const backlogPath = join(home, "data", "backlog.md");
		writeFileSync(
			backlogPath,
			[
				"## In flight",
				"- [ ] alpha - Alpha (repo: lindy) (kind: ship)",
				`  - ${FAILING_URL} https://github.com/lindy-ai/lindy/pull/999abc https://github.com/?/repo/pull/1 https://github.com/foo\\bar/repo/pull/1`,
				"- [ ] alpha - Duplicate (repo: lindy) (kind: scout)",
				`  - ${MERGED_URL}`,
			].join("\n"),
		);
		writeFileSync(
			join(home, "state", "alpha.meta"),
			`pr=${MERGED_URL}\npr=${MALFORMED_URL}\n`,
		);
		const issues: ShadowIssue[] = [];
		const watchSet = parseWatchSet(home, issues);
		expect(watchSet).toHaveLength(1);
		expect(watchSet[0]?.prUrls).toEqual([FAILING_URL]);
		expect(issues.some((issue) => issue.message.includes("malformed GitHub"))).toBe(true);
		expect(issues.some((issue) => issue.message.includes("duplicate In flight effort"))).toBe(
			true,
		);
		expect(issues.some((issue) => issue.message.includes("duplicates key pr"))).toBe(true);

		writeFileSync(backlogPath, Buffer.from([0xff]));
		const utf8Issues: ShadowIssue[] = [];
		expect(parseWatchSet(home, utf8Issues)).toEqual([]);
		expect(utf8Issues).toHaveLength(1);
		expect(utf8Issues[0]?.source).toBe(backlogPath);
	});

	test("rejects non-canonical raw URL syntax from meta files", () => {
		const home = createHome();
		mkdirSync(join(home, "data"), { recursive: true });
		mkdirSync(join(home, "state"), { recursive: true });
		writeFileSync(
			join(home, "data", "backlog.md"),
			"## In flight\n- [ ] alpha - Alpha (repo: lindy) (kind: ship)\n",
		);
		const metaPath = join(home, "state", "alpha.meta");
		const invalidValues = [
			"not-a-url",
			"https://github.com/foo\\bar/pull/1",
			"https://github.com:443/org/repo/pull/1",
			"https://github.com/org/repo/pull/1?",
			"https://github.com/org/repo/pull/1#",
			"https://@github.com/org/repo/pull/1",
		];
		for (const value of invalidValues) {
			writeFileSync(metaPath, `pr=${value}\n`);
			const issues: ShadowIssue[] = [];
			expect(parseWatchSet(home, issues)[0]?.prUrls).toEqual([]);
			expect(issues.some((issue) => issue.source === metaPath)).toBe(true);
		}
	});

	test("keeps a complete status record at the bounded tail boundary", () => {
		const home = createHome();
		mkdirSync(join(home, "state"), { recursive: true });
		const prefix = "discarded prefix\n";
		const fixed = "one\ntwo\nthree\nfour\n";
		const boundedTail = fixed + "z".repeat(64 * 1024 - fixed.length);
		writeFileSync(join(home, "state", "alpha.status"), prefix + boundedTail);
		const activity = readEffortActivity(home, "alpha");
		const lines = activity.statusTail?.split("\n") ?? [];
		expect(lines).toHaveLength(5);
		expect(lines.slice(0, 4)).toEqual(["one", "two", "three", "four"]);
		expect(lines[4]).toHaveLength(64 * 1024 - fixed.length);

		const oversizedIssues: ShadowIssue[] = [];
		writeFileSync(
			join(home, "state", "alpha.status"),
			"x".repeat(64 * 1024 + 1) + "\n",
		);
		expect(readEffortActivity(home, "alpha", oversizedIssues)).toEqual({
			statusMtimeMs: null,
			statusTail: null,
		});
		expect(oversizedIssues.some((issue) => issue.message.includes("last record exceeds"))).toBe(
			true,
		);
	});
});

describe("GitHub fact derivation", () => {
	test("derives passing, pending, none, and active review decisions", async () => {
		const cases: PollDerivationCase[] = [
			{
				number: 201,
				checks: [{ name: "unit", conclusion: "SUCCESS" }, { name: "lint", state: "NEUTRAL" }],
				reviews: [],
				expected: "passing",
				reviewDecision: undefined,
			},
			{
				number: 202,
				checks: [
					{ name: "unit", conclusion: "SUCCESS" },
					{ name: "deploy", status: "IN_PROGRESS", conclusion: "" },
				],
				reviews: [
					{ state: "CHANGES_REQUESTED", author: { login: "reviewer" } },
					{ state: "COMMENTED", author: { login: "reviewer" } },
				],
				expected: "pending",
				reviewDecision: "CHANGES_REQUESTED",
			},
			{
				number: 203,
				checks: [],
				reviews: [],
				expected: "none",
				reviewDecision: undefined,
			},
			{
				number: 204,
				checks: [{ name: "malformed", conclusion: " FAILURE " }],
				reviews: [],
				expected: "pending",
				reviewDecision: undefined,
			},
		];
		for (const testCase of cases) {
			const url = `https://github.com/lindy-ai/lindy/pull/${testCase.number}`;
			const fact = await pollPr(url, async () => ({
				stdout: JSON.stringify({
					state: "OPEN",
					statusCheckRollup: testCase.checks,
					reviews: testCase.reviews,
					updatedAt: new Date(NOW_MS).toISOString(),
					mergeStateStatus: "CLEAN",
				}),
				stderr: "",
				exitCode: 0,
			}));
			expect(fact?.checksRollup).toBe(testCase.expected);
			expect(fact?.reviewDecision).toBe(testCase.reviewDecision);
		}
	});

	test("rejects a non-ISO GitHub update timestamp", async () => {
		const issues: ShadowIssue[] = [];
		const fact = await pollPr(
			MALFORMED_CHECK_URL,
			async () => ({
				stdout: JSON.stringify({
					state: "OPEN",
					statusCheckRollup: [],
					reviews: [],
					updatedAt: "July 25, 2026",
					mergeStateStatus: "CLEAN",
				}),
				stderr: "",
				exitCode: 0,
			}),
			issues,
		);
		expect(fact).toBeNull();
		expect(issues).toHaveLength(1);
	});
});

describe("one-pass divergence report", () => {
	test("flags stale actionable facts, watcher stalls, and preserves JSON shape", async () => {
		const home = writeFixture();
		const stdout: string[] = [];
		const stderr: string[] = [];
		const report = await runShadow(["--json", "--fm-home", home], {
			run: runner,
			now: () => NOW_MS,
			stdout: (value) => stdout.push(value),
			stderr: (value) => stderr.push(value),
		});
		expect(report.coverage).toEqual({
			totalEfforts: 1,
			totalPrs: 3,
			resolvedPrs: 2,
			erroredPrs: 1,
		});
		expect(report.efforts[0]?.flagged).toBe(true);
		expect(report.efforts[0]?.flagReason).toBe(
			"deck holds a fresh actionable fact firstmate appears behind on",
		);
		expect(report.efforts[0]?.prs[0]).toMatchObject({
			resolved: true,
			checksRollup: "failing",
			failingChecks: ["lint"],
		});
		const merged = report.efforts[0]?.prs.find((pr) => pr.url === MERGED_URL);
		expect(merged).toMatchObject({
			resolved: true,
			state: "MERGED",
			checksRollup: "none",
			reviewDecision: "APPROVED",
		});
		expect(report.watcherStall).toMatchObject({
			detected: true,
			shadowPollSucceeded: true,
			thresholdMs: 300_000,
		});
		expect(stderr).toHaveLength(1);
		expect(stderr[0]).toContain(MALFORMED_URL);
		const machine: unknown = JSON.parse(stdout[0] ?? "");
		const stableReport = DivergenceReportSchema.parse(machine);
		expect(stableReport).toEqual(report);
		expect(Object.keys(report)).toEqual([
			"header",
			"generatedAtMs",
			"statusStaleThresholdMs",
			"coverage",
			"efforts",
			"watcherStall",
			"liveness",
		]);
		expect(Object.keys(report.coverage)).toEqual([
			"totalEfforts",
			"totalPrs",
			"resolvedPrs",
			"erroredPrs",
		]);
		expect(Object.keys(report.efforts[0] ?? {})).toEqual([
			"effortId",
			"description",
			"statusMtimeMs",
			"ageSinceStatusMs",
			"statusTail",
			"prs",
			"flagged",
			"flagReason",
		]);
		expect(Object.keys(report.efforts[0]?.prs[0] ?? {})).toEqual([
			"url",
			"resolved",
			"state",
			"checksRollup",
			"failingChecks",
			"reviewDecision",
			"deckFactUpdatedAtMs",
			"mergeStateStatus",
		]);
		const errored = report.efforts[0]?.prs.find((pr) => pr.url === MALFORMED_URL);
		expect(Object.keys(errored ?? {})).toEqual(["url", "resolved", "error"]);
	});

	test("prints actionable detail in human mode and keeps main exit zero", async () => {
		const home = writeFixture();
		const stdout: string[] = [];
		await runShadow(["--fm-home", home], {
			run: runner,
			now: () => NOW_MS,
			stdout: (value) => stdout.push(value),
			stderr: () => undefined,
		});
		const human = stdout[0] ?? "";
		expect(human).toContain("lint");
		expect(human).toContain("APPROVED");
		expect(human).toContain("STATUS TAIL");
		expect(human).toContain("working: line six");
		expect(human).toContain("FLAG REASON");

		const emptyHome = createHome();
		mkdirSync(join(emptyHome, "data"), { recursive: true });
		mkdirSync(join(emptyHome, "state"), { recursive: true });
		writeFileSync(join(emptyHome, "data", "backlog.md"), "## In flight\n");
		const endedAt = Math.floor(Date.now() / 1_000);
		writeFileSync(
			join(emptyHome, "state", ".watch-cycle-exits.log"),
			`ended_at=${endedAt}\tbeacon_age=1\n`,
		);
		const log = spyOn(console, "log").mockImplementation(() => undefined);
		const error = spyOn(console, "error").mockImplementation(() => undefined);
		const priorExitCode = process.exitCode;
		process.exitCode = 17;
		try {
			await main(["--json", "--fm-home", emptyHome]);
			expect(process.exitCode).toBe(0);
		} finally {
			process.exitCode = priorExitCode;
			log.mockRestore();
			error.mockRestore();
		}
	});
});
