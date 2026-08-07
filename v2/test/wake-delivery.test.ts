import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { wakeFiles } from "../src/home";
import { appendStatus } from "../src/events";
import * as wake from "../src/wake";

let home: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-wake-delivery-"));
	process.env.DECK_V2_HOME = home;
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
});


function childScript(source: string): string {
	const file = path.join(home, `wake-child-${randomUUID()}.mjs`);
	fs.writeFileSync(file, source);
	return file;
}

async function waitForChildren(children: Bun.Subprocess[]): Promise<void> {
	const exits = await Promise.all(children.map((child) => child.exited));
	for (let index = 0; index < children.length; index += 1) {
		// `stderr` is typed as a number (fd) when not piped, so narrow before
		// reading it rather than asserting: a child spawned without a pipe would
		// otherwise fail here instead of reporting its real exit status.
		const handle = children[index]!.stderr;
		const stderr = handle instanceof ReadableStream ? await new Response(handle).text() : "";
		expect(exits[index], stderr).toBe(0);
	}
}

// The generated child is a separate module-loading boundary, so its absolute
// source path is selected at runtime rather than through this test's imports.
function enqueueSource(body: string): string {
	return `
		process.env.DECK_V2_HOME = ${JSON.stringify(home)};
		const fs = await import("node:fs");
		const { enqueueWakeConditions, enqueueWakeOnce, clearWakeConditions, reconcile, ackWakes, markInFlight } = await import(${JSON.stringify(path.join(import.meta.dir, "..", "src", "wake.ts"))});
		${body}
	`;
}

describe("one-file wake delivery", () => {
	test("REGRESSION: enqueue during an ack of a different id loses nothing", async () => {
		wake.enqueueWakeConditions([
			{ key: "agent-requested", taskId: "acked", note: "remove me" },
			{ key: "agent-requested", taskId: "survivor", note: "keep me" },
		]);
		const ackedId = wake.pendingWakes().find((entry) => entry.taskId === "acked")!.id;
		const barrier = path.join(home, "ack-enqueue-barrier");
		fs.writeFileSync(barrier, "");
		const script = childScript(
			enqueueSource(`
				fs.appendFileSync(${JSON.stringify(barrier)}, "x");
				while (fs.readFileSync(${JSON.stringify(barrier)}, "utf8").length < 2) {}
				if (process.argv[2] === "enqueue") {
					for (let index = 0; index < 200; index += 1) {
						enqueueWakeConditions([{ key: "agent-requested", taskId: "concurrent", note: "wake " + index }]);
					}
				} else {
					for (let index = 0; index < 200; index += 1) ackWakes([${JSON.stringify(ackedId)}]);
				}
			`),
		);
		const children = ["enqueue", "ack"].map((mode) =>
			Bun.spawn(["bun", script, mode], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" }),
		);
		await waitForChildren(children);

		const owed = wake.pendingWakes();
		expect(owed.some((entry) => entry.id === ackedId)).toBe(false);
		expect(owed.filter((entry) => entry.taskId === "concurrent")).toHaveLength(200);
		expect(owed.some((entry) => entry.taskId === "survivor")).toBe(true);
	});

	test("producer processes with independent counters cannot collide", async () => {
		const contenders = 24;
		const barrier = path.join(home, "producer-barrier");
		fs.writeFileSync(barrier, "");
		const script = childScript(
			enqueueSource(`
				Date.now = () => 1_800_000_000_000;
				fs.appendFileSync(${JSON.stringify(barrier)}, "x");
				while (fs.readFileSync(${JSON.stringify(barrier)}, "utf8").length < ${contenders}) {}
				enqueueWakeConditions([{ key: "agent-requested", taskId: "same-task", note: "producer " + process.argv[2] }]);
			`),
		);
		const children = Array.from({ length: contenders }, (_, index) =>
			Bun.spawn(["bun", script, String(index)], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" }),
		);
		await waitForChildren(children);

		const ids = wake.pendingWakes().map((entry) => entry.id);
		expect(ids).toHaveLength(contenders);
		expect(new Set(ids).size).toBe(contenders);
	});

	test("concurrent baseline clear/enqueue sequences preserve every recurrence", async () => {
		const barrier = path.join(home, "baseline-mutation-barrier");
		fs.writeFileSync(barrier, "");
		const script = childScript(
			enqueueSource(`
				fs.appendFileSync(${JSON.stringify(barrier)}, "x");
				while (fs.readFileSync(${JSON.stringify(barrier)}, "utf8").length < 2) {}
				for (let index = 0; index < 40; index += 1) {
					clearWakeConditions("baseline-race", ["agent-requested"]);
					enqueueWakeConditions([{ key: "agent-requested", taskId: "baseline-race", note: "producer " + process.argv[2] }]);
				}
			`),
		);
		const children = ["a", "b"].map((producer) =>
			Bun.spawn(["bun", script, producer], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" }),
		);
		await waitForChildren(children);

		expect(wake.pendingWakes().filter((entry) => entry.taskId === "baseline-race")).toHaveLength(80);
		const baseline = JSON.parse(fs.readFileSync(wakeFiles().baseline, "utf8")) as Record<string, { lastRaw?: string }>;
		expect(baseline["baseline-race:agent-requested"]?.lastRaw).toMatch(/^agent-requested:producer [ab]$/);
	});

	test("reconcile cannot resurrect a cleared one-shot registration baseline", async () => {
		wake.enqueueWakeConditions([{ key: "agent-requested", taskId: "registration-race", note: "old registration" }]);
		wake.ackWakes(wake.pendingWakes().map((entry) => entry.id));
		appendStatus("registration-race", "working", "observer update");
		const barrier = path.join(home, "reconcile-clear-barrier");
		fs.writeFileSync(barrier, "");
		const script = childScript(
			enqueueSource(`
				fs.appendFileSync(${JSON.stringify(barrier)}, "x");
				while (fs.readFileSync(${JSON.stringify(barrier)}, "utf8").length < 2) {}
				if (process.argv[2] === "reconcile") {
					reconcile(["registration-race"]);
				} else {
					clearWakeConditions("registration-race", ["agent-requested"]);
					enqueueWakeOnce("registration-race-1", { key: "agent-requested", taskId: "registration-race", note: "promoted registration" });
				}
			`),
		);
		const children = ["reconcile", "promote"].map((mode) =>
			Bun.spawn(["bun", script, mode], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" }),
		);
		await waitForChildren(children);

		const baseline = JSON.parse(fs.readFileSync(wakeFiles().baseline, "utf8")) as Record<string, unknown>;
		expect(baseline["registration-race:agent-requested"]).toBeUndefined();
		expect(wake.pendingWakes().filter((entry) => entry.id === "wake-once-registration-race-1")).toHaveLength(1);
	});

	test("a crash after enqueue but before cursor persistence cannot lose the wake", async () => {
		appendStatus("cursor-crash", "failed", "run exited unexpectedly");
		const script = childScript(`
			process.env.DECK_V2_HOME = ${JSON.stringify(home)};
			const { createRequire } = await import("node:module");
			const require = createRequire(import.meta.url);
			const nodeFs = require("node:fs");
			const renameSync = nodeFs.renameSync;
			nodeFs.renameSync = (source, target) => {
				if (String(target).endsWith(".wake-cursors.json")) process.exit(86);
				return renameSync(source, target);
			};
			const { reconcile } = await import(${JSON.stringify(path.join(import.meta.dir, "..", "src", "wake.ts"))});
			reconcile(["cursor-crash"]);
		`);
		const child = Bun.spawn(["bun", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited, stderr).toBe(86);
		expect(wake.pendingWakes().filter((entry) => entry.taskId === "cursor-crash")).toHaveLength(1);

		wake.reconcile(["cursor-crash"]);
		expect(wake.pendingWakes().filter((entry) => entry.taskId === "cursor-crash")).toHaveLength(1);
	});

	test("legacy JSONL migrates without losing colliding entries", async () => {
		const legacy = wakeFiles().queue;
		fs.mkdirSync(path.dirname(legacy), { recursive: true });
		const repeated = {
			id: "same-task:migration:0",
			taskId: "same-task",
			tier: "T0",
			raw: "blocked:same reason",
			note: "same reason",
			verb: "blocked",
		} as const;
		const distinct = {
			id: "other-task:migration:0",
			taskId: "other-task",
			tier: "T1",
			raw: "done:complete",
			note: "complete",
			verb: "done",
		} as const;
		fs.writeFileSync(legacy, `${JSON.stringify(repeated)}\n${JSON.stringify(repeated)}\n${JSON.stringify(distinct)}\n`);

		const migrated = wake.pendingWakes();
		expect(migrated).toHaveLength(3);
		expect(new Set(migrated.map((entry) => entry.id)).size).toBe(3);
		expect(migrated.filter((entry) => entry.note === "same reason")).toHaveLength(2);
		expect(fs.existsSync(legacy)).toBe(false);
		expect(wake.pendingWakes()).toHaveLength(3);
	});

	test("a corrupt legacy remnant cannot resurrect an acknowledged migrated wake", () => {
		const legacy = wakeFiles().queue;
		fs.mkdirSync(path.dirname(legacy), { recursive: true });
		const valid = {
			id: "legacy-task:migration:0",
			taskId: "legacy-task",
			tier: "T0",
			raw: "blocked:credential",
			note: "credential",
			verb: "blocked",
		} as const;
		fs.writeFileSync(legacy, `${JSON.stringify(valid)}\n{\"id\":\"torn\"`);

		const id = wake.pendingWakes()[0]!.id;
		expect(fs.readFileSync(`${legacy}.corrupt`, "utf8")).toContain('{\"id\":\"torn\"');
		expect(fs.existsSync(legacy)).toBe(false);
		wake.ackWakes([id]);
		expect(wake.pendingWakes()).toHaveLength(0);
	});

	test("never-delivered and expired in-flight wakes are due", async () => {
		wake.enqueueWakeConditions([{ key: "agent-requested", taskId: "timer", note: "check outcome", tier: "T1" }]);
		const entry = wake.pendingWakes()[0]!;
		expect(entry.tier).toBe("T1");
		expect(wake.dueWakes(1_000)).toEqual([entry]);

		wake.markInFlight([entry.id], 10_000);
		expect(wake.pendingWakes()[0]?.deliveredAt).toBe(10_000);
		expect(wake.dueWakes(129_999, 120_000)).toHaveLength(0);
		expect(wake.dueWakes(130_000, 120_000).map((due) => due.id)).toEqual([entry.id]);
	});

	test("agent, watcher, and terminal conditions receive their contracted default tiers", async () => {
		wake.enqueueWakeConditions([
			{ key: "agent-requested", taskId: "agent-default", note: "wake now" },
			{ key: "agent-requested", taskId: "agent-explicit", note: "wait for terminal", tier: "T1" },
			{ key: "watcher-stale", taskId: "watcher", note: "observer stopped" },
			{ key: "run-terminal", taskId: "terminal", note: "run exited" },
		]);
		const tiers = Object.fromEntries(wake.pendingWakes().map((entry) => [entry.taskId, entry.tier]));
		expect(tiers).toEqual({
			"agent-default": "T0",
			"agent-explicit": "T1",
			watcher: "T0",
			terminal: "T1",
		});
	});

	test("one-shot retries use first enqueue time rather than registration time", () => {
		const registrationId = `1-${process.pid.toString(36)}-${"a".repeat(24)}`;
		wake.enqueueWakeConditions([{ key: "agent-requested", taskId: "ordinary-first", note: "first" }]);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		wake.enqueueWakeOnce(registrationId, {
			key: "agent-requested",
			taskId: "one-shot-second",
			note: "second",
		});
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		wake.enqueueWakeConditions([{ key: "agent-requested", taskId: "ordinary-third", note: "third" }]);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		wake.enqueueWakeOnce(registrationId, {
			key: "agent-requested",
			taskId: "one-shot-second",
			note: "second",
		});
		expect(wake.pendingWakes().map((entry) => entry.taskId)).toEqual(["ordinary-first", "one-shot-second", "ordinary-third"]);
	});

	test("ack removes permanently and repeated ack is harmless", async () => {
		wake.enqueueWakeConditions([{ key: "watcher-stale", taskId: "observer", note: "no heartbeat" }]);
		const id = wake.pendingWakes()[0]!.id;
		wake.markInFlight([id], 1_000);
		wake.ackWakes([id]);
		wake.ackWakes([id]);
		wake.markInFlight([id], 2_000);
		expect(wake.pendingWakes()).toHaveLength(0);
		expect(wake.dueWakes(200_000)).toHaveLength(0);
	});

	test("a concurrent in-flight marker cannot resurrect an acknowledged wake", async () => {
		wake.enqueueWakeConditions([{ key: "agent-requested", taskId: "mark-ack-race", note: "deliver once" }]);
		const id = wake.pendingWakes()[0]!.id;
		const barrier = path.join(home, "mark-ack-barrier");
		fs.writeFileSync(barrier, "");
		const queueDir = `${wakeFiles().queue}.d`;
		fs.writeFileSync(path.join(queueDir, ".mutation.lock"), "99999999:dead-owner");
		const script = childScript(
			enqueueSource(`
				fs.appendFileSync(${JSON.stringify(barrier)}, "x");
				while (fs.readFileSync(${JSON.stringify(barrier)}, "utf8").length < 2) {}
				if (process.argv[2] === "mark") {
					for (let index = 0; index < 200; index += 1) markInFlight([${JSON.stringify(id)}], index);
				} else {
					for (let index = 0; index < 200; index += 1) ackWakes([${JSON.stringify(id)}]);
				}
			`),
		);
		const children = ["mark", "ack"].map((mode) =>
			Bun.spawn(["bun", script, mode], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" }),
		);
		await waitForChildren(children);
		expect(wake.pendingWakes()).toHaveLength(0);
	});

	test("an unreadable mutation lock fails loudly without deleting the wake", () => {
		wake.enqueueWakeConditions([{ key: "agent-requested", taskId: "locked", note: "still owed" }]);
		const entry = wake.pendingWakes()[0]!;
		const lock = path.join(`${wakeFiles().queue}.d`, ".mutation.lock");
		fs.mkdirSync(lock);
		const started = Date.now();
		expect(() => wake.ackWakes([entry.id])).toThrow(/cannot inspect wake outbox mutation lock/);
		expect(Date.now() - started).toBeLessThan(1_000);
		fs.rmSync(lock, { recursive: true });
		expect(wake.pendingWakes().map((owed) => owed.id)).toEqual([entry.id]);
	});

	test("policy suppression removes the wake and records why it was withheld", () => {
		wake.enqueueWakeConditions([{ key: "run-terminal", taskId: "no-terminal-wake", note: "run completed" }]);
		const id = wake.pendingWakes()[0]!.id;
		wake.suppressWakes([id], "project wakeOnTerminal is disabled");

		expect(wake.pendingWakes()).toHaveLength(0);
		expect(wake.dueWakes()).toHaveLength(0);
		expect(wake.pendingWakes()).toHaveLength(0);
		const log = path.join(path.dirname(wakeFiles().queue), ".wake-suppressed.jsonl");
		const record = JSON.parse(fs.readFileSync(log, "utf8")) as Record<string, unknown>;
		expect(record).toMatchObject({
			id,
			taskId: "no-terminal-wake",
			verb: "run-terminal",
			reason: "project wakeOnTerminal is disabled",
		});
		expect(typeof record.timestamp).toBe("number");
	});

	test("a crash between suppression evidence and unlink leaves an explainable owed wake", async () => {
		wake.enqueueWakeConditions([{ key: "run-terminal", taskId: "suppress-crash", note: "run completed" }]);
		const id = wake.pendingWakes()[0]!.id;
		const script = childScript(`
			process.env.DECK_V2_HOME = ${JSON.stringify(home)};
			const { createRequire } = await import("node:module");
			const require = createRequire(import.meta.url);
			const nodeFs = require("node:fs");
			const unlinkSync = nodeFs.unlinkSync;
			nodeFs.unlinkSync = (target) => {
				if (String(target).endsWith(${JSON.stringify(`${id}.json`)})) process.exit(87);
				return unlinkSync(target);
			};
			const { suppressWakes } = await import(${JSON.stringify(path.join(import.meta.dir, "..", "src", "wake.ts"))});
			suppressWakes([${JSON.stringify(id)}], "terminal wakes disabled");
		`);
		const child = Bun.spawn(["bun", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited, stderr).toBe(87);

		const log = path.join(path.dirname(wakeFiles().queue), ".wake-suppressed.jsonl");
		expect(fs.readFileSync(log, "utf8")).toContain("terminal wakes disabled");
		expect(wake.pendingWakes().map((entry) => entry.id)).toEqual([id]);
	});

	test("redelivery preserves the stable id until consumer acknowledgement", async () => {
		wake.enqueueWakeConditions([{ key: "agent-requested", taskId: "redelivery", note: "resume" }]);
		const id = wake.pendingWakes()[0]!.id;
		wake.markInFlight([id], 1_000);
		const first = wake.dueWakes(121_000);
		const replay = wake.dueWakes(121_000);
		expect(first.map((entry) => entry.id)).toEqual([id]);
		expect(replay.map((entry) => entry.id)).toEqual([id]);
		expect(wake.pendingWakes()).toHaveLength(1);
	});

	test("a corrupt per-wake file is skipped without poisoning valid entries", async () => {
		wake.enqueueWakeConditions([{ key: "agent-requested", taskId: "valid", note: "keep this" }]);
		const queueDir = `${wakeFiles().queue}.d`;
		fs.writeFileSync(path.join(queueDir, "corrupt.json"), '{"id":"corrupt"');

		expect(() => wake.pendingWakes()).not.toThrow();
		expect(wake.pendingWakes().map((entry) => entry.taskId)).toEqual(["valid"]);
	});
});
