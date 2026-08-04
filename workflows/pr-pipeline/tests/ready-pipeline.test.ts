import { describe, expect, test } from "bun:test";
import { evaluateReadyForStamp } from "../lib/ready.ts";

describe("ready exhaustion inputs", () => {
	test("green approval is ready, so exhaustion must not rescue a non-ready row", () => {
		const result = evaluateReadyForStamp([{ login: "reviewer", state: "APPROVED", submittedAt: "2026-01-01", isBot: false }], "green", {
			author: "author", excludedApprovers: [],
		});
		expect(result.ready).toBe(true);
		expect(result.approvedBy).toBe("reviewer");
	});

	test("a cancelled CI result is not ready even with approval", () => {
		const result = evaluateReadyForStamp([{ login: "reviewer", state: "APPROVED", submittedAt: "2026-01-01", isBot: false }], "red", {
			author: "author", excludedApprovers: [],
		});
		expect(result.ready).toBe(false);
	});
});
