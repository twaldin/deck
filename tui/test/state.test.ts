import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "bun:test";
import { eventSchema, inboxCommandSchema, inboxReceiptSchema, manifestSchema } from "@deck/core";
import { DeckStateReader } from "../src/state";

const fixtureManifest = manifestSchema.parse(
	JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", "needs-tim.json"), "utf8")),
);

test("reads canonical files, limits tail to 20, and folds inbox receipts", () => {
	const deckHome = fs.mkdtempSync(path.join(os.tmpdir(), "deck-tui-state-"));
	try {
		const effortsDir = path.join(deckHome, "efforts");
		const brokerDir = path.join(deckHome, "broker");
		const effortDir = path.join(effortsDir, fixtureManifest.effort_id);
		fs.mkdirSync(effortDir, { recursive: true });
		fs.mkdirSync(brokerDir, { recursive: true });
		fs.writeFileSync(path.join(effortDir, "manifest.json"), JSON.stringify(fixtureManifest));
		fs.writeFileSync(
			path.join(effortDir, "charter.json"),
			JSON.stringify({
				goal: "Render durable Deck state.",
				acceptance_criteria: ["Receipts are visible"],
				constraints: [],
				created: "2026-07-22T09:00:00.000Z",
				charter_changes: [],
			}),
		);

		const events = Array.from({ length: 2_000 }, (_, index) =>
			eventSchema.parse({
				id: `event-${index}`,
				ts: new Date(1_784_721_000_000 + index).toISOString(),
				plane: "fact",
				type: "fact.test",
				actor: "router:test",
				data: { sequence: index },
			}),
		);
		fs.writeFileSync(path.join(effortDir, "tail.jsonl"), `${events.map(event => JSON.stringify(event)).join("\n")}\n`);

		const command = inboxCommandSchema.parse({
			cmd_id: "cmd-1",
			cmd: { type: "tim.message", body: "Receipt test" },
			from: "tim",
			ts: 1_784_721_000_000,
			delivered: null,
			acked: null,
		});
		const delivered = inboxReceiptSchema.parse({ cmd_id: "cmd-1", receipt: "delivered", ts: 1_784_721_001_000 });
		const acked = inboxReceiptSchema.parse({ cmd_id: "cmd-1", receipt: "acked", ts: 1_784_721_002_000 });
		fs.writeFileSync(
			path.join(effortDir, "inbox.jsonl"),
			`${[command, delivered, acked].map(record => JSON.stringify(record)).join("\n")}\n`,
		);

		const reader = new DeckStateReader({ effortsDir, brokerDir });
		const board = reader.loadBoard();
		const effort = reader.loadEffort(fixtureManifest.effort_id);
		expect(board.efforts).toHaveLength(1);
		expect(board.issues).toEqual([]);
		expect(effort.events).toHaveLength(20);
		expect(effort.events[0]?.id).toBe("event-1980");
		expect(effort.inbox).toHaveLength(1);
		expect(effort.inbox[0]?.delivered).toBe(delivered.ts);
		expect(effort.inbox[0]?.acked).toBe(acked.ts);
		expect(effort.issues).toEqual([]);
	} finally {
		fs.rmSync(deckHome, { recursive: true, force: true });
	}
});
