import { describe, expect, test } from "bun:test";
import { formatSessionText } from "../src/tail";

describe("session tail formatter", () => {
	test("renders compact turns, tool calls, and errors without JSON", () => {
		const raw = [
			JSON.stringify({ type: "session", version: 3 }),
			JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "I will inspect the repo" }, { type: "toolCall", name: "bash", arguments: { command: "git status --short" } }] } }),
			JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:02Z", message: { role: "tool", content: [{ type: "toolResult", isError: true, content: "permission denied" }] } }),
		].join("\n");
		expect(formatSessionText(raw).join("\n")).toBe([
			"── turn 1 assistant ──",
			"assistant: I will inspect the repo",
			"bash: git status --short",
			"!! ERROR: permission denied",
		].join("\n"));
	});

	test("increments turn boundaries for each assistant message", () => {
		const raw = [
			JSON.stringify({ type: "message", message: { role: "assistant", content: "first" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: "second" } }),
		].join("\n");
		expect(formatSessionText(raw).filter((line) => line.includes("turn"))).toEqual([
			"── turn 1 assistant ──",
			"── turn 2 assistant ──",
		]);
	});
});
