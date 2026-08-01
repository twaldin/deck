/**
 * Observer adapter tests.
 *
 * The assertion that matters is idempotency under polling. `smithers ps` shows
 * the same transition on every cycle until it changes, so a naive adapter
 * appends `done:` once per poll — and every one of those costs the orchestrator a
 * supervision turn. The second thing that matters is the opposite failure: a
 * genuine second failure of a retried node must NOT be swallowed as a duplicate.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let home: string;

async function mods() {
	return {
		observer: await import("../src/observer"),
		events: await import("../src/events"),
	};
}

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-obs-"));
	process.env.DECK_V2_HOME = home;
	fs.mkdirSync(path.join(home, "state"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
});

const run = (status: string, step: string | null = null) => ({
	id: "run-1",
	workflow: "pr-pipeline",
	status,
	step,
	rootDir: "/tmp/wt",
});

describe("observer idempotency", () => {
	test("REGRESSION: polling the same terminal state appends exactly one line", async () => {
		const { observer, events } = await mods();
		const observation = { run: run("succeeded"), nodes: [] };

		expect(observer.observeOnce("t1", observation)).toHaveLength(1);
		// Five more polls of an unchanged run: the CLI keeps reporting completed.
		for (let i = 0; i < 5; i++) observer.observeOnce("t1", observation);

		const lines = events.readStatus("t1").events;
		expect(lines.filter((line) => line.verb === "done")).toHaveLength(1);
	});

	test("a retried node failing again is a second event, not a duplicate", async () => {
		const { observer, events } = await mods();
		observer.observeOnce("t1", {
			run: run("running", "implement"),
			nodes: [{ nodeId: "implement", status: "failed", attempt: 0 }],
		});
		// Same node, same transition, but a new attempt: genuinely new news.
		observer.observeOnce("t1", {
			run: run("running", "implement"),
			nodes: [{ nodeId: "implement", status: "failed", attempt: 1 }],
		});
		expect(events.readStatus("t1").events.filter((line) => line.verb === "failed")).toHaveLength(2);
	});

	test("a restarted observer does not re-announce history", async () => {
		const { observer, events } = await mods();
		observer.observeOnce("t1", { run: run("waiting-approval", "gate"), nodes: [] });
		observer.observeOnce("t1", { run: run("succeeded"), nodes: [] });

		// Simulating a fresh observer process: the ledger is on disk, so a replay of
		// the whole observed history must add nothing.
		observer.observeOnce("t1", { run: run("waiting-approval", "gate"), nodes: [] });
		observer.observeOnce("t1", { run: run("succeeded"), nodes: [] });

		const lines = events.readStatus("t1").events;
		expect(lines).toHaveLength(2);
		expect(lines.map((line) => line.verb)).toEqual(["needs-decision", "done"]);
	});

	test("REGRESSION: a lost ledger is the failure that re-announces everything", async () => {
		const { observer, events } = await mods();
		observer.observeOnce("t1", { run: run("succeeded"), nodes: [] });
		// The ledger must exist and be complete JSON; a truncated one reads as empty
		// and every past transition looks new again.
		const ledger = path.join(home, "state", "t1.observed");
		expect(fs.existsSync(ledger)).toBe(true);
		expect(() => JSON.parse(fs.readFileSync(ledger, "utf8"))).not.toThrow();
		// No stray temp file left behind by the write-then-rename.
		expect(fs.existsSync(`${ledger}.tmp`)).toBe(false);
		expect(events.readStatus("t1").events).toHaveLength(1);
	});
});

describe("observer event selection", () => {
	test("pipeline milestones wake while the run stays running, in order and once", async () => {
		const { observer, events } = await mods();
		const base = { run: { ...run("running", "pipeline"), workflow: "pr-pipeline" }, nodes: [] as any[] };
		const polls = [
			[{ nodeId: "push-pr", status: "finished", attempt: 0, output: { prNumber: 42 } }],
			[
				{ nodeId: "push-pr", status: "finished", attempt: 0, output: { prNumber: 42 } },
				{ nodeId: "landing-poll", status: "finished", attempt: 0, output: { landed: true, sha: "abc123" } },
			],
		];
		for (const nodes of polls) observer.observeOnce("t1", { ...base, nodes });
		observer.observeOnce("t1", { ...base, nodes: polls[1]! });
		const emitted = events.readStatus("t1").events;
		expect(emitted.map((event) => event.verb)).toEqual(["resolved", "resolved"]);
		expect(emitted.map((event) => event.note)).toEqual(["PR opened (prNumber 42)", "PR landed (sha abc123)"]);
	});

	test("production ps observation enriches milestones from inspect output", async () => {
		const { observer, events } = await mods();
		fs.mkdirSync(path.join(home, "state", "ship"), { recursive: true });
		fs.writeFileSync(path.join(home, "state", "ship", "run-1.input.json"), JSON.stringify({ ticket: "ticket-1" }));
		const calls: string[] = [];
		const emitted = await observer.observePsSnapshotWithInspect({
			rows: [{ id: "run-1", status: "running", workflow: "pr-pipeline" }],
			workspace: "/tmp/workspace",
			run: async (_command, args, cwd) => {
				calls.push(`${cwd}:${args.join(" ")}`);
				return { exitCode: 0, stdout: JSON.stringify({
					run: { id: "run-1", workflow: "pr-pipeline", status: "running" },
				nodes: [{ nodeId: "push-pr", state: "finished", attempt: 0, output: { prNumber: 42 } }],
			}) };
			},
		});
		expect(calls).toHaveLength(1);
		expect(emitted[0]?.note).toBe("PR opened (prNumber 42)");
		expect(events.readStatus("ticket-1").events).toHaveLength(1);
	});

	test("production ps observation falls back when inspect fails", async () => {
		const { observer, events } = await mods();
		fs.mkdirSync(path.join(home, "state", "ship"), { recursive: true });
		fs.writeFileSync(path.join(home, "state", "ship", "run-1.input.json"), JSON.stringify({ ticket: "ticket-1" }));
		const emitted = await observer.observePsSnapshotWithInspect({
			rows: [{ id: "run-1", status: "waiting-approval", step: "r0-stamp", workflow: "pr-pipeline" }],
			workspace: "/tmp/workspace",
			run: async () => ({ exitCode: 1, stdout: "not json" }),
		});
		expect(emitted[0]?.verb).toBe("needs-decision");
		expect(events.readStatus("ticket-1").events).toHaveLength(1);
	});

	test("a running workflow with healthy nodes says nothing", async () => {
		const { observer } = await mods();
		const events = observer.observeOnce("t1", {
			run: run("running", "implement"),
			nodes: [
				{ nodeId: "plan", status: "completed" },
				{ nodeId: "implement", status: "running" },
			],
		});
		// Node-started and node-completed are not news; fm2's status volume was
		// 49% such lines.
		expect(events).toHaveLength(0);
	});

	test("review escalation is an orch-heal failure and is idempotent", async () => {
		const { observer, events } = await mods();
		const observation = { run: run("waiting-approval", "review-escalation"), nodes: [] };
		expect(observer.observeOnce("t1", observation)[0]?.verb).toBe("failed");
		expect(observer.observeOnce("t1", observation)).toHaveLength(0);
		expect(events.readStatus("t1").events[0]?.note).toContain("orch heal");
	});

	test("stamp remains a captain decision, not an orch failure", async () => {
		const { observer } = await mods();
		const [event] = observer.observeOnce("t1", { run: run("waiting-approval", "r0-stamp"), nodes: [] });
		expect(event?.verb).toBe("needs-decision");
		expect(event?.note).toBe("stamp ready");
	});

	test("an approval gate is a decision, because nothing advances without him", async () => {
		const { observer } = await mods();
		const [event] = observer.observeOnce("t1", {
			run: run("waiting-approval", "merge-gate"),
			nodes: [],
		});
		expect(event?.verb).toBe("needs-decision");
		expect(event?.note).toContain("merge-gate");
	});

	test("terminal ps outcomes produce wake events", async () => {
		const { observer, events } = await mods();
		fs.mkdirSync(path.join(home, "state", "ship"), { recursive: true });
		fs.writeFileSync(path.join(home, "state", "ship", "run-1.input.json"), JSON.stringify({ ticket: "ticket-1" }));
		const emitted = observer.observePsSnapshot([{ id: "run-1", status: "finished", state: "succeeded", workflow: "pr-pipeline" }]);
		expect(emitted[0]?.verb).toBe("done");
		expect(events.readStatus("ticket-1").events).toHaveLength(1);
	});

	test("waiting-event includes the blocked node in the wake", async () => {
		const { observer, events } = await mods();
		fs.mkdirSync(path.join(home, "state", "ship"), { recursive: true });
		fs.writeFileSync(path.join(home, "state", "ship", "run-1.input.json"), JSON.stringify({ ticket: "ticket-1" }));
		const emitted = observer.observePsSnapshot([{
			id: "run-1", status: "waiting-event", runState: { state: "waiting-event", blocked: { nodeId: "await-ci" } },
			workflow: "pr-pipeline",
		} as any]);
		expect(emitted[0]?.verb).toBe("blocked");
		expect(emitted[0]?.note).toContain("await-ci");
		expect(events.readStatus("ticket-1").events[0]?.note).toContain("await-ci");
	});

	test("ps reconcile creates a T0 status for a ship escalation", async () => {
		const { observer, events } = await mods();
		fs.mkdirSync(path.join(home, "state", "ship"), { recursive: true });
		fs.writeFileSync(path.join(home, "state", "ship", "run-1.input.json"), JSON.stringify({ ticket: "ticket-1" }));
		const emitted = observer.observePsSnapshot([{ id: "run-1", status: "waiting-approval", step: "review-escalation", workflow: "pr-pipeline" }]);
		expect(emitted[0]?.verb).toBe("failed");
		expect(events.readStatus("ticket-1").events).toHaveLength(1);
		const repeated = observer.observePsSnapshot([{ id: "run-1", status: "waiting-approval", step: "review-escalation", workflow: "pr-pipeline" }]);
		expect(repeated).toHaveLength(0);
		expect(events.readStatus("ticket-1").events).toHaveLength(1);
	});

	test("paused is reported as paused, never as failed", async () => {
		const { observer } = await mods();
		const [event] = observer.observeOnce("t1", { run: run("paused"), nodes: [] });
		expect(event?.verb).toBe("paused");
	});

	test("a cancelled run is terminal and reported as failed", async () => {
		const { observer } = await mods();
		const [event] = observer.observeOnce("t1", { run: run("cancelled"), nodes: [] });
		expect(event?.verb).toBe("failed");
		expect(observer.isFinished({ run: run("cancelled"), nodes: [] })).toBe(true);
		expect(observer.isFinished({ run: run("running"), nodes: [] })).toBe(false);
	});

	test("planning is pure: it decides without writing", async () => {
		const { observer, events } = await mods();
		const planned = observer.planEvents("t1", { run: run("succeeded"), nodes: [] }, { emitted: [] });
		expect(planned).toHaveLength(1);
		expect(events.readStatus("t1").events).toHaveLength(0);
	});

	test("a node-level and run-level transition never collide on one key", async () => {
		const { observer } = await mods();
		// A run whose id could be confused with a node id: keys must stay distinct.
		const emitted = observer.observeOnce("t1", {
			run: run("failed"),
			nodes: [{ nodeId: "-", status: "failed", attempt: 0 }],
		});
		expect(new Set(emitted.map((event) => event.key)).size).toBe(emitted.length);
		expect(emitted).toHaveLength(2);
	});
});

describe("polling a real run shape", () => {
	// The REAL 0.30.0 shape, read off a live workspace: steps carry `state`, the run
	// carries both `status` (stopped) and `runState.state` (outcome).
	const inspectPayload = (state: string, steps: unknown[] = []) =>
		JSON.stringify({
			run: { id: "run-1", workflow: "pr-pipeline", status: "finished", step: "implement" },
			runState: { state },
			steps,
			config: { rootDir: "/tmp/wt" },
		});

	test("polls until the run is terminal, then stops", async () => {
		const { observer } = await mods();
		const responses = [
			inspectPayload("running", [{ id: "implement", state: "running" }]),
			inspectPayload("running", [{ id: "implement", state: "failed", attempt: 0 }]),
			inspectPayload("succeeded"),
		];
		let calls = 0;
		const emitted = await observer.observeRun({
			taskId: "t1",
			runId: "run-1",
			workspace: "/tmp/ws",
			run: async () => ({ stdout: responses[Math.min(calls++, responses.length - 1)] ?? "", exitCode: 0 }),
			sleep: async () => {},
			maxCycles: 10,
		});
		// It stopped at the terminal state rather than polling forever.
		expect(calls).toBe(3);
		expect(emitted.map((event) => event.verb)).toEqual(["failed", "done"]);
	});

	// A failed CLI read is not a failed run. Reporting it as one appends a terminal
	// status for a workflow that is still working, and terminal status is what the
	// orchestrator acts on.
	test("REGRESSION: a failed read does not become a failed status", async () => {
		const { observer, events } = await mods();
		let calls = 0;
		await observer.observeRun({
			taskId: "t1",
			runId: "run-1",
			workspace: "/tmp/ws",
			run: async () => (++calls < 3 ? { stdout: "", exitCode: 1 } : { stdout: inspectPayload("succeeded"), exitCode: 0 }),
			sleep: async () => {},
			maxCycles: 10,
		});
		const lines = events.readStatus("t1").events;
		expect(lines.filter((line) => line.verb === "failed")).toHaveLength(0);
		expect(lines.filter((line) => line.verb === "done")).toHaveLength(1);
	});

	test("inspect prefers the explicit blocked node over the current step", async () => {
		const { observer } = await mods();
		const parsed = observer.parseInspect(JSON.stringify({
			run: { id: "r", status: "waiting", step: "previous-step", blockedNode: "await-ci" },
			runState: { state: "waiting-event", blocked: { nodeId: "await-ci" } },
		}));
		expect(parsed?.run.step).toBe("await-ci");
	});

	test("unparseable output is skipped rather than guessed at", async () => {
		const { observer } = await mods();
		expect(observer.parseInspect("not json")).toBeNull();
		expect(observer.parseInspect("{}")).toBeNull();
		// Legacy steps[].id is accepted alongside canonical nodes[].nodeId.
		const legacy = observer.parseInspect(
			JSON.stringify({ run: { id: "r", status: "running" }, steps: [{ id: "plan", state: "finished" }] }),
		);
		expect(legacy?.nodes[0]?.nodeId).toBe("plan");
	});
});

describe("key collisions that lose events", () => {
	// Verified against a live 0.30.0 debate run: `backlog-opponent` appears TWICE at
	// attempt 1, once per round. Two failures of the same loop node in one payload
	// must be two events; keying without an occurrence collapses them and one
	// failure is never reported.
	test("REGRESSION: duplicate loop-node rows get distinct keys", async () => {
		const { observer } = await mods();
		const observation = {
			run: run("running", "debate"),
			nodes: [
				{ nodeId: "opponent", status: "failed", attempt: 1 },
				{ nodeId: "opponent", status: "failed", attempt: 1 },
			],
		};
		const emitted = observer.observeOnce("t1", observation);
		expect(emitted).toHaveLength(2);
		// The KEYS must differ. Identical keys mean the ledger records one and the
		// next poll re-reports the other forever, or drops it — the status lines look
		// fine either way, so the key is what has to be asserted.
		expect(new Set(emitted.map((event) => event.key)).size).toBe(2);

		// And a re-poll of the unchanged payload adds nothing.
		expect(observer.observeOnce("t1", observation)).toHaveLength(0);
	});

	// A workflow with two approval gates stops twice in waiting-approval. Keying on
	// the state alone reports only the first, so the second gate waits on a captain
	// who was never told it existed.
	test("REGRESSION: a second approval gate is reported, not swallowed", async () => {
		const { observer, events } = await mods();
		observer.observeOnce("t1", { run: run("waiting-approval", "gate-one"), nodes: [] });
		observer.observeOnce("t1", { run: run("running", "work"), nodes: [] });
		observer.observeOnce("t1", { run: run("waiting-approval", "gate-two"), nodes: [] });

		const decisions = events.readStatus("t1").events.filter((line) => line.verb === "needs-decision");
		expect(decisions).toHaveLength(2);
		expect(decisions[1]?.note).toContain("gate-two");
	});

	test("re-polling the SAME gate still appends only once", async () => {
		const { observer, events } = await mods();
		for (let i = 0; i < 4; i++) {
			observer.observeOnce("t1", { run: run("waiting-approval", "gate-one"), nodes: [] });
		}
		expect(events.readStatus("t1").events).toHaveLength(1);
	});
});
