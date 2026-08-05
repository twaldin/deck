/**
 * The projection's pure decisions and command intent. The herdr CLI is never
 * reached. A test-side execFile stub records the commands and rejects an
 * unconfigured live herdr call, so tests cannot create workspaces or panes.
 * Smithers runs are fleet-only and never get a pane.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHerdrTestStub, HerdrTestGuardError } from "./herdr-stub";
import type { TaskRow } from "../src/monitor";

// Bun does not set NODE_ENV for its runner. Mark this process so the executable
// guard can distinguish a test invocation from an operator's normal herdr CLI.
process.env.NODE_ENV = "test";
const herdrStub = createHerdrTestStub();
const { commandFor, desiredState, mayClosePane, projectFleet, projectionMessage, shellQuote, shouldReleasePane } =
	await import("../src/herdr");

type FleetFrame = Parameters<typeof projectFleet>[0];

function task(overrides: Partial<TaskRow> = {}): TaskRow {
	return {
		taskId: "t1",
		kind: "ship",
		project: null,
		runState: "none",
		lastVerb: null,
		lastNote: null,
		openDecisions: 0,
		queuedMessages: 0,
		unresolvedSideEffects: 0,
		pr: null,
		worktree: null,
		runId: null,
		stage: null,
		pane: null,
		statusAgeMs: null,
		...overrides,
	};
}

function frameOf(...tasks: TaskRow[]): FleetFrame {
	return {
		generatedAt: new Date().toISOString(),
		tasks,
		workflows: [],
		counters: {
			tasks: tasks.length,
			running: tasks.filter((row) => row.runState === "running").length,
			blocked: 0,
			openDecisions: 0,
			queuedMessages: 0,
			openQuestions: 0,
			internalOpen: 0,
			internalCap: 12,
		},
		sources: [],
	};
}

function commandCalls() {
	return herdrStub.readCalls().filter(({ file }) => file === "herdr");
}

function verbs() {
	return commandCalls().map(({ args }) => args.slice(0, 2).join(" "));
}

describe("desiredState", () => {
	test("running maps to working", () => {
		expect(desiredState(task({ runState: "running" }))).toBe("working");
	});

	test("blocked, failed and needs-decision map to blocked even while running", () => {
		expect(desiredState(task({ runState: "running", lastVerb: "blocked" }))).toBe("blocked");
		expect(desiredState(task({ runState: "running", lastVerb: "failed" }))).toBe("blocked");
		expect(desiredState(task({ runState: "running", lastVerb: "needs-decision" }))).toBe("blocked");
		expect(desiredState(task({ runState: "running", openDecisions: 1 }))).toBe("blocked");
	});

	test("finished or never-started maps to idle", () => {
		expect(desiredState(task({ runState: "finished", lastVerb: "done" }))).toBe("idle");
		expect(desiredState(task())).toBe("idle");
	});
});

describe("shouldReleasePane", () => {
	test("terminal verbs release even with the worktree still on disk", () => {
		expect(shouldReleasePane({ runState: "finished", lastVerb: "done", worktreeExists: true })).toBe(true);
		expect(shouldReleasePane({ runState: "none", lastVerb: "failed", worktreeExists: true })).toBe(true);
	});

	test("parked (paused/blocked, no live run) releases", () => {
		expect(shouldReleasePane({ runState: "finished", lastVerb: "paused", worktreeExists: true })).toBe(true);
		expect(shouldReleasePane({ runState: "none", lastVerb: "blocked", worktreeExists: true })).toBe(true);
	});

	test("running keeps the pane unless the verb is terminal", () => {
		expect(shouldReleasePane({ runState: "running", lastVerb: "working", worktreeExists: true })).toBe(false);
		expect(shouldReleasePane({ runState: "running", lastVerb: "blocked", worktreeExists: true })).toBe(false);
		expect(shouldReleasePane({ runState: "running", lastVerb: "done", worktreeExists: true })).toBe(true);
	});

	test("gone worktree releases any non-running task", () => {
		expect(shouldReleasePane({ runState: "finished", lastVerb: "working", worktreeExists: false })).toBe(true);
		expect(shouldReleasePane({ runState: "none", lastVerb: null, worktreeExists: false })).toBe(true);
	});

	test("between events parks an existing pane idle", () => {
		expect(shouldReleasePane({ runState: "finished", lastVerb: "working", worktreeExists: true })).toBe(false);
		expect(shouldReleasePane({ runState: "none", lastVerb: null, worktreeExists: true })).toBe(false);
	});
});

describe("projection helpers", () => {
	test("projection commands use the deck tail for spawns and smithers logs for workflows", () => {
		expect(commandFor({ taskId: "worker-1", runId: null })).toContain("exec deck-v2 tail 'worker-1'");
		expect(commandFor({ taskId: "workflow", runId: "run-1" })).toBe(
			"smithers status 'run-1'; exec smithers logs 'run-1' --follow --tail 30",
		);
	});
	test("projectionMessage carries the last verb + note and truncates", () => {
		expect(projectionMessage(task({ lastVerb: "working", lastNote: "step 3" }))).toBe("working: step 3");
		expect(projectionMessage(task())).toBe("no status yet");
		expect(projectionMessage(task({ lastVerb: "working", lastNote: "x".repeat(300) })).length).toBe(120);
	});

	test("mayClosePane requires exact pane id + agent label", () => {
		expect(mayClosePane({ pane_id: "w1:p2", agent: "t1" }, "w1:p2", "t1")).toBe(true);
		expect(mayClosePane({ pane_id: "w1:p2" }, "w1:p2", "t1")).toBe(false);
		expect(mayClosePane({ pane_id: "w1:p2", agent: "other" }, "w1:p2", "t1")).toBe(false);
		expect(mayClosePane({ pane_id: "w1:p9", agent: "t1" }, "w1:p2", "t1")).toBe(false);
		expect(mayClosePane(null, "w1:p2", "t1")).toBe(false);
	});

	test("shellQuote keeps spaces and metacharacters as data", () => {
		expect(shellQuote("/a b/c.status")).toBe("'/a b/c.status'");
		expect(shellQuote("/x;rm -rf /")).toBe("'/x;rm -rf /'");
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
	});
});

describe("herdr projection uses the test stub", () => {
	let home: string;
	let originalPath: string | undefined;
	let originalHerdrBin: string | undefined;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-herdr-"));
		process.env.DECK_V2_HOME = home;
		originalPath = process.env.PATH;
		originalHerdrBin = process.env.DECK_HERDR_BIN;
		delete process.env.DECK_HERDR_BIN;
		herdrStub.install();
		herdrStub.enable();
		fs.mkdirSync(path.join(home, "state"), { recursive: true });
		herdrStub.reset();
	});

	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalHerdrBin === undefined) delete process.env.DECK_HERDR_BIN;
		else process.env.DECK_HERDR_BIN = originalHerdrBin;
		herdrStub.disable();
	});

	test("a running task projects workspace, tab, pane tail, and agent state intent", async () => {
		herdrStub.setReply("workspace create", { workspace: { workspace_id: "wTEST" } });
		herdrStub.setReply("tab create", { root_pane: { pane_id: "wTEST:p1" }, tab: { tab_id: "wTEST:t1" } });
		const health = await projectFleet(frameOf(task({ runState: "running", lastVerb: "working", lastNote: "step 3" })));

		expect(health.state).toBe("ok");
		expect(health.detail).toBe("1 effort(s) projected");
		expect(verbs()).toEqual([
			"workspace list",
			"workspace list",
			"workspace create",
			"pane list",
			"tab create",
			"pane run",
			"pane report-agent",
			"pane list",
		]);
		const report = commandCalls().find(({ args }) => args[1] === "report-agent");
		expect(report?.args).toContain("wTEST:p1");
		expect(report?.args).toContain("working");
		expect(report?.args).toContain("working: step 3");
	});

	test("a herdr failure skips and never creates a workspace", async () => {
		herdrStub.setReply("workspace list", null);
		const health = await projectFleet(frameOf(task({ runState: "running" })));

		expect(health.state).toBe("skipped");
		expect(health.detail).toBe("herdr not running");
		expect(verbs()).toEqual(["workspace list"]);
	});

	test("a done task releases only its identity-matched pane", async () => {
		fs.writeFileSync(path.join(home, "state", "t1.meta"), "herdr_pane=wTEST:p1\nherdr_tab=wTEST:t1\n");
		herdrStub.setReply("pane get", { pane: { pane_id: "wTEST:p1", agent: "t1" } });
		await projectFleet(frameOf(task({ runState: "finished", lastVerb: "done" })));

		expect(verbs()).toEqual(["workspace list", "pane get", "pane release-agent", "tab close"]);
	});

	test("REGRESSION: a pane owned by somebody else is never closed", async () => {
		fs.writeFileSync(path.join(home, "state", "t1.meta"), "herdr_pane=wTEST:p1\nherdr_tab=wTEST:t1\n");
		herdrStub.setReply("pane get", { pane: { pane_id: "wTEST:p1", agent: "someone-else" } });
		await projectFleet(frameOf(task({ runState: "finished", lastVerb: "done" })));

		expect(verbs()).toEqual(["workspace list", "pane get"]);
	});
});

afterAll(() => herdrStub.remove());

describe("herdr test guard", () => {
	test("REGRESSION: an unconfigured test reaching the live herdr path fails loudly", () => {
		herdrStub.disable();
		const result = Bun.spawnSync(["herdr", "workspace", "create"], {
			env: { ...process.env, PATH: `${herdrStub.path}${path.delimiter}${process.env.PATH ?? ""}` },
		});
		expect(result.exitCode).toBe(86);
		expect(new TextDecoder().decode(result.stderr)).toMatch(/herdr test guard: refusing live mutation path/);
		expect(() => herdrStub.assertEnabled()).toThrow(HerdrTestGuardError);
		expect(() => herdrStub.assertEnabled()).toThrow(/live herdr/);
	});

	test("the guard does not block the harmless process-list probe", () => {
		herdrStub.disable();
		const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="], {
			env: { ...process.env, PATH: `${herdrStub.path}${path.delimiter}${process.env.PATH ?? ""}` },
		});
		expect(result.exitCode).toBe(0);
	});
});
