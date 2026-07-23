import {
	assertCap,
	CAPS,
	DeckError,
	loadConfig,
	openEffort,
	stageSchema,
	ulid,
} from "@deck/core";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { z } from "zod";
import type { DeckExtensionApi, ToolResult } from "./pi-types";
import { dispatchThroughRouter } from "./router-client";

const extensionEnvSchema = z.looseObject({
	DECK_EFFORT: z.string().min(1).optional(),
	DECK_LEASE_TOKEN: z.string().min(1).optional(),
	DECK_ACTOR: z.string().min(1).optional(),
});

const reportProgressSchema = z.object({
	status: z.string().min(1),
});

const askTimSchema = z.object({
	kind: z.enum(["decision", "cancellation", "flagged", "degraded"]),
	question: z.string().min(1),
	recommendation: z.string().min(1),
	options: z.array(z.string().min(1)).min(1),
	cancel_in_flight: z.string().min(1).optional(),
}).superRefine((value, context) => {
	if (value.kind === "cancellation" && value.cancel_in_flight === undefined) {
		context.addIssue({
			code: "custom",
			path: ["cancel_in_flight"],
			message: "cancel_in_flight is required for cancellation cards",
		});
	}
	if (value.kind !== "cancellation" && value.cancel_in_flight !== undefined) {
		context.addIssue({
			code: "custom",
			path: ["cancel_in_flight"],
			message: "cancel_in_flight is only valid for cancellation cards",
		});
	}
});

const dispatchSchema = z.object({
	kind: z.enum(["workflow", "subagent"]),
	target: z.string().min(1),
	brief: z.string().min(1),
});

const parkSchema = z.object({
	digest: z.string().min(1),
});

const evidenceParamsSchema = z.object({
	label: z.string().min(1),
	ref: z.string().min(1),
	scope: z.enum(["ci", "review", "deploy", "fallout", "other"]),
});

const advanceStageSchema = z.object({
	to: stageSchema,
	expected_revision: z.number().int().nonnegative(),
});

const sessionStartEventSchema = z.looseObject({
	type: z.literal("session_start"),
	reason: z.enum(["startup", "reload", "new", "resume", "fork"]),
});

const messageStartEventSchema = z.looseObject({
	type: z.literal("message_start"),
	message: z.looseObject({
		role: z.string(),
		content: z.unknown().optional(),
	}),
});

const textContentSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
});

const userContentSchema = z.union([z.string(), z.array(z.unknown())]);

const tokenUsageSchema = z.object({
	input: z.number().nonnegative(),
	output: z.number().nonnegative(),
	cacheRead: z.number().nonnegative(),
	cacheWrite: z.number().nonnegative(),
	totalTokens: z.number().nonnegative(),
});

const turnEndEventSchema = z.looseObject({
	type: z.literal("turn_end"),
	turnIndex: z.number().int().nonnegative(),
	message: z.looseObject({
		role: z.string(),
		stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]).optional(),
		usage: z.unknown().optional(),
	}),
});

const commandMarkerSchema = z.string().min(1).regex(/^[^\]\s]+$/);
const commandMarkerPattern = /^\s*\[deck:cmd ([^\]\s]+)\]/;

type LifecycleToolName =
	| "report_progress"
	| "ask_tim"
	| "dispatch"
	| "park"
	| "record_evidence"
	| "advance_stage";

const TOOL_PARAMETERS: Record<LifecycleToolName, TSchema> = {
	report_progress: Type.Object({
		status: Type.String({ description: "Concise progress status, at most 500 characters" }),
	}, { additionalProperties: false }),
	ask_tim: Type.Object({
		kind: Type.Union([
			Type.Literal("decision"),
			Type.Literal("cancellation"),
			Type.Literal("flagged"),
			Type.Literal("degraded"),
		]),
		question: Type.String({ description: "Question for Tim, at most 600 characters" }),
		recommendation: Type.String({ description: "Recommended answer, at most 400 characters" }),
		options: Type.Array(
			Type.String({ description: "Option label, at most 120 characters" }),
			{ minItems: 1, description: "One to five answer options" },
		),
		cancel_in_flight: Type.Optional(Type.String({
			description: "Required only for cancellation cards: the dispatch id to cancel",
		})),
	}, { additionalProperties: false }),
	dispatch: Type.Object({
		kind: Type.Union([Type.Literal("workflow"), Type.Literal("subagent")]),
		target: Type.String(),
		brief: Type.String(),
	}, { additionalProperties: false }),
	park: Type.Object({
		digest: Type.String({ description: "Park digest, at most 2000 characters" }),
	}, { additionalProperties: false }),
	record_evidence: Type.Object({
		label: Type.String(),
		ref: Type.String(),
		scope: Type.Union([
			Type.Literal("ci"),
			Type.Literal("review"),
			Type.Literal("deploy"),
			Type.Literal("fallout"),
			Type.Literal("other"),
		]),
	}, { additionalProperties: false }),
	advance_stage: Type.Object({
		to: Type.Union([
			Type.Literal("intake"),
			Type.Literal("active"),
			Type.Literal("review"),
			Type.Literal("landed"),
			Type.Literal("watching"),
			Type.Literal("done"),
			Type.Literal("abandoned"),
		]),
		expected_revision: Type.Integer({ minimum: 0 }),
	}, { additionalProperties: false }),
};

function result(text: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details };
}

function parseToolParams<T>(tool: string, schema: z.ZodType<T>, input: unknown): T {
	const parsed = schema.safeParse(input);
	if (!parsed.success) {
		throw new DeckError("E_ARG", `${tool} parameters are invalid`, { issues: parsed.error.issues });
	}
	return parsed.data;
}

function extractUserText(content: unknown): string | null {
	const parsed = userContentSchema.safeParse(content);
	if (!parsed.success) {
		return null;
	}
	if (typeof parsed.data === "string") {
		return parsed.data;
	}
	const textParts: string[] = [];
	for (const part of parsed.data) {
		const text = textContentSchema.safeParse(part);
		if (text.success) {
			textParts.push(text.data.text);
		}
	}
	return textParts.join("");
}

function leadingCommandIds(text: string): string[] {
	const ids: string[] = [];
	let remainder = text;
	while (true) {
		const match = commandMarkerPattern.exec(remainder);
		if (match === null) {
			return ids;
		}
		const candidate = match[1];
		if (candidate === undefined) {
			return ids;
		}
		ids.push(commandMarkerSchema.parse(candidate));
		remainder = remainder.slice(match[0].length);
	}
}

export default function registerDeckLifecycle(pi: DeckExtensionApi): void {
	const env = extensionEnvSchema.parse(process.env);
	if (env.DECK_EFFORT === undefined || env.DECK_LEASE_TOKEN === undefined) {
		return;
	}

	const effortId = env.DECK_EFFORT;
	const leaseToken = env.DECK_LEASE_TOKEN;
	const actor = env.DECK_ACTOR ?? "owner";
	const store = openEffort(effortId);
	const pendingCommandIds = new Set<string>();
	let fenced = false;
	let warned = false;

	const warnStaleOwner = (): void => {
		if (warned) {
			return;
		}
		warned = true;
		pi.sendMessage({
			customType: "deck.lease_warning",
			content: "E_LEASE: This Deck owner lease is stale. Stop work and exit; the router will start the current owner.",
			display: true,
			details: { effort_id: effortId },
		}, { triggerTurn: false });
	};

	const leaseIsCurrent = (): boolean => {
		if (fenced) {
			return false;
		}
		if (!store.verifyLease(leaseToken)) {
			fenced = true;
			warnStaleOwner();
			return false;
		}
		return true;
	};

	const assertOwnerLease = (): void => {
		if (!leaseIsCurrent()) {
			throw new DeckError("E_LEASE", "owner lease is stale; exit this process", { effort_id: effortId });
		}
	};

	pi.on("session_start", (event) => {
		const parsed = sessionStartEventSchema.safeParse(event);
		if (!parsed.success) {
			return;
		}
		leaseIsCurrent();
	});

	pi.on("message_start", (event) => {
		const parsed = messageStartEventSchema.safeParse(event);
		if (!parsed.success || parsed.data.message.role !== "user") {
			return;
		}
		const text = extractUserText(parsed.data.message.content);
		if (text === null) {
			return;
		}
		for (const commandId of leadingCommandIds(text)) {
			pendingCommandIds.add(commandId);
		}
	});

	pi.on("turn_end", (event) => {
		const parsed = turnEndEventSchema.safeParse(event);
		if (!parsed.success || !leaseIsCurrent()) {
			return;
		}

		const commandIds = [...pendingCommandIds];
		pendingCommandIds.clear();
		const outcome = parsed.data.message;
		const turnApplied = outcome.role === "assistant"
			&& (outcome.stopReason === "stop" || outcome.stopReason === "toolUse");
		if (turnApplied) {
			const inbox = store.inboxState();
			for (const commandId of commandIds) {
				if (!inbox.some((command) => command.cmd_id === commandId)) {
					throw new DeckError("E_STATE", "unknown inbox command marker", { cmd_id: commandId });
				}
				store.appendEvent({
					plane: "lifecycle",
					type: "lifecycle.ack",
					actor,
					data: { cmd_id: commandId },
					idem: { source: "deck:inbox", external_id: commandId, version: "applied-v1" },
				}, leaseToken);
				store.inboxAck(commandId, leaseToken);
			}
		}

		const usage = tokenUsageSchema.safeParse(outcome.usage);
		store.appendEvent({
			plane: "lifecycle",
			type: "lifecycle.turn_end",
			actor,
			data: {
				turn_index: parsed.data.turnIndex,
				stop_reason: outcome.stopReason ?? null,
				...(usage.success ? { token_usage: usage.data } : {}),
			},
		}, leaseToken);
	});

	pi.registerTool({
		name: "report_progress",
		label: "Report progress",
		description: "Record a concise owner progress update.",
		promptSnippet: "Record a concise effort status update.",
		parameters: TOOL_PARAMETERS.report_progress,
		async execute(_toolCallId, input) {
			assertOwnerLease();
			const params = parseToolParams("report_progress", reportProgressSchema, input);
			assertCap("status", params.status, CAPS.reportProgressStatus);
			const current = store.readManifest();
			const manifest = store.mutate(current.revision, leaseToken, (draft) => ({
				manifest: draft,
				event: {
					plane: "lifecycle",
					type: "lifecycle.progress",
					actor,
					data: { status: params.status },
				},
			}));
			return result("Progress recorded.", { revision: manifest.revision });
		},
	});

	pi.registerTool({
		name: "ask_tim",
		label: "Ask Tim",
		description: "Open a decision or escalation card for Tim.",
		promptSnippet: "Open a concise card when Tim must decide or intervene.",
		parameters: TOOL_PARAMETERS.ask_tim,
		async execute(_toolCallId, input) {
			assertOwnerLease();
			const params = parseToolParams("ask_tim", askTimSchema, input);
			assertCap("question", params.question, CAPS.askTimQuestion);
			assertCap("recommendation", params.recommendation, CAPS.askTimRecommendation);
			if (params.options.length > CAPS.askTimMaxOptions) {
				throw new DeckError(
					"E_TOO_LONG",
					`options has ${params.options.length} entries; limit ${CAPS.askTimMaxOptions}. Compress and retry.`,
					{ field: "options", limit: CAPS.askTimMaxOptions, length: params.options.length },
				);
			}
			for (const [index, option] of params.options.entries()) {
				assertCap(`options[${index}]`, option, CAPS.askTimOptionLabel);
			}
			const cardId = ulid();
			const current = store.readManifest();
			const manifest = store.mutate(current.revision, leaseToken, (draft) => {
				draft.cards.push({
					id: cardId,
					card: {
						kind: params.kind,
						question: params.question,
						recommendation: params.recommendation,
						options: params.options,
					},
					status: "open",
					answer: null,
					answered_ts: null,
					cancel_in_flight: params.cancel_in_flight ?? null,
				});
				draft.overlays.needs_tim.push(cardId);
				return {
					manifest: draft,
					event: {
						plane: "lifecycle",
						type: "lifecycle.card",
						actor,
						data: { card_id: cardId, kind: params.kind },
					},
				};
			});
			return result(`Card opened: ${cardId}`, { card_id: cardId, revision: manifest.revision });
		},
	});

	pi.registerTool({
		name: "dispatch",
		label: "Dispatch",
		description: "Dispatch a workflow or subagent through the Deck router.",
		promptSnippet: "Dispatch bounded parallel work through the router.",
		parameters: TOOL_PARAMETERS.dispatch,
		async execute(_toolCallId, input, signal) {
			assertOwnerLease();
			const params = parseToolParams("dispatch", dispatchSchema, input);
			const manifest = store.readManifest();
			const activeDispatches = manifest.dispatches.filter(
				(dispatch) => dispatch.state === "pending" || dispatch.state === "running",
			).length;
			let limit: number;
			try {
				limit = loadConfig().admission.maxDispatchesPerEffort;
			} catch (error) {
				throw new DeckError("E_IO", "cannot load dispatch admission configuration", {
					cause: error instanceof Error ? error.message : String(error),
				});
			}
			if (activeDispatches >= limit) {
				throw new DeckError("E_ADMISSION", "per-effort dispatch limit reached", {
					effort_id: effortId,
					active: activeDispatches,
					limit,
				});
			}
			const dispatched = await dispatchThroughRouter({
				effortId,
				leaseToken,
				kind: params.kind,
				target: params.target,
				brief: params.brief,
			}, signal);
			return result(
				`Dispatch live: ${dispatched.dispatch_id}; session ${dispatched.session.machine}:${dispatched.session.session_id}; lease epoch ${dispatched.session.lease_epoch}.`,
				{ ...dispatched },
			);
		},
	});

	pi.registerTool({
		name: "park",
		label: "Park",
		description: "Persist a rehydration digest and report the owner parked.",
		promptSnippet: "Persist a compact digest before yielding the owner process.",
		parameters: TOOL_PARAMETERS.park,
		async execute(_toolCallId, input) {
			assertOwnerLease();
			const params = parseToolParams("park", parkSchema, input);
			assertCap("digest", params.digest, CAPS.parkDigest);
			const current = store.readManifest();
			const manifest = store.mutate(current.revision, leaseToken, (draft) => {
				draft.digest = params.digest;
				return {
					manifest: draft,
					event: {
						plane: "lifecycle",
						type: "lifecycle.park",
						actor,
						data: { digest: params.digest },
					},
				};
			});
			return { ...result("Owner parked.", { revision: manifest.revision }), terminate: true };
		},
	});

	pi.registerTool({
		name: "record_evidence",
		label: "Record evidence",
		description: "Append an evidence reference to the effort manifest.",
		promptSnippet: "Attach review, CI, deploy, fallout, or other evidence.",
		parameters: TOOL_PARAMETERS.record_evidence,
		async execute(_toolCallId, input) {
			assertOwnerLease();
			const params = parseToolParams("record_evidence", evidenceParamsSchema, input);
			const current = store.readManifest();
			const evidenceTimestamp = Date.now();
			const manifest = store.mutate(current.revision, leaseToken, (draft) => {
				draft.evidence.push({
					ts: evidenceTimestamp,
					label: params.label,
					ref: params.ref,
					by: "agent",
					scope: params.scope,
				});
				return {
					manifest: draft,
					event: {
						plane: "lifecycle",
						type: "lifecycle.evidence",
						actor,
						data: { label: params.label, ref: params.ref, scope: params.scope },
					},
				};
			});
			return result("Evidence recorded.", { revision: manifest.revision });
		},
	});

	pi.registerTool({
		name: "advance_stage",
		label: "Advance stage",
		description: "CAS the effort to a new lifecycle stage.",
		promptSnippet: "Advance the effort stage with its expected manifest revision.",
		parameters: TOOL_PARAMETERS.advance_stage,
		async execute(_toolCallId, input) {
			assertOwnerLease();
			const params = parseToolParams("advance_stage", advanceStageSchema, input);
			const manifest = store.mutate(params.expected_revision, leaseToken, (draft) => {
				const from = draft.stage;
				draft.stage = params.to;
				return {
					manifest: draft,
					event: {
						plane: "lifecycle",
						type: "lifecycle.stage",
						actor,
						data: { from, to: params.to },
					},
				};
			});
			return result(`Stage advanced to ${manifest.stage}.`, { revision: manifest.revision, stage: manifest.stage });
		},
	});
}

export type { DeckExtensionApi };
