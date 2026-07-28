/**
 * Durable captain-question queue, shared by every pi session in one pi home.
 *
 * Storage is one append-only JSONL log of events (`ask`, `answer`, `deliver`)
 * folded into current state on read. Append-only is the point: several pi
 * processes write this file concurrently, and a single `appendFileSync` of one
 * line under 4KB is atomic on the platforms pi runs on, whereas a
 * read-modify-write of a records file would silently drop a concurrent ask.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export type Urgency = "low" | "normal" | "high";
export type QuestionStatus = "open" | "answered" | "dismissed";

export interface AskEvent {
	kind: "ask";
	id: string;
	question: string;
	context?: string;
	options?: string[];
	recommendation?: string;
	urgency: Urgency;
	sessionId: string;
	cwd: string;
	askedAt: number;
}

interface AnswerEvent {
	kind: "answer";
	id: string;
	answer: string;
	status: "answered" | "dismissed";
	answeredAt: number;
}

interface DeliverEvent {
	kind: "deliver";
	id: string;
	deliveredAt: number;
}

type QueueEvent = AskEvent | AnswerEvent | DeliverEvent;

export interface Question extends AskEvent {
	status: QuestionStatus;
	answer?: string;
	answeredAt?: number;
	delivered: boolean;
}

/**
 * `DECK_QUESTIONS_FILE` exists so tests and the smoke check never touch the
 * live queue; `PI_CONFIG_DIR`/`INSTALL_TARGET` keep the queue next to the pi
 * home the asking session actually runs in.
 */
export function queueFile(env: Record<string, string | undefined> = process.env): string {
	const explicit = env.DECK_QUESTIONS_FILE;
	if (explicit !== undefined && explicit !== "") return explicit;
	const home = env.PI_CONFIG_DIR ?? path.join(homedir(), ".pi", "agent");
	return path.join(home, "questions", "queue.jsonl");
}

function append(file: string, event: QueueEvent): void {
	mkdirSync(path.dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
}

/** Milliseconds of the last write, or null when the queue does not exist yet. */
export function queueMtimeMs(file: string): number | null {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return null;
	}
}

/** Folds the event log. Unparseable lines are skipped: one corrupt line must not hide the queue. */
export function readQuestions(file: string): Question[] {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const byId = new Map<string, Question>();
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		let event: QueueEvent;
		try {
			event = JSON.parse(line) as QueueEvent;
		} catch {
			continue;
		}
		if (event.kind === "ask") {
			// Re-asking a known id refreshes the prompt but keeps any existing answer.
			const existing = byId.get(event.id);
			byId.set(event.id, { ...event, status: "open", delivered: false, ...pick(existing) });
		} else if (event.kind === "answer") {
			const existing = byId.get(event.id);
			if (existing === undefined) continue;
			// Resolution is TERMINAL. Two captains can hold the same /questions
			// dialog open, and the second one's pick lands after the first answer
			// was already delivered to the agent. Letting it win would leave the
			// durable record disagreeing with what the agent was actually told.
			// First answer wins, everywhere, because every reader folds this log.
			if (existing.status !== "open") continue;
			existing.status = event.status;
			existing.answer = event.answer;
			existing.answeredAt = event.answeredAt;
		} else if (event.kind === "deliver") {
			const existing = byId.get(event.id);
			if (existing !== undefined) existing.delivered = true;
		}
	}
	return [...byId.values()];
}

function pick(existing: Question | undefined): Partial<Question> {
	if (existing === undefined) return {};
	return {
		status: existing.status,
		answer: existing.answer,
		answeredAt: existing.answeredAt,
		delivered: existing.delivered,
	};
}

/**
 * Per-event size ceiling. The append-atomicity this store relies on holds for
 * small writes, and every reader folds the whole log, so one multi-MB event
 * would degrade every session sharing the queue and make the captain's dialog
 * unusable. Enforced here as well as in the tool schema: the store is the
 * boundary every writer crosses.
 */
export const MAX_EVENT_BYTES = 8 * 1024;

function appendBounded(file: string, event: AskEvent): void {
	const line = JSON.stringify(event);
	const bytes = Buffer.byteLength(line, "utf8");
	if (bytes > MAX_EVENT_BYTES) {
		throw new Error(
			`question is too large to queue (${bytes} bytes > ${MAX_EVENT_BYTES}); shorten question/context/recommendation`,
		);
	}
	append(file, event);
}

export function ask(
	file: string,
	input: {
		id?: string;
		question: string;
		context?: string;
		options?: string[];
		recommendation?: string;
		urgency?: string;
		sessionId: string;
		cwd: string;
		now?: number;
	},
): AskEvent {
	const question = input.question.trim();
	if (question === "") throw new Error("question must not be empty");
	const event: AskEvent = {
		kind: "ask",
		id: input.id?.trim() || `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		question,
		...(input.context === undefined ? {} : { context: input.context }),
		...(input.options === undefined || input.options.length === 0
			? {}
			: { options: input.options }),
		...(input.recommendation === undefined ? {} : { recommendation: input.recommendation }),
		urgency: normalizeUrgency(input.urgency),
		sessionId: input.sessionId,
		cwd: input.cwd,
		askedAt: input.now ?? Date.now(),
	};
	appendBounded(file, event);
	return event;
}

/**
 * Records the captain's resolution. Returns false when the question was already
 * resolved by another captain session, so the caller can say so instead of
 * pretending the second answer took effect.
 */
export function answer(
	file: string,
	id: string,
	text: string,
	status: "answered" | "dismissed" = "answered",
	now = Date.now(),
): boolean {
	const current = readQuestions(file).find((entry) => entry.id === id);
	append(file, {
		kind: "answer",
		id,
		answer: text.slice(0, MAX_EVENT_BYTES),
		status,
		answeredAt: now,
	});
	// Advisory only: the fold is what actually enforces first-answer-wins, since
	// a concurrent captain can resolve the question between this read and append.
	return current?.status === "open";
}

/** Marks an answer as handed back to the asking agent so it is not re-delivered. */
export function markDelivered(file: string, id: string, now = Date.now()): void {
	append(file, { kind: "deliver", id, deliveredAt: now });
}

const URGENCY_RANK: Record<Urgency, number> = { high: 0, normal: 1, low: 2 };

/** Anything unrecognized is `normal`: a mislabeled urgency must not lose the question. */
function normalizeUrgency(value: string | undefined): Urgency {
	const lowered = value?.trim().toLowerCase();
	return lowered === "low" || lowered === "high" ? lowered : "normal";
}

/** Open questions, most urgent first then oldest first. */
export function openQuestions(file: string): Question[] {
	return readQuestions(file)
		.filter((entry) => entry.status === "open")
		.sort(
			(a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || a.askedAt - b.askedAt,
		);
}

/** Answers this session asked for that it has not yet been told about. */
export function pendingAnswersFor(file: string, sessionId: string): Question[] {
	return readQuestions(file)
		.filter(
			(entry) =>
				entry.sessionId === sessionId && entry.status !== "open" && !entry.delivered,
		)
		.sort((a, b) => (a.answeredAt ?? 0) - (b.answeredAt ?? 0));
}

export function formatAge(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${minutes % 60 === 0 ? "" : `${minutes % 60}m`}`;
	return `${Math.floor(hours / 24)}d${hours % 24 === 0 ? "" : `${hours % 24}h`}`;
}
