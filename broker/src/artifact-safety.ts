import { createHash } from "node:crypto";

export type ArtifactProvenance = {
	model: string;
	credentialId: number;
};

export type ArtifactRoute = {
	model: string;
	credentialId: number;
	authProvider: string;
	sessionId: string;
};

type ArtifactKind = "openai-reasoning" | "openai-compaction" | "anthropic-thinking" | "anthropic-redacted-thinking";
type ArtifactFamily = "openai" | "anthropic";

export type ArtifactSafetyEvent = {
	type: "reasoning-artifact-safety";
	action: "strip" | "block";
	family: ArtifactFamily;
	kind: ArtifactKind;
	reason: "account-or-model-portability" | "model-mismatch" | "unknown-provenance" | "unsupported-transport";
	disposition: "summary-preserved" | "dropped" | "request-rejected";
	resolvedModel: string;
	resolvedCredentialId: number;
	producerModel?: string;
	producerCredentialId?: number;
};

export type ArtifactEventSink = (event: ArtifactSafetyEvent) => void;

const MAX_PROVENANCE_ENTRIES = 4096;

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function artifactKey(kind: ArtifactKind, opaque: string): string {
	return `${kind}:${createHash("sha256").update(opaque).digest("base64url")}`;
}

/**
 * Bounded, process-local provenance for opaque artifacts observed on broker
 * responses. A restart intentionally makes old artifacts unknown: callers then
 * strip prior-turn artifacts or reject an unsafe latest-turn continuation
 * rather than guessing which upstream can decrypt them.
 */
export class ArtifactProvenanceRegistry {
	readonly #entries = new Map<string, ArtifactProvenance>();

	remember(kind: ArtifactKind, opaque: string, provenance: ArtifactProvenance): void {
		if (opaque.length === 0) return;
		const key = artifactKey(kind, opaque);
		this.#entries.delete(key);
		this.#entries.set(key, provenance);
		if (this.#entries.size <= MAX_PROVENANCE_ENTRIES) return;
		const oldest = this.#entries.keys().next().value;
		if (oldest !== undefined) this.#entries.delete(oldest);
	}

	lookup(kind: ArtifactKind, opaque: string): ArtifactProvenance | undefined {
		if (opaque.length === 0) return undefined;
		return this.#entries.get(artifactKey(kind, opaque));
	}
}

function eventFor(
	action: ArtifactSafetyEvent["action"],
	family: ArtifactFamily,
	kind: ArtifactKind,
	reason: ArtifactSafetyEvent["reason"],
	disposition: ArtifactSafetyEvent["disposition"],
	route: ArtifactRoute,
	producer?: ArtifactProvenance,
): ArtifactSafetyEvent {
	return {
		type: "reasoning-artifact-safety",
		action,
		family,
		kind,
		reason,
		disposition,
		resolvedModel: route.model,
		resolvedCredentialId: route.credentialId,
		...(producer === undefined ? {} : {
			producerModel: producer.model,
			producerCredentialId: producer.credentialId,
		}),
	};
}

/**
 * OpenAI ciphertext is bound to the producing model and organization. Preserve
 * it only when both identities are proven unchanged; otherwise retain its
 * visible summary in an ordinary assistant item. Compaction has no portable
 * visible fallback and is dropped on a mismatch or unknown provenance.
 */
export function sanitizeOpenAIEncryptedArtifacts(
	body: Record<string, unknown>,
	route: ArtifactRoute,
	registry: ArtifactProvenanceRegistry,
	emit: ArtifactEventSink,
): void {
	if (!Array.isArray(body.input)) return;
	const retained: unknown[] = [];
	for (const candidate of body.input) {
		if (!isObject(candidate)) {
			retained.push(candidate);
			continue;
		}
		if (candidate.type === "reasoning" && typeof candidate.encrypted_content === "string") {
			const producer = registry.lookup("openai-reasoning", candidate.encrypted_content);
			if (producer?.model === route.model && producer.credentialId === route.credentialId) {
				retained.push(candidate);
				continue;
			}
			const summary = Array.isArray(candidate.summary) ? candidate.summary : [];
			const summaryText = summary.flatMap(entry =>
				isObject(entry) && entry.type === "summary_text" && typeof entry.text === "string" ? [entry.text] : [],
			).join("");
			if (summaryText.length > 0) {
				retained.push({
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: summaryText }],
				});
			}
			emit(eventFor(
				"strip",
				"openai",
				"openai-reasoning",
				"account-or-model-portability",
				summaryText.length > 0 ? "summary-preserved" : "dropped",
				route,
				producer,
			));
			continue;
		}
		if (candidate.type === "compaction" && typeof candidate.encrypted_content === "string") {
			const producer = registry.lookup("openai-compaction", candidate.encrypted_content);
			if (producer?.model === route.model && producer.credentialId === route.credentialId) {
				retained.push(candidate);
				continue;
			}
			emit(eventFor("strip", "openai", "openai-compaction", "account-or-model-portability", "dropped", route, producer));
			continue;
		}
		retained.push(candidate);
	}
	body.input = retained;
}

function openAIArtifact(item: unknown): { kind: "openai-reasoning" | "openai-compaction"; opaque: string } | undefined {
	if (!isObject(item) || typeof item.encrypted_content !== "string") return undefined;
	if (item.type === "reasoning") return { kind: "openai-reasoning", opaque: item.encrypted_content };
	if (item.type === "compaction") return { kind: "openai-compaction", opaque: item.encrypted_content };
	return undefined;
}

function openAIThinkingArtifact(signature: unknown): { kind: "openai-reasoning"; opaque: string } | undefined {
	if (typeof signature !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(signature);
		if (isObject(parsed) && parsed.type === "reasoning" && typeof parsed.encrypted_content === "string") {
			return { kind: "openai-reasoning", opaque: parsed.encrypted_content };
		}
	} catch {
		// Anthropic and other providers use non-JSON signatures.
	}
	return undefined;
}

/** Apply the same provenance policy to canonical Context messages on pi-native. */
export function sanitizePiNativeArtifacts(
	body: Record<string, unknown>,
	route: ArtifactRoute,
	registry: ArtifactProvenanceRegistry,
	emit: ArtifactEventSink,
): AnthropicSanitizeResult {
	if (!isObject(body.context) || !Array.isArray(body.context.messages)) return { ok: true };
	const messages = body.context.messages;
	let latestAssistant = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (isObject(messages[index]) && messages[index].role === "assistant") {
			latestAssistant = index;
			break;
		}
	}
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!isObject(message)) continue;
		const removedOpenAI = new Set<string>();
		const visibleOpenAISummaries: string[] = [];
		if (isObject(message.providerPayload) && message.providerPayload.type === "openaiResponsesHistory" && Array.isArray(message.providerPayload.items)) {
			const retained: unknown[] = [];
			for (const item of message.providerPayload.items) {
				const artifact = openAIArtifact(item);
				if (artifact === undefined) {
					retained.push(item);
					continue;
				}
				const producer = registry.lookup(artifact.kind, artifact.opaque);
				if (producer?.model === route.model && producer.credentialId === route.credentialId) {
					retained.push(item);
					continue;
				}
				removedOpenAI.add(artifact.opaque);
				const summary = artifact.kind === "openai-reasoning" && isObject(item) && Array.isArray(item.summary)
					? item.summary.flatMap(part =>
						isObject(part) && part.type === "summary_text" && typeof part.text === "string" ? [part.text] : [],
					).join("")
					: "";
				if (summary.trim().length > 0) visibleOpenAISummaries.push(summary);
				emit(eventFor("strip", "openai", artifact.kind, "account-or-model-portability", summary.trim().length > 0 ? "summary-preserved" : "dropped", route, producer));
			}
			message.providerPayload.items = retained;
		}
		if (!Array.isArray(message.content)) {
			if (message.role === "assistant" && visibleOpenAISummaries.length > 0) {
				message.content = visibleOpenAISummaries.map(thinking => ({ type: "thinking", thinking }));
			}
			continue;
		}
		const retainedContent: unknown[] = [];
		for (const block of message.content) {
			if (!isObject(block)) {
				retainedContent.push(block);
				continue;
			}
			const openAI = openAIThinkingArtifact(block.thinkingSignature);
			if (openAI !== undefined) {
				const producer = registry.lookup(openAI.kind, openAI.opaque);
				if (producer?.model === route.model && producer.credentialId === route.credentialId && !removedOpenAI.has(openAI.opaque)) {
					retainedContent.push(block);
				} else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length > 0) {
					retainedContent.push({ type: "thinking", thinking: block.thinking });
				}
				continue;
			}
			const anthropic = block.type === "thinking" && typeof block.thinkingSignature === "string"
				? { kind: "anthropic-thinking" as const, opaque: block.thinkingSignature, summary: block.thinking }
				: block.type === "redactedThinking" && typeof block.data === "string"
					? { kind: "anthropic-redacted-thinking" as const, opaque: block.data, summary: undefined }
					: undefined;
			if (anthropic === undefined) {
				retainedContent.push(block);
				continue;
			}
			const producer = registry.lookup(anthropic.kind, anthropic.opaque);
			if (producer?.model === route.model) {
				retainedContent.push(block);
				continue;
			}
			const reason = producer === undefined ? "unknown-provenance" : "model-mismatch";
			if (index === latestAssistant) {
				emit(eventFor("block", "anthropic", anthropic.kind, reason, "request-rejected", route, producer));
				return { ok: false, message: `latest assistant ${anthropic.kind} is not proven portable to resolved model ${route.model}` };
			}
			if (typeof anthropic.summary === "string" && anthropic.summary.trim().length > 0) {
				retainedContent.push({ type: "text", text: anthropic.summary });
			}
			emit(eventFor("strip", "anthropic", anthropic.kind, reason, typeof anthropic.summary === "string" && anthropic.summary.trim().length > 0 ? "summary-preserved" : "dropped", route, producer));
		}
		for (const summary of visibleOpenAISummaries) {
			const alreadyPresent = retainedContent.some(block =>
				isObject(block) &&
				((block.type === "thinking" && block.thinking === summary) || (block.type === "text" && block.text === summary))
			);
			if (!alreadyPresent) retainedContent.push({ type: "thinking", thinking: summary });
		}
		message.content = retainedContent;
	}
	return { ok: true };
}
type AnthropicArtifact = {
	kind: "anthropic-thinking" | "anthropic-redacted-thinking";
	opaque: string;
	visibleSummary?: string;
};

function anthropicArtifact(block: unknown): AnthropicArtifact | undefined {
	if (!isObject(block)) return undefined;
	if (block.type === "thinking") {
		return {
			kind: "anthropic-thinking",
			opaque: typeof block.signature === "string" ? block.signature : "",
			visibleSummary: typeof block.thinking === "string" ? block.thinking : undefined,
		};
	}
	if (block.type === "redacted_thinking") {
		return {
			kind: "anthropic-redacted-thinking",
			opaque: typeof block.data === "string" ? block.data : "",
		};
	}
	return undefined;
}

type AnthropicAssistantMessage = Record<string, unknown> & { role: "assistant" };

function assistantMessage(message: unknown): AnthropicAssistantMessage | undefined {
	if (!isObject(message) || message.role !== "assistant") return undefined;
	return message as AnthropicAssistantMessage;
}

export type AnthropicSanitizeResult =
	| { ok: true }
	| { ok: false; message: string };

/**
 * Demote foreign prior-turn thinking to visible assistant prose, but never
 * rewrite the latest assistant message: Anthropic requires that message's
 * signed thinking bytes to remain unchanged during a continuation. A latest
 * artifact with foreign or unknown provenance therefore fails closed locally.
 */
export function sanitizeAnthropicThinking(
	body: Record<string, unknown>,
	route: ArtifactRoute,
	registry: ArtifactProvenanceRegistry,
	emit: ArtifactEventSink,
): AnthropicSanitizeResult {
	if (!Array.isArray(body.messages)) return { ok: true };
	let latestAssistant = -1;
	for (let index = body.messages.length - 1; index >= 0; index--) {
		if (assistantMessage(body.messages[index]) !== undefined) {
			latestAssistant = index;
			break;
		}
	}

	if (latestAssistant >= 0) {
		const latest = assistantMessage(body.messages[latestAssistant]);
		const latestContent = latest !== undefined && Array.isArray(latest.content) ? latest.content : [];
		for (const block of latestContent) {
			const artifact = anthropicArtifact(block);
			if (artifact === undefined) continue;
			const producer = registry.lookup(artifact.kind, artifact.opaque);
			// Anthropic documents model binding, not account binding. Account
			// provenance is recorded when observable but is deliberately not used
			// to invent a portability restriction the vendor does not claim.
			if (producer?.model === route.model) continue;
			const reason = producer === undefined ? "unknown-provenance" : "model-mismatch";
			emit(eventFor("block", "anthropic", artifact.kind, reason, "request-rejected", route, producer));
			return {
				ok: false,
				message: producer === undefined
					? `latest assistant ${artifact.kind} has no broker provenance; refusing to modify or replay it`
					: `latest assistant ${artifact.kind} was produced by ${producer.model}, not resolved model ${route.model}; refusing to modify or replay it`,
			};
		}
	}

	for (let index = 0; index < body.messages.length; index++) {
		if (index === latestAssistant) continue;
		const message = assistantMessage(body.messages[index]);
		if (message === undefined || !Array.isArray(message.content)) continue;
		const content = message.content;
		const retained: unknown[] = [];
		for (const block of content) {
			const artifact = anthropicArtifact(block);
			if (artifact === undefined) {
				retained.push(block);
				continue;
			}
			const producer = registry.lookup(artifact.kind, artifact.opaque);
			if (producer?.model === route.model) {
				retained.push(block);
				continue;
			}
			const summary = artifact.visibleSummary?.trim();
			if (summary) retained.push({ type: "text", text: artifact.visibleSummary });
			emit(eventFor(
				"strip",
				"anthropic",
				artifact.kind,
				producer === undefined ? "unknown-provenance" : "model-mismatch",
				summary ? "summary-preserved" : "dropped",
				route,
				producer,
			));
		}
		message.content = retained;
	}
	return { ok: true };
}

function recordArtifactCandidate(
	value: unknown,
	provenance: ArtifactProvenance,
	registry: ArtifactProvenanceRegistry,
): void {
	if (!isObject(value)) return;
	if (value.type === "reasoning" && typeof value.encrypted_content === "string") {
		registry.remember("openai-reasoning", value.encrypted_content, provenance);
	} else if (value.type === "compaction" && typeof value.encrypted_content === "string") {
		registry.remember("openai-compaction", value.encrypted_content, provenance);
	} else if (value.type === "thinking" && typeof value.signature === "string") {
		registry.remember("anthropic-thinking", value.signature, provenance);
	} else if (value.type === "redacted_thinking" && typeof value.data === "string") {
		registry.remember("anthropic-redacted-thinking", value.data, provenance);
	}
}

function recordPiMessageArtifacts(
	message: unknown,
	provenance: ArtifactProvenance,
	registry: ArtifactProvenanceRegistry,
): void {
	if (!isObject(message)) return;
	if (isObject(message.providerPayload) && Array.isArray(message.providerPayload.items)) {
		for (const item of message.providerPayload.items) recordArtifactCandidate(item, provenance, registry);
	}
	const anthropic = message.provider === "anthropic" || (typeof message.api === "string" && message.api.includes("anthropic"));
	if (!anthropic || !Array.isArray(message.content)) return;
	for (const block of message.content) {
		if (!isObject(block)) continue;
		if (block.type === "thinking" && typeof block.thinkingSignature === "string") {
			registry.remember("anthropic-thinking", block.thinkingSignature, provenance);
		} else if (block.type === "redactedThinking" && typeof block.data === "string") {
			registry.remember("anthropic-redacted-thinking", block.data, provenance);
		}
	}
}

/** Record artifacts only at protocol-defined response item/block locations. */
export function recordResponseArtifactProvenance(
	value: unknown,
	provenance: ArtifactProvenance,
	registry: ArtifactProvenanceRegistry,
): void {
	if (!isObject(value)) return;
	const candidates: unknown[] = [];
	if (Array.isArray(value.output)) candidates.push(...value.output);
	if (Array.isArray(value.content)) candidates.push(...value.content);
	if (isObject(value.item)) candidates.push(value.item);
	if (isObject(value.content_block)) candidates.push(value.content_block);
	if (isObject(value.response) && Array.isArray(value.response.output)) candidates.push(...value.response.output);
	if (isObject(value.message)) recordPiMessageArtifacts(value.message, provenance, registry);
	if (isObject(value.error)) recordPiMessageArtifacts(value.error, provenance, registry);
	for (const candidate of candidates) recordArtifactCandidate(candidate, provenance, registry);
}

/** Stateful observer for Anthropic signature deltas and complete SSE items. */
export class SseArtifactProvenanceObserver {
	readonly #thinkingSignatures = new Map<number, string>();

	constructor(
		private readonly resolveProvenance: () => ArtifactProvenance | undefined,
		private readonly registry: ArtifactProvenanceRegistry,
	) {}

	observe(completeFrames: Uint8Array): void {
		const text = new TextDecoder().decode(completeFrames);
		for (const frame of text.split(/\r?\n\r?\n/)) {
			if (frame.length === 0) continue;
			const data = frame.split(/\r?\n/)
				.filter(line => line.startsWith("data:"))
				.map(line => line.slice(5).trimStart())
				.join("\n");
			if (!data || data === "[DONE]") continue;
			let payload: unknown;
			try {
				payload = JSON.parse(data);
			} catch {
				continue;
			}
			const provenance = this.resolveProvenance();
			if (provenance === undefined) continue;
			recordResponseArtifactProvenance(payload, provenance, this.registry);
			if (!isObject(payload) || typeof payload.index !== "number") continue;
			if (payload.type === "content_block_start" && isObject(payload.content_block) && payload.content_block.type === "thinking") {
				this.#thinkingSignatures.set(payload.index, typeof payload.content_block.signature === "string" ? payload.content_block.signature : "");
			} else if (
				payload.type === "content_block_delta" &&
				isObject(payload.delta) &&
				payload.delta.type === "signature_delta" &&
				typeof payload.delta.signature === "string"
			) {
				this.#thinkingSignatures.set(payload.index, (this.#thinkingSignatures.get(payload.index) ?? "") + payload.delta.signature);
			} else if (payload.type === "content_block_stop") {
				const signature = this.#thinkingSignatures.get(payload.index);
				if (signature) this.registry.remember("anthropic-thinking", signature, provenance);
				this.#thinkingSignatures.delete(payload.index);
			}
		}
	}
}
