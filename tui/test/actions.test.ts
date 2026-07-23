import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "bun:test";
import { eventSchema, inboxCommandSchema, manifestSchema } from "@deck/core";
import { z } from "zod";

const harnessResultSchema = z.object({
	answer: z.object({ manifest: manifestSchema, command: inboxCommandSchema }),
	manifest: manifestSchema,
	inbox: z.array(inboxCommandSchema),
	tail: z.array(eventSchema),
});

test("card answer mutates the manifest and queues an owner command", async () => {
	const deckHome = fs.mkdtempSync(path.join(os.tmpdir(), "deck-tui-action-"));
	try {
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "action-harness.ts")], {
			env: { ...process.env, DECK_HOME: deckHome },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		const result = harnessResultSchema.parse(JSON.parse(stdout));
		const answeredCard = result.manifest.cards[0];
		if (answeredCard === undefined || answeredCard.answered_ts === null) throw new Error("answered card is incomplete");
		const inboxCommand = result.inbox[0];
		if (inboxCommand === undefined) throw new Error("card answer command is missing");
		expect(answeredCard.status).toBe("answered");
		expect(answeredCard.answer).toBe("yes");
		expect(result.manifest.overlays.needs_tim).toEqual([]);
		expect(result.manifest.decisions).toEqual([
			{ ts: answeredCard.answered_ts, card_id: "card-1", answer: "yes" },
		]);
		expect(result.answer.command).toEqual(inboxCommand);
		expect(inboxCommand.cmd).toEqual({ kind: "card_answer", card_id: "card-1", answer: "yes" });
		expect(inboxCommand.delivered).toBeNull();
		expect(inboxCommand.acked).toBeNull();
		expect(result.tail[0]?.type).toBe("tim.decision");
	} finally {
		fs.rmSync(deckHome, { recursive: true, force: true });
	}
});
