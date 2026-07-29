import { makeSubprocessRunner } from "./collectors/runner";
import { HELP_TEXT, parseArgs } from "./config";
import { runTui, type TuiIo } from "./tui";

interface CliData {
	toString(): string;
}

export interface CliRuntime {
	env: NodeJS.ProcessEnv;
	cwd: () => string;
	stdout: {
		isTTY: boolean;
		columns: () => number;
		rows: () => number;
		write: (data: string) => void;
		onResize: (handler: () => void) => void;
		offResize: (handler: () => void) => void;
	};
	stderr: { write: (data: string) => void };
	stdin: {
		isTTY: boolean;
		setRawMode?: (enabled: boolean) => void;
		resume: () => void;
		pause: () => void;
		onData: (handler: (data: CliData) => void) => void;
		offData: (handler: (data: CliData) => void) => void;
	};
	onSignal: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
	offSignal: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
	makeRunner: typeof makeSubprocessRunner;
	runTui: typeof runTui;
	now: () => number;
}

const PROCESS_RUNTIME: CliRuntime = {
	env: process.env,
	cwd: () => process.cwd(),
	stdout: {
		isTTY: Boolean(process.stdout.isTTY),
		columns: () => (process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80),
		rows: () => (process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 24),
		write: (data) => {
			process.stdout.write(data);
		},
		onResize: (handler) => process.stdout.on("resize", handler),
		offResize: (handler) => {
			process.stdout.off("resize", handler);
		},
	},
	stderr: {
		write: (data) => {
			process.stderr.write(data);
		},
	},
	stdin: {
		isTTY: Boolean(process.stdin.isTTY),
		setRawMode: process.stdin.setRawMode?.bind(process.stdin),
		resume: () => {
			process.stdin.resume();
		},
		pause: () => {
			process.stdin.pause();
		},
		onData: (handler) => process.stdin.on("data", handler),
		offData: (handler) => {
			process.stdin.off("data", handler);
		},
	},
	onSignal: (signal, handler) => process.on(signal, handler),
	offSignal: (signal, handler) => {
		process.off(signal, handler);
	},
	makeRunner: makeSubprocessRunner,
	runTui,
	now: () => Date.now(),
};

/**
 * CLI entry point. Wires the real subprocess runner + terminal IO into the
 * (dependency-injected) TUI loop. Returns a process exit code.
 */
export async function runCli(argv: readonly string[], runtime: CliRuntime = PROCESS_RUNTIME): Promise<number> {
	const parsed = parseArgs(argv, runtime.env, runtime.cwd(), runtime.stdout.isTTY);
	if (parsed.error) {
		runtime.stderr.write(`deck-fleet: ${parsed.error}\n\n${HELP_TEXT}`);
		return 2;
	}
	if (parsed.help) {
		runtime.stdout.write(HELP_TEXT);
		return 0;
	}

	const deps = { run: runtime.makeRunner(), paneRun: runtime.makeRunner(), now: runtime.now };

	const io: TuiIo = {
		write: runtime.stdout.write,
		columns: runtime.stdout.columns,
		rows: runtime.stdout.rows,
		onResize: runtime.stdout.onResize,
		offResize: runtime.stdout.offResize,
	};

	if (parsed.config.once) {
		await runtime.runTui(parsed.config, deps, io);
		return 0;
	}

	// Install signal cleanup before the initial refresh. The TUI does not hide
	// the cursor until that refresh is ready, and this signal aborts any child
	// probes already in flight.
	const lifecycleController = new AbortController();
	let stopTui = () => lifecycleController.abort();
	let settled = false;
	let rawModeEnabled = false;
	let resolveExit!: (code: number) => void;
	const exit = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	const onData = (buf: CliData) => {
		const input = buf.toString();
		if (input.includes("q") || input.includes("\u0003")) shutdown();
	};
	const shutdown = () => {
		if (settled) return;
		settled = true;
		lifecycleController.abort();
		runtime.offSignal("SIGINT", shutdown);
		runtime.offSignal("SIGTERM", shutdown);
		if (runtime.stdin.isTTY) {
			runtime.stdin.offData(onData);
			if (rawModeEnabled) runtime.stdin.setRawMode?.(false);
			runtime.stdin.pause();
		}
		stopTui();
		resolveExit(0);
	};
	runtime.onSignal("SIGINT", shutdown);
	runtime.onSignal("SIGTERM", shutdown);
	// Enable the two read-only quit keys before the initial refresh so a slow
	// first Smithers probe is cancellable too.
	if (runtime.stdin.isTTY) {
		runtime.stdin.setRawMode?.(true);
		rawModeEnabled = runtime.stdin.setRawMode !== undefined;
		runtime.stdin.resume();
		runtime.stdin.onData(onData);
	}

	try {
		stopTui = await runtime.runTui(parsed.config, deps, io, lifecycleController.signal);
	} catch (error) {
		lifecycleController.abort();
		runtime.offSignal("SIGINT", shutdown);
		runtime.offSignal("SIGTERM", shutdown);
		if (runtime.stdin.isTTY) {
			runtime.stdin.offData(onData);
			if (rawModeEnabled) runtime.stdin.setRawMode?.(false);
			runtime.stdin.pause();
		}
		throw error;
	}
	if (settled) {
		stopTui();
		return await exit;
	}

	// Read-only: the ONLY keys handled are quit (q / Ctrl-C). No keybinding
	// mutates any fleet or Smithers state.
	return await exit;
}
