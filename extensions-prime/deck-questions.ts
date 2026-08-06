/**
 * Deck questions has exactly two workflow answer lanes:
 * 1. `smithers-approval` is submitted only by a human selecting an action in
 *    the interactive `/questions` command. The model-callable answer tool
 *    cannot advance an Approval node.
 * 2. `store` appends an answer for the owning run to hydrate.
 *
 * Both lanes are declared by the workflow question record. Presentation text
 * never grants approval authority or changes the route.
 */
import { Type } from "typebox";
import {
	answer as recordAnswer,
	openQuestions,
	queueFile,
	readQuestionHistory,
	type Question,
} from "../v2/src/questions-store";
import { routeWorkflowQuestionAnswer } from "../v2/src/workflow-questions";
import {
	QUESTIONS_POLL_INTERVAL_MS,
	registerQuestions,
	type QuestionsExtensionApi,
	type QuestionsRuntime,
} from "../v2/src/questions";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
};


type DeckQuestionsApi = QuestionsExtensionApi;

type QuestionsIntervalHandle = Parameters<QuestionsRuntime["clearInterval"]>[0];
const text = (body: string, details: Record<string, unknown> = {}): ToolResult => ({
	content: [{ type: "text", text: body }],
	details,
});

function questionSummary(question: Question): Record<string, unknown> {
	return {
		id: question.id,
		status: question.status,
		urgency: question.urgency,
		question: question.question,
		...(question.questionKind === undefined ? {} : { questionKind: question.questionKind }),
		...(question.origin === undefined ? {} : { origin: question.origin }),
		...(question.prContext === undefined ? {} : { prContext: question.prContext }),
		...(question.workflow === undefined ? {} : { workflow: question.workflow }),
		...(question.context === undefined ? {} : { context: question.context }),
		...(question.options === undefined ? {} : { options: question.options }),
		...(question.actions === undefined ? {} : { actions: question.actions }),
		...(question.recommendation === undefined ? {} : { recommendation: question.recommendation }),
		...(question.answer === undefined ? {} : { answer: question.answer }),
		askedAt: question.askedAt,
		sessionId: question.sessionId,
		cwd: question.cwd,
	};
}

export function setQuestionsStatus(ctx: unknown, file: string): number {
	const count = openQuestions(file).length;
	let ui: unknown;
	if (typeof ctx === "object" && ctx !== null && "ui" in ctx) ui = ctx.ui;
	if (typeof ui === "object" && ui !== null && "setStatus" in ui && typeof ui.setStatus === "function") {
		ui.setStatus("deck-questions", count === 0 ? undefined : `${count}?`);
	}
	return count;
}

/** Register only Deck's durable question queue surface. */
export function registerDeckQuestions(
	agent: DeckQuestionsApi,
	env: Record<string, string | undefined> = process.env,
	runtime?: QuestionsRuntime,
): void {
	const file = queueFile(env);
	let latestStatusContext: unknown;
	let statusPoll: QuestionsIntervalHandle | undefined;

	// Preserve the proven interactive /questions flow and answer delivery while
	// decorating its ask tool and command with the standalone status chip.
	const questionsApi: QuestionsExtensionApi = {
		registerTool(tool) {
			agent.registerTool({
				...tool,
				async execute(...args) {
					const result = await tool.execute(...args);
					setQuestionsStatus(args[4], file);
					return result;
				},
			});
		},
		registerCommand(name, options) {
			agent.registerCommand(name, {
				...options,
				async handler(args, ctx) {
					try {
						await options.handler(args, ctx);
					} finally {
						setQuestionsStatus(ctx, file);
					}
				},
			});
		},
		on: (event, handler) => agent.on(event, handler),
		sendMessage: (message, options) => agent.sendMessage(message, options),
	};
	if (runtime === undefined) registerQuestions(questionsApi, env);
	else registerQuestions(questionsApi, env, runtime);

	agent.registerTool({
		name: "list_questions",
		label: "List Questions",
		description: "List queued operator questions without changing the append-only queue.",
		parameters: Type.Object({
			include_resolved: Type.Optional(
				Type.Boolean({ description: "Include answered and dismissed queue history; default false" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = params.include_resolved === true
				? readQuestionHistory(file)
				: openQuestions(file);
			setQuestionsStatus(ctx, file);
			const rows = questions.map(questionSummary);
			return text(
				rows.length === 0 ? "No queued questions." : JSON.stringify(rows, null, 2),
				{ file, questions: rows },
			);
		},
	});

	agent.registerTool({
		name: "answer_question",
		label: "Answer Question",
		description:
			"Answer a plain open question. Workflow approvals are human-only and must be resolved through the interactive /questions command.",
		parameters: Type.Object({
			id: Type.String({ description: "Queued question id", minLength: 1, maxLength: 512 }),
			answer: Type.String({ description: "Operator answer or workflow action", minLength: 1, maxLength: 7000 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const id = String(params.id).trim();
			const answer = String(params.answer).trim();
			if (id === "") throw new Error("answer_question needs a question id");
			if (answer === "") throw new Error("answer_question needs a non-empty answer");
			const entry = openQuestions(file).find((question) => question.id === id);
			if (entry === undefined) {
				const existing = readQuestionHistory(file).find((question) => question.id === id);
				throw new Error(existing === undefined
					? `question ${id} does not exist`
					: `question ${id} is already ${existing.status}`);
			}
			if (entry.workflow?.answerLane === "smithers-approval") {
				throw new Error(
					"workflow approvals require the interactive /questions command; answer_question cannot advance a Smithers gate",
				);
			}
			const routed = entry.workflow === undefined
				? undefined
				: await routeWorkflowQuestionAnswer(file, entry, answer, {
						env,
						...(runtime === undefined
							? {}
							: { now: runtime.now, ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }) }),
					});
			if (routed?.choice === "hold") {
				const open = setQuestionsStatus(ctx, file);
				return text(`Held question ${id}; it remains open (${open} open in the queue).`, {
					id,
					open,
					file,
					lane: routed.lane,
					choice: routed.choice,
				});
			}
			const applied = routed?.applied ?? recordAnswer(file, id, answer);
			if (!applied) {
				const existing = readQuestionHistory(file).find((question) => question.id === id);
				throw new Error(`question ${id} is already ${existing?.status ?? "resolved"}`);
			}
			const open = setQuestionsStatus(ctx, file);
			return text(`Answered question ${id} (${open} open in the queue).`, {
				id,
				open,
				file,
				...(routed === undefined ? {} : { lane: routed.lane, choice: routed.choice }),
			});
		},
	});

	const refreshStatus = (_event: unknown, ctx: unknown): void => {
		latestStatusContext = ctx;
		setQuestionsStatus(ctx, file);
	};
	agent.on("session_start", (_event, ctx) => {
		refreshStatus(_event, ctx);
		if (statusPoll !== undefined) return;
		const clock = runtime ?? {
			setInterval: (callback: () => void, ms: number) => setInterval(callback, ms),
		};
		statusPoll = clock.setInterval(() => {
			try {
				setQuestionsStatus(latestStatusContext, file);
			} catch {
				// Status chrome is best-effort; queue tools remain available.
			}
		}, QUESTIONS_POLL_INTERVAL_MS);
		statusPoll.unref?.();
	});
	agent.on("agent_settled", refreshStatus);
	agent.on("session_shutdown", () => {
		if (statusPoll !== undefined) {
			if (runtime === undefined) clearInterval(statusPoll);
			else runtime.clearInterval(statusPoll);
		}
		statusPoll = undefined;
		latestStatusContext = undefined;
	});
}

export default function deckQuestions(agent: DeckQuestionsApi): void {
	registerDeckQuestions(agent);
}
