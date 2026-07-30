/**
 * Claim + receipt protocol for irreversible operations.
 *
 * run_epoch alone is not enough (review round 2, finding 1). A run can pass an
 * epoch pre-check and still lose the race while the provider call is in flight;
 * once GitHub accepts a push, "rejected, never applied" is false — the side
 * effect exists in the world. Epochs fence local state and grant the RIGHT TO
 * START. Receipts are what make an interrupted op recoverable.
 *
 *   1. acquire an exclusive claim under the CURRENT epoch (fail closed)
 *   2. persist a PENDING receipt BEFORE the provider call
 *   3. revalidate while holding the claim
 *   4. perform the call
 *   5. persist the TERMINAL receipt and release the claim
 *
 * A PENDING receipt with no terminal record is the crash signature. Reconcile
 * resolves it by asking the provider what actually happened — never by retrying
 * blind. fm2's learnings already carry this rule for creates: "a
 * 'skipped/failed' create may have executed server-side."
 */
import * as fs from "node:fs";
import { assertTaskId, ensureHomeDirs, stateFiles } from "./home";
import { currentEpoch } from "./meta";

export const IRREVERSIBLE_OPS = ["push", "merge", "deploy", "migration", "teardown"] as const;
export type IrreversibleOp = (typeof IRREVERSIBLE_OPS)[number];

export type Receipt = {
	receipt_id: string;
	op: IrreversibleOp;
	epoch: number;
	target: string;
	/** Bound head SHA where relevant, so a moved head invalidates the intent. */
	head_sha?: string;
	status: "pending" | "confirmed" | "failed";
	started_at: string;
	/** Present only on a terminal receipt. */
	confirmed_at?: string;
	/** Provider truth: commit sha, merge sha, run id. */
	ref?: string;
	error?: string;
};

export class ClaimError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ClaimError";
	}
}

type ClaimFile = { receipt_id: string; op: IrreversibleOp; epoch: number; pid: number; at: string };

function receiptId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function appendReceipt(taskId: string, receipt: Receipt): void {
	fs.appendFileSync(stateFiles(taskId).receipts, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
}

export function readReceipts(taskId: string): Receipt[] {
	assertTaskId(taskId);
	let raw: string;
	try {
		raw = fs.readFileSync(stateFiles(taskId).receipts, "utf8");
	} catch {
		return [];
	}
	const receipts: Receipt[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			receipts.push(JSON.parse(line) as Receipt);
		} catch {
			// torn trailing line
		}
	}
	return receipts;
}

/**
 * Unresolved PENDING receipts: written before a provider call, never given a
 * terminal record. Each one means "we may have changed the world and do not know
 * whether it took." Reconcile MUST resolve these against the provider before
 * any retry.
 */
export function unresolvedReceipts(taskId: string): Receipt[] {
	const terminal = new Set<string>();
	for (const receipt of readReceipts(taskId)) {
		if (receipt.status !== "pending") terminal.add(receipt.receipt_id);
	}
	const open = new Map<string, Receipt>();
	for (const receipt of readReceipts(taskId)) {
		if (receipt.status === "pending" && !terminal.has(receipt.receipt_id)) {
			open.set(receipt.receipt_id, receipt);
		}
	}
	return [...open.values()];
}

function readClaim(taskId: string): ClaimFile | null {
	try {
		return JSON.parse(fs.readFileSync(stateFiles(taskId).claim, "utf8")) as ClaimFile;
	} catch {
		return null;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Acquire the exclusive side-effect claim for this task under `epoch`.
 *
 * Fails closed: a run that cannot obtain the current-epoch claim is FORBIDDEN
 * from attempting the op. It does not check and hope.
 */
export function acquireClaim(
	taskId: string,
	op: IrreversibleOp,
	epoch: number,
	options: { target: string; headSha?: string },
): Receipt {
	assertTaskId(taskId);
	ensureHomeDirs();

	const live = currentEpoch(taskId);
	if (epoch !== live) {
		throw new ClaimError(
			`refusing ${op} for ${taskId}: run epoch ${epoch} is not current (${live}); this run has been superseded`,
		);
	}

	// Any LIVE holder blocks, whatever its epoch. Only checking same-epoch holders
	// was wrong: a superseded run whose process is still alive can still be
	// mid-push, and letting a new epoch push alongside it is exactly the
	// double-irreversible-op this protocol exists to prevent. An epoch grants the
	// right to START; it cannot un-land someone else's push.
	const existing = readClaim(taskId);
	if (existing !== null && pidAlive(existing.pid)) {
		throw new ClaimError(
			`refusing ${op} for ${taskId}: claim held by live pid ${existing.pid} at epoch ${existing.epoch}`,
		);
	}
	// A dead holder leaves its PENDING receipt behind on purpose: reclaiming the
	// claim never resolves it, because we cannot know whether its op landed.

	const receipt: Receipt = {
		receipt_id: receiptId(),
		op,
		epoch,
		target: options.target,
		...(options.headSha === undefined ? {} : { head_sha: options.headSha }),
		status: "pending",
		started_at: new Date().toISOString(),
	};

	const claim: ClaimFile = {
		receipt_id: receipt.receipt_id,
		op,
		epoch,
		pid: process.pid,
		at: receipt.started_at,
	};
	// The claim is taken with an ATOMIC exclusive create, before the receipt is
	// written. "wx" fails if the file exists, so exactly one of two concurrent
	// callers can win. The previous write-then-rename silently overwrote a
	// competing claim, so both callers believed they held it and both would push:
	// read-then-write has a gap between the read and the write, and rename closes
	// nothing.
	const claimFile = stateFiles(taskId).claim;
	try {
		fs.writeFileSync(claimFile, `${JSON.stringify(claim)}\n`, { mode: 0o600, flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			// Someone created it between our check and here, or a dead holder's file
			// is still present. Re-read to report which.
			const holder = readClaim(taskId);
			if (holder !== null && pidAlive(holder.pid)) {
				throw new ClaimError(
					`refusing ${op} for ${taskId}: claim held by live pid ${holder.pid} at epoch ${holder.epoch}`,
				);
			}
			// A dead holder's claim is reclaimable, but rm-then-create is NOT atomic:
			// two callers can both remove, then both create, and both believe they
			// hold it. (Observed: 2 winners out of 8 contenders.)
			//
			// The exchange is made atomic with a per-caller lock directory. mkdir is
			// atomic on every POSIX filesystem, so exactly one caller can create it,
			// and only that caller is allowed to replace the dead claim.
			const reclaimLock = `${claimFile}.reclaim`;
			try {
				fs.mkdirSync(reclaimLock);
			} catch {
				throw new ClaimError(
					`refusing ${op} for ${taskId}: another run is reclaiming the claim from a dead holder`,
				);
			}
			try {
				// Re-verify under the lock: the winner of the previous reclaim may have
				// already installed a live claim while we waited.
				const holder = readClaim(taskId);
				if (holder !== null && pidAlive(holder.pid)) {
					throw new ClaimError(
						`refusing ${op} for ${taskId}: claim held by live pid ${holder.pid} at epoch ${holder.epoch}`,
					);
				}
				// rename is atomic, so the claim file is never briefly absent.
				const staging = `${claimFile}.${process.pid}.staged`;
				fs.writeFileSync(staging, `${JSON.stringify(claim)}\n`, { mode: 0o600 });
				fs.renameSync(staging, claimFile);
			} finally {
				fs.rmSync(reclaimLock, { recursive: true, force: true });
			}
		} else {
			throw error;
		}
	}
	// PENDING receipt lands BEFORE the provider call, so a crash is always
	// detectable as "may have happened". It is written after the claim so a lost
	// race leaves no misleading pending receipt behind.
	appendReceipt(taskId, receipt);
	return receipt;
}

/** Record the terminal receipt and release the claim. */
export function settleClaim(
	taskId: string,
	receipt: Receipt,
	outcome: { status: "confirmed" | "failed"; ref?: string; error?: string },
): Receipt {
	assertTaskId(taskId);
	const terminal: Receipt = {
		...receipt,
		status: outcome.status,
		confirmed_at: new Date().toISOString(),
		...(outcome.ref === undefined ? {} : { ref: outcome.ref }),
		...(outcome.error === undefined ? {} : { error: outcome.error }),
	};
	appendReceipt(taskId, terminal);
	try {
		fs.rmSync(stateFiles(taskId).claim);
	} catch {
		// already released
	}
	return terminal;
}

/**
 * Run an irreversible op under the full protocol. `perform` must return the
 * provider's truth ref. A throw yields a `failed` terminal receipt; a crash
 * leaves the PENDING receipt for reconcile.
 */
export async function withSideEffect<T extends { ref?: string }>(
	taskId: string,
	op: IrreversibleOp,
	epoch: number,
	options: { target: string; headSha?: string; revalidate?: () => void | Promise<void> },
	perform: () => Promise<T>,
): Promise<{ result: T; receipt: Receipt }> {
	const receipt = acquireClaim(taskId, op, epoch, options);
	try {
		if (options.revalidate !== undefined) await options.revalidate();
		const result = await perform();
		const settled = settleClaim(taskId, receipt, {
			status: "confirmed",
			...(result.ref === undefined ? {} : { ref: result.ref }),
		});
		return { result, receipt: settled };
	} catch (error) {
		settleClaim(taskId, receipt, {
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
