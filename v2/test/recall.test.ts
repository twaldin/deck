import { describe, expect, test } from "bun:test";
import { parsePrReference, resolveEffortReference } from "../src/recall";

// These moved out of the deck-recall extension when the `recall_effort` tool was
// deleted: the resolver is now reached from `deck.recall()` and `deck-v2 recall`,
// so it must not depend on an extension being loaded.
describe("effort reference resolution", () => {
	const efforts = [
		{ id: "alpha", run_epoch: 4, pr: "https://github.com/acme/widgets/pull/17" },
		{ id: "beta", run_epoch: 2, pr: "other/tools#17" },
		{ id: "123", run_epoch: 8, pr: "#99" },
	];

	test("parses supported PR spellings", () => {
		expect(parsePrReference("17")).toEqual({ number: 17 });
		expect(parsePrReference("#17")).toEqual({ number: 17 });
		expect(parsePrReference("Acme/Widgets#17")).toEqual({ repo: "acme/widgets", number: 17 });
		expect(parsePrReference("https://github.com/Acme/Widgets/pull/17/files")).toEqual({
			repo: "acme/widgets",
			number: 17,
		});
		expect(parsePrReference("not a pr")).toBeNull();
	});

	test("prefers an exact task id and requires unique bare PRs", () => {
		expect(resolveEffortReference("123", efforts)).toEqual({ taskId: "123", epoch: 8 });
		expect(resolveEffortReference("acme/widgets#17", efforts)).toEqual({ taskId: "alpha", epoch: 4 });
		expect(() => resolveEffortReference("#17", efforts)).toThrow("ambiguous");
		expect(() => resolveEffortReference("missing", efforts)).toThrow('no Deck effort matches "missing"');
		expect(() => resolveEffortReference("   ", efforts)).toThrow("needs a task id or PR reference");
	});
});
