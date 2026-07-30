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
 */
import * as fs from "node:fs";
import { assertTaskId, ensureHomeDirs, stateFiles } from "./home";

export type QueuedMessage = {
	id: string;
	ts: string;
	text: string;
	/** Who queued it: the captain via CLI, or the orchestrator. */
	from: "captain" | "orchestrator";
	/** Set when a run consumed it. */
	acked_by_epoch?: number;
	acked_at?: string;
};

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
	return readQueue(taskId).filter((m) => m.acked_at === undefined);
}

/**
 * Drain: return pending messages and mark them acked, by rewriting the log with
 * ack fields set. Rewrite is safe because the queue is drained by exactly one
 * run at a time (the epoch holder).
 */
export function drain(taskId: string, epoch: number): QueuedMessage[] {
	assertTaskId(taskId);
	const all = readQueue(taskId);
	const now = new Date().toISOString();
	const drained: QueuedMessage[] = [];
	const rewritten = all.map((message) => {
		if (message.acked_at !== undefined) return message;
		const acked: QueuedMessage = { ...message, acked_by_epoch: epoch, acked_at: now };
		drained.push(acked);
		return acked;
	});
	if (drained.length === 0) return [];
	const file = stateFiles(taskId).queue;
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, rewritten.map((m) => JSON.stringify(m)).join("\n") + "\n", {
		mode: 0o600,
	});
	fs.renameSync(tmp, file);
	return drained;
}
