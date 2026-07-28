import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import type { CommandRunner } from "../src/collectors/backlog";
import type { FleetConfig } from "../src/config";
import { renderFrame, runTui, type TuiIo } from "../src/tui";

const FM_HOME = path.join(import.meta.dir, "fixtures", "fm-home");

const baseConfig: FleetConfig = {
	fmHome: FM_HOME,
	smithersWorkspaces: [],
	intervalMs: 2000,
	color: false,
	once: true,
	minWidth: 48,
};

const noSmithers: CommandRunner = async () => null;

describe("tui --once", () => {
	test("writes exactly one newline-joined frame and does not hide the cursor", async () => {
		let out = "";
		const io: TuiIo = {
			write: (d) => {
				out += d;
			},
			columns: () => 100,
			rows: () => 40,
			onResize: () => {},
			offResize: () => {},
		};
		const stop = await runTui(baseConfig, { run: noSmithers, now: () => 1 }, io);
		stop();
		expect(out).toContain("Fleet ·");
		expect(out).toContain("alpha");
		// --once must not touch cursor-hide (capture friendliness)
		expect(out.includes("\x1b[?25l")).toBe(false);
	});

	test("renderFrame respects the physical width below min-width", async () => {
		const lines = await renderFrame(baseConfig, { run: noSmithers, now: () => 1 }, 30);
		for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(30);
	});
});

describe("tui live loop", () => {
	test("hides cursor on start, restores on stop, uses differential updates", async () => {
		const writes: string[] = [];
		let resizeHandler: (() => void) | null = null;
		const io: TuiIo = {
			write: (d) => writes.push(d),
			columns: () => 80,
			rows: () => 40,
			onResize: (h) => {
				resizeHandler = h;
			},
			offResize: () => {},
		};
		const stop = await runTui({ ...baseConfig, once: false }, { run: noSmithers, now: () => 1 }, io);
		// first write is cursor hide
		expect(writes[0]).toBe("\x1b[?25l");
		// a full frame was painted after the hide
		expect(writes.join("")).toContain("Fleet ·");
		stop();
		expect(writes[writes.length - 1]).toBe("\x1b[?25h");
		expect(typeof resizeHandler).toBe("function");
	});

	test("serializes resize refreshes and coalesces them into one follow-up", async () => {
		let resizeHandler: (() => void) | null = null;
		let calls = 0;
		let inFlight = 0;
		let maxInFlight = 0;
		const secondGate = deferred();
		const run: CommandRunner = async () => {
			calls++;
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			if (calls === 2) await secondGate.promise;
			inFlight--;
			return null;
		};
		const io: TuiIo = {
			write: () => {},
			columns: () => 80,
			rows: () => 40,
			onResize: (handler) => {
				resizeHandler = handler;
			},
			offResize: () => {},
		};

		const stop = await runTui({ ...baseConfig, once: false, intervalMs: 60_000 }, { run, now: () => 1 }, io);
		(resizeHandler as (() => void) | null)?.();
		await waitFor(() => calls === 2);
		(resizeHandler as (() => void) | null)?.();
		(resizeHandler as (() => void) | null)?.();
		expect(calls).toBe(2);
		expect(maxInFlight).toBe(1);

		secondGate.resolve();
		await waitFor(() => calls === 3);
		expect(maxInFlight).toBe(1);
		stop();
	});

	test("stop during collection suppresses the stale frame write", async () => {
		const writes: string[] = [];
		let resizeHandler: (() => void) | null = null;
		let calls = 0;
		let observedAbort = false;
		const run: CommandRunner = async (_command, _args, _cwd, signal) => {
			calls++;
			if (calls === 2) {
				await new Promise<void>((resolve) => {
					if (signal?.aborted) {
						observedAbort = true;
						resolve();
						return;
					}
					signal?.addEventListener(
						"abort",
						() => {
							observedAbort = true;
							resolve();
						},
						{ once: true },
					);
				});
			}
			return null;
		};
		const io: TuiIo = {
			write: (data) => writes.push(data),
			columns: () => 80,
			rows: () => 40,
			onResize: (handler) => {
				resizeHandler = handler;
			},
			offResize: () => {},
		};

		const stop = await runTui({ ...baseConfig, once: false, intervalMs: 60_000 }, { run, now: () => 1 }, io);
		(resizeHandler as (() => void) | null)?.();
		await waitFor(() => calls === 2);
		stop();
		const writesAtStop = writes.length;
		expect(writes[writesAtStop - 1]).toBe("\x1b[?25h");

		await waitFor(() => observedAbort);
		expect(writes).toHaveLength(writesAtStop);
	});

	test("fits live output within the pane height and reports omitted rows", async () => {
		const writes: string[] = [];
		const io: TuiIo = {
			write: (data) => writes.push(data),
			columns: () => 80,
			rows: () => 6,
			onResize: () => {},
			offResize: () => {},
		};
		const stop = await runTui(
			{ ...baseConfig, once: false, intervalMs: 60_000 },
			{ run: noSmithers, now: () => 1 },
			io,
		);
		const firstFrame = writes.join("");
		expect(firstFrame).toContain("omitted");
		// Five frame rows plus the cursor row fit a six-row pane.
		expect((firstFrame.match(/\n/g) ?? [])).toHaveLength(5);
		stop();
	});
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	throw new Error("condition was not reached");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
