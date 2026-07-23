import { listEfforts, type Manifest, type RouterConfig } from "@deck/core";
import { z } from "zod";
import type { SourceAdapter, WatchTarget } from "./adapters";
import { watchTargetSchema } from "./adapters";
import type { FactPipeline } from "./fact-pipeline";

export const pollLevelSchema = z.enum(["hot", "green", "quiet", "watching"]);
export type PollLevel = z.infer<typeof pollLevelSchema>;
const ciStateDataSchema = z.object({ state: z.string() }).loose();
const POLL_LEVEL_RANK: Record<PollLevel, number> = { hot: 0, green: 1, quiet: 2, watching: 3 };

export interface PollTargetStatus extends WatchTarget {
	next_poll_at: number;
	interval: number;
	level: PollLevel;
	failures: number;
}

interface ScheduledTarget {
	target: WatchTarget;
	nextPollAt: number;
	interval: number;
	level: PollLevel;
	failures: number;
	stickyRed: boolean;
}

export interface SchedulerOptions {
	config: RouterConfig;
	maxConcurrentPolls: number;
	adapters: SourceAdapter[];
	pipeline: FactPipeline;
	now?: () => number;
	random?: () => number;
	onDegraded?: (target: WatchTarget, error: unknown) => Promise<void>;
}

export class PollScheduler {
	private readonly config: RouterConfig;
	private readonly maxConcurrentPolls: number;
	private readonly adapters: SourceAdapter[];
	private readonly pipeline: FactPipeline;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly onDegraded: (target: WatchTarget, error: unknown) => Promise<void>;
	private schedules = new Map<string, ScheduledTarget>();

	constructor(options: SchedulerOptions) {
		this.config = options.config;
		this.maxConcurrentPolls = z.number().int().positive().parse(options.maxConcurrentPolls);
		this.adapters = options.adapters;
		this.pipeline = options.pipeline;
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.onDegraded = options.onDegraded ?? (async () => undefined);
	}

	/** Rebuild from lock-free manifest projections; existing cadence survives watch-index refreshes. */
	rebuildWatchIndex(): void {
		const desired = new Map<string, { target: WatchTarget; levels: PollLevel[] }>();
		for (const store of listEfforts()) {
			const manifest = store.readManifest();
			if (manifest.stage === "done" || manifest.stage === "abandoned") {
				continue;
			}
			const level = manifestLevel(manifest);
			for (const target of manifestTargets(manifest)) {
				const key = scheduleKey(target);
				const current = desired.get(key);
				if (current === undefined) {
					desired.set(key, { target, levels: [level] });
				} else {
					current.target.effortIds.push(manifest.effort_id);
					current.levels.push(level);
				}
			}
		}
		const next = new Map<string, ScheduledTarget>();
		for (const [key, entry] of desired) {
			entry.target.effortIds = [...new Set(entry.target.effortIds)].sort();
			const existing = this.schedules.get(key);
			const derivedLevel = mostUrgent(entry.levels);
			if (existing !== undefined) {
				existing.target = watchTargetSchema.parse(entry.target);
				if (existing.level === "watching" && derivedLevel !== "watching") {
					existing.level = derivedLevel;
					existing.interval = this.config.intervals[derivedLevel];
				}
				next.set(key, existing);
				continue;
			}
			next.set(key, {
				target: watchTargetSchema.parse(entry.target),
				nextPollAt: this.now() + Math.floor(this.random() * this.config.tickMs),
				interval: this.config.intervals[derivedLevel],
				level: derivedLevel,
				failures: 0,
				stickyRed: false,
			});
		}
		this.schedules = next;
	}

	async tick(force = false): Promise<void> {
		this.rebuildWatchIndex();
		const now = this.now();
		const due = [...this.schedules.values()].filter((schedule) => force || schedule.nextPollAt <= now);
		let index = 0;
		const workers = Array.from(
			{ length: Math.min(this.maxConcurrentPolls, due.length) },
			async () => {
				while (index < due.length) {
					const current = due[index];
					index += 1;
					if (current !== undefined) {
						await this.poll(current);
					}
				}
			},
		);
		await Promise.all(workers);
	}

	status(): PollTargetStatus[] {
		return [...this.schedules.values()].map((schedule) => ({
			...schedule.target,
			next_poll_at: schedule.nextPollAt,
			interval: schedule.interval,
			level: schedule.level,
			failures: schedule.failures,
		}));
	}

	private async poll(schedule: ScheduledTarget): Promise<void> {
		const source = this.adapters.find((adapter) => adapter.supports(schedule.target));
		if (source === undefined) {
			this.scheduleNext(schedule);
			return;
		}
		try {
			const adapter = source.bind(schedule.target);
			const result = await adapter.pollCmd(this.pipeline.cursorFor(schedule.target));
			this.pipeline.process(schedule.target, result);
			schedule.failures = 0;
			this.updateLevel(schedule, result.facts);
		} catch (error) {
			schedule.failures += 1;
			await this.onDegraded(schedule.target, error);
			const base = this.config.intervals[schedule.level];
			schedule.interval = Math.min(this.config.intervals.watching, base * (2 ** Math.min(6, schedule.failures)));
		}
		this.scheduleNext(schedule);
	}

	private updateLevel(schedule: ScheduledTarget, facts: { type: string; data: Record<string, unknown> }[]): void {
		let sawReview = false;
		let sawRed = false;
		let sawGreen = false;
		for (const fact of facts) {
			if (fact.type === "fact.pr.review") {
				sawReview = true;
			}
			if (fact.type === "fact.pr.ci_state") {
				const state = ciStateDataSchema.parse(fact.data).state;
				sawRed ||= state === "red";
				sawGreen ||= state === "green";
			}
		}
		if (sawRed) {
			schedule.level = "hot";
			schedule.stickyRed = true;
		} else if (sawGreen) {
			schedule.level = "green";
			schedule.stickyRed = false;
		} else if (sawReview) {
			schedule.level = "hot";
			schedule.stickyRed = false;
		} else if (!schedule.stickyRed && schedule.level === "hot") {
			schedule.level = "green";
		} else if (!schedule.stickyRed && schedule.level === "green") {
			schedule.level = "quiet";
		}
		schedule.interval = this.config.intervals[schedule.level];
	}

	private scheduleNext(schedule: ScheduledTarget): void {
		const jitter = 0.9 + this.random() * 0.2;
		schedule.nextPollAt = this.now() + Math.max(1, Math.round(schedule.interval * jitter));
	}
}

function manifestTargets(manifest: Manifest): WatchTarget[] {
	const targets: WatchTarget[] = [];
	for (const reference of manifest.watch.prs) {
		targets.push({ source: "gh", kind: "pr", reference, effortIds: [manifest.effort_id] });
	}
	for (const reference of manifest.watch.tickets) {
		targets.push({ source: "linear", kind: "ticket", reference, effortIds: [manifest.effort_id] });
	}
	for (const reference of manifest.watch.slack_threads) {
		targets.push({ source: "slack", kind: "thread", reference, effortIds: [manifest.effort_id] });
	}
	return targets.map((target) => watchTargetSchema.parse(target));
}

function manifestLevel(manifest: Manifest): PollLevel {
	if (manifest.stage === "watching") {
		return "watching";
	}
	if (manifest.stage === "review") {
		return "green";
	}
	return "quiet";
}

function mostUrgent(levels: PollLevel[]): PollLevel {

	let selected: PollLevel = "watching";
	for (const level of levels) {
		if (POLL_LEVEL_RANK[level] < POLL_LEVEL_RANK[selected]) {
			selected = level;
		}
	}
	return selected;
}

function scheduleKey(target: WatchTarget): string {
	return `${target.source}:${target.kind}:${target.reference}`;
}
