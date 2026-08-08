import { afterEach, describe, expect, test } from "bun:test";
import {
	NEUTRAL_USAGE_STATUS,
	USAGE_CACHE_MS,
	USAGE_REFRESH_INTERVAL_MS,
	buildUsageText,
	registerDeckUsage,
	renderUsageBar,
	type UsageRoster,
	type UsageTimerHandle,
} from "../deck-usage";

type Handler = (event: unknown, ctx: UsageFixture["ctx"]) => Promise<void> | void;
type Command = { handler: (args: string, ctx: UsageFixture["ctx"]) => Promise<void> | void };

type UsageFixture = {
	commands: Map<string, Command>;
	handlers: Map<string, Handler[]>;
	statuses: string[];
	notifications: string[];
	ctx: {
		ui: {
			setStatus(id: string, value: string | undefined): void;
			notify(message: string, level?: "info"): void;
		};
	};
	emit(event: string): Promise<void>;
	waitForStatuses(count: number): Promise<void>;
	advance(ms: number): void;
	fetchAttempts: () => number;
	intervalMs: () => number | undefined;
	runInterval(): void;
	wasCleared: () => boolean;
};

type StubRequest = { path: string; authorization: string | null };
type StubBroker = {
	origin: string;
	requests: StubRequest[];
	close(): void;
	waitForRequests(count: number): Promise<void>;
};

const servers: StubBroker[] = [];
afterEach(() => {
	for (const stub of servers.splice(0)) stub.close();
});

function startStubBroker(response: () => Response | Promise<Response>): StubBroker {
	const requests: StubRequest[] = [];
	const requestWaiters: Array<{ count: number; resolve: () => void }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			requests.push({
				path: url.pathname,
				authorization: request.headers.get("authorization"),
			});
			for (const waiter of requestWaiters.splice(0)) {
				if (requests.length >= waiter.count) waiter.resolve();
				else requestWaiters.push(waiter);
			}
			return response();
		},
	});
	let open = true;
	const stub: StubBroker = {
		origin: `http://127.0.0.1:${server.port}`,
		requests,
		close() {
			if (!open) return;
			open = false;
			server.stop(true);
		},
		waitForRequests(count) {
			if (requests.length >= count) return Promise.resolve();
			const pending = Promise.withResolvers<void>();
			requestWaiters.push({ count, resolve: pending.resolve });
			return pending.promise;
		},
	};
	servers.push(stub);
	return stub;
}


function fixture(origin: string): UsageFixture {
	const commands = new Map<string, Command>();
	const handlers = new Map<string, Handler[]>();
	const statuses: string[] = [];
	const notifications: string[] = [];
	const statusWaiters: Array<{ count: number; resolve: () => void }> = [];
	let now = Date.parse("2026-08-05T12:00:00.000Z");
	let fetchAttempts = 0;
	let intervalMs: number | undefined;
	let intervalCallback: (() => void) | undefined;
	let cleared = false;
	const timer: UsageTimerHandle = { unref() {} };
	const ctx = {
		ui: {
			setStatus(id: string, value: string | undefined) {
				expect(id).toBe("deck-usage");
				if (value !== undefined) {
					statuses.push(value);
					for (const waiter of statusWaiters.splice(0)) {
						if (statuses.length >= waiter.count) waiter.resolve();
						else statusWaiters.push(waiter);
					}
				}
			},
			notify(message: string) {
				notifications.push(message);
			},
		},
	};
	registerDeckUsage(
		{
			registerCommand(name, command) {
				commands.set(name, command as Command);
			},
			on(event, handler) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler as Handler]);
			},
		},
		{
			DECK_GATEWAY_ORIGIN: origin,
			DECK_GATEWAY_API_KEY: "stub-gateway-token",
			// Tests must never fall through to the live ~/.deck token path.
			HOME: "/definitely-not-the-live-home",
		},
		{
			fetch(input, init) {
				fetchAttempts += 1;
				return globalThis.fetch(input, init);
			},
			now: () => now,
			readFile: file => {
				throw new Error(`test unexpectedly read ${file}`);
			},
			setInterval(callback, ms) {
				intervalCallback = callback;
				intervalMs = ms;
				return timer;
			},
			clearInterval(handle) {
				expect(handle).toBe(timer);
				cleared = true;
			},
		},
	);
	return {
		commands,
		handlers,
		statuses,
		notifications,
		ctx,
		async emit(event) {
			await Promise.all((handlers.get(event) ?? []).map(handler => handler({}, ctx)));
		},
		waitForStatuses(count) {
			if (statuses.length >= count) return Promise.resolve();
			const pending = Promise.withResolvers<void>();
			statusWaiters.push({ count, resolve: pending.resolve });
			return pending.promise;
		},
		advance(ms) {
			now += ms;
		},
		fetchAttempts: () => fetchAttempts,
		intervalMs: () => intervalMs,
		runInterval() {
			if (intervalCallback === undefined) throw new Error("usage refresh interval was not registered");
			intervalCallback();
		},
		wasCleared: () => cleared,
	};
}

const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const ROSTER: UsageRoster = {
	generatedAt: NOW,
	reports: [
		{
			provider: "anthropic",
			metadata: { email: "alice@example.com" },
			limits: [
				{
					id: "all-model-5h",
					window: { id: "5h", resetsAt: NOW + 60 * 60_000 },
					amount: { used: 50, limit: 100, usedFraction: 0.5, unit: "percent" },
				},
			],
		},
		{
			provider: "openai-codex",
			metadata: { accountId: "acct-bob" },
			limits: [
				{
					id: "fable-7d",
					window: { id: "7d", resetsAt: NOW + 7 * 24 * 60 * 60_000 },
					scope: { tier: "fable" },
					amount: { remainingFraction: 0.25, unit: "percent" },
				},
			],
		},
	],
};

const FAST_ROSTER: UsageRoster = {
	...ROSTER,
	fastTier: {
		windowMs: 7 * 24 * 60 * 60_000,
		windowStartedAt: NOW - 7 * 24 * 60 * 60_000,
		targetFraction: 0.3,
		fastFraction: 0.35,
		fastStandardCostUsd: 3.5,
		totalStandardCostUsd: 10,
		fastRequests: 2,
		totalRequests: 5,
		exceedsTarget: true,
		multipliers: [2.5],
	},
};

describe("deck usage rendering", () => {
	test("renders the retired six-cell bars at 0%, partial, and 100%", () => {
		expect(renderUsageBar(0)).toBe("░░░░░░");
		expect(renderUsageBar(0.5)).toBe("███░░░");
		expect(renderUsageBar(1)).toBe("██████");
	});

	test("formats every account, window, and exact reset in the full breakdown", () => {
		const output = buildUsageText(ROSTER, undefined, NOW);
		expect(output).toContain("alice@example.com · claude");
		expect(output).toContain("5h: 50% free · resets 2026-08-05T13:00:00.000Z (in 1h 0m)");
		expect(output).toContain("acct-bob · codex");
		expect(output).toContain("7d·fable: 25% free · resets 2026-08-12T12:00:00.000Z (in 7d 0h)");
	});

	test("shows the trailing fast share, credit rate, configurable target, and warning", () => {
		const output = buildUsageText(FAST_ROSTER, undefined, NOW);
		expect(output).toContain("fast tier · trailing 7d");
		expect(output).toContain("35% of tracked Standard-rate cost (2/5 requests) · target ≤30% · credit rate 2.5× Standard");
		expect(output).toContain("WARNING: trailing fast share exceeds the 30% target");
	});
});

describe("deck usage broker integration", () => {
	test("registers /quota and paints compact multi-account bars from /v1/usage", async () => {
		const broker = startStubBroker(() => Response.json(FAST_ROSTER));
		const extension = fixture(broker.origin);
		expect(extension.commands.has("quota")).toBe(true);
		expect(extension.commands.has("usage")).toBe(false);

		await extension.emit("session_start");
		expect(extension.statuses[0]).toBe(NEUTRAL_USAGE_STATUS);
		await extension.waitForStatuses(2);
		expect(extension.statuses.at(-1)).toContain("alice@example.com claude 5h ███░░░ 50%");
		expect(extension.statuses.at(-1)).toContain("acct-bob codex 7d·fable ██░░░░ 25%");
		expect(broker.requests).toEqual([{ path: "/v1/usage", authorization: "Bearer stub-gateway-token" }]);
		expect(extension.intervalMs()).toBe(USAGE_REFRESH_INTERVAL_MS);

		await extension.commands.get("quota")!.handler("", extension.ctx);
		expect(extension.notifications.at(-1)).toContain("alice@example.com · claude");
		expect(extension.notifications.at(-1)).toContain("2026-08-12T12:00:00.000Z");
		expect(extension.notifications.at(-1)).toContain("fast tier · trailing 7d");
		expect(extension.notifications.at(-1)).toContain("credit rate 2.5× Standard");
		expect(extension.notifications.at(-1)).toContain("WARNING");
		expect(broker.requests).toHaveLength(1);

		await extension.emit("session_shutdown");
		expect(extension.wasCleared()).toBe(true);
	});

	test("/quota renders the full report through the host select dialog when one exists", async () => {
		const broker = startStubBroker(() => Response.json(FAST_ROSTER));
		const extension = fixture(broker.origin);
		await extension.emit("session_start");
		await extension.waitForStatuses(2);

		// A host with a select dialog gets the scrollable multi-line viewer;
		// notify would collapse the report to its last line (observed on prime).
		const dialogs: Array<{ title: string; options: string[] }> = [];
		(extension.ctx.ui as { select?: (title: string, options: string[]) => Promise<string | undefined> }).select =
			async (title, options) => {
				dialogs.push({ title, options });
				return undefined;
			};
		await extension.commands.get("quota")!.handler("", extension.ctx);
		expect(dialogs).toHaveLength(1);
		expect(dialogs[0]!.title).toBe("Broker quota");
		const body = dialogs[0]!.options.join("\n");
		expect(body).toContain("alice@example.com · claude");
		expect(body).toContain("fast tier · trailing 7d");
		expect(dialogs[0]!.options.at(-1)).toBe("Close");
		// The report is not double-delivered through notify.
		expect(extension.notifications).toHaveLength(0);
	});

	test("/quota falls back to notify when the select dialog rejects", async () => {
		const broker = startStubBroker(() => Response.json(ROSTER));
		const extension = fixture(broker.origin);
		await extension.emit("session_start");
		await extension.waitForStatuses(2);
		(extension.ctx.ui as { select?: () => Promise<string | undefined> }).select = async () => {
			throw new Error("dialog unavailable");
		};
		await extension.commands.get("quota")!.handler("", extension.ctx);
		expect(extension.notifications.at(-1)).toContain("alice@example.com · claude");
	});

	test("degrades an unreachable broker to a neutral chip without throwing", async () => {
		const broker = startStubBroker(() => Response.json(ROSTER));
		// Keep the stub's allocated origin but close its listener: fetch must reject
		// at the transport boundary rather than return a cooperative HTTP error.
		broker.close();
		const extension = fixture(broker.origin);
		await extension.emit("session_start");
		await extension.waitForStatuses(2);
		expect(extension.statuses.at(-1)).toBe(NEUTRAL_USAGE_STATUS);

		await expect(extension.commands.get("quota")!.handler("", extension.ctx)).resolves.toBeUndefined();
		expect(extension.notifications.at(-1)).toBe("deck usage\n\nNo broker roster available.");
		await Promise.all(Array.from({ length: 20 }, () => extension.emit("agent_settled")));
		expect(extension.fetchAttempts()).toBe(1);
	});

	test("coalesces concurrent refreshes and honors the short cache", async () => {
		const broker = startStubBroker(() => Response.json(ROSTER));
		const extension = fixture(broker.origin);
		await extension.emit("session_start");
		await Promise.all(Array.from({ length: 20 }, () => extension.emit("agent_settled")));
		await extension.waitForStatuses(22);
		expect(broker.requests).toHaveLength(1);

		extension.advance(USAGE_CACHE_MS - 1);
		await extension.emit("agent_settled");
		await extension.waitForStatuses(23);
		expect(broker.requests).toHaveLength(1);

		extension.advance(2);
		extension.runInterval();
		await Promise.all([broker.waitForRequests(2), extension.waitForStatuses(24)]);
		expect(broker.requests).toHaveLength(2);
	});

	test("does not repaint a disposed session when an in-flight refresh completes", async () => {
		const delayed = Promise.withResolvers<Response>();
		const broker = startStubBroker(() => delayed.promise);
		const extension = fixture(broker.origin);
		await extension.emit("session_start");
		await broker.waitForRequests(1);
		await extension.emit("session_shutdown");
		expect(extension.statuses).toEqual([NEUTRAL_USAGE_STATUS]);

		delayed.resolve(Response.json(ROSTER));
		await extension.commands.get("quota")!.handler("", extension.ctx);
		// The second write belongs to the explicit command. The background refresh
		// from the disposed generation must not contribute a third write.
		expect(extension.statuses).toHaveLength(2);
		expect(extension.statuses.at(-1)).toContain("alice@example.com claude");
	});
});
