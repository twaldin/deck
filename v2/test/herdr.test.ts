/**
 * The projection's pure decisions: which herdr state a task maps to. The herdr
 * CLI itself is not exercised — the pass degrades to "skipped" without it,
 * asserted last. Smithers runs are fleet-only and never get a pane.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TaskRow } from "../src/monitor";
import {
	desiredState,
	mayClosePane,
	projectionMessage,
	commandFor,
	shellQuote,
	shouldReleasePane,
} from "../src/herdr";

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
		expect(
			shouldReleasePane({ runState: "finished", lastVerb: "done", worktreeExists: true }),
		).toBe(true);
		expect(
			shouldReleasePane({ runState: "none", lastVerb: "failed", worktreeExists: true }),
		).toBe(true);
	});

	test("parked (paused/blocked, no live run) releases", () => {
		expect(
			shouldReleasePane({ runState: "finished", lastVerb: "paused", worktreeExists: true }),
		).toBe(true);
		expect(
			shouldReleasePane({ runState: "none", lastVerb: "blocked", worktreeExists: true }),
		).toBe(true);
	});

	test("running keeps the pane unless the verb is terminal", () => {
		expect(
			shouldReleasePane({ runState: "running", lastVerb: "working", worktreeExists: true }),
		).toBe(false);
		expect(
			shouldReleasePane({ runState: "running", lastVerb: "blocked", worktreeExists: true }),
		).toBe(false);
		expect(
			shouldReleasePane({ runState: "running", lastVerb: "done", worktreeExists: true }),
		).toBe(true);
	});

	test("gone worktree releases any non-running task", () => {
		expect(
			shouldReleasePane({ runState: "finished", lastVerb: "working", worktreeExists: false }),
		).toBe(true);
		expect(
			shouldReleasePane({ runState: "none", lastVerb: null, worktreeExists: false }),
		).toBe(true);
	});

	test("between events (not running, non-terminal verb, worktree present) parks idle", () => {
		expect(
			shouldReleasePane({ runState: "finished", lastVerb: "working", worktreeExists: true }),
		).toBe(false);
		expect(
			shouldReleasePane({ runState: "none", lastVerb: null, worktreeExists: true }),
		).toBe(false);
	});
});

describe("projectionMessage", () => {
	test("carries the last verb + note, truncated", () => {
		expect(projectionMessage(task({ lastVerb: "working", lastNote: "step 3" }))).toBe(
			"working: step 3",
		);
		expect(projectionMessage(task())).toBe("no status yet");
		expect(projectionMessage(task({ lastVerb: "working", lastNote: "x".repeat(300) })).length).toBe(
			120,
		);
	});
});

describe("mayClosePane: identity-exact, never less", () => {
	test("closes only on exact pane id + agent label match", () => {
		expect(mayClosePane({ pane_id: "w1:p2", agent: "t1" }, "w1:p2", "t1")).toBe(true);
	});

	test("REGRESSION: a missing agent field is not authorization to close", () => {
		// A herdr schema change or a reused pane id yields pane info without our
		// label; closing on that would close somebody else's pane.
		expect(mayClosePane({ pane_id: "w1:p2" }, "w1:p2", "t1")).toBe(false);
	});

	test("mismatched agent, mismatched pane, or no pane never close", () => {
		expect(mayClosePane({ pane_id: "w1:p2", agent: "other" }, "w1:p2", "t1")).toBe(false);
		expect(mayClosePane({ pane_id: "w1:p9", agent: "t1" }, "w1:p2", "t1")).toBe(false);
		expect(mayClosePane(null, "w1:p2", "t1")).toBe(false);
	});
});

describe("projection commands", () => {
	test("spawn panes run the compact deck tail and workflows run smithers logs", () => {
		expect(commandFor({ taskId: "worker-1", runId: null })).toContain("exec deck-v2 tail 'worker-1'");
		expect(commandFor({ taskId: "workflow", runId: "run-1" })).toBe("smithers status 'run-1'; exec smithers logs 'run-1' --follow --tail 30");
	});
});

describe("shellQuote", () => {
	test("spaces and metacharacters stay data", () => {
		expect(shellQuote("/a b/c.status")).toBe("'/a b/c.status'");
		expect(shellQuote("/x;rm -rf /")).toBe("'/x;rm -rf /'");
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
	});
});

describe("projectFleet degrades without herdr", () => {
	let home: string;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-herdr-"));
		process.env.DECK_V2_HOME = home;
	});

	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
		delete process.env.DECK_V2_HOME;
	});

	test("missing herdr binary yields skipped health, never a throw", async () => {
		const original = process.env.PATH;
		process.env.PATH = "/nonexistent";
		try {
			const { projectFleet } = await import("../src/herdr");
			const health = await projectFleet({
				generatedAt: new Date().toISOString(),
				tasks: [task({ runState: "running" })],
				workflows: [],
				counters: { tasks: 1, running: 1, blocked: 0, openDecisions: 0, queuedMessages: 0, openQuestions: 0, internalOpen: 0, internalCap: 12 },
				sources: [],
			});
			expect(health.state).toBe("skipped");
		} finally {
			process.env.PATH = original;
		}
	});

	test("projects two spawns and one workflow in one reusable workspace", async () => {
		const originalPath = process.env.PATH;
		const bin = fs.mkdtempSync(path.join(os.tmpdir(), "deck-herdr-bin-"));
		const log = path.join(bin, "calls.jsonl");
		const state = path.join(bin, "state.json");
		const herdrStub = path.join(bin, "herdr");
		fs.writeFileSync(state, JSON.stringify({ workspace: null, panes: {}, next: 1 }));
		fs.writeFileSync(herdrStub, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_HERDR_STATE;
const logFile = process.env.FAKE_HERDR_LOG;
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
fs.appendFileSync(logFile, JSON.stringify(args) + "\\n");
const result = (value) => process.stdout.write(JSON.stringify({ result: value }));
const flag = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
if (args[0] === "workspace" && args[1] === "list") result({ workspaces: state.workspace === null ? [] : [state.workspace] });
else if (args[0] === "workspace" && args[1] === "get") result(state.workspace === null ? {} : { workspace: state.workspace });
else if (args[0] === "workspace" && args[1] === "create") { state.workspace = { workspace_id: "ws1", label: flag("--label") }; result({ workspace: state.workspace }); }
else if (args[0] === "workspace" && args[1] === "rename") { state.workspace.label = args[3]; result({ workspace: state.workspace }); }
else if (args[0] === "pane" && args[1] === "list") result({ panes: Object.values(state.panes) });
else if (args[0] === "tab" && args[1] === "create") { const n = state.next++; const pane = { pane_id: "p" + n, tab_id: "t" + n, workspace_id: "ws1", agent: undefined, label: flag("--label") }; state.panes[pane.pane_id] = pane; result({ root_pane: { pane_id: pane.pane_id }, tab: { tab_id: pane.tab_id } }); }
else if (args[0] === "pane" && args[1] === "run") result({});
else if (args[0] === "pane" && args[1] === "report-agent") { const pane = state.panes[args[2]]; if (pane !== undefined) pane.agent = flag("--agent"); result({}); }
else if (args[0] === "pane" && args[1] === "get") { const pane = state.panes[args[2]]; result({ pane: pane === undefined ? null : pane }); }
else if (args[0] === "pane" && args[1] === "release-agent") result({});
else if (args[0] === "tab" && args[1] === "close") { for (const [id, pane] of Object.entries(state.panes)) if (pane.tab_id === args[2]) delete state.panes[id]; result({}); }
else result({});
fs.writeFileSync(stateFile, JSON.stringify(state));
`, { mode: 0o700 });
	process.env.PATH = originalPath ?? "";
	process.env.DECK_HERDR_BIN = herdrStub;
	process.env.FAKE_HERDR_STATE = state;
	process.env.FAKE_HERDR_LOG = log;
	try {
		const { projectFleet } = await import("../src/herdr");
		const frame = {
			generatedAt: new Date().toISOString(),
			tasks: [task({ taskId: "spawn-a", runState: "running" }), task({ taskId: "spawn-b", runState: "running" }), task({ taskId: "run:workflow-1", runId: "workflow-1", runState: "running" })],
			workflows: [],
			counters: { tasks: 3, running: 3, blocked: 0, openDecisions: 0, queuedMessages: 0, openQuestions: 0, internalOpen: 0, internalCap: 12 },
			sources: [],
		};
		expect((await projectFleet(frame)).state).toBe("ok");
		const first = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
		expect(first.filter((call) => call[0] === "workspace" && call[1] === "create")).toHaveLength(1);
		expect(first.filter((call) => call[0] === "tab" && call[1] === "create")).toHaveLength(3);
		const paneCommands = first.filter((call) => call[0] === "pane" && call[1] === "run").map((call) => call[3] as string);
		expect(paneCommands.filter((command) => command.includes("spawn-a"))).toHaveLength(1);
		expect(paneCommands.filter((command) => command.includes("spawn-b"))).toHaveLength(1);
		expect(paneCommands).toContain("smithers status 'workflow-1'; exec smithers logs 'workflow-1' --follow --tail 30");
		expect(paneCommands.some((command) => command.includes("DECK_V2_HOME="))).toBe(true);
		const beforeSecond = first.length;
		expect((await projectFleet(frame)).state).toBe("ok");
		const second = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
		expect(second.slice(beforeSecond).some((call) => call[0] === "workspace" && call[1] === "create")).toBe(false);
		const terminal = { ...frame, tasks: frame.tasks.map((item) => item.taskId === "spawn-a" ? { ...item, runState: "finished" as const, lastVerb: "done" } : item) };
		expect((await projectFleet(terminal)).state).toBe("ok");
		const final = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
		expect(final.filter((call) => call[0] === "tab" && call[1] === "close")).toHaveLength(1);
	} finally {
		process.env.PATH = originalPath;
		delete process.env.DECK_HERDR_BIN;
		delete process.env.FAKE_HERDR_STATE;
		delete process.env.FAKE_HERDR_LOG;
		fs.rmSync(bin, { recursive: true, force: true });
	}
	});
});
