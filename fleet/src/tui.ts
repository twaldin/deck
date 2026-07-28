import type { FleetConfig } from "./config";
import { FramePainter } from "./diff";
import { buildModel, type BuildModelDeps } from "./model";
import { renderModel } from "./render";
import { fitFrame } from "./viewport";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export interface TuiIo {
	write: (data: string) => void;
	/** Current terminal column count. */
	columns: () => number;
	/** Current terminal row count. Live mode reserves one row for its cursor. */
	rows: () => number;
	onResize: (handler: () => void) => void;
	offResize: (handler: () => void) => void;
}

/** Build a single rendered frame (array of lines) from live sources. */
export async function renderFrame(
	config: FleetConfig,
	deps: BuildModelDeps,
	width: number,
	signal?: AbortSignal,
): Promise<string[]> {
	const model = await buildModel(config, deps, signal);
	return renderModel(model, { width, minWidth: config.minWidth, color: config.color });
}

/**
 * Run the dashboard. In --once mode it prints one frame (newline-joined) and
 * returns. Otherwise it enters a refresh loop with flicker-free differential
 * updates and correct resize handling, until the returned stop() is called.
 */
export async function runTui(
	config: FleetConfig,
	deps: BuildModelDeps,
	io: TuiIo,
	externalSignal?: AbortSignal,
): Promise<() => void> {
	if (config.once) {
		const frame = await renderFrame(config, deps, io.columns(), AbortSignal.timeout(15_000));
		io.write(`${frame.join("\n")}\n`);
		return () => {};
	}

	const painter = new FramePainter();
	const sessionController = new AbortController();
	let resized = false;
	let stopped = false;
	let cursorHidden = false;
	let refreshPending = false;
	let activeRefresh: Promise<void> | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	const onResize = () => {
		resized = true;
		void requestRefresh(true);
	};
	io.onResize(onResize);
	const stop = () => {
		if (stopped) return;
		stopped = true;
		sessionController.abort();
		if (timer) clearInterval(timer);
		io.offResize(onResize);
		externalSignal?.removeEventListener("abort", stop);
		if (cursorHidden) io.write(SHOW_CURSOR);
	};
	externalSignal?.addEventListener("abort", stop, { once: true });
	if (externalSignal?.aborted) stop();

	const tickOnce = async () => {
		const width = io.columns();
		const rows = io.rows();
		const rendered = await renderWithDeadline(config, deps, width, sessionController.signal);
		if (stopped) return;

		// If the terminal changed while collection was in flight, discard the
		// stale-dimension frame and coalesce one immediate replacement.
		if (io.columns() !== width || io.rows() !== rows) {
			refreshPending = true;
			return;
		}

		// The painter parks below the block, so always retain one physical row
		// for that cursor. This prevents CSI-up/down math from escaping a short
		// herdr pane after the first frame scrolls.
		const frame = fitFrame(rendered, Math.max(0, rows - 1), width);
		const forceFull = resized;
		resized = false;
		const diff = painter.paint(frame, forceFull);
		if (!cursorHidden) {
			io.write(HIDE_CURSOR);
			cursorHidden = true;
		}
		io.write(diff.output);
	};

	/**
	 * Serialize refreshes. Interval pulses are skipped while busy; resize
	 * requests coalesce into one follow-up refresh so a slow CLI probe cannot
	 * race the painter or apply stale frames out of order.
	 */
	function requestRefresh(coalesce: boolean): Promise<void> {
		if (stopped) return Promise.resolve();
		if (activeRefresh) {
			if (coalesce) refreshPending = true;
			return activeRefresh;
		}

		activeRefresh = (async () => {
			do {
				refreshPending = false;
				await tickOnce();
			} while (!stopped && refreshPending);
		})().finally(() => {
			activeRefresh = null;
		});
		return activeRefresh;
	}

	try {
		await requestRefresh(false);
		if (!stopped) {
			timer = setInterval(() => {
				void requestRefresh(false);
			}, config.intervalMs);
		}
	} catch (error) {
		stop();
		throw error;
	}

	return stop;
}

async function renderWithDeadline(
	config: FleetConfig,
	deps: BuildModelDeps,
	width: number,
	sessionSignal: AbortSignal,
): Promise<string[]> {
	const refreshController = new AbortController();
	const abortRefresh = () => refreshController.abort();
	sessionSignal.addEventListener("abort", abortRefresh, { once: true });
	const timeout = setTimeout(abortRefresh, 15_000);
	try {
		return await renderFrame(config, deps, width, refreshController.signal);
	} finally {
		clearTimeout(timeout);
		sessionSignal.removeEventListener("abort", abortRefresh);
	}
}
