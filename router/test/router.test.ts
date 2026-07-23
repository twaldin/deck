import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AdapterFact, AdapterPollResult, TargetPollAdapter, WatchTarget } from "../src/adapters";
import type { DeckConfig, DeckEvent } from "@deck/core";

const deckHome = fs.mkdtempSync(path.join(os.tmpdir(), "deck-router-test-"));
process.env.DECK_HOME = deckHome;
process.env.DECK_MACHINE = "router-test";

// DECK_HOME is captured at module evaluation, so these known modules are intentionally loaded after the temp boundary.
const core = await import("@deck/core");
const { AdmissionController } = await import("../src/admission");
const { ChildRegistry } = await import("../src/child-registry");
const { classifyFact } = await import("../src/classifier");
const { WakeCoalescer } = await import("../src/coalescer");
const { FactPipeline } = await import("../src/fact-pipeline");
const { GhAdapter } = await import("../src/gh-adapter");
const { isProcessGroupAlive, killProcessGroup, spawnProcessGroup } = await import("../src/process-group");
const { OwnerSupervisor, classifyOwnerExit, hasCurrentParkEvent } = await import("../src/supervisor");

const fakePi = path.join(import.meta.dir, "fixtures/fake-pi.ts");
let sequence = 0;

function createTestEffort(label: string): InstanceType<typeof core.EffortStore> {
	sequence += 1;
	return core.createEffort({
		effort_id: `deck--${label}-${sequence}-${randomUUID().slice(0, 8)}`,
		project: "deck",
		title: label,
		charter: {
			goal: `Test ${label}`,
			acceptance_criteria: ["The router behavior is verified"],
			constraints: [],
		},
	});
}

function configWith(overrides: Partial<DeckConfig["router"]> = {}): DeckConfig {
	return {
		...core.DEFAULT_CONFIG,
		admission: { ...core.DEFAULT_CONFIG.admission },
		router: { ...core.DEFAULT_CONFIG.router, ...overrides },
	};
}

function ciFact(version = "v1", state: "red" | "green" | "pending" = "red"): AdapterFact {
	return {
		plane: "fact",
		type: "fact.pr.ci_state",
		actor: "router:fake",
		data: { pr: "deck/test#1", check_id: "build", state },
		idem: { source: "fake", external_id: "pr:deck/test#1:check:build", version },
	};
}

class FakeAdapter implements TargetPollAdapter {
	readonly source = "fake";
	readonly target: WatchTarget;
	private readonly result: AdapterPollResult;

	constructor(target: WatchTarget, result: AdapterPollResult) {
		this.target = target;
		this.result = result;
	}

	async pollCmd(_cursor?: unknown): Promise<AdapterPollResult> {
		return this.result;
	}
}

afterAll(() => {
	fs.rmSync(deckHome, { recursive: true, force: true });
});

describe("GitHub adapter", () => {
	test("emits only check, review, and comment transitions after its cursor", async () => {
		const response = {
			data: {
				repository: {
					pullRequest: {
						url: "https://github.com/deck/repo/pull/7",
						updatedAt: "2026-07-22T00:00:00Z",
						commits: {
							nodes: [{
								commit: {
									statusCheckRollup: {
										contexts: {
											nodes: [{
												__typename: "CheckRun",
												databaseId: 91,
												name: "build",
												status: "COMPLETED",
												conclusion: "FAILURE",
												startedAt: "2026-07-22T00:00:00Z",
												completedAt: "2026-07-22T00:01:00Z",
												detailsUrl: "https://github.com/deck/repo/actions/runs/91",
											}],
										},
									},
								},
							}],
						},
						reviews: {
							nodes: [{
								databaseId: 12,
								id: "review-12",
								state: "APPROVED",
								submittedAt: "2026-07-22T00:02:00Z",
								updatedAt: "2026-07-22T00:02:00Z",
								body: "Looks good",
								url: "https://github.com/deck/repo/pull/7#pullrequestreview-12",
								author: { login: "reviewer" },
							}],
						},
						comments: {
							nodes: [{
								databaseId: 13,
								id: "comment-13",
								createdAt: "2026-07-22T00:03:00Z",
								updatedAt: "2026-07-22T00:03:00Z",
								body: "Please adjust this",
								url: "https://github.com/deck/repo/pull/7#issuecomment-13",
								author: { login: "reviewer" },
							}],
						},
					},
				},
			},
		};
		const adapter = new GhAdapter({
			deadlineMs: 1_000,
			outputCapBytes: 512 * 1024,
			runner: async () => ({ stdout: JSON.stringify(response), stderr: "", exitCode: 0 }),
		}).bind({
			source: "gh",
			kind: "pr",
			reference: "deck/repo#7",
			effortIds: ["deck--gh-test"],
		});
		const first = await adapter.pollCmd(undefined);
		expect(first.facts).toHaveLength(3);
		expect(first.facts.find((fact) => fact.type === "fact.pr.ci_state")?.data.state).toBe("red");
		expect(first.facts.filter((fact) => fact.type === "fact.pr.review")).toHaveLength(2);
		const second = await adapter.pollCmd(first.cursor);
		expect(second.facts).toHaveLength(0);
	});
});

describe("fact pipeline", () => {
	test("deduplicates and preserves tail -> seen ring -> cursor order with a fake adapter", async () => {
		const store = createTestEffort("pipeline");
		const target: WatchTarget = {
			source: "fake",
			kind: "pr",
			reference: "deck/test#1",
			effortIds: [store.effortId],
		};
		const adapter = new FakeAdapter(target, { facts: [ciFact()], cursor: { page: 1 } });
		const seenKeys = new Set<string>();
		const order: string[] = [];
		const coalescer = new WakeCoalescer(60_000, async () => undefined);
		const pipeline = new FactPipeline({
			coalescer,
			ringFactory: () => ({
				has: (idem) => {
					order.push("seen.has");
					return seenKeys.has(JSON.stringify(idem));
				},
				add: (idem) => {
					expect(store.readTail().filter((event) => event.type === "fact.pr.ci_state")).toHaveLength(1);
					order.push("seen.add");
					seenKeys.add(JSON.stringify(idem));
				},
				flush: () => undefined,
			}),
			cursorReader: () => ({}),
			cursorWriter: (_source, cursor) => {
				expect(cursor).toEqual({ page: 1 });
				expect(seenKeys.size).toBe(1);
				order.push("cursor");
				return {};
			},
		});
		const polled = await adapter.pollCmd(undefined);
		const first = pipeline.process(target, polled);
		const second = pipeline.process(target, polled);
		expect(first).toEqual({ appended: 1, duplicates: 0, wakesQueued: 1 });
		expect(second).toEqual({ appended: 0, duplicates: 1, wakesQueued: 0 });
		expect(store.readTail().filter((event) => event.type === "fact.pr.ci_state")).toHaveLength(1);
		expect(order.slice(0, 3)).toEqual(["seen.has", "seen.add", "cursor"]);
		await coalescer.flushAll();
	});
});

describe("wake coalescing", () => {
	test("folds an effort burst into one wake window", async () => {
		const store = createTestEffort("coalescing");
		const first = store.appendEvent(ciFact("v1"));
		const second = store.appendEvent(ciFact("v2"));
		const batches: Array<{ summary: string; events: DeckEvent[] }> = [];
		const coalescer = new WakeCoalescer(15, async (batch) => {
			batches.push({ summary: batch.summary, events: batch.events });
		});
		coalescer.enqueue(store.effortId, first);
		coalescer.enqueue(store.effortId, second);
		expect(coalescer.pendingEfforts).toBe(1);
		await coalescer.flushAll();
		expect(batches).toHaveLength(1);
		expect(batches[0]?.events).toHaveLength(2);
		expect(batches[0]?.summary).toBe("2 fact.pr.ci_state");
	});
});

describe("admission", () => {
	test("enforces per-effort, global, and swap caps before spawn", () => {
		const config = {
			...core.DEFAULT_CONFIG.admission,
			maxActiveSessionsGlobal: 2,
			maxDispatchesPerEffort: 1,
			swapThresholdBytes: 100,
		};
		const admission = new AdmissionController(config, () => 0);
		expect(admission.tryReserve("d1", "dispatch", "effort-a").allowed).toBe(true);
		expect(admission.tryReserve("d2", "dispatch", "effort-a").reason).toBe("effort-cap");
		expect(admission.tryReserve("owner", "owner", "effort-b").allowed).toBe(true);
		expect(admission.tryReserve("d3", "dispatch", "effort-c").reason).toBe("global-cap");
		admission.release("owner");
		expect(admission.tryReserve("d3", "dispatch", "effort-c").allowed).toBe(true);

		const swapAdmission = new AdmissionController(config, () => 101);
		expect(swapAdmission.tryReserve("owner", "owner", "effort-a").reason).toBe("swap");
	});
});

describe("classifier D-F", () => {
	test("wakes and flags Done regressions and PR-link changes", () => {
		const stateRegression: AdapterFact = {
			plane: "fact",
			type: "fact.ticket.state",
			actor: "router:linear",
			data: { ticket: "ENG-1", previous_state: "Done", current_state: "In Progress" },
			idem: { source: "linear", external_id: "ENG-1:state", version: "2" },
		};
		const linkChange: AdapterFact = {
			plane: "fact",
			type: "fact.ticket.pr_link",
			actor: "router:linear",
			data: {
				ticket: "ENG-1",
				ticket_state: "Done",
				previous_pr_links: ["deck/repo#1"],
				current_pr_links: ["deck/repo#2"],
			},
			idem: { source: "linear", external_id: "ENG-1:links", version: "2" },
		};
		expect(classifyFact(stateRegression, { waiting: false })).toMatchObject({ wake: true, flagged: true });
		expect(classifyFact(linkChange, { waiting: false })).toMatchObject({ wake: true, flagged: true });
	});
});

describe("process groups", () => {
	test("kills a stubborn shell and all sleep children as one group", async () => {
		const group = spawnProcessGroup("sh", ["-c", "trap '' TERM; sleep 30 & sleep 30 & wait"]);
		expect(isProcessGroupAlive(group.pgid)).toBe(true);
		await killProcessGroup(group.pgid, group.exited, 50);
		expect(isProcessGroupAlive(group.pgid)).toBe(false);
	});
});

describe("owner exit semantics", () => {
	test("recognizes agent-end park only for the current generation and keeps exit classes separate", () => {
		const store = createTestEffort("park-exit");
		const firstLease = store.bumpLease(store.readManifest().revision, {
			machine: "router-test",
			session_id: "owner-one",
			last_heartbeat: Date.now(),
		});
		expect(classifyOwnerExit(0)).toBe("ended");
		const manifest = store.readManifest();
		store.mutate(manifest.revision, firstLease.token, (current) => ({
			manifest: { ...current, digest: "Parked with clean context." },
			event: {
				plane: "lifecycle",
				type: "lifecycle.park",
				actor: "owner",
				data: { digest: "Parked with clean context." },
			},
		}));
		expect(hasCurrentParkEvent(store)).toBe(true);
		expect(classifyOwnerExit(0)).toBe("ended");
		expect(classifyOwnerExit(1)).toBe("crash");
		store.bumpLease(store.readManifest().revision, { machine: "router-test", session_id: "owner-two", last_heartbeat: null });
		expect(hasCurrentParkEvent(store)).toBe(false);
	});
});

describe("pi supervision", () => {
	test("fresh owner spawn injects durable inbox commands and redelivers until ack", async () => {
		const store = createTestEffort("owner");
		const promptLog = path.join(deckHome, `${store.effortId}.prompts`);
		store.inboxAppend({ from: "tim", cmd: { text: "Please check CI" }, cmd_id: "cmd-owner-test" });
		const supervisor = new OwnerSupervisor({
			config: configWith({ spawnDeadlineMs: 500 }),
			piCommand: [process.execPath, fakePi],
			ownerModel: "fake",
			lifecycleExtensionPath: fakePi,
			queueLimit: 10,
			registry: new ChildRegistry(),
			spawnEnv: { FAKE_PI_PROMPT_LOG: promptLog },
			killGraceMs: 50,
		});
		await supervisor.wake(store.effortId, "manual test wake");
		expect(store.inboxState().find((command) => command.cmd_id === "cmd-owner-test")?.delivered).not.toBeNull();
		const boundLease = store.readLease();
		expect(boundLease?.holder?.session_id).toBe(store.readManifest().session?.session_id);
		await supervisor.tick();
		const prompts = fs.readFileSync(promptLog, "utf8");
		expect(prompts.match(/\[deck:cmd cmd-owner-test\]/g)?.length).toBeGreaterThanOrEqual(2);
		await supervisor.shutdown();
	});

	test("agent_end after a current park event terminates and marks the owner parked", async () => {
		const store = createTestEffort("owner-park");
		const { promise: parked, resolve: resolveParked } = Promise.withResolvers<void>();
		const supervisor = new OwnerSupervisor({
			config: configWith({ spawnDeadlineMs: 500 }),
			piCommand: [process.execPath, fakePi],
			ownerModel: "fake",
			lifecycleExtensionPath: fakePi,
			queueLimit: 10,
			registry: new ChildRegistry(),
			spawnEnv: {
				FAKE_PI_HEARTBEAT_DELAY_MS: "25",
				FAKE_PI_PARK_AFTER_PROMPT: "1",
			},
			killGraceMs: 50,
			onOwnerState: (effortId, state) => {
				if (effortId === store.effortId && state === "parked") {
					resolveParked();
				}
			},
		});
		await supervisor.wake(store.effortId, "park integration wake");
		await parked;
		expect((await supervisor.status()).owners).toHaveLength(0);
		const parkedExit = store.readTail().find((event) => event.type === "lifecycle.owner_exit");
		expect(parkedExit).toBeDefined();
		const data = z.object({ state: z.string() }).loose().parse(parkedExit?.data);
		expect(data.state).toBe("parked");
		await supervisor.shutdown();
	});

	test("dispatch liveness timeout kills the group and records no running lane", async () => {
		const store = createTestEffort("dispatch-timeout");
		const lease = store.bumpLease(store.readManifest().revision, { machine: "router-test", session_id: "owner-session", last_heartbeat: Date.now() });
		const supervisor = new OwnerSupervisor({
			config: configWith({ spawnDeadlineMs: 120 }),
			piCommand: [process.execPath, fakePi],
			ownerModel: "fake",
			lifecycleExtensionPath: fakePi,
			queueLimit: 10,
			registry: new ChildRegistry(),
			spawnEnv: { FAKE_PI_NEVER_HEARTBEAT: "1" },
			killGraceMs: 50,
		});
		let caught: unknown;
		try {
			await supervisor.dispatch(store.effortId, "fake", "Do the work", lease.token);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(core.DeckError);
		if (caught instanceof core.DeckError) {
			expect(caught.code).toBe("E_LIVENESS");
		}
		expect(store.readManifest().dispatches).toHaveLength(0);
		expect(new ChildRegistry().list().filter((record) => record.effort_id === store.effortId)).toHaveLength(0);
		await supervisor.shutdown();
	});

	test("caller abort kills an unverified dispatch child", async () => {
		const store = createTestEffort("dispatch-abort");
		const lease = store.bumpLease(store.readManifest().revision, { machine: "router-test", session_id: "owner-session", last_heartbeat: Date.now() });
		const supervisor = new OwnerSupervisor({
			config: configWith({ spawnDeadlineMs: 1_000 }),
			piCommand: [process.execPath, fakePi],
			ownerModel: "fake",
			lifecycleExtensionPath: fakePi,
			queueLimit: 10,
			registry: new ChildRegistry(),
			spawnEnv: { FAKE_PI_NEVER_HEARTBEAT: "1" },
			killGraceMs: 50,
		});
		const controller = new AbortController();
		const dispatched = supervisor.dispatch(store.effortId, "fake", "Abort this work", lease.token, controller.signal);
		controller.abort();
		await expect(dispatched).rejects.toBeInstanceOf(core.DeckError);
		expect(store.readManifest().dispatches).toHaveLength(0);
		expect(new ChildRegistry().list().filter((record) => record.effort_id === store.effortId)).toHaveLength(0);
		await supervisor.shutdown();
	});

	test("boot reconcile fails and flags a recorded dispatch without first heartbeat", async () => {
		const store = createTestEffort("reconcile");
		const manifest = store.readManifest();
		store.mutate(manifest.revision, null, (current) => ({
			manifest: {
				...current,
				dispatches: [...current.dispatches, {
					id: "dispatch-without-heartbeat",
					kind: "subagent",
					target: "fake",
					state: "running",
					started: Date.now(),
					session: {
						machine: "router-test",
						session_id: "worker-session",
						lease_epoch: 1,
						last_heartbeat: null,
					},
					result_ref: null,
				}],
			},
			event: {
				plane: "lifecycle",
				type: "lifecycle.test_dispatch_recorded",
				actor: "test",
				data: { dispatch_id: "dispatch-without-heartbeat" },
			},
		}));
		const supervisor = new OwnerSupervisor({
			config: configWith(),
			piCommand: [process.execPath, fakePi],
			ownerModel: "fake",
			lifecycleExtensionPath: fakePi,
			queueLimit: 10,
			registry: new ChildRegistry(),
			killGraceMs: 50,
		});
		await supervisor.recover();
		const reconciled = store.readManifest();
		expect(reconciled.dispatches[0]?.state).toBe("failed");
		expect(reconciled.cards.some((entry) => entry.card.kind === "flagged")).toBe(true);
		await supervisor.shutdown();
	});
});
