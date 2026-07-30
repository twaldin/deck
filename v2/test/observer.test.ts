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
		const observation = { run: run("completed"), nodes: [] };

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
		expect(events.readStatus("t1").events.filter((line) => line.verb === "working")).toHaveLength(2);
	});

	test("a restarted observer does not re-announce history", async () => {
		const { observer, events } = await mods();
		observer.observeOnce("t1", { run: run("awaiting_approval", "gate"), nodes: [] });
		observer.observeOnce("t1", { run: run("completed"), nodes: [] });

		// Simulating a fresh observer process: the ledger is on disk, so a replay of
		// the whole observed history must add nothing.
		observer.observeOnce("t1", { run: run("awaiting_approval", "gate"), nodes: [] });
		observer.observeOnce("t1", { run: run("completed"), nodes: [] });

		const lines = events.readStatus("t1").events;
		expect(lines).toHaveLength(2);
		expect(lines.map((line) => line.verb)).toEqual(["needs-decision", "done"]);
	});

	test("REGRESSION: a lost ledger is the failure that re-announces everything", async () => {
		const { observer, events } = await mods();
		observer.observeOnce("t1", { run: run("completed"), nodes: [] });
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

	test("an approval gate is a decision, because nothing advances without him", async () => {
		const { observer } = await mods();
		const [event] = observer.observeOnce("t1", {
			run: run("awaiting_approval", "merge-gate"),
			nodes: [],
		});
		expect(event?.verb).toBe("needs-decision");
		expect(event?.note).toContain("merge-gate");
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
		const planned = observer.planEvents("t1", { run: run("completed"), nodes: [] }, { emitted: [] });
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
