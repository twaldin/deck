/**
 * Durable message queue: turn-boundary steering (captain decision, final).
 *
 * `deck-v2 send` appends here; the next run drains it during hydration. This is
 * what structurally deletes fm2's delivery-unconfirmed class: there are no
 * keystrokes to swallow, and the append either happened or it did not. fm2's
 * evidence for why this matters: "Enter swallowed" x14/19/31 in sampled
 * sessions, an 8.5h wedge with 20 undelivered escalations, a 14.8h silent
 * escalation buffer, and one incident that dropped 100% of escalations.
 *
 * Delivery receipts are a file cursor, not a protocol: a message is `delivered`
 * when appended and `acked` when a run records having consumed it.
 *
 * BOTH logs are append-only, and nothing ever rewrites the producer log.
 * Acknowledgement used to rewrite the queue file with ack fields set, which races
 * the producer: `deck-v2 send` appends while a spawning run rewrites, and the
 * rewrite is built from a snapshot taken before the append. Measured with two
 * concurrent processes: 29 of 41 queued captain steers destroyed. A lost steer is
 * silent — he believes he redirected the work and it continues the old way.
 *
 * So acks live in their own append-only file and `pending()` joins the two by id.
 * Two appends to two different files cannot lose each other.
 */
import * as fs from "node:fs";
import { assertTaskId, ensureHomeDirs, stateFiles } from "./home";

export type QueuedMessage = {
	id: string;
	ts: string;
	text: string;
	/** Who queued it: the captain via CLI, or the orchestrator. */
	from: "captain" | "orchestrator";
	/** Legacy inline ack, from before acks moved to their own append-only log. */
	acked_by_epoch?: number;
	acked_at?: string;
};

function ackFile(taskId: string): string {
	return `${stateFiles(taskId).queue}.acks`;
}

/** Ids already consumed by some run, read from the append-only ack log. */
function ackedIds(taskId: string): Set<string> {
	const acked = new Set<string>();
	let raw: string;
	try {
		raw = fs.readFileSync(ackFile(taskId), "utf8");
	} catch {
		return acked;
	}
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as { id?: string };
			if (typeof parsed.id === "string") acked.add(parsed.id);
		} catch {
			// A torn tail line from a crash mid-append. Skipping it re-delivers one
			// message, which is noisy; treating it as an ack would lose one silently.
		}
	}
	return acked;
}

function messageId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function enqueue(
	taskId: string,
	text: string,
	from: QueuedMessage["from"] = "captain",
): QueuedMessage {
	assertTaskId(taskId);
	ensureHomeDirs();
	const message: QueuedMessage = {
		id: messageId(),
		ts: new Date().toISOString(),
		text,
		from,
	};
	fs.appendFileSync(stateFiles(taskId).queue, `${JSON.stringify(message)}\n`, { mode: 0o600 });
	return message;
}

export function readQueue(taskId: string): QueuedMessage[] {
	assertTaskId(taskId);
	let raw: string;
	try {
		raw = fs.readFileSync(stateFiles(taskId).queue, "utf8");
	} catch {
		return [];
	}
	const messages: QueuedMessage[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			messages.push(JSON.parse(line) as QueuedMessage);
		} catch {
			// A torn trailing line is the only expected corruption; skip it rather
			// than failing the whole drain.
		}
	}
	return messages;
}

export function pending(taskId: string): QueuedMessage[] {
	const acked = ackedIds(taskId);
	// A message is pending unless an ack record exists for it, or the message row
	// itself carries a legacy inline ack.
	return readQueue(taskId).filter((m) => m.acked_at === undefined && !acked.has(m.id));
}

/**
 * Drain: return pending messages and mark them acked, by rewriting the log with
 * ack fields set. Rewrite is safe because the queue is drained by exactly one
 * run at a time (the epoch holder).
 */
/**
 * Mark specific messages acked. Separated from reading so the ack can happen
 * after the consuming run is known to have started: acking at string-build time
 * loses the captain's steer outright if the spawn then fails.
 */
export function ack(taskId: string, ids: string[], epoch: number): void {
	if (ids.length === 0) return;
	assertTaskId(taskId);
	ensureHomeDirs();
	const now = new Date().toISOString();
	// Append-only, to its own file: never touch the producer log.
	const lines = ids.map((id) => JSON.stringify({ id, acked_by_epoch: epoch, acked_at: now }));
	fs.appendFileSync(ackFile(taskId), `${lines.join("\n")}\n`, { mode: 0o600 });
}


