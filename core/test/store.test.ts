import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DeckErrorCode } from "../src/errors";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "deck-core-store-"));
process.env.DECK_HOME = testHome;
// Layout constants read DECK_HOME at module load; this intentionally tests that boundary.
const deck = await import("../src/index");

const charter = {
	goal: "Ship the substrate safely",
	acceptance_criteria: ["All durable state survives restart"],
	constraints: ["No real home writes"],
};

beforeEach(() => {
	fs.rmSync(testHome, { recursive: true, force: true });
	fs.mkdirSync(testHome, { recursive: true, mode: 0o700 });
});

afterAll(() => {
	fs.rmSync(testHome, { recursive: true, force: true });
});

describe("EffortStore", () => {
	test("rejects stale manifest revisions with E_CAS", () => {
		const store = deck.createEffort({ effort_id: "test--cas", project: "test", title: "CAS", charter });
		const original = store.readManifest();
		store.mutate(original.revision, null, (manifest) => {
			manifest.stage = "active";
			return {
				manifest,
				event: { plane: "lifecycle", type: "lifecycle.stage", actor: "router", data: { stage: "active" } },
			};
		});

		expectDeckCode(() => store.mutate(original.revision, null, (manifest) => ({
			manifest,
			event: { plane: "lifecycle", type: "lifecycle.stale", actor: "router", data: {} },
		})), "E_CAS");
		expect(store.readManifest().revision).toBe(1);
	});

	test("fences an old owner lease token", () => {
		const store = deck.createEffort({ effort_id: "test--lease", project: "test", title: "Lease", charter });
		const first = store.bumpLease(store.readManifest().revision, {
			machine: "m1",
			session_id: "s1",
			last_heartbeat: 10,
		});
		const second = store.bumpLease(store.readManifest().revision, {
			machine: "m1",
			session_id: "s2",
			last_heartbeat: 20,
		});
		const revision = store.readManifest().revision;

		expect(first.epoch).toBe(1);
		expect(second.epoch).toBe(2);
		expect(store.verifyLease(first.token)).toBe(false);
		expect(store.verifyLease(second.token)).toBe(true);
		expectDeckCode(() => store.mutate(revision, first.token, (manifest) => ({
			manifest,
			event: { plane: "lifecycle", type: "lifecycle.stale", actor: "owner", data: {} },
		})), "E_LEASE");
		expectDeckCode(() => store.appendEvent({
			plane: "lifecycle",
			type: "lifecycle.stale_append",
			actor: "owner",
			data: {},
		}, first.token), "E_LEASE");

		const next = store.mutate(revision, second.token, (manifest) => {
			manifest.stage = "active";
			return {
				manifest,
				event: { plane: "lifecycle", type: "lifecycle.stage", actor: "owner", data: { stage: "active" } },
			};
		});
		expect(next.revision).toBe(revision + 1);
	});

	test("reserves and binds a lease without changing its token or epoch", () => {
		const store = deck.createEffort({ effort_id: "test--lease-bind", project: "test", title: "Bind", charter });
		const reserved = store.reserveLease(store.readManifest().revision);
		expect(reserved.holder).toBeNull();
		expect(store.readManifest().session).toBeNull();

		const bound = store.bindLeaseSession(store.readManifest().revision, reserved.token, {
			machine: "m1",
			session_id: "real-session",
			last_heartbeat: 50,
		});
		expect(bound.token).toBe(reserved.token);
		expect(bound.epoch).toBe(reserved.epoch);
		expect(bound.holder?.session_id).toBe("real-session");
		expect(store.readManifest().session?.lease_epoch).toBe(reserved.epoch);
	});

	test("requires deploy evidence and a fallout verdict before done", () => {
		const store = deck.createEffort({ effort_id: "test--done", project: "test", title: "Done", charter });
		const attemptDone = () => store.mutate(store.readManifest().revision, null, (manifest) => {
			manifest.stage = "done";
			return {
				manifest,
				event: { plane: "lifecycle", type: "lifecycle.stage", actor: "router", data: { stage: "done" } },
			};
		});

		expectDeckCode(attemptDone, "E_EVIDENCE");
		store.mutate(store.readManifest().revision, null, (manifest) => {
			manifest.evidence.push({
				ts: 100,
				label: "production deploy",
				ref: "deploy:100",
				by: "watch",
				scope: "deploy",
			});
			return {
				manifest,
				event: { plane: "fact", type: "fact.deploy", actor: "router", data: { deploy: "100" } },
			};
		});
		expectDeckCode(attemptDone, "E_EVIDENCE");
		store.appendEvent({
			plane: "judgment",
			type: "judgment.fallout_verdict",
			actor: "owner",
			data: { verdict: "healthy" },
		});
		expect(attemptDone().stage).toBe("done");
		expectDeckCode(() => store.mutate(store.readManifest().revision, null, (manifest) => {
			manifest.evidence = [];
			return {
				manifest,
				event: { plane: "lifecycle", type: "lifecycle.invalid_done", actor: "router", data: {} },
			};
		}), "E_EVIDENCE");
	});

	test("recovers an abandoned malformed O_EXCL lockfile", () => {
		const store = deck.createEffort({ effort_id: "test--stale-lock", project: "test", title: "Lock", charter });
		fs.writeFileSync(store.lockPath, "partial", { mode: 0o600 });
		const stale = new Date(Date.now() - 121_000);
		fs.utimesSync(store.lockPath, stale, stale);
		const next = store.mutate(store.readManifest().revision, null, (manifest) => ({
			manifest,
			event: { plane: "lifecycle", type: "lifecycle.after_stale_lock", actor: "router", data: {} },
		}));
		expect(next.revision).toBe(1);
	});

	test("ignores an unrenamed manifest.tmp crash window", () => {
		const store = deck.createEffort({ effort_id: "test--tmp", project: "test", title: "Tmp", charter });
		const oldManifest = store.readManifest();
		fs.writeFileSync(`${store.manifestPath}.tmp`, JSON.stringify({ ...oldManifest, revision: 999, stage: "done" }));

		const reopened = deck.openEffort(store.effortId);
		expect(reopened.readManifest()).toEqual(oldManifest);
	});

	test("quarantines a malformed trailing tail line and remains appendable", () => {
		const store = deck.createEffort({ effort_id: "test--tail", project: "test", title: "Tail", charter });
		fs.appendFileSync(store.tailPath, "{\"id\":\"partial");
		const reopened = deck.openEffort(store.effortId);
		const quarantined = fs.readFileSync(path.join(store.directory, deck.EFFORT_FILES.tailBad), "utf8");
		expect(quarantined).toContain("{\"id\":\"partial");

		const appended = reopened.appendEvent({
			plane: "fact",
			type: "fact.after_recovery",
			actor: "router",
			data: { ok: true },
		});
		expect(deck.openEffort(store.effortId).readTail()[0]?.id).toBe(appended.id);
	});

	test("terminates a valid final record before the next append", () => {
		const store = deck.createEffort({ effort_id: "test--unterminated", project: "test", title: "Tail", charter });
		const tail = fs.readFileSync(store.tailPath, "utf8");
		fs.writeFileSync(store.tailPath, tail.slice(0, -1));
		const reopened = deck.openEffort(store.effortId);
		reopened.appendEvent({ plane: "fact", type: "fact.next", actor: "router", data: {} });
		expect(reopened.readTail()).toHaveLength(2);
	});

	test("deduplicates a retried fact at the durable tail boundary", () => {
		const store = deck.createEffort({ effort_id: "test--idem", project: "test", title: "Idem", charter });
		const input = {
			plane: "fact" as const,
			type: "fact.ci",
			actor: "router:gh",
			data: { state: "green" },
			idem: { source: "gh", external_id: "check:1", version: "v1" },
		};
		const first = store.appendEvent(input);
		const retried = store.appendEvent(input);
		expect(retried.id).toBe(first.id);
		expect(store.readTail().filter((event) => event.type === "fact.ci")).toHaveLength(1);
	});

	test("lists only complete effort directories in stable order", () => {
		deck.createEffort({ effort_id: "test--zeta", project: "test", title: "Zeta", charter });
		deck.createEffort({ effort_id: "test--alpha", project: "test", title: "Alpha", charter });
		fs.mkdirSync(path.join(deck.EFFORTS_DIR, ".creating-crashed"));
		expect(deck.listEfforts().map((store) => store.effortId)).toEqual(["test--alpha", "test--zeta"]);
	});

	test("folds durable inbox receipts and dedupes redelivery across reopen", () => {
		const store = deck.createEffort({ effort_id: "test--inbox", project: "test", title: "Inbox", charter });
		const lease = store.bumpLease(
			store.readManifest().revision,
			{ machine: "m1", session_id: "owner", last_heartbeat: 1 },
		);
		const command = store.inboxAppend({
			cmd_id: "cmd-1",
			cmd: { type: "tim.message", body: "please check" },
			from: "tim",
			ts: 10,
		});
		expect(command.delivered).toBeNull();
		store.inboxMarkDelivered(command.cmd_id);

		fs.appendFileSync(store.inboxPath, "{\"cmd_id\":\"partial");
		const afterCrash = deck.openEffort(store.effortId);
		const replacementLease = afterCrash.bumpLease(
			afterCrash.readManifest().revision,
			{ machine: "m1", session_id: "owner-2", last_heartbeat: 2 },
		);
		expectDeckCode(() => afterCrash.inboxAck(command.cmd_id, lease.token), "E_LEASE");
		afterCrash.inboxAck(command.cmd_id, replacementLease.token);
		const finalState = deck.openEffort(store.effortId).inboxState();
		expect(finalState).toHaveLength(1);
		expect(finalState[0]?.delivered).not.toBeNull();
		expect(finalState[0]?.acked).not.toBeNull();

		afterCrash.inboxAppend({ cmd_id: "cmd-1", cmd: { duplicate: true }, from: "tim", ts: 99 });
		const lines = fs.readFileSync(store.inboxPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(3);
		expect(deck.openEffort(store.effortId).inboxState()[0]?.cmd).toEqual({
			type: "tim.message",
			body: "please check",
		});
	});
});

describe("intake durability", () => {
	test("deduplicates and evicts seen keys by cap and age", () => {
		let now = 1_000;
		const ring = new deck.SeenRing("gh", { capacity: 3, maxAgeMs: 100, fsyncBatchSize: 2, now: () => now });
		const firstKey = { source: "gh", external_id: "pr:1", version: "1" };
		ring.add(firstKey);
		ring.add(firstKey);
		expect(fs.readFileSync(ring.file, "utf8").trim().split("\n")).toHaveLength(1);
		for (let version = 2; version <= 4; version += 1) {
			ring.add({ source: "gh", external_id: `pr:${version}`, version: String(version) });
		}
		expect(ring.has({ source: "gh", external_id: "pr:1", version: "1" })).toBe(false);
		expect(ring.has({ source: "gh", external_id: "pr:4", version: "4" })).toBe(true);

		const reopened = new deck.SeenRing("gh", { capacity: 3, maxAgeMs: 100, now: () => now });
		expect(reopened.has({ source: "gh", external_id: "pr:4", version: "4" })).toBe(true);
		now = 1_101;
		expect(reopened.has({ source: "gh", external_id: "pr:4", version: "4" })).toBe(false);
	});

	test("persists typed cursors", () => {
		expect(deck.readCursors()).toEqual({});
		deck.writeCursor("gh", { page: 2, after: "abc" });
		deck.writeCursor("linear", "cursor-7");
		expect(deck.readCursors()).toEqual({ gh: { page: 2, after: "abc" }, linear: "cursor-7" });
	});
});

describe("buildSeed", () => {
	test("respects budget and mandatory priority order", () => {
		const store = deck.createEffort({ effort_id: "test--seed", project: "test", title: "Seed", charter });
		const resultEvent = store.appendEvent({
			plane: "lifecycle",
			type: "lifecycle.dispatch_result",
			actor: "wf:test",
			data: { dispatch_id: "test--seed/run", result: "passed" },
		});
		store.mutate(store.readManifest().revision, null, (manifest) => {
			manifest.cards.push({
				id: "card-1",
				card: {
					kind: "decision",
					question: "Proceed?",
					recommendation: "Proceed",
					options: ["yes", "no"],
				},
				status: "open",
				answer: null,
				answered_ts: null,
				cancel_in_flight: null,
			});
			manifest.dispatches.push({
				id: "test--seed/run",
				kind: "workflow",
				target: "test@v1",
				state: "running",
				started: 20,
				session: null,
				result_ref: `tail:${resultEvent.id}`,
			});
			manifest.digest = "Short park digest";
			return {
				manifest,
				event: { plane: "lifecycle", type: "lifecycle.setup", actor: "router", data: {} },
			};
		});
		const oldRecent = store.appendEvent({ plane: "fact", type: "fact.old", actor: "router", data: { n: 1 } });
		const decision = store.appendEvent({ plane: "tim", type: "tim.decision", actor: "tim", data: { answer: "yes" } });
		const huge = store.appendEvent({
			plane: "fact",
			type: "fact.huge",
			actor: "router",
			data: { body: "x".repeat(5_000) },
		});
		const triggeringEvent = deck.eventSchema.parse({
			id: deck.ulid(),
			ts: new Date().toISOString(),
			plane: "fact",
			type: "fact.trigger",
			actor: "router",
			data: { trigger: true },
		});

		const seed = deck.buildSeed(store.effortId, { triggeringEvent, tokenBudget: 800 });
		expect(seed.budgetUsed).toBeLessThanOrEqual(800);
		expect(seed.text.indexOf("[charter]")).toBeLessThan(seed.text.indexOf("[open_cards]"));
		expect(seed.text.indexOf("[open_cards]")).toBeLessThan(seed.text.indexOf("[active_dispatches]"));
		expect(seed.text.indexOf("[active_dispatches]")).toBeLessThan(seed.text.indexOf("[triggering_event]"));
		expect(seed.text.indexOf("[triggering_event]")).toBeLessThan(seed.text.indexOf("[digest]"));
		expect(seed.text.indexOf("[digest]")).toBeLessThan(seed.text.indexOf("[tim_decisions]"));
		expect(seed.text.indexOf("[tim_decisions]")).toBeLessThan(seed.text.indexOf("[recent_tail_newest_first]"));
		expect(seed.includedEventIds).toContain(resultEvent.id);
		expect(seed.includedEventIds).toContain(triggeringEvent.id);
		expect(seed.includedEventIds).toContain(decision.id);
		expect(seed.includedEventIds).toContain(huge.id);
		expect(seed.includedEventIds).toContain(oldRecent.id);
		expect(seed.text).toContain(`\"id\":\"${huge.id}\"`);
		expect(seed.text).toContain("\"truncated\":true");
		expectDeckCode(() => deck.buildSeed(store.effortId, { triggeringEvent, tokenBudget: 1 }), "E_ARG");
	});
});

function expectDeckCode(operation: () => unknown, code: DeckErrorCode): void {
	try {
		operation();
		throw new Error(`expected ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(deck.DeckError);
		if (error instanceof deck.DeckError) {
			expect(error.code).toBe(code);
		}
	}
}

describe("answerCard (D-A composite)", () => {
	test("inbox-first write order, projection flip, idempotent re-answer", () => {
		const store = deck.createEffort({ effort_id: "test--answercard", project: "test", title: "AC", charter });
		const manifest = store.readManifest();
		store.mutate(manifest.revision, null, current => ({
			manifest: {
				...current,
				cards: [
					{
						id: "01CARD",
						card: { kind: "decision", question: "Q?", recommendation: "R", options: ["a", "b"] },
						status: "open",
						answer: null,
						answered_ts: null,
						cancel_in_flight: null,
					},
				],
				overlays: { ...current.overlays, needs_tim: ["01CARD"] },
			},
			event: { plane: "lifecycle", type: "lifecycle.card", actor: "owner", data: { card_id: "01CARD" } },
		}));

		const after = store.answerCard("01CARD", "a");
		expect(after.cards[0]?.status).toBe("answered");
		expect(after.decisions.at(-1)?.answer).toBe("a");
		expect(after.overlays.needs_tim).toEqual([]);
		const commands = store.inboxState();
		const cmd = commands.find(entry => entry.cmd_id === "card-answer:01CARD");
		expect(cmd).toBeDefined();
		expect(cmd?.from).toBe("tim");

		// Idempotent re-answer (crash recovery path): same answer, no new command.
		const again = store.answerCard("01CARD", "a");
		expect(again.revision).toBe(after.revision);
		expect(store.inboxState().filter(entry => entry.cmd_id === "card-answer:01CARD").length).toBe(1);

		// Conflicting re-answer rejected.
		expect(() => store.answerCard("01CARD", "b")).toThrow(/E_STATE/);
	});
});
