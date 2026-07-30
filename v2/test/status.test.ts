import { describe, expect, test } from "bun:test";
import {
	STATUS_VERBS,
	formatStatusLine,
	isMalformed,
	parseStatusLine,
	tierFor,
	type StatusEvent,
} from "../src/status";

function ok(line: string): StatusEvent {
	const parsed = parseStatusLine(line);
	if (parsed === null) throw new Error("unexpected blank line");
	if (isMalformed(parsed)) throw new Error(`unexpected malformed: ${parsed.reason}`);
	return parsed;
}

describe("status grammar", () => {
	test("parses a plain line", () => {
		const e = ok("done: PR https://github.com/o/r/pull/1 checks green");
		expect(e.verb).toBe("done");
		expect(e.key).toBe("default");
		expect(e.note).toBe("PR https://github.com/o/r/pull/1 checks green");
	});

	test("parses every verb", () => {
		for (const verb of STATUS_VERBS) {
			expect(ok(`${verb}: note`).verb).toBe(verb);
		}
	});

	test("parses a decision key", () => {
		const e = ok("needs-decision [key=api-shape]: which shape");
		expect(e.verb).toBe("needs-decision");
		expect(e.key).toBe("api-shape");
		expect(e.note).toBe("which shape");
	});

	test("note keeps colons and URLs intact", () => {
		expect(ok("blocked: see https://x.test/a:b for why").note).toBe(
			"see https://x.test/a:b for why",
		);
	});

	// The fm2 regression. bin/fm-classify-lib.sh:162-167 took everything before
	// the first colon, so these parsed as verbs "[2026-07-29T01" and
	// "2026-07-29T04" and the real blocked/paused events were invisible.
	test("REGRESSION: timestamp-prefixed lines are malformed, never misparsed", () => {
		for (const line of [
			"[2026-07-29T01:13 UTC] blocked: main red",
			"2026-07-29T04:51:05Z paused: waiting on upstream",
		]) {
			const parsed = parseStatusLine(line);
			expect(parsed).not.toBeNull();
			if (parsed === null) return;
			expect(isMalformed(parsed)).toBe(true);
			if (isMalformed(parsed)) expect(parsed.reason).toContain("does not start with a status verb");
		}
	});

	test("rejects an unknown verb rather than guessing", () => {
		const parsed = parseStatusLine("progress: half way");
		if (parsed === null || !isMalformed(parsed)) throw new Error("expected malformed");
		expect(parsed.reason).toContain("does not start with a status verb");
	});

	test("rejects a line with no colon", () => {
		const parsed = parseStatusLine("done");
		if (parsed === null || !isMalformed(parsed)) throw new Error("expected malformed");
		expect(parsed.reason).toContain("no colon");
	});

	test("blank lines are null", () => {
		expect(parseStatusLine("")).toBeNull();
		expect(parseStatusLine("   ")).toBeNull();
	});

	test("format round-trips and collapses newlines", () => {
		const line = formatStatusLine("blocked", "two\nlines  here", "k1");
		expect(line).toBe("blocked [key=k1]: two lines here");
		const e = ok(line);
		expect(e.key).toBe("k1");
		expect(e.note).toBe("two lines here");
	});

	test("severity tiers match the wake design", () => {
		expect(tierFor("blocked")).toBe("T0");
		expect(tierFor("failed")).toBe("T0");
		expect(tierFor("needs-decision")).toBe("T0");
		expect(tierFor("done")).toBe("T1");
		expect(tierFor("resolved")).toBe("T1");
		// The absorbed-noise class: these must never wake.
		expect(tierFor("working")).toBe("T2");
		expect(tierFor("paused")).toBe("T2");
	});
});
