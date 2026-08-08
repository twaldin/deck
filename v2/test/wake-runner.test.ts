import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	claimWakeDrain,
	drainOnce,
	recordSweep,
	retireQuestionsForTerminalRuns,
	selectLiveSession,
	runWakeDrain,
	staleWatcherCondition,
	WAKE_DRAIN_LEASE_MS,
	type WakeDrainDependencies,
} from "../src/wake-runner";
import { askWorkflowQuestion, openQuestions, workflowQuestions } from "../src/questions-store";
import {
	defaultConditionTier,
	dueWakes,
	enqueueWakeConditions,
	ackWakes,
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
	retired: string[];
} {
	const sent: Sent[] = [];
	const marked: Array<{ ids: string[]; now: number }> = [];
	const suppressed: Array<{ ids: string[]; reason: string }> = [];
	const retired: string[] = [];
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
			retire: (ids) => {
				retired.push(...ids);
			},
			suppressWakes: (ids, reason) => {
				suppressed.push({ ids, reason });
			},
		},
		sent,
		marked,
		suppressed,
		retired,
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
		const { deps, sent, retired } = harness([first, second]);

		const result = await drainOnce(deps);

		expect(sent).toHaveLength(2);
		expect(sent[0]?.content).toBe("task-urgent-a: blocked — note urgent-a\n\n[wake:urgent-a]");
		expect(sent[1]?.content).toBe("task-urgent-b: failed — note urgent-b\n\n[wake:urgent-b]");
		expect(sent.every((message) => message.options.triggerTurn)).toBe(true);
		// Receipt is the acknowledgement: a delivered wake is retired here, not
		// left owed until the orchestrator calls wake_ack.
		expect(retired).toEqual(["urgent-a", "urgent-b"]);
		expect(result.deliveredIds).toEqual(["urgent-a", "urgent-b"]);
	});

	test("same-fact T0s across tasks fold into one interrupt", async () => {
		// Three runs watching one broker each produced a broker-no-quota wake;
		// the captain got three separate mid-turn interruptions carrying the
		// same fact (observed live 2026-08-08). Same key + same note = one
		// message covering every task, retiring every entry.
		const outage = (id: string) => wake(id, "T0", { key: "broker-no-quota", verb: "broker-no-quota", note: "broker has no available quota" });
		const { deps, sent, retired } = harness([outage("q-a"), outage("q-b"), outage("q-c"), wake("other", "T0", { verb: "failed" })]);

		const result = await drainOnce(deps);

		expect(sent).toHaveLength(2);
		expect(sent[0]?.content).toContain("task-q-a");
		expect(sent[0]?.content).toContain("task-q-c");
		expect(sent[0]?.content).toContain("[wake:q-a,q-b,q-c]");
		expect(retired).toEqual(["q-a", "q-b", "q-c", "other"]);
		expect(result.deliveredIds).toEqual(["q-a", "q-b", "q-c", "other"]);
	});

	test("fold identity separates different verbs and same-task repeats", async () => {
		// "blocked: X" and "failed: X" with an identical note are different
		// facts; two failures of ONE task are also two facts. Neither may
		// share a fold — a real failure can never hide inside one.
		const { deps, sent } = harness([
			wake("v-a", "T0", { taskId: "t1", key: "default", verb: "blocked", note: "same words" }),
			wake("v-b", "T0", { taskId: "t2", key: "default", verb: "failed", note: "same words" }),
			wake("v-c", "T0", { taskId: "t1", key: "default", verb: "failed", note: "same words" }),
		]);

		const result = await drainOnce(deps);

		// v-a (blocked) never joins the failed group; v-b and v-c carry the
		// same fact about two DIFFERENT tasks so they fold: 2 messages.
		expect(sent).toHaveLength(2);
		expect(result.deliveredIds.sort()).toEqual(["v-a", "v-b", "v-c"]);
	});

	test("same-task repeats of one fact never fold together", async () => {
		const { deps, sent } = harness([
			wake("s-a", "T0", { taskId: "t1", key: "default", verb: "failed", note: "same words" }),
			wake("s-b", "T0", { taskId: "t1", key: "default", verb: "failed", note: "same words" }),
		]);

		const result = await drainOnce(deps);

		expect(sent).toHaveLength(2);
		expect(result.deliveredIds.sort()).toEqual(["s-a", "s-b"]);
	});

	test("broker quota exhaustion classifies T1 through the production default", () => {
		expect(defaultConditionTier("broker-no-quota")).toBe("T1");
		expect(defaultConditionTier("ci-fail")).toBe("T0");
	});

	test("broker condition with no explicit tier delivers as one T1 batch", async () => {
		// The producer omits tier; classification happens in the store. Three
		// tasks hitting the shared outage must produce one batched message,
		// not three interrupts.
		const tier = defaultConditionTier("broker-no-quota");
		const outage = (id: string) => wake(id, tier, { key: "broker-no-quota", verb: "broker-no-quota", note: "broker has no available quota" });
		const { deps, sent } = harness([outage("n-a"), outage("n-b"), outage("n-c")]);

		const result = await drainOnce(deps);

		expect(tier).toBe("T1");
		expect(sent).toHaveLength(1);
		expect(result.deliveredIds.sort()).toEqual(["n-a", "n-b", "n-c"]);
	});

	test("a rejected send keeps the wake owed instead of retiring it", async () => {
		// The daemon answers {success:false} for a prompt it will not accept. That
		// resolves, so awaiting the request is not proof of delivery; retiring on
		// it would drop the event with nobody informed.
		const { deps, retired } = harness([wake("urgent-a", "T0")], {
			send: async () => ({ ok: false }),
		});

		const result = await drainOnce(deps);

		expect(retired).toEqual([]);
		expect(result.deliveredIds).toEqual([]);
		expect(result.failedIds).toEqual(["urgent-a"]);
	});

	test("a send that throws keeps the wake owed", async () => {
		const { deps, retired } = harness([wake("urgent-a", "T0")], {
			send: async () => {
				throw new Error("socket closed mid-delivery");
			},
		});

		const result = await drainOnce(deps);

		expect(retired).toEqual([]);
		expect(result.failedIds).toEqual(["urgent-a"]);
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
		expect(sent[5]?.content).toContain("4 more urgent wake group(s) still owed");

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
		const { deps, sent, retired } = harness(wakes);

		await drainOnce(deps);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.content).toContain("2 task(s) updated.");
		expect(sent[0]?.content).toContain("task-a: done — second (+1 earlier)");
		expect(sent[0]?.content).toContain("task-b: resolved — note batch-b");
		expect(sent[0]?.content.endsWith("[wake:batch-a1,batch-a2,batch-b]")).toBe(true);
		// A folded batch carries several ids in one message, so all of them retire
		// on that single receipt.
		expect(retired).toEqual(["batch-a1", "batch-a2", "batch-b"]);
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

	test("a delivered wake is retired from the real queue and never comes back", async () => {
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
			retire: (ids) => {
				ackWakes(ids);
			},
			suppressWakes: () => {},
		});

		expect(sent[0]?.content.endsWith(`[wake:${before[0]?.id}]`)).toBe(true);
		// Delivery is the end of the entry's life. It used to stay owed with a
		// deliveredAt marker and return on a timer until the orchestrator acked,
		// which is how one effort interrupted a live session every two minutes.
		expect(pendingWakes()).toHaveLength(0);
		expect(dueWakes(NOW + 86_400_000)).toHaveLength(0);
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
			retire: () => {
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

describe("terminal-run question retirement (production sweep seam)", () => {
	const base = {
		answerLane: "store" as const,
		resumeHint: "hint",
		originalIssue: "issue",
		proposedAction: "action",
		blastRadius: "radius",
		cwd: "/workflow",
	};

	function questionsFile(): string {
		return path.join(home, "questions", "queue.jsonl");
	}

	test("retires questions for terminal runs and leaves live runs alone", () => {
		const file = questionsFile();
		process.env.DECK_QUESTIONS_FILE = file;
		try {
			askWorkflowQuestion(file, { ...base, runId: "run-dead", nodeId: "n1" });
			askWorkflowQuestion(file, { ...base, runId: "run-live", nodeId: "n1" });

			const retired = retireQuestionsForTerminalRuns([
				{ id: "run-dead", status: "finished", state: "cancelled" },
				{ id: "run-live", status: "running" },
			]);

			expect(retired).toHaveLength(1);
			expect(workflowQuestions(file, "run-dead", "n1")[0]?.status).toBe("dismissed");
			expect(openQuestions(file)).toHaveLength(1);
			expect(openQuestions(file)[0]?.workflow?.runId).toBe("run-live");

			// Idempotent across sweeps.
			expect(retireQuestionsForTerminalRuns([
				{ id: "run-dead", status: "finished", state: "cancelled" },
			])).toEqual([]);
		} finally {
			delete process.env.DECK_QUESTIONS_FILE;
		}
	});

	test("INTEGRATION: one wake-drain sweep retires a cancelled run's question via the gateway snapshot", async () => {
		const file = questionsFile();
		process.env.DECK_QUESTIONS_FILE = file;
		// collectRuns requires the workspace dir to exist before it consults the gateway.
		fs.mkdirSync(path.join(home, "state", "smithers"), { recursive: true });
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json({
				ok: true,
				payload: [{ id: "run-cx", workflow: "pr-pipeline", status: "finished", state: "cancelled" }],
			}),
		});
		process.env.SMITHERS_GATEWAY_URL = `http://127.0.0.1:${server.port}`;
		try {
			askWorkflowQuestion(file, { ...base, runId: "run-cx", nodeId: "gate" });
			expect(openQuestions(file)).toHaveLength(1);

			await runWakeDrain({ once: true });

			const entry = workflowQuestions(file, "run-cx", "gate")[0];
			expect(entry?.status).toBe("dismissed");
			expect(entry?.answer).toContain("terminal state cancelled");
			expect(openQuestions(file)).toEqual([]);
		} finally {
			server.stop(true);
			delete process.env.SMITHERS_GATEWAY_URL;
			delete process.env.DECK_QUESTIONS_FILE;
		}
	});

	test("REGRESSION: a hung gateway never blocks the sweep — GC is skipped with a warning", async () => {
		const file = questionsFile();
		process.env.DECK_QUESTIONS_FILE = file;
		fs.mkdirSync(path.join(home, "state", "smithers"), { recursive: true });
		// A gateway that accepts the request and never responds.
		const server = Bun.serve({
			port: 0,
			fetch: () => new Promise<Response>(() => {}),
		});
		process.env.SMITHERS_GATEWAY_URL = `http://127.0.0.1:${server.port}`;
		process.env.DECK_RUN_SNAPSHOT_DEADLINE_MS = "200";
		const warnings: string[] = [];
		const realWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			warnings.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			askWorkflowQuestion(file, { ...base, runId: "run-hung", nodeId: "n1" });
			// The sweep completes: wake delivery ran, GC was skipped.
			await runWakeDrain({ once: true });
			expect(warnings.join("")).toContain("skipping question GC");
			// GC was skipped, so the question is untouched (the run may be live).
			expect(openQuestions(file)).toHaveLength(1);
		} finally {
			process.stderr.write = realWrite;
			server.stop(true);
			delete process.env.SMITHERS_GATEWAY_URL;
			delete process.env.DECK_QUESTIONS_FILE;
			delete process.env.DECK_RUN_SNAPSHOT_DEADLINE_MS;
		}
	});

	test("REGRESSION: a hung snapshot is evicted on timeout — the next sweep issues a fresh request and GC recovers", async () => {
		const file = questionsFile();
		process.env.DECK_QUESTIONS_FILE = file;
		fs.mkdirSync(path.join(home, "state", "smithers"), { recursive: true });
		process.env.DECK_RUN_SNAPSHOT_DEADLINE_MS = "200";
		// Sweep 1: a gateway that accepts the request and never responds.
		const hung = Bun.serve({
			port: 0,
			fetch: () => new Promise<Response>(() => {}),
		});
		process.env.SMITHERS_GATEWAY_URL = `http://127.0.0.1:${hung.port}`;
		const warnings: string[] = [];
		const realWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			warnings.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		let healthy: ReturnType<typeof Bun.serve> | undefined;
		try {
			askWorkflowQuestion(file, { ...base, runId: "run-recover", nodeId: "n1" });
			await runWakeDrain({ once: true });
			expect(warnings.join("")).toContain("skipping question GC");
			expect(openQuestions(file)).toHaveLength(1);

			// Sweep 2: a healthy gateway. Without eviction, the cached hung
			// promise would be re-awaited and GC would stay disabled forever.
			healthy = Bun.serve({
				port: 0,
				fetch: () => Response.json({
					ok: true,
					payload: [{ id: "run-recover", workflow: "pr-pipeline", status: "finished", state: "cancelled" }],
				}),
			});
			process.env.SMITHERS_GATEWAY_URL = `http://127.0.0.1:${healthy.port}`;
			await runWakeDrain({ once: true });
			expect(workflowQuestions(file, "run-recover", "n1")[0]?.status).toBe("dismissed");
			expect(openQuestions(file)).toEqual([]);
		} finally {
			process.stderr.write = realWrite;
			hung.stop(true);
			healthy?.stop(true);
			delete process.env.SMITHERS_GATEWAY_URL;
			delete process.env.DECK_QUESTIONS_FILE;
			delete process.env.DECK_RUN_SNAPSHOT_DEADLINE_MS;
		}
	});

	test("REGRESSION: a gateway HTTP error (degraded health, no rejection) skips GC with a warning", async () => {
		const file = questionsFile();
		process.env.DECK_QUESTIONS_FILE = file;
		fs.mkdirSync(path.join(home, "state", "smithers"), { recursive: true });
		// collectRuns swallows this into { runs: [], health: missing } — it never
		// rejects, so the deadline path alone would silently no-op.
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response("boom", { status: 500 }),
		});
		process.env.SMITHERS_GATEWAY_URL = `http://127.0.0.1:${server.port}`;
		const warnings: string[] = [];
		const realWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			warnings.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			askWorkflowQuestion(file, { ...base, runId: "run-err", nodeId: "n1" });
			await runWakeDrain({ once: true });
			expect(warnings.join("")).toContain(
				"skipping question GC this sweep: gateway snapshot missing",
			);
			// GC skipped: the question is untouched.
			expect(openQuestions(file)).toHaveLength(1);
		} finally {
			process.stderr.write = realWrite;
			server.stop(true);
			delete process.env.SMITHERS_GATEWAY_URL;
			delete process.env.DECK_QUESTIONS_FILE;
		}
	});

	test("REGRESSION: retirement stops at the budget deadline and warns, resuming next sweep", () => {
		const file = questionsFile();
		process.env.DECK_QUESTIONS_FILE = file;
		try {
			askWorkflowQuestion(file, { ...base, runId: "run-a", nodeId: "n1" });
			askWorkflowQuestion(file, { ...base, runId: "run-b", nodeId: "n1" });
			const warnings: string[] = [];

			// Deadline already in the past: the loop stops before any run.
			const retired = retireQuestionsForTerminalRuns(
				[
					{ id: "run-a", status: "finished", state: "cancelled" },
					{ id: "run-b", status: "finished", state: "cancelled" },
				],
				(message) => warnings.push(message),
				Date.now() - 1,
			);

			expect(retired).toEqual([]);
			expect(warnings.join("")).toContain(
				"question GC budget exhausted after 0 run(s); resuming next sweep",
			);
			expect(openQuestions(file)).toHaveLength(2);

			// The next sweep, with budget, finishes the work.
			expect(retireQuestionsForTerminalRuns(
				[
					{ id: "run-a", status: "finished", state: "cancelled" },
					{ id: "run-b", status: "finished", state: "cancelled" },
				],
				undefined,
				Date.now() + 5_000,
			)).toHaveLength(2);
			expect(openQuestions(file)).toEqual([]);
		} finally {
			delete process.env.DECK_QUESTIONS_FILE;
		}
	});

	test("a retirement failure warns and does not break the sweep path", () => {
		// A directory where the queue file should be is a real write failure.
		const asDir = path.join(home, "questions", "queue.jsonl");
		fs.mkdirSync(asDir, { recursive: true });
		process.env.DECK_QUESTIONS_FILE = asDir;
		const warnings: string[] = [];
		try {
			expect(retireQuestionsForTerminalRuns(
				[{ id: "run-z", state: "failed" }],
				(message) => warnings.push(message),
			)).toEqual([]);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("run-z");
		} finally {
			delete process.env.DECK_QUESTIONS_FILE;
		}
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
