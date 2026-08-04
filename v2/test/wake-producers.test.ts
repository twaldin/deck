import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let root: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-wake-producers-"));
	process.env.DECK_V2_HOME = root;
	fs.mkdirSync(path.join(root, "state"), { recursive: true });
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
});

describe("wake producers", () => {
	test("publishes every required condition to the durable outbox", async () => {
		const { produceWakeConditions } = await import("../src/wake-producers");
		produceWakeConditions({ taskId: "ticket", maxAdversarial: true, reviewerSilent: true, mainRed: true, migrationBlocked: true, brokerNoQuota: true });
		const queue = fs.readFileSync(path.join(root, "state", ".wake-queue.jsonl"), "utf8");
		for (const key of ["max-adversarial", "reviewer-silent", "main-red", "migration-gate", "broker-no-quota"]) expect(queue).toContain(key);
	});

	test("publishes a needs-decision condition", async () => {
		const { produceWakeConditions } = await import("../src/wake-producers");
		produceWakeConditions({ taskId: "ticket", needsDecision: "Choose the safe path" });
		const queue = fs.readFileSync(path.join(root, "state", ".wake-queue.jsonl"), "utf8");
		expect(queue).toContain("needs-decision");
	});

	test("releases a recovered incident so a later failure can claim it", async () => {
		const { claimMainFailure, releaseMainFailure } = await import("../src/wake-producers");
		const fingerprint = "repo:main";
		expect(claimMainFailure(root, fingerprint, "ticket-1")).toBe(true);
		releaseMainFailure(root, fingerprint);
		expect(claimMainFailure(root, fingerprint, "ticket-2")).toBe(true);
	});

	test("an abandoned claim expires", async () => {
		const { claimMainFailure } = await import("../src/wake-producers");
		const fingerprint = "repo:main";
		expect(claimMainFailure(root, fingerprint, "ticket-1")).toBe(true);
		const file = path.join(root, "main-failure.json");
		const claim = JSON.parse(fs.readFileSync(file, "utf8"));
		claim.claimedAt = Date.now() - 31 * 60_000;
		fs.writeFileSync(file, JSON.stringify(claim));
		expect(claimMainFailure(root, fingerprint, "ticket-2")).toBe(true);
	});
});
