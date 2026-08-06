import { describe, expect, test } from "bun:test";
import { fetchPrOverview, parseToolJson, type ExecFn } from "../lib/gh";

/**
 * An adopt run died at `fetchPrOverview` with
 * `JSON Parse error: Unrecognized token '\u001b'`: the pipeline was launched
 * from a pane, `gh` concluded a human was watching, and it coloured its output.
 * Every GitHub read in the pipeline parses JSON, so one escape byte breaks all
 * of them.
 */
describe("gh output is parsed as machine output", () => {
	test("a coloured prefix does not break a PR read", async () => {
		const coloured: ExecFn = async () => ({
			code: 0,
			stdout: `\u001b[0m\u001b[32m${JSON.stringify({
				number: 1,
				html_url: "https://github.com/acme/widgets/pull/1",
				state: "open",
				head: { ref: "feature", sha: "abc123", repo: { full_name: "acme/widgets" } },
				base: { ref: "main" },
			})}\u001b[0m`,
			stderr: "",
		});

		const overview = await fetchPrOverview(
			{ gh: "gh", repo: "acme/widgets", exec: coloured },
			1,
		);
		expect(overview.number).toBe(1);
		expect(overview.headSha).toBe("abc123");
	});

	test("output with no JSON at all reports what it actually got", () => {
		expect(() => parseToolJson("gh: could not authenticate", "gh")).toThrow(
			/returned no JSON: gh: could not authenticate/,
		);
	});

	test("genuinely malformed JSON is still an error, not silently accepted", () => {
		expect(() => parseToolJson('{"number": ', "gh")).toThrow(/unparseable JSON/);
	});
});
