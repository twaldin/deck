import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { buildHydration, type Hydration } from "../v2/src/hydrate";
import { stateDir } from "../v2/src/home";
import { readMeta, type TaskMeta } from "../v2/src/meta";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
};

type RecallContext = {
	ui?: { notify?: (message: string, level?: "warning") => void };
};

type RecallTool = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: RecallContext,
	): Promise<ToolResult>;
};

export interface DeckRecallApi {
	registerTool(tool: RecallTool): void;
	on(event: string, handler: (event: unknown, ctx: RecallContext) => Promise<void> | void): void;
	sendMessage(
		message: { customType: string; content: string; display: boolean; details?: unknown },
		options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
	): void | Promise<void>;
}

export interface EffortReference {
	taskId: string;
	epoch: number;
}

export interface DeckRecallDependencies {
	wake(): Promise<string | null>;
	efforts(): TaskMeta[];
	hydrate(taskId: string, epoch: number): Hydration;
}

type PrReference = { number: number; repo?: string };

export function parsePrReference(value: string): PrReference | null {
	const trimmed = value.trim();
	const url = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(trimmed);
	if (url !== null) return { repo: url[1]?.toLowerCase(), number: Number(url[2]) };
	const scoped = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(trimmed);
	if (scoped !== null) return { repo: scoped[1]?.toLowerCase(), number: Number(scoped[2]) };
	const bare = /^#?(\d+)$/.exec(trimmed);
	return bare === null ? null : { number: Number(bare[1]) };
}

/** Resolve an exact task id first, then a unique PR reference. */
export function resolveEffortReference(reference: string, efforts: TaskMeta[]): EffortReference {
	const normalized = reference.trim();
	if (normalized === "") throw new Error("recall_effort needs a task id or PR reference");
	const exact = efforts.find((effort) => effort.id === normalized);
	if (exact !== undefined) return { taskId: exact.id, epoch: exact.run_epoch ?? 0 };

	const requestedPr = parsePrReference(normalized);
	if (requestedPr === null) throw new Error(`no Deck effort matches "${normalized}"`);
	const matches = efforts.filter((effort) => {
		if (effort.pr === undefined) return false;
		const effortPr = parsePrReference(effort.pr);
		if (effortPr === null || effortPr.number !== requestedPr.number) return false;
		return requestedPr.repo === undefined || effortPr.repo === requestedPr.repo;
	});
	if (matches.length === 0) throw new Error(`no Deck effort matches PR ${normalized}`);
	if (matches.length > 1) {
		throw new Error(`PR ${normalized} is ambiguous across efforts: ${matches.map((effort) => effort.id).join(", ")}`);
	}
	const match = matches[0];
	if (match === undefined) throw new Error(`no Deck effort matches PR ${normalized}`);
	return { taskId: match.id, epoch: match.run_epoch ?? 0 };
}

function listEfforts(): TaskMeta[] {
	let names: string[];
	try {
		names = fs.readdirSync(stateDir());
	} catch {
		return [];
	}
	const efforts: TaskMeta[] = [];
	for (const name of names) {
		if (!name.endsWith(".meta")) continue;
		const id = name.slice(0, -".meta".length);
		try {
			const meta = readMeta(id);
			if (meta !== null) efforts.push(meta);
		} catch {
			// Ignore unrelated or malformed files in the state directory.
		}
	}
	return efforts;
}

function runMemoWake(): Promise<string | null> {
	const memo = path.join(os.homedir(), ".optmem", "memo");
	if (!fs.existsSync(memo)) return Promise.resolve(null);
	const { promise, resolve, reject } = Promise.withResolvers<string | null>();
	execFile(memo, ["wake"], { timeout: 15_000, maxBuffer: 1_000_000 }, (error, stdout) => {
		if (error !== null) reject(error);
		else resolve(stdout.trim() === "" ? null : stdout.trim());
	});
	return promise;
}

const defaultDependencies: DeckRecallDependencies = {
	wake: runMemoWake,
	efforts: listEfforts,
	hydrate: buildHydration,
};

/** Register only OptMem wake injection and explicit effort hydration. */
export function registerDeckRecall(
	agent: DeckRecallApi,
	dependencies: DeckRecallDependencies = defaultDependencies,
): void {
	let injectedSession = false;
	const injectedCompactions = new Set<string>();
	let compactionSequence = 0;

	const injectWake = async (ctx: RecallContext, key: string): Promise<void> => {
		if (key === "session_start" ? injectedSession : injectedCompactions.has(key)) return;
		if (key === "session_start") injectedSession = true;
		else injectedCompactions.add(key);
		try {
			const wake = await dependencies.wake();
			if (wake === null || wake.trim() === "") return;
			await agent.sendMessage(
				{
					customType: "deck.optmem-wake.v1",
					content: wake,
					display: false,
					details: { source: "~/.optmem/memo wake" },
				},
				{ deliverAs: key === "session_start" ? "nextTurn" : "steer", triggerTurn: false },
			);
		} catch (error) {
			if (key === "session_start") injectedSession = false;
			else injectedCompactions.delete(key);
			ctx.ui?.notify?.(
				`OptMem wake failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	};

	agent.on("session_start", async (_event, ctx) => {
		injectedSession = false;
		injectedCompactions.clear();
		compactionSequence = 0;
		await injectWake(ctx, "session_start");
	});
	agent.on("session_compact", async (event, ctx) => {
		const value = event as { compactionEntry?: { id?: unknown }; id?: unknown } | undefined;
		const key = String(value?.compactionEntry?.id ?? value?.id ?? `compaction-${compactionSequence++}`);
		await injectWake(ctx, key);
	});
}

export default function deckRecall(agent: DeckRecallApi): void {
	registerDeckRecall(agent);
}
