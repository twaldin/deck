import {
	ensureStateDirs,
	openEffort,
	type DeckConfig,
} from "@deck/core";
import { AdmissionController } from "./admission";
import { ChildRegistry } from "./child-registry";
import { WakeCoalescer } from "./coalescer";
import { RouterControlServer } from "./control-server";
import { FactPipeline } from "./fact-pipeline";
import { GhAdapter } from "./gh-adapter";
import { runBoundedCommand, type BoundedCommandOptions, type CommandResult } from "./process-group";
import { PollScheduler } from "./scheduler";
import { OwnerSupervisor } from "./supervisor";
import type { RouterRuntimeConfig } from "./runtime-config";

export class WakeRouter {
	readonly supervisor: OwnerSupervisor;
	readonly scheduler: PollScheduler;
	readonly pipeline: FactPipeline;
	readonly control: RouterControlServer;
	private readonly config: DeckConfig;
	private readonly registry: ChildRegistry;
	private readonly coalescer: WakeCoalescer;
	private tickTimer: NodeJS.Timeout | undefined;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private tickRunning = false;
	private stopped = false;

	constructor(runtime: RouterRuntimeConfig) {
		this.config = runtime.deck;
		ensureStateDirs();
		this.registry = new ChildRegistry();
		const admission = new AdmissionController(runtime.deck.admission);
		this.supervisor = new OwnerSupervisor({
			config: runtime.deck,
			piCommand: runtime.piCommand,
			ownerModel: runtime.ownerModel,
			lifecycleExtensionPath: runtime.lifecycleExtensionPath,
			queueLimit: runtime.queueLimit,
			registry: this.registry,
			admission,
		});
		this.coalescer = new WakeCoalescer(
			runtime.deck.router.coalesceMs,
			async (batch) => {
				await this.supervisor.wake(
					batch.effortId,
					batch.summary,
					batch.events[batch.events.length - 1],
				);
			},
			(error) => console.error("wake coalescing failed", error),
		);
		this.pipeline = new FactPipeline({ coalescer: this.coalescer });
		const pollRunner = async (
			command: string,
			args: string[],
			options: BoundedCommandOptions,
		): Promise<CommandResult> => runBoundedCommand(command, args, {
			...options,
			onSpawn: (group) => {
				this.registry.add({
					pid: group.pid,
					pgid: group.pgid,
					kind: "poll",
					effort_id: null,
					dispatch_id: null,
					session_id: null,
					command,
					started_at: Date.now(),
				});
			},
			onExit: (group) => {
				this.registry.remove(group.pgid);
			},
		});
		const gh = new GhAdapter({
			deadlineMs: runtime.deck.router.pollDeadlineMs,
			outputCapBytes: runtime.deck.router.pollOutputCapBytes,
			runner: pollRunner,
		});
		this.scheduler = new PollScheduler({
			config: runtime.deck.router,
			maxConcurrentPolls: runtime.deck.admission.maxConcurrentPolls,
			adapters: [gh],
			pipeline: this.pipeline,
			onDegraded: async (target, error) => {
				for (const effortId of target.effortIds) {
					openEffort(effortId).appendEvent({
						plane: "lifecycle",
						type: "lifecycle.intake_degraded",
						actor: `router:${target.source}`,
						data: {
							target: target.reference,
							error: error instanceof Error ? error.message : String(error),
						},
					});
				}
			},
		});
		this.control = new RouterControlServer({ supervisor: this.supervisor, scheduler: this.scheduler });
	}

	async initialize(): Promise<void> {
		await this.supervisor.recover();
		this.scheduler.rebuildWatchIndex();
	}

	async runOnce(): Promise<void> {
		await this.scheduler.tick(true);
		await this.coalescer.flushAll();
		await this.supervisor.tick();
		this.pipeline.flush();
	}

	async start(): Promise<void> {
		await this.control.start();
		await this.runTick(false);
		this.tickTimer = setInterval(() => {
			void this.runTick(false);
		}, this.config.router.tickMs);
		this.heartbeatTimer = setInterval(() => {
			void this.supervisor.tick().catch((error) => console.error("router heartbeat failed", error));
		}, this.config.router.heartbeatIntervalMs);
	}

	async shutdown(): Promise<void> {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		clearInterval(this.tickTimer);
		clearInterval(this.heartbeatTimer);
		this.tickTimer = undefined;
		this.heartbeatTimer = undefined;
		await this.coalescer.flushAll();
		this.pipeline.flush();
		await this.control.close();
		await this.supervisor.shutdown();
	}

	private async runTick(force: boolean): Promise<void> {
		if (this.tickRunning || this.stopped) {
			return;
		}
		this.tickRunning = true;
		try {
			await this.scheduler.tick(force);
			await this.supervisor.tick();
		} catch (error) {
			console.error("router tick failed", error);
		} finally {
			this.tickRunning = false;
		}
	}
}
