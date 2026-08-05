import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildStandingDoctrine } from "../src/prompts";

// Doctrine tests must not read or write the operator's configured home.
const promptTestHome = fs.mkdtempSync(path.join(os.tmpdir(), "deck-prompts-home-"));
const savedDeckHome = process.env.DECK_V2_HOME;

beforeAll(() => {
	process.env.DECK_V2_HOME = promptTestHome;
	fs.mkdirSync(path.join(promptTestHome, "config"), { recursive: true });
	fs.writeFileSync(path.join(promptTestHome, "config", "projects.json"), JSON.stringify([{
		id: "review-project",
		repo: "example-org/review-project",
		primary: "/tmp/review-project",
		pipeline: "lindy-full",
		yolo: false,
		stamp: true,
		knowledge: [
			path.join(promptTestHome, "data", "domain.md"),
			path.join(promptTestHome, "data", "ops.md"),
			path.join(promptTestHome, "data", "ref", "distill", "STANDING-RULES.md"),
		],
		doctrine: "Landing requires the squash commit. Unapplied migrations block ALL of CI repo-wide. Verify through the requested_reviewers API. Use read-only production access. Query version: -1. Never a named reviewer.",
		depsWarm: true,
	}]));
});

afterAll(() => {
	if (savedDeckHome === undefined) delete process.env.DECK_V2_HOME;
	else process.env.DECK_V2_HOME = savedDeckHome;
	fs.rmSync(promptTestHome, { recursive: true, force: true });
});

describe("standing doctrine", () => {
	test("configured projects carry their paths, traps, merge posture, and worker memory boundary", () => {
		const doctrine = buildStandingDoctrine("review-project");
		expect(doctrine).toContain("## Standing doctrine (review-project)");
		expect(doctrine).toContain("domain.md");
		expect(doctrine).toContain("ref/distill/STANDING-RULES.md");
		expect(doctrine).toContain("Unapplied migrations block ALL of CI repo-wide");
		expect(doctrine).toContain("requested_reviewers API");
		expect(doctrine).toContain("Never run OptMem");
	});

	test("profile lookup remains case-insensitive", () => {
		expect(buildStandingDoctrine("Review-Project")).toContain("## Standing doctrine (review-project)");
	});

	test("unconfigured seats receive only the thin global doctrine", () => {
		const doctrine = buildStandingDoctrine();
		expect(doctrine).toContain("ref/distill/STANDING-RULES.md");
		expect(doctrine).toContain("secrets-map.md");
		expect(doctrine).toContain("Never run OptMem");
		expect(doctrine).not.toContain("domain.md");
		expect(doctrine).not.toContain("captain.md");
	});

	test("progressive disclosure keeps the doctrine bounded", () => {
		expect(buildStandingDoctrine("review-project").length).toBeLessThan(2500);
		expect(buildStandingDoctrine().length).toBeLessThan(1000);
	});
});
