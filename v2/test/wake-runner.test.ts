import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	claimWakeDrain,
	drainOnce,
	recordSweep,
	selectLiveSession,
	runWakeDrain,
	staleWatcherCondition,
	WAKE_DRAIN_LEASE_MS,
	type WakeDrainDependencies,
} from "../src/wake-runner";
import {
	dueWakes,
	enqueueWakeConditions,
	markInFlight,
	pendingWakes,
	type WakeItem,
} from "../src/wake";

const NOW = 10_000;
type TestWake = ReturnType<WakeDrainDependencies["dueWakes"]>[number];
type Sent = { content: string; options: { triggerTurn: boolean } };

let home: string;

function wake(
	id: string,
	tier: TestWake["tier"],
	overrides: Partial<TestWake> = {},
): TestWake {
	return {
		id,
		taskId: `task-${id}`,
		tier,
		verb: tier === "T0" ? "blocked" : tier === "T1" ? "done" : "working",
		key: "default",
		note: `note ${id}`,
		raw: `raw ${id}`,
		...overrides,
	};
}

function harness(
	wakes: TestWake[],
	options: {
		live?: boolean;
		send?: (content: string, options: { triggerTurn: boolean }) => Promise<{ ok: boolean }>;
		policy?: (items: WakeItem[]) => WakeItem[];
	} = {},
): {
	deps: WakeDrainDependencies;
	sent: Sent[];
	marked: Array<{ ids: string[]; now: number }>;
	suppressed: Array<{ ids: string[]; reason: string }>;
} {
	const sent: Sent[] = [];
	const marked: Array<{ ids: string[]; now: number }> = [];
	const suppressed: Array<{ ids: string[]; reason: string }> = [];
	return {
		deps: {
			now: () => NOW,
			hasLiveSession: () => options.live ?? true,
			dueWakes: () => wakes,
			owners: new Map(),
			applyProjectTierPolicy: (items) => options.policy?.(items) ?? items,
			send: options.send ?? (async (content, sendOptions) => {
				sent.push({ content, options: sendOptions });
				return { ok: true };
			}),
			markInFlight: (ids, now) => {
				marked.push({ ids, now });
			},
			suppressWakes: (ids, reason) => {
				suppressed.push({ ids, reason });
			},
		},
		sent,
		marked,
		suppressed,
	};
}

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-wake-runner-"));
	process.env.DECK_V2_HOME = home;
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
});

describe("drainOnce", () => {
	test("delivers every T0 event as its own interrupt", async () => {
		const first = wake("urgent-a", "T0");
		const second = wake("urgent-b", "T0", { verb: "failed" });
		const { deps, sent, marked } = harness([first, second]);

		const result = await drainOnce(deps);

		expect(sent).toHaveLength(2);
		expect(sent[0]?.content).toBe("task-urgent-a: blocked — note urgent-a\n\n[wake:urgent-a]");
		expect(sent[1]?.content).toBe("task-urgent-b: failed — note urgent-b\n\n[wake:urgent-b]");
		expect(sent.every((message) => message.options.triggerTurn)).toBe(true);
		expect(marked).toEqual([
			{ ids: ["urgent-a"], now: NOW },
			{ ids: ["urgent-b"], now: NOW },
		]);
		expect(result.deliveredIds).toEqual(["urgent-a", "urgent-b"]);
	});

	test("caps interrupts per cycle and keeps the overflow owed", async () => {
		// Measured on deckbox at first activation: 90 T0 entries were owed at
		// once. One message each would bury the orchestrator's context the moment
		// it starts, which is why an earlier wake attempt was abandoned.
		const many = Array.from({ length: 9 }, (_, index) => wake(`urgent-${index}`, "T0"));
		const { deps, sent, marked } = harness(many);

		const result = await drainOnce(deps);

		// Five interrupts, plus ONE folded notice about the rest. A warning that
		// there are too many messages must not itself be another interrupt.
		expect(sent).toHaveLength(6);
		expect(result.deliveredIds).toEqual(["urgent-0", "urgent-1", "urgent-2", "urgent-3", "urgent-4"]);
		expect(sent[5]?.content).toContain("4 more urgent wake(s) still owed");

		// The overflow is deferred, never dropped: not marked in flight, not
		// suppressed, and carrying no id into the marker, so it is redelivered.
		const markedIds = marked.flatMap((call) => call.ids);
		expect(markedIds).not.toContain("urgent-5");
		expect(markedIds).not.toContain("urgent-8");
		expect(sent[5]?.content).not.toContain("urgent-5");
		expect(result.silentIds).toEqual([]);
	});

	test("folds every due T1 event into exactly one message with every id", async () => {
		const wakes = [
			wake("batch-a1", "T1", { taskId: "task-a", note: "first" }),
			wake("batch-a2", "T1", { taskId: "task-a", note: "second" }),
			wake("batch-b", "T1", { taskId: "task-b", verb: "resolved" }),
		];
		const { deps, sent, marked } = harness(wakes);

		await drainOnce(deps);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.content).toContain("2 task(s) updated.");
		expect(sent[0]?.content).toContain("task-a: done — second (+1 earlier)");
		expect(sent[0]?.content).toContain("task-b: resolved — note batch-b");
		expect(sent[0]?.content.endsWith("[wake:batch-a1,batch-a2,batch-b]")).toBe(true);
		expect(marked).toEqual([{ ids: ["batch-a1", "batch-a2", "batch-b"], now: NOW }]);
	});

	test("never delivers T2 entries", async () => {
		const { deps, sent, marked, suppressed } = harness([wake("silent", "T2")]);

		const result = await drainOnce(deps);

		expect(sent).toEqual([]);
		expect(marked).toEqual([]);
		expect(suppressed).toEqual([{
			ids: ["silent"],
			reason: "classified T2; wake policy forbids delivery",
		}]);
		expect(result.silentIds).toEqual(["silent"]);
	});

	test("retries an entry after a failed send because it was not marked in-flight", async () => {
		let attempts = 0;
		const { deps, marked } = harness([wake("retry", "T0")], {
			send: async () => {
				attempts += 1;
				return { ok: false };
			},
		});

		await drainOnce(deps);
		await drainOnce(deps);

		expect(attempts).toBe(2);
		expect(marked).toEqual([]);
	});

	test("marks a successful delivery in-flight without acknowledging it", async () => {
		enqueueWakeConditions([{
			key: "needs-decision",
			taskId: "durable-wake",
			note: "choose a path",
			tier: "T0",
		}]);
		const before = pendingWakes();
		expect(before).toHaveLength(1);
		const sent: Sent[] = [];

		await drainOnce({
			now: () => NOW,
			hasLiveSession: () => true,
			dueWakes,
			owners: new Map(),
			applyProjectTierPolicy: (items) => items,
			send: async (content, options) => {
				sent.push({ content, options });
				return { ok: true };
			},
			markInFlight,
			suppressWakes: () => {},
		});

		const after = pendingWakes();
		expect(after).toHaveLength(1);
		expect(after[0]?.id).toBe(before[0]?.id);
		expect(after[0]?.deliveredAt).toBe(NOW);
		expect(sent[0]?.content.endsWith(`[wake:${before[0]?.id}]`)).toBe(true);
	});

	test("does not read, send, or mutate the queue without a live session", async () => {
		enqueueWakeConditions([{
			key: "needs-decision",
			taskId: "parked-wake",
			note: "still owed",
			tier: "T0",
		}]);
		const before = pendingWakes();
		let dueReads = 0;
		let sends = 0;
		let marks = 0;

		const result = await drainOnce({
			now: () => NOW,
			hasLiveSession: () => false,
			dueWakes: (now) => {
				dueReads += 1;
				return dueWakes(now);
			},
			owners: new Map(),
			applyProjectTierPolicy: (items) => items,
			send: async () => {
				sends += 1;
				return { ok: true };
			},
			markInFlight: () => {
				marks += 1;
			},
			suppressWakes: () => {},
		});

		expect(result.liveSession).toBe(false);
		expect({ dueReads, sends, marks }).toEqual({ dueReads: 0, sends: 0, marks: 0 });
		expect(pendingWakes()).toEqual(before);
	});

	test("applies injected project policy to durable entries before delivery", async () => {
		const terminal = wake("terminal", "T1", { key: "terminal", verb: "done" });
		let policyCalls = 0;
		const { deps, sent, suppressed } = harness([terminal], {
			policy: (items) => {
				policyCalls += 1;
				return items.map((item) => ({ ...item, tier: "T2" }));
			},
		});

		const result = await drainOnce(deps);

		expect(policyCalls).toBe(1);
		expect(sent).toEqual([]);
		expect(suppressed).toEqual([{
			ids: ["terminal"],
			reason: "classified T2; wake policy forbids delivery",
		}]);
		expect(result.silentIds).toEqual(["terminal"]);
	});
});

describe("wake watcher heartbeat", () => {
	test("is loud when no sweep has ever been recorded", () => {
		expect(staleWatcherCondition(NOW, 1_000)).toMatchObject({
			key: "watcher-stale",
			taskId: "wake-runner",
			tier: "T0",
		});
	});

	test("fires only after the recorded sweep is older than the threshold", () => {
		recordSweep(NOW);

		expect(staleWatcherCondition(NOW + 999, 1_000)).toBeNull();
		expect(staleWatcherCondition(NOW + 1_000, 1_000)).toBeNull();
		expect(staleWatcherCondition(NOW + 1_001, 1_000)).toMatchObject({
			key: "watcher-stale",
			taskId: "wake-runner",
			tier: "T0",
		});
	});
});

describe("wake drain singleton", () => {
	test("a live holder makes --once a successful no-op", async () => {
		const holder = claimWakeDrain();
		expect(holder).not.toBeNull();
		try {
			await runWakeDrain({ once: true });
			expect(fs.existsSync(path.join(home, "state", ".wake-runner-heartbeat.json"))).toBe(false);
		} finally {
			holder?.release();
		}
	});

	test("a running holder that renews is not evicted", () => {
		const holder = claimWakeDrain(NOW, process.pid);
		expect(holder).not.toBeNull();
		expect(holder?.renew(NOW + WAKE_DRAIN_LEASE_MS)).toBe(true);

		const contender = claimWakeDrain(
			NOW + WAKE_DRAIN_LEASE_MS * 2 - 1,
			process.pid,
		);

		expect(contender).toBeNull();
		holder?.release(NOW + WAKE_DRAIN_LEASE_MS * 2);
	});

	test("reclaims an expired holder even when its pid was reused, then releases after --once", async () => {
		const abandoned = claimWakeDrain(NOW, process.pid);
		expect(abandoned).not.toBeNull();

		await runWakeDrain({ once: true });

		expect(abandoned?.renew(Date.now())).toBe(false);
		expect(fs.existsSync(path.join(home, "state", ".wake-runner-heartbeat.json"))).toBe(true);
		const next = claimWakeDrain();
		expect(next).not.toBeNull();
		next?.release();
	});
});

describe("selectLiveSession", () => {
	const home = "/home/tim/.deck";
	const base = { runtimeKind: "top-level" as const, cwd: home };

	test("refuses a session with no attached client", () => {
		// Measured on deckbox: the daemon accepted a message for a
		// daemon-resident session with zero clients, answered success, and the
		// text appeared in no transcript. The drainer marked the wake in flight,
		// so the obligation was consumed and nobody was ever woken. Delivery to
		// nobody is worse than no delivery.
		expect(selectLiveSession([{ ...base, id: "orphan", attachedClients: 0 }], home)).toBeNull();
		expect(selectLiveSession([{ ...base, id: "orphan" }], home)).toBeNull();
	});

	test("selects an attached session and prefers the most attached", () => {
		expect(selectLiveSession([{ ...base, id: "live", attachedClients: 1 }], home)).toBe("live");
		expect(
			selectLiveSession(
				[
					{ ...base, id: "orphan", attachedClients: 0 },
					{ ...base, id: "live", attachedClients: 1 },
				],
				home,
			),
		).toBe("live");
	});

	test("ignores sessions from another home or runtime kind", () => {
		expect(selectLiveSession([{ ...base, cwd: "/elsewhere", id: "x", attachedClients: 1 }], home)).toBeNull();
		expect(
			selectLiveSession([{ runtimeKind: "child", cwd: home, id: "x", attachedClients: 1 } as never], home),
		).toBeNull();
	});
});
