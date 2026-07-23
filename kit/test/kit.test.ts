import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const deckHome = fs.mkdtempSync(path.join(os.tmpdir(), "deck-smithers-kit-test-"));
process.env.DECK_HOME = deckHome;

// Dynamic imports are intentional: storage captures DECK_HOME at module load,
// so the isolated test root must exist before either package enters the graph.
const core = await import("@deck/core");
const {
	DeckApproval,
	DeckPiAgent,
	DeckWorktree,
	DeckWorktreeCommandError,
} = await import("../src/index");

afterAll(() => {
	fs.rmSync(deckHome, { recursive: true, force: true });
});

test("DeckPiAgent fixes the broker provider and resolves Pi resource paths", () => {
	const dispatchSkill = path.join(deckHome, "review-skill");
	fs.mkdirSync(dispatchSkill);
	fs.writeFileSync(path.join(dispatchSkill, "SKILL.md"), "# Review\n");
	const agent = new DeckPiAgent({
		basePrompt: "Deck rules",
		rolePrompt: "Worker role",
		dispatchSkills: [dispatchSkill],
	});

	expect(agent.opts.provider).toBe("deck");
	expect(agent.opts.model).toBe("claude-haiku-4-5");
	expect(agent.opts.apiKey).toBeUndefined();
	expect(agent.opts.skill).toEqual([dispatchSkill]);
	expect(agent.opts.extension).toHaveLength(1);
	expect(fs.existsSync(agent.opts.extension?.[0] ?? "")).toBe(true);
	expect(agent.composedSystemPrompt).toContain("Deck rules\n\nWorker role");
});

test("DeckWorktree forwards current Deck state to the shared CLI", async () => {
	const command = path.resolve(import.meta.dir, "../../cli/bin/deck");
	const worktree = {
		id: "wt:deck:1",
		repo: "/tmp/deck-repo",
		path: "/tmp/deck-worktree",
		effort: "deck--smithers-kit",
		branch: "deck/smithers-kit/1",
		created: "2026-07-22T00:00:00.000Z",
		state: "active",
	};
	fs.writeFileSync(path.join(deckHome, "worktrees.json"), JSON.stringify({ v: 1, entries: [worktree] }));
	const worktrees = new DeckWorktree({ command });

	expect(await worktrees.list()).toEqual([worktree]);
});

test("DeckWorktree kills a hung process group at its deadline", async () => {
	const command = path.join(deckHome, "hanging-deck");
	const childPidFile = path.join(deckHome, "hanging-child.pid");
	fs.writeFileSync(
		command,
		`#!/usr/bin/env bun
const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
await Bun.write(process.env.DECK_KIT_CHILD_PID_FILE, String(child.pid));
const { promise } = Promise.withResolvers();
await promise;
`,
	);
	fs.chmodSync(command, 0o755);
	process.env.DECK_KIT_CHILD_PID_FILE = childPidFile;
	const worktrees = new DeckWorktree({ command, timeoutMs: 1_000 });

	try {
		await worktrees.list();
		throw new Error("hung command unexpectedly completed");
	} catch (error) {
		if (!(error instanceof DeckWorktreeCommandError)) {
			throw error;
		}
		expect(error.reason).toBe("timeout");
	}
	const childPid = Number.parseInt(fs.readFileSync(childPidFile, "utf8"), 10);
	expect(() => process.kill(childPid, 0)).toThrow();
});

test("DeckApproval creates one durable card and is idempotent", () => {
	core.createEffort({
		effort_id: "deck--smithers-kit",
		project: "deck",
		title: "Smithers kit test",
		charter: {
			goal: "Exercise approval mirroring",
			acceptance_criteria: ["Card is durable"],
			constraints: [],
		},
	});

	const approval = new DeckApproval();
	const request = {
		effortId: "deck--smithers-kit",
		workflowRunId: "run-1",
		nodeId: "approve-1",
		title: "Approve task B?",
		summary: "Task A persisted.",
	};
	const first = approval.mirror(request);
	const second = approval.mirror(request);
	const store = core.openEffort("deck--smithers-kit");
	const firstManifest = store.readManifest();
	const firstCardId = "smithers:run-1:approve-1:0";
	store.mutate(firstManifest.revision, null, (current) => ({
		manifest: {
			...current,
			overlays: {
				...current.overlays,
				needs_tim: current.overlays.needs_tim.filter((cardId) => cardId !== firstCardId),
			},
			cards: current.cards.map((entry) =>
				entry.id === firstCardId
					? { ...entry, status: "answered" as const, answer: "Approve", answered_ts: Date.now() }
					: entry,
			),
		},
		event: {
			plane: "tim",
			type: "tim.decision",
			actor: "tim",
			data: { card_id: firstCardId, answer: "Approve" },
		},
	}));
	const nextIteration = approval.mirror({ ...request, iteration: 1 });
	const manifest = store.readManifest();

	expect(first).toEqual({
		cardId: firstCardId,
		manifestRevision: 1,
		created: true,
	});
	expect(second.created).toBe(false);
	expect(nextIteration).toEqual({
		cardId: "smithers:run-1:approve-1:1",
		manifestRevision: 3,
		created: true,
	});
	expect(manifest.cards).toHaveLength(2);
	expect(manifest.overlays.needs_tim).toEqual(["smithers:run-1:approve-1:1"]);
	expect(manifest.cards[0]?.card.recommendation).toBe("Task A persisted.");
});
