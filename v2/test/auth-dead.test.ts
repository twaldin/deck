import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { authDeadQuestionId, syncAuthDeadQuestions } from "../src/auth-dead";
import { answer, compact, markDelivered, openQuestions, readQuestions } from "../src/questions-store";
import { buildUsageText } from "../src/fleet";
import { authDeadStatusLine, usageStatusLine, type UsageRoster } from "../src/usage-roster";

let dir: string;
let file: string;
const session = { sessionId: "orchestrator-1", cwd: "/tmp/deck" };

const DEAD: UsageRoster = {
	reports: [{ provider: "anthropic", limits: [{ window: { id: "5h" }, amount: { remainingFraction: 0.5 } }] }],
	dead: [{ id: 4, provider: "anthropic", email: "dead@deck.invalid", cause: "invalid_grant: Refresh token not found or invalid", disabledAtMs: 1_700_000_000_000 }],
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-authdead-"));
	file = path.join(dir, "queue.jsonl");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("auth-dead durable questions", () => {
	test("asks once per dead account and never duplicates across cycles", () => {
		const first = syncAuthDeadQuestions(file, DEAD, session);
		expect(first.asked).toEqual([authDeadQuestionId(DEAD.dead![0]!)]);

		const second = syncAuthDeadQuestions(file, DEAD, session);
		expect(second.asked).toEqual([]);
		expect(openQuestions(file)).toHaveLength(1);
	});

	test("the question names the account and the fix", () => {
		syncAuthDeadQuestions(file, DEAD, session);
		const question = openQuestions(file)[0]!;
		expect(question.question).toContain("REAUTH NEEDED");
		expect(question.question).toContain("dead@deck.invalid");
		expect(question.question).toContain("claude");
		expect(question.question).toContain("bun ~/dev/deck/broker/src/cli.ts login anthropic");
		expect(question.context).toContain("invalid_grant");
		expect(question.urgency).toBe("high");
	});

	test("does not append again after the captain resolves the incident", () => {
		syncAuthDeadQuestions(file, DEAD, session);
		const id = authDeadQuestionId(DEAD.dead![0]!);
		answer(file, id, "leave it out", "dismissed");
		markDelivered(file, id);
		compact(file);
		const before = fs.statSync(file).size;
		expect(syncAuthDeadQuestions(file, DEAD, session)).toEqual({ asked: [], cleared: [] });
		expect(fs.statSync(file).size).toBe(before);
	});

	test("clears the question once the account authenticates again", () => {
		syncAuthDeadQuestions(file, DEAD, session);
		const id = authDeadQuestionId(DEAD.dead![0]!);

		const recovered = syncAuthDeadQuestions(file, { ...DEAD, dead: [] }, session);
		expect(recovered.cleared).toEqual([id]);
		expect(openQuestions(file)).toEqual([]);
		expect(readQuestions(file).find(entry => entry.id === id)?.status).toBe("dismissed");
	});

	test("leaves unrelated questions alone", () => {
		syncAuthDeadQuestions(file, DEAD, session);
		fs.appendFileSync(
			file,
			`${JSON.stringify({ kind: "ask", id: "other", question: "merge?", urgency: "normal", sessionId: session.sessionId, cwd: session.cwd, askedAt: Date.now() })}\n`,
		);
		const result = syncAuthDeadQuestions(file, { dead: [] }, session);
		expect(result.cleared).toEqual([authDeadQuestionId(DEAD.dead![0]!)]);
		expect(openQuestions(file).map(entry => entry.id)).toEqual(["other"]);
	});

	test("a roster with no dead accounts asks nothing", () => {
		expect(syncAuthDeadQuestions(file, { reports: [], dead: [] }, session)).toEqual({ asked: [], cleared: [] });
	});

	test("REGRESSION: an unreadable roster never dismisses a live login question", () => {
		syncAuthDeadQuestions(file, DEAD, session);
		// readUsageRoster returns null when the file is missing or unparseable, and
		// a broker older than the dead field writes no `dead` key at all. Treating
		// either as recovery dismissed the question PERMANENTLY: the fold keeps a
		// terminal status across re-asks, so the captain never saw it again.
		expect(syncAuthDeadQuestions(file, null, session)).toEqual({ asked: [], cleared: [] });
		expect(syncAuthDeadQuestions(file, { reports: [] }, session)).toEqual({ asked: [], cleared: [] });
		expect(openQuestions(file)).toHaveLength(1);
	});

	test("REGRESSION: a second failure of the same account asks again", () => {
		syncAuthDeadQuestions(file, DEAD, session);
		syncAuthDeadQuestions(file, { dead: [] }, session); // captain logs back in
		const relapse = { dead: [{ ...DEAD.dead![0]!, disabledAtMs: 1_700_000_999_000 }] };
		const second = syncAuthDeadQuestions(file, relapse, session);
		// A reused id would be swallowed: the fold restores the dismissed status.
		expect(second.asked).toHaveLength(1);
		expect(openQuestions(file)).toHaveLength(1);
		expect(openQuestions(file)[0]!.status).toBe("open");
	});
});

describe("auth-dead visibility", () => {
	test("the statusline leads with the login warning", () => {
		expect(authDeadStatusLine(DEAD)).toBe("REAUTH NEEDED: dead@deck.invalid");
		expect(usageStatusLine(DEAD).startsWith("REAUTH NEEDED: dead@deck.invalid")).toBe(true);
	});

	test("a healthy roster shows no warning", () => {
		expect(authDeadStatusLine({ reports: [] })).toBe("");
		expect(authDeadStatusLine(null)).toBe("");
		expect(usageStatusLine({ reports: [{ provider: "anthropic", limits: [{ window: { id: "5h" }, amount: { remainingFraction: 0.5 } }] }] })).not.toContain("login");
	});

	test("/usage lists the dead account instead of dropping it", () => {
		const text = buildUsageText(DEAD);
		expect(text).toContain("REAUTH NEEDED: dead@deck.invalid · anthropic");
		expect(text).toContain("invalid_grant");
	});
});
