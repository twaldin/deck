import { spawnSync } from "node:child_process";
import type { AdmissionConfig } from "@deck/core";
import { z } from "zod";

const swapOutputSchema = z.string().min(1);
const SWAP_MULTIPLIER_BY_UNIT: Record<string, number> = {
	K: 1024,
	M: 1024 ** 2,
	G: 1024 ** 3,
	T: 1024 ** 4,
	P: 1024 ** 5,
};

export type SessionKind = "owner" | "dispatch";

interface ActiveSession {
	kind: SessionKind;
	effortId: string;
}

export interface AdmissionDecision {
	allowed: boolean;
	reason: "ok" | "global-cap" | "effort-cap" | "swap";
	swapUsedBytes: number;
}

export interface AdmissionSnapshot {
	activeSessions: number;
	activeOwners: number;
	activeDispatches: number;
	maxActiveSessionsGlobal: number;
	maxDispatchesPerEffort: number;
	swapUsedBytes: number;
	swapThresholdBytes: number;
}

export type SwapReader = () => number;

export class AdmissionController {
	private readonly config: AdmissionConfig;
	private readonly swapReader: SwapReader;
	private readonly active = new Map<string, ActiveSession>();
	private lastSwapUsedBytes = 0;

	constructor(config: AdmissionConfig, swapReader: SwapReader = readSwapUsedBytes) {
		this.config = config;
		this.swapReader = swapReader;
	}

	tryReserve(key: string, kind: SessionKind, effortId: string): AdmissionDecision {
		const existing = this.active.get(key);
		if (existing !== undefined) {
			return { allowed: true, reason: "ok", swapUsedBytes: this.lastSwapUsedBytes };
		}
		this.lastSwapUsedBytes = this.swapReader();
		if (this.lastSwapUsedBytes > this.config.swapThresholdBytes) {
			return { allowed: false, reason: "swap", swapUsedBytes: this.lastSwapUsedBytes };
		}
		if (this.active.size >= this.config.maxActiveSessionsGlobal) {
			return { allowed: false, reason: "global-cap", swapUsedBytes: this.lastSwapUsedBytes };
		}
		if (kind === "dispatch") {
			let dispatches = 0;
			for (const active of this.active.values()) {
				if (active.kind === "dispatch" && active.effortId === effortId) {
					dispatches += 1;
				}
			}
			if (dispatches >= this.config.maxDispatchesPerEffort) {
				return { allowed: false, reason: "effort-cap", swapUsedBytes: this.lastSwapUsedBytes };
			}
		}
		this.active.set(key, { kind, effortId });
		return { allowed: true, reason: "ok", swapUsedBytes: this.lastSwapUsedBytes };
	}

	release(key: string): void {
		this.active.delete(key);
	}

	snapshot(): AdmissionSnapshot {
		let activeOwners = 0;
		let activeDispatches = 0;
		for (const session of this.active.values()) {
			if (session.kind === "owner") {
				activeOwners += 1;
			} else {
				activeDispatches += 1;
			}
		}
		return {
			activeSessions: this.active.size,
			activeOwners,
			activeDispatches,
			maxActiveSessionsGlobal: this.config.maxActiveSessionsGlobal,
			maxDispatchesPerEffort: this.config.maxDispatchesPerEffort,
			swapUsedBytes: this.lastSwapUsedBytes,
			swapThresholdBytes: this.config.swapThresholdBytes,
		};
	}
}

/** Parse macOS `sysctl vm.swapusage`; unsupported hosts conservatively report zero. */
export function readSwapUsedBytes(): number {
	const result = spawnSync("sysctl", ["vm.swapusage"], { encoding: "utf8", timeout: 2_000 });
	if (result.status !== 0 || result.error !== undefined) {
		return 0;
	}
	const parsedOutput = swapOutputSchema.safeParse(result.stdout);
	if (!parsedOutput.success) {
		return 0;
	}
	const output = parsedOutput.data;
	const match = /used\s*=\s*([0-9.]+)([KMGTP])/.exec(output);
	if (match === null) {
		return 0;
	}
	const value = Number(match[1]);
	const unit = match[2];
	return Math.round(value * (SWAP_MULTIPLIER_BY_UNIT[unit ?? ""] ?? 0));
}
