import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as observer from "../src/observer";
import * as projects from "../src/projects";
import * as wake from "../src/wake";
import type { ProjectProfile } from "../src/projects";
import type { WakeItem } from "../src/wake";

let home: string;

function writeProfile(wakeOnTerminal?: boolean): void {
	const profile = {
		id: "demo",
		repo: "example/demo",
		primary: "/tmp/demo",
		pipeline: "yolo-ship",
		yolo: true,
		stamp: false,
		knowledge: [],
		reviewPolicy: { requireHuman: false, requiredBots: [] },
		depsWarm: true,
		...(wakeOnTerminal === undefined ? {} : { wakeOnTerminal }),
	};
	const file = path.join(home, "config", "projects.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify([profile])}\n`);
}

function writeShipInput(runId: string, ticket: string): void {
	const file = path.join(home, "state", "ship", `${runId}.input.json`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ profile: "demo", ticket })}\n`);
}

function runningRun(id: string) {
	return {
		id,
		workflow: "pr-pipeline",
		status: "running",
		step: "pipeline",
		rootDir: "/tmp/demo-worktree",
	};
}

function classified(taskIds: string[]): WakeItem[] {
	const result = wake.reconcile(taskIds);
	return [...result.interrupt, ...result.batched, ...result.silent];
}

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-terminal-wake-"));
	process.env.DECK_V2_HOME = home;
	fs.mkdirSync(path.join(home, "state"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
});

describe("project terminal wake policy", () => {
	test("parses the optional profile flag and defaults omission to no wake", () => {
		writeProfile();
		expect(projects.loadProfiles()[0]?.wakeOnTerminal).toBeUndefined();
		writeProfile(true);
		expect(projects.loadProfiles()[0]?.wakeOnTerminal).toBe(true);
		expect(() => projects.validateProfiles([{
			...projects.loadProfiles()[0],
			wakeOnTerminal: "yes",
		}], "test-projects.json")).toThrow(/wakeOnTerminal must be a boolean/);
	});

	test("does not wake on landing when the flag is absent", () => {
		writeProfile();
		const profile = projects.loadProfiles()[0]!;
		writeShipInput("run-no-wake", "ticket-no-wake");
		expect(observer.wakeOnTerminalForRun("run-no-wake")).toBe(false);

		const emitted = observer.observeOnce("ticket-no-wake", {
			run: runningRun("run-no-wake"),
			nodes: [{ nodeId: "landing-poll", status: "finished", output: { landed: true, sha: "abc123" } }],
		});

		expect(emitted.map((event) => event.note)).toEqual(["PR landed (sha abc123)"]);
		const items = classified(["ticket-no-wake"]);
		const policy = observer.applyProjectTierPolicy(
			items,
			new Map([["ticket-no-wake", profile]]),
		);
		expect(policy).toHaveLength(1);
		expect(policy[0]).toMatchObject({ tier: "T2", event: { key: "terminal" } });
		expect(policy.filter((item) => item.tier !== "T2")).toHaveLength(0);
		const unknown = observer.applyProjectTierPolicy(
			items,
			new Map<string, ProjectProfile | undefined>(),
		);
		expect(unknown[0]?.tier).toBe("T2");
	});

	test("landing emits exactly one T1 wake for an opted-in project", () => {
		writeProfile(true);
		const profile = projects.loadProfiles()[0]!;
		writeShipInput("run-landed", "ticket-landed");
		expect(observer.wakeOnTerminalForRun("run-landed")).toBe(true);
		const observation = {
			run: runningRun("run-landed"),
			nodes: [{ nodeId: "landing-poll", status: "finished", output: { landed: true, sha: "def456" } }],
		};

		observer.observeOnce("ticket-landed", observation);
		observer.observeOnce("ticket-landed", observation);

		const policy = observer.applyProjectTierPolicy(
			classified(["ticket-landed"]),
			new Map([["ticket-landed", profile]]),
		);
		expect(policy).toHaveLength(1);
		expect(policy[0]).toMatchObject({
			taskId: "ticket-landed",
			tier: "T1",
			event: { verb: "resolved", key: "terminal", note: "PR landed (sha def456)" },
		});
	});

	test("failed and cancelled workflow runs emit urgent terminal wakes", () => {
		writeProfile();
		const unflagged = projects.loadProfiles()[0]!;
		writeProfile(true);
		const flagged = projects.loadProfiles()[0]!;
		for (const status of ["failed", "cancelled"] as const) {
			const runId = `run-${status}`;
			const taskId = `ticket-${status}`;
			writeShipInput(runId, taskId);
			observer.observeOnce(taskId, {
				run: { ...runningRun(runId), status },
				nodes: [],
			});
		}

		const policy = observer.applyProjectTierPolicy(
			classified(["ticket-failed", "ticket-cancelled"]),
			new Map([
				["ticket-failed", unflagged],
				["ticket-cancelled", flagged],
			]),
		);
		expect(policy).toHaveLength(2);
		expect(policy.every((item) => item.tier === "T0" && item.event.key === "terminal")).toBe(true);
		expect(policy.map((item) => item.event.note)).toEqual([
			"workflow failed",
			"workflow cancelled",
		]);
	});

	test("informational milestones never wake under either setting", () => {
		const owners = new Map<string, ProjectProfile | undefined>();
		const taskIds: string[] = [];
		for (const enabled of [false, true]) {
			writeProfile(enabled ? true : undefined);
			const suffix = enabled ? "on" : "off";
			const runId = `run-info-${suffix}`;
			const taskId = `ticket-info-${suffix}`;
			taskIds.push(taskId);
			owners.set(taskId, projects.loadProfiles()[0]);
			writeShipInput(runId, taskId);
			const emitted = observer.observeOnce(taskId, {
				run: runningRun(runId),
				nodes: [
					{ nodeId: "push-pr", status: "finished", output: { prNumber: 42 } },
					{ nodeId: "enqueue-merge", status: "finished" },
					{ nodeId: "fallout-wait", status: "running" },
					{ nodeId: "fallout-watch", status: "finished" },
				],
			});
			expect(emitted.map((event) => event.note)).toEqual([
				"PR opened (prNumber 42)",
				"PR submitted to the merge queue",
				"entered fallout wait",
				"fallout checks complete",
			]);
		}
		const policy = observer.applyProjectTierPolicy(classified(taskIds), owners);
		expect(policy).toHaveLength(8);
		expect(policy.every((item) => item.tier === "T2" && item.event.key === "milestone")).toBe(true);
		expect(policy.filter((item) => item.tier !== "T2")).toHaveLength(0);
	});

	test("two completions in one observation cycle remain one batchable delivery", () => {
		writeProfile(true);
		const profile = projects.loadProfiles()[0]!;
		writeShipInput("run-a", "ticket-a");
		writeShipInput("run-b", "ticket-b");

		observer.observePsSnapshot([
			{ id: "run-a", status: "finished", state: "succeeded", workflow: "pr-pipeline" },
			{ id: "run-b", status: "finished", state: "succeeded", workflow: "pr-pipeline" },
		]);

		const policy = observer.applyProjectTierPolicy(
			classified(["ticket-a", "ticket-b"]),
			new Map([
				["ticket-a", profile],
				["ticket-b", profile],
			]),
		);
		expect(policy).toHaveLength(2);
		expect(policy.every((item) => item.tier === "T1" && item.event.key === "terminal")).toBe(true);
		const folded = wake.foldBatched(policy);
		expect(folded).toContain("2 task(s) updated");
		expect(folded).toContain("ticket-a");
		expect(folded).toContain("ticket-b");
	});
});
