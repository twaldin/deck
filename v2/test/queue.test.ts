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
