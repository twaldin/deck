import * as fs from "node:fs";
import * as path from "node:path";
import {
	loadProfiles,
	profilesFile,
	type ModelSeat,
	type ProjectProfile,
} from "./projects";

export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
export type ReasoningSeat = "implementer" | "reviewer" | "watcher" | "fallout";

const ORDER = [...REASONING_LEVELS];
const ANTHROPIC_BUDGETS: Record<ReasoningLevel, number> = {
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
	max: 65536,
};
const SEATS: readonly ReasoningSeat[] = ["implementer", "reviewer", "watcher", "fallout"];
const REASONING_FIELD: Record<ReasoningSeat, keyof NonNullable<ProjectProfile["models"]>> = {
	implementer: "reasoningImplementer",
	reviewer: "reasoningReviewer",
	watcher: "reasoningWatcher",
	fallout: "reasoningFallout",
};

export type ReasoningTheme = {
	bold(text: string): string;
	fg(key: string, text: string): string;
};

export type ReasoningRow = {
	profile: string;
	seat: ReasoningSeat;
	model: string;
	level: ReasoningLevel;
	effective: ReasoningLevel;
};

export function nativeMeaning(model: string, level: string): string | null {
	if (level === "minimal") level = "low";
	if (!isReasoningLevel(level)) return null;
	const provider = providerForModel(model);
	const native = provider === "anthropic"
		? `budget_tokens ${ANTHROPIC_BUDGETS[level as ReasoningLevel]}`
		: `reasoning_effort ${level}`;
	return native;
}

export function isReasoningLevel(value: string): value is ReasoningLevel {
	return (REASONING_LEVELS as readonly string[]).includes(value);
}

export function assertReasoningLevel(value: string): ReasoningLevel {
	if (!isReasoningLevel(value)) {
		throw new Error(`reasoning level must be low, medium, high, xhigh, or max; received ${value}`);
	}
	return value;
}

function modelName(seat: ModelSeat): string {
	return typeof seat === "string" ? seat : seat.model;
}

/** Deck model family, used for the broker's provider-native explanation. */
export function providerForModel(model: string): "anthropic" | "openai" | "xai" {
	const id = model.split("/").at(-1) ?? model;
	if (id.startsWith("claude-")) return "anthropic";
	if (id.startsWith("grok-")) return "xai";
	return "openai";
}

export function supportedLevels(model: string): readonly ReasoningLevel[] {
	const id = model.split("/").at(-1) ?? model;
	if (providerForModel(model) === "xai") return ["low", "medium", "high"];
	if (["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"].includes(id)) return REASONING_LEVELS;
	if (["claude-fable-5", "claude-opus-5", "claude-sonnet-5"].includes(id)) return REASONING_LEVELS;
	if (["claude-sonnet-4-5", "claude-haiku-4-5", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5"].includes(id)) {
		return id === "claude-haiku-4-5" ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high", "xhigh"];
	}
	return ["low", "high"];
}

export function clampLevel(level: ReasoningLevel, supported: readonly ReasoningLevel[]): ReasoningLevel {
	if (supported.includes(level)) return level;
	const requested = ORDER.indexOf(level);
	return [...supported]
		.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
		.reverse()
		.find((candidate) => ORDER.indexOf(candidate) <= requested) ?? supported[0] ?? "low";
}

export function seatReasoning(profile: ProjectProfile, seat: ReasoningSeat): { model: string; requested: ReasoningLevel; effective: ReasoningLevel } | null {
	const configured = profile.models?.[seat];
	if (configured === undefined) return null;
	const embedded = typeof configured === "object" ? configured.reasoning : undefined;
	const field = REASONING_FIELD[seat];
	const configuredLevel = embedded ?? profile.models?.[field] ?? profile.models?.reasoning;
	const requested = typeof configuredLevel === "string" && ([...REASONING_LEVELS, "minimal"] as string[]).includes(configuredLevel)
		? configuredLevel as ReasoningLevel
		: "medium";
	const normalized = requested === ("minimal" as string) ? "low" : requested;
	return { model: modelName(configured), requested, effective: clampLevel(normalized as ReasoningLevel, supportedLevels(modelName(configured))) };
}

function configuredRows(profiles: readonly ProjectProfile[]): ReasoningRow[] {
	const rows: ReasoningRow[] = [];
	for (const profile of profiles) {
		for (const seat of SEATS) {
			const resolved = seatReasoning(profile, seat);
			if (resolved === null) continue;
			rows.push({ profile: profile.id, seat, model: resolved.model, level: resolved.requested, effective: resolved.effective });
		}
	}
	return rows;
}

export function renderReasoning(
	selfLevel: string,
	profiles: readonly ProjectProfile[],
	theme: ReasoningTheme,
	selfModel: string | null,
): string {
	const selfNative = selfModel === null ? null : nativeMeaning(selfModel, selfLevel);
	const lines = [theme.bold(theme.fg("accent", "deck reasoning")), `  self  ${selfLevel}${selfNative === null || selfModel === null ? "" : ` · ${selfModel} · ${selfNative}`}`];
	for (const row of configuredRows(profiles)) {
		const native = nativeMeaning(row.model, row.effective);
		const level = row.level === row.effective ? row.level : `${row.level}→${row.effective}`;
		lines.push(`  ${row.profile}/${row.seat}  ${level} · ${row.model}${native === null ? "" : ` · ${native}`}`);
	}
	return lines.join("\n");
}

export type ReasoningUpdate = { rows: ReasoningRow[]; warnings: string[]; file: string };

/** Update the named seat in every profile that has that seat configured. */
export function setSeatReasoning(
	seat: string,
	requested: string,
	home?: string,
): ReasoningUpdate {
	if (!SEATS.includes(seat as ReasoningSeat)) {
		throw new Error(`unknown reasoning seat "${seat}"; use implementer, reviewer, watcher, or fallout`);
	}
	const level = assertReasoningLevel(requested);
	const profiles = loadProfiles(home);
	const warnings: string[] = [];
	const rows: ReasoningRow[] = [];
	let configured = 0;
	const field = REASONING_FIELD[seat as ReasoningSeat];
	for (const profile of profiles) {
		const models = profile.models;
		const configuredModel = models?.[seat as ReasoningSeat];
		if (configuredModel === undefined) continue;
		configured++;
		const model = modelName(configuredModel);
		const actual = clampLevel(level, supportedLevels(model));
		if (actual !== level) warnings.push(`${profile.id}/${seat}: ${level} unsupported by ${model}; using ${actual}`);
		if (typeof configuredModel === "object") {
			configuredModel.reasoning = requested;
			if (profile.models !== undefined) delete (profile.models as Record<string, unknown>)[field];
		} else {
			if (profile.models === undefined) profile.models = {};
			(profile.models as Record<string, unknown>)[field] = requested;
		}
		rows.push({ profile: profile.id, seat: seat as ReasoningSeat, model, level: actual, effective: actual });
	}
	if (configured === 0) throw new Error(`reasoning seat "${seat}" is not configured in any project profile`);
	const file = profilesFile(home);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	let output: unknown = profiles;
	if (fs.existsSync(file)) {
		// Keep fields that this version does not know. The config belongs to the
		// captain and may have been written by a newer deck version.
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
		for (const profile of raw) {
			const changed = rows.filter((row) => row.profile === profile.id && row.seat === seat);
			const rawModels = profile.models;
			if (rawModels === null || typeof rawModels !== "object" || Array.isArray(rawModels)) continue;
			const modelsObject = rawModels as Record<string, unknown>;
			for (const row of changed) {
				const configured = modelsObject[seat];
				if (configured !== null && typeof configured === "object" && !Array.isArray(configured)) {
					(configured as Record<string, unknown>).reasoning = requested;
					delete modelsObject[field];
				} else modelsObject[field] = requested;
			}
		}
		output = raw;
	}
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(output, null, "\t")}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
	return { rows, warnings, file };
}

export function reasoningSeats(): readonly ReasoningSeat[] {
	return SEATS;
}
