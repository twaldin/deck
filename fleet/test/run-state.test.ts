import { describe, expect, test } from "bun:test";
import { isLiveRun } from "../src/run-state";

describe("isLiveRun", () => {
	test("keeps executing/waiting/paused work live", () => {
		expect(isLiveRun("running")).toBe(true);
		expect(isLiveRun("RUNNING")).toBe(true);
		expect(isLiveRun("waiting-approval")).toBe(true);
		expect(isLiveRun("waiting-event")).toBe(true);
		expect(isLiveRun("waiting-timer")).toBe(true);
		expect(isLiveRun("paused")).toBe(true);
	});

	test("treats terminal Smithers states as history", () => {
		expect(isLiveRun("finished")).toBe(false);
		expect(isLiveRun("failed")).toBe(false);
		expect(isLiveRun("cancelled")).toBe(false);
		expect(isLiveRun("succeeded")).toBe(false);
		expect(isLiveRun("continued")).toBe(false);
		expect(isLiveRun("unknown")).toBe(false);
	});
});
