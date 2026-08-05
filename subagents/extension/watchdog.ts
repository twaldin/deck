import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { activityAdvanced, sampleActivity, type ActivitySnapshot } from "./activity.ts";

export type WatchdogFailure = {
	kind: "timeout" | "dead" | "aborted";
	reason: string;
	pid?: number;
	timeoutMs?: number;
};

export type WatchdogOptions = {
	worktree: string;
	timeoutMs: number;
	livenessMs: number;
	sessionDir?: string;
	onFailure: (failure: WatchdogFailure) => void;
};

/** Bound a child and reuse the wake engine's measured activity signals. */
export function startSubagentWatchdog(proc: ChildProcess, options: WatchdogOptions): { sessionDir: string; stop: () => void } {
	const sessionDir = options.sessionDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-transcript-"));
	let previous: ActivitySnapshot | undefined;
	let lastActivityAt = Date.now();
	let stopped = false;
	let reported = false;
	const fail = (failure: WatchdogFailure) => {
		if (stopped || reported) return;
		reported = true;
		options.onFailure(failure);
		if (proc.exitCode === null) proc.kill("SIGTERM");
		setTimeout(() => {
			if (proc.exitCode === null) proc.kill("SIGKILL");
		}, 1000).unref();
	};
	const timeout = setTimeout(() => fail({ kind: "timeout", reason: `subagent exceeded ${options.timeoutMs}ms wall-clock timeout`, pid: proc.pid, timeoutMs: options.timeoutMs }), options.timeoutMs);
	const liveness = setInterval(() => {
		if (stopped || proc.exitCode !== null || proc.pid === undefined) return;
		const current = sampleActivity(proc.pid, options.worktree, sessionDir);
		if (previous === undefined || activityAdvanced(previous, current)) lastActivityAt = Date.now();
		previous = current;
		if (Date.now() - lastActivityAt >= options.livenessMs) {
			fail({ kind: "dead", reason: `child produced no worktree, transcript, or CPU activity for ${options.livenessMs}ms`, pid: proc.pid });
		}
	}, Math.max(5, Math.min(options.livenessMs, 5_000)));
	// The first sample is separate from the interval. This avoids charging
	// process startup time against liveness and makes a short test window stable.
	const initialSample = setTimeout(() => {
		if (stopped || proc.exitCode !== null || proc.pid === undefined) return;
		previous = sampleActivity(proc.pid, options.worktree, sessionDir);
		lastActivityAt = Date.now();
	}, 0);
	return {
		sessionDir,
		stop: () => {
			if (stopped) return;
			stopped = true;
			clearTimeout(timeout);
			clearTimeout(initialSample);
			clearInterval(liveness);
			if (options.sessionDir === undefined) fs.rmSync(sessionDir, { recursive: true, force: true });
		},
	};
}
