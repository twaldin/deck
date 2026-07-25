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
import {
	classifyActor,
	deriveSessionFindings,
	emptySessionStore,
	indexFromStore,
	ingestLine,
	loadSessionStore,
	saveSessionStore,
	updateSessionStore,
	type SessionRoots,
} from "../src/sessions.ts";

const NOW_MS = 2_000_000_000_000;
const FAILING_URL = "https://github.com/lindy-ai/lindy/pull/101";
const MERGED_URL = "https://github.com/lindy-ai/lindy/pull/102";
const MALFORMED_URL = "https://github.com/lindy-ai/lindy/pull/103";
const MALFORMED_CHECK_URL = "https://github.com/lindy-ai/lindy/pull/104";
const LANDED_URL = "https://github.com/lindy-ai/lindy/pull/105";
const DROPPED_URL = "https://github.com/lindy-ai/lindy/pull/106";
const tempHomes: string[] = [];

/** Hermetic session scanning: empty roots + throwaway store, never the real ~/. */
function hermeticSessions(): { sessionRoots: SessionRoots; sessionStorePath: string } {
	const root = mkdtempSync(join(tmpdir(), "deck-sessions-"));
	tempHomes.push(root);
	return {
		sessionRoots: {
			claudeProjects: join(root, "claude"),
			codexSessions: join(root, "codex"),
			ompSessions: join(root, "omp"),
		},
		sessionStorePath: join(root, "session-index.json"),
	};
}

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
	if (url === LANDED_URL) {
		return {
			stdout: JSON.stringify({
				state: "CLOSED",
				statusCheckRollup: [],
				reviews: [{ state: "APPROVED", author: { login: "reviewer" } }],
				updatedAt: new Date(NOW_MS - 3_000).toISOString(),
				mergeStateStatus: "UNKNOWN",
			}),
			stderr: "",
			exitCode: 0,
		};
	}
	if (url === DROPPED_URL) {
		return {
			stdout: JSON.stringify({
				state: "CLOSED",
				statusCheckRollup: [],
				reviews: [],
				updatedAt: new Date(NOW_MS - 4_000).toISOString(),
				mergeStateStatus: "UNKNOWN",
			}),
			stderr: "",
			exitCode: 0,
		};
	}
	return { stdout: "{malformed gh json", stderr: "", exitCode: 0 };
}

/** Stub the Graphite landing search: LANDED_URL has a (#105) squash commit on main, DROPPED_URL has none. */
function ghCommitSearch(token: string): CommandResult {
	if (token === "(#105)") {
		return {
			stdout: JSON.stringify([{ sha: "deadbeefcafe", commit: { message: "[REL-1] land it (#105)" } }]),
			stderr: "",
			exitCode: 0,
		};
	}
	return { stdout: "[]", stderr: "", exitCode: 0 };
}

const runner: CommandRunner = async (command) => {
	if (command[1] === "search" && command[2] === "commits") {
		const token = command[3];
		if (token === undefined) throw new Error("test runner received no search token");
		return ghCommitSearch(token);
	}
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

	test("Graphite lands-and-closes: CLOSED PR with a (#N) squash commit on main resolves to landed, not dropped", async () => {
		// The #25426 class: GitHub reports CLOSED/mergedAt=null but the change was
		// squash-landed onto main; firstmate's learnings.md documents this exact
		// trap. A CLOSED PR must be resolved against the base branch before it is
		// ever treated as unmerged/dropped.
		const landingRunner: CommandRunner = async (command) => {
			if (command[1] === "search" && command[2] === "commits") {
				return {
					stdout: JSON.stringify([{ sha: "0e2a9694cafe", commit: { message: "[REL-10527] Preserve daily brief calendar titles (#25426)" } }]),
					stderr: "",
					exitCode: 0,
				};
			}
			return {
				stdout: JSON.stringify({ state: "CLOSED", statusCheckRollup: [], reviews: [], updatedAt: new Date(NOW_MS).toISOString(), mergeStateStatus: "UNKNOWN" }),
				stderr: "",
				exitCode: 0,
			};
		};
		const landed = await pollPr("https://github.com/lindy-ai/lindy/pull/25426", landingRunner, []);
		expect(landed?.state).toBe("CLOSED");
		expect(landed?.landed).toBe(true);
		expect(landed?.landedSha).toBe("0e2a9694cafe");

		// Contrast: a CLOSED PR with NO squash commit on main is genuinely dropped.
		const droppedRunner: CommandRunner = async (command) => {
			if (command[1] === "search" && command[2] === "commits") {
				return { stdout: "[]", stderr: "", exitCode: 0 };
			}
			return {
				stdout: JSON.stringify({ state: "CLOSED", statusCheckRollup: [], reviews: [], updatedAt: new Date(NOW_MS).toISOString(), mergeStateStatus: "UNKNOWN" }),
				stderr: "",
				exitCode: 0,
			};
		};
		const dropped = await pollPr("https://github.com/lindy-ai/lindy/pull/99999", droppedRunner, []);
		expect(dropped?.state).toBe("CLOSED");
		expect(dropped?.landed).toBe(false);
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
			...hermeticSessions(),
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
			"sessions",
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
			"landed",
			"landedSha",
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
			...hermeticSessions(),
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
			await main(["--json", "--fm-home", emptyHome, "--no-sessions"]);
			expect(process.exitCode).toBe(0);
		} finally {
			process.exitCode = priorExitCode;
			log.mockRestore();
			error.mockRestore();
		}
	});
});

describe("session evidence streaming", () => {
	const CLAUDE_TS = new Date(NOW_MS - 10 * 60_000).toISOString();
	const NEWER_TS = new Date(NOW_MS - 5 * 60_000).toISOString();

	function line(record: Record<string, unknown>): string {
		return `${JSON.stringify(record)}\n`;
	}

	test("provenance: only work records feed the index, stamped with record ts", () => {
		const store = emptySessionStore();
		// Passive: hook/context injection quoting a PR (Claude startup GitHub summary).
		ingestLine(store, "claude", "worker", "/log/a.jsonl", JSON.stringify({ type: "attachment", timestamp: CLAUDE_TS, attachment: { content: `open PRs: ${FAILING_URL}` } }));
		// Passive: plain user prompt mentioning a Linear id.
		ingestLine(store, "claude", "worker", "/log/a.jsonl", JSON.stringify({ type: "user", timestamp: CLAUDE_TS, message: { role: "user", content: "please fix REL-777" } }));
		expect(Object.keys(store.prTs)).toEqual([]);
		expect(Object.keys(store.linearTs)).toEqual([]);
		// Active: assistant turn working the PR.
		ingestLine(store, "claude", "worker", "/log/a.jsonl", JSON.stringify({ type: "assistant", timestamp: CLAUDE_TS, message: { role: "assistant", content: `pushing fix to ${FAILING_URL} for REL-777` } }));
		expect(store.prTs[FAILING_URL]?.worker?.tsMs).toBe(Date.parse(CLAUDE_TS));
		expect(store.linearTs["REL-777"]?.worker?.tsMs).toBe(Date.parse(CLAUDE_TS));
		// Active: tool result (claude user record with toolUseResult) advances the ts.
		ingestLine(store, "claude", "worker", "/log/a.jsonl", JSON.stringify({ type: "user", timestamp: NEWER_TS, toolUseResult: { stdout: `merged ${FAILING_URL}` } }));
		expect(store.prTs[FAILING_URL]?.worker?.tsMs).toBe(Date.parse(NEWER_TS));
		// codex: function_call active, user message passive.
		ingestLine(store, "codex", "worker", "/log/c.jsonl", JSON.stringify({ type: "response_item", timestamp: NEWER_TS, payload: { type: "function_call", arguments: "gh pr view https://github.com/lindy-ai/lindy/pull/900" } }));
		ingestLine(store, "codex", "worker", "/log/c.jsonl", JSON.stringify({ type: "response_item", timestamp: NEWER_TS, payload: { type: "message", role: "user", content: "look at https://github.com/lindy-ai/lindy/pull/901" } }));
		expect(store.prTs["https://github.com/lindy-ai/lindy/pull/900"]?.worker).toBeDefined();
		expect(store.prTs["https://github.com/lindy-ai/lindy/pull/901"]).toBeUndefined();
		// omp: toolResult active; custom (system injection) passive.
		ingestLine(store, "omp", "worker", "/log/o.jsonl", JSON.stringify({ type: "message", timestamp: NEWER_TS, message: { role: "toolResult", content: "ENG-55 test green" } }));
		ingestLine(store, "omp", "worker", "/log/o.jsonl", JSON.stringify({ type: "custom", timestamp: NEWER_TS, data: "ENG-56 injected context" }));
		expect(store.linearTs["ENG-55"]?.worker).toBeDefined();
		expect(store.linearTs["ENG-56"]).toBeUndefined();
	});

	test("actor partition: firstmate transcripts never count as worker activity", () => {
		expect(classifyActor("/Users/u/.omp/agent/sessions/-firstmate/x.jsonl")).toBe("firstmate");
		expect(classifyActor("/Users/u/.omp/agent/sessions/-firstmate/2026-07-23T17-26-14_abc/__advisor.jsonl")).toBe("firstmate");
		expect(classifyActor("/Users/u/.claude/projects/-Users-twaldin-firstmate/y.jsonl")).toBe("firstmate");
		expect(classifyActor("/Users/u/.claude/projects/-Users-twaldin--treehouse-firstmate-7bab20-5-firstmate/z.jsonl")).toBe("worker");
		expect(classifyActor("/Users/u/.codex/sessions/2026/07/24/r.jsonl")).toBe("worker");
		const store = emptySessionStore();
		ingestLine(store, "omp", "firstmate", "/log/fm.jsonl", JSON.stringify({ type: "message", timestamp: CLAUDE_TS, message: { role: "assistant", content: `I should follow up on ${FAILING_URL} (REL-321)` } }));
		expect(store.prTs[FAILING_URL]?.firstmate).toBeDefined();
		expect(store.prTs[FAILING_URL]?.worker).toBeUndefined();
		// Firstmate-only activity produces NO fm_behind finding.
		const index = indexFromStore(store);
		const watchSet = [{ effortId: "alpha", description: "", repo: "", prUrls: [FAILING_URL], linearIds: ["REL-321"] }];
		const statusMtime = new Map<string, number | null>([["alpha", NOW_MS - 5 * 60 * 60_000]]);
		const findings = deriveSessionFindings(watchSet, statusMtime, new Map(), index, { nowMs: NOW_MS });
		expect(findings.filter((finding) => finding.kind === "fm_behind_sessions")).toEqual([]);
	});

	test("bootstrap digests and inventory dumps never count as work", () => {
		const store = emptySessionStore();
		// fm-session-start invocation record.
		ingestLine(store, "omp", "firstmate", "/log/fm.jsonl", JSON.stringify({ type: "message", timestamp: CLAUDE_TS, message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "bin/fm-session-start.sh" } }] } }));
		// Fleet-wide digest: one record touching many efforts.
		const digest = Array.from({ length: 12 }, (_, index) => `REL-${9100 + index}`).join(" ");
		ingestLine(store, "omp", "firstmate", "/log/fm.jsonl", JSON.stringify({ type: "message", timestamp: CLAUDE_TS, message: { role: "toolResult", content: digest } }));
		expect(Object.keys(store.linearTs)).toEqual([]);
		expect(Object.keys(store.prTs)).toEqual([]);
	});

	test("codex cwd is authoritative: fm-cwd => firstmate, deck-cwd => excluded (paths are date-only)", () => {
		const root = mkdtempSync(join(tmpdir(), "deck-cwd-"));
		tempHomes.push(root);
		const fmHome = join(root, "firstmate");
		const deckHome = join(root, "dev", "deck");
		const codexDay = join(root, "codex", "2026", "07", "25");
		mkdirSync(codexDay, { recursive: true });
		const roots = { claudeProjects: join(root, "claude"), codexSessions: join(root, "codex"), ompSessions: join(root, "omp") };
		// File A: session_meta says cwd=~/firstmate -> firstmate cognition, despite a date-only path.
		const fmFile = join(codexDay, "rollout-fm.jsonl");
		writeFileSync(
			fmFile,
			line({ type: "session_meta", timestamp: CLAUDE_TS, payload: { cwd: fmHome } }) +
				line({ type: "response_item", timestamp: CLAUDE_TS, payload: { type: "function_call", arguments: "gh pr view https://github.com/lindy-ai/lindy/pull/600" } }),
		);
		// File B: session_meta says cwd=~/dev/deck -> excluded wholesale.
		const deckFile = join(codexDay, "rollout-deck.jsonl");
		writeFileSync(
			deckFile,
			line({ type: "session_meta", timestamp: CLAUDE_TS, payload: { cwd: deckHome } }) +
				line({ type: "response_item", timestamp: CLAUDE_TS, payload: { type: "function_call", arguments: "gh pr view https://github.com/lindy-ai/lindy/pull/601" } }),
		);
		const store = emptySessionStore();
		const issues: ShadowIssue[] = [];
		updateSessionStore(store, issues, { roots, nowMs: NOW_MS, windowMs: NOW_MS, fmHome, deckHome });
		// A: firstmate awareness only - never worker.
		expect(store.prTs["https://github.com/lindy-ai/lindy/pull/600"]?.firstmate).toBeDefined();
		expect(store.prTs["https://github.com/lindy-ai/lindy/pull/600"]?.worker).toBeUndefined();
		expect(store.files[fmFile]?.actor).toBe("firstmate");
		expect(store.files[fmFile]?.cwd).toBe(fmHome);
		// B: nothing ingested; cursor parked at EOF; flagged excluded.
		expect(store.prTs["https://github.com/lindy-ai/lindy/pull/601"]).toBeUndefined();
		expect(store.files[deckFile]?.excluded).toBe(true);
		// B grows: still nothing ingested on the next pass.
		writeFileSync(
			deckFile,
			line({ type: "response_item", timestamp: NEWER_TS, payload: { type: "function_call", arguments: "work on https://github.com/lindy-ai/lindy/pull/602" } }),
			{ flag: "a" },
		);
		updateSessionStore(store, issues, { roots, nowMs: NOW_MS, windowMs: NOW_MS, fmHome, deckHome });
		expect(store.prTs["https://github.com/lindy-ai/lindy/pull/602"]).toBeUndefined();
		expect(issues).toEqual([]);
	});

	test("streaming backfill + cursor: append-only reads, rotation reset", () => {
		const root = mkdtempSync(join(tmpdir(), "deck-stream-"));
		tempHomes.push(root);
		const claudeDir = join(root, "claude", "proj");
		mkdirSync(claudeDir, { recursive: true });
		const file = join(claudeDir, "s1.jsonl");
		writeFileSync(
			file,
			line({ type: "assistant", timestamp: CLAUDE_TS, message: { content: "working https://github.com/lindy-ai/lindy/pull/500" } }),
		);
		const roots = { claudeProjects: join(root, "claude"), codexSessions: join(root, "codex"), ompSessions: join(root, "omp") };
		const store = emptySessionStore();
		const issues: ShadowIssue[] = [];
		updateSessionStore(store, issues, { roots, nowMs: NOW_MS, windowMs: NOW_MS });
		expect(store.prTs["https://github.com/lindy-ai/lindy/pull/500"]?.worker?.tsMs).toBe(Date.parse(CLAUDE_TS));
		const offsetAfterFirst = store.files[file]?.offset ?? 0;
		expect(offsetAfterFirst).toBeGreaterThan(0);
		// Append: only the new record is consumed; older token ts unchanged, new token added.
		writeFileSync(
			file,
			line({ type: "assistant", timestamp: NEWER_TS, message: { content: "now on https://github.com/lindy-ai/lindy/pull/501" } }),
			{ flag: "a" },
		);
		updateSessionStore(store, issues, { roots, nowMs: NOW_MS, windowMs: NOW_MS });
		expect(store.files[file]?.offset ?? 0).toBeGreaterThan(offsetAfterFirst);
		expect(store.prTs["https://github.com/lindy-ai/lindy/pull/501"]?.worker?.tsMs).toBe(Date.parse(NEWER_TS));
		// Truncation/rotation: shrink the file; cursor resets and re-consumes.
		writeFileSync(file, line({ type: "assistant", timestamp: NEWER_TS, message: { content: "rotated https://github.com/lindy-ai/lindy/pull/502" } }));
		updateSessionStore(store, issues, { roots, nowMs: NOW_MS, windowMs: NOW_MS });
		expect(store.prTs["https://github.com/lindy-ai/lindy/pull/502"]?.worker).toBeDefined();
		expect(issues).toEqual([]);
		// Store round-trips through disk.
		const storePath = join(root, "store.json");
		saveSessionStore(storePath, store, issues);
		const reloaded = loadSessionStore(storePath, issues);
		expect(reloaded).toEqual(store);
	});

	test("findings: fm_behind signal, untracked_pr fm-aware signal, stalled_effort signal", () => {
		const store = emptySessionStore();
		const workTs = NOW_MS - 10 * 60_000;
		ingestLine(store, "omp", "worker", "/log/w.jsonl", JSON.stringify({ type: "message", timestamp: new Date(workTs).toISOString(), message: { role: "assistant", content: `pushed to ${FAILING_URL} for REL-321` } }));
		ingestLine(store, "omp", "worker", "/log/w.jsonl", JSON.stringify({ type: "message", timestamp: new Date(workTs).toISOString(), message: { role: "assistant", content: "untracked work on https://github.com/lindy-ai/lindy/pull/777" } }));
		// Firstmate ALSO mentioned the untracked PR -> known-yet-untracked signal.
		ingestLine(store, "omp", "firstmate", "/log/fm.jsonl", JSON.stringify({ type: "message", timestamp: new Date(workTs).toISOString(), message: { role: "assistant", content: "should track https://github.com/lindy-ai/lindy/pull/777" } }));
		// A PR co-mentioned with a WATCHED Linear ID is tracked via its effort -> no untracked finding.
		ingestLine(store, "omp", "worker", "/log/w.jsonl", JSON.stringify({ type: "message", timestamp: new Date(workTs).toISOString(), message: { role: "assistant", content: "opened https://github.com/lindy-ai/lindy/pull/778 for REL-321" } }));
		const index = indexFromStore(store);
		const watchSet = [
			{ effortId: "alpha", description: "", repo: "", prUrls: [FAILING_URL], linearIds: ["REL-321"] },
			{ effortId: "stalled", description: "", repo: "", prUrls: [DROPPED_URL], linearIds: [] },
		];
		const statusMtime = new Map<string, number | null>([
			["alpha", workTs - 2 * 60 * 60_000], // status 2h older than worker activity -> behind
			["stalled", NOW_MS - 80 * 60 * 60_000], // stale beyond 48h window
		]);
		const factsByUrl = new Map([
			[FAILING_URL, { url: FAILING_URL, state: "OPEN", landed: false, checksRollup: "failing" as const, failingChecks: ["lint"], updatedAtMs: NOW_MS, reviewDecision: undefined, landedSha: undefined, mergeStateStatus: undefined }],
			[DROPPED_URL, { url: DROPPED_URL, state: "OPEN", landed: false, checksRollup: "pending" as const, failingChecks: [], updatedAtMs: NOW_MS, reviewDecision: undefined, landedSha: undefined, mergeStateStatus: undefined }],
		]);
		const findings = deriveSessionFindings(watchSet, statusMtime, factsByUrl, index, { nowMs: NOW_MS });
		const kinds = findings.map((finding) => `${finding.kind}:${finding.severity}:${finding.effortId ?? "-"}`).sort();
		expect(kinds).toEqual([
			"fm_behind_sessions:signal:alpha",
			"stalled_effort:signal:stalled",
			"untracked_pr:signal:-",
		]);
		const behind = findings.find((finding) => finding.kind === "fm_behind_sessions");
		expect(behind?.evidencePaths).toEqual(["/log/w.jsonl"]);
		expect(behind?.latestSessionMtimeMs).toBe(workTs);
		const untracked = findings.find((finding) => finding.kind === "untracked_pr");
		expect(untracked?.detail).toContain("known yet untracked");
	});
});
