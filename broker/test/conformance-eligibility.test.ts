/**
 * SPEC §6.5 conformance battery — cancellation and live plan eligibility.
 * Runs against the LIVE broker daemon and deliberately burns one token for
 * each listed Anthropic and OpenAI Codex model.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { buildModelIndex, DEFAULT_ALLOWLIST, isModelAllowed } from "../src/models";
import { CHEAP_MODEL, gatewayGet, gatewayPost, hasLiveBroker } from "./harness";

const planProvider = z.enum(["anthropic", "openai-codex"]);
type PlanProvider = z.infer<typeof planProvider>;

const modelList = z.looseObject({
	data: z.array(
		z.looseObject({
			id: z.string(),
			owned_by: z.string(),
		}),
	),
});
const gatewayError = z.looseObject({
	type: z.string().optional(),
	message: z.string().optional(),
	error: z
		.looseObject({
			type: z.string().optional(),
			message: z.string().optional(),
		})
		.optional(),
});
const localError = z.looseObject({
	type: z.literal("error"),
	error: z.looseObject({
		type: z.literal("invalid_request_error"),
		message: z.string(),
	}),
});
const sseEvent = z.looseObject({ type: z.string() });

const VALIDATED_MODELS: Record<PlanProvider, readonly string[]> = {
	anthropic: [
		"anthropic/claude-fable-5",
		"anthropic/claude-haiku-4-5",
		"anthropic/claude-haiku-4-5-20251001",
		"anthropic/claude-opus-4-1",
		"anthropic/claude-opus-4-1-20250805",
		"anthropic/claude-opus-4-5",
		"anthropic/claude-opus-4-5-20251101",
		"anthropic/claude-opus-4-6",
		"anthropic/claude-opus-4-7",
		"anthropic/claude-opus-4-8",
		"anthropic/claude-opus-5",
		"anthropic/claude-sonnet-4-5",
		"anthropic/claude-sonnet-4-5-20250929",
		"anthropic/claude-sonnet-4-6",
		"anthropic/claude-sonnet-5",
	],
	"openai-codex": [
		"openai-codex/gpt-5.3-codex-spark",
		"openai-codex/gpt-5.4",
		"openai-codex/gpt-5.4-mini",
		"openai-codex/gpt-5.5",
		"openai-codex/gpt-5.6-luna",
		"openai-codex/gpt-5.6-sol",
		"openai-codex/gpt-5.6-terra",
	],
};


type ProbeClassification = "eligible" | "eligible-but-exhausted" | "not-eligible" | "unexpected";

interface ProbeResult {
	model: string;
	classification: ProbeClassification;
	status: number;
	detail: string;
}

interface ResponseBodyReader {
	read(): Promise<{ done: boolean; value?: unknown }>;
}

async function getModels(): Promise<z.infer<typeof modelList>["data"]> {
	const response = await gatewayGet("/v1/models");
	expect(response.status).toBe(200);
	return modelList.parse(await response.json()).data;
}

function probeRequest(provider: PlanProvider, model: string): { pathname: string; body: unknown } {
	if (provider === "anthropic") {
		return {
			pathname: "/v1/messages",
			body: {
				model,
				max_tokens: 1,
				messages: [{ role: "user", content: "Reply with OK." }],
			},
		};
	}
	return {
		pathname: "/v1/chat/completions",
		body: {
			model,
			max_tokens: 1,
			messages: [{ role: "user", content: "Reply with OK." }],
		},
	};
}

async function errorDetail(response: Response): Promise<string> {
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return "non-JSON error response";
	}
	const parsed = gatewayError.safeParse(payload);
	if (!parsed.success) return "unrecognized error response";
	return [parsed.data.type, parsed.data.message, parsed.data.error?.type, parsed.data.error?.message]
		.filter(value => value !== undefined)
		.join(" ");
}

async function probeModel(provider: PlanProvider, model: string): Promise<ProbeResult> {
	const request = probeRequest(provider, model);
	const response = await gatewayPost(request.pathname, request.body);
	if (response.status === 200) {
		await response.arrayBuffer();
		return { model, classification: "eligible", status: response.status, detail: "" };
	}

	const detail = await errorDetail(response);
	if (response.status === 429 && /rate[_ -]?limit/i.test(detail)) {
		return { model, classification: "eligible-but-exhausted", status: response.status, detail };
	}

	const modelEligibilityError = /model|not[_ -]?found|permission|not[_ -]?eligible|access/i.test(detail);
	const directRejection = [400, 403, 404].includes(response.status) && modelEligibilityError;
	const wrappedUpstreamRejection = response.status === 502 && /\b(?:400|403|404)\b/.test(detail) && modelEligibilityError;
	if (directRejection || wrappedUpstreamRejection) {
		return { model, classification: "not-eligible", status: response.status, detail };
	}
	return { model, classification: "unexpected", status: response.status, detail };
}

async function withDeadline<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
	// This live integration test must use the platform clock: it verifies the
	// broker's real cancellation latency, which fake timers cannot exercise.
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), milliseconds);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function readerEnds(reader: ResponseBodyReader): Promise<void> {
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) return;
		}
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") return;
		throw error;
	}
}

async function abortAfterFirstContentDelta(response: Response, controller: AbortController): Promise<number> {
	if (!response.body) throw new Error("streaming response had no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const next = await withDeadline(reader.read(), 30_000, "stream produced no content delta within 30s");
			if (next.done) throw new Error("stream ended before its first content_block_delta");
			buffer += decoder.decode(next.value, { stream: true });

			let boundary = buffer.match(/\r?\n\r?\n/);
			while (boundary?.index !== undefined) {
				const block = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary[0].length);
				const dataLine = block.split(/\r?\n/).find(line => line.startsWith("data:"));
				if (dataLine) {
					const event = sseEvent.parse(JSON.parse(dataLine.slice("data:".length).trim()));
					if (event.type === "content_block_delta") {
						const abortStarted = performance.now();
						controller.abort();
						await withDeadline(readerEnds(reader), 2_000, "aborted stream remained open for 2s");
						return performance.now() - abortStarted;
					}
				}
				boundary = buffer.match(/\r?\n\r?\n/);
			}
		}
	} finally {
		controller.abort();
		await reader.cancel().catch(() => undefined);
	}
}

// The battery burns real tokens against a running deck-broker. It skips when
// none is reachable, which is also the case when a unit-test file in the same
// `bun test` process has repointed DECK_HOME at a throwaway home.
describe.skipIf(!hasLiveBroker())("SPEC 6.5 eligibility and cancellation", () => {
	test("(7) every listed plan model remains live-eligible", async () => {
		const models = await getModels();
		const results: ProbeResult[] = [];
		for (const model of models) {
			const parsedProvider = planProvider.safeParse(model.owned_by);
			if (!parsedProvider.success) continue;
			results.push(await probeModel(parsedProvider.data, model.id));
		}

		const unexpected = results.filter(result => result.classification === "unexpected");
		const ineligible = results.filter(result => result.classification === "not-eligible");
		expect(unexpected).toEqual([]);
		expect(ineligible).toEqual([]);

		for (const provider of planProvider.options) {
			const eligibleIds = results
				.filter(result => result.model.startsWith(`${provider}/`))
				.map(result => result.model);
			expect(eligibleIds).toEqual([...VALIDATED_MODELS[provider]]);
			const defaultIds = DEFAULT_ALLOWLIST[provider]?.map(id => `${provider}/${id}`);
			expect(defaultIds).toEqual([...VALIDATED_MODELS[provider]]);
		}
	}, 180_000);

	test("(7) an absent model is rejected locally with the distinctive model error", async () => {
		const unknownModel = "claude-3-opus-20240229";
		const response = await gatewayPost("/v1/messages", {
			model: unknownModel,
			max_tokens: 1,
			messages: [{ role: "user", content: "Reply with OK." }],
		});
		expect(response.status).toBe(404);
		const body = localError.parse(await response.json());
		expect(body.error.message).toBe(`Unknown model: ${unknownModel}`);
	});

	test("(7) every listed Anthropic id satisfies the production default allowlist", async () => {
		const models = await getModels();
		const anthropicModels = models.filter(model => model.owned_by === "anthropic");
		expect(anthropicModels.length).toBeGreaterThan(0);
		for (const model of anthropicModels) {
			const localId = model.id.slice("anthropic/".length);
			expect(isModelAllowed(DEFAULT_ALLOWLIST, "anthropic", localId)).toBe(true);
		}
	});

	test("(7) allowlist entries are exact unless they carry an explicit trailing wildcard", () => {
		const exactAllowlist: Record<string, readonly string[]> = { anthropic: ["claude-opus-4-1"] };
		const wildcardAllowlist: Record<string, readonly string[]> = { zai: ["glm-*"] };
		expect(isModelAllowed(exactAllowlist, "anthropic", "claude-opus-4-1")).toBe(true);
		expect(isModelAllowed(exactAllowlist, "anthropic", "claude-opus-4-1-20270101")).toBe(false);
		expect(isModelAllowed(wildcardAllowlist, "zai", "glm-5")).toBe(true);
	});

	test("(7) at least one known-eligible model resolves", () => {
		const resolved = buildModelIndex(DEFAULT_ALLOWLIST).resolve(CHEAP_MODEL);
		expect(resolved?.provider).toBe("anthropic");
		expect(resolved?.id).toBe(CHEAP_MODEL);
	});

	test("(6) aborting after the first delta closes promptly and leaves the broker healthy", async () => {
		const controller = new AbortController();
		const response = await gatewayPost(
			"/v1/messages",
			{
				model: CHEAP_MODEL,
				max_tokens: 512,
				stream: true,
				messages: [{ role: "user", content: "Count from 1 to 200 slowly, one number per line." }],
			},
			{ signal: controller.signal },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const abortElapsed = await abortAfterFirstContentDelta(response, controller);
		expect(abortElapsed).toBeLessThan(2_000);

		const health = await gatewayPost("/v1/messages", {
			model: CHEAP_MODEL,
			max_tokens: 8,
			messages: [{ role: "user", content: "Reply with exactly: HEALTHY" }],
		});
		expect(health.status).toBe(200);
		await health.arrayBuffer();
	}, 60_000);
});
