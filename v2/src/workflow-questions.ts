import {
	answer as recordAnswer,
	readQuestionHistory,
	readQuestions,
	type Question,
} from "./questions-store";

export type WorkflowAnswerChoice = "approve" | "deny" | "hold";

export interface WorkflowAnswerResult {
	lane: "smithers-approval" | "store";
	choice?: WorkflowAnswerChoice;
	applied: boolean;
}

export interface WorkflowApprovalRuntime {
	env?: Record<string, string | undefined>;
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	now?: () => number;
}


/** Strictly maps answer-tool text onto the three workflow approval actions. */
export function workflowAnswerChoice(text: string): WorkflowAnswerChoice | undefined {
	const normalized = text.trim().toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ");
	if (["approve", "approved", "stamp", "yes"].includes(normalized)) return "approve";
	if (["deny", "denied", "deny gate", "close"].includes(normalized)) return "deny";
	if (normalized === "hold") return "hold";
	return undefined;
}

/**
 * Submit a workflow-owned approval through the authenticated Gateway API.
 * The queue is not resolved until this request succeeds; failed transport can
 * therefore never turn a visible question into a false acknowledgement.
 */
export async function submitWorkflowApproval(
	question: Question,
	approved: boolean,
	note: string,
	runtime: WorkflowApprovalRuntime = {},
): Promise<void> {
	const workflow = question.workflow;
	if (workflow?.answerLane !== "smithers-approval") {
		throw new Error(`question ${question.id} is not a Smithers approval`);
	}
	const env = runtime.env ?? process.env;
	const token = env.SMITHERS_GATEWAY_TOKEN?.trim();
	if (!token) throw new Error("SMITHERS_GATEWAY_TOKEN is required to answer a workflow approval");
	const baseUrl = (env.SMITHERS_GATEWAY_URL ?? "http://127.0.0.1:7331").replace(/\/+$/, "");
	const request = runtime.fetch ?? globalThis.fetch;
	const value =
		workflow.approvalValue === undefined
			? { questionId: question.id, prNumber: workflow.prNumber }
			: workflow.approvalValue;
	const response = await request(`${baseUrl}/v1/rpc/submitApproval`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			runId: workflow.runId,
			nodeId: workflow.nodeId,
			iteration: workflow.iteration,
			approved,
			note,
			decision: { approved, value, note },
		}),
		signal: AbortSignal.timeout(15_000),
	});
	const body = await response.text();
	let frame: unknown;
	try {
		frame = JSON.parse(body);
	} catch {
		if (!response.ok) {
			throw new Error(`Smithers approval failed (${response.status}): ${body.slice(0, 1000) || response.statusText}`);
		}
		throw new Error("Smithers approval returned invalid JSON");
	}
	if (!response.ok) {
		const error =
			typeof frame === "object" && frame !== null && "error" in frame
				? frame.error
				: undefined;
		if (
			response.status === 409 &&
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "AlreadyDecided"
		) {
			const expectedStatus = approved ? "approved" : "denied";
			if (
				"runId" in error &&
				error.runId === workflow.runId &&
				"nodeId" in error &&
				error.nodeId === workflow.nodeId &&
				"iteration" in error &&
				error.iteration === workflow.iteration &&
				"status" in error &&
				error.status === expectedStatus
			) {
				return;
			}
			throw new Error("Smithers approval conflicts with the decision already recorded");
		}
		throw new Error(`Smithers approval failed (${response.status}): ${body.slice(0, 1000) || response.statusText}`);
	}
	if (
		typeof frame !== "object" ||
		frame === null ||
		!("ok" in frame) ||
		frame.ok !== true ||
		!("payload" in frame)
	) {
		throw new Error("Smithers approval returned a mismatched success receipt");
	}
	const payload = frame.payload;
	if (
		typeof payload !== "object" ||
		payload === null ||
		!("runId" in payload) ||
		payload.runId !== workflow.runId ||
		!("nodeId" in payload) ||
		payload.nodeId !== workflow.nodeId ||
		!("iteration" in payload) ||
		payload.iteration !== workflow.iteration ||
		!("approved" in payload) ||
		payload.approved !== approved
	) {
		throw new Error("Smithers approval returned a mismatched success receipt");
	}
}
/** Returns true only when Gateway authoritatively reports the owning run terminal. */
export async function workflowRunIsTerminal(
	question: Question,
	runtime: WorkflowApprovalRuntime = {},
): Promise<boolean> {
	const workflow = question.workflow;
	if (workflow === undefined) throw new Error(`question ${question.id} is not workflow-owned`);
	const env = runtime.env ?? process.env;
	const token = env.SMITHERS_GATEWAY_TOKEN?.trim();
	if (!token) throw new Error("SMITHERS_GATEWAY_TOKEN is required to verify workflow status");
	const baseUrl = (env.SMITHERS_GATEWAY_URL ?? "http://127.0.0.1:7331").replace(/\/+$/, "");
	const response = await (runtime.fetch ?? globalThis.fetch)(`${baseUrl}/v1/rpc/getRun`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ runId: workflow.runId }),
		signal: AbortSignal.timeout(15_000),
	});
	const body = await response.text();
	if (!response.ok) {
		throw new Error(`Smithers run lookup failed (${response.status}): ${body.slice(0, 1000) || response.statusText}`);
	}
	let frame: unknown;
	try {
		frame = JSON.parse(body);
	} catch {
		throw new Error("Smithers run lookup returned invalid JSON");
	}
	if (
		typeof frame !== "object" ||
		frame === null ||
		!("ok" in frame) ||
		frame.ok !== true ||
		!("payload" in frame) ||
		typeof frame.payload !== "object" ||
		frame.payload === null ||
		!("runId" in frame.payload) ||
		frame.payload.runId !== workflow.runId ||
		!("status" in frame.payload) ||
		typeof frame.payload.status !== "string"
	) {
		throw new Error("Smithers run lookup returned a mismatched success receipt");
	}
	return ["finished", "failed", "cancelled", "continued"].includes(frame.payload.status);
}


/**
 * Routes one workflow answer down exactly one of two lanes:
 * - Smithers approvals are submitted first, then folded closed in the queue.
 * - Plain decisions are appended only to the store for the run's next hydrate.
 */
export async function routeWorkflowQuestionAnswer(
	file: string,
	question: Question,
	text: string,
	runtime: WorkflowApprovalRuntime = {},
	choiceOverride?: WorkflowAnswerChoice,
): Promise<WorkflowAnswerResult> {
	const declaredWorkflow = question.workflow;
	if (declaredWorkflow === undefined) {
		throw new Error(`question ${question.id} is not workflow-owned`);
	}
	const answer = text.trim();
	if (answer === "") throw new Error("workflow answer must not be empty");
	const current = readQuestions(file).find((entry) => entry.id === question.id);
	if (current?.status !== "open" || current.workflow === undefined) {
		return { lane: declaredWorkflow.answerLane, applied: false };
	}
	const workflow = current.workflow;
	if (workflow.answerLane === "store") {
		return {
			lane: "store",
			applied: recordAnswer(
				file,
				current.id,
				answer,
				"answered",
				runtime.now?.() ?? Date.now(),
			),
		};
	}
	const choice = choiceOverride ?? workflowAnswerChoice(answer);
	if (choice === undefined) {
		throw new Error("workflow approval answer must be Stamp/Approve, Deny gate, or Hold");
	}
	if (choice === "hold") {
		return { lane: "smithers-approval", choice, applied: false };
	}
	await submitWorkflowApproval(current, choice === "approve", answer, runtime);
	const appended = recordAnswer(
		file,
		current.id,
		answer,
		"answered",
		runtime.now?.() ?? Date.now(),
	);
	if (!appended) {
		const existing = readQuestionHistory(file).find((entry) => entry.id === current.id);
		if (existing?.status === "open" || existing === undefined) {
			throw new Error(`Smithers accepted the decision but question ${current.id} did not fold closed`);
		}
		// Smithers rejects a conflicting second decision as AlreadyDecided. A
		// matching response or the workflow's terminal append is reconciliation.
	}
	return { lane: "smithers-approval", choice, applied: true };
}
