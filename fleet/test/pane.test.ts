import { describe, expect, test } from "bun:test";
import { parsePaneState, collectPaneStates } from "../src/collectors/pane";
import type { TaskMeta } from "../src/types";

const meta = (window: string, backend = "herdr"): TaskMeta => ({
	window, backend, worktree: null, project: null, harness: null, kind: null,
	mode: null, model: null, effort: null, raw: {},
});

describe("live pane state", () => {
	test("parses agent status and fails closed for malformed output", () => {
		expect(parsePaneState('{"result":{"agent":{"agent_status":"working"}}}')).toBe("working");
		expect(parsePaneState('{"result":{"agent":{"agent_status":"idle"}}}')).toBe("idle");
		expect(parsePaneState("not json")).toBe("unknown");
		expect(parsePaneState('{"result":{"agent":{"agent_status":"surprising"}}}')).toBe("unknown");
	});

	test("queries only herdr panes and preserves task ids", async () => {
		const calls: string[][] = [];
		const states = await collectPaneStates(new Map([
			["alpha", meta("default:p1")],
			["beta", meta("default:p2", "tmux")],
		]), async (command, args) => {
			calls.push([command, ...args]);
			return { stdout: '{"result":{"agent":{"agent_status":"working"}}}', exitCode: 0 };
		}, "/tmp");
		expect(calls).toEqual([["herdr", "agent", "get", "default:p1"]]);
		expect(states.get("alpha")).toBe("working");
		expect(states.has("beta")).toBe(false);
	});
});
