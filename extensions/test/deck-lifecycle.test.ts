import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import type { DeckError, DeckErrorCode, RouterRequest, RouterResponse } from "@deck/core";
import type {
	DeckExtensionApi,
	DeckHook,
	DeckHookHandler,
	DeckTool,
} from "../src/pi-types";

const TEST_HOME = mkdtempSync(path.join(tmpdir(), "deck-extensions-"));
process.env.DECK_HOME = TEST_HOME;
process.env.DECK_MACHINE = "test-machine";

// Dynamic import keeps the SPEC §0 DECK_HOME boundary pointed at this test-only directory.
const core = await import("@deck/core");
const { default: registerDeckLifecycle } = await import("../src/deck-lifecycle");

interface SentMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: Record<string, unknown>;
}

class ExtensionHarness implements DeckExtensionApi {
	readonly tools: Record<string, DeckTool> = {};
	readonly hooks: Record<DeckHook, DeckHookHandler[]> = {
		session_start: [],
		message_start: [],
		turn_end: [],
	};
	readonly messages: SentMessage[] = [];

	registerTool(tool: DeckTool): void {
		this.tools[tool.name] = tool;
	}

	on(event: DeckHook, handler: DeckHookHandler): void {
		this.hooks[event].push(handler);
	}

	sendMessage(message: SentMessage): void {
		this.messages.push(message);
	}

	async emit(event: DeckHook, payload: unknown): Promise<void> {
		for (const handler of this.hooks[event]) {
			await handler(payload, {});
		}
	}
}

let effortSequence = 0;

async function setupOwner(actor?: string) {
	effortSequence += 1;
	const effortId = `deck--extension-test-${effortSequence}`;
	const store = core.createEffort({
		effort_id: effortId,
		project: "deck",
		title: `Extension test ${effortSequence}`,
		charter: {
			goal: "Exercise the lifecycle extension",
			acceptance_criteria: ["Tool behavior is durable"],
			constraints: [],
		},
	});
	const lease = store.bumpLease(store.readManifest().revision, {
		machine: "test-machine",
		session_id: `session-${effortSequence}`,
		last_heartbeat: Date.now(),
	});
	process.env.DECK_EFFORT = effortId;
	process.env.DECK_LEASE_TOKEN = lease.token;
	if (actor === undefined) {
		delete process.env.DECK_ACTOR;
	} else {
		process.env.DECK_ACTOR = actor;
	}
	const harness = new ExtensionHarness();
	registerDeckLifecycle(harness);
	await harness.emit("session_start", { type: "session_start", reason: "startup" });
	return { effortId, harness, lease, store };
}

function requireTool(harness: ExtensionHarness, name: string): DeckTool {
	const tool = harness.tools[name];
	if (tool === undefined) {
		throw new Error(`missing tool ${name}`);
	}
	return tool;
}

async function expectDeckError(
	operation: Promise<unknown>,
	code: DeckErrorCode,
	field?: string,
): Promise<DeckError> {
	try {
		await operation;
		expect.unreachable(`expected ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(core.DeckError);
		if (!(error instanceof core.DeckError)) {
			throw error;
		}
		expect(error.code).toBe(code);
		if (field !== undefined) {
			expect(error.detail.field).toBe(field);
			expect(error.message).toContain(field);
			expect(error.message).toContain("limit");
		}
		return error;
	}
}

function prepareRouterCapability(): void {
	mkdirSync(path.dirname(core.ROUTER_SOCK), { recursive: true, mode: 0o700 });
	const capabilityPath = path.join(TEST_HOME, "router", "control.token");
	mkdirSync(path.dirname(capabilityPath), { recursive: true, mode: 0o700 });
	writeFileSync(capabilityPath, "router-test-cap\n", { mode: 0o600 });
	rmSync(core.ROUTER_SOCK, { force: true });
}

function startFakeRouter(
	response: (request: RouterRequest) => RouterResponse,
) {
	prepareRouterCapability();
	const buffers = new WeakMap<Bun.Socket<undefined>, string>();
	const requestResolvers = Promise.withResolvers<RouterRequest>();
	const server = Bun.listen({
		unix: core.ROUTER_SOCK,
		socket: {
			open(socket) {
				buffers.set(socket, "");
			},
			data(socket, data) {
				const next = `${buffers.get(socket) ?? ""}${data.toString("utf8")}`;
				const newline = next.indexOf("\n");
				if (newline < 0) {
					buffers.set(socket, next);
					return;
				}
				const decoded: unknown = JSON.parse(next.slice(0, newline));
				const request = core.routerRequestSchema.parse(decoded);
				requestResolvers.resolve(request);
				socket.write(`${JSON.stringify(response(request))}\n`);
			},
			error(_socket, error) {
				requestResolvers.reject(error);
			},
		},
	});
	return {
		request: requestResolvers.promise,
		stop(): void {
			server.stop(true);
			rmSync(core.ROUTER_SOCK, { force: true });
		},
	};
}

const toolSignal = new AbortController().signal;
const noUpdate = (): void => {};

void describe("deck lifecycle extension", () => {
	test("is inert when deck owner environment is absent", () => {
		delete process.env.DECK_EFFORT;
		delete process.env.DECK_LEASE_TOKEN;
		const harness = new ExtensionHarness();
		registerDeckLifecycle(harness);
		expect(Object.keys(harness.tools)).toHaveLength(0);
		expect(harness.hooks.session_start).toHaveLength(0);
	});

	test("registers every tool with a one-line prompt snippet", async () => {
		const { harness } = await setupOwner();
		expect(Object.keys(harness.tools).sort()).toEqual([
			"advance_stage",
			"ask_tim",
			"dispatch",
			"park",
			"record_evidence",
			"report_progress",
		]);
		for (const tool of Object.values(harness.tools)) {
			expect(tool.promptSnippet.length).toBeGreaterThan(0);
			expect(tool.promptSnippet).not.toContain("\n");
		}
	});

	test("records progress, a cancellation card, park digest, evidence, and stage", async () => {
		const { harness, store } = await setupOwner();
		const initialRevision = store.readManifest().revision;
		await requireTool(harness, "report_progress").execute(
			"progress-call",
			{ status: "Implementation is verified." },
			toolSignal,
			noUpdate,
			{},
		);
		const afterProgress = store.readManifest();
		expect(afterProgress.revision).toBe(initialRevision + 1);
		expect(new Date(afterProgress.updated).getTime()).toBeGreaterThanOrEqual(new Date(store.readManifest().created).getTime());

		const cardResult = await requireTool(harness, "ask_tim").execute(
			"card-call",
			{
				kind: "cancellation",
				question: "Cancel the running review lane?",
				recommendation: "Cancel it because the branch was replaced.",
				options: ["Cancel", "Keep running"],
				cancel_in_flight: "dispatch-running",
			},
			toolSignal,
			noUpdate,
			{},
		);
		const cardId = cardResult.details.card_id;
		expect(typeof cardId).toBe("string");
		if (typeof cardId !== "string") {
			throw new Error("ask_tim did not return a card id");
		}
		const afterCard = store.readManifest();
		expect(afterCard.cards.at(-1)).toMatchObject({
			id: cardId,
			status: "open",
			cancel_in_flight: "dispatch-running",
		});
		expect(afterCard.overlays.needs_tim).toContain(cardId);

		const parkResult = await requireTool(harness, "park").execute(
			"park-call",
			{ digest: "Tests pass; resume at rollout." },
			toolSignal,
			noUpdate,
			{},
		);
		expect(parkResult.terminate).toBe(true);
		expect(store.readManifest().digest).toBe("Tests pass; resume at rollout.");

		await requireTool(harness, "record_evidence").execute(
			"evidence-call",
			{ label: "CI green", ref: "https://ci.example/run/1", scope: "ci" },
			toolSignal,
			noUpdate,
			{},
		);
		expect(store.readManifest().evidence.at(-1)).toMatchObject({
			label: "CI green",
			ref: "https://ci.example/run/1",
			by: "agent",
			scope: "ci",
		});

		const beforeStage = store.readManifest();
		await requireTool(harness, "advance_stage").execute(
			"stage-call",
			{ to: "active", expected_revision: beforeStage.revision },
			toolSignal,
			noUpdate,
			{},
		);
		expect(store.readManifest().stage).toBe("active");

		const eventTypes = store.readTail().map((event) => event.type);
		for (const eventType of [
			"lifecycle.progress",
			"lifecycle.card",
			"lifecycle.park",
			"lifecycle.evidence",
			"lifecycle.stage",
		]) {
			expect(eventTypes).toContain(eventType);
		}
	});

	test("rejects every concise-field cap before mutation", async () => {
		const cases: Array<{ tool: string; field: string; params: Record<string, unknown> }> = [
			{ tool: "report_progress", field: "status", params: { status: "s".repeat(501) } },
			{
				tool: "ask_tim",
				field: "question",
				params: { kind: "decision", question: "q".repeat(601), recommendation: "r", options: ["yes"] },
			},
			{
				tool: "ask_tim",
				field: "recommendation",
				params: { kind: "decision", question: "q", recommendation: "r".repeat(401), options: ["yes"] },
			},
			{
				tool: "ask_tim",
				field: "options[0]",
				params: { kind: "decision", question: "q", recommendation: "r", options: ["o".repeat(121)] },
			},
			{
				tool: "ask_tim",
				field: "options",
				params: { kind: "decision", question: "q", recommendation: "r", options: ["1", "2", "3", "4", "5", "6"] },
			},
			{ tool: "park", field: "digest", params: { digest: "d".repeat(2001) } },
		];

		for (const capCase of cases) {
			const { harness, store } = await setupOwner();
			const before = store.readManifest();
			await expectDeckError(
				requireTool(harness, capCase.tool).execute("cap-call", capCase.params, toolSignal, noUpdate, {}),
				"E_TOO_LONG",
				capCase.field,
			);
			expect(store.readManifest()).toEqual(before);
		}
	});

	test("fences every tool after the lease becomes stale and warns once", async () => {
		const { harness, store } = await setupOwner();
		const before = store.readManifest();
		store.bumpLease(before.revision, {
			machine: "test-machine",
			session_id: "replacement-session",
			last_heartbeat: Date.now(),
		});
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		expect(harness.messages).toHaveLength(1);
		expect(harness.messages[0]?.content).toContain("E_LEASE");

		const inputs: Record<string, Record<string, unknown>> = {
			report_progress: { status: "stale" },
			ask_tim: { kind: "decision", question: "q", recommendation: "r", options: ["o"] },
			dispatch: { kind: "workflow", target: "wf@v1", brief: "stale" },
			park: { digest: "stale" },
			record_evidence: { label: "stale", ref: "ref", scope: "other" },
			advance_stage: { to: "active", expected_revision: before.revision },
		};
		for (const [name, input] of Object.entries(inputs)) {
			await expectDeckError(
				requireTool(harness, name).execute("stale-call", input, toolSignal, noUpdate, {}),
				"E_LEASE",
			);
		}
		expect(harness.messages).toHaveLength(1);
		const after = store.readManifest();
		expect(after.cards).toEqual(before.cards);
		expect(after.digest).toBe(before.digest);
		expect(after.evidence).toEqual(before.evidence);
	});

	test("dispatches over the authenticated Unix router protocol", async () => {
		const { effortId, harness, lease } = await setupOwner();
		const fixture = startFakeRouter((request) => ({
			ok: true,
			id: request.id,
			data: {
				dispatch_id: "dispatch-live",
				session: {
					machine: "worker-machine",
					session_id: "worker-session",
					lease_epoch: 4,
					last_heartbeat: Date.now(),
				},
			},
		}));
		try {
			const output = await requireTool(harness, "dispatch").execute(
				"dispatch-call",
				{ kind: "workflow", target: "pr-pipeline@v3", brief: "Run CI and review." },
				toolSignal,
				noUpdate,
				{},
			);
			expect(output.details).toMatchObject({
				dispatch_id: "dispatch-live",
				session: { machine: "worker-machine", session_id: "worker-session" },
			});
			const request = await fixture.request;
			expect(request).toMatchObject({
				op: "dispatch",
				cap: "router-test-cap",
				effort_id: effortId,
				lease_token: lease.token,
				kind: "workflow",
				target: "pr-pipeline@v3",
				brief: "Run CI and review.",
			});
		} finally {
			fixture.stop();
		}
	});

	test("passes E_LIVENESS router failures through as tool errors", async () => {
		const { harness } = await setupOwner();
		const fixture = startFakeRouter((request) => ({
			ok: false,
			id: request.id,
			code: "E_LIVENESS",
			error: "worker did not produce its first heartbeat",
		}));
		try {
			await expectDeckError(
				requireTool(harness, "dispatch").execute(
					"dispatch-call",
					{ kind: "subagent", target: "reviewer", brief: "Review the patch." },
					toolSignal,
					noUpdate,
					{},
				),
				"E_LIVENESS",
			);
		} finally {
			fixture.stop();
		}
	});

	test("fast-fails the per-effort dispatch admission limit", async () => {
		const { harness, lease, store } = await setupOwner();
		const current = store.readManifest();
		store.mutate(current.revision, lease.token, (draft) => {
			draft.dispatches.push({
				id: "dispatch-active",
				kind: "subagent",
				target: "reviewer",
				state: "running",
				started: Date.now(),
				session: null,
				result_ref: null,
			});
			return {
				manifest: draft,
				event: {
					plane: "lifecycle",
					type: "lifecycle.dispatch",
					actor: "router",
					data: { dispatch_id: "dispatch-active" },
				},
			};
		});
		const configPath = path.join(TEST_HOME, "config.json");
		writeFileSync(configPath, JSON.stringify({ admission: { maxDispatchesPerEffort: 1 } }), { mode: 0o600 });
		try {
			await expectDeckError(
				requireTool(harness, "dispatch").execute(
					"dispatch-over-limit",
					{ kind: "subagent", target: "reviewer", brief: "Should not reach the router." },
					toolSignal,
					noUpdate,
					{},
				),
				"E_ADMISSION",
			);
		} finally {
			rmSync(configPath, { force: true });
		}
	});

	test("acks a leading command marker on turn end and records token usage", async () => {
		const { harness, store } = await setupOwner();
		store.inboxAppend({
			cmd_id: "cmd-ack-1",
			cmd: { action: "review" },
			from: "tim",
			ts: Date.now(),
		});
		await harness.emit("message_start", {
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: "[deck:cmd cmd-ack-1]\nPlease review now." }],
				timestamp: Date.now(),
			},
		});
		expect(store.inboxState()[0]?.acked).toBeNull();
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 3,
			message: {
				role: "assistant",
				stopReason: "stop",
				usage: { input: 120, output: 30, cacheRead: 40, cacheWrite: 5, totalTokens: 195 },
			},
			toolResults: [],
		});
		expect(store.inboxState()[0]?.acked).not.toBeNull();
		const ack = store.readTail().find((event) => event.type === "lifecycle.ack");
		expect(ack?.data.cmd_id).toBe("cmd-ack-1");
		const turnEnd = store.readTail().find((event) => event.type === "lifecycle.turn_end");
		expect(turnEnd?.data).toMatchObject({
			turn_index: 3,
			token_usage: { input: 120, output: 30, cacheRead: 40, cacheWrite: 5, totalTokens: 195 },
			stop_reason: "stop",
		});
	});

	test("does not ack a command when its turn aborts", async () => {
		const { harness, store } = await setupOwner();
		store.inboxAppend({
			cmd_id: "cmd-aborted",
			cmd: { action: "deploy" },
			from: "tim",
			ts: Date.now(),
		});
		await harness.emit("message_start", {
			type: "message_start",
			message: {
				role: "user",
				content: "[deck:cmd cmd-aborted]\nDeploy after verification.",
				timestamp: Date.now(),
			},
		});
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: {
				role: "assistant",
				stopReason: "aborted",
				usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
			},
			toolResults: [],
		});
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: {
				role: "assistant",
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
			},
			toolResults: [],
		});
		expect(store.inboxState()[0]?.acked).toBeNull();
		expect(store.readTail().filter((event) => event.type === "lifecycle.ack")).toHaveLength(0);
	});

	test("acks only after a failed tool turn is successfully retried", async () => {
		const { harness, store } = await setupOwner();
		store.inboxAppend({
			cmd_id: "cmd-retry",
			cmd: { action: "advance" },
			from: "router",
			ts: Date.now(),
		});
		await harness.emit("message_start", {
			type: "message_start",
			message: {
				role: "user",
				content: "[deck:cmd cmd-retry]\nAdvance the effort.",
				timestamp: Date.now(),
			},
		});
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: {
				role: "assistant",
				stopReason: "toolUse",
				usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 },
			},
			toolResults: [{ isError: true }],
		});
		expect(store.inboxState()[0]?.acked).toBeNull();
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: {
				role: "assistant",
				stopReason: "stop",
				usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4 },
			},
			toolResults: [],
		});
		expect(store.inboxState()[0]?.acked).toBeNull();

		await harness.emit("message_start", {
			type: "message_start",
			message: {
				role: "user",
				content: "[deck:cmd cmd-retry]\nAdvance the effort.",
				timestamp: Date.now(),
			},
		});
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 2,
			message: {
				role: "assistant",
				stopReason: "stop",
				usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4 },
			},
			toolResults: [],
		});
		expect(store.inboxState()[0]?.acked).not.toBeNull();
		expect(store.readTail().filter((event) => event.type === "lifecycle.ack")).toHaveLength(1);
	});

	test("attributes lifecycle events to the router-provided actor", async () => {
		const { harness, store } = await setupOwner("wf:reviewer/dispatch-1");
		await requireTool(harness, "report_progress").execute(
			"worker-progress",
			{ status: "Review complete." },
			toolSignal,
			noUpdate,
			{},
		);
		const progress = store.readTail().find((event) => event.type === "lifecycle.progress");
		expect(progress?.actor).toBe("wf:reviewer/dispatch-1");
	});

	test("surfaces E_EVIDENCE when advancing to done without both gates", async () => {
		const { harness, store } = await setupOwner();
		const before = store.readManifest();
		const error = await expectDeckError(
			requireTool(harness, "advance_stage").execute(
				"done-call",
				{ to: "done", expected_revision: before.revision },
				toolSignal,
				noUpdate,
				{},
			),
			"E_EVIDENCE",
		);
		expect(error.message).toBe("E_EVIDENCE: done requires deploy evidence and a fallout verdict");
		expect(store.readManifest()).toEqual(before);
	});

	test("requires the cancellation dispatch id at the zod boundary", async () => {
		const { harness } = await setupOwner();
		await expectDeckError(
			requireTool(harness, "ask_tim").execute(
				"invalid-card",
				{ kind: "cancellation", question: "Cancel?", recommendation: "Cancel.", options: ["Yes"] },
				toolSignal,
				noUpdate,
				{},
			),
			"E_ARG",
		);
	});
});

afterAll(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
});
