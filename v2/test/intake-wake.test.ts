/**
 * Reconcile consumes the intake event log (written by deck-intake) with the
 * same cursor discipline as `.status` files. The assertions target the
 * acceptance criteria directly:
 *   - a new review request interrupts (T0)
 *   - a correlated event wakes its task as a batched T1
 *   - uncorrelated churn is recorded silently, never delivered
 *   - a second reconcile over the same log fires NOTHING (idempotent restarts)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let home: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-intake-"));
	process.env.DECK_V2_HOME = home;
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
});

async function mods() {
	return {
		wake: await import("../src/wake"),
		home: await import("../src/home"),
	};
}

function appendLines(file: string, lines: string[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${lines.join("\n")}\n`);
}

function event(overrides: Record<string, unknown>): string {
	return JSON.stringify({
		v: 1,
		ts: "2026-02-01T00:00:00Z",
		kind: "ci",
		url: "https://github.com/o/r/pull/7",
		taskId: null,
		signal: false,
		note: "ci passing->failing: t https://github.com/o/r/pull/7",
		...overrides,
	});
}

describe("intake event consumption", () => {
	test("review request interrupts; correlated event batches; churn is silent", async () => {
		const { wake, home: h } = await mods();
		appendLines(h.intakeFiles().events, [
			event({ kind: "new", signal: true, note: "new PR (review-owed): fix x https://x/1" }),
			event({ taskId: "t1", note: "ci passing->failing: mine https://x/2" }),
			event({ note: "ci pending->passing: other https://x/3" }),
		]);
		const result = wake.reconcile([]);
		expect(result.interrupt).toHaveLength(1);
		expect(result.interrupt[0]?.event.note).toContain("review-owed");
		expect(result.batched).toHaveLength(1);
		expect(result.batched[0]?.taskId).toBe("t1");
		expect(result.silent).toHaveLength(1);
		// Delivered tiers land in the durable outbox; silent never does.
		expect(wake.pendingWakes()).toHaveLength(2);
	});

	test("removed and review-decision events batch even uncorrelated", async () => {
		const { wake, home: h } = await mods();
		appendLines(h.intakeFiles().events, [
			event({ kind: "removed", note: "PR merged: x https://x/1" }),
			event({ kind: "review-decision", note: "review review-required->approved: x https://x/1" }),
		]);
		const result = wake.reconcile([]);
		expect(result.interrupt).toHaveLength(0);
		expect(result.batched).toHaveLength(2);
	});

	test("IDEMPOTENT: a second reconcile over the same log fires nothing", async () => {
		const { wake, home: h } = await mods();
		appendLines(h.intakeFiles().events, [
			event({ signal: true, url: "https://x/1", note: "new PR: a https://x/1" }),
			event({ taskId: "t1", url: "https://x/2", note: "ci passing->failing: b https://x/2" }),
		]);
		const first = wake.reconcile([]);
		expect(first.interrupt.length + first.batched.length).toBe(2);
		const second = wake.reconcile([]);
		expect(second.interrupt).toHaveLength(0);
		expect(second.batched).toHaveLength(0);
		expect(second.silent).toHaveLength(0);
	});

	test("only the tail appended after the cursor is consumed", async () => {
		const { wake, home: h } = await mods();
		appendLines(h.intakeFiles().events, [event({ taskId: "t1", note: "first" })]);
		wake.reconcile([]);
		appendLines(h.intakeFiles().events, [event({ taskId: "t1", note: "second" })]);
		const result = wake.reconcile([]);
		expect(result.batched).toHaveLength(1);
		expect(result.batched[0]?.event.note).toBe("second");
	});

	test("a torn/garbage line is reported malformed, not swallowed", async () => {
		const { wake, home: h } = await mods();
		appendLines(h.intakeFiles().events, ['{"v":1,"kind":"ci"', event({ taskId: "t1" })]);
		const result = wake.reconcile([]);
		expect(result.malformed).toHaveLength(1);
		expect(result.malformed[0]?.taskId).toBe(".intake");
		expect(result.batched).toHaveLength(1);
	});

	test("crash-window duplicate (same url+kind+note, re-appended) wakes once", async () => {
		const { wake, home: h } = await mods();
		// The poller crashed between the event append and its state-file write, so
		// the next poll re-emitted the same diff with a NEW timestamp.
		appendLines(h.intakeFiles().events, [event({ signal: true, ts: "2026-02-01T00:00:00Z" })]);
		wake.reconcile([]);
		appendLines(h.intakeFiles().events, [event({ signal: true, ts: "2026-02-01T00:02:00Z" })]);
		const second = wake.reconcile([]);
		expect(second.interrupt).toHaveLength(0);
		expect(second.silent).toHaveLength(1);
		// A REAL new transition on the same url+kind still wakes.
		appendLines(h.intakeFiles().events, [
			event({ taskId: "t1", note: "ci failing->passing: t https://x/7" }),
		]);
		const third = wake.reconcile([]);
		expect(third.batched).toHaveLength(1);
	});

	test("a legitimate RE-occurrence (intervening event) wakes again", async () => {
		const { wake, home: h } = await mods();
		const reviewRequest = {
			kind: "new",
			signal: true,
			note: "new PR (review-owed): fix x https://x/1",
			url: "https://x/1",
		};
		appendLines(h.intakeFiles().events, [event(reviewRequest)]);
		expect(wake.reconcile([]).interrupt).toHaveLength(1);
		// Review request withdrawn, then re-requested later: same url, same kind,
		// same note — but a real second ask, separated by the removal event.
		appendLines(h.intakeFiles().events, [
			event({ kind: "removed", url: "https://x/1", note: "PR descoped: fix x https://x/1" }),
		]);
		wake.reconcile([]);
		appendLines(h.intakeFiles().events, [event(reviewRequest)]);
		expect(wake.reconcile([]).interrupt).toHaveLength(1);
	});

	test("no intake log at all is a clean no-op", async () => {
		const { wake } = await mods();
		const result = wake.reconcile([]);
		expect(result.interrupt).toHaveLength(0);
		expect(result.batched).toHaveLength(0);
		expect(result.silent).toHaveLength(0);
	});
});
