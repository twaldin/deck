import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pendingWakes } from "../src/wake";

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
		const queue = JSON.stringify(pendingWakes());
		for (const key of ["max-adversarial", "reviewer-silent", "main-red", "migration-gate", "broker-no-quota"]) expect(queue).toContain(key);
	});

	test("publishes a needs-decision condition", async () => {
		const { produceWakeConditions } = await import("../src/wake-producers");
		produceWakeConditions({ taskId: "ticket", needsDecision: "Choose the safe path" });
		const queue = JSON.stringify(pendingWakes());
		expect(queue).toContain("needs-decision");
	});

	test("REGRESSION: dry-run publisher records intent without creating a real wake", async () => {
		const { publishWakeProducer, wakeProducerIntents } = await import("../src/wake-producers");
		const workspace = path.join(root, "state", "smithers");
		publishWakeProducer({ dryRun: true, workspace, snapshot: { taskId: "fixture-call-site", needsDecision: "fixture refusal" } });
		expect(wakeProducerIntents(workspace)).toEqual([
			expect.objectContaining({ snapshot: { taskId: "fixture-call-site", needsDecision: "fixture refusal" } }),
		]);
		expect(pendingWakes()).toHaveLength(0);
		expect(fs.existsSync(path.join(workspace, "wake-producers.json"))).toBe(false);
	});

	test("REGRESSION: a test fixture cannot publish a real wake", async () => {
		const { publishWakeProducer } = await import("../src/wake-producers");
		const workspace = path.join(root, "state", "smithers");
		expect(() => publishWakeProducer({ dryRun: false, workspace, snapshot: { taskId: "fixture-call-site", ciFail: true } })).toThrow("refusing real wake publication from a test runner");
		expect(pendingWakes()).toHaveLength(0);
		expect(fs.existsSync(path.join(workspace, "wake-producers.json"))).toBe(false);
	});

	test("REGRESSION: an inactive publish retracts a condition so it can wake again", async () => {
		const { publishWakeProducer } = await import("../src/wake-producers");
		const workspace = path.join(root, "state", "smithers");
		const savedNodeEnv = process.env.NODE_ENV;
		delete process.env.NODE_ENV;
		try {
			publishWakeProducer({ dryRun: false, workspace, snapshot: { taskId: "recurring", ciFail: true } });
			publishWakeProducer({ dryRun: false, workspace, snapshot: { taskId: "recurring", ciFail: false } });
			publishWakeProducer({ dryRun: false, workspace, snapshot: { taskId: "recurring", ciFail: true } });
		} finally {
			if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = savedNodeEnv;
		}
		const events = pendingWakes();
		expect(events.filter((event) => event.verb === "ci-fail")).toHaveLength(2);
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
