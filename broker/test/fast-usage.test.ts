import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	FAST_USAGE_WINDOW_MS,
	FastUsageMonitor,
	FastUsageResponseObserver,
	extractTokenUsage,
	fastCreditMultiplier,
	parseFastUsageTarget,
	summarizeFastUsage,
} from "../src/fast-usage";
import { buildModelIndex } from "../src/models";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
});

describe("fast usage attribution", () => {
	test("maps only the ChatGPT Fast model set to the documented credit rates", () => {
		expect(fastCreditMultiplier("openai-codex", "gpt-5.4")).toBe(2);
		expect(fastCreditMultiplier("openai-codex", "gpt-5.5")).toBe(2.5);
		expect(fastCreditMultiplier("openai-codex", "gpt-5.6-sol:fast")).toBe(2.5);
		expect(fastCreditMultiplier("openai-codex", "gpt-5.4-mini")).toBeUndefined();
		expect(fastCreditMultiplier("openai-codex", "gpt-5.3-codex-spark")).toBeUndefined();
		expect(fastCreditMultiplier("anthropic", "claude-opus-5")).toBeUndefined();
		expect(fastCreditMultiplier("openai", "gpt-5.6")).toBeUndefined();
	});

	test("extracts OpenAI chat and Responses token usage", () => {
		expect(extractTokenUsage({
			usage: {
				prompt_tokens: 100,
				completion_tokens: 20,
				prompt_tokens_details: { cached_tokens: 40 },
			},
		})).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0 });
		expect(extractTokenUsage({
			usage: {
				input_tokens: 200,
				output_tokens: 30,
				input_tokens_details: { cached_tokens: 50 },
			},
		})).toEqual({ inputTokens: 200, outputTokens: 30, cacheReadTokens: 50, cacheWriteTokens: 0 });
	});

	test("computes a trailing seven-day standard-cost-weighted share and warning", () => {
		const now = Date.parse("2026-08-06T12:00:00.000Z");
		const summary = summarizeFastUsage([
			{ recordedAt: now - 1_000, provider: "openai-codex", accountKey: "a", model: "gpt-5.6-sol", serviceTier: "priority", costUsd: 3 },
			{ recordedAt: now - 2_000, provider: "anthropic", accountKey: "b", model: "claude-haiku-4-5", serviceTier: "default", costUsd: 7 },
			{ recordedAt: now - FAST_USAGE_WINDOW_MS - 1, provider: "openai-codex", accountKey: "a", model: "gpt-5.6-sol", serviceTier: "priority", costUsd: 100 },
			// Pre-attribution history has no tier and must not skew the denominator.
			{ recordedAt: now - 3_000, provider: "openai-codex", accountKey: "legacy", costUsd: 100 },
		], now, 0.25);
		expect(summary.fastFraction).toBe(0.3);
		expect(summary.fastRequests).toBe(1);
		expect(summary.totalRequests).toBe(2);
		expect(summary.multipliers).toEqual([2.5]);
		expect(summary.exceedsTarget).toBe(true);
		expect(summary.windowStartedAt).toBe(now - FAST_USAGE_WINDOW_MS);
	});

	test("validates the configurable target", () => {
		expect(parseFastUsageTarget(undefined)).toBe(0.3);
		expect(parseFastUsageTarget("0.2")).toBe(0.2);
		expect(() => parseFastUsageTarget("30")).toThrow("fraction between 0 and 1");
	});

	test("attributes usage when an SSE event is split across network chunks", () => {
		const recorded: Array<{ costUsd: number; options: { model?: string; serviceTier?: string } | undefined }> = [];
		const monitor = new FastUsageMonitor({
			recordUsageCost(_provider, costUsd, options) {
				recorded.push({ costUsd, options });
				return true;
			},
			listUsageCosts() {
				return [];
			},
		}, buildModelIndex().resolve);
		const observer = new FastUsageResponseObserver(monitor, {
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			requestedServiceTier: "priority",
		});
		const bytes = new TextEncoder().encode("data: {\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":20}}\n\ndata: [DONE]\n\n");
		observer.observeSseFrames(bytes.slice(0, 11));
		observer.observeSseFrames(bytes.slice(11, 47));
		observer.observeSseFrames(bytes.slice(47));
		observer.complete();
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.costUsd).toBeGreaterThan(0);
		expect(recorded[0]?.options).toMatchObject({ model: "gpt-5.6-sol", serviceTier: "priority" });
	});

	test("persists model and effective tier in existing usage_cost_history", async () => {
		const directory = mkdtempSync(join(tmpdir(), "deck-fast-usage-"));
		const store = await SqliteAuthCredentialStore.open(join(directory, "store.db"));
		const storage = new AuthStorage(store);
		cleanup.push(() => {
			storage.close();
			rmSync(directory, { recursive: true, force: true });
		});
		const rows = store.upsertAuthCredentialForProvider("openai-codex", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			accountId: "acct-fast-test",
		});
		await storage.reload();
		const credential = rows.find(row => row.credential.type === "oauth");
		if (credential === undefined) throw new Error("failed to seed OAuth credential");
		expect(storage.pinSessionOAuthAccount("openai-codex", "fast-session", credential.id)).toBe(true);

		const models = buildModelIndex();
		const now = Date.parse("2026-08-06T12:00:00.000Z");
		const monitor = new FastUsageMonitor(storage, models.resolve, 0.3, () => now);
		expect(monitor.record({
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			sessionId: "fast-session",
			requestedServiceTier: "priority",
		}, { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(true);

		const entries = storage.listUsageCosts({ sinceMs: now - 1 });
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			serviceTier: "priority",
		});
		expect(entries[0]!.costUsd).toBeGreaterThan(0);
		expect(monitor.summary()).toMatchObject({ fastFraction: 1, fastRequests: 1, totalRequests: 1, exceedsTarget: true });
	});
});
