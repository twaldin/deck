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
 * OpenAI OAuth dispatch can rotate again inside pi-ai after the broker selects
 * an account (refresh/auth/quota failover). The outer broker cannot bind one
 * request to a credential through that retry, so no encrypted blob is safe to
 * forward: retain only the wire identity and visible summary.
 * Compaction is dropped because the current auth-gateway has no compaction
 * transport and would discard it later anyway.
 */
export function stripOpenAIEncryptedArtifacts(
	body: Record<string, unknown>,
	route: ArtifactRoute,
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
			));
			continue;
		}
		if (candidate.type === "compaction" && typeof candidate.encrypted_content === "string") {
			emit(eventFor("strip", "openai", "openai-compaction", "unsupported-transport", "dropped", route));
			continue;
		}
		retained.push(candidate);
	}
	body.input = retained;
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
