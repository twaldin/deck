import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import deckV2 from "../src/extension/index";
import { STANDING_RULES_DIGEST_BUDGET, STANDING_RULES_DIGEST_MARKER, standingRulesDigest } from "../src/extension/standing-rules";

let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-rules-"));
	process.env.DECK_V2_HOME = home;
	fs.mkdirSync(path.join(home, "data", "ref", "distill"), { recursive: true });
});
afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
});

test("truncates oldest content and stays within the byte budget", () => {
	fs.writeFileSync(path.join(home, "data", "captain.md"), "old\n" + "x".repeat(7000));
	fs.writeFileSync(path.join(home, "data", "ref", "distill", "STANDING-RULES.md"), "newest");
	const digest = standingRulesDigest();
	expect(Buffer.byteLength(digest)).toBeLessThanOrEqual(STANDING_RULES_DIGEST_BUDGET);
	expect(digest).toContain("newest");
	expect(digest).not.toContain("old\n");
});

test("injects once at session start and once for each compaction", async () => {
	fs.writeFileSync(path.join(home, "data", "captain.md"), "captain");
	const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
	const sent: { content: string; options?: Record<string, unknown> }[] = [];
	const pi = {
		registerTool() {}, registerCommand() {},
		on(event: string, handler: any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		sendMessage(message: { content: string }, options?: Record<string, unknown>) { sent.push({ content: message.content, options }); },
	};
	deckV2(pi as never);
	const ctx = { mode: "print", isIdle: () => true, hasPendingMessages: () => false };
	for (const [event, payload] of [["session_start", {}], ["session_compact", { compactionEntry: { id: "c1" } }], ["session_compact", { compactionEntry: { id: "c1" } }], ["session_compact", { compactionEntry: { id: "c2" } }]] as const) {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	}
	expect(sent).toHaveLength(3);
	expect(sent.every((message) => message.content.includes(STANDING_RULES_DIGEST_MARKER))).toBe(true);
	expect(sent[0]?.options).toEqual({ deliverAs: "nextTurn", triggerTurn: false });
	expect(sent[1]?.options).toEqual({ deliverAs: "steer", triggerTurn: false });
	expect(sent[2]?.options).toEqual({ deliverAs: "steer", triggerTurn: false });
});
