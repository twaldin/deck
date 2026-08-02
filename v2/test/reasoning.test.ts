import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import deckV2 from "../src/extension/index";
import { profilesFile, type ProjectProfile } from "../src/projects";
import { clampLevel, renderReasoning, setSeatReasoning } from "../src/reasoning";
import { workerReasoningFor } from "../src/spawn";

let home: string;
let oldHome: string | undefined;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deck-reasoning-"));
	oldHome = process.env.DECK_V2_HOME;
	process.env.DECK_V2_HOME = home;
});
afterEach(() => {
	if (oldHome === undefined) delete process.env.DECK_V2_HOME;
	else process.env.DECK_V2_HOME = oldHome;
	fs.rmSync(home, { recursive: true, force: true });
});

const profile = (models: ProjectProfile["models"]): ProjectProfile => ({
	id: "demo", repo: "demo/repo", primary: "/tmp/demo", pipeline: "yolo-ship", yolo: true, stamp: false, knowledge: [], models, depsWarm: true,
});
const theme = { bold: (value: string) => value, fg: (_key: string, value: string) => value };

function writeProfiles(profiles: ProjectProfile[]): void {
	fs.mkdirSync(path.dirname(profilesFile(home)), { recursive: true });
	fs.writeFileSync(profilesFile(home), `${JSON.stringify(profiles)}\n`);
}

describe("reasoning command model", () => {
	test("renders session, seats, and provider-native meaning", () => {
		const output = renderReasoning("high", [profile({ implementer: "deck/gpt-5.6-sol", reviewer: "deck/claude-fable-5", reasoningImplementer: "xhigh", reasoningReviewer: "high" })], theme, null);
		expect(output).toContain("self  high");
		expect(output).toContain("demo/implementer  xhigh");
		expect(output).toContain("reasoning_effort xhigh");
		expect(output).toContain("demo/reviewer  high");
		expect(output).toContain("budget_tokens 16384");
		const clamped = renderReasoning("high", [profile({ fallout: "deck/gpt-5.6-sol", reasoningFallout: "max" })], theme, null);
		expect(clamped).toContain("max→xhigh");
		expect(clamped).toContain("reasoning_effort xhigh");
	});

	test("sets a seat and persists it in projects.json", () => {
		writeProfiles([profile({ implementer: "deck/gpt-5.6-sol", reasoningImplementer: "low" })]);
		const result = setSeatReasoning("implementer", "high", home);
		expect(result.rows[0]?.level).toBe("high");
		expect(JSON.parse(fs.readFileSync(profilesFile(home), "utf8"))[0].models.reasoningImplementer).toBe("high");
	});

	test("rejects invalid levels and seats", () => {
		writeProfiles([profile({ implementer: "deck/gpt-5.6-sol" })]);
		expect(() => setSeatReasoning("implementer", "turbo", home)).toThrow(/level/);
		expect(() => setSeatReasoning("captain", "high", home)).toThrow(/unknown reasoning seat/);
	});

	test("clamps unsupported levels for display but persists the requested level", () => {
		writeProfiles([profile({ implementer: "deck/gpt-5.6-luna", fallout: "deck/gpt-5.6-sol", future: "kept" } as any)]);
		const result = setSeatReasoning("fallout", "max", home);
		expect(result.rows[0]?.level).toBe("xhigh");
		expect(result.warnings[0]).toContain("unsupported");
		expect(clampLevel("max", ["low", "high"])).toBe("high");
		const stored = JSON.parse(fs.readFileSync(profilesFile(home), "utf8"))[0];
		expect(stored.models.reasoningFallout).toBe("max");
		expect(stored.models.future).toBe("kept");
	});

	test("writes embedded seats without dropping unknown config fields", () => {
		writeProfiles([profile({ implementer: { model: "deck/gpt-5.6-luna", reasoning: "low" }, future: "kept" } as any)]);
		setSeatReasoning("implementer", "high", home);
		const stored = JSON.parse(fs.readFileSync(profilesFile(home), "utf8"))[0];
		expect(stored.models.implementer).toEqual({ model: "deck/gpt-5.6-luna", reasoning: "high" });
		expect(stored.models.future).toBe("kept");
	});

	test("worker spawn reads embedded and flat seat reasoning", () => {
		writeProfiles([profile({ implementer: { model: "deck/gpt-5.6-luna", reasoning: "high" } } as any)]);
		expect(workerReasoningFor({ ...({ taskId: "x", task: "x", acceptance: [], kind: "scout", project: "demo", worktree: "/tmp/demo" }), } as any)).toBe("high");
		writeProfiles([profile({ implementer: "deck/gpt-5.6-luna", reasoningImplementer: "xhigh" })]);
		expect(workerReasoningFor({ ...({ taskId: "x", task: "x", acceptance: [], kind: "scout", project: "demo", worktree: "/tmp/demo" }), } as any)).toBe("xhigh");
	});
});

describe("/reasoning extension command", () => {
	test("sets self through the pi API", async () => {
		const commands = new Map<string, any>();
		const notifications: string[] = [];
		let selected = "medium";
		const pi = {
			registerTool: () => {}, registerCommand: (name: string, command: any) => commands.set(name, command),
			on: () => {}, getThinkingLevel: () => selected, setThinkingLevel: (level: string) => { selected = level; },
		};
		deckV2(pi);
		await commands.get("reasoning").handler("self high", { ui: { notify: (value: string) => notifications.push(value) } });
		expect(selected).toBe("high");
		expect(notifications[0]).toContain("self  high");
	});
});
