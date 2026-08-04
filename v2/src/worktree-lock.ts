import * as fs from "node:fs";
import * as path from "node:path";
import { stateDir } from "./home";

function lockPath(worktree: string): string {
	const resolved = fs.existsSync(worktree) ? fs.realpathSync(worktree) : path.resolve(worktree);
	const key = Buffer.from(resolved).toString("base64url");
	return path.join(stateDir(), "worktree-locks", `${key}.lock`);
}

/** Claim a worktree before launching a run. mkdir is atomic across processes. */
function ownerFile(file: string): string { return path.join(file, "owner"); }

function readLock(file: string): { owner: string; pid: number; durable: boolean } | null {
	try {
		const row = JSON.parse(fs.readFileSync(ownerFile(file), "utf8")) as { owner?: unknown; pid?: unknown; durable?: unknown };
		return typeof row.owner === "string" && typeof row.pid === "number"
			? { owner: row.owner, pid: row.pid, durable: row.durable === true }
			: null;
	} catch { return null; }
}

function pidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

export function releaseWorktree(worktree: string, owner: string): void {
	const file = lockPath(worktree);
	const lock = readLock(file);
	if (lock?.owner !== owner) return;
	// Rename the directory away before removing it. A new claimant cannot be
	// deleted by this release if it wins the mkdir race after the check.
	const tombstone = `${file}.release-${process.pid}-${Date.now()}`;
	try { fs.renameSync(file, tombstone); fs.rmSync(tombstone, { recursive: true, force: true }); } catch { /* already released */ }
}

/** Claim a worktree. A dead recorded process is reclaimable after a crash. */
export function claimWorktree(worktree: string, owner: string, pid = process.pid, durable = false): () => void {
	const file = lockPath(worktree);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.mkdirSync(tmp, { mode: 0o700 });
		fs.writeFileSync(ownerFile(tmp), `${JSON.stringify({ owner, pid, durable })}\n`, { mode: 0o600 });
		fs.renameSync(tmp, file);
	} catch {
		const current = readLock(file);
		if (current?.owner === owner) {
			updateWorktreePid(worktree, owner, pid);
			return () => releaseWorktree(worktree, owner);
		}
		if (current !== null && !current.durable && !pidAlive(current.pid)) {
			const stale = `${file}.stale-${process.pid}-${Date.now()}`;
			try { fs.renameSync(file, stale); fs.rmSync(stale, { recursive: true, force: true }); } catch { /* another claimant won */ }
			try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* retry below */ }
			return claimWorktree(worktree, owner, pid, durable);
		}
		try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* lock owner remains authoritative */ }
		throw new Error(`refusing to start: worktree ${path.resolve(worktree)} is already in use by ${current?.owner ?? "unknown"}; inspect or remove lock ${ownerFile(file)}`);
	}
	return () => releaseWorktree(worktree, owner);
}

export function updateWorktreePid(worktree: string, owner: string, pid: number): void {
	const file = lockPath(worktree);
	const lock = readLock(file);
	if (lock?.owner !== owner) return;
	const tmp = `${ownerFile(file)}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify({ owner, pid, durable: lock.durable })}\n`, { mode: 0o600 });
	fs.renameSync(tmp, ownerFile(file));
}
