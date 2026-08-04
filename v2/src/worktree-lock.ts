import * as fs from "node:fs";
import * as path from "node:path";
import { stateDir } from "./home";

function lockPath(worktree: string): string {
	const key = Buffer.from(path.resolve(worktree)).toString("base64url");
	return path.join(stateDir(), "worktree-locks", `${key}.lock`);
}

/** Claim a worktree before launching a run. mkdir is atomic across processes. */
export function releaseWorktree(worktree: string, owner: string): void {
	const file = lockPath(worktree);
	try {
		if (fs.readFileSync(path.join(file, "owner"), "utf8").trim() === owner) fs.rmSync(file, { recursive: true, force: true });
	} catch { /* already released */ }
}

export function claimWorktree(worktree: string, owner: string): () => void {
	const file = lockPath(worktree);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	try {
		fs.mkdirSync(file, { mode: 0o700 });
		fs.writeFileSync(path.join(file, "owner"), `${owner}\n`, { mode: 0o600 });
	} catch {
		let current = "unknown";
		try { current = fs.readFileSync(path.join(file, "owner"), "utf8").trim() || current; } catch { /* lock exists */ }
		// Even the same owner must not start a second process. This closes the
		// duplicate-ship race instead of treating an accidental retry as safe.
		throw new Error(`refusing to start: worktree ${path.resolve(worktree)} is already in use by ${current}`);
	}
	return () => {
		fs.rmSync(file, { recursive: true, force: true });
	};
}
