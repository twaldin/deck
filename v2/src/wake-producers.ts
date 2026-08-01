import * as fs from "node:fs";
import * as path from "node:path";
import { enqueueWakeConditions, type WakeCondition } from "./wake";

/** Durable producers used by workflow observers and the headless reconciler. */
export type ProducerSnapshot = {
	taskId: string;
	maxAdversarial?: boolean;
	reviewerSilent?: boolean;
	mainRed?: boolean;
	migrationBlocked?: boolean;
	brokerNoQuota?: boolean;
};

export function produceWakeConditions(snapshot: ProducerSnapshot): void {
	const conditions: WakeCondition[] = [];
	const add = (key: WakeCondition["key"], active: boolean | undefined, note: string) => {
		if (active) conditions.push({ key, taskId: snapshot.taskId, note });
	};
	add("max-adversarial", snapshot.maxAdversarial, "maximum adversarial review attempts reached");
	add("reviewer-silent", snapshot.reviewerSilent, "reviewer has not responded");
	add("main-red", snapshot.mainRed, "main branch failure requires shared diagnosis");
	add("migration-gate", snapshot.migrationBlocked, "migration gate is blocking progress");
	add("broker-no-quota", snapshot.brokerNoQuota, "broker has no available quota");
	enqueueWakeConditions(conditions);
}

/** Read observer records and produce all five condition classes after restart. */
export function reconcileWakeProducers(file: string): void {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8")) as ProducerSnapshot;
		if (value && typeof value.taskId === "string") produceWakeConditions(value);
	} catch {
		// A missing or partial observer record is retried by the next reconcile.
	}
}

/** Single-owner coordination for a main-branch failure. */
export function claimMainFailure(root: string, fingerprint: string, owner: string): boolean {
	const file = path.join(root, "main-failure.json");
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	try {
		const current = JSON.parse(fs.readFileSync(file, "utf8")) as { fingerprint?: string; owner?: string };
		if (current.fingerprint === fingerprint) return current.owner === owner;
	} catch { /* no record */ }
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ fingerprint, owner, state: "diagnosing" }) + "\n", { mode: 0o600 });
	try { fs.renameSync(tmp, file); return true; } catch { return false; }
}
