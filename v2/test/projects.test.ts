/**
 * Project profiles: the machine form of data/projects.md.
 *
 * What must hold: the seeds match the captain's written policy (lindy = stamp
 * always, yolo OFF; deck = yolo ON), a config file replaces the seeds
 * wholesale, a self-contradictory file is refused (pipeline id vs yolo/stamp
 * flags), and briefs branch on the profile instead of a hardcoded project
 * fork.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bootstrapHome } from "../src/bootstrap";
import {
	findProfile,
	loadProfiles,
	mergeHint,
	profilesFile,
	seedProfiles,
	seedProfilesFile,
	validateProfiles,
} from "../src/projects";
import { buildStandingDoctrine } from "../src/prompts";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deck-projects-"));
	savedHome = process.env.DECK_V2_HOME;
	process.env.DECK_V2_HOME = home;
});

afterEach(() => {
	if (savedHome === undefined) delete process.env.DECK_V2_HOME;
	else process.env.DECK_V2_HOME = savedHome;
	fs.rmSync(home, { recursive: true, force: true });
});

const deckOverride = {
	id: "example-project",
	repo: "example-org/example-project",
	primary: "/opt/deck",
	pipeline: "yolo-ship",
	yolo: true,
	stamp: false,
	knowledge: [],
	reviewPolicy: { requireHuman: false, requiredBots: [{ login: "coderabbitai[bot]", approvalCheckPattern: "^CodeRabbit(?:$| /)" }] },
};

function writeConfig(profiles: unknown): void {
	const file = profilesFile(home);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(profiles));
}

describe("seeds", () => {
	test("contain no personal project defaults", () => {
		expect(seedProfiles()).toEqual([]);
		expect(findProfile("example-project")).toBeNull();
		expect(findProfile("unknown-thing")).toBeNull();
	});
});

describe("config file", () => {
	test("replaces the seeds wholesale", () => {
		writeConfig([deckOverride]);
		expect(findProfile("example-project")?.primary).toBe("/opt/deck");
		expect(findProfile("review-project")).toBeNull();
		expect(loadProfiles()).toHaveLength(1);
	});

	test("preserves an explicit production marker and refuses malformed values", () => {
		writeConfig([{ ...deckOverride, production: true }]);
		expect(loadProfiles()[0]?.production).toBe(true);
		expect(() => validateProfiles([{ ...deckOverride, production: "yes" }], "x")).toThrow(
			/production must be a boolean/,
		);
	});

	test("REGRESSION: a pipeline/flags contradiction is refused, not silently obeyed", () => {
		// yolo-ship with stamp=true is the dangerous kind of typo: whichever
		// field a consumer happens to read decides whether a merge waits for
		// the captain. Refuse the file instead.
		writeConfig([{ ...deckOverride, stamp: true }]);
		expect(() => loadProfiles()).toThrow(/implies yolo=true stamp=false/);
	});

	test("review policy is explicit, profile-scoped, and regex-validated", () => {
		const { reviewPolicy: _missing, ...withoutPolicy } = deckOverride;
		expect(() => validateProfiles([withoutPolicy], "x")).toThrow(/reviewPolicy is required/);
		expect(() => validateProfiles([{
			...deckOverride,
			reviewPolicy: {
				requireHuman: false,
				requiredBots: [{ login: "coderabbitai[bot]", approvalCheckPattern: "[" }],
			},
		}], "x")).toThrow(/approvalCheckPattern must be a valid regex/);
	});

	test("model seat config refuses malformed opposition defaults", () => {
		writeConfig([{ ...deckOverride, models: { implementer: "deck/gpt-5.6-luna", watcher: "deck/gpt-5.6-luna", fallout: "deck/gpt-5.6-sol", familyOpposition: true, oppositionDefaults: { openai: 42 } } }]);
		expect(() => loadProfiles()).toThrow(/oppositionDefaults values/);
	});

	test("preserves canonical mechanical and manual judgment-fallback model seats", () => {
		writeConfig([{
			...deckOverride,
			models: {
				mechanical: { model: "deck/gpt-5.6-luna", reasoning: "xhigh" },
				judgmentFallback: { model: "deck/claude-opus-5", reasoning: "high" },
				reasoningMechanical: "xhigh",
			},
		}]);
		expect(loadProfiles()[0]?.models).toMatchObject({
			mechanical: { model: "deck/gpt-5.6-luna", reasoning: "xhigh" },
			judgmentFallback: { model: "deck/claude-opus-5", reasoning: "high" },
			reasoningMechanical: "xhigh",
		});
		expect(() => validateProfiles([{
			...deckOverride,
			models: { mechanical: { model: "deck/gpt-5.6-luna", reasoning: "minimal" } },
		}], "x")).toThrow(/reasoning must be one of low/);
	});

	test.each([
		["missing", undefined],
		["null", null],
		["partial", { implementer: "deck/claude-fable-5" }],
	] as const)("normalizes %s model config to a defaultable policy", (_name, models) => {
		writeConfig([{ ...deckOverride, models }]);
		const profile = loadProfiles()[0];
		expect(profile?.models?.implementer).toBe(models && "implementer" in models ? "deck/claude-fable-5" : undefined);
	});

	test("malformed entries are refused with the reason", () => {
		expect(() => validateProfiles({}, "x")).toThrow(/array/);
		expect(() => validateProfiles([{ ...deckOverride, primary: "relative" }], "x")).toThrow(
			/absolute/,
		);
		expect(() => validateProfiles([{ ...deckOverride, pipeline: "nope" }], "x")).toThrow(
			/pipeline must be one of/,
		);
		expect(() => validateProfiles([deckOverride, deckOverride], "x")).toThrow(/duplicate/);
	});
});

describe("seeding", () => {
	test("bootstrap writes config/projects.json once; an existing file is never overwritten", () => {
		const result = bootstrapHome({ repoV2Dir: "" });
		expect(result.created).toContain(profilesFile(home));
		const loaded = loadProfiles();
		expect(loaded).toEqual([]);

		// The captain's edit survives a re-bootstrap.
		writeConfig([deckOverride]);
		expect(seedProfilesFile(home)).toBeNull();
		bootstrapHome({ repoV2Dir: "" });
		expect(loadProfiles()).toHaveLength(1);
	});
});

describe("briefs branch on the profile", () => {
	test("use a configured profile's merge posture", () => {
		writeConfig([{ ...deckOverride, pipeline: "lindy-full", yolo: false, stamp: true }]);
		const review = buildStandingDoctrine("example-project");
		expect(review).toContain("Per-PR captain stamp");
		expect(review).not.toContain("yolo ON");
	});

	test("a config edit changes the brief without a code change", () => {
		// Flip lindy's knowledge pack down to one file; the brief follows the file.
		writeConfig([
			{
				...deckOverride,
				knowledge: ["/custom/only-file.md"],
				doctrine: "Custom doctrine line.",
			},
		]);
		const doctrine = buildStandingDoctrine("example-project");
		expect(doctrine).toContain("/custom/only-file.md");
		expect(doctrine).toContain("Custom doctrine line.");
		expect(doctrine).not.toContain("lindy-ops.md");
	});

	test("mergeHint is derived from the flags, not the project name", () => {
		expect(mergeHint({ ...deckOverride, pipeline: "yolo-ship" } as never)).toContain("yolo ON");
		expect(
			mergeHint({ ...deckOverride, pipeline: "ask-then-yolo" } as never),
		).toContain("ask the captain once");
	});
});
