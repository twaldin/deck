import { describe, expect, test } from "bun:test";
import {
	getContextMarker,
	registerIdleCompaction,
	type IdleCompactionExtensionApi,
	type IdleCompactionRuntime,
} from "../src/idle-compaction";
import {
	DEFAULT_IDLE_COMPACTION_CONFIG,
	decideIdleCompaction,
	idleThresholdMs,
	parseIdleCompactionConfig,
} from "../src/idle-compaction-policy";

class FakeRuntime implements IdleCompactionRuntime {
	currentTime = 0;
	firedTimers = 0;
	private nextId = 1;
	private timers = new Map<number, { at: number; callback: () => void }>();

	now = (): number => this.currentTime;

	setTimer = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
		const id = this.nextId++;
		this.timers.set(id, { at: this.currentTime + Math.max(0, delayMs), callback });
		return id as unknown as ReturnType<typeof setTimeout>;
	};

	clearTimer = (handle: ReturnType<typeof setTimeout>): void => {
		this.timers.delete(handle as unknown as number);
	};

	advance(ms: number): void {
		const target = this.currentTime + ms;
		while (true) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
			if (due === undefined) break;
			const [id, timer] = due;
			this.timers.delete(id);
			this.currentTime = timer.at;
			this.firedTimers += 1;
			timer.callback();
		}
		this.currentTime = target;
	}
}

type Handler = (event: any, context: TestContext) => Promise<void> | void;

class ExtensionHarness implements IdleCompactionExtensionApi {
	readonly hooks = new Map<string, Handler[]>();
	readonly appended: Array<{ customType: string; data: unknown }> = [];
	noIdleCompaction = false;

	on(event: string, handler: Handler): void {
		const handlers = this.hooks.get(event) ?? [];
		handlers.push(handler);
		this.hooks.set(event, handlers);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.appended.push({ customType, data });
	}

	registerFlag(): void {}
	getFlag(name: string): boolean | undefined {
		return name === "no-idle-compaction" ? this.noIdleCompaction : undefined;
	}

	async emit(event: string, context: TestContext, payload: any = { type: event }): Promise<void> {
		for (const handler of this.hooks.get(event) ?? []) await handler(payload, context);
	}
}

class TestContext {
	hasUI = true;
	model = { provider: "deck", id: "model-a", baseUrl: "http://deck.test/v1" };
	idle = true;
	pending = false;
	tokens: number | null = 80_000;
	contextWindow = 200_000;
	entries: Array<{ type: string; id?: string; customType?: string; data?: unknown }> = [
		{ type: "message", id: "message-1" },
	];
	readonly notifications: Array<{ message: string; level?: string }> = [];
	readonly compactCalls: Array<{
		customInstructions?: string;
		onComplete?: (result: { tokensBefore: number; estimatedTokensAfter: number }) => void;
		onError?: (error: Error) => void;
	}> = [];

	ui = {
		notify: (message: string, level?: "info" | "warning" | "error"): void => {
			this.notifications.push({ message, level });
		},
	};

	sessionManager = {
		getBranch: () => this.entries,
		getLeafId: () => this.entries.at(-1)?.id ?? null,
	};

	isIdle = (): boolean => this.idle;
	hasPendingMessages = (): boolean => this.pending;
	getContextUsage = () => ({ tokens: this.tokens, contextWindow: this.contextWindow });
	compact = (options: (typeof this.compactCalls)[number]): void => {
		this.compactCalls.push(options);
	};

	completeCompaction(tokensBefore = 80_000, estimatedTokensAfter = 20_000): void {
		this.entries.push({ type: "compaction", id: `compaction-${this.compactCalls.length}` });
		this.compactCalls.at(-1)?.onComplete?.({ tokensBefore, estimatedTokensAfter });
		this.tokens = estimatedTokensAfter;
	}
}

function setup(env: Record<string, string | undefined> = {}) {
	const runtime = new FakeRuntime();
	const harness = new ExtensionHarness();
	const context = new TestContext();
	registerIdleCompaction(
		harness,
		{
			PI_IDLE_COMPACTION_TTL_MS: "1000",
			PI_IDLE_COMPACTION_MARGIN_MS: "200",
			PI_IDLE_COMPACTION_RETRY_MS: "100",
			PI_IDLE_COMPACTION_NOTIFY: "0",
			...env,
		},
		runtime,
	);
	return { runtime, harness, context };
}

async function warmAndSettle(harness: ExtensionHarness, context: TestContext): Promise<void> {
	await harness.emit("after_provider_response", context, {
		type: "after_provider_response",
		status: 200,
	});
	await harness.emit("turn_end", context, {
		type: "turn_end",
		message: { role: "assistant", stopReason: "stop" },
	});
	await harness.emit("agent_settled", context);
}

describe("idle compaction policy", () => {
	test("defaults to the warm-cache deadline and a 30% context floor", () => {
		expect(idleThresholdMs({ ...DEFAULT_IDLE_COMPACTION_CONFIG })).toBe(240_000);
		expect(DEFAULT_IDLE_COMPACTION_CONFIG.contextFloorPercent).toBe(30);
		expect(DEFAULT_IDLE_COMPACTION_CONFIG.engine).toBe("client");
	});

	test("requires idle, no tools or pending messages, elapsed TTL-minus-margin, and floor usage", () => {
		const base = {
			config: { ...DEFAULT_IDLE_COMPACTION_CONFIG },
			nowMs: 240_000,
			lastCacheTouchMs: 0,
			isIdle: true,
			hasPendingMessages: false,
			inFlightToolCalls: 0,
			contextTokens: 60_000,
			contextWindow: 200_000,
			currentContextMarker: "message-2",
			lastCompactedContextMarker: "message-1",
			lastCompactedTokens: 20_000,
			lastCompactedAtMs: null,
		};
		expect(decideIdleCompaction(base)).toMatchObject({ compact: true, floorTokens: 60_000 });
		expect(decideIdleCompaction({ ...base, isIdle: false })).toEqual({
			compact: false,
			reason: "busy",
		});
		expect(decideIdleCompaction({ ...base, inFlightToolCalls: 1 })).toEqual({
			compact: false,
			reason: "busy",
		});
		expect(decideIdleCompaction({ ...base, hasPendingMessages: true })).toEqual({
			compact: false,
			reason: "busy",
		});
		expect(decideIdleCompaction({ ...base, nowMs: 239_999 })).toEqual({
			compact: false,
			reason: "cache-still-fresh",
			waitMs: 1,
		});
		expect(decideIdleCompaction({ ...base, contextTokens: 59_999 })).toEqual({
			compact: false,
			reason: "below-context-floor",
		});
	});

	test("enforces cooldown and window-relative growth before re-compacting", () => {
		const base = {
			config: { ...DEFAULT_IDLE_COMPACTION_CONFIG },
			nowMs: 500_000,
			lastCacheTouchMs: 0,
			isIdle: true,
			hasPendingMessages: false,
			inFlightToolCalls: 0,
			contextTokens: 25_000,
			contextWindow: 200_000,
			currentContextMarker: "message-2",
			lastCompactedContextMarker: "compaction-1",
			lastCompactedTokens: 20_000,
			lastCompactedAtMs: 400_000,
		};
		expect(decideIdleCompaction(base)).toMatchObject({ compact: false, reason: "cooldown" });
		expect(
			decideIdleCompaction({ ...base, lastCompactedAtMs: 0 }),
		).toEqual({ compact: false, reason: "below-context-floor" });
		expect(
			decideIdleCompaction({
				...base,
				lastCompactedAtMs: 0,
				contextTokens: 65_000,
				lastCompactedTokens: 58_000,
			}),
		).toEqual({ compact: false, reason: "no-context-growth" });
	});

	test("does not recompact an unchanged context, even when token usage is unavailable", () => {
		const decision = decideIdleCompaction({
			config: { ...DEFAULT_IDLE_COMPACTION_CONFIG },
			nowMs: 300_000,
			lastCacheTouchMs: 0,
			isIdle: true,
			hasPendingMessages: false,
			inFlightToolCalls: 0,
			contextTokens: null,
			contextWindow: 200_000,
			currentContextMarker: "compaction-1",
			lastCompactedContextMarker: "compaction-1",
			lastCompactedTokens: null,
			lastCompactedAtMs: null,
		});
		expect(decision).toEqual({ compact: false, reason: "no-context-growth" });
	});

	test("parses opt-out and rejects invalid timing", () => {
		const parsed = parseIdleCompactionConfig({
			PI_IDLE_COMPACTION: "off",
			PI_IDLE_COMPACTION_TTL_MS: "1000",
			PI_IDLE_COMPACTION_MARGIN_MS: "1000",
			PI_IDLE_COMPACTION_ENGINE: "native",
		});
		expect(parsed.config.enabled).toBeFalse();
		expect(parsed.config.engine).toBe("native");
		expect(parsed.config.marginMs).toBe(999);
		expect(parsed.warnings).toHaveLength(1);
	});
});

describe("idle compaction extension", () => {
	test("does not arm until a provider response warmed the cache", async () => {
		const { runtime, harness, context } = setup();
		await harness.emit("session_start", context);
		runtime.advance(10_000);
		expect(context.compactCalls).toHaveLength(0);
	});

	test("fires exactly at TTL-minus-margin via the sanctioned context API", async () => {
		const { runtime, harness, context } = setup();
		await harness.emit("session_start", context);
		await warmAndSettle(harness, context);
		runtime.advance(799);
		expect(context.compactCalls).toHaveLength(0);
		runtime.advance(1);
		expect(context.compactCalls).toHaveLength(1);
		expect(context.compactCalls[0]?.customInstructions).toContain("parked");
	});

	test("uses the latest provider response as cache-touch time", async () => {
		const { runtime, harness, context } = setup();
		await harness.emit("session_start", context);
		await warmAndSettle(harness, context);
		runtime.advance(600);
		await warmAndSettle(harness, context);
		runtime.advance(799);
		expect(context.compactCalls).toHaveLength(0);
		runtime.advance(1);
		expect(context.compactCalls).toHaveLength(1);
	});

	test("does not reuse stale cache warmth after a failed provider request", async () => {
		const { runtime, harness, context } = setup();
		await harness.emit("session_start", context);
		await warmAndSettle(harness, context);
		runtime.advance(100);

		await harness.emit("before_agent_start", context);
		await harness.emit("agent_start", context);
		context.entries.push({ type: "message", id: "failed-turn" });
		await harness.emit("before_provider_request", context);
		await harness.emit("after_provider_response", context, {
			type: "after_provider_response",
			status: 500,
		});
		await harness.emit("agent_settled", context);
		runtime.advance(10_000);
		expect(context.compactCalls).toHaveLength(0);
	});

	test("does not promote a 2xx response whose stream ends aborted", async () => {
		const { runtime, harness, context } = setup();
		await harness.emit("session_start", context);
		await harness.emit("before_agent_start", context);
		await harness.emit("agent_start", context);
		await harness.emit("before_provider_request", context);
		await harness.emit("after_provider_response", context, {
			type: "after_provider_response",
			status: 200,
		});
		await harness.emit("turn_end", context, {
			type: "turn_end",
			message: { role: "assistant", stopReason: "aborted" },
		});
		await harness.emit("agent_settled", context);
		runtime.advance(10_000);
		expect(context.compactCalls).toHaveLength(0);
	});

	test("model changes invalidate cache warmth and its timer", async () => {
		const { runtime, harness, context } = setup();
		await harness.emit("session_start", context);
		await warmAndSettle(harness, context);
		runtime.advance(700);
		context.model = { provider: "deck", id: "model-b", baseUrl: "http://deck.test/v1" };
		await harness.emit("model_select", context);
		runtime.advance(10_000);
		expect(context.compactCalls).toHaveLength(0);
	});

	test("never compacts during streaming, pending messages, or in-flight tools", async () => {
		const streaming = setup();
		await streaming.harness.emit("session_start", streaming.context);
		await warmAndSettle(streaming.harness, streaming.context);
		streaming.context.idle = false;
		streaming.runtime.advance(800);
		expect(streaming.context.compactCalls).toHaveLength(0);

		const pending = setup();
		pending.context.pending = true;
		await pending.harness.emit("session_start", pending.context);
		await warmAndSettle(pending.harness, pending.context);
		pending.runtime.advance(800);
		expect(pending.context.compactCalls).toHaveLength(0);

		const tools = setup();
		await tools.harness.emit("session_start", tools.context);
		await warmAndSettle(tools.harness, tools.context);
		tools.runtime.advance(700);
		await tools.harness.emit("tool_execution_start", tools.context);
		tools.runtime.advance(100);
		expect(tools.context.compactCalls).toHaveLength(0);
		await tools.harness.emit("tool_execution_end", tools.context);
		await tools.harness.emit("agent_settled", tools.context);
		tools.runtime.advance(0);
		expect(tools.context.compactCalls).toHaveLength(1);
	});

	test("does not fight pi auto-compaction or repeat without context growth", async () => {
		const { runtime, harness, context } = setup({
			PI_IDLE_COMPACTION_MIN_INTERVAL_MS: "0",
		});
		await harness.emit("session_start", context);
		await warmAndSettle(harness, context);
		runtime.advance(800);
		context.completeCompaction();
		expect(context.compactCalls).toHaveLength(1);
		expect(harness.appended.at(-1)?.customType).toBe("deck.idle-compaction.v1");

		await harness.emit("agent_settled", context);
		runtime.advance(0);
		expect(context.compactCalls).toHaveLength(1);

		context.entries.push({ type: "message", id: "message-2" });
		context.tokens = 80_000;
		await warmAndSettle(harness, context);
		runtime.advance(800);
		expect(context.compactCalls).toHaveLength(2);

		context.entries.push({ type: "compaction", id: "pi-auto-compaction" });
		await harness.emit("session_compact", context, {
			type: "session_compact",
			compactionEntry: { id: "pi-auto-compaction" },
			reason: "threshold",
		});
		await harness.emit("agent_settled", context);
		runtime.advance(10_000);
		expect(context.compactCalls).toHaveLength(2);
	});

	test("an external compaction suppresses the idle timer", async () => {
		const { runtime, harness, context } = setup();
		await harness.emit("session_start", context);
		await warmAndSettle(harness, context);
		runtime.advance(700);
		await harness.emit("session_before_compact", context);
		runtime.advance(1_000);
		expect(context.compactCalls).toHaveLength(0);
	});

	test("caps usage-unknown retries for an unchanged parked context", async () => {
		const { runtime, harness, context } = setup({
			PI_IDLE_COMPACTION_MAX_RETRIES: "2",
		});
		context.tokens = null;
		await harness.emit("session_start", context);
		await warmAndSettle(harness, context);
		runtime.advance(800 + 100 + 200 + 10_000);
		expect(context.compactCalls).toHaveLength(0);
		expect(runtime.firedTimers).toBe(3);

		context.tokens = 80_000;
		context.entries.push({ type: "message", id: "new-context" });
		await warmAndSettle(harness, context);
		runtime.advance(800);
		expect(context.compactCalls).toHaveLength(1);
	});

	test("caps compaction-error retries with exponential backoff until context changes", async () => {
		const { runtime, harness, context } = setup({
			PI_IDLE_COMPACTION_MAX_RETRIES: "2",
		});
		await harness.emit("session_start", context);
		await warmAndSettle(harness, context);
		runtime.advance(800);
		expect(context.compactCalls).toHaveLength(1);
		context.compactCalls.at(-1)?.onError?.(new Error("auth failed"));
		runtime.advance(100);
		expect(context.compactCalls).toHaveLength(2);
		context.compactCalls.at(-1)?.onError?.(new Error("auth failed"));
		runtime.advance(200);
		expect(context.compactCalls).toHaveLength(3);
		context.compactCalls.at(-1)?.onError?.(new Error("auth failed"));
		runtime.advance(10_000);
		expect(context.compactCalls).toHaveLength(3);
	});

	test("restores repeat suppression from persisted and bare compaction entries", async () => {
		for (const entries of [
			[
				{ type: "compaction", id: "compaction-1" },
				{
					type: "custom",
					id: "state-1",
					customType: "deck.idle-compaction.v1",
					data: { contextMarker: "compaction-1", contextTokens: 20_000, compactedAt: 1 },
				},
			],
			[{ type: "compaction", id: "compaction-1" }],
		]) {
			const { runtime, harness, context } = setup();
			context.entries = entries;
			await harness.emit("session_start", context);
			await warmAndSettle(harness, context);
			runtime.advance(10_000);
			expect(context.compactCalls).toHaveLength(0);
		}
	});

	test("session flag, env opt-out, and shutdown all cancel work", async () => {
		const flagged = setup();
		flagged.harness.noIdleCompaction = true;
		await flagged.harness.emit("session_start", flagged.context);
		await warmAndSettle(flagged.harness, flagged.context);
		flagged.runtime.advance(2_000);
		expect(flagged.context.compactCalls).toHaveLength(0);

		const headless = setup({ PI_IDLE_COMPACTION_NOTIFY: "1" });
		headless.context.hasUI = false;
		await headless.harness.emit("session_start", headless.context);
		await warmAndSettle(headless.harness, headless.context);
		headless.runtime.advance(800);
		expect(headless.context.notifications).toHaveLength(0);

		const enabled = setup();
		await enabled.harness.emit("session_start", enabled.context);
		await warmAndSettle(enabled.harness, enabled.context);
		await enabled.harness.emit("session_shutdown", enabled.context);
		enabled.runtime.advance(2_000);
		expect(enabled.context.compactCalls).toHaveLength(0);

		const disabled = setup({ PI_IDLE_COMPACTION: "0" });
		await disabled.harness.emit("session_start", disabled.context);
		disabled.runtime.advance(2_000);
		expect(disabled.context.compactCalls).toHaveLength(0);
	});

	test("native engine is an explicit inert seam until broker support exists", async () => {
		const { runtime, harness, context } = setup({
			PI_IDLE_COMPACTION_ENGINE: "native",
			PI_IDLE_COMPACTION_NOTIFY: "1",
		});
		await harness.emit("session_start", context);
		runtime.advance(2_000);
		expect(context.compactCalls).toHaveLength(0);
		expect(context.notifications[0]?.message).toContain("unsupported");
	});

	test("finds a context marker without treating extension state as growth", () => {
		const context = new TestContext();
		context.entries.push({
			type: "custom",
			id: "state-1",
			customType: "deck.idle-compaction.v1",
		});
		expect(getContextMarker(context.sessionManager)).toBe("message-1");
	});
});
