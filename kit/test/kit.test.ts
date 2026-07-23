import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const deckHome = fs.mkdtempSync(path.join(os.tmpdir(), "deck-smithers-kit-test-"));
process.env.DECK_HOME = deckHome;

// Dynamic imports are intentional: storage captures DECK_HOME at module load,
// so the isolated test root must exist before either package enters the graph.
const core = await import("@deck/core");
const { DeckApproval, DeckPiAgent, DeckWorktree } = await import("../src/index");

afterAll(() => {
	fs.rmSync(deckHome, { recursive: true, force: true });
});

test("DeckPiAgent fixes the broker provider and composes dispatch context", () => {
	const agent = new DeckPiAgent({
		basePrompt: "Deck rules",
		rolePrompt: "Worker role",
		dispatchSkills: ["review"],
	});

	expect(agent.opts.provider).toBe("deck");
	expect(agent.opts.model).toBe("claude-haiku-4-5");
	expect(agent.opts.apiKey).toBeUndefined();
	expect(agent.opts.skill).toEqual(["review"]);
	expect(agent.opts.extension).toEqual(["@smithers-orchestrator/pi-plugin"]);
	expect(agent.composedSystemPrompt).toContain("Deck rules\n\nWorker role");
});

test("DeckWorktree reads the shared allocator through the deck CLI", async () => {
	const command = path.resolve(import.meta.dir, "../../cli/bin/deck");
	const worktrees = new DeckWorktree({ command });

	expect(await worktrees.list()).toEqual([]);
});

test("DeckApproval creates one durable card and is idempotent", () => {
	core.createEffort({
		effort_id: "smithers-kit",
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
		effortId: "smithers-kit",
		workflowRunId: "run-1",
		nodeId: "approve-1",
		title: "Approve task B?",
		summary: "Task A persisted.",
	};
	const first = approval.mirror(request);
	const second = approval.mirror(request);
	const manifest = core.openEffort("smithers-kit").readManifest();

	expect(first).toEqual({
		cardId: "smithers:run-1:approve-1",
		manifestRevision: 1,
		created: true,
	});
	expect(second.created).toBe(false);
	expect(manifest.cards).toHaveLength(1);
	expect(manifest.overlays.needs_tim).toEqual(["smithers:run-1:approve-1"]);
	expect(manifest.cards[0]?.card.recommendation).toBe("Task A persisted.");
});
