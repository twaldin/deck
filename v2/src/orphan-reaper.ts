import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendStatus } from "./events";

const exec = promisify(execFile);

export type ProcessRow = { pid: number; ppid: number; command: string };

export function orphanedBunTests(rows: ProcessRow[]): ProcessRow[] {
	return rows.filter((row) => row.ppid === 1 && /(^|\/)bun( |$)/.test(row.command) && /\btest\b/.test(row.command));
}

export function parseProcessList(output: string): ProcessRow[] {
	return output.split("\n").flatMap((line) => {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
		if (match === null) return [];
		return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }];
	});
}

export async function reapOrphanedBunTests(options: {
	list?: () => Promise<string>;
	kill?: (pid: number) => Promise<void>;
} = {}): Promise<number[]> {
	const list = options.list ?? (async () => (await exec("ps", ["-axo", "pid=,ppid=,command="])).stdout);
	const kill = options.kill ?? (async (pid) => { process.kill(pid, "SIGTERM"); });
	let victims: ProcessRow[];
	try { victims = orphanedBunTests(parseProcessList(await list())); } catch { return []; }
	const killed: number[] = [];
	for (const victim of victims) {
		try {
			await kill(victim.pid);
			killed.push(victim.pid);
			appendStatus("orphan-reaper", "working", `reaped orphan bun test pid=${victim.pid} ppid=1`);
		} catch { /* process exited between ps and kill */ }
	}
	return killed;
}
