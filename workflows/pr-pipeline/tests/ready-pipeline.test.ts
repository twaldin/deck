import { describe, expect, test } from "bun:test";
import { evaluateReadyForStamp } from "../lib/ready.ts";

type ReadyRow = { ready: boolean; regressed: boolean; approvedBy: string | null; ci: string; headSha: string };
function selectStampReadyRow(latest: ReadyRow | undefined, rows: ReadyRow[]): ReadyRow | undefined {
	return latest?.ready === true ? latest : [...rows].reverse().find((row) => row.approvedBy !== null && row.ci === "green" && !row.regressed);
}

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
		expect(selectStampReadyRow(undefined, [{ ready: false, regressed: false, approvedBy: "reviewer", ci: "red", headSha: "h" }])).toBeUndefined();
	});

	test("a later non-ready poll still selects the earlier green approved row", () => {
		const approved = { ready: true, regressed: false, approvedBy: "reviewer", ci: "green", headSha: "h1" };
		const later = { ready: false, regressed: false, approvedBy: null, ci: "none", headSha: "h2" };
		expect(selectStampReadyRow(later, [approved, later])).toEqual(approved);
	});
});
