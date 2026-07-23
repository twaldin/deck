import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DeckError } from "../errors";
import { EFFORT_FILES, EFFORTS_DIR, effortDir, ensureStateDirs } from "../layout";
import {
	eventSchema,
	inboxCommandSchema,
	leaseSchema,
	manifestSchema,
	type DeckEvent,
	type InboxCommand,
	type Lease,
	type Manifest,
} from "../schemas";
import {
	appendJsonLine,
	appendQuarantinedLine,
	atomicWriteJson,
	ensurePrivateDir,
	parseJsonFile,
	readJsonLines,
	withExclusiveLock,
} from "./io";
import {
	createEffortInputSchema,
	eventInputSchema,
	inboxCommandInputSchema,
	inboxReceiptSchema,
	inboxRecordSchema,
	leaseSessionInputSchema,
	mutationResultSchema,
	type CreateEffortInput,
	type EventInput,
	type InboxCommandInput,
	type LeaseSessionInput,
	type MutationResult,
} from "./schemas";
import { charterSchema, type Charter } from "../schemas";
import { ulid } from "ulid";

const tailReadOptionsSchema = z.object({
	fromId: z.string().min(1).optional(),
	limit: z.number().int().positive().optional(),
});
export type TailReadOptions = z.infer<typeof tailReadOptionsSchema>;

export type ManifestMutation = (manifest: Manifest) => MutationResult;

/** Per-effort durable state handle. Construct through openEffort/createEffort. */
export class EffortStore {
	readonly effortId: string;
	readonly directory: string;
	readonly manifestPath: string;
	readonly tailPath: string;
	readonly charterPath: string;
	readonly lockPath: string;
	readonly leasePath: string;
	readonly inboxPath: string;

	constructor(effortId: string) {
		assertSafeEffortId(effortId);
		this.effortId = effortId;
		this.directory = effortDir(effortId);
		this.manifestPath = path.join(this.directory, EFFORT_FILES.manifest);
		this.tailPath = path.join(this.directory, EFFORT_FILES.tail);
		this.charterPath = path.join(this.directory, EFFORT_FILES.charter);
		this.lockPath = path.join(this.directory, EFFORT_FILES.lock);
		this.leasePath = path.join(this.directory, EFFORT_FILES.lease);
		this.inboxPath = path.join(this.directory, EFFORT_FILES.inbox);
	}

	/** Lock-free projection read; every boundary is parsed through manifestSchema. */
	readManifest(): Manifest {
		return parseJsonFile(this.manifestPath, manifestSchema);
	}

	readCharter(): Charter {
		return parseJsonFile(this.charterPath, charterSchema);
	}

	/**
	 * SPEC §3/§4.2 CAS writer. The callback returns both the new projection and
	 * its paired event; manifest rename and tail append happen under one lock.
	 * A null token is reserved for router/Tim writes and skips only lease fencing.
	 */
	mutate(expectedRevision: number, leaseToken: string | null, fn: ManifestMutation): Manifest {
		if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
			throw new DeckError("E_ARG", "expectedRevision must be a nonnegative integer", { expectedRevision });
		}
		if (leaseToken !== null && leaseToken.length === 0) {
			throw new DeckError("E_ARG", "leaseToken must be non-empty or null");
		}

		return withExclusiveLock(this.lockPath, () => {
			const current = this.readManifest();
			if (current.revision !== expectedRevision) {
				throw new DeckError("E_CAS", "manifest revision changed", {
				expected_revision: expectedRevision,
				actual_revision: current.revision,
			});
			}
			if (leaseToken !== null) {
				this.assertLeaseMatches(leaseToken, current);
			}

			const result = mutationResultSchema.parse(fn(structuredClone(current)));
			if (result.manifest.effort_id !== current.effort_id) {
				throw new DeckError("E_STATE", "effort_id is immutable", {
					expected: current.effort_id,
					actual: result.manifest.effort_id,
				});
			}
			if (result.manifest.created !== current.created) {
				throw new DeckError("E_STATE", "manifest created timestamp is immutable");
			}

			const next = manifestSchema.parse({
				...result.manifest,
				v: 2,
				revision: current.revision + 1,
				updated: new Date().toISOString(),
			});
			this.assertTerminalEvidence(current, next);
			const event = normalizeEvent(result.event);
			atomicWriteJson(this.manifestPath, next, manifestSchema, `${this.manifestPath}.tmp`);
			appendJsonLine(this.tailPath, event, eventSchema);
			return next;
		});
	}

	/** Standalone append: one O_APPEND write of one pre-serialized line + fsync. */
	appendEvent(input: EventInput): DeckEvent {
		const event = normalizeEvent(input);
		return appendJsonLine(this.tailPath, event, eventSchema);
	}

	/**
	 * Returns newest first. fromId is an exclusive pagination cursor: only
	 * records older than that event are returned. V1 reads the append-only file
	 * whole; the API permits a reverse-block reader without changing callers.
	 */
	readTail(options: TailReadOptions = {}): DeckEvent[] {
		const parsedOptions = tailReadOptionsSchema.parse(options);
		const newest = readJsonLines(this.tailPath, eventSchema).reverse();
		let start = 0;
		if (parsedOptions.fromId !== undefined) {
			const cursor = newest.findIndex((event) => event.id === parsedOptions.fromId);
			if (cursor < 0) {
				return [];
			}
			start = cursor + 1;
		}
		const end = parsedOptions.limit === undefined ? newest.length : start + parsedOptions.limit;
		return newest.slice(start, end);
	}

	/**
	 * Establish a new owner generation. This fencing primitive serializes on
	 * manifest.lock, advances from the latest durable epoch, writes the lease
	 * first (fencing the old owner), then updates manifest.session and its event.
	 */
	bumpLease(sessionRef: LeaseSessionInput): Lease {
		const session = leaseSessionInputSchema.parse(sessionRef);
		return withExclusiveLock(this.lockPath, () => {
			const manifest = this.readManifest();
			const currentLease = this.readLease();
			const manifestEpoch = manifest.session?.lease_epoch ?? 0;
			const epoch = Math.max(currentLease?.epoch ?? 0, manifestEpoch) + 1;
			const holder = {
				...session,
				lease_epoch: epoch,
			};
			const lease = leaseSchema.parse({
				epoch,
				token: randomBytes(32).toString("base64url"),
				holder,
				written: Date.now(),
			});
			atomicWriteJson(this.leasePath, lease, leaseSchema, `${this.leasePath}.tmp`);

			const next = manifestSchema.parse({
				...manifest,
				session: holder,
				revision: manifest.revision + 1,
				updated: new Date().toISOString(),
			});
			const event = normalizeEvent({
				plane: "lifecycle",
				type: "lifecycle.lease",
				actor: "router",
				data: { epoch, machine: holder.machine, session_id: holder.session_id },
			});
			atomicWriteJson(this.manifestPath, next, manifestSchema, `${this.manifestPath}.tmp`);
			appendJsonLine(this.tailPath, event, eventSchema);
			return lease;
		});
	}

	readLease(): Lease | null {
		if (!fs.existsSync(this.leasePath)) {
			return null;
		}
		return parseJsonFile(this.leasePath, leaseSchema);
	}

	verifyLease(token: string): boolean {
		if (token.length === 0) {
			return false;
		}
		const lease = this.readLease();
		return lease !== null && lease.token === token;
	}

	inboxAppend(input: InboxCommandInput): InboxCommand {
		const parsedInput = inboxCommandInputSchema.parse(input);
		return withExclusiveLock(this.lockPath, () => {
			const existing = this.inboxState().find((command) => command.cmd_id === parsedInput.cmd_id);
			if (existing !== undefined) {
				return existing;
			}
			const command = inboxCommandSchema.parse({
				...parsedInput,
				cmd_id: parsedInput.cmd_id ?? ulid(),
				ts: parsedInput.ts ?? Date.now(),
				delivered: null,
				acked: null,
			});
			return appendJsonLine(this.inboxPath, command, inboxCommandSchema);
		});
	}

	inboxMarkDelivered(cmdId: string): InboxCommand {
		return this.appendInboxReceipt(cmdId, "delivered");
	}

	inboxAck(cmdId: string): InboxCommand {
		return this.appendInboxReceipt(cmdId, "acked");
	}

	/** Fold append-only command and follow-up receipt records (SPEC §4.5.3). */
	inboxState(): InboxCommand[] {
		const records = readJsonLines(this.inboxPath, inboxRecordSchema);
		const commands = new Map<string, InboxCommand>();
		for (const record of records) {
			if ("cmd" in record) {
				if (!commands.has(record.cmd_id)) {
					commands.set(record.cmd_id, record);
				}
				continue;
			}
			const command = commands.get(record.cmd_id);
			if (command === undefined) {
				throw new DeckError("E_IO", "inbox receipt precedes its command", { cmd_id: record.cmd_id });
			}
			const updated = record.receipt === "delivered"
				? { ...command, delivered: record.ts }
				: { ...command, acked: record.ts };
			commands.set(record.cmd_id, inboxCommandSchema.parse(updated));
		}
		return [...commands.values()];
	}

	/** Called by openEffort before the handle is returned. */
	recoverTrailingTail(): void {
		if (!fs.existsSync(this.tailPath)) {
			fs.writeFileSync(this.tailPath, "", { mode: 0o600 });
			return;
		}
		const bytes = fs.readFileSync(this.tailPath);
		let logicalEnd = bytes.length;
		while (logicalEnd > 0 && (bytes[logicalEnd - 1] === 0x0a || bytes[logicalEnd - 1] === 0x0d)) {
			logicalEnd -= 1;
		}
		if (logicalEnd === 0) {
			return;
		}

		const content = bytes.subarray(0, logicalEnd).toString("utf8");
		const lines = content.split("\n");
		let malformedLast = false;
		for (let index = 0; index < lines.length; index += 1) {
			const rawLine = lines[index];
			if (rawLine === undefined) {
				continue;
			}
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			try {
				const decoded: unknown = JSON.parse(line);
				eventSchema.parse(decoded);
			} catch (error) {
				if (index !== lines.length - 1) {
					throw new DeckError("E_IO", "malformed non-trailing tail record", {
						line: index + 1,
						cause: error instanceof Error ? error.message : String(error),
					});
				}
				malformedLast = true;
			}
		}
		if (!malformedLast) {
			return;
		}

		const previousNewline = bytes.lastIndexOf(0x0a, logicalEnd - 1);
		const badStart = previousNewline < 0 ? 0 : previousNewline + 1;
		appendQuarantinedLine(path.join(this.directory, EFFORT_FILES.tailBad), bytes.subarray(badStart, logicalEnd));
		let descriptor: number | null = null;
		try {
			descriptor = fs.openSync(this.tailPath, fs.constants.O_WRONLY);
			fs.ftruncateSync(descriptor, badStart);
			fs.fsyncSync(descriptor);
		} catch (error) {
			throw new DeckError("E_IO", "cannot truncate quarantined tail", {
				cause: error instanceof Error ? error.message : String(error),
			});
		} finally {
			if (descriptor !== null) {
				fs.closeSync(descriptor);
			}
		}
	}

	private assertLeaseMatches(token: string, manifest: Manifest): void {
		const lease = this.readLease();
		if (lease === null || lease.token !== token || manifest.session?.lease_epoch !== lease.epoch) {
			throw new DeckError("E_LEASE", "owner lease is stale", {
				manifest_epoch: manifest.session?.lease_epoch ?? null,
				lease_epoch: lease?.epoch ?? null,
			});
		}
	}

	private assertTerminalEvidence(current: Manifest, next: Manifest): void {
		if (current.stage === "done" || next.stage !== "done") {
			return;
		}
		const hasDeployEvidence = next.evidence.some((entry) => entry.scope === "deploy");
		const hasFalloutVerdict = readJsonLines(this.tailPath, eventSchema)
			.some((event) => event.type === "judgment.fallout_verdict");
		if (!hasDeployEvidence || !hasFalloutVerdict) {
			throw new DeckError("E_EVIDENCE", "done requires deploy evidence and a fallout verdict", {
				has_deploy_evidence: hasDeployEvidence,
				has_fallout_verdict: hasFalloutVerdict,
			});
		}
	}

	private appendInboxReceipt(cmdId: string, receipt: "delivered" | "acked"): InboxCommand {
		if (cmdId.length === 0) {
			throw new DeckError("E_ARG", "cmd_id must be non-empty");
		}
		return withExclusiveLock(this.lockPath, () => {
			const command = this.inboxState().find((candidate) => candidate.cmd_id === cmdId);
			if (command === undefined) {
				throw new DeckError("E_STATE", "unknown inbox command", { cmd_id: cmdId });
			}
			if ((receipt === "delivered" && command.delivered !== null)
				|| (receipt === "acked" && command.acked !== null)) {
				return command;
			}
			const followUp = inboxReceiptSchema.parse({ cmd_id: cmdId, receipt, ts: Date.now() });
			appendJsonLine(this.inboxPath, followUp, inboxReceiptSchema);
			return inboxCommandSchema.parse(receipt === "delivered"
				? { ...command, delivered: followUp.ts }
				: { ...command, acked: followUp.ts });
		});
	}
}

export function openEffort(effortId: string): EffortStore {
	const store = new EffortStore(effortId);
	store.readManifest();
	store.readCharter();
	store.recoverTrailingTail();
	return store;
}

export function createEffort(input: CreateEffortInput): EffortStore {
	const parsed = createEffortInputSchema.parse(input);
	assertSafeEffortId(parsed.effort_id);
	ensureStateDirs();
	const directory = effortDir(parsed.effort_id);
	try {
		fs.mkdirSync(directory, { mode: 0o700 });
	} catch (error) {
		throw new DeckError("E_STATE", "effort already exists or cannot be created", {
			effort_id: parsed.effort_id,
			cause: error instanceof Error ? error.message : String(error),
		});
	}
	ensurePrivateDir(directory);
	const now = new Date().toISOString();
	const charter = charterSchema.parse({ ...parsed.charter, created: now, charter_changes: [] });
	const manifest = manifestSchema.parse({
		v: 2,
		effort_id: parsed.effort_id,
		project: parsed.project,
		title: parsed.title,
		created: now,
		updated: now,
		revision: 0,
		stage: "intake",
		overlays: { blocked: null, needs_tim: [] },
		session: null,
		watch: { prs: [], tickets: [], slack_threads: [] },
		worktrees: [],
		dispatches: [],
		evidence: [],
		side_effects: [],
		cards: [],
		decisions: [],
		digest: null,
	});
	const store = new EffortStore(parsed.effort_id);
	atomicWriteJson(store.charterPath, charter, charterSchema);
	atomicWriteJson(store.manifestPath, manifest, manifestSchema, `${store.manifestPath}.tmp`);
	fs.writeFileSync(store.tailPath, "", { mode: 0o600 });
	fs.writeFileSync(store.inboxPath, "", { mode: 0o600 });
	store.appendEvent({
		plane: "lifecycle",
		type: "lifecycle.effort_created",
		actor: "store",
		data: { effort_id: parsed.effort_id },
	});
	return openEffort(parsed.effort_id);
}

export function listEfforts(): EffortStore[] {
	ensureStateDirs();
	return fs.readdirSync(EFFORTS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right))
		.map((effortId) => openEffort(effortId));
}

function normalizeEvent(input: EventInput): DeckEvent {
	const parsed = eventInputSchema.parse(input);
	return eventSchema.parse({
		...parsed,
		id: parsed.id ?? ulid(),
		ts: parsed.ts ?? new Date().toISOString(),
	});
}

function assertSafeEffortId(effortId: string): void {
	if (effortId.length === 0 || effortId === "." || effortId === ".." || path.basename(effortId) !== effortId) {
		throw new DeckError("E_ARG", "effort_id must be one path-safe segment", { effort_id: effortId });
	}
}
