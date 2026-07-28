/**
 * Captain-facing pending-questions queue.
 *
 * Failure mode this kills: an agent asks a decision question in chat, the
 * captain never sees it, and the effort parks silently forever. Agents call
 * `ask_captain` instead, which writes to a durable shared queue; the captain
 * runs `/questions` in ANY pi session in the same home and clears the backlog
 * in one sitting; the asking session picks its answers back up.
 */
import { Type } from "typebox";
import {
	answer as recordAnswer,
	ask,
	formatAge,
	markDelivered,
	openQuestions,
	pendingAnswersFor,
	queueFile,
	queueMtimeMs,
	readQuestions,
	type Question,
} from "./questions-store";

const POLL_INTERVAL_MS = 15_000;

interface Ui {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	select(title: string, options: string[]): Promise<string | undefined>;
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
}

const defaultRuntime: QuestionsRuntime = {
	now: Date.now,
	setInterval: (callback, ms) => setInterval(callback, ms),
	clearInterval,
};

const DISMISSED = "(dismissed by the captain without an answer)";
/** Control actions, always after the agent's own options and matched by position. */
const CONTROLS = ["Write an answer...", "Dismiss", "Skip", "Stop reviewing"] as const;

/** One question rendered for the captain: everything needed to decide, nothing more. */
export function describe(entry: Question, nowMs: number): string {
	const lines = [
		`[${entry.urgency}] asked ${formatAge(nowMs - entry.askedAt)} ago by session ${entry.sessionId}`,
		`cwd: ${entry.cwd}`,
		"",
		entry.question,
	];
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
): void {
	const file = queueFile(env);
	let poll: ReturnType<typeof setInterval> | undefined;
	let lastSeenMtimeMs: number | null = null;

	/** Hands every undelivered answer for this session back to its agent, once. */
	const deliverAnswers = (ctx: QuestionsContext, triggerTurn: boolean): number => {
		const sessionId = ctx.sessionManager.getSessionId();
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
			"Queue a decision question for the captain in a durable shared queue instead of asking in chat. " +
			"The captain reviews all queued questions with /questions from any pi session; the answer is " +
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
				const picked = await ctx.ui.select(
					`(${index + 1}/${open.length}) ${describe(entry, runtime.now())}`,
					choices,
				);
				if (picked === undefined) break;
				const choice = choices.indexOf(picked);
				if (choice < 0) break;
				const control = choice < options.length ? undefined : CONTROLS[choice - options.length];
				if (control === "Stop reviewing") break;
				if (control === "Skip") continue;
				if (control === "Dismiss") {
					if (resolve(ctx, entry, DISMISSED, "dismissed")) answered += 1;
					continue;
				}
				let text = options[choice] ?? "";
				if (control === "Write an answer...") {
					const written = await ctx.ui.editor(entry.question, entry.recommendation ?? "");
					if (written === undefined || written.trim() === "") continue;
					text = written.trim();
				}
				if (resolve(ctx, entry, text, "answered")) answered += 1;
			}

			// Answers to questions this very session asked are deliverable right away.
			deliverAnswers(ctx, false);
			ctx.ui.notify(
				`Resolved ${answered} of ${open.length} question(s); ${openQuestions(file).length} still open.`,
				"info",
			);
		},
	});

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

	const startPolling = (ctx: QuestionsContext): void => {
		if (poll !== undefined) return;
		poll = runtime.setInterval(() => {
			const mtime = queueMtimeMs(file);
			if (mtime === lastSeenMtimeMs) return;
			lastSeenMtimeMs = mtime;
			// triggerTurn wakes a parked agent: without it, an agent that queued a
			// question and stopped would never learn the answer arrived.
			deliverAnswers(ctx, true);
		}, POLL_INTERVAL_MS);
	};

	pi.on("session_start", (_event, ctx) => {
		// Snapshot the poll baseline BEFORE the delivery read. The other order
		// loses a wake-up: an answer appended between the read and the snapshot
		// would be baked into the baseline as already-seen, so the poll would not
		// fire and a parked asker would wait for an unrelated queue write.
		lastSeenMtimeMs = queueMtimeMs(file);
		// Answers that landed while this session was not running.
		deliverAnswers(ctx, false);
		startPolling(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
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
