/**
 * Ship: profile -> pipeline input mapping, and the spawn-side enforcement that
 * makes the pipeline the DEFAULT ship path (a bare ship spawn on a profiled
 * project is refused; --no-pipeline is the explicit escape hatch).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateBrief } from "../../workflows/pr-pipeline/lib/brief";
import { profilesFile, seedProfiles, type ProjectProfile } from "../src/projects";
import { existingPrFromFlag, runCli } from "../src/cli";
import { buildPipelineInput, pipelineDir, startShip, type ShipRequest } from "../src/ship";
import { assertShipGoesThroughPipeline, shipProfileFor, workerModelFor } from "../src/spawn";
import { smithersWorkspaceCwd, smithersWorkspaceRoot } from "../src/workspace";

let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deck-ship-"));
	for (const key of ["DECK_V2_HOME", "DECK_PIPELINE_DIR"]) saved[key] = process.env[key];
	process.env.DECK_V2_HOME = home;
	delete process.env.DECK_PIPELINE_DIR;
});

afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(home, { recursive: true, force: true });
});

const seeds = () => seedProfiles(home);
const deckProfile = () => seeds().find((p) => p.id === "deck") as ProjectProfile;
const lindyProfile = () => seeds().find((p) => p.id === "lindy") as ProjectProfile;

const request = (overrides: Partial<ShipRequest> = {}): ShipRequest => ({
	ticket: "deck-42",
	profile: "deck",
	worktree: "/tmp/wt",
	branch: "deck/x",
	title: "A change",
	summary: "Does a thing",
	acceptance: ["it works"],
	...overrides,
});

describe("ship CLI flags", () => {
	async function runWithCapturedStderr(argv: string[]): Promise<{ exitCode: number; stderr: string }> {
		let stderr = "";
		const originalWrite = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stderr.write;
		try {
			return { exitCode: await runCli(argv), stderr };
		} finally {
			process.stderr.write = originalWrite;
		}
	}

	test("rejects unknown flags", async () => {
		const result = await runWithCapturedStderr(["ship", "deck-42", "--typo"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("unknown flag(s) for ship: --typo");
	});

	test("keeps existing-pr in the ship allowlist", async () => {
		const result = await runWithCapturedStderr(["ship", "deck-42", "--existing-pr", "4242"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).not.toContain("unknown flag(s) for ship");
		expect(result.stderr).toContain("--profile is required");
	});
});

describe("worker model wiring", () => {
	test("uses the profile implementer instead of the default worker model", () => {
		const profile = { ...deckProfile(), models: { ...deckProfile().models!, implementer: "deck/claude-fable-5" } };
		const file = profilesFile(home);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify([profile]));
		expect(
			workerModelFor({
				taskId: "model-test",
				task: "test",
				acceptance: ["works"],
				kind: "ship",
				project: profile.id,
			}),
		).toBe("deck/claude-fable-5");
	});

	test("rejects a profile implementer outside the deck catalog", () => {
		const profile = deckProfile();
		const file = profilesFile(home);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify([{ ...profile, models: { ...profile.models, implementer: "openai/gpt-5" } }]));
		expect(() => workerModelFor({ taskId: "model-test", task: "test", acceptance: ["works"], kind: "scout", project: profile.id })).toThrow(
			/must use the deck provider/,
		);
	});
});

describe("existingPrFromFlag", () => {
	test("accepts positive integer values and rejects bare, non-positive, and fractional flags", () => {
		expect(existingPrFromFlag("42")).toBe(42);
		expect(existingPrFromFlag(undefined)).toBeUndefined();
		for (const value of [true, "0", "-1", "1.5"]) {
			expect(() => existingPrFromFlag(value)).toThrow(/positive PR number/);
		}
	});
});

describe("buildPipelineInput", () => {
	test("maps the profile onto the pipeline input; dryRun defaults FALSE (ship means ship)", () => {
		const input = buildPipelineInput(request(), deckProfile());
		expect(input.profile).toBe("deck");
		expect(input.repo).toBe("twaldin/deck");
		expect(input.dryRun).toBe(false);
		expect(input.ticket).toBe("deck-42");
	});

	test("the generated brief passes the pipeline's own preflight validation", () => {
		const input = buildPipelineInput(request(), deckProfile());
		const verdict = validateBrief(input.brief);
		expect(verdict.ok).toBe(true);
	});

	test("named kill-switch and default explicit none both validate", () => {
		const named = buildPipelineInput(request({ killSwitch: "FLAG_X" }), deckProfile());
		expect((named.brief as { killSwitch: unknown }).killSwitch).toEqual({
			kind: "named",
			name: "FLAG_X",
		});
		const none = buildPipelineInput(request(), deckProfile());
		expect((none.brief as { killSwitch: unknown }).killSwitch).toEqual({ kind: "none" });
		expect(validateBrief(named.brief).ok).toBe(true);
		expect(validateBrief(none.brief).ok).toBe(true);
	});

	test("yolo profile with no reviewers records the explicit reviewer skip; lindy never does", () => {
		const deck = buildPipelineInput(request(), deckProfile());
		expect((deck.github as { skipReviewerRequest?: boolean })?.skipReviewerRequest).toBe(true);
		const withReviewers = buildPipelineInput(request({ reviewers: ["alice"] }), deckProfile());
		expect(withReviewers.github).toBeUndefined();
		const lindy = buildPipelineInput(request({ profile: "lindy" }), lindyProfile());
		expect(lindy.github).toBeUndefined();
	});

	test("real runs get a deploy-evidence command (done is evidence-gated); dry runs do not need one", () => {
		const real = buildPipelineInput(request({ baseBranch: "v2" }), deckProfile());
		const commands = real.commands as { deployEvidence: string };
		expect(commands.deployEvidence).toContain("origin/v2");
		const dry = buildPipelineInput(request({ dryRun: true }), deckProfile());
		expect(dry.commands).toBeUndefined();
		expect(dry.dryRun).toBe(true);
	});

	test("existingPr passes through to the pipeline input (adopt path); omitted stays omitted", () => {
		const adopt = buildPipelineInput(request({ existingPr: 4242 }), deckProfile());
		expect(adopt.existingPr).toBe(4242);
		expect((adopt.commands as { deployEvidence: string }).deployEvidence).toContain("adopted existing PR");
		const fresh = buildPipelineInput(request(), deckProfile());
		expect(fresh.existingPr).toBeUndefined();
	});

	test("explicit reviewer skip is passed through even for a stamp profile", () => {
		const input = buildPipelineInput(request({ profile: "lindy", skipReviewerRequest: true }), lindyProfile());
		expect(input.github).toEqual({ skipReviewerRequest: true });
	});

	test("a stamp profile (lindy) never gets the weak git-log deploy default: preflight must fail closed until explicit evidence exists", () => {
		const lindy = buildPipelineInput(request({ profile: "lindy" }), lindyProfile());
		expect(lindy.commands).toBeUndefined();
		const explicit = buildPipelineInput(
			request({ profile: "lindy", deployEvidence: "check-deploy.sh" }),
			lindyProfile(),
		);
		expect((explicit.commands as { deployEvidence: string }).deployEvidence).toBe("check-deploy.sh");
	});
});

describe("smithers workspace", () => {
	test("REGRESSION: ship invokes Smithers from the shared workspace parent", () => {
		expect(smithersWorkspaceRoot(home)).toBe(path.join(home, "workflows", ".smithers"));
		expect(smithersWorkspaceCwd(home)).toBe(path.join(home, "workflows"));
	});
});

describe("startShip", () => {
	test("unknown profile refuses before anything is written", async () => {
		await expect(startShip(request({ profile: "nope" }), home)).rejects.toThrow(
			/unknown project profile/,
		);
	});

	test("a non-positive or fractional existingPr refuses before anything is written", async () => {
		await expect(startShip(request({ existingPr: 0 }), home)).rejects.toThrow(/existingPr/);
		await expect(startShip(request({ existingPr: -3 }), home)).rejects.toThrow(/existingPr/);
		await expect(startShip(request({ existingPr: 1.5 }), home)).rejects.toThrow(/existingPr/);
	});

	test("empty acceptance refuses (preflight fails closed downstream anyway)", async () => {
		await expect(startShip(request({ acceptance: [] }), home)).rejects.toThrow(/acceptance/);
	});

	test("missing pipeline dir refuses with the override hint", async () => {
		process.env.DECK_PIPELINE_DIR = path.join(home, "not-there");
		await expect(startShip(request(), home)).rejects.toThrow(/DECK_PIPELINE_DIR/);
	});

	test("pipelineDir resolves to the repo's pr-pipeline workflow", () => {
		expect(fs.existsSync(path.join(pipelineDir(), "pipeline.tsx"))).toBe(true);
	});

	test("REGRESSION: a launch that never starts REJECTS instead of reporting started", async () => {
		// A fake pipeline dir satisfies the existence check; an empty PATH makes
		// bunx unspawnable, so the child emits error instead of spawn.
		const fakeDir = path.join(home, "fake-pipeline");
		fs.mkdirSync(fakeDir, { recursive: true });
		fs.writeFileSync(path.join(fakeDir, "pipeline.tsx"), "// fake\n");
		process.env.DECK_PIPELINE_DIR = fakeDir;
		const savedPath = process.env.PATH;
		process.env.PATH = path.join(home, "empty-bin");
		try {
			await expect(startShip(request(), home)).rejects.toThrow(/could not start the pipeline run/);
		} finally {
			process.env.PATH = savedPath;
		}
	});
});

describe("spawn enforcement: pipeline is the default ship path", () => {
	test("shipProfileFor matches by project name, repo alias, and primary path", () => {
		const base = { taskId: "t", task: "x", acceptance: [], kind: "ship" as const };
		expect(shipProfileFor({ ...base, repo: "deck" })?.id).toBe("deck");
		expect(shipProfileFor({ ...base, project: "lindy", worktree: "/tmp/wt" })?.id).toBe("lindy");
		expect(shipProfileFor({ ...base, repo: deckProfile().primary })?.id).toBe("deck");
		expect(shipProfileFor({ ...base, repo: "/somewhere/unprofiled" })).toBeNull();
	});

	test("REGRESSION: a worktree-only ship spawn on a profiled repo is refused too (the worktree resolves to its primary)", async () => {
		// Build a real repo (the profile primary) and a linked worktree from it.
		const primary = path.join(home, "repo");
		fs.mkdirSync(primary, { recursive: true });
		const git = (args: string[], cwd: string) => {
			const run = Bun.spawnSync(["git", ...args], { cwd });
			if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
		};
		git(["init", "-b", "main"], primary);
		fs.writeFileSync(path.join(primary, "f.txt"), "x\n");
		git(["add", "f.txt"], primary);
		git(
			["-c", "user.name=t", "-c", "user.email=t@e.t", "commit", "-m", "x"],
			primary,
		);
		const wt = path.join(home, "wt-1");
		git(["worktree", "add", wt, "-b", "task-branch", "main"], primary);

		const file = profilesFile(home);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify([
				{
					id: "repoproj",
					repo: "twaldin/repoproj",
					primary,
					pipeline: "yolo-ship",
					yolo: true,
					stamp: false,
					knowledge: [],
				},
			]),
		);

		const req = { taskId: "t", task: "x", acceptance: [], kind: "ship" as const, worktree: wt };
		expect(shipProfileFor(req)?.id).toBe("repoproj");
		expect(() => assertShipGoesThroughPipeline(req)).toThrow(/repoproj/);
		// A worktree of an UNPROFILED repo still spawns bare.
		fs.writeFileSync(file, JSON.stringify([]));
		expect(() => assertShipGoesThroughPipeline(req)).not.toThrow();
	});

	test("REGRESSION: a bare ship spawn on a profiled repo is refused and points at deck-v2 ship", () => {
		const req = { taskId: "t", task: "x", acceptance: [], kind: "ship" as const, repo: "deck" };
		expect(() => assertShipGoesThroughPipeline(req)).toThrow(/deck-v2 ship/);
		expect(() => assertShipGoesThroughPipeline(req)).toThrow(/adversarial review/);
	});

	test("--no-pipeline is the explicit escape hatch", () => {
		expect(() =>
			assertShipGoesThroughPipeline({
				taskId: "t",
				task: "x",
				acceptance: [],
				kind: "ship",
				repo: "deck",
				noPipeline: true,
			}),
		).not.toThrow();
	});

	test("scouts and unprofiled repos are untouched", () => {
		expect(() =>
			assertShipGoesThroughPipeline({
				taskId: "t",
				task: "x",
				acceptance: [],
				kind: "scout",
				repo: "deck",
			}),
		).not.toThrow();
		expect(() =>
			assertShipGoesThroughPipeline({
				taskId: "t",
				task: "x",
				acceptance: [],
				kind: "ship",
				repo: "/somewhere/unprofiled",
			}),
		).not.toThrow();
	});

	test("a captain-edited config file drives the match (not just seeds)", () => {
		const file = profilesFile(home);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify([
				{
					id: "sideproj",
					repo: "twaldin/sideproj",
					primary: "/somewhere/sideproj",
					pipeline: "yolo-ship",
					yolo: true,
					stamp: false,
					knowledge: [],
				},
			]),
		);
		expect(() =>
			assertShipGoesThroughPipeline({
				taskId: "t",
				task: "x",
				acceptance: [],
				kind: "ship",
				repo: "sideproj",
			}),
		).toThrow(/yolo-ship/);
		// Wholesale replacement: deck is no longer profiled, so it spawns bare.
		expect(() =>
			assertShipGoesThroughPipeline({
				taskId: "t",
				task: "x",
				acceptance: [],
				kind: "ship",
				repo: "/unrelated/deck",
			}),
		).not.toThrow();
	});
});
