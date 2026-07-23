import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import {
	charterSchema,
	eventSchema,
	inboxCommandSchema,
	manifestSchema,
	type Manifest,
} from "@deck/core";
import { renderAccounts, renderBoard, renderEffort, sortBoardEfforts } from "../src/render";
import { brokerStatusSchema, usageRosterSchema } from "../src/types";

const NOW = 1_784_721_660_000;

async function loadManifest(name: string): Promise<Manifest> {
	const text = await Bun.file(path.join(import.meta.dir, "fixtures", name)).text();
	return manifestSchema.parse(JSON.parse(text));
}

const needsTim = await loadManifest("needs-tim.json");
const active = await loadManifest("active.json");

describe("board renderer", () => {
	test("sorts needs_tim first, then stage, then newest updated", () => {
		const olderActive = manifestSchema.parse({
			...active,
			effort_id: "deck--older",
			updated: "2026-07-22T10:00:00.000Z",
		});
		const ordered = sortBoardEfforts([olderActive, active, needsTim]);
		expect(ordered.map(effort => effort.effort_id)).toEqual(["deck--tui", "deck--broker", "deck--older"]);
	});

	test("renders overlays, open-card count, heartbeat age, and selection", () => {
		const lines = renderBoard({ efforts: [active, needsTim], issues: [] }, 0, NOW);
		const selected = lines.find(line => line.startsWith(">"));
		expect(selected).toContain("deck--tui");
		expect(selected).toContain("[needs_tim:1]");
		expect(selected).toContain("[blocked]");
		expect(selected).toContain("STALE 1m");
		expect(selected).toMatch(/\s1\s+STALE/);
	});

	test("uses the configured heartbeat interval and keeps selection in a bounded viewport", () => {
		const efforts = Array.from({ length: 10 }, (_, index) =>
			manifestSchema.parse({
				...active,
				effort_id: `deck--effort-${index}`,
				updated: new Date(NOW - index * 1_000).toISOString(),
			}),
		);
		const ordered = sortBoardEfforts(efforts);
		const selectedId = ordered[8]?.effort_id;
		const lines = renderBoard({ efforts, issues: [] }, 8, NOW, 60_000, 8, 80);
		expect(lines.find(line => line.startsWith(">"))).toContain(selectedId);
		expect(lines.join("\n")).toContain("Showing 7-10 of 10 efforts.");
		expect(lines.every(line => line.length <= 80)).toBeTrue();
		expect(lines[2]).toContain("stage");
		expect(lines[2]).toContain("effort");
		expect(lines[2]).toContain("title");
		expect(lines[2]).toContain("flags");
		expect(lines[2]).toContain("heartbeat");
		expect(lines[2]).toContain("updated");

		const configuredHeartbeat = renderBoard({ efforts: [needsTim], issues: [] }, 0, NOW, 60_000);
		expect(configuredHeartbeat.find(line => line.startsWith(">"))).toContain("live 1m");
	});

	test("removes terminal control bytes from state text", () => {
		const hostile = manifestSchema.parse({
			...active,
			title: "safe\u001b[2J\nforged",
		});
		const output = renderBoard({ efforts: [hostile], issues: [] }, 0, NOW).join("\n");
		expect(output).not.toContain("\u001b");
		expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
	});
});

describe("effort renderer", () => {
	test("renders full cards, dispatches, recent events, and D-A receipts", () => {
		const charter = charterSchema.parse({
			goal: "Ship a minimal keyboard-driven TUI.",
			acceptance_criteria: ["Board renders"],
			constraints: ["No framework"],
			created: "2026-07-22T09:00:00.000Z",
			charter_changes: [],
		});
		const event = eventSchema.parse({
			id: "event-1",
			ts: "2026-07-22T12:01:00.000Z",
			plane: "judgment",
			type: "judgment.assessment",
			actor: "owner",
			data: { summary: "Renderer is ready for review." },
		});
		const command = inboxCommandSchema.parse({
			cmd_id: "cmd-1",
			cmd: { type: "tim.message", body: "Please tighten the card layout." },
			from: "tim",
			ts: NOW - 5_000,
			delivered: NOW - 4_000,
			acked: NOW - 3_000,
		});
		const lines = renderEffort(
			{
				effortId: needsTim.effort_id,
				manifest: needsTim,
				charter,
				events: [event],
				inbox: [command],
				issues: [],
			},
			0,
			NOW,
		);
		const output = lines.join("\n");
		expect(output).toContain("goal: Ship a minimal keyboard-driven TUI.");
		expect(output).toContain("question: Which terminal stack should Deck use?");
		expect(output).toContain("recommendation: Use raw ANSI and a small key loop.");
		expect(output).toContain("1. Raw ANSI");
		expect(output).toContain("running");
		expect(output).toContain("judgment.assessment");
		expect(output).toContain("Renderer is ready for review.");
		expect(output).toContain("delivered=2026-");
		expect(output).toContain("acked=2026-");
		expect(output).toContain("Please tighten the card layout.");
	});
});

describe("accounts renderer", () => {
	test("renders control status, cooling blocks, and every usage window", () => {
		const usage = usageRosterSchema.parse({
			generatedAt: "2026-07-22T12:00:00.000Z",
			reports: [
				{
					provider: "anthropic",
					fetchedAt: NOW,
					metadata: { email: "tim@example.com" },
					limits: [
						{
							id: "anthropic:5h",
							label: "Claude 5 Hour",
							scope: { provider: "anthropic", windowId: "5h", shared: true },
							window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: NOW + 60_000 },
							amount: { used: 8, limit: 100, remaining: 92, usedFraction: 0.08, remainingFraction: 0.92, unit: "percent" },
							status: "ok",
						},
					],
				},
			],
		});
		const broker = brokerStatusSchema.parse({
			version: "deck-broker/0.1.0",
			pid: 123,
			uptimeMs: 90_000,
			gateway: "http://127.0.0.1:8377",
			accounts: [
				{
					id: 7,
					provider: "anthropic",
					type: "oauth",
					email: "tim@example.com",
					accountId: "account-1",
					orgName: null,
					expires: NOW + 3_600_000,
					blocks: [{ providerKey: "anthropic", blockScope: "5h", blockedUntilMs: NOW + 120_000 }],
				},
			],
		});
		const output = renderAccounts({ usage, broker, issues: [] }, NOW).join("\n");
		expect(output).toContain("deck-broker/0.1.0");
		expect(output).toContain("cooling: anthropic/5h");
		expect(output).toContain("2m remaining");
		expect(output).toContain("anthropic / tim@example.com");
		expect(output).toContain("Claude 5 Hour: 8/100 percent (8% used)");
	});
});
