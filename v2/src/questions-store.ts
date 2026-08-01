/**
 * Durable captain-question queue, owned by the ORCHESTRATOR session only.
 *
 * Storage is one append-only JSONL log of events (`ask`, `answer`, `deliver`)
 * folded into current state on read. Append-only is the point: several pi
 * processes write this file concurrently, and a single `appendFileSync` of one
 * line under 4KB is atomic on the platforms pi runs on, whereas a
 * read-modify-write of a records file would silently drop a concurrent ask.
 *
 * The queue lives under the deck home (`~/.deck/questions/`), NOT under
 * `~/.pi/agent`: the pi home is shared by every pi session on the machine, and
 * a queue there collected ghost questions from long-dead worker sessions that
 * nobody would ever deliver answers to.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { deckV2Home } from "./home";

export type Urgency = "low" | "normal" | "high";
export type QuestionStatus = "open" | "answered" | "dismissed";
export type QuestionKind = "agent" | "stamp";

export interface AskEvent {
	kind: "ask";
	id: string;
	/** The queue kind is presentation-neutral: stamps are captain questions. */
	questionKind?: QuestionKind;
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
	/** Unique per append, so a writer can refold and see whether its own answer won. */
	eventId: string;
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
	/** `eventId` of the answer that won the fold. */
	resolvedBy?: string;
	delivered: boolean;
}

/** `DECK_QUESTIONS_FILE` exists so tests and the smoke check never touch the live queue. */
export function queueFile(env: Record<string, string | undefined> = process.env): string {
	const explicit = env.DECK_QUESTIONS_FILE;
	if (explicit !== undefined && explicit !== "") return explicit;
	return path.join(deckV2Home(), "questions", "queue.jsonl");
}

/** The queue the pre-deck extension wrote under the pi home; imported once, then retired. */
export function legacyQueueFile(env: Record<string, string | undefined> = process.env): string {
	const home = env.PI_CONFIG_DIR ?? path.join(homedir(), ".pi", "agent");
	return path.join(home, "questions", "queue.jsonl");
}

/**
 * Per-event size ceiling. The append-atomicity this store relies on holds for
 * small writes, and every reader folds the whole log, so one multi-MB event
 * would degrade every session sharing the queue and make the captain's dialog
 * unusable. EVERY event goes through here, not just asks.
 */
export const MAX_EVENT_BYTES = 8 * 1024;

function append(file: string, event: QueueEvent): void {
	const line = JSON.stringify(event);
	const bytes = Buffer.byteLength(line, "utf8");
	if (bytes > MAX_EVENT_BYTES) {
		throw new Error(
			`queue event is too large (${bytes} bytes > ${MAX_EVENT_BYTES}); shorten the text`,
		);
	}
	// Decision text names cwds and project details; keep it out of other users' reach.
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	appendFileSync(file, `${line}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * Truncates to a UTF-8 BYTE budget without splitting a character. `slice()`
 * counts UTF-16 code units, so it does not bound the bytes actually appended.
 */
export function truncateBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let bytes = 0;
	let out = "";
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		out += char;
	}
	return out;
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
			existing.resolvedBy = event.eventId;
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
		resolvedBy: existing.resolvedBy,
		delivered: existing.delivered,
	};
}

function randomSuffix(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ask(
	file: string,
	input: {
		id?: string;
		questionKind?: QuestionKind;
		question: string;
		context?: string;
		options?: string[];
		recommendation?: string;
		urgency?: string;
		sessionId: string;
		cwd: string;
		/** Use a shared durable key when the decision is global across runs. */
		idScope?: "session" | "global";
		now?: number;
	},
): AskEvent {
	const question = input.question.trim();
	if (question === "") throw new Error("question must not be empty");
	const supplied = input.id?.trim();
	const event: AskEvent = {
		kind: "ask",
		// Caller-supplied ids are SCOPED TO THE ASKING SESSION. The log is shared by
		// every session in the pi home, so a bare "migration-decision" from two
		// sessions would collide in the fold: the second ask would overwrite the
		// first's sessionId and could hand its answer to the wrong agent. Only the
		// same session can refresh its own stable id, which is what "stable" means
		// to the agent using it.
		id:
			supplied === undefined || supplied === ""
				? `q-${randomSuffix()}`
				: input.idScope === "global"
					? supplied
					: `${input.sessionId}:${supplied}`, 
		...(input.questionKind === undefined ? {} : { questionKind: input.questionKind }),
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
	append(file, event);
	return event;
}

/**
 * Budget for answer text. The rest of MAX_EVENT_BYTES covers the JSON envelope
 * (kind, ids, status, timestamp), so bounding only the free text still bounds
 * the appended line.
 */
const MAX_ANSWER_BYTES = MAX_EVENT_BYTES - 1024;

/**
 * Records the captain's resolution and reports whether THIS answer is the one
 * the fold kept. It answers by re-folding after the append rather than trusting
 * a pre-append read: two captains can both observe `open` before either writes,
 * and a pre-append read would then tell both of them they won.
 */
/** Atomically create one global ask. The lock is a directory because mkdir is exclusive on
 * every filesystem used by Deck. The check and append happen while holding it. */
export function askIfAbsent(file: string, input: Parameters<typeof ask>[1]): AskEvent {
	const id = input.id?.trim();
	if (!id || input.idScope !== "global") return ask(file, input);
	const lock = `${file}.${id.replace(/[^a-zA-Z0-9_.-]/g, "_")}.lock`;
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	for (let attempt = 0; ; attempt++) {
		try {
			mkdirSync(lock, { mode: 0o700 });
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST" || attempt >= 500) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	try {
		const existing = openQuestions(file).find((question) => question.id === id);
		if (existing) return existing;
		return ask(file, input);
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

export function answer(
	file: string,
	id: string,
	text: string,
	status: "answered" | "dismissed" = "answered",
	now = Date.now(),
): boolean {
	const eventId = `a-${randomSuffix()}`;
	append(file, {
		kind: "answer",
		id,
		eventId,
		answer: truncateBytes(text, MAX_ANSWER_BYTES),
		status,
		answeredAt: now,
	});
	return readQuestions(file).find((entry) => entry.id === id)?.resolvedBy === eventId;
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

/** Anything older than this is stale: an unanswered question nobody chased for a week is dead. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A question worth keeping in the live queue.
 *
 * Resolved-but-undelivered is ALWAYS kept, at any age: compaction runs on
 * session start before delivery, so aging these out would silently destroy a
 * captain answer the asker never saw — the exact failure the queue exists
 * to prevent. Resolved-and-delivered is history. Open questions must
 * be fresh and carry a sane timestamp; junk without a real `askedAt`
 * (firstmate-era records) can never age out, so it goes immediately.
 */
function isLive(entry: Question, now: number): boolean {
	if (entry.status !== "open") return !entry.delivered;
	if (typeof entry.askedAt !== "number" || !Number.isFinite(entry.askedAt)) return false;
	return now - entry.askedAt <= STALE_AFTER_MS;
}

/** Reconstructs the minimal event lines that fold back into `entry`. */
function eventLines(entry: Question): string[] {
	const { status, answer: text, answeredAt, resolvedBy, delivered, ...askEvent } = entry;
	const lines = [JSON.stringify(askEvent satisfies AskEvent)];
	if (status !== "open") {
		lines.push(
			JSON.stringify({
				kind: "answer",
				id: entry.id,
				eventId: resolvedBy ?? `a-${randomSuffix()}`,
				answer: text ?? "",
				status,
				answeredAt: answeredAt ?? entry.askedAt,
			} satisfies AnswerEvent),
		);
	}
	if (delivered) {
		lines.push(
			JSON.stringify({ kind: "deliver", id: entry.id, deliveredAt: answeredAt ?? entry.askedAt } satisfies DeliverEvent),
		);
	}
	return lines;
}

/**
 * Purge answered + stale questions from the live queue, archiving what is
 * dropped to `archive.jsonl` beside it. Rewrite-in-place is safe here because
 * only the orchestrator session owns this queue; there is no concurrent writer
 * to race with, and the write itself goes through a temp file + rename.
 */
export function compact(file: string, now = Date.now()): { kept: number; archived: number } {
	const all = readQuestions(file);
	if (all.length === 0) return { kept: 0, archived: 0 };
	const keep = all.filter((entry) => isLive(entry, now));
	const drop = all.filter((entry) => !isLive(entry, now));
	if (drop.length === 0) return { kept: keep.length, archived: 0 };
	const dir = path.dirname(file);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	appendFileSync(
		path.join(dir, "archive.jsonl"),
		`${drop.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	const tmp = `${file}.tmp`;
	const body = keep.flatMap(eventLines).join("\n");
	writeFileSync(tmp, body === "" ? "" : `${body}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, file);
	return { kept: keep.length, archived: drop.length };
}

/**
 * One-time import from the legacy pi-home queue: live questions move over,
 * everything else is left behind, and the legacy file is renamed so it can
 * never be imported (or grown) again.
 */
export function importLegacyQueue(file: string, legacy: string, now = Date.now()): number {
	if (legacy === file) return 0;
	let entries: Question[];
	try {
		statSync(legacy);
		entries = readQuestions(legacy);
	} catch {
		return 0; // no legacy queue, nothing to import
	}
	const live = entries.filter((entry) => entry.status === "open" && isLive(entry, now));
	for (const entry of live) {
		const { status, answer, answeredAt, resolvedBy, delivered, ...askEvent } = entry;
		append(file, askEvent);
	}
	renameSync(legacy, `${legacy}.imported`);
	return live.length;
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
