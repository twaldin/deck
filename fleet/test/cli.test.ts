import { describe, expect, test } from "bun:test";
import type { CommandRunner } from "../src/collectors/backlog";
import { runCli, type CliRuntime } from "../src/cli";

type Signal = "SIGINT" | "SIGTERM";

function runtimeHarness() {
	const signalHandlers = new Map<Signal, () => void>();
	let dataHandler: ((data: { toString(): string }) => void) | null = null;
	const rawModes: boolean[] = [];
	let resumes = 0;
	let pauses = 0;
	let stops = 0;
	const noopRunner: CommandRunner = async () => null;

	const runtime: CliRuntime = {
		env: {},
		cwd: () => "/work",
		stdout: {
			isTTY: true,
			columns: () => 80,
			rows: () => 24,
			write: () => {},
			onResize: () => {},
			offResize: () => {},
		},
		stderr: { write: () => {} },
		stdin: {
			isTTY: true,
			setRawMode: (enabled) => rawModes.push(enabled),
			resume: () => {
				resumes++;
			},
			pause: () => {
				pauses++;
			},
			onData: (handler) => {
				dataHandler = handler;
			},
			offData: (handler) => {
				if (dataHandler === handler) dataHandler = null;
			},
		},
		onSignal: (signal, handler) => {
			signalHandlers.set(signal, handler);
		},
		offSignal: (signal, handler) => {
			if (signalHandlers.get(signal) === handler) signalHandlers.delete(signal);
		},
		makeRunner: () => noopRunner,
		runTui: async () => () => {
			stops++;
		},
		now: () => 1,
	};

	return {
		runtime,
		triggerData: (text: string) => dataHandler?.({ toString: () => text }),
		triggerSignal: (signal: Signal) => signalHandlers.get(signal)?.(),
		state: () => ({ signalHandlers, dataHandler, rawModes, resumes, pauses, stops }),
	};
}

describe("runCli live lifecycle", () => {
	for (const [name, trigger] of [
		["q", (h: ReturnType<typeof runtimeHarness>) => h.triggerData("q")],
		["Ctrl-C byte", (h: ReturnType<typeof runtimeHarness>) => h.triggerData("\u0003")],
		["SIGINT", (h: ReturnType<typeof runtimeHarness>) => h.triggerSignal("SIGINT")],
		["SIGTERM", (h: ReturnType<typeof runtimeHarness>) => h.triggerSignal("SIGTERM")],
	] as const) {
		test(`${name} stops once and restores stdin`, async () => {
			const harness = runtimeHarness();
			const result = runCli([], harness.runtime);
			await Bun.sleep(0);
			trigger(harness);

			expect(await result).toBe(0);
			const state = harness.state();
			expect(state.stops).toBe(1);
			expect(state.rawModes).toEqual([true, false]);
			expect(state.resumes).toBe(1);
			expect(state.pauses).toBe(1);
			expect(state.dataHandler).toBeNull();
			expect(state.signalHandlers.size).toBe(0);
		});
	}

	for (const [name, trigger] of [
		["q", (h: ReturnType<typeof runtimeHarness>) => h.triggerData("q")],
		["SIGTERM", (h: ReturnType<typeof runtimeHarness>) => h.triggerSignal("SIGTERM")],
	] as const) {
		test(`${name} aborts an in-flight initial refresh and restores terminal input`, async () => {
			const harness = runtimeHarness();
			let observedAbort = false;
			harness.runtime.runTui = async (_config, _deps, _io, signal) => {
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
				return () => {};
			};

			const result = runCli([], harness.runtime);
			await Bun.sleep(0);
			trigger(harness);

			expect(await result).toBe(0);
			expect(observedAbort).toBe(true);
			expect(harness.state().rawModes).toEqual([true, false]);
			expect(harness.state().signalHandlers.size).toBe(0);
		});
	}
});
