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
	id: "deck",
	repo: "twaldin/deck",
	primary: "/opt/deck",
	pipeline: "yolo-ship",
	yolo: true,
	stamp: false,
	knowledge: [],
};

function writeConfig(profiles: unknown): void {
	const file = profilesFile(home);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(profiles));
}

describe("seeds", () => {
	test("carry the captain's written merge policy: lindy stamp always, deck yolo", () => {
		const lindy = findProfile("lindy");
		expect(lindy?.pipeline).toBe("lindy-full");
		expect(lindy?.yolo).toBe(false);
		expect(lindy?.stamp).toBe(true);
		expect(lindy?.knowledge.some((k) => k.endsWith("lindy-domain.md"))).toBe(true);
		// The frozen traps ride in the profile, not in a prompts.ts fork.
		expect(lindy?.doctrine).toContain("squash commit");
		expect(lindy?.models?.implementer).toBe("deck/gpt-5.6-luna");
		expect(lindy?.models?.reviewer).toBeUndefined();
		expect(lindy?.models?.oppositionDefaults?.openai).toBe("deck/claude-fable-5");

		const deck = findProfile("deck");
		expect(deck?.pipeline).toBe("yolo-ship");
		expect(deck?.yolo).toBe(true);
		expect(deck?.stamp).toBe(false);
	});

	test("resolve by repo name too", () => {
		expect(findProfile("lindy-ai/lindy")?.id).toBe("lindy");
		expect(findProfile("unknown-thing")).toBeNull();
	});
});

describe("config file", () => {
	test("replaces the seeds wholesale", () => {
		writeConfig([deckOverride]);
		expect(findProfile("deck")?.primary).toBe("/opt/deck");
		expect(findProfile("lindy")).toBeNull();
		expect(loadProfiles()).toHaveLength(1);
	});

	test("REGRESSION: a pipeline/flags contradiction is refused, not silently obeyed", () => {
		// yolo-ship with stamp=true is the dangerous kind of typo: whichever
		// field a consumer happens to read decides whether a merge waits for
		// the captain. Refuse the file instead.
		writeConfig([{ ...deckOverride, stamp: true }]);
		expect(() => loadProfiles()).toThrow(/implies yolo=true stamp=false/);
	});

	test("model seat config refuses malformed opposition defaults", () => {
		writeConfig([{ ...deckOverride, models: { implementer: "deck/gpt-5.6-luna", watcher: "deck/gpt-5.6-luna", fallout: "deck/gpt-5.6-sol", familyOpposition: true, oppositionDefaults: { openai: 42 } } }]);
		expect(() => loadProfiles()).toThrow(/oppositionDefaults values/);
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
		expect(loaded.map((p) => p.id).sort()).toEqual(["deck", "lindy"]);

		// The captain's edit survives a re-bootstrap.
		writeConfig([deckOverride]);
		expect(seedProfilesFile(home)).toBeNull();
		bootstrapHome({ repoV2Dir: "" });
		expect(loadProfiles()).toHaveLength(1);
	});
});

describe("briefs branch on the profile", () => {
	test("doctrine carries the profile's knowledge paths and merge posture", () => {
		const lindy = buildStandingDoctrine("lindy");
		expect(lindy).toContain("lindy-domain.md");
		expect(lindy).toContain("Per-PR captain stamp");
		expect(lindy).not.toContain("yolo ON");

		const deck = buildStandingDoctrine("deck");
		expect(deck).toContain("yolo ON for green work");
		expect(deck).not.toContain("Per-PR captain stamp");
	});

	test("a config edit changes the brief without a code change", () => {
		// Flip lindy's knowledge pack down to one file; the brief follows the file.
		writeConfig([
			{
				...seedProfiles(home).find((p) => p.id === "lindy"),
				knowledge: ["/custom/only-file.md"],
				doctrine: "Custom doctrine line.",
			},
		]);
		const doctrine = buildStandingDoctrine("lindy");
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
