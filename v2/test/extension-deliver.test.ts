import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { warnOnShadowWorkspace } from "../src/workspace";

let home: string;
let savedPath: string | undefined;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-deliver-"));
	process.env.DECK_V2_HOME = home;
	savedPath = process.env.PATH;
	process.env.PATH = "/nonexistent";
});
afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
	if (savedPath !== undefined) process.env.PATH = savedPath;
});


describe("fleet workspace safeguards", () => {
	test("REGRESSION: shadow warning lists execution run ids only", () => {
		const shadow = path.join(home, "workflows", "pr-pipeline", ".smithers");
		fs.mkdirSync(path.join(shadow, "executions", "run-123"), { recursive: true });
		fs.mkdirSync(path.join(shadow, "lib"), { recursive: true });
		const warnings: string[] = [];
		const ids = warnOnShadowWorkspace(home, (message) => warnings.push(message));
		expect(ids).toEqual(["run-123"]);
		expect(warnings[0]).toContain("run-123");
		expect(warnings[0]).not.toContain("lib");
	});

	test("REGRESSION: terminal markers in attempt payloads do not hide a live run", () => {
		const shadow = path.join(home, "workflows", "pr-pipeline", ".smithers");
		const run = path.join(shadow, "executions", "run-live");
		fs.mkdirSync(run, { recursive: true });
		fs.writeFileSync(path.join(run, "attempt.json"), JSON.stringify({ payload: "RunFailed", status: "failed" }));
		const warnings: string[] = [];
		expect(warnOnShadowWorkspace(home, (message) => warnings.push(message))).toEqual(["run-live"]);
		expect(warnings).toHaveLength(1);
	});

	test("REGRESSION: canonical terminal state is excluded", () => {
		const shadow = path.join(home, "workflows", "pr-pipeline", ".smithers");
		const run = path.join(shadow, "executions", "run-done");
		fs.mkdirSync(run, { recursive: true });
		fs.writeFileSync(path.join(run, "run.json"), JSON.stringify({ status: "completed" }));
		expect(warnOnShadowWorkspace(home, () => {})).toEqual([]);
	});

	test("REGRESSION: identical orphan sets warn once per session", () => {
		const shadow = path.join(home, "workflows", "pr-pipeline", ".smithers");
		fs.mkdirSync(path.join(shadow, "executions", "run-123"), { recursive: true });
		const warnings: string[] = [];
		const warnedFingerprints = new Set<string>();
		warnOnShadowWorkspace(home, (message) => warnings.push(message), warnedFingerprints);
		warnOnShadowWorkspace(home, (message) => warnings.push(message), warnedFingerprints);
		expect(warnings).toHaveLength(1);
	});


	test("REGRESSION: an empty shadow workspace does not warn", () => {
		const shadow = path.join(home, "workflows", "pr-pipeline", ".smithers");
		fs.mkdirSync(path.join(shadow, "executions"), { recursive: true });
		const warnings: string[] = [];
		expect(warnOnShadowWorkspace(home, (message) => warnings.push(message))).toEqual([]);
		expect(warnings).toEqual([]);
	});

});
