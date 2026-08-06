/**
 * Effort reference resolution, shared by the CLI and any seat-facing surface.
 *
 * This lives in `v2/src` and not in an extension because the code surface is
 * the only agent-facing path now: the `recall_effort` tool is gone, so the
 * resolver must not depend on an extension being loaded.
 */
import * as fs from "node:fs";
import { stateDir } from "./home";
import { readMeta, type TaskMeta } from "./meta";

export interface EffortReference {
	taskId: string;
	epoch: number;
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
	if (normalized === "") throw new Error("recall needs a task id or PR reference");
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

/** Every effort with a durable meta record in the Deck home. */
export function listEffortMetas(): TaskMeta[] {
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
