import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { evaluateReadyForStamp } from "../lib/ready.ts";

const pipelineSource = readFileSync(new URL("../pipeline.tsx", import.meta.url), "utf8");

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
		expect(pipelineSource).toContain("ctx.latest(outputs.readyPoll, readyNode)?.ready === true");
	});

	test("the production ready loop exits on any ready row", () => {
		expect(pipelineSource).toContain("ctx.latest(outputs.readyPoll, readyNode)?.ready === true ||");
		expect(pipelineSource).not.toContain("greenApprovedRow");
		expect(pipelineSource).not.toContain("stampReadyRow");
	});
});
