import { describe, expect, test } from "bun:test";
import { GatewaySubscription } from "../src/gateway-subscription";

describe("GatewaySubscription", () => {
	test("coalesces concurrent snapshot producers", async () => {
		const subscription = new GatewaySubscription();
		let calls = 0;
		let resolve!: (value: string) => void;
		const pending = new Promise<string>((done) => { resolve = done; });
		const producer = () => { calls++; return pending; };
		const first = subscription.request("same-snapshot", producer);
		const second = subscription.request("same-snapshot", producer);
		expect(first).toBe(second);
		expect(calls).toBe(1);
		resolve("observed");
		expect(await second).toBe("observed");
	});

	test("starts one stream for concurrent subscribers and fans out events", async () => {
		const subscription = new GatewaySubscription();
		let starts = 0;
		const seen: string[] = [];
		subscription.subscribe((event) => seen.push(`a:${event.runId}`));
		subscription.subscribe((event) => seen.push(`b:${event.runId}`));
		subscription.start(async (onEvent) => {
			starts++;
			onEvent({ runId: "run-1", observation: { run: { id: "run-1", workflow: "w", status: "s", step: null, rootDir: null }, nodes: [] } });
			return () => {};
		});
		subscription.start(async () => { starts++; return () => {}; });
		await Promise.resolve();
		expect(starts).toBe(1);
		expect(seen).toEqual(["a:run-1", "b:run-1"]);
	});
});
