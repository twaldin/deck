import * as fs from "node:fs";
import * as path from "node:path";
import { clearWakeConditions, enqueueWakeConditions, type WakeCondition } from "./wake";
import { smithersWorkspaceCwd } from "./workspace";

/** Durable producers used by workflow observers and the headless reconciler. */
export type ProducerSnapshot = {
	taskId: string;
	needsDecision?: string;
	maxAdversarial?: boolean;
	reviewerSilent?: boolean;
	mainRed?: boolean;
	migrationBlocked?: boolean;
	brokerNoQuota?: boolean;
	ciFail?: boolean;
	actionableComment?: boolean;
	decisionAsk?: boolean;
	terminal?: boolean;
};

export type WakeProducerPublish = {
	snapshot: ProducerSnapshot;
	dryRun: boolean;
	/** Override only for isolated tests. Production uses the canonical workspace. */
	workspace?: string;
};

export type WakeProducerIntent = { at: string; snapshot: ProducerSnapshot };

const PRODUCER_FILE = "wake-producers.json";
const INTENT_FILE = "wake-producer-intents.jsonl";

function producerFile(workspace: string): string {
	return path.join(workspace, PRODUCER_FILE);
}

function intentFile(workspace: string): string {
	return path.join(workspace, INTENT_FILE);
}

/** Read dry-run publication intents without touching the real wake queue. */
export function wakeProducerIntents(workspace = smithersWorkspaceCwd()): WakeProducerIntent[] {
	try {
		return fs
			.readFileSync(intentFile(workspace), "utf8")
			.split("\n")
			.flatMap((line) => {
				try { return [JSON.parse(line) as WakeProducerIntent]; }
				catch { return []; }
			});
	} catch {
		return [];
	}
}

/**
 * The only workflow-to-wake publisher. Dry runs retain observable intent but
 * never enter the real outbox. Tests must not call the real path: fail before
 * either the producer record or the wake queue can be written.
 */
export function publishWakeProducer({ snapshot, dryRun, workspace = smithersWorkspaceCwd() }: WakeProducerPublish): void {
	if (snapshot.taskId.length === 0) return;
	if (dryRun) {
		fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
		fs.appendFileSync(
			intentFile(workspace),
			`${JSON.stringify({ at: new Date().toISOString(), snapshot } satisfies WakeProducerIntent)}\n`,
			{ mode: 0o600 },
		);
		return;
	}
	if (process.env.NODE_ENV === "test") {
		throw new Error("refusing real wake publication from a test runner");
	}
	const file = producerFile(workspace);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const lock = `${file}.lock`;
	try { fs.mkdirSync(lock, { mode: 0o700 }); }
	catch { return; }
	try {
		let records: ProducerSnapshot[] = [];
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ProducerSnapshot | ProducerSnapshot[];
			records = Array.isArray(parsed) ? parsed : [parsed];
		} catch { /* create the producer record on first publish */ }
		records = records.filter((record) => record.taskId !== snapshot.taskId);
		records.push(snapshot);
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(records)}\n`, { mode: 0o600 });
		fs.renameSync(tmp, file);
		produceWakeConditions(snapshot);
	} finally {
		fs.rmSync(lock, { recursive: true, force: true });
	}
}

export function produceWakeConditions(snapshot: ProducerSnapshot): void {
	const conditions: WakeCondition[] = [];
	const add = (key: WakeCondition["key"], active: boolean | undefined, note: string) => {
		if (active) conditions.push({ key, taskId: snapshot.taskId, note });
	};
	add("max-adversarial", snapshot.maxAdversarial, "maximum adversarial review attempts reached");
	add("reviewer-silent", snapshot.reviewerSilent, "reviewer has not responded");
	add("main-red", snapshot.mainRed, "main branch failure requires shared diagnosis");
	add("migration-gate", snapshot.migrationBlocked, "migration gate is blocking progress");
	if (snapshot.terminal) {
		clearWakeConditions(snapshot.taskId, ["max-adversarial", "reviewer-silent", "main-red", "migration-gate", "broker-no-quota", "ci-fail", "actionable-comment", "decision-ask"]);
		return;
	}
	add("broker-no-quota", snapshot.brokerNoQuota, "broker has no available quota");
	if (snapshot.needsDecision) conditions.push({ key: "needs-decision", taskId: snapshot.taskId, note: snapshot.needsDecision });
	add("ci-fail", snapshot.ciFail, "CI failed and needs a fix");
	add("actionable-comment", snapshot.actionableComment, "an actionable review comment needs a fix");
	add("decision-ask", snapshot.decisionAsk, "a decision is required");
	const keys: WakeCondition["key"][] = ["max-adversarial", "reviewer-silent", "main-red", "migration-gate", "broker-no-quota", "needs-decision", "ci-fail", "actionable-comment", "decision-ask"];
	const active = new Set(conditions.map((condition) => condition.key));
	clearWakeConditions(snapshot.taskId, keys.filter((key) => !active.has(key)));
	enqueueWakeConditions(conditions);
}

/** Read observer records and produce all five condition classes after restart. */
export function reconcileWakeProducers(file: string): void {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ProducerSnapshot | ProducerSnapshot[];
		const values = Array.isArray(parsed) ? parsed : [parsed];
		for (const value of values) {
			if (value && typeof value.taskId === "string") produceWakeConditions(value);
		}
	} catch {
		// A missing or partial observer record is retried by the next reconcile.
	}
}

/** Single-owner coordination for a main-branch failure. */
export function releaseMainFailure(root: string, fingerprint: string): void {
	const file = path.join(root, "main-failure.json");
	try {
		const current = JSON.parse(fs.readFileSync(file, "utf8")) as { fingerprint?: string };
		if (current.fingerprint === fingerprint) fs.rmSync(file, { force: true });
	} catch { /* no active incident */ }
}

export function claimMainFailure(root: string, fingerprint: string, owner: string): boolean {
	const file = path.join(root, "main-failure.json");
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	try {
		const current = JSON.parse(fs.readFileSync(file, "utf8")) as { fingerprint?: string; owner?: string; claimedAt?: number };
		if (current.fingerprint === fingerprint && (!current.claimedAt || Date.now() - current.claimedAt < 30 * 60_000)) return current.owner === owner;
		if (current.fingerprint === fingerprint) fs.rmSync(file, { force: true });
	} catch { /* no record */ }
	const lock = `${file}.lock`;
	let acquired = false;
	try {
		try {
			const stat = fs.statSync(lock);
			if (Date.now() - stat.mtimeMs > 5 * 60_000) fs.rmSync(lock, { recursive: true, force: true });
		} catch { /* lock is absent */ }
		fs.mkdirSync(lock, { recursive: false, mode: 0o700 });
		acquired = true;
		const claim = JSON.stringify({ fingerprint, owner, state: "diagnosing", claimedAt: Date.now() }) + "\n";
		fs.writeFileSync(path.join(lock, "claim.json"), claim, { mode: 0o600 });
		fs.writeFileSync(`${file}.new`, claim, { mode: 0o600 });
		fs.renameSync(`${file}.new`, file);
		fs.rmSync(lock, { recursive: true, force: true });
		return true;
	} catch {
		if (acquired) try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* preserve the failure */ }
		return false;
	}
}
