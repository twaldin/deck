import type { DeckEvent } from "@deck/core";

export interface WakeBatch {
	effortId: string;
	events: DeckEvent[];
	summary: string;
}

interface PendingBatch {
	events: DeckEvent[];
	timer: NodeJS.Timeout;
}

export type WakeBatchHandler = (batch: WakeBatch) => Promise<void>;

/** One timer per effort folds a burst of facts into one owner wake (SPEC §5.5.4). */
export class WakeCoalescer {
	private readonly windowMs: number;
	private readonly handler: WakeBatchHandler;
	private readonly onError: (error: unknown) => void;
	private readonly pending = new Map<string, PendingBatch>();

	constructor(windowMs: number, handler: WakeBatchHandler, onError: (error: unknown) => void = console.error) {
		this.windowMs = windowMs;
		this.handler = handler;
		this.onError = onError;
	}

	enqueue(effortId: string, event: DeckEvent): void {
		const current = this.pending.get(effortId);
		if (current !== undefined) {
			current.events.push(event);
			return;
		}
		const timer = setTimeout(() => {
			void this.flush(effortId).catch(this.onError);
		}, this.windowMs);
		timer.unref();
		this.pending.set(effortId, { events: [event], timer });
	}

	async flush(effortId: string): Promise<void> {
		const batch = this.pending.get(effortId);
		if (batch === undefined) {
			return;
		}
		clearTimeout(batch.timer);
		this.pending.delete(effortId);
		const counts: Record<string, number> = {};
		for (const event of batch.events) {
			counts[event.type] = (counts[event.type] ?? 0) + 1;
		}
		const summary = Object.entries(counts)
			.map(([type, count]) => `${count} ${type}`)
			.join(", ");
		await this.handler({ effortId, events: batch.events, summary });
	}

	async flushAll(): Promise<void> {
		for (const effortId of [...this.pending.keys()]) {
			await this.flush(effortId);
		}
	}

	get pendingEfforts(): number {
		return this.pending.size;
	}
}
