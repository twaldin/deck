/**
 * Machine-readable project profiles.
 *
 * data/projects.md is the human form; this is the machine form the fleet
 * actually branches on: where the primary checkout is, which pipeline the
 * project runs (lindy-full | yolo-ship | ask-then-yolo), whether merges are
 * yolo-on-green or per-PR captain stamp, and which knowledge files every brief
 * must carry.
 *
 * Storage is one JSON file at <home>/config/projects.json — no framework, no
 * new dependency. The file, once seeded, is the captain's to edit; the seeds
 * in code are only the fallback when it does not exist yet.
 *
 * Deliberately dependency-free (node builtins only): workflows/pr-pipeline
 * imports this module directly, and its lib/ contract is "unit-testable
 * without smithers, zod, or network access".
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PIPELINES = ["lindy-full", "yolo-ship", "ask-then-yolo"] as const;
export type PipelineId = (typeof PIPELINES)[number];

export type ModelSeat = string | { model: string; reasoning?: string };

export type ModelSeats = {
	implementer?: ModelSeat;
	reviewer?: ModelSeat;
	watcher?: ModelSeat;
	fallout?: ModelSeat;
	reasoning?: "low" | "medium" | "high" | "xhigh" | "max";
	reasoningImplementer?: "low" | "medium" | "high" | "xhigh" | "max";
	reasoningReviewer?: "low" | "medium" | "high" | "xhigh" | "max";
	reasoningWatcher?: "low" | "medium" | "high" | "xhigh" | "max";
	reasoningFallout?: "low" | "medium" | "high" | "xhigh" | "max";
	familyOpposition?: boolean;
	oppositionDefaults?: Record<string, string>;
};

export type ProjectProfile = {
	/** Stable id; doubles as the repo alias (spawn --repo <id>). */
	id: string;
	/** e.g. "example-org/review-project" */
	repo: string;
	/** Absolute path to the primary checkout. Never edited; worktrees only. */
	primary: string;
	pipeline: PipelineId;
	/** Merge green work without per-PR captain word. */
	yolo: boolean;
	/** Every merge needs the captain's per-PR stamp. */
	stamp: boolean;
	/** Product repos may run only in the canonical home Smithers workspace. */
	production?: boolean;
	/** Absolute paths a brief must carry (mandatory reading). */
	knowledge: string[];
	/** Project-specific doctrine prose, inlined verbatim into briefs. */
	doctrine?: string;
	/** Captain-editable workflow seat models. */
	models?: ModelSeats;
	/** Dependency install command for allocated worktrees. */
	installCommand?: string;
	/** Project command used to validate an automatic rebase. */
	testCommand?: string;
	/** Whether allocation should warm dependencies in the background. */
	depsWarm: boolean;
	/** Optional post-landing fallout probe. */
	falloutCommand?: string;
};

/** Same resolution as home.ts, inlined so this module stays dependency-free. */
function defaultHome(): string {
	return process.env.DECK_V2_HOME ?? path.join(os.homedir(), ".deck");
}

export function profilesFile(home = defaultHome()): string {
	return path.join(home, "config", "projects.json");
}

/** Personal projects are configured in ~/.deck/config/projects.json. */
export function seedProfiles(_home?: string): ProjectProfile[] {
	return [];
}

/** Each pipeline implies its flags; a file that contradicts itself is refused. */
const PIPELINE_FLAGS: Record<PipelineId, { yolo: boolean; stamp: boolean }> = {
	"lindy-full": { yolo: false, stamp: true },
	"yolo-ship": { yolo: true, stamp: false },
	"ask-then-yolo": { yolo: true, stamp: false },
};

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateProfiles(parsed: unknown, source: string): ProjectProfile[] {
	if (!Array.isArray(parsed)) {
		throw new Error(`${source}: expected a JSON array of project profiles`);
	}
	const seen = new Set<string>();
	return parsed.map((entry, index) => {
		const where = `${source}[${index}]`;
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`${where}: expected an object`);
		}
		const p = entry as Record<string, unknown>;
		if (typeof p.id !== "string" || !ID_RE.test(p.id)) {
			throw new Error(`${where}: id must match ${ID_RE}`);
		}
		if (seen.has(p.id)) throw new Error(`${where}: duplicate id "${p.id}"`);
		seen.add(p.id);
		if (typeof p.repo !== "string" || p.repo.length === 0) {
			throw new Error(`${where} (${p.id}): repo must be a non-empty string`);
		}
		if (typeof p.primary !== "string" || !path.isAbsolute(p.primary)) {
			throw new Error(`${where} (${p.id}): primary must be an absolute path`);
		}
		if (!PIPELINES.includes(p.pipeline as PipelineId)) {
			throw new Error(`${where} (${p.id}): pipeline must be one of ${PIPELINES.join(" | ")}`);
		}
		const pipeline = p.pipeline as PipelineId;
		if (typeof p.yolo !== "boolean" || typeof p.stamp !== "boolean") {
			throw new Error(`${where} (${p.id}): yolo and stamp must be booleans`);
		}
		const implied = PIPELINE_FLAGS[pipeline];
		if (p.yolo !== implied.yolo || p.stamp !== implied.stamp) {
			throw new Error(
				`${where} (${p.id}): pipeline "${pipeline}" implies yolo=${implied.yolo} stamp=${implied.stamp}; the file says yolo=${p.yolo} stamp=${p.stamp}. Fix the contradiction.`,
			);
		}
		if (p.production !== undefined && typeof p.production !== "boolean") {
			throw new Error(`${where} (${p.id}): production must be a boolean`);
		}
		const knowledge = p.knowledge ?? [];
		if (!Array.isArray(knowledge) || knowledge.some((k) => typeof k !== "string")) {
			throw new Error(`${where} (${p.id}): knowledge must be an array of paths`);
		}
		if (p.doctrine !== undefined && typeof p.doctrine !== "string") {
			throw new Error(`${where} (${p.id}): doctrine must be a string`);
		}
		let models: ModelSeats | undefined;
		if (p.models !== undefined && p.models !== null) {
			if (typeof p.models !== "object" || Array.isArray(p.models)) {
				throw new Error(`${where} (${p.id}): models must be an object`);
			}
			const m = p.models as Record<string, unknown>;
			for (const role of ["implementer", "reviewer", "watcher", "fallout"] as const) {
				const seat = m[role];
				if (seat !== undefined && typeof seat !== "string" && (seat === null || typeof seat !== "object" || Array.isArray(seat))) throw new Error(`${where} (${p.id}): models.${role} must be a model string or { model, reasoning }`);
				if (seat !== undefined && typeof seat === "object") {
					const value = seat as Record<string, unknown>;
					if (typeof value.model !== "string" || value.model.length === 0) throw new Error(`${where} (${p.id}): models.${role}.model must be a non-empty string`);
					if (value.reasoning !== undefined && (typeof value.reasoning !== "string" || !["minimal", "low", "medium", "high", "xhigh", "max"].includes(value.reasoning))) throw new Error(`${where} (${p.id}): models.${role}.reasoning must be one of minimal, low, medium, high, xhigh, max`);
				}
			}
			for (const seat of ["reasoning", "reasoningImplementer", "reasoningReviewer", "reasoningWatcher", "reasoningFallout"]) {
				if (m[seat] !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(m[seat] as string)) throw new Error(`${where} (${p.id}): models.${seat} must be low, medium, high, xhigh, or max`);
			}
			if (m.familyOpposition !== undefined && typeof m.familyOpposition !== "boolean") {
				throw new Error(`${where} (${p.id}): models.familyOpposition must be a boolean`);
			}
			if (m.oppositionDefaults !== undefined && (m.oppositionDefaults === null || typeof m.oppositionDefaults !== "object" || Array.isArray(m.oppositionDefaults))) {
				throw new Error(`${where} (${p.id}): models.oppositionDefaults must be an object`);
			}
			models = {
				...(m.implementer === undefined ? {} : { implementer: m.implementer as ModelSeat }),
				...(m.reviewer === undefined ? {} : { reviewer: m.reviewer as ModelSeat }),
				...(m.watcher === undefined ? {} : { watcher: m.watcher as ModelSeat }),
				...(m.fallout === undefined ? {} : { fallout: m.fallout as ModelSeat }),
				...(m.reasoning === undefined ? {} : { reasoning: m.reasoning as ModelSeats["reasoning"] }),
				...(m.reasoningImplementer === undefined ? {} : { reasoningImplementer: m.reasoningImplementer as ModelSeats["reasoningImplementer"] }),
				...(m.reasoningReviewer === undefined ? {} : { reasoningReviewer: m.reasoningReviewer as ModelSeats["reasoningReviewer"] }),
				...(m.reasoningWatcher === undefined ? {} : { reasoningWatcher: m.reasoningWatcher as ModelSeats["reasoningWatcher"] }),
				...(m.reasoningFallout === undefined ? {} : { reasoningFallout: m.reasoningFallout as ModelSeats["reasoningFallout"] }),
				...(m.familyOpposition === undefined ? {} : { familyOpposition: m.familyOpposition as boolean }),
				oppositionDefaults: (() => {
					const entries = Object.entries((m.oppositionDefaults ?? {}) as Record<string, unknown>);
					if (entries.some(([, value]) => typeof value !== "string" || value.length === 0)) {
						throw new Error(`${where} (${p.id}): models.oppositionDefaults values must be non-empty strings`);
					}
					return Object.fromEntries(entries) as Record<string, string>;
				})(),
			};
		}
		if (p.testCommand !== undefined && typeof p.testCommand !== "string") {
			throw new Error(`${where} (${p.id}): testCommand must be a string`);
		}
		if (p.installCommand !== undefined && typeof p.installCommand !== "string") {
			throw new Error(`${where} (${p.id}): installCommand must be a string`);
		}
		if (p.depsWarm !== undefined && typeof p.depsWarm !== "boolean") {
			throw new Error(`${where} (${p.id}): depsWarm must be a boolean`);
		}
		return {
			id: p.id,
			repo: p.repo,
			primary: p.primary,
			pipeline,
			yolo: p.yolo,
			stamp: p.stamp,
			...(p.production === undefined ? {} : { production: p.production }),
			knowledge: knowledge as string[],
			...(p.doctrine === undefined ? {} : { doctrine: p.doctrine }),
			...(models === undefined ? {} : { models }),
			...(p.testCommand === undefined ? {} : { testCommand: p.testCommand }),
			...(p.installCommand === undefined ? {} : { installCommand: p.installCommand }),
			depsWarm: p.depsWarm ?? true
		};
	});
}

/**
 * Load profiles: the config file when it exists (wholesale — no merging with
 * seeds, so a captain's deletion stays deleted), else the code seeds.
 */
export function loadProfiles(home = defaultHome()): ProjectProfile[] {
	const file = profilesFile(home);
	if (!fs.existsSync(file)) return seedProfiles(home);
	return validateProfiles(JSON.parse(fs.readFileSync(file, "utf8")), file);
}

export function findProfile(idOrRepo: string, home = defaultHome()): ProjectProfile | null {
	const needle = idOrRepo.toLowerCase();
	for (const profile of loadProfiles(home)) {
		if (profile.id === needle || profile.repo.toLowerCase() === needle) return profile;
	}
	return null;
}

/** Write the seed file once. Returns the path when written, null if it exists. */
export function seedProfilesFile(home = defaultHome()): string | null {
	const file = profilesFile(home);
	if (fs.existsSync(file)) return null;
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${JSON.stringify(seedProfiles(home), null, "\t")}\n`, { mode: 0o600 });
	return file;
}

/** One line of merge posture for briefs/doctrine, derived from the profile. */
export function mergeHint(profile: ProjectProfile): string {
	if (profile.stamp) {
		return "Merges: yolo OFF. Per-PR captain stamp + merge word, always. Never run a no-mistakes pipeline.";
	}
	if (profile.pipeline === "ask-then-yolo") {
		return "Merges: ask the captain once per effort, then yolo on green. You still never merge; the orchestrator owns the merge.";
	}
	return "Merges: yolo ON for green work. You still never merge; the orchestrator owns the merge.";
}
