import { describe, expect, test } from "bun:test";
import { clampIntervalSec, defaultFmHome, parseArgs } from "../src/config";

describe("parseArgs", () => {
	test("defaults: fm-home from env, cwd workspace, interval 2s", () => {
		const { config } = parseArgs([], { FM_HOME: "/x/fm2" }, "/work", false);
		expect(config.fmHome).toBe("/x/fm2");
		expect(config.intervalMs).toBe(2000);
		expect(config.smithersWorkspaces).toContain("/work");
		expect(config.smithersWorkspaces).toContain("/x/fm2/workflows");
		expect(config.color).toBe(false); // not a tty
		expect(config.verbose).toBe(false);
	});

	test("clamps interval into the 1-5s band", () => {
		expect(parseArgs(["--interval", "0"], {}, "/w", false).config.intervalMs).toBe(1000);
		expect(parseArgs(["--interval", "9"], {}, "/w", false).config.intervalMs).toBe(5000);
		expect(parseArgs(["--interval", "3"], {}, "/w", false).config.intervalMs).toBe(3000);
	});

	test("--once and --no-color and repeated --workspace", () => {
		const { config } = parseArgs(
			["--once", "--verbose", "--no-color", "--workspace", "/a", "--workspace", "/b"],
			{},
			"/w",
			true,
		);
		expect(config.once).toBe(true);
		expect(config.color).toBe(false);
		expect(config.verbose).toBe(true);
		expect(config.smithersWorkspaces).toEqual(["/a", "/b"]);
	});

	test("color on for a tty unless NO_COLOR", () => {
		expect(parseArgs([], {}, "/w", true).config.color).toBe(true);
		expect(parseArgs([], { NO_COLOR: "1" }, "/w", true).config.color).toBe(false);
	});

	test("--help sets help flag", () => {
		expect(parseArgs(["--help"], {}, "/w", false).help).toBe(true);
	});

	test("unknown arg produces an error", () => {
		expect(parseArgs(["--bogus"], {}, "/w", false).error).toContain("unknown");
	});

	test("clampIntervalSec + defaultFmHome", () => {
		expect(clampIntervalSec(0)).toBe(1);
		expect(clampIntervalSec(100)).toBe(5);
		expect(defaultFmHome({ FM_HOME: "/z" })).toBe("/z");
	});
});
