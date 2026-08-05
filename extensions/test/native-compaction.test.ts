import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	buildNativeRequest,
	guardNativeArtifact,
	injectNativeArtifact,
	latestNativeArtifact,
	nativeProviderForModel,
	parseNativeCompactionConfig,
} from "../src/native-compaction.ts";

const auth = { ok: true as const, apiKey: "test-key" };
const branch = [{ type: "message", message: { role: "user", content: "old" } }];

describe("native compaction provider strategies", () => {
	test("is opt-in per provider and off by default", () => {
		assert.deepEqual(parseNativeCompactionConfig({}).enabled, { openai: false, anthropic: false, xai: false });
		assert.deepEqual(parseNativeCompactionConfig({ PI_NATIVE_COMPACTION_XAI: "yes" }).enabled, { openai: false, anthropic: false, xai: true });
	});

	test("requires the concrete provider API and supported model", () => {
		assert.equal(nativeProviderForModel({ provider: "openai", api: "openai-responses", id: "gpt-5.5" }), "openai");
		assert.equal(nativeProviderForModel({ provider: "openai", api: "openai-completions", id: "gpt-5.5" }), undefined);
		assert.equal(nativeProviderForModel({ provider: "deck", api: "openai-responses", id: "gpt-5.5" }), undefined);
		assert.equal(nativeProviderForModel({ provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6" }), "anthropic");
		assert.equal(nativeProviderForModel({ provider: "xai", api: "openai-responses", id: "grok-4.5" }), "xai");
		assert.equal(nativeProviderForModel({ provider: "google", api: "google-generative-ai", id: "gemini-2.5-pro" }), undefined);
	});

	test("builds OpenAI request with the discrete compact endpoint and store=false", () => {
		const request = buildNativeRequest("openai", { provider: "openai", api: "openai-responses", id: "gpt-5.5", baseUrl: "https://api.openai.com/v1" }, auth, branch, 120_000);
		assert.equal(request.url, "https://api.openai.com/v1/responses/compact");
		assert.equal(request.body.store, false);
	});

	test("builds Anthropic request with beta and structured compaction edit", () => {
		const request = buildNativeRequest("anthropic", { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6", baseUrl: "https://api.anthropic.com/v1" }, auth, branch, 50_000);
		assert.match(request.headers["anthropic-beta"] ?? "", /compact-2026-01-12/);
		assert.deepEqual(request.body.context_management, { edits: [{ type: "compact_20260112" }] });
	});
});

describe("native compaction portability guard", () => {
	const artifact = { provider: "openai" as const, model: "gpt-5.5", artifact: { type: "compaction", encrypted_content: "opaque" }, createdAt: "now", firstKeptEntryId: "entry" };

	test("refuses to inject a native artifact after switching providers", () => {
		const guard = guardNativeArtifact(artifact, "anthropic");
		assert.equal(guard.allowed, false);
		assert.match(guard.reason, /using pi local compaction instead/);
		const payload = { input: [{ role: "user", content: "new" }] };
		assert.deepEqual(injectNativeArtifact(payload, artifact, "anthropic"), payload);
	});

	test("finds persisted native artifacts in the session branch", () => {
		assert.deepEqual(latestNativeArtifact([{ type: "message" }, { type: "compaction", details: artifact }]), artifact);
	});
});
