/**
 * Deck substrate defaults (SPEC §4.4 caps, §5.1 poll cadence, §5.5 admission).
 * All values overridable via ~/.deck/config.json (flat partial of this shape);
 * loaders merge, never mutate these constants.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DECK_HOME } from "./layout";

/** Conciseness caps (D-H): schema-level max lengths; violation ⇒ E_TOO_LONG. */
export const CAPS = {
	askTimQuestion: 600,
	askTimRecommendation: 400,
	askTimOptionLabel: 120,
	askTimMaxOptions: 5,
	reportProgressStatus: 500,
	parkDigest: 2000,
} as const;

/** Admission limits (SPEC §5.5.3, D-B). */
export interface AdmissionConfig {
	maxConcurrentPolls: number;
	maxDispatchesPerEffort: number;
	maxActiveSessionsGlobal: number;
	maxWorktreesGlobal: number;
	maxBrowserTabsGlobal: number;
	maxWorkflowNodesPerRun: number;
	/** Machine swap bytes above which new spawns defer + idle owners park (D-B). */
	swapThresholdBytes: number;
}

/** Router loop (SPEC §5.1, §5.5.1). */
export interface RouterConfig {
	tickMs: number;
	pollDeadlineMs: number;
	pollOutputCapBytes: number;
	/** Poll intervals by attention level, ms. */
	intervals: { hot: number; green: number; quiet: number; watching: number };
	/** Coalesce window for multi-fact wakes (SPEC §5.5.4). */
	coalesceMs: number;
	/** Spawn deadline for dispatch liveness verification (D-D). */
	spawnDeadlineMs: number;
	heartbeatIntervalMs: number;
}

export interface DeckConfig {
	admission: AdmissionConfig;
	router: RouterConfig;
	/** Rehydration seed budget in tokens (SPEC §4.6, D-G: tight). */
	seedTokenBudget: number;
}

export const DEFAULT_CONFIG: DeckConfig = {
	admission: {
		maxConcurrentPolls: 4,
		maxDispatchesPerEffort: 8,
		maxActiveSessionsGlobal: 12,
		maxWorktreesGlobal: 24,
		maxBrowserTabsGlobal: 16,
		maxWorkflowNodesPerRun: 200,
		swapThresholdBytes: 18 * 1024 ** 3,
	},
	router: {
		tickMs: 30_000,
		pollDeadlineMs: 45_000,
		pollOutputCapBytes: 512 * 1024,
		intervals: { hot: 60_000, green: 300_000, quiet: 900_000, watching: 1_800_000 },
		coalesceMs: 5_000,
		spawnDeadlineMs: 60_000,
		heartbeatIntervalMs: 15_000,
	},
	seedTokenBudget: 8_000,
};

export function loadConfig(): DeckConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(DECK_HOME, "config.json"), "utf8")) as Partial<DeckConfig>;
		return {
			admission: { ...DEFAULT_CONFIG.admission, ...raw.admission },
			router: { ...DEFAULT_CONFIG.router, ...raw.router },
			seedTokenBudget: raw.seedTokenBudget ?? DEFAULT_CONFIG.seedTokenBudget,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}
