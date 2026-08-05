import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_WALK_ENTRIES = 20_000;

export function newestMtimeMs(root: string, cutoff: number, limit: number): { newest: number; truncated: boolean } {
	let newest = 0;
	let visited = 0;
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (dir === undefined) break;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			if (visited++ > MAX_WALK_ENTRIES) return { newest, truncated: true };
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) { stack.push(full); continue; }
			if (!entry.isFile()) continue;
			try {
				const mtime = fs.statSync(full).mtimeMs;
				if (mtime <= limit) newest = Math.max(newest, mtime);
				if (newest > cutoff) return { newest, truncated: false };
			} catch { /* file disappeared */ }
		}
	}
	return { newest, truncated: false };
}

export function sessionSignal(dir: string): { mtimeMs: number; bytes: number } {
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { mtimeMs: 0, bytes: 0 }; }
	let mtimeMs = 0;
	let bytes = 0;
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		try {
			const stat = fs.statSync(path.join(dir, entry.name));
			mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
			bytes += stat.size;
		} catch { /* file disappeared */ }
	}
	return { mtimeMs, bytes };
}

function cpuTimeMs(pid: number): number | null {
	try {
		const out = spawnSync("ps", ["-o", "cputime=", "-p", String(pid)], { encoding: "utf8" });
		if (out.status !== 0 || typeof out.stdout !== "string") return null;
		const match = out.stdout.trim().match(/^(?:(\d+)-)?(\d+):(\d+):(\d+)(?:\.(\d+))?$/);
		if (match === null) return null;
		const days = Number(match[1] ?? 0);
		const hours = Number(match[2]);
		const minutes = Number(match[3]);
		const seconds = Number(match[4]);
		return ((days * 24 + hours) * 60 + minutes) * 60_000 + (seconds + Number(`0.${match[5] ?? "0"}`)) * 1000;
	} catch { return null; }
}

export type ActivitySnapshot = {
	worktreeMtimeMs: number;
	transcriptMtimeMs: number;
	transcriptBytes: number;
	cpuTimeMs: number | null;
};

export function sampleActivity(pid: number, worktree: string, sessionDir: string, now = Date.now()): ActivitySnapshot {
	const transcript = sessionSignal(sessionDir);
	return {
		worktreeMtimeMs: newestMtimeMs(worktree, Number.POSITIVE_INFINITY, now).newest,
		transcriptMtimeMs: transcript.mtimeMs,
		transcriptBytes: transcript.bytes,
		cpuTimeMs: cpuTimeMs(pid),
	};
}

export function activityAdvanced(previous: ActivitySnapshot, current: ActivitySnapshot): boolean {
	return current.worktreeMtimeMs > previous.worktreeMtimeMs
		|| current.transcriptMtimeMs > previous.transcriptMtimeMs
		|| current.transcriptBytes > previous.transcriptBytes
		|| (previous.cpuTimeMs !== null && current.cpuTimeMs !== null && current.cpuTimeMs > previous.cpuTimeMs);
}
