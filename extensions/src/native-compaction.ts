/** Provider-native server compaction for direct pi provider routes. */

const NATIVE_COMPACTION_DETAILS = "deck.native-compaction.v1";
const DEFAULT_THRESHOLDS = { openai: 120_000, anthropic: 50_000, xai: 100_000 } as const;

type NativeProvider = keyof typeof DEFAULT_THRESHOLDS;

type Model = { provider: string; id: string; api?: string; baseUrl?: string };
type SessionEntry = { type?: string; id?: string; message?: { role?: string; content?: unknown }; details?: unknown };
type NativeArtifact = {
	provider: NativeProvider;
	model: string;
	artifact: unknown;
	createdAt: string;
	firstKeptEntryId: string;
};
export type NativeCompactionConfig = {
	enabled: Record<NativeProvider, boolean>;
	threshold: Record<NativeProvider, number>;
};

type Auth = { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string };
type Context = {
	model?: Model;
	modelRegistry: { getApiKeyAndHeaders(model: Model): Promise<Auth> };
	sessionManager: { getBranch(): SessionEntry[] };
	ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
};
type ExtensionApi = { on(event: string, handler: (event: any, context: Context) => Promise<unknown> | unknown): void };

type NativeRequest = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function enabled(value: string | undefined): boolean {
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function parseNativeCompactionConfig(env: Record<string, string | undefined> = process.env): NativeCompactionConfig {
	return {
		enabled: {
			openai: enabled(env.PI_NATIVE_COMPACTION_OPENAI),
			anthropic: enabled(env.PI_NATIVE_COMPACTION_ANTHROPIC),
			xai: enabled(env.PI_NATIVE_COMPACTION_XAI),
		},
		threshold: {
			openai: positiveInteger(env.PI_NATIVE_COMPACTION_OPENAI_THRESHOLD, DEFAULT_THRESHOLDS.openai),
			anthropic: positiveInteger(env.PI_NATIVE_COMPACTION_ANTHROPIC_THRESHOLD, DEFAULT_THRESHOLDS.anthropic),
			xai: positiveInteger(env.PI_NATIVE_COMPACTION_XAI_THRESHOLD, DEFAULT_THRESHOLDS.xai),
		},
	};
}

/** Capability selection is based on the actual provider and API, not model name alone. */
export function nativeProviderForModel(model: Model | undefined): NativeProvider | undefined {
	if (!model) return undefined;
	if (model.provider === "openai" && model.api === "openai-responses" && /^gpt-5(?:[.-]|$)/.test(model.id)) return "openai";
	if (model.provider === "anthropic" && model.api === "anthropic-messages" && /claude-(?:opus|sonnet)-4-6(?:[-.]|$)/.test(model.id)) return "anthropic";
	if (model.provider === "xai" && model.api === "openai-responses" && /^grok-4\.5(?:[-.]|$)/.test(model.id)) return "xai";
	return undefined;
}

function activeProvider(model: Model | undefined): string | undefined {
	if (!model) return undefined;
	if (model.provider === "openai" || model.provider === "anthropic" || model.provider === "xai") return model.provider;
	return model.provider;
}

export function guardNativeArtifact(
	artifact: Pick<NativeArtifact, "provider"> | undefined,
	active: string | undefined,
): { allowed: true } | { allowed: false; reason: string } {
	if (!artifact || !active || artifact.provider === active) return { allowed: true };
	return {
		allowed: false,
		reason: `session contains a ${artifact.provider} native compaction artifact but the active provider is ${active}; using pi local compaction instead`,
	};
}

function isNativeArtifact(value: unknown): value is NativeArtifact {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<NativeArtifact>;
	return (
		(item.provider === "openai" || item.provider === "anthropic" || item.provider === "xai") &&
		typeof item.model === "string" &&
		typeof item.createdAt === "string" &&
		typeof item.firstKeptEntryId === "string" &&
		"artifact" in item
	);
}

export function latestNativeArtifact(branch: SessionEntry[]): NativeArtifact | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type === "compaction" && isNativeArtifact(entry.details)) return entry.details;
	}
	return undefined;
}

function notify(ctx: Context, message: string, level: "info" | "warning" = "info"): void {
	ctx.ui.notify(`Native compaction: ${message}`, level);
	console.warn(`[deck-native-compaction] ${message}`);
}

function endpoint(baseUrl: string | undefined, path: string): string {
	const base = (baseUrl ?? "").replace(/\/$/, "");
	return `${base}${base.endsWith("/v1") ? "" : "/v1"}${path}`;
}

function headers(provider: NativeProvider, auth: Extract<Auth, { ok: true }>): Record<string, string> {
	const result: Record<string, string> = { "content-type": "application/json", ...(auth.headers ?? {}) };
	const hasAuth = Object.keys(result).some((key) => ["authorization", "x-api-key"].includes(key.toLowerCase()));
	if (auth.apiKey && !hasAuth) {
		const anthropicBearer = provider === "anthropic" && auth.apiKey.startsWith("sk-ant-oat");
		result[provider === "anthropic" && !anthropicBearer ? "x-api-key" : "authorization"] = anthropicBearer || provider !== "anthropic" ? `Bearer ${auth.apiKey}` : auth.apiKey;
	}
	if (provider === "anthropic") {
		result["anthropic-version"] ??= "2023-06-01";
		result["anthropic-beta"] = [result["anthropic-beta"], "compact-2026-01-12"].filter(Boolean).join(",");
	}
	return result;
}

function inputs(branch: SessionEntry[]): Array<Record<string, unknown>> {
	return branch.flatMap((entry) => {
		const message = entry.message;
		return message && (message.role === "user" || message.role === "assistant")
			? [{ role: message.role, content: message.content }]
			: [];
	});
}

export function buildNativeRequest(provider: NativeProvider, model: Model, auth: Extract<Auth, { ok: true }>, branch: SessionEntry[], _threshold: number): NativeRequest {
	const messages = inputs(branch);
	if (provider === "anthropic") {
		return {
			url: endpoint(model.baseUrl, "/messages"),
			headers: headers(provider, auth),
			body: {
				model: model.id,
				max_tokens: 1024,
				messages,
				context_management: { edits: [{ type: "compact_20260112" }] },
			},
		};
	}
	if (provider === "openai") {
		return {
			url: endpoint(model.baseUrl, "/responses/compact"),
			headers: headers(provider, auth),
			body: { model: model.id, input: messages, store: false },
		};
	}
	return {
		url: endpoint(model.baseUrl, "/responses/compact"),
		headers: headers(provider, auth),
		body: { model: model.id, input: messages },
	};
}

function artifactFromResponse(provider: NativeProvider, payload: Record<string, unknown>): unknown {
	if (provider === "anthropic") {
		if (Array.isArray(payload.content)) return payload.content.find((item) => item && typeof item === "object" && (item as { type?: string }).type === "compaction");
		return undefined;
	}
	return Array.isArray(payload.output)
		? payload.output.find((item) => item && typeof item === "object" && (item as { type?: string }).type === "compaction")
		: undefined;
}

function summaryFromArtifact(provider: NativeProvider, artifact: unknown): string {
	if (provider === "anthropic" && artifact && typeof artifact === "object" && typeof (artifact as { summary?: unknown }).summary === "string") {
		return (artifact as { summary: string }).summary;
	}
	return `Provider-native ${provider} compaction completed. The artifact is opaque and can only be replayed to ${provider}.`;
}

async function callNativeCompaction(
	provider: NativeProvider,
	model: Model,
	branch: SessionEntry[],
	config: NativeCompactionConfig,
	ctx: Context,
	fetchFn: typeof fetch,
	signal: AbortSignal,
): Promise<{ artifact: unknown; summary: string; tokensBefore: number }> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	const request = buildNativeRequest(provider, model, auth, branch, config.threshold[provider]);
	const response = await fetchFn(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(request.body), signal });
	if (!response.ok) throw new Error(`${provider} compaction returned HTTP ${response.status}`);
	const payload = (await response.json()) as Record<string, unknown>;
	const artifact = artifactFromResponse(provider, payload);
	if (!artifact) throw new Error(`${provider} response contained no compaction artifact`);
	const usage = payload.usage as { input_tokens?: unknown } | undefined;
	return {
		artifact,
		summary: summaryFromArtifact(provider, artifact),
		tokensBefore: typeof usage?.input_tokens === "number" ? usage.input_tokens : inputs(branch).length,
	};
}

export function injectNativeArtifact(payload: unknown, artifact: NativeArtifact, active?: string): unknown {
	if (!guardNativeArtifact(artifact, active).allowed) return payload;
	if (!payload || typeof payload !== "object") return payload;
	const request = payload as Record<string, unknown>;
	if (artifact.provider === "anthropic" && Array.isArray(request.messages)) return { ...request, messages: [{ role: "assistant", content: [artifact.artifact] }, ...request.messages] };
	if ((artifact.provider === "openai" || artifact.provider === "xai") && Array.isArray(request.input)) return { ...request, input: [artifact.artifact, ...request.input] };
	return payload;
}

export function registerNativeCompaction(pi: ExtensionApi, env: Record<string, string | undefined> = process.env, fetchFn: typeof fetch = fetch): void {
	const config = parseNativeCompactionConfig(env);

	pi.on("session_start", (_event, ctx) => {
		const artifact = latestNativeArtifact(ctx.sessionManager.getBranch());
		const guard = guardNativeArtifact(artifact, activeProvider(ctx.model));
		if (!guard.allowed) notify(ctx, guard.reason, "warning");
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const artifact = latestNativeArtifact(ctx.sessionManager.getBranch());
		const provider = nativeProviderForModel(ctx.model);
		const guard = guardNativeArtifact(artifact, activeProvider(ctx.model));
		if (!guard.allowed) {
			notify(ctx, guard.reason, "warning");
			return event.payload;
		}
		if (artifact && provider && config.enabled[provider]) return injectNativeArtifact(event.payload, artifact, activeProvider(ctx.model));
		if (provider === "openai" && config.enabled.openai && event.payload && typeof event.payload === "object") {
			const payload = event.payload as Record<string, unknown>;
			return { ...payload, context_management: [{ type: "compaction", compact_threshold: config.threshold.openai }] };
		}
		return event.payload;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const provider = nativeProviderForModel(ctx.model);
		if (!provider || !config.enabled[provider]) {
			if (ctx.model) notify(ctx, `${ctx.model.provider} native path is disabled or unsupported; falling back to pi local compaction`);
			return undefined;
		}
		const existing = latestNativeArtifact(ctx.sessionManager.getBranch());
		const guard = guardNativeArtifact(existing, activeProvider(ctx.model));
		if (!guard.allowed) {
			notify(ctx, guard.reason, "warning");
			return undefined;
		}
		const model = ctx.model;
		if (!model) return undefined;
		try {
			const result = await callNativeCompaction(provider, model, event.branchEntries, config, ctx, fetchFn, event.signal);
			const details: NativeArtifact = {
				provider,
				model: model.id,
				artifact: result.artifact,
				createdAt: new Date().toISOString(),
				firstKeptEntryId: event.preparation.firstKeptEntryId,
			};
			notify(ctx, `${provider} native compaction artifact received`);
			return { compaction: { summary: result.summary, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: result.tokensBefore, details } };
		} catch (error) {
			notify(ctx, `${provider} native compaction failed (${error instanceof Error ? error.message : String(error)}); falling back to pi local compaction`, "warning");
			return undefined;
		}
	});

	pi.on("session_compact", (event, ctx) => {
		if (isNativeArtifact(event.compactionEntry.details)) notify(ctx, `${event.compactionEntry.details.provider} artifact persisted for provider-locked replay`);
	});
}

export default function (pi: ExtensionApi): void {
	registerNativeCompaction(pi);
}

export { NATIVE_COMPACTION_DETAILS };
