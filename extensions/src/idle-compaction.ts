import {
	decideIdleCompaction,
	idleThresholdMs,
	MAX_TIMER_DELAY_MS,
	parseIdleCompactionConfig,
	selectIdleCompactionConfig,
	type IdleCompactionConfig,
} from "./idle-compaction-policy";

const STATE_ENTRY_TYPE = "deck.idle-compaction.v1";
/**
 * Supplements pi's own structured compaction template (pi appends this as
 * "Additional focus:"), so it names only what a PARKED FLEET AGENT uniquely
 * needs and does not restate Goal/Progress/Next-Steps, which pi already covers.
 *
 * The previous text asked for "goals, constraints, decisions, progress, next
 * steps" — all of which pi's template already demands — and asked for none of
 * the identifiers a resuming agent actually cannot reconstruct. An agent that
 * wakes without its run receipt starts a second run of something already
 * executing; one that wakes without its pending decision asks the captain twice.
 */
const COMPACTION_INSTRUCTIONS =
	"This agent is parking and will resume cold. Additionally preserve, exactly: its task id and current status-file state; worktree path and branch; PR URLs with their last known CI and review state; any pending decision it is waiting on and who owes the answer; run receipts (endpoint, run id, poller) for anything still executing remotely; and the precise next command or action it would have taken. Prefer exact identifiers over descriptions.";

type TimerHandle = ReturnType<typeof setTimeout>;

export interface IdleCompactionRuntime {
	now(): number;
	setTimer(callback: () => void, delayMs: number): TimerHandle;
	clearTimer(handle: TimerHandle): void;
}

const defaultRuntime: IdleCompactionRuntime = {
	now: Date.now,
	setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimer: clearTimeout,
};

interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
}

interface SessionEntry {
	type: string;
	id?: string;
	customType?: string;
	data?: unknown;
}

interface ReadonlySessionManager {
	getBranch(): SessionEntry[];
	getLeafId(): string | null;
}

interface CompactionResult {
	tokensBefore: number;
	estimatedTokensAfter: number;
}

interface IdleCompactionContext {
	hasUI: boolean;
	model?: { provider: string; id: string; baseUrl?: string };
	ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	getContextUsage(): ContextUsage | undefined;
	sessionManager: ReadonlySessionManager;
	compact(options: {
		customInstructions?: string;
		onComplete?: (result: CompactionResult) => void;
		onError?: (error: Error) => void;
	}): void;
}

type EventHandler = (event: any, context: IdleCompactionContext) => Promise<void> | void;

export interface IdleCompactionExtensionApi {
	on(event: string, handler: EventHandler): void;
	appendEntry(customType: string, data?: unknown): void;
	registerFlag?(
		name: string,
		options: { description: string; type: "boolean"; default: boolean },
	): void;
	getFlag?(name: string): boolean | string | undefined;
}

interface PersistedState {
	contextMarker: string | null;
	contextTokens: number | null;
	compactedAt: number;
}

function isPersistedState(value: unknown): value is PersistedState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Partial<PersistedState>;
	return (
		(state.contextMarker === null || typeof state.contextMarker === "string") &&
		(state.contextTokens === null || typeof state.contextTokens === "number") &&
		typeof state.compactedAt === "number"
	);
}

/** Last branch entry that affects model context; extension state entries are ignored. */
export function getContextMarker(sessionManager: ReadonlySessionManager): string | null {
	const branch = sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" && typeof entry?.id === "string") return entry.id;
	}
	return null;
}

function restoreState(sessionManager: ReadonlySessionManager): PersistedState | null {
	const branch = sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (
			entry?.type === "custom" &&
			entry.customType === STATE_ENTRY_TYPE &&
			isPersistedState(entry.data)
		) {
			return entry.data;
		}
		if (entry?.type === "compaction") {
			return {
				contextMarker: entry.id ?? null,
				contextTokens: null,
				compactedAt: 0,
			};
		}
	}
	return null;
}

export function registerIdleCompaction(
	pi: IdleCompactionExtensionApi,
	env: Record<string, string | undefined> = process.env,
	runtime: IdleCompactionRuntime = defaultRuntime,
): void {
	pi.registerFlag?.("no-idle-compaction", {
		description: "Disable warm-cache idle compaction for this pi session",
		type: "boolean",
		default: false,
	});
	const parsed = parseIdleCompactionConfig(env);
	let active = false;
	let enabledForSession = false;
	let timer: TimerHandle | undefined;
	let lastCacheTouchMs = runtime.now();
	let hasCacheTouch = false;
	let providerResponseThisTurn = false;
	let successfulResponseThisRun = false;
	let cacheTouchModelIdentity: string | null = null;
	let latestContext: IdleCompactionContext | undefined;
	let compacting = false;
	let idleCompactionRequested = false;
	let inFlightToolCalls = 0;
	let lastCompactedContextMarker: string | null = null;
	let lastCompactedTokens: number | null = null;
	let lastCompactedAtMs: number | null = null;
	let failedContextMarker: string | null = null;
	let failuresForContext = 0;

	const modelIdentity = (ctx: IdleCompactionContext): string | null =>
		ctx.model === undefined
			? null
			: `${ctx.model.provider}\u0000${ctx.model.id}\u0000${ctx.model.baseUrl ?? ""}`;

	const configFor = (ctx: IdleCompactionContext): IdleCompactionConfig =>
		selectIdleCompactionConfig(parsed, ctx.model);

	const clearScheduled = (): void => {
		if (timer !== undefined) runtime.clearTimer(timer);
		timer = undefined;
	};

	const notify = (
		ctx: IdleCompactionContext,
		message: string,
		level: "info" | "warning" | "error" = "info",
	): void => {
		if (parsed.config.notify && ctx.hasUI) ctx.ui.notify(message, level);
	};

	const reportConfigWarning = (ctx: IdleCompactionContext, warning: string): void => {
		const message = `Idle compaction: ${warning}`;
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		else console.error(message);
	};

	const persistCompaction = (
		ctx: IdleCompactionContext,
		contextTokens: number | null,
	): void => {
		lastCompactedContextMarker = getContextMarker(ctx.sessionManager);
		lastCompactedTokens = contextTokens;
		lastCompactedAtMs = runtime.now();
		pi.appendEntry(STATE_ENTRY_TYPE, {
			contextMarker: lastCompactedContextMarker,
			contextTokens,
			compactedAt: lastCompactedAtMs,
		} satisfies PersistedState);
	};

	const scheduleAfter = (delayMs: number): void => {
		clearScheduled();
		if (latestContext === undefined || !active || !enabledForSession || !hasCacheTouch) return;
		const config = configFor(latestContext);
		if (config.engine !== "client") return;
		timer = runtime.setTimer(() => {
			timer = undefined;
			const ctx = latestContext;
			if (
				!active ||
				ctx === undefined ||
				compacting ||
				modelIdentity(ctx) !== cacheTouchModelIdentity
			) {
				return;
			}
			const currentConfig = configFor(ctx);

			const usage = ctx.getContextUsage();
			const currentContextMarker = getContextMarker(ctx.sessionManager);
			if (currentContextMarker !== failedContextMarker) {
				failedContextMarker = currentContextMarker;
				failuresForContext = 0;
			} else if (failuresForContext > currentConfig.maxRetriesPerContext) {
				return;
			}
			const decision = decideIdleCompaction({
				config: { ...currentConfig, enabled: enabledForSession },
				nowMs: runtime.now(),
				lastCacheTouchMs,
				isIdle: ctx.isIdle(),
				hasPendingMessages: ctx.hasPendingMessages(),
				inFlightToolCalls,
				contextTokens: usage?.tokens ?? null,
				contextWindow: usage?.contextWindow ?? 0,
				currentContextMarker,
				lastCompactedContextMarker,
				lastCompactedTokens,
				lastCompactedAtMs,
			});

			if (!decision.compact) {
				if (decision.reason === "cache-still-fresh" || decision.reason === "cooldown") {
					scheduleAfter(decision.waitMs ?? currentConfig.retryDelayMs);
				} else if (decision.reason === "usage-unknown") {
					failedContextMarker = currentContextMarker;
					failuresForContext += 1;
					if (failuresForContext <= currentConfig.maxRetriesPerContext) {
						scheduleAfter(currentConfig.retryDelayMs * 2 ** (failuresForContext - 1));
					}
				}
				return;
			}

			// ctx.compact() aborts before compacting in pi 0.82, so this final check is
			// intentionally adjacent to the call. Never interrupt streaming/tools.
			if (!ctx.isIdle() || ctx.hasPendingMessages() || inFlightToolCalls > 0) return;
			compacting = true;
			idleCompactionRequested = true;
			notify(
				ctx,
				`Idle compaction started at ${usage?.tokens?.toLocaleString()} tokens (${Math.round(decision.idleForMs / 1000)}s idle)`,
			);
			ctx.compact({
				customInstructions: COMPACTION_INSTRUCTIONS,
				onComplete: (result) => {
					if (!active) return;
					compacting = false;
					idleCompactionRequested = false;
					failuresForContext = 0;
					persistCompaction(ctx, result.estimatedTokensAfter);
					notify(
						ctx,
						`Idle compaction completed: ${result.tokensBefore.toLocaleString()} → ~${result.estimatedTokensAfter.toLocaleString()} tokens`,
					);
				},
				onError: (error) => {
					if (!active) return;
					compacting = false;
					idleCompactionRequested = false;
					failedContextMarker = currentContextMarker;
					failuresForContext += 1;
					notify(ctx, `Idle compaction failed: ${error.message}`, "warning");
					if (
						failuresForContext <= currentConfig.maxRetriesPerContext &&
						ctx.isIdle() &&
						!ctx.hasPendingMessages()
					) {
						scheduleAfter(currentConfig.retryDelayMs * 2 ** (failuresForContext - 1));
					}
				},
			});
		// Node would otherwise coerce an oversized timeout to 1ms; after this
		// chunk the cache-fresh decision recomputes and schedules the remainder.
		}, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, delayMs)));
	};

	const scheduleFromCacheTouch = (): void => {
		if (latestContext === undefined) return;
		const config = configFor(latestContext);
		scheduleAfter(Math.max(0, lastCacheTouchMs + idleThresholdMs(config) - runtime.now()));
	};

	pi.on("session_start", (_event, ctx) => {
		active = true;
		enabledForSession = parsed.config.enabled && pi.getFlag?.("no-idle-compaction") !== true;
		latestContext = ctx;
		compacting = false;
		idleCompactionRequested = false;
		inFlightToolCalls = 0;
		lastCacheTouchMs = runtime.now();
		hasCacheTouch = false;
		providerResponseThisTurn = false;
		successfulResponseThisRun = false;
		cacheTouchModelIdentity = null;
		failedContextMarker = null;
		failuresForContext = 0;
		const restored = restoreState(ctx.sessionManager);
		lastCompactedContextMarker = restored?.contextMarker ?? null;
		lastCompactedTokens = restored?.contextTokens ?? null;
		lastCompactedAtMs = restored !== null && restored.compactedAt > 0 ? restored.compactedAt : null;
		for (const warning of parsed.warnings) reportConfigWarning(ctx, warning);
		if (parsed.config.engine === "native") {
			notify(ctx, "Idle compaction: native engine is reserved but unsupported; no compaction will run", "warning");
		}
	});

	pi.on("before_agent_start", (_event, ctx) => {
		latestContext = ctx;
		providerResponseThisTurn = false;
		successfulResponseThisRun = false;
		clearScheduled();
	});
	pi.on("agent_start", (_event, ctx) => {
		latestContext = ctx;
		compacting = false;
		idleCompactionRequested = false;
		providerResponseThisTurn = false;
		successfulResponseThisRun = false;
		inFlightToolCalls = 0;
		clearScheduled();
	});
	pi.on("before_provider_request", (_event, ctx) => {
		latestContext = ctx;
		providerResponseThisTurn = false;
		successfulResponseThisRun = false;
	});
	pi.on("after_provider_response", (event, ctx) => {
		latestContext = ctx;
		providerResponseThisTurn = event.status >= 200 && event.status < 300;
		if (providerResponseThisTurn) lastCacheTouchMs = runtime.now();
	});
	pi.on("turn_end", (event, ctx) => {
		latestContext = ctx;
		const stopReason = event.message?.stopReason;
		const successfulTurn = stopReason !== "error" && stopReason !== "aborted";
		successfulResponseThisRun = providerResponseThisTurn && successfulTurn;
		providerResponseThisTurn = false;
		if (successfulResponseThisRun) cacheTouchModelIdentity = modelIdentity(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		latestContext = ctx;
		hasCacheTouch = false;
		providerResponseThisTurn = false;
		successfulResponseThisRun = false;
		cacheTouchModelIdentity = null;
		clearScheduled();
	});
	pi.on("tool_execution_start", (_event, ctx) => {
		latestContext = ctx;
		inFlightToolCalls += 1;
		clearScheduled();
	});
	pi.on("tool_execution_end", (_event, ctx) => {
		latestContext = ctx;
		inFlightToolCalls = Math.max(0, inFlightToolCalls - 1);
	});
	pi.on("agent_settled", (_event, ctx) => {
		latestContext = ctx;
		// Fully settled is the lifecycle authority that no tool can remain active;
		// clear a defensive leak if an aborted tool omitted its end event. Cache
		// warmth is per run: a failed/aborted run with no provider response must
		// not reuse an older run's warm-cache deadline for its changed context.
		inFlightToolCalls = 0;
		hasCacheTouch = successfulResponseThisRun;
		if (!compacting && hasCacheTouch) scheduleFromCacheTouch();
	});
	pi.on("session_before_compact", (_event, ctx) => {
		latestContext = ctx;
		compacting = true;
		clearScheduled();
	});
	pi.on("session_compact", (event, ctx) => {
		latestContext = ctx;
		lastCompactedContextMarker = event.compactionEntry?.id ?? getContextMarker(ctx.sessionManager);
		lastCompactedTokens = null;
		lastCompactedAtMs = runtime.now();
		if (!idleCompactionRequested) compacting = false;
		clearScheduled();
	});
	pi.on("session_shutdown", () => {
		active = false;
		latestContext = undefined;
		clearScheduled();
	});
}

export { DEFAULT_IDLE_COMPACTION_CONFIG } from "./idle-compaction-policy";
export type { IdleCompactionConfig } from "./idle-compaction-policy";

export default function idleCompactionExtension(pi: IdleCompactionExtensionApi): void {
	registerIdleCompaction(pi);
}
