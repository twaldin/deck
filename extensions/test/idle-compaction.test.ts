import assert from "node:assert/strict";
import { describe, test } from "node:test";

const expect = <T>(value: T) => ({
	toBe: (expected: T) => assert.strictEqual(value, expected),
	toEqual: (expected: unknown) => assert.deepStrictEqual(value, expected),
	toBeFalse: () => assert.strictEqual(value, false),
	toBeTrue: () => assert.strictEqual(value, true),
	toBeUndefined: () => assert.strictEqual(value, undefined),
	toHaveLength: (length: number) => assert.strictEqual((value as { length: number }).length, length),
	toMatchObject: (expected: Record<string, unknown>) => {
		assert.deepStrictEqual(
			Object.fromEntries(Object.keys(expected).map((key) => [key, (value as Record<string, unknown>)[key]])),
			Object.fromEntries(Object.keys(expected).map((key) => [key, expected[key]])),
		);
	},
	toContain: (expected: unknown) => assert.ok((value as string).includes(expected as string)),
	toContainEqual: (expected: unknown) => {
		assert.ok((value as unknown[]).some((item) => {
			try {
				assert.deepStrictEqual(item, expected);
				return true;
			} catch {
				return false;
			}
		}));
	},
});
import {
	getContextMarker,
	registerIdleCompaction,
	type IdleCompactionExtensionApi,
	type IdleCompactionRuntime,
} from "../src/idle-compaction.ts";
import {
	DEFAULT_IDLE_COMPACTION_CONFIG,
	decideIdleCompaction,
	idleThresholdMs,
	parseIdleCompactionConfig,
	selectIdleCompactionConfig,
	hasProviderNativeCompaction,
} from "../src/idle-compaction-policy.ts";

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
	readonly sentMessages: Array<{ message: unknown; options: unknown }> = [];
	noIdleCompaction = false;

	on(event: string, handler: Handler): void {
		const handlers = this.hooks.get(event) ?? [];
		handlers.push(handler);
		this.hooks.set(event, handlers);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.appended.push({ customType, data });
	}

	sendMessage(message: unknown, options: unknown): void {
		this.sentMessages.push({ message, options });
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
	// glm-test: an uncalibrated route, so mechanics tests exercise the global
	// test timing instead of a built-in provider profile.
	model = { provider: "deck", id: "glm-test", baseUrl: "http://deck.test/v1" };
	idle = true;
	pending = false;
	tokens: number | null = 120_000;
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
		expect(DEFAULT_IDLE_COMPACTION_CONFIG.keepWarmContextPercent).toBe(50);
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
			contextTokens: 120_000,
			contextWindow: 200_000,
			providerNativeCompactionAvailable: true,
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
		expect(decideIdleCompaction({ ...base, providerNativeCompactionAvailable: false })).toEqual({
			compact: false,
			reason: "provider-native-unavailable",
		});
	});

	test("uses keep-warm only when configured and identifies native routes", () => {
		const base = {
			config: { ...DEFAULT_IDLE_COMPACTION_CONFIG, keepWarm: true },
			nowMs: 240_000,
			lastCacheTouchMs: 0,
			isIdle: true,
			hasPendingMessages: false,
			inFlightToolCalls: 0,
			contextTokens: 40_000,
			contextWindow: 200_000,
			currentContextMarker: "message-2",
			lastCompactedContextMarker: "message-1",
			lastCompactedTokens: 20_000,
			lastCompactedAtMs: null,
			providerNativeCompactionAvailable: false,
		};
		expect(decideIdleCompaction(base)).toEqual({ compact: false, reason: "keep-warm" });
		expect(hasProviderNativeCompaction({ provider: "xai", id: "grok-4" })).toBeFalse();
		expect(hasProviderNativeCompaction({ provider: "deck", id: "grok-4" })).toBeFalse();
		expect(hasProviderNativeCompaction({ provider: "unknown", id: "custom-model" })).toBeFalse();
		expect(hasProviderNativeCompaction({ provider: "deck", id: "claude-sonnet-4-5" })).toBeTrue();
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
			providerNativeCompactionAvailable: true,
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
				contextTokens: 120_000,
				lastCompactedTokens: 118_000,
				providerNativeCompactionAvailable: true,
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
		expect(parsed.config.marginMs).toBe(200);
		expect(parsed.warnings).toEqual([
			"PI_IDLE_COMPACTION_MARGIN_MS must be smaller than PI_IDLE_COMPACTION_TTL_MS; using a safe margin",
		]);
	});

	test("selects calibrated cache deadlines by resolved upstream provider", () => {
		const parsed = parseIdleCompactionConfig({
			PI_IDLE_COMPACTION_OPENAI_TTL_MS: "1000",
			PI_IDLE_COMPACTION_OPENAI_MARGIN_MS: "300",
			PI_IDLE_COMPACTION_ANTHROPIC_TTL_MS: "900",
			PI_IDLE_COMPACTION_ANTHROPIC_MARGIN_MS: "100",
		});
		expect(selectIdleCompactionConfig(parsed, { provider: "deck", id: "claude-test" })).toMatchObject({
			cacheTtlMs: 900,
			marginMs: 100,
		});
		expect(selectIdleCompactionConfig(parsed, { provider: "deck", id: "gpt-test" })).toMatchObject({
			cacheTtlMs: 1_000,
			marginMs: 300,
		});
		expect(selectIdleCompactionConfig(parsed, { provider: "deck", id: "glm-test" })).toBe(parsed.config);
	});

	test("gives grok/xai routes a built-in short cache profile with env override", () => {
		const parsed = parseIdleCompactionConfig({});
		const xai = { cacheTtlMs: 120_000, marginMs: 30_000 };
		expect(selectIdleCompactionConfig(parsed, { provider: "xai", id: "grok-4-fast" })).toMatchObject(xai);
		expect(selectIdleCompactionConfig(parsed, { provider: "xai-oauth", id: "custom-id" })).toMatchObject(xai);
		expect(selectIdleCompactionConfig(parsed, { provider: "deck", id: "xai/grok-code-fast-1" })).toMatchObject(xai);
		expect(selectIdleCompactionConfig(parsed, { provider: "deck", id: "glm-test" })).toBe(parsed.config);

		const overridden = parseIdleCompactionConfig({
			PI_IDLE_COMPACTION_XAI_TTL_MS: "60000",
			PI_IDLE_COMPACTION_XAI_MARGIN_MS: "10000",
			PI_IDLE_COMPACTION_ANTHROPIC_TTL_MS: "900",
			PI_IDLE_COMPACTION_ANTHROPIC_MARGIN_MS: "100",
		});
		expect(selectIdleCompactionConfig(overridden, { provider: "deck", id: "grok-test" })).toMatchObject({
			cacheTtlMs: 60_000,
			marginMs: 10_000,
		});
		expect(selectIdleCompactionConfig(overridden, { provider: "anthropic", id: "claude-test" })).toMatchObject({
			cacheTtlMs: 900,
			marginMs: 100,
		});
	});

	test("compacts after the xai idle threshold, well before the global one", () => {
		const config = selectIdleCompactionConfig(parseIdleCompactionConfig({}), {
			provider: "deck",
			id: "grok-4-fast",
		});
		expect(idleThresholdMs(config)).toBe(90_000);
		const input = {
			config,
			nowMs: 90_000,
			lastCacheTouchMs: 0,
			isIdle: true,
			hasPendingMessages: false,
			inFlightToolCalls: 0,
			contextTokens: 100_000,
			contextWindow: 200_000,
			currentContextMarker: "m1",
			lastCompactedContextMarker: null,
			lastCompactedTokens: null,
			lastCompactedAtMs: null,
		};
		expect(decideIdleCompaction(input)).toMatchObject({ compact: true, idleForMs: 90_000 });
		expect(decideIdleCompaction({ ...input, nowMs: 89_999 })).toMatchObject({
			compact: false,
			reason: "cache-still-fresh",
		});
	});

	test("rejects incomplete and invalid provider timing profiles", () => {
		const incomplete = parseIdleCompactionConfig({ PI_IDLE_COMPACTION_OPENAI_TTL_MS: "1000" });
		expect(incomplete.providerConfigs.openai).toBeUndefined();
		expect(incomplete.warnings).toEqual([
			"PI_IDLE_COMPACTION_OPENAI_TTL_MS/PI_IDLE_COMPACTION_OPENAI_MARGIN_MS must both be set; ignoring the incomplete provider profile",
		]);

		const invalid = parseIdleCompactionConfig({
			PI_IDLE_COMPACTION_TTL_MS: "600000",
			PI_IDLE_COMPACTION_OPENAI_TTL_MS: "5min",
			PI_IDLE_COMPACTION_OPENAI_MARGIN_MS: "30000",
		});
		expect(invalid.providerConfigs.openai).toBeUndefined();
		expect(selectIdleCompactionConfig(invalid, { provider: "deck", id: "gpt-test" })).toMatchObject({
			cacheTtlMs: 600_000,
			marginMs: 60_000,
		});
	});

	test("lets a provider profile override the legacy global timing", () => {
		const parsed = parseIdleCompactionConfig({
			PI_IDLE_COMPACTION_TTL_MS: "1000",
			PI_IDLE_COMPACTION_MARGIN_MS: "200",
			PI_IDLE_COMPACTION_ANTHROPIC_TTL_MS: "900",
			PI_IDLE_COMPACTION_ANTHROPIC_MARGIN_MS: "100",
		});
		expect(selectIdleCompactionConfig(parsed, { provider: "anthropic", id: "claude-test" })).toMatchObject({
			cacheTtlMs: 900,
			marginMs: 100,
		});
		// No OPENAI env pair and no 5.6+ model: the global timing applies.
		expect(selectIdleCompactionConfig(parsed, { provider: "openai", id: "gpt-test" })).toMatchObject({
			cacheTtlMs: 1_000,
			marginMs: 200,
		});
	});

	test("enables keep-warm for long cache routes", () => {
		const parsed = parseIdleCompactionConfig({});
		expect(selectIdleCompactionConfig(parsed, { provider: "deck", id: "claude-sonnet-4-5" }).keepWarm).toBeTrue();
		expect(selectIdleCompactionConfig(parsed, { provider: "deck", id: "gpt-5.6-sol" }).keepWarm).toBeTrue();
		expect(parsed.config.keepWarm).toBeFalse();
	});

	test("gives deck claude routes the broker's 1h retention and GPT-5.6+ the 30m minimum", () => {
		const parsed = parseIdleCompactionConfig({});
		// deck claude-*: the broker's pi-ai layer requests ttl "1h" on oauth.
		expect(selectIdleCompactionConfig(parsed, { provider: "deck", id: "claude-sonnet-4-5" })).toMatchObject({
			cacheTtlMs: 3_600_000,
			marginMs: 300_000,
		});
		// direct anthropic: plain 5m ephemeral unless the operator opts into long
		// retention, so the global timing stands.
		expect(selectIdleCompactionConfig(parsed, { provider: "anthropic", id: "claude-sonnet-4-5" })).toBe(
			parsed.config,
		);
		// GPT-5.6+ carries the documented 30m minimum on any route.
		expect(selectIdleCompactionConfig(parsed, { provider: "deck", id: "gpt-5.6-sol" })).toMatchObject({
			cacheTtlMs: 1_800_000,
			marginMs: 300_000,
		});
		expect(selectIdleCompactionConfig(parsed, { provider: "openai", id: "gpt-6" })).toMatchObject({
			cacheTtlMs: 1_800_000,
		});
		expect(
			idleThresholdMs(selectIdleCompactionConfig(parsed, { provider: "openai-codex", id: "gpt-5.6-sol" })),
		).toBe(25 * 60_000);
		// Older gpt-* stay on the conservative global timing.
		expect(selectIdleCompactionConfig(parsed, { provider: "openai", id: "gpt-5.1" })).toBe(parsed.config);
		expect(selectIdleCompactionConfig(parsed, { provider: "deck", id: "glm-test" })).toBe(parsed.config);
	});

	test("env pair overrides the built-in long profile back to 5m ephemeral", () => {
		const parsed = parseIdleCompactionConfig({
			PI_IDLE_COMPACTION_ANTHROPIC_TTL_MS: "300000",
			PI_IDLE_COMPACTION_ANTHROPIC_MARGIN_MS: "60000",
		});
		expect(selectIdleCompactionConfig(parsed, { provider: "deck", id: "claude-test" })).toMatchObject({
			cacheTtlMs: 300_000,
			marginMs: 60_000,
		});
		expect(selectIdleCompactionConfig(parsed, { provider: "anthropic", id: "claude-test" })).toMatchObject({
			cacheTtlMs: 300_000,
			marginMs: 60_000,
		});
	});

	test("recognizes direct and provider-qualified model routes", () => {
		const parsed = parseIdleCompactionConfig({
			PI_IDLE_COMPACTION_ANTHROPIC_TTL_MS: "900",
			PI_IDLE_COMPACTION_ANTHROPIC_MARGIN_MS: "100",
			PI_IDLE_COMPACTION_OPENAI_TTL_MS: "1000",
			PI_IDLE_COMPACTION_OPENAI_MARGIN_MS: "300",
		});
		expect(
			selectIdleCompactionConfig(parsed, { provider: "deck", id: "anthropic/claude-opus-5" }),
		).toMatchObject({ cacheTtlMs: 900 });
		expect(
			selectIdleCompactionConfig(parsed, { provider: "deck", id: "openai-codex/gpt-5.6-sol" }),
		).toMatchObject({ cacheTtlMs: 1_000 });
		expect(selectIdleCompactionConfig(parsed, { provider: "anthropic", id: "custom-id" })).toMatchObject({
			cacheTtlMs: 900,
		});
	});

	test("caps the default cooldown at a profile deadline without overriding an explicit operator interval", () => {
		const defaultInterval = parseIdleCompactionConfig({
			PI_IDLE_COMPACTION_TTL_MS: "120000",
			PI_IDLE_COMPACTION_MARGIN_MS: "60000",
		});
		expect(defaultInterval.config.minimumCompactionIntervalMs).toBe(60_000);

		const explicitInterval = parseIdleCompactionConfig({
			PI_IDLE_COMPACTION_TTL_MS: "120000",
			PI_IDLE_COMPACTION_MARGIN_MS: "60000",
			PI_IDLE_COMPACTION_MIN_INTERVAL_MS: "90000",
		});
		expect(explicitInterval.config.minimumCompactionIntervalMs).toBe(90_000);

		const provider = parseIdleCompactionConfig({
			PI_IDLE_COMPACTION_OPENAI_TTL_MS: "1000",
			PI_IDLE_COMPACTION_OPENAI_MARGIN_MS: "1000",
		});
		expect(provider.providerConfigs.openai).toMatchObject({
			marginMs: 200,
			minimumCompactionIntervalMs: 800,
		});
		expect(provider.warnings).toEqual([
			"PI_IDLE_COMPACTION_OPENAI_MARGIN_MS must be smaller than PI_IDLE_COMPACTION_OPENAI_TTL_MS; using a safe margin",
		]);
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
		// Assert the identifiers a cold resume cannot reconstruct, not the prose:
		// an agent that wakes without its run receipt starts a second run of work
		// already executing, and one without its pending decision asks twice.
		const instructions = context.compactCalls[0]?.customInstructions ?? "";
		expect(instructions).toContain("task id");
		expect(instructions).toContain("run receipts");
		expect(instructions).toContain("pending decision");
	});

	test("sends a tiny keep-warm turn for a long route below the compaction threshold", async () => {
		const { runtime, harness, context } = setup({
			PI_IDLE_COMPACTION_ANTHROPIC_TTL_MS: "1000",
			PI_IDLE_COMPACTION_ANTHROPIC_MARGIN_MS: "200",
		});
		context.model = { provider: "deck", id: "claude-sonnet-4-5", baseUrl: "http://deck.test/v1" };
		context.tokens = 40_000;
		await harness.emit("session_start", context);
		await warmAndSettle(harness, context);
		runtime.advance(800);
		expect(harness.sentMessages).toHaveLength(1);
		expect(context.compactCalls).toHaveLength(0);
		expect(harness.sentMessages[0]?.message).toMatchObject({
			customType: "deck.idle-keepwarm.v1",
			content: "Reply with exactly idle. Do not call tools.",
			display: false,
		});
		expect(harness.sentMessages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
	});

	test("falls back to compaction for a long route with a large context", async () => {
		const { runtime, harness, context } = setup({
			PI_IDLE_COMPACTION_ANTHROPIC_TTL_MS: "1000",
			PI_IDLE_COMPACTION_ANTHROPIC_MARGIN_MS: "200",
		});
		context.model = { provider: "deck", id: "claude-sonnet-4-5", baseUrl: "http://deck.test/v1" };
		context.tokens = 160_000;
		await harness.emit("session_start", context);
		await warmAndSettle(harness, context);
		runtime.advance(800);
		expect(harness.sentMessages).toHaveLength(0);
		expect(context.compactCalls).toHaveLength(1);
	});

	test("uses the OpenAI profile deadline for a deck OpenAI route", async () => {
		const { runtime, harness, context } = setup({
			PI_IDLE_COMPACTION_OPENAI_TTL_MS: "1000",
			PI_IDLE_COMPACTION_OPENAI_MARGIN_MS: "300",
		});
		context.model = { provider: "deck", id: "gpt-test", baseUrl: "http://deck.test/v1" };
		await harness.emit("session_start", context);
		await warmAndSettle(harness, context);
		runtime.advance(699);
		expect(context.compactCalls).toHaveLength(0);
		runtime.advance(1);
		expect(context.compactCalls).toHaveLength(1);
	});

	test("retains the legacy global deadline for an uncalibrated provider route", async () => {
		const { runtime, harness, context } = setup();
		context.model = { provider: "deck", id: "glm-test", baseUrl: "http://deck.test/v1" };
		await harness.emit("session_start", context);
		await warmAndSettle(harness, context);
		runtime.advance(799);
		expect(context.compactCalls).toHaveLength(0);
		runtime.advance(1);
		expect(context.compactCalls).toHaveLength(1);
	});

	test("uses the newly selected model family's deadline", async () => {
		const { runtime, harness, context } = setup({
			PI_IDLE_COMPACTION_ANTHROPIC_TTL_MS: "1000",
			PI_IDLE_COMPACTION_ANTHROPIC_MARGIN_MS: "300",
			PI_IDLE_COMPACTION_OPENAI_TTL_MS: "1000",
			PI_IDLE_COMPACTION_OPENAI_MARGIN_MS: "100",
		});
		await harness.emit("session_start", context);
		await warmAndSettle(harness, context);
		context.model = { provider: "deck", id: "gpt-test", baseUrl: "http://deck.test/v1" };
		await harness.emit("model_select", context);
		await warmAndSettle(harness, context);
		runtime.advance(899);
		expect(context.compactCalls).toHaveLength(0);
		runtime.advance(1);
		expect(context.compactCalls).toHaveLength(1);
	});

	test("reports configuration warnings regardless of the model family", async () => {
		const { harness, context } = setup({
			PI_IDLE_COMPACTION_NOTIFY: "1",
			PI_IDLE_COMPACTION_OPENAI_TTL_MS: "invalid",
			PI_IDLE_COMPACTION_OPENAI_MARGIN_MS: "100",
		});
		context.model = { provider: "deck", id: "glm-test", baseUrl: "http://deck.test/v1" };
		await harness.emit("session_start", context);
		expect(context.notifications).toContainEqual({
			message:
				"Idle compaction: PI_IDLE_COMPACTION_OPENAI_TTL_MS/PI_IDLE_COMPACTION_OPENAI_MARGIN_MS must be valid timing values; ignoring the provider profile",
			level: "warning",
		});
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

	test("re-arms the idle timer when a long tool ends after the deadline", async () => {
		const { runtime, harness, context } = setup();
		await harness.emit("session_start", context);
		await warmAndSettle(harness, context);
		runtime.advance(700);
		await harness.emit("tool_execution_start", context);
		context.idle = false;
		runtime.advance(500);
		context.idle = true;
		await harness.emit("tool_execution_end", context);
		runtime.advance(0);
		expect(context.compactCalls).toHaveLength(1);
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
		context.tokens = 120_000;
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

		context.tokens = 120_000;
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
