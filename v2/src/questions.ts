/**
 * Durable question queue surface shared by plain Deck pi sessions.
 *
 * The standalone deck-questions entrypoint registers this module only in
 * ~/.deck/.pi. Smithers pipeline seats do not load it, so there is one
 * captain-facing queue rather than a competing question channel per worker.
 */
import { Type } from "typebox";
import { Box, SelectList, Text } from "@earendil-works/pi-tui";
import { pipelineDir } from "./ship";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	answer as recordAnswer,
	ask,
	formatAge,
	importLegacyQueue,
	legacyQueueFile,
	markDelivered,
	openQuestions,
	pendingAnswersFor,
	queueFile,
	queueMtimeMs,
	readQuestions,
	readQuestionHistory,
	type Question,
} from "./questions-store";
import {
	routeWorkflowQuestionAnswer,
	workflowRunIsTerminal,
	type WorkflowAnswerChoice,
} from "./workflow-questions";

// Polling audit: before this change the fleet overlay polled every 5s (12/min)
// and the wake reconciler every 30s (2/min), in addition to this queue poll
// every 15s (4/min): 18 periodic wake checks/min across these surfaces. The
// overlay and reconciler polls are now event-driven, leaving one queue poll at
// 4/min. This coalesces redundant periodic checks without changing delivery.
export const QUESTIONS_POLL_INTERVAL_MS = 15_000;

interface Ui {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	select(title: string, options: string[]): Promise<string | undefined>;
	custom?<T>(factory: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => any, options?: { overlay?: boolean; overlayOptions?: { maxHeight?: string } }): Promise<T>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
}

interface QuestionsContext {
	hasUI: boolean;
	cwd: string;
	ui: Ui;
	sessionManager: { getSessionId(): string };
}

export interface QuestionsExtensionApi {
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters: unknown;
		execute(
			toolCallId: string,
			params: any,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: QuestionsContext,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
	}): void;
	registerCommand(
		name: string,
		options: { description: string; handler(args: string, ctx: QuestionsContext): Promise<void> },
	): void;
	on(event: string, handler: (event: any, ctx: QuestionsContext) => Promise<void> | void): void;
	sendMessage(
		message: { customType: string; content: string; display: boolean; details?: unknown },
		options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
	): void;
}

export interface QuestionsRuntime {
	now(): number;
	setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
	clearInterval(handle: ReturnType<typeof setInterval>): void;
	fetch?(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

const defaultRuntime: QuestionsRuntime = {
	now: Date.now,
	setInterval: (callback, ms) => setInterval(callback, ms),
	clearInterval,
};

const DISMISSED = "(dismissed by the captain without an answer)";
export function parseStampGateId(id: string): { runId?: string; node: string } {
	const scoped = id.includes("deck-fleet:") ? id.slice(id.indexOf("deck-fleet:") + "deck-fleet:".length) : id;
	const raw = scoped.startsWith("stamp:") ? scoped : "";
	if (raw.startsWith("stamp:gateway:")) {
		const rest = raw.slice("stamp:gateway:".length);
		const marker = rest.indexOf(":stamp:");
		if (marker < 1) return { runId: undefined, node: "r0-stamp" };
		const runId = rest.slice(0, marker);
		const tail = rest.slice(marker + ":stamp:".length).split(":");
		if (/^\d+$/.test(tail.at(-1) ?? "")) tail.pop();
		return { runId, node: tail.join(":") || "r0-stamp" };
	}
	const markerIndex = raw.indexOf(":stamp:", "stamp:".length);
	if (raw === "" || markerIndex < 0) return { runId: undefined, node: "r0-stamp" };
	const tail = raw.slice(markerIndex + ":stamp:".length);
	const separator = tail.indexOf(":");
	if (separator < 1) return { runId: undefined, node: "r0-stamp" };
	return { runId: tail.slice(0, separator), node: tail.slice(separator + 1) || "r0-stamp" };
}
/** Control actions, always after the agent's own options and matched by position. */
const CONTROLS = ["Write an answer...", "Dismiss", "Skip", "Stop reviewing"] as const;
const exec = promisify(execFile);
type CommandExecutor = (command: string, args: string[], options: { cwd: string; timeout: number }) => Promise<unknown>;

/** One question rendered for the captain: everything needed to decide, nothing more. */
export function describe(entry: Question, nowMs: number): string {
	const lines = [
		`[${entry.urgency}] asked ${formatAge(nowMs - entry.askedAt)} ago by session ${entry.sessionId}`,
		`cwd: ${entry.cwd}`,
	];
	const pr = entry.prContext;
	if (pr !== undefined) {
		lines.push(
			"",
			pr.prRepo !== undefined && pr.prNumber !== undefined
				? `PR URL: https://github.com/${pr.prRepo}/pull/${pr.prNumber}`
				: "PR URL: unavailable",
			`Target: ${pr.prRepo ?? "unknown"}#${pr.prNumber ?? "unknown"}@${pr.headSha ?? "unknown"}`,
			`PR title: ${pr.prTitle ?? "untitled"}`,
			`Repository: ${pr.prRepo ?? "unknown"}`,
			"",
			`THE ORIGINAL ISSUE (AGENT CLAIM): ${pr.originalIssue ?? "Not recorded."}`,
			`OUR FIX (AGENT CLAIM): ${pr.ourFix ?? "Not recorded."}`,
			`WHY IT IS CORRECT (AGENT CLAIM): ${pr.whyCorrect ?? "No evidence recorded."}`,
			`CI: ${pr.ciState ?? "unknown"}`,
			`mergeStateStatus: ${pr.mergeStateStatus ?? "unknown"}`,
		);
	}
	const workflow = entry.workflow;
	if (workflow !== undefined) {
		lines.push(
			"",
			`Workflow wait: run ${workflow.runId}; node ${workflow.nodeId}; PR #${workflow.prNumber ?? "pending"}`,
			`Answer lane: ${workflow.answerLane}`,
			`ORIGINAL ISSUE: ${workflow.originalIssue}`,
			`PROPOSED ACTION: ${workflow.proposedAction}`,
			`BLAST RADIUS: ${workflow.blastRadius}`,
			`Resume: ${workflow.resumeHint}`,
		);
	}
	lines.push("", entry.question);
	if (entry.context !== undefined) lines.push("", `context: ${entry.context}`);
	if (entry.recommendation !== undefined) lines.push("", `agent recommends: ${entry.recommendation}`);
	return lines.join("\n");
}

/** Text handed back to the asking agent for one resolved question. */
export function answerMessage(entry: Question): string {
	return [
		`Captain answered your queued question (${entry.id}):`,
		`Q: ${entry.question}`,
		`A: ${entry.status === "dismissed" ? DISMISSED : entry.answer ?? ""}`,
	].join("\n");
}

export function registerQuestions(
	pi: QuestionsExtensionApi,
	env: Record<string, string | undefined> = process.env,
	runtime: QuestionsRuntime = defaultRuntime,
	executor: CommandExecutor = exec as unknown as CommandExecutor,
): void {
	const file = queueFile(env);
	let poll: ReturnType<typeof setInterval> | undefined;
	/** Latest live session id, refreshed by session events (see startPolling). */
	let latestSessionId: string | undefined;
	let lastSeenMtimeMs: number | null = null;

	/** Hands every undelivered answer for this session back to its agent, once. */
	const deliverAnswers = (
		source: QuestionsContext | { sessionId: string },
		triggerTurn: boolean,
	): number => {
		const sessionId =
			"sessionId" in source ? source.sessionId : source.sessionManager.getSessionId();
		const pending = pendingAnswersFor(file, sessionId);
		let delivered = 0;
		for (const entry of pending) {
			// Send BEFORE marking. The failure this ordering picks: a crash between
			// the two lines re-delivers one answer, which is merely noisy, whereas
			// marking first would drop that answer permanently and silently park
			// the agent forever - exactly the failure this extension exists to kill.
			pi.sendMessage(
				{
					customType: "deck.captain-answer",
					content: answerMessage(entry),
					display: true,
					details: { id: entry.id, status: entry.status },
				},
				{ deliverAs: "followUp", triggerTurn },
			);
			markDelivered(file, entry.id, runtime.now());
			delivered += 1;
		}
		return delivered;
	};

	pi.registerTool({
		name: "ask_captain",
		label: "Ask Captain",
		description:
			"Queue a decision question for the captain in a durable queue instead of asking in chat. " +
			"The captain reviews all queued questions with /questions; the answer is " +
			"delivered back into this session when they answer. Returns immediately - do not block on it. " +
			"Prefer continuing on any work that does not depend on the answer.",
		promptSnippet: "Queue a decision question for the captain without blocking this session",
		promptGuidelines: [
			"Use ask_captain when a decision needs the captain and the chat message would otherwise be missed; keep working on independent parts instead of waiting.",
		],
		// Lengths are bounded at the schema boundary AND again in the store. Every
		// pi session sharing this queue folds the whole log on every poll, so an
		// unbounded question would degrade sessions that never asked anything.
		// They are also the practical limits of a question a human reads in a
		// select dialog.
		parameters: Type.Object({
			question: Type.String({
				description: "The decision to make, phrased for a human",
				maxLength: 1000,
			}),
			id: Type.Optional(
				Type.String({
					description: "Stable id; reusing one refreshes that question",
					maxLength: 128,
				}),
			),
			context: Type.Optional(
				Type.String({ description: "Background the captain needs", maxLength: 2000 }),
			),
			options: Type.Optional(
				Type.Array(Type.String({ maxLength: 200 }), {
					description: "Concrete choices the captain can pick",
					maxItems: 12,
				}),
			),
			recommendation: Type.Optional(
				Type.String({ description: "What you would do absent an answer", maxLength: 1000 }),
			),
			// Plain string, normalized in the store: an enum here would need
			// pi-ai's StringEnum for Google compatibility, and one severity word is
			// not worth a second import to resolve at extension load.
			urgency: Type.Optional(Type.String({ description: "low | normal | high (default normal)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const event = ask(file, {
				id: params.id,
				question: params.question,
				context: params.context,
				options: params.options,
				recommendation: params.recommendation,
				urgency: params.urgency,
				sessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				now: runtime.now(),
			});
			const waiting = openQuestions(file).length;
			if (ctx.hasUI) ctx.ui.notify(`Queued question for the captain (${waiting} open)`, "info");
			return {
				content: [
					{
						type: "text",
						text: `Queued question ${event.id} for the captain (${waiting} open in the queue). The answer arrives in this session once they run /questions.`,
					},
				],
				details: { id: event.id, open: waiting, file },
			};
		},
	});

	pi.registerCommand("questions", {
		description: "Review and answer all queued agent questions",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const delivered = deliverAnswers(ctx, false);
			const open = openQuestions(file);
			if (open.length === 0) {
				ctx.ui.notify(
					delivered > 0
						? `No open questions; delivered ${delivered} answer(s) to this session.`
						: `No open questions. Queue: ${file}`,
					"info",
				);
				return;
			}

			let answered = 0;
			for (const [index, entry] of open.entries()) {
				// Choices are matched by POSITION, never by display string: an agent is
				// free to offer an option literally named "Dismiss" or "Skip", and
				// comparing labels would silently turn picking it into a control action.
				// Numbering the agent's options also keeps duplicate options selectable.
				const options = entry.options ?? [];
				const choices = [
					...options.map((option, position) => `${position + 1}. ${option}`),
					...CONTROLS,
				];
				const title = `(${index + 1}/${open.length}) ${describe(entry, runtime.now())}`;
				const picked = ctx.ui.custom === undefined
					? await ctx.ui.select(title, choices)
					: await ctx.ui.custom<string | undefined>((tui, rawTheme, _keybindings, done) => {
						const theme = rawTheme as { fg?: (name: string, value: string) => string };
						const selectTheme = {
							selectedPrefix: (value: string) => theme.fg?.("accent", value) ?? value,
							selectedText: (value: string) => theme.fg?.("accent", value) ?? value,
							description: (value: string) => theme.fg?.("muted", value) ?? value,
							scrollInfo: (value: string) => theme.fg?.("dim", value) ?? value,
							noMatch: (value: string) => theme.fg?.("warning", value) ?? value,
						};
						const list = new SelectList(
							choices.map((value) => ({ value, label: value })),
							Math.min(choices.length, Math.max(1, (tui.terminal?.rows ?? 40) - 10)),
							selectTheme,
						);
						list.onSelect = (item) => done(item.value);
						list.onCancel = () => done(undefined);
						const box = new Box(1, 1);
						box.addChild(new Text(title, 0, 0));
						box.addChild(list);
						return {
							render: (width: number) => box.render(width),
							invalidate: () => box.invalidate(),
							handleInput: (data: string) => {
								// Preserve the selector's vi navigation in the custom component.
								// SelectList handles the configured arrows; these aliases are
								// translated to the same terminal sequences.
								// The built-in selector accepts both the configured confirm key and a
								// literal newline from pasted or line-oriented terminal input.
								// Keep that compatibility in the overlay component.
								const normalized = data === "\n" ? "enter" : data;
								if (normalized === "enter") {
									done(list.getSelectedItem()?.value);
									return;
								}
								// Keep the built-in selector's tool-expansion binding from
								// becoming an accidental selection or answer.
								if (data === "\u000f") return;
								list.handleInput(data === "j" ? "\u001b[B" : data === "k" ? "\u001b[A" : data);
								tui.requestRender();
							},
						};
					}, { overlay: true, overlayOptions: { maxHeight: "90%" } });
				if (picked === undefined) break;
				const choice = choices.indexOf(picked);
				if (choice < 0) break;
				const control = choice < options.length ? undefined : CONTROLS[choice - options.length];
				if (control === "Stop reviewing") break;
				if (control === "Skip") continue;
				if (control === "Dismiss") {
					if (entry.workflow === undefined) {
						if (resolve(ctx, entry, DISMISSED, "dismissed")) answered += 1;
						continue;
					}
					try {
						const terminal = await workflowRunIsTerminal(entry, {
							env,
							...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
						});
						if (terminal) {
							if (resolve(ctx, entry, DISMISSED, "dismissed")) answered += 1;
						} else {
							ctx.ui.notify(
								"Workflow decisions cannot be dismissed while their wait is active; choose Hold, approve/deny the gate, or answer the plain decision.",
								"warning",
							);
						}
					} catch (error) {
						ctx.ui.notify(
							`Workflow status could not be verified; the question remains open: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}
					continue;
				}
				let text = options[choice] ?? "";
				if (control === "Write an answer...") {
					const written = await ctx.ui.editor(entry.question, entry.recommendation ?? "");
					if (written === undefined || written.trim() === "") continue;
					text = written.trim();
				}
				let applied = false;
				const selectedOption = control === undefined ? choice : -1;
				const selectedLabel = control === undefined ? text : undefined;
				const action = selectedOption >= 0 ? entry.actions?.[selectedOption] : undefined;
				if (action === "hold") continue;
				const trustedStamp = entry.questionKind === "stamp" && entry.origin === "fleet";
				const trustedReviewGate = entry.origin === "review-gate" && entry.prContext !== undefined;
				if (entry.workflow !== undefined) {
					const choiceOverride: WorkflowAnswerChoice | undefined =
						action === "stamp" || action === "approve"
							? "approve"
							: action === "deny-gate"
								? "deny"
								: undefined;
					try {
						const routed = await routeWorkflowQuestionAnswer(
							file,
							entry,
							text,
							{
								env,
								now: runtime.now,
								...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
							},
							choiceOverride,
						);
						applied = routed.applied;
					} catch (error) {
						ctx.ui.notify(
							`Workflow decision was not recorded; the question remains open: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}
				} else if ((action === "stamp" && trustedStamp || action === undefined && trustedStamp && selectedLabel === "Stamp")) {
					applied = await approveStamp(ctx, entry);
				} else if ((action === "approve" && trustedReviewGate || action === undefined && trustedReviewGate && entry.questionKind === "approve" && selectedLabel === "Approve")) {
					applied = await approvePullRequest(ctx, entry);
				} else if ((action === "deny-gate" && (trustedStamp || trustedReviewGate) || action === undefined && trustedStamp && selectedLabel === "Close")) {
					applied = await closeStamp(ctx, entry);
				} else if ((action === "close-pr" && trustedReviewGate || action === undefined && trustedReviewGate && entry.questionKind === "agent" && selectedLabel === "Close")) {
					applied = await closePullRequest(ctx, entry);
				} else {
					applied = resolve(ctx, entry, text, "answered");
				}
				if (applied) answered += 1;
			}

			// Answers to questions this very session asked are deliverable right away.
			deliverAnswers(ctx, false);
			ctx.ui.notify(
				`Resolved ${answered} of ${open.length} question(s); ${openQuestions(file).length} still open.`,
				"info",
			);
		},
	});

	const closeStamp = async (ctx: QuestionsContext, entry: Question): Promise<boolean> => {
		const { runId, node } = parseStampGateId(entry.id);
		if (runId === undefined) {
			ctx.ui.notify("Stamp close needs a valid pipeline gate.", "error");
			return false;
		}
		try {
			await executor("smithers", ["deny", runId, "--node", node, "--by", "captain"], { cwd: entry.prContext?.workflowDir ?? pipelineDir(), timeout: 15_000 });
			return resolve(ctx, entry, "Close", "answered");
		} catch (error) {
			ctx.ui.notify(`Stamp was not closed: ${error instanceof Error ? error.message : "unknown error"}`, "error");
			return false;
		}
	};

	const closePullRequest = async (ctx: QuestionsContext, entry: Question): Promise<boolean> => {
		const pr = entry.prContext;
		if (pr?.prNumber === undefined || pr.prRepo === undefined || pr.headSha === undefined) {
			ctx.ui.notify("Closing needs a PR number, repository, and reviewed head.", "error");
			return false;
		}
		try {
			const current = await executor("gh", ["pr", "view", String(pr.prNumber), "--repo", pr.prRepo, "--json", "headRefOid"], { cwd: ctx.cwd, timeout: 15_000 });
			const value = typeof current === "object" && current !== null && "stdout" in current ? JSON.parse(String((current as { stdout: unknown }).stdout)) : current;
			if (typeof value !== "object" || value === null || String((value as { headRefOid?: unknown }).headRefOid) !== pr.headSha) {
				ctx.ui.notify("Close stopped because the PR head changed or could not be verified.", "warning");
				return false;
			}
			await executor("gh", ["pr", "close", String(pr.prNumber), "--repo", pr.prRepo], { cwd: ctx.cwd, timeout: 15_000 });
			const { runId, node } = parseStampGateId(entry.id);
			if (runId !== undefined) {
				await executor("smithers", ["deny", runId, "--node", node, "--by", "captain"], { cwd: entry.prContext?.workflowDir ?? pipelineDir(), timeout: 15_000 });
			}
			return resolve(ctx, entry, "Close", "answered");
		} catch (error) {
			ctx.ui.notify(`PR was not closed: ${error instanceof Error ? error.message : "unknown error"}`, "error");
			return false;
		}
	};

	const approvePullRequest = async (ctx: QuestionsContext, entry: Question): Promise<boolean> => {
		const pr = entry.prContext;
		if (pr?.prNumber === undefined || pr.prRepo === undefined || pr.headSha === undefined) {
			ctx.ui.notify("Approval needs a PR number, repository, and reviewed head.", "error");
			return false;
		}
		try {
			const current = await executor("gh", ["pr", "view", String(pr.prNumber), "--repo", pr.prRepo, "--json", "headRefOid,mergeable,mergeStateStatus,statusCheckRollup"], { cwd: ctx.cwd, timeout: 15_000 });
			const currentValue = typeof current === "object" && current !== null && "stdout" in current
				? JSON.parse(String((current as { stdout: unknown }).stdout))
				: current;
			const currentSha = typeof currentValue === "object" && currentValue !== null && "headRefOid" in currentValue
				? String((currentValue as { headRefOid: unknown }).headRefOid)
				: "";
			const checks = typeof currentValue === "object" && currentValue !== null && Array.isArray((currentValue as { statusCheckRollup?: unknown }).statusCheckRollup)
				? (currentValue as { statusCheckRollup: Array<{ conclusion?: unknown; state?: unknown; status?: unknown }> }).statusCheckRollup
				: [];
			const mergeable = typeof currentValue === "object" && currentValue !== null ? String((currentValue as { mergeable?: unknown }).mergeable).toUpperCase() : "UNKNOWN";
			const mergeState = typeof currentValue === "object" && currentValue !== null ? String((currentValue as { mergeStateStatus?: unknown }).mergeStateStatus).toUpperCase() : "UNKNOWN";
			const checkStates = checks.map((check) => String(check.conclusion || check.status || check.state).toUpperCase());
			const safeChecks = checks.length === 0 || checkStates.every((state) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(state));
			const unsafe = mergeable === "UNMERGEABLE" || ["DIRTY", "BEHIND", "UNSTABLE"].includes(mergeState) || !safeChecks;
			if (currentSha !== pr.headSha || unsafe) {
				ctx.ui.notify("Approval stopped because the PR head, CI, or merge state changed. Review it again.", "warning");
				return false;
			}
			await executor("gh", ["pr", "review", String(pr.prNumber), "--repo", pr.prRepo, "--approve"], { cwd: ctx.cwd, timeout: 15_000 });
			return resolve(ctx, entry, "Approve", "answered");
		} catch (error) {
			ctx.ui.notify(`Approval was not recorded: ${error instanceof Error ? error.message : "unknown error"}`, "error");
			return false;
		}
	};

	const approveStamp = async (ctx: QuestionsContext, entry: Question): Promise<boolean> => {
		const pr = entry.prContext;
		if (entry.questionKind === "stamp" && (pr?.prNumber === undefined || pr.prRepo === undefined || pr.headSha === undefined)) {
			ctx.ui.notify("Stamp needs a PR number, repository, and reviewed head. Re-queue this question.", "error");
			return false;
		}
		if (pr?.prNumber !== undefined || pr?.prRepo !== undefined) {
			if (pr.prNumber === undefined || pr.prRepo === undefined || pr.headSha === undefined) {
				ctx.ui.notify("Stamp needs a PR number, repository, and reviewed head.", "error");
				return false;
			}
			try {
				const current = await executor("gh", ["pr", "view", String(pr.prNumber), "--repo", pr.prRepo, "--json", "headRefOid,mergeable,mergeStateStatus,statusCheckRollup"], { cwd: ctx.cwd, timeout: 15_000 });
				const value = typeof current === "object" && current !== null && "stdout" in current ? JSON.parse(String((current as { stdout: unknown }).stdout)) : current;
				const checks = typeof value === "object" && value !== null && Array.isArray((value as { statusCheckRollup?: unknown }).statusCheckRollup) ? (value as { statusCheckRollup: Array<{ conclusion?: unknown; state?: unknown; status?: unknown }> }).statusCheckRollup : [];
				const checkStates = checks.map((check) => String(check.conclusion || check.status || check.state).toUpperCase());
				const safeChecks = checks.length === 0 || checkStates.every((state) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(state));
				const mergeState = typeof value === "object" && value !== null ? String((value as { mergeStateStatus?: unknown }).mergeStateStatus).toUpperCase() : "UNKNOWN";
				const mergeable = typeof value === "object" && value !== null ? String((value as { mergeable?: unknown }).mergeable).toUpperCase() : "UNKNOWN";
				const verified = typeof value === "object" && value !== null && String((value as { headRefOid?: unknown }).headRefOid) === pr.headSha && mergeable !== "UNMERGEABLE" && !["DIRTY", "BEHIND", "UNSTABLE"].includes(mergeState) && safeChecks;
				if (!verified) {
					ctx.ui.notify("Stamp stopped because the PR head, CI, or merge state changed. Review it again.", "warning");
					return false;
				}
			} catch (error) {
				ctx.ui.notify(`Stamp was not verified: ${error instanceof Error ? error.message : "unknown error"}`, "error");
				return false;
			}
		}
		const { runId, node } = parseStampGateId(entry.id);
		if (runId === undefined) {
			ctx.ui.notify("Stamp needs a valid pipeline gate.", "error");
			return false;
		}
		try {
			try {
				await executor("smithers", ["approve", runId, "--node", node, "--by", "captain"], { cwd: entry.prContext?.workflowDir ?? pipelineDir(), timeout: 15_000 });
			} catch (error) {
				// Approval is idempotent for this recovery path. A retry after the
				// approval succeeded but resume failed reports the gate as no longer
				// pending; continue to resume instead of asking for approval twice.
				const message = error instanceof Error ? error.message : String(error);
				if (!/(?:approval|gate)\s+(?:is\s+)?(?:already\s+approved|already\s+resolved)|already\s+approved|approval\s+is\s+not\s+pending|gate\s+is\s+not\s+pending/i.test(message)) throw error;
			}
			const workflowDir = entry.prContext?.workflowDir ?? pipelineDir();
			const workflowFile = entry.prContext?.workflowFile ?? "pipeline.tsx";
			await executor("smithers", ["up", workflowFile, "--run-id", runId, "--resume", "true"], { cwd: workflowDir, timeout: 15_000 });
			return resolve(ctx, entry, "Stamp", "answered");
		} catch (error) {
			ctx.ui.notify(`Stamp was not recorded; the pipeline remains actionable: ${error instanceof Error ? error.message : "unknown error"}`, "error");
			return false;
		}
	};

	/** Records one resolution, telling the captain when another session got there first. */
	const resolve = (
		ctx: QuestionsContext,
		entry: Question,
		text: string,
		status: "answered" | "dismissed",
	): boolean => {
		const applied = recordAnswer(file, entry.id, text, status, runtime.now());
		const stored = readQuestions(file).find((q) => q.id === entry.id)?.answer;
		if (applied && stored !== undefined && stored !== text) {
			// Silently clipping the captain's words would be worse than saying so.
			ctx.ui.notify(`Answer was too long and was truncated: ${entry.question}`, "warning");
		}
		if (!applied) {
			ctx.ui.notify(
				`Already resolved elsewhere, your answer was not applied: ${entry.question}`,
				"warning",
			);
		}
		return applied;
	};

	/**
	 * The poll must NOT capture the session_start ctx.
	 *
	 * A captured ctx dies with its session: after ctx.newSession(), fork(),
	 * switchSession() or reload(), pi rejects it as "stale after session
	 * replacement" and every later poll throws instead of delivering an answer —
	 * which parks the asking agent forever, the exact failure this extension
	 * exists to prevent. Only the session id is actually needed, so the poll reads
	 * the latest one recorded by a live event.
	 */
	const startPolling = (): void => {
		if (poll !== undefined) return;
		poll = runtime.setInterval(() => {
			if (latestSessionId === undefined) return;
			const mtime = queueMtimeMs(file);
			if (mtime === lastSeenMtimeMs) return;
			lastSeenMtimeMs = mtime;
			// triggerTurn wakes a parked agent: without it, an agent that queued a
			// question and stopped would never learn the answer arrived.
			deliverAnswers({ sessionId: latestSessionId }, true);
		}, QUESTIONS_POLL_INTERVAL_MS);
	};

	pi.on("session_start", (_event, ctx) => {
		// Before anything reads the queue, pull still-open questions out of the
		// legacy pi-home queue once. Never compact the live queue here: plain Deck
		// sessions are concurrent appenders, so startup must remain append-only.
		//
		// The import is gated: it renames the legacy file under the PI HOME, which
		// is live state. It runs only when the caller explicitly points at a pi
		// home (PI_CONFIG_DIR, tests) or when nothing at all is overridden (a
		// normal Deck session). A partially-overridden env — a test that redirects
		// the deck side but not the pi side — must never reach the live ~/.pi.
		const importSafe =
			env.PI_CONFIG_DIR !== undefined ||
			(env.DECK_QUESTIONS_FILE === undefined && process.env.DECK_V2_HOME === undefined);
		try {
			if (importSafe) importLegacyQueue(file, legacyQueueFile(env), runtime.now());
		} catch {
			// Legacy import is best-effort; the live queue remains usable.
		}
		// More than one questions hook runs at session start; a test or RPC ctx
		// may not carry a session manager, and hygiene above already ran.
		if (ctx?.sessionManager === undefined) return;
		// Refreshed on every session event so the poll never holds a dead ctx.
		latestSessionId = ctx.sessionManager.getSessionId();
		// Snapshot the poll baseline BEFORE the delivery read. The other order
		// loses a wake-up: an answer appended between the read and the snapshot
		// would be baked into the baseline as already-seen, so the poll would not
		// fire and a parked asker would wait for an unrelated queue write.
		lastSeenMtimeMs = queueMtimeMs(file);
		// Answers that landed while this session was not running.
		deliverAnswers(ctx, false);
		startPolling();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx?.sessionManager === undefined) return;
		latestSessionId = ctx.sessionManager.getSessionId();
		lastSeenMtimeMs = queueMtimeMs(file);
		deliverAnswers(ctx, true);
	});

	pi.on("session_shutdown", () => {
		if (poll !== undefined) runtime.clearInterval(poll);
		poll = undefined;
	});
}

export default function questionsExtension(pi: QuestionsExtensionApi): void {
	registerQuestions(pi);
}
