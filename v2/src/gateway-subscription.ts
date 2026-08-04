import type { Observation } from "./observer";

export type GatewayEvent = { runId: string; observation: Observation };
export type GatewaySubscriber = (event: GatewayEvent) => void;

/** One gateway stream per workspace. Consumers receive the same event fan-out. */
export class GatewaySubscription {
	private readonly subscribers = new Set<GatewaySubscriber>();
	private running = false;
	private stopStream: (() => void) | undefined;

	subscribe(subscriber: GatewaySubscriber): () => void {
		this.subscribers.add(subscriber);
		return () => this.subscribers.delete(subscriber);
	}

	start(stream: (onEvent: (event: GatewayEvent) => void) => (() => void) | Promise<() => void>): void {
		if (this.running) return;
		this.running = true;
		Promise.resolve(stream((event) => {
			for (const subscriber of [...this.subscribers]) subscriber(event);
		})).then((stop) => {
			if (!this.running) { stop(); return; }
			this.stopStream = stop;
		}).catch(() => { this.running = false; });
	}

	stop(): void {
		this.running = false;
		this.stopStream?.();
		this.stopStream = undefined;
	}

	get subscriberCount(): number { return this.subscribers.size; }
	get isRunning(): boolean { return this.running; }
}

const subscriptions = new Map<string, GatewaySubscription>();
export function gatewaySubscription(workspace: string): GatewaySubscription {
	let subscription = subscriptions.get(workspace);
	if (subscription === undefined) {
		subscription = new GatewaySubscription();
		subscriptions.set(workspace, subscription);
	}
	return subscription;
}
