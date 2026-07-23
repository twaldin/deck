import * as fs from "node:fs";
import * as path from "node:path";
import {
	DECK_HOME,
	DeckError,
	MACHINE,
	buildSeed,
	listEfforts,
	openEffort,
	ulid,
	type DeckConfig,
	type DeckEvent,
	type DispatchResult,
	type EffortStore,
	type SessionRef,
} from "@deck/core";
import { z } from "zod";
import {
	AdmissionController,
	type AdmissionDecision,
	type AdmissionSnapshot,
} from "./admission";
import { ChildRegistry, type ChildRecord } from "./child-registry";
import { isProcessGroupAlive } from "./process-group";
import { RpcChild, type RpcState } from "./rpc-child";
import type { JsonValue } from "./adapters";

const inboxTextSchema = z.object({ text: z.string().min(1) }).loose();
const wakeCommandSchema = z.object({ type: z.literal("wake"), reason: z.string().min(1) }).loose();
const ROUTER_MACHINE = z.string().min(1).parse(MACHINE);

interface ManagedOwner {
	kind: "owner";
	effortId: string;
	rpc: RpcChild;
	sessionId: string;
	leaseEpoch: number;
	leaseToken: string;
	lastPersistedHeartbeat: number;
	cleaned: boolean;
	expectedTermination: boolean;
}

interface ManagedDispatch {
	kind: "dispatch";
	effortId: string;
	dispatchId: string;
	rpc: RpcChild;
	sessionId: string;
	leaseEpoch: number;
	recorded: boolean;
	cleaned: boolean;
}

interface QueuedWake {
	reasons: string[];
	triggeringEvent?: DeckEvent;
}

interface DispatchInput {
	dispatchId: string;
	effortId: string;
	target: string;
	brief: string;
	leaseToken: string;
	signal?: AbortSignal;
}

interface PendingDispatch extends DispatchInput {
	resolve: (result: DispatchResult) => void;
	reject: (error: Error) => void;
	abort: () => void;
}

export type OwnerRuntimeState = "parked" | "ended" | "crash";

export interface SupervisorOptions {
	config: DeckConfig;
	piCommand: string[];
	ownerModel: string;
	lifecycleExtensionPath: string;
	queueLimit: number;
	registry?: ChildRegistry;
	admission?: AdmissionController;
	spawnEnv?: NodeJS.ProcessEnv;
	killGraceMs?: number;
	onOwnerState?: (effortId: string, state: OwnerRuntimeState) => void;
}

export interface SupervisorStatus {
	owners: Array<{ effort_id: string; pid: number; pgid: number; session_id: string; responsive: boolean }>;
	dispatches: Array<{ effort_id: string; dispatch_id: string; pid: number; pgid: number; session_id: string }>;
	queued_wakes: number;
	queued_dispatches: number;
	admission: AdmissionSnapshot;
}

export class OwnerSupervisor {
	private readonly config: DeckConfig;
	private readonly piCommand: string[];
	private readonly ownerModel: string;
	private readonly lifecycleExtensionPath: string;
	private readonly queueLimit: number;
	private readonly registry: ChildRegistry;
	private readonly admission: AdmissionController;
	private readonly spawnEnv: NodeJS.ProcessEnv;
	private readonly killGraceMs: number;
	private readonly onOwnerState: (effortId: string, state: OwnerRuntimeState) => void;
	private readonly owners = new Map<string, ManagedOwner>();
	private readonly dispatches = new Map<string, ManagedDispatch>();
	private readonly wakeQueue = new Map<string, QueuedWake>();
	private readonly dispatchQueue: PendingDispatch[] = [];
	private stopping = false;

	constructor(options: SupervisorOptions) {
		this.config = options.config;
		this.piCommand = z.array(z.string().min(1)).min(1).parse(options.piCommand);
		this.ownerModel = z.string().min(1).parse(options.ownerModel);
		this.lifecycleExtensionPath = z.string().min(1).parse(options.lifecycleExtensionPath);
		this.queueLimit = z.number().int().positive().parse(options.queueLimit);
		this.registry = options.registry ?? new ChildRegistry();
		this.admission = options.admission ?? new AdmissionController(options.config.admission);
		this.spawnEnv = options.spawnEnv ?? {};
		this.killGraceMs = options.killGraceMs ?? 5_000;
		this.onOwnerState = options.onOwnerState ?? (() => undefined);
	}

	async recover(): Promise<void> {
		const stale = await this.registry.reapStale(this.killGraceMs);
		for (const record of stale) {
			if (record.effort_id !== null) {
				appendLifecycleEvent(record.effort_id, "lifecycle.orphan_reaped", {
					kind: record.kind,
					pid: record.pid,
					pgid: record.pgid,
				});
			}
		}
		for (const store of listEfforts()) {
			reconcileHeartbeatlessDispatches(store);
		}
	}

	async wake(effortId: string, reason: string, triggeringEvent?: DeckEvent): Promise<{ queued: boolean }> {
		const store = openEffort(effortId);
		store.inboxAppend({
			from: "router",
			cmd: {
				type: "wake",
				reason,
				event_ids: triggeringEvent === undefined ? [] : [triggeringEvent.id],
			},
		});
		const owner = this.owners.get(effortId);
		if (owner !== undefined && await this.ownerResponsive(owner)) {
			await this.deliverPendingInbox(owner);
			return { queued: false };
		}
		if (owner !== undefined) {
			await this.terminateOwner(owner);
		}
		const admissionKey = `owner:${effortId}`;
		const decision = this.admission.tryReserve(admissionKey, "owner", effortId);
		if (!decision.allowed) {
			this.enqueueWake(effortId, reason, triggeringEvent);
			appendAdmissionDegraded(store, decision);
			return { queued: true };
		}
		try {
			const spawned = await this.spawnOwner(store, triggeringEvent);
			this.owners.set(effortId, spawned);
			this.watchOwnerExit(spawned);
			await this.deliverPendingInbox(spawned);
			return { queued: false };
		} catch (error) {
			this.admission.release(admissionKey);
			appendLifecycleEvent(effortId, "lifecycle.owner_spawn_degraded", {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async dispatch(
		effortId: string,
		target: string,
		brief: string,
		leaseToken: string,
		signal?: AbortSignal,
	): Promise<DispatchResult> {
		if (dispatchCallerDisconnected(signal)) {
			throw new DeckError("E_STATE", "dispatch caller disconnected before admission");
		}
		const store = openEffort(effortId);
		if (!store.verifyLease(leaseToken)) {
			throw new DeckError("E_LEASE", "dispatch caller lease is stale");
		}
		const dispatchId = ulid();
		const decision = this.admission.tryReserve(`dispatch:${dispatchId}`, "dispatch", effortId);
		if (decision.allowed) {
			return this.spawnDispatch({ dispatchId, effortId, target, brief, leaseToken, signal });
		}
		if (this.dispatchQueue.length + this.wakeQueue.size >= this.queueLimit) {
			throw new DeckError("E_ADMISSION", `router spawn queue is full (${this.queueLimit})`, {
				reason: decision.reason,
			});
		}
		const { promise, resolve, reject } = Promise.withResolvers<DispatchResult>();
		const pending: PendingDispatch = {
			dispatchId,
			effortId,
			target,
			brief,
			leaseToken,
			signal,
			resolve,
			reject,
			abort: () => undefined,
		};
		pending.abort = () => {
			const index = this.dispatchQueue.indexOf(pending);
			if (index >= 0) {
				this.dispatchQueue.splice(index, 1);
				pending.reject(new DeckError("E_STATE", "dispatch caller disconnected while queued"));
			}
		};
		signal?.addEventListener("abort", pending.abort, { once: true });
		this.dispatchQueue.push(pending);
		if (dispatchCallerDisconnected(signal)) {
			pending.abort();
		}
		appendAdmissionDegraded(store, decision);
		return promise;
	}

	async cancel(effortId: string, dispatchId: string): Promise<void> {
		const managed = this.dispatches.get(dispatchId);
		if (managed !== undefined && managed.effortId === effortId) {
			await managed.rpc.terminate(this.killGraceMs);
			this.cleanupDispatch(managed);
		}
		mutateDispatchState(openEffort(effortId), dispatchId, "cancelled", "lifecycle.dispatch_cancelled");
		await this.drainQueues();
	}

	async tick(): Promise<void> {
		for (const owner of [...this.owners.values()]) {
			if (!isProcessGroupAlive(owner.rpc.pgid)) {
				this.cleanupOwner(owner);
				continue;
			}
			await this.deliverPendingInbox(owner);
			await this.persistHeartbeat(owner);
		}
		await this.drainQueues();
	}

	async status(): Promise<SupervisorStatus> {
		const owners: SupervisorStatus["owners"] = [];
		for (const owner of this.owners.values()) {
			owners.push({
				effort_id: owner.effortId,
				pid: owner.rpc.pid,
				pgid: owner.rpc.pgid,
				session_id: owner.sessionId,
				responsive: await this.ownerResponsive(owner),
			});
		}
		return {
			owners,
			dispatches: [...this.dispatches.values()].map((dispatch) => ({
				effort_id: dispatch.effortId,
				dispatch_id: dispatch.dispatchId,
				pid: dispatch.rpc.pid,
				pgid: dispatch.rpc.pgid,
				session_id: dispatch.sessionId,
			})),
			queued_wakes: this.wakeQueue.size,
			queued_dispatches: this.dispatchQueue.length,
			admission: this.admission.snapshot(),
		};
	}

	async shutdown(): Promise<void> {
		this.stopping = true;
		for (const pending of this.dispatchQueue.splice(0)) {
			pending.signal?.removeEventListener("abort", pending.abort);
			pending.reject(new DeckError("E_STATE", "router is shutting down"));
		}
		for (const dispatch of [...this.dispatches.values()]) {
			await dispatch.rpc.terminate(this.killGraceMs);
			this.cleanupDispatch(dispatch);
		}
		for (const owner of [...this.owners.values()]) {
			await this.terminateOwner(owner);
		}
	}

	private async spawnOwner(store: EffortStore, triggeringEvent?: DeckEvent): Promise<ManagedOwner> {
		const manifest = store.readManifest();
		const resumeSessionId = manifest.session?.session_id;
		const lease = resumeSessionId === undefined
			? store.reserveLease(manifest.revision)
			: store.bumpLease({
				machine: ROUTER_MACHINE,
				session_id: resumeSessionId,
				last_heartbeat: null,
			});
		const args = this.piArgs(this.ownerModel, store.effortId);
		if (resumeSessionId !== undefined) {
			args.push("--session", resumeSessionId);
		}
		const rpc = await this.spawnRpc("owner", store.effortId, null, args, lease.token, "owner");
		try {
			const state = await this.awaitState(rpc, Date.now() + this.config.router.spawnDeadlineMs);
			if (resumeSessionId === undefined) {
				bindFreshOwnerSession(store, lease.token, state.sessionId);
			}
			this.registry.update(rpc.pgid, { session_id: state.sessionId });
			if (resumeSessionId === undefined) {
				const seed = buildSeed(store.effortId, {
					triggeringEvent,
					tokenBudget: this.config.seedTokenBudget,
				});
				await rpc.inject(seed.text);
			}
			return {
				kind: "owner",
				effortId: store.effortId,
				rpc,
				expectedTermination: false,
				sessionId: state.sessionId,
				leaseEpoch: lease.epoch,
				leaseToken: lease.token,
				lastPersistedHeartbeat: 0,
				cleaned: false,
			};
		} catch (error) {
			await rpc.terminate(this.killGraceMs);
			this.registry.remove(rpc.pgid);
			throw error;
		}
	}

	private async spawnDispatch(input: DispatchInput): Promise<DispatchResult> {
		const store = openEffort(input.effortId);
		if (dispatchCallerDisconnected(input.signal)) {
			this.admission.release(`dispatch:${input.dispatchId}`);
			throw new DeckError("E_STATE", "dispatch caller disconnected before spawn");
		}
		if (!store.verifyLease(input.leaseToken)) {
			this.admission.release(`dispatch:${input.dispatchId}`);
			throw new DeckError("E_LEASE", "dispatch caller lease became stale while queued");
		}
		const lease = store.readLease();
		if (lease === null) {
			this.admission.release(`dispatch:${input.dispatchId}`);
			throw new DeckError("E_LEASE", "effort has no active lease");
		}
		const args = this.piArgs(input.target, input.effortId);
		let rpc: RpcChild;
		try {
			rpc = await this.spawnRpc(
				"dispatch",
				input.effortId,
				input.dispatchId,
				args,
				input.leaseToken,
				`wf:${input.target}/${input.dispatchId}`,
			);
		} catch (error) {
			this.admission.release(`dispatch:${input.dispatchId}`);
			throw new DeckError("E_LIVENESS", error instanceof Error ? error.message : String(error), {
				dispatch_id: input.dispatchId,
			});
		}
		const managed: ManagedDispatch = {
			kind: "dispatch",
			effortId: input.effortId,
			dispatchId: input.dispatchId,
			rpc,
			sessionId: "pending",
			leaseEpoch: lease.epoch,
			recorded: false,
			cleaned: false,
		};
		this.dispatches.set(input.dispatchId, managed);
		this.watchDispatchExit(managed);
		const deadlineAt = Date.now() + this.config.router.spawnDeadlineMs;
		let abortTermination: Promise<void> | null = null;
		const abort = (): void => {
			abortTermination ??= rpc.terminate(this.killGraceMs);
		};
		input.signal?.addEventListener("abort", abort, { once: true });
		if (dispatchCallerDisconnected(input.signal)) {
			abort();
		}
		try {
			const state = await this.awaitState(rpc, deadlineAt);
			managed.sessionId = state.sessionId;
			this.registry.update(rpc.pgid, { session_id: state.sessionId });
			await rpc.inject(input.brief, Math.max(1, deadlineAt - Date.now()));
			const heartbeat = await rpc.waitForHeartbeat(state.sessionFile, deadlineAt);
			if (dispatchCallerDisconnected(input.signal)) {
				throw new DeckError("E_STATE", "dispatch caller disconnected before liveness verification");
			}
			const session: SessionRef = {
				machine: ROUTER_MACHINE,
				session_id: state.sessionId,
				lease_epoch: lease.epoch,
				last_heartbeat: heartbeat,
			};
			recordDispatch(store, input, session);
			managed.recorded = true;
			return { dispatch_id: input.dispatchId, session };
		} catch (error) {
			await (abortTermination ?? rpc.terminate(this.killGraceMs));
			this.cleanupDispatch(managed);
			if (error instanceof DeckError) {
				throw error;
			}
			throw new DeckError("E_LIVENESS", error instanceof Error ? error.message : String(error), {
				dispatch_id: input.dispatchId,
			});
		} finally {
			input.signal?.removeEventListener("abort", abort);
		}
	}

	private async spawnRpc(
		kind: ChildRecord["kind"],
		effortId: string,
		dispatchId: string | null,
		args: string[],
		leaseToken: string,
		actor: string,
	): Promise<RpcChild> {
		const [command, ...prefix] = this.piCommand;
		if (command === undefined) {
			throw new DeckError("E_STATE", "pi command is empty");
		}
		let rpc: RpcChild | undefined;
		rpc = new RpcChild(command, [...prefix, ...args], {
			env: {
				...process.env,
				...this.spawnEnv,
				DECK_ACTOR: actor,
				DECK_EFFORT: effortId,
				DECK_LEASE_TOKEN: leaseToken,
			},
			onEvent: (event) => {
				if (kind === "owner" && event.type === "agent_end" && rpc !== undefined) {
					void this.parkOwnerAfterAgentEnd(effortId, rpc).catch((error) => {
						console.error("owner park handling failed", error);
					});
				}
			},
		});
		try {
			this.registry.add({
				pid: rpc.pid,
				pgid: rpc.pgid,
				kind,
				effort_id: effortId,
				dispatch_id: dispatchId,
				session_id: null,
				command,
				started_at: Date.now(),
			});
		} catch (error) {
			await rpc.terminate(this.killGraceMs);
			throw error;
		}
		return rpc;
	}

	private piArgs(model: string, effortId: string): string[] {
		const sessionDir = path.join(DECK_HOME, "sessions", effortId);
		fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
		fs.chmodSync(sessionDir, 0o700);
		return [
			"--mode", "rpc",
			"--provider", "deck",
			"--model", model,
			"--no-context-files",
			"-e", this.lifecycleExtensionPath,
			"--session-dir", sessionDir,
		];
	}

	private async awaitState(rpc: RpcChild, deadlineAt: number): Promise<RpcState> {
		let lastError: unknown = new Error("pi RPC did not respond");
		while (Date.now() < deadlineAt) {
			try {
				return await rpc.getState(Math.min(1_000, Math.max(1, deadlineAt - Date.now())));
			} catch (error) {
				lastError = error;
				if (!isProcessGroupAlive(rpc.pgid)) {
					break;
				}
			}
		}
		throw lastError;
	}

	private async ownerResponsive(owner: ManagedOwner): Promise<boolean> {
		if (!isProcessGroupAlive(owner.rpc.pgid)) {
			return false;
		}
		try {
			const state = await owner.rpc.getState(2_000);
			return state.sessionId === owner.sessionId;
		} catch {
			return false;
		}
	}

	private async deliverPendingInbox(owner: ManagedOwner): Promise<void> {
		const store = openEffort(owner.effortId);
		for (const command of store.inboxState()) {
			if (command.acked !== null) {
				continue;
			}
			await owner.rpc.inject(`[deck:cmd ${command.cmd_id}] ${commandText(command.cmd)}`);
			store.inboxMarkDelivered(command.cmd_id);
		}
	}

	private async persistHeartbeat(owner: ManagedOwner): Promise<void> {
		const heartbeat = owner.rpc.lastEventAt;
		if (heartbeat <= owner.lastPersistedHeartbeat) {
			return;
		}
		const store = openEffort(owner.effortId);
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const manifest = store.readManifest();
			if (manifest.session?.session_id !== owner.sessionId
				|| manifest.session.lease_epoch !== owner.leaseEpoch) {
				return;
			}
			try {
				store.mutate(manifest.revision, null, (current) => ({
					manifest: {
						...current,
						session: current.session === null ? null : { ...current.session, last_heartbeat: heartbeat },
					},
					event: {
						plane: "lifecycle",
						type: "lifecycle.heartbeat",
						actor: "router",
						data: { session_id: owner.sessionId, heartbeat },
					},
				}));
				owner.lastPersistedHeartbeat = heartbeat;
				return;
			} catch (error) {
				if (!(error instanceof DeckError && error.code === "E_CAS") || attempt === 4) {
					throw error;
				}
			}
		}
	}

	private enqueueWake(effortId: string, reason: string, triggeringEvent?: DeckEvent): void {
		const current = this.wakeQueue.get(effortId);
		if (current !== undefined) {
			current.reasons.push(reason);
			current.triggeringEvent = triggeringEvent ?? current.triggeringEvent;
			return;
		}
		if (this.wakeQueue.size + this.dispatchQueue.length >= this.queueLimit) {
			appendLifecycleEvent(effortId, "lifecycle.admission_queue_full", { limit: this.queueLimit });
			return;
		}
		this.wakeQueue.set(effortId, { reasons: [reason], triggeringEvent });
	}

	private async drainQueues(): Promise<void> {
		if (this.stopping) {
			return;
		}
		for (const [effortId, wake] of [...this.wakeQueue]) {
			const decision = this.admission.tryReserve(`owner:${effortId}`, "owner", effortId);
			if (!decision.allowed) {
				break;
			}
			this.wakeQueue.delete(effortId);
			try {
				const store = openEffort(effortId);
				const owner = await this.spawnOwner(store, wake.triggeringEvent);
				this.owners.set(effortId, owner);
				this.watchOwnerExit(owner);
				await this.deliverPendingInbox(owner);
			} catch (error) {
				this.admission.release(`owner:${effortId}`);
				appendLifecycleEvent(effortId, "lifecycle.owner_spawn_degraded", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		await this.reviveDurableInbox();
		while (this.dispatchQueue.length > 0) {
			const pending = this.dispatchQueue[0];
			if (pending === undefined) {
				break;
			}
			const decision = this.admission.tryReserve(
				`dispatch:${pending.dispatchId}`,
				"dispatch",
				pending.effortId,
			);
			if (!decision.allowed) {
				break;
			}
			this.dispatchQueue.shift();
			pending.signal?.removeEventListener("abort", pending.abort);
			void this.spawnDispatch(pending).then(pending.resolve, pending.reject);
		}
	}

	private async reviveDurableInbox(): Promise<void> {
		for (const store of listEfforts()) {
			if (this.owners.has(store.effortId) || this.wakeQueue.has(store.effortId)) {
				continue;
			}
			const parkedAt = latestParkedAt(store);
			const hasUnackedCommand = store.inboxState().some((command) =>
				command.acked === null && (parkedAt === null || command.ts > parkedAt));
			if (!hasUnackedCommand) {
				continue;
			}
			const admissionKey = `owner:${store.effortId}`;
			const decision = this.admission.tryReserve(admissionKey, "owner", store.effortId);
			if (!decision.allowed) {
				break;
			}
			try {
				const owner = await this.spawnOwner(store);
				this.owners.set(store.effortId, owner);
				this.watchOwnerExit(owner);
				await this.deliverPendingInbox(owner);
			} catch (error) {
				this.admission.release(admissionKey);
				appendLifecycleEvent(store.effortId, "lifecycle.owner_spawn_degraded", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	private async parkOwnerAfterAgentEnd(effortId: string, rpc: RpcChild): Promise<void> {
		const owner = this.owners.get(effortId);
		if (owner === undefined || owner.rpc !== rpc || owner.expectedTermination) {
			return;
		}
		const store = openEffort(effortId);
		if (!hasCurrentParkEvent(store)) {
			return;
		}
		owner.expectedTermination = true;
		store.appendEvent({
			plane: "lifecycle",
			type: "lifecycle.owner_exit",
			actor: "router",
			data: {
				session_id: owner.sessionId,
				state: "parked",
				exit_code: null,
				signal: "SIGTERM",
			},
		});
		await rpc.terminate(this.killGraceMs);
		this.cleanupOwner(owner);
		this.onOwnerState(effortId, "parked");

	}

	private watchOwnerExit(owner: ManagedOwner): void {
		void owner.rpc.group.exited.then(({ code, signal }) => {
			if (!owner.expectedTermination) {
				const store = openEffort(owner.effortId);
				const state = classifyOwnerExit(code);
				store.appendEvent({
					plane: "lifecycle",
					type: "lifecycle.owner_exit",
					actor: "router",
					data: {
						session_id: owner.sessionId,
						state,
						exit_code: code,
						signal,
					},
				});
				this.onOwnerState(owner.effortId, state);
			}
			this.cleanupOwner(owner);
			if (!this.stopping) {
				void this.drainQueues();
			}
		});
	}

	private watchDispatchExit(dispatch: ManagedDispatch): void {
		void dispatch.rpc.group.exited.then(({ code }) => {
			if (dispatch.recorded) {
				try {
					mutateDispatchState(
						openEffort(dispatch.effortId),
						dispatch.dispatchId,
						code === 0 ? "done" : "failed",
						code === 0 ? "lifecycle.dispatch_done" : "lifecycle.dispatch_failed",
					);
				} catch (error) {
					console.error(error);
				}
			}
			this.cleanupDispatch(dispatch);
			void this.drainQueues();
		});
	}

	private async terminateOwner(owner: ManagedOwner): Promise<void> {
		owner.expectedTermination = true;
		await owner.rpc.terminate(this.killGraceMs);
		this.cleanupOwner(owner);
	}

	private cleanupOwner(owner: ManagedOwner): void {
		if (owner.cleaned) {
			return;
		}
		owner.cleaned = true;
		this.owners.delete(owner.effortId);
		this.registry.remove(owner.rpc.pgid);
		this.admission.release(`owner:${owner.effortId}`);
	}

	private cleanupDispatch(dispatch: ManagedDispatch): void {
		if (dispatch.cleaned) {
			return;
		}
		dispatch.cleaned = true;
		this.dispatches.delete(dispatch.dispatchId);
		this.registry.remove(dispatch.rpc.pgid);
		this.admission.release(`dispatch:${dispatch.dispatchId}`);
	}
}

function bindFreshOwnerSession(store: EffortStore, leaseToken: string, sessionId: string): void {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const manifest = store.readManifest();
		try {
			store.bindLeaseSession(manifest.revision, leaseToken, {
				machine: ROUTER_MACHINE,
				session_id: sessionId,
				last_heartbeat: null,
			});
			return;
		} catch (error) {
			if (!(error instanceof DeckError && error.code === "E_CAS") || attempt === 4) {
				throw error;
			}
		}
	}
}

function recordDispatch(
	store: EffortStore,
	input: DispatchInput,
	session: SessionRef,
): void {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const manifest = store.readManifest();
		try {
			store.mutate(manifest.revision, input.leaseToken, (current) => ({
				manifest: {
					...current,
					dispatches: [...current.dispatches, {
						id: input.dispatchId,
						kind: "subagent",
						target: input.target,
						state: "running",
						started: Date.now(),
						session,
						result_ref: null,
					}],
				},
				event: {
					plane: "lifecycle",
					type: "lifecycle.dispatch",
					actor: "router",
					data: { dispatch_id: input.dispatchId, target: input.target, session_id: session.session_id },
				},
			}));
			return;
		} catch (error) {
			if (!(error instanceof DeckError && error.code === "E_CAS") || attempt === 4) {
				throw error;
			}
		}
	}
}

function mutateDispatchState(
	store: EffortStore,
	dispatchId: string,
	state: "done" | "failed" | "cancelled",
	eventType: string,
): void {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const manifest = store.readManifest();
		const dispatch = manifest.dispatches.find((candidate) => candidate.id === dispatchId);
		if (dispatch === undefined) {
			throw new DeckError("E_STATE", `unknown dispatch ${dispatchId}`);
		}
		if (dispatch.state === state) {
			return;
		}
		try {
			store.mutate(manifest.revision, null, (current) => ({
				manifest: {
					...current,
					dispatches: current.dispatches.map((candidate) => candidate.id === dispatchId
						? { ...candidate, state }
						: candidate),
				},
				event: {
					plane: "lifecycle",
					type: eventType,
					actor: "router",
					data: { dispatch_id: dispatchId, state },
				},
			}));
			return;
		} catch (error) {
			if (!(error instanceof DeckError && error.code === "E_CAS") || attempt === 4) {
				throw error;
			}
		}
	}
}

function reconcileHeartbeatlessDispatches(store: EffortStore): void {
	const manifest = store.readManifest();
	const broken = manifest.dispatches.filter((dispatch) =>
		(dispatch.state === "pending" || dispatch.state === "running")
		&& (dispatch.session === null || dispatch.session.last_heartbeat === null));
	for (const dispatch of broken) {
		const question = `Dispatch ${dispatch.id} has no first heartbeat. Retry it or leave it failed?`;
		if (store.readManifest().cards.some((entry) => entry.status === "open" && entry.card.question === question)) {
			continue;
		}
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const current = store.readManifest();
			const cardId = ulid();
			try {
				store.mutate(current.revision, null, (latest) => ({
					manifest: {
						...latest,
						dispatches: latest.dispatches.map((candidate) => candidate.id === dispatch.id
							? { ...candidate, state: "failed" }
							: candidate),
						overlays: {
							...latest.overlays,
							needs_tim: [...latest.overlays.needs_tim, cardId],
						},
						cards: [...latest.cards, {
							id: cardId,
							card: {
								kind: "flagged",
								question,
								recommendation: "Retry only if the work is still needed; no live lane was proven.",
								options: ["Retry dispatch", "Leave failed"],
							},
							status: "open",
							answer: null,
							answered_ts: null,
							cancel_in_flight: null,
						}],
					},
					event: {
						plane: "lifecycle",
						type: "lifecycle.dispatch_reconcile_failed",
						actor: "router",
						data: { dispatch_id: dispatch.id, card_id: cardId },
					},
				}));
				break;
			} catch (error) {
				if (!(error instanceof DeckError && error.code === "E_CAS") || attempt === 4) {
					throw error;
				}
			}
		}
	}
}

export type OwnerExitState = Exclude<OwnerRuntimeState, "parked">;

export function classifyOwnerExit(exitCode: number | null): OwnerExitState {
	return exitCode === 0 ? "ended" : "crash";
}

function latestParkedAt(store: EffortStore): number | null {
	const latestExit = store.readTail().find((event) => event.type === "lifecycle.owner_exit");
	if (latestExit === undefined) {
		return null;
	}
	const parsed = z.object({ state: z.string() }).loose().safeParse(latestExit.data);
	if (!parsed.success || parsed.data.state !== "parked") {
		return null;
	}
	const timestamp = Date.parse(latestExit.ts);
	return Number.isFinite(timestamp) ? timestamp : null;
}

/** Park requests are consumed only for the current lease generation and only as the newest lifecycle event. */
export function hasCurrentParkEvent(store: EffortStore): boolean {
	const newest = store.readTail();
	const newestLifecycle = newest.find((event) => event.plane === "lifecycle");
	if (newestLifecycle?.type !== "lifecycle.park") {
		return false;
	}
	const parkIndex = newest.findIndex((event) => event.id === newestLifecycle.id);
	const leaseIndex = newest.findIndex((event) => event.type === "lifecycle.lease");
	return leaseIndex < 0 || parkIndex < leaseIndex;
}

function dispatchCallerDisconnected(signal: AbortSignal | undefined): boolean {
	if (signal === undefined) {
		return false;
	}
	return signal.aborted;
}

function commandText(command: Record<string, unknown>): string {
	const text = inboxTextSchema.safeParse(command);
	if (text.success) {
		return text.data.text;
	}
	const wake = wakeCommandSchema.safeParse(command);
	if (wake.success) {
		return wake.data.reason;
	}
	return JSON.stringify(command);
}

function appendAdmissionDegraded(store: EffortStore, decision: AdmissionDecision): void {
	store.appendEvent({
		plane: "lifecycle",
		type: "lifecycle.admission_degraded",
		actor: "router",
		data: { reason: decision.reason, swap_used_bytes: decision.swapUsedBytes },
	});
}

function appendLifecycleEvent(
	effortId: string,
	type: string,
	data: Record<string, JsonValue>,
): void {
	openEffort(effortId).appendEvent({ plane: "lifecycle", type, actor: "router", data });
}
