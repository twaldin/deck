import { describe, expect, test } from "bun:test";
import { fitFrame } from "../src/viewport";

describe("fitFrame", () => {
	test("returns the complete frame when it fits", () => {
		expect(fitFrame(["a", "b"], 2)).toEqual(["a", "b"]);
		expect(fitFrame(["a", "b"], 3)).toEqual(["a", "b"]);
	});

	test("reserves the final physical row for an exact omitted count", () => {
		expect(fitFrame(["a", "b", "c", "d"], 3)).toEqual(["a", "b", "… 2 lines omitted"]);
		expect(fitFrame(["a", "b"], 1)).toEqual(["… 2 lines omitted"]);
	});

	test("handles zero and fractional row budgets deterministically", () => {
		expect(fitFrame(["a"], 0)).toEqual([]);
		expect(fitFrame(["a", "b", "c"], 2.9)).toEqual(["a", "… 2 lines omitted"]);
	});

	test("keeps the omission marker inside an optional column budget", () => {
		const frame = fitFrame(["a", "b", "c"], 2, 5);
		expect(frame[1]).toBe("… 2 …");
		expect(Bun.stringWidth(frame[1]!)).toBeLessThanOrEqual(5);
	});

	test("preserves the diagnostics footer when fitting a dashboard", () => {
		const frame = fitFrame(
			["Fleet", "task 1", "task 2", "task 3", "", "Sources", "MISSING smithers", "ok backlog"],
			6,
		);
		expect(frame).toEqual([
			"Fleet",
			"task 1",
			"task 2",
			"… 3 lines omitted",
			"Sources",
			"MISSING smithers",
		]);
	});
});
