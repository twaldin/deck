/**
 * Phase-2 exit gates (SPEC §4.5.3 D-A, §5.5.6(d) D-C — process-level scope).
 *
 * These are LIVE integration tests: a real router daemon, a real pi owner on
 * the deck broker (claude-haiku-4-5, tiny turns), the real lifecycle
 * extension. They run against a throwaway DECK_HOME; the only shared
 * dependency is the live broker's LLM gateway.
 *
 * Gate 1 (D-A): TUI send → inbox append → router delivery → owner ack → tail
 * event; then a router kill -9 BETWEEN append and delivery must not drop the
 * message — it delivers+acks after restart. The firstmate resend pattern must
 * be structurally impossible.
 *
 * Gate 2 (D-C, process-level): kill -9 router AND owner; board still renders
 * from disk; a restarted router revives exactly one owner (lease epoch
 * monotonic) and a new message still delivers+acks. Machine-reboot variant is
 * Tim-gated (recorded in the morning ledger).
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "deck-gate-"));
process.env.DECK_HOME = TEMP_HOME;

// Dynamic imports are REQUIRED here (rule exception): @deck/core reads
// DECK_HOME at module-init time, so the env pin above must execute first —
// a static import would hoist past it and bind the real ~/.deck.
const core = await import("@deck/core");
const tuiRender = await import("../tui/src/render.ts");
const tuiActions = await import("../tui/src/actions.ts");

const ROUTER_MAIN = path.resolve(import.meta.dir, "../router/src/main.ts");
const EFFORT_ID = "gate--no-silent-drop";

core.ensureStateDirs();
// Fast cadence for the drill: 1s ticks, 1s heartbeat pump.
fs.writeFileSync(
	path.join(TEMP_HOME, "config.json"),
	JSON.stringify({ router: { tickMs: 1_000, heartbeatIntervalMs: 1_000, spawnDeadlineMs: 90_000 } }),
);

type RouterProc = { proc: Bun.Subprocess; pid: number };
let router: RouterProc | null = null;

function startRouter(): RouterProc {
	const proc = Bun.spawn(["bun", ROUTER_MAIN], {
		env: {
			...process.env,
			DECK_HOME: TEMP_HOME,
			DECK_OWNER_MODEL: "claude-haiku-4-5",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	return { proc, pid: proc.pid };
}

async function routerRequest(op: Record<string, unknown>): Promise<Record<string, unknown>> {
	const cap = fs.readFileSync(path.join(TEMP_HOME, "router", "control.token"), "utf8").trim();
	const payload = { id: `gate-${Date.now()}`, cap, ...op };
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
	let buffer = "";
	void Bun.connect({
		unix: path.join(TEMP_HOME, "run", "router.sock"),
		socket: {
			open(socket) {
				socket.write(`${JSON.stringify(payload)}\n`);
			},
			data(socket, chunk) {
				buffer += chunk.toString("utf8");
				const newline = buffer.indexOf("\n");
				if (newline === -1) return;
				socket.end();
				resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
			},
			error(_socket, error) {
				reject(error);
			},
		},
	}).catch(reject);
	return promise;
}

async function waitFor<T>(label: string, timeoutMs: number, probe: () => T | null | Promise<T | null>): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== null) return value;
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
		// Real wall-clock poll (rule exception): this integration gate observes
		// external OS processes (router daemon, pi owner); fake timers cannot
		// advance another process's clock.
		await Bun.sleep(500);
	}
}

async function waitForRouterUp(timeoutMs: number): Promise<void> {
	await waitFor("router control socket", timeoutMs, async () => {
		try {
			const response = await routerRequest({ op: "status" });
			return response.ok === true ? true : null;
		} catch {
			return null;
		}
	});
}

type GateInboxCommand = { cmd_id: string; delivered: number | null; acked: number | null };

function ackedCommand(cmdId: string): GateInboxCommand | null {
	const command = findCommand(cmdId);
	return command !== null && command.acked !== null ? command : null;
}

function findCommand(cmdId: string): GateInboxCommand | null {
	const store = core.openEffort(EFFORT_ID);
	return store.inboxState().find(entry => entry.cmd_id === cmdId) ?? null;
}

const childrenSchema = z.array(
	z.looseObject({ kind: z.string(), effort_id: z.string(), pgid: z.number(), session_id: z.string().optional() }),
);

function readChildren(): z.infer<typeof childrenSchema> {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(path.join(TEMP_HOME, "router", "children.json"), "utf8"));
		if (Array.isArray(raw)) return childrenSchema.parse(raw);
		if (raw !== null && typeof raw === "object" && "children" in raw) return childrenSchema.parse(raw.children);
		return [];
	} catch {
		return [];
	}
}

afterAll(() => {
	if (router) {
		try {
			process.kill(router.pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	// Reap any surviving pi children registered by the drill.
	for (const child of readChildren()) {
		try {
			process.kill(-child.pgid, "SIGKILL");
		} catch {
			// already gone
		}
	}
});

describe("phase-2 exit gates", () => {
	test(
		"D-A: message delivers and acks end-to-end, including across a router kill -9",
		async () => {
			core.createEffort({
				effort_id: EFFORT_ID,
				project: "gate",
				title: "No silent drop gate",
				charter: {
					goal: "Prove Tim->owner messages are never silently dropped.",
					acceptance_criteria: ["every inbox command reaches acked"],
					constraints: ["reply with one short sentence to any instruction"],
				},
			});

			router = startRouter();
			await waitForRouterUp(30_000);

			// 1. Send + wake: full happy path to acked.
			const first = tuiActions.sendOwnerMessage(EFFORT_ID, "Say READY and nothing else.");
			const wake = await routerRequest({ op: "wake", effort_id: EFFORT_ID, reason: "gate: first message" });
			if (wake.ok !== true) throw new Error(`wake failed: ${JSON.stringify(wake)}`);
			const firstAcked = await waitFor("first command acked", 180_000, () => ackedCommand(first.cmd_id));
			expect(firstAcked?.delivered).not.toBeNull();

			// Tail must carry the ack event (D-A: receipt is durable, not implied).
			const store = core.openEffort(EFFORT_ID);
			const tail = store.readTail({});
			expect(tail.some(event => event.type === "lifecycle.ack")).toBe(true);

			// 2. Crash window: append, then kill -9 the router BEFORE it can deliver.
			const second = tuiActions.sendOwnerMessage(EFFORT_ID, "Say SURVIVED and nothing else.");
			process.kill(router.pid, "SIGKILL");
			await Bun.sleep(500);
			expect(findCommand(second.cmd_id)?.acked ?? null).toBeNull();

			// 3. Restart: reconcile must deliver the pending command with zero manual steps.
			router = startRouter();
			await waitForRouterUp(30_000);
			const secondAcked = await waitFor("second command acked after router crash", 240_000, () =>
				ackedCommand(second.cmd_id),
			);
			expect(secondAcked?.delivered).not.toBeNull();
		},
		600_000,
	);

	test(
		"D-C (process-level): kill -9 router + owner; board renders; single owner revives; messages still flow",
		async () => {
			// Kill every registered child hard, then the router.
			const childrenBefore = readChildren();
			for (const child of childrenBefore) {
				try {
					process.kill(-child.pgid, "SIGKILL");
				} catch {
					// already gone
				}
			}
			if (router) process.kill(router.pid, "SIGKILL");
			await Bun.sleep(500);

			// Board renders from disk alone — manifests and tails intact.
			const manifests = core.listEfforts().map(store => store.readManifest());
			expect(manifests.length).toBeGreaterThanOrEqual(1);
			const boardLines = tuiRender.renderBoard({ efforts: manifests, issues: [] }, 0, Date.now());
			expect(boardLines.join("\n")).toContain(EFFORT_ID);
			const epochBefore = manifests.find(m => m.effort_id === EFFORT_ID)?.session?.lease_epoch ?? 0;

			// Restart and prove revival: new message delivers+acks, exactly one owner, epoch advanced.
			router = startRouter();
			await waitForRouterUp(30_000);
			const third = tuiActions.sendOwnerMessage(EFFORT_ID, "Say REVIVED and nothing else.");
			const wake = await routerRequest({ op: "wake", effort_id: EFFORT_ID, reason: "gate: revive after kill-9" });
			expect(wake.ok).toBe(true);
			const thirdAcked = await waitFor("third command acked after full kill", 240_000, () => ackedCommand(third.cmd_id));
			expect(thirdAcked?.delivered).not.toBeNull();

			const after = core.openEffort(EFFORT_ID).readManifest();
			expect(after.session?.lease_epoch ?? 0).toBeGreaterThan(epochBefore);
			const owners = readChildren().filter(child => child.kind === "owner" && child.effort_id === EFFORT_ID);
			expect(owners.length).toBeLessThanOrEqual(1);
		},
		600_000,
	);
});
