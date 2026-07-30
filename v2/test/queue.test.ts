import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-q-"));
	process.env.DECK_V2_HOME = home;
	fs.mkdirSync(path.join(home, "state"), { recursive: true });
});
afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
});

describe("queued message delivery", () => {
	// The adversarial review found this: hydration acked messages at string-BUILD
	// time, so a spawn that then failed marked the captain's steer delivered and it
	// was gone. That failure is silent — he believes he redirected the work.
	test("REGRESSION: building hydration does not ack; the message survives a failed spawn", async () => {
		const { enqueue, pending } = await import("../src/queue");
		const { buildHydration } = await import("../src/hydrate");
		enqueue("t1", "stop and rebase first", "captain");

		const hydration = buildHydration("t1", 1);
		expect(hydration.text).toContain("stop and rebase first");
		expect(hydration.messageIds).toHaveLength(1);
		// The spawn failed. The steer must still be owed.
		expect(pending("t1")).toHaveLength(1);
	});

	test("acking after a started run makes delivery exactly once", async () => {
		const { enqueue, pending, ack } = await import("../src/queue");
		const { buildHydration } = await import("../src/hydrate");
		enqueue("t1", "use the other approach", "captain");

		const first = buildHydration("t1", 1);
		ack("t1", first.messageIds, 1);
		expect(pending("t1")).toHaveLength(0);
		// A later run must not see it again.
		expect(buildHydration("t1", 2).messageIds).toHaveLength(0);
	});
});

describe("concurrent send and ack", () => {
	// Acking used to rewrite the producer log from a snapshot, which races
	// `deck-v2 send`. Measured with two real processes: 29 of 41 queued captain
	// steers destroyed. A lost steer is silent — he believes he redirected the work
	// and it continues the old way.
	test("REGRESSION: a concurrent send and ack lose nothing", async () => {
		const { enqueue, readQueue } = await import("../src/queue");
		enqueue("t1", "seed", "captain");

		const script = `
			process.env.DECK_V2_HOME = ${JSON.stringify(home)};
			const fs = await import("node:fs");
			const { enqueue, ack, readQueue } = await import(${JSON.stringify(path.join(import.meta.dir, "..", "src", "queue.ts"))});
			const barrier = ${JSON.stringify(path.join(home, "barrier"))};
			fs.appendFileSync(barrier, "x");
			while (fs.readFileSync(barrier, "utf8").length < 2) {}
			if (process.argv[2] === "send") {
				for (let i = 0; i < 40; i++) enqueue("t1", "steer " + i, "captain");
			} else {
				for (let i = 0; i < 40; i++) ack("t1", readQueue("t1").map((m) => m.id), 1);
			}
		`;
		const file = path.join(home, "race.mjs");
		fs.writeFileSync(file, script);
		fs.writeFileSync(path.join(home, "barrier"), "");

		const procs = ["send", "ack"].map((mode) =>
			Bun.spawn(["bun", file, mode], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" }),
		);
		await Promise.all(procs.map((proc) => proc.exited));

		// Every message the producer wrote must still exist.
		expect(readQueue("t1")).toHaveLength(41);
	});

	test("acking never rewrites the producer log", async () => {
		const { enqueue, ack, pending } = await import("../src/queue");
		const first = enqueue("t1", "one", "captain");
		enqueue("t1", "two", "captain");
		const queueFile = path.join(home, "state", "t1.queue");
		const before = fs.readFileSync(queueFile, "utf8");

		ack("t1", [first.id], 1);
		// Byte-identical: the queue file is append-only from the producer's side.
		expect(fs.readFileSync(queueFile, "utf8")).toBe(before);
		expect(pending("t1").map((m) => m.text)).toEqual(["two"]);
	});
});
