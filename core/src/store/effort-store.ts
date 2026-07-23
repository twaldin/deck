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
	atomicWriteJson,
	ensurePrivateDir,
	fsyncDirectory,
	parseJsonFile,
	readJsonLines,
	repairTrailingJsonLine,
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
			if (result.manifest.project !== current.project) {
				throw new DeckError("E_STATE", "manifest project is immutable");
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
			this.assertTerminalEvidence(next);
			const event = normalizeEvent(result.event);
			const committed = this.findCommittedEvent(event);
			if (committed !== null) {
				throw new DeckError("E_STATE", "paired mutation event is already committed", {
					event_id: event.id,
					committed_event_id: committed.id,
				});
			}
			atomicWriteJson(this.manifestPath, next, manifestSchema, `${this.manifestPath}.tmp`);
			appendJsonLine(this.tailPath, event, eventSchema);
			return next;
		});
	}

	/**
	 * Standalone append: one O_APPEND write + fsync. All appends serialize with
	 * boot repair; a supplied owner token is fenced in the same lock hold.
	 * Retried facts return the already-committed matching idem record.
	 */
	appendEvent(input: EventInput, leaseToken: string | null = null): DeckEvent {
		const event = normalizeEvent(input);
		return withExclusiveLock(this.lockPath, () => {
			if (leaseToken !== null) {
				this.assertLeaseMatches(leaseToken, this.readManifest());
			}
			const committed = this.findCommittedEvent(event);
			if (committed !== null) {
				return committed;
			}
			return appendJsonLine(this.tailPath, event, eventSchema);
		});
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
	 * Allocate the fencing generation before a process exists. The returned
	 * token can be injected into its immutable spawn environment; bind it after
	 * the session id becomes observable.
	 */
	reserveLease(expectedRevision: number): Lease {
		assertExpectedRevision(expectedRevision);
		return withExclusiveLock(this.lockPath, () => {
			const manifest = this.readManifest();
			assertManifestRevision(manifest, expectedRevision);
			const currentLease = this.readLease();
			const epoch = Math.max(currentLease?.epoch ?? 0, manifest.session?.lease_epoch ?? 0) + 1;
			const lease = leaseSchema.parse({
				epoch,
				token: randomBytes(32).toString("base64url"),
				holder: null,
				written: Date.now(),
			});
			atomicWriteJson(this.leasePath, lease, leaseSchema, `${this.leasePath}.tmp`);
			const next = manifestSchema.parse({
				...manifest,
				revision: manifest.revision + 1,
				updated: new Date().toISOString(),
			});
			const event = normalizeEvent({
				plane: "lifecycle",
				type: "lifecycle.lease_reserved",
				actor: "router",
				data: { epoch },
			});
			atomicWriteJson(this.manifestPath, next, manifestSchema, `${this.manifestPath}.tmp`);
			appendJsonLine(this.tailPath, event, eventSchema);
			return lease;
		});
	}

	/**
	 * Bind a reserved generation without rotating its token. CAS prevents two
	 * spawn completions from projecting different sessions for one generation.
	 */
	bindLeaseSession(expectedRevision: number, token: string, sessionRef: LeaseSessionInput): Lease {
		assertExpectedRevision(expectedRevision);
		const session = leaseSessionInputSchema.parse(sessionRef);
		if (token.length === 0) {
			throw new DeckError("E_ARG", "lease token must be non-empty");
		}
		return withExclusiveLock(this.lockPath, () => {
			const manifest = this.readManifest();
			assertManifestRevision(manifest, expectedRevision);
			const lease = this.readLease();
			if (lease === null || lease.token !== token) {
				throw new DeckError("E_LEASE", "reserved owner lease is stale");
			}
			if (lease.holder !== null
				&& (lease.holder.machine !== session.machine || lease.holder.session_id !== session.session_id)) {
				throw new DeckError("E_LEASE", "lease generation is already bound to another session", {
					epoch: lease.epoch,
				});
			}
			const holder = { ...session, lease_epoch: lease.epoch };
			const boundLease = leaseSchema.parse({ ...lease, holder, written: Date.now() });
			atomicWriteJson(this.leasePath, boundLease, leaseSchema, `${this.leasePath}.tmp`);
			const next = manifestSchema.parse({
				...manifest,
				session: holder,
				revision: manifest.revision + 1,
				updated: new Date().toISOString(),
			});
			const event = normalizeEvent({
				plane: "lifecycle",
				type: "lifecycle.lease_bound",
				actor: "router",
				data: { epoch: lease.epoch, machine: holder.machine, session_id: holder.session_id },
			});
			atomicWriteJson(this.manifestPath, next, manifestSchema, `${this.manifestPath}.tmp`);
			appendJsonLine(this.tailPath, event, eventSchema);
			return boundLease;
		});
	}

	/**
	 * Establish a new owner generation. This fencing primitive serializes on
	 * manifest.lock, advances from the latest durable epoch, writes the lease
	 * first (fencing the old owner), then updates manifest.session and its event.
	 */
	bumpLease(expectedRevision: number, sessionRef: LeaseSessionInput): Lease {
		assertExpectedRevision(expectedRevision);
		const session = leaseSessionInputSchema.parse(sessionRef);
		return withExclusiveLock(this.lockPath, () => {
			const manifest = this.readManifest();
			assertManifestRevision(manifest, expectedRevision);
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

	/**
	 * True iff `token` is the current lease AND the manifest projection agrees on
	 * the epoch — the EXACT predicate the mutation fence (assertLeaseMatches)
	 * enforces. Fast-fail callers (the lifecycle extension) MUST use this, not
	 * verifyLease: during the reserve→bind window the lease epoch leads
	 * manifest.session, so a token-only check passes while a real mutation would
	 * reject. Fencing on both keeps the fast-fail consistent with the authority.
	 */
	leaseMatches(token: string): boolean {
		if (token.length === 0) {
			return false;
		}
		const lease = this.readLease();
		if (lease === null || lease.token !== token) {
			return false;
		}
		return this.readManifest().session?.lease_epoch === lease.epoch;
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

	inboxMarkDelivered(cmdId: string, leaseToken: string | null = null): InboxCommand {
		return this.appendInboxReceipt(cmdId, "delivered", leaseToken);
	}

	inboxAck(cmdId: string, leaseToken: string): InboxCommand {
		if (leaseToken.length === 0) {
			throw new DeckError("E_ARG", "leaseToken must be non-empty");
		}
		return this.appendInboxReceipt(cmdId, "acked", leaseToken);
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
	/**
	 * Composite card answer (TUI flow, D-A). WRITE ORDER: the card_answer inbox
	 * command lands FIRST (fsynced, deterministic cmd_id so retries dedupe),
	 * then the manifest projection flips under the lock. A crash between the
	 * two leaves a deliverable command with the card still open — benign: the
	 * owner receives the answer and a re-answer completes the projection. The
	 * reverse order would silently drop the decision (the firstmate resend bug).
	 */
	answerCard(cardId: string, answer: string): Manifest {
		if (cardId.length === 0 || answer.length === 0) {
			throw new DeckError("E_ARG", "answerCard requires cardId and answer");
		}
		const before = this.readManifest();
		const entry = before.cards.find((candidate) => candidate.id === cardId);
		if (entry === undefined) {
			throw new DeckError("E_STATE", "no such card", { cardId });
		}
		if (entry.status === "answered") {
			if (entry.answer === answer) return before; // idempotent re-answer (crash recovery)
			throw new DeckError("E_STATE", "card already answered differently", { cardId });
		}
		this.inboxAppend({
			cmd_id: `card-answer:${cardId}`,
			from: "tim",
			cmd: { kind: "card_answer", card_id: cardId, answer },
		});
		const now = Date.now();
		return this.mutate(before.revision, null, (manifest) => ({
			manifest: {
				...manifest,
				cards: manifest.cards.map((candidate) =>
					candidate.id === cardId
						? { ...candidate, status: "answered" as const, answer, answered_ts: now }
						: candidate,
				),
				decisions: [...manifest.decisions, { ts: now, card_id: cardId, answer }],
				overlays: {
					...manifest.overlays,
					needs_tim: manifest.overlays.needs_tim.filter((id) => id !== cardId),
				},
			},
			event: {
				plane: "tim",
				type: "tim.decision",
				actor: "tim",
				data: { card_id: cardId, answer },
			},
		}));
	}

	/** Called by openEffort before the handle is returned. */
	recoverTrailingTail(): void {
		withExclusiveLock(this.lockPath, () => {
			repairTrailingJsonLine(
				this.tailPath,
				path.join(this.directory, EFFORT_FILES.tailBad),
				eventSchema,
			);
			repairTrailingJsonLine(
				this.inboxPath,
				path.join(this.directory, "inbox.bad"),
				inboxRecordSchema,
			);
		});
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

	private assertTerminalEvidence(next: Manifest): void {
		if (next.stage !== "done") {
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

	private appendInboxReceipt(
		cmdId: string,
		receipt: "delivered" | "acked",
		leaseToken: string | null,
	): InboxCommand {
		if (cmdId.length === 0) {
			throw new DeckError("E_ARG", "cmd_id must be non-empty");
		}
		return withExclusiveLock(this.lockPath, () => {
			if (leaseToken !== null) {
				this.assertLeaseMatches(leaseToken, this.readManifest());
			}
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

	private findCommittedEvent(event: DeckEvent): DeckEvent | null {
		const committed = readJsonLines(this.tailPath, eventSchema);
		const sameId = committed.find((candidate) => candidate.id === event.id);
		if (sameId !== undefined) {
			if (JSON.stringify(sameId) !== JSON.stringify(event)) {
				throw new DeckError("E_STATE", "event id is already used by different content", { event_id: event.id });
			}
			return sameId;
		}
		if (event.idem === undefined) {
			return null;
		}
		const idem = event.idem;
		return committed.find((candidate) => {
			if (candidate.idem === undefined) {
				return false;
			}
			return candidate.idem.source === idem.source
				&& candidate.idem.external_id === idem.external_id
				&& candidate.idem.version === idem.version;
		}) ?? null;
	}
}

export function openEffort(effortId: string): EffortStore {
	const store = new EffortStore(effortId);
	const manifest = store.readManifest();
	if (manifest.effort_id !== effortId) {
		throw new DeckError("E_IO", "manifest effort_id does not match its directory", {
			directory_effort_id: effortId,
			manifest_effort_id: manifest.effort_id,
		});
	}
	store.readCharter();
	store.recoverTrailingTail();
	return store;
}

export function createEffort(input: CreateEffortInput): EffortStore {
	const parsed = createEffortInputSchema.parse(input);
	assertSafeEffortId(parsed.effort_id);
	if (!parsed.effort_id.startsWith(`${parsed.project}--`)) {
		throw new DeckError("E_ARG", "effort_id must be prefixed by project", {
			effort_id: parsed.effort_id,
			project: parsed.project,
		});
	}
	ensureStateDirs();
	const directory = effortDir(parsed.effort_id);
	if (fs.existsSync(directory)) {
		throw new DeckError("E_STATE", "effort already exists", { effort_id: parsed.effort_id });
	}
	const staging = path.join(EFFORTS_DIR, `.creating-${ulid()}`);
	fs.mkdirSync(staging, { mode: 0o700 });
	ensurePrivateDir(staging);
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
	try {
		const charterPath = path.join(staging, EFFORT_FILES.charter);
		const manifestPath = path.join(staging, EFFORT_FILES.manifest);
		const tailPath = path.join(staging, EFFORT_FILES.tail);
		const inboxPath = path.join(staging, EFFORT_FILES.inbox);
		atomicWriteJson(charterPath, charter, charterSchema);
		atomicWriteJson(manifestPath, manifest, manifestSchema, `${manifestPath}.tmp`);
		fs.writeFileSync(tailPath, "", { mode: 0o600 });
		fs.writeFileSync(inboxPath, "", { mode: 0o600 });
		appendJsonLine(tailPath, normalizeEvent({
			plane: "lifecycle",
			type: "lifecycle.effort_created",
			actor: "store",
			data: { effort_id: parsed.effort_id },
		}), eventSchema);
		fs.renameSync(staging, directory);
		fsyncDirectory(EFFORTS_DIR);
	} catch (error) {
		fs.rmSync(staging, { recursive: true, force: true });
		if (error instanceof DeckError) {
			throw error;
		}
		throw new DeckError("E_IO", "cannot create effort atomically", {
			effort_id: parsed.effort_id,
			cause: error instanceof Error ? error.message : String(error),
		});
	}
	return openEffort(parsed.effort_id);
}

export function listEfforts(): EffortStore[] {
	ensureStateDirs();
	return fs.readdirSync(EFFORTS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
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
	const parsed = z.string()
		.regex(/^[A-Za-z0-9._-]+--[A-Za-z0-9._-]+$/, "effort_id must match <project>--<slug>")
		.safeParse(effortId);
	if (!parsed.success || path.basename(parsed.data) !== parsed.data) {
		throw new DeckError("E_ARG", "effort_id must be one safe <project>--<slug> segment", { effort_id: effortId });
	}
}

function assertExpectedRevision(expectedRevision: number): void {
	if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
		throw new DeckError("E_ARG", "expectedRevision must be a nonnegative integer", { expectedRevision });
	}
}

function assertManifestRevision(manifest: Manifest, expectedRevision: number): void {
	if (manifest.revision !== expectedRevision) {
		throw new DeckError("E_CAS", "manifest revision changed", {
			expected_revision: expectedRevision,
			actual_revision: manifest.revision,
		});
	}
}
