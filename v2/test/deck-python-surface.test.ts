import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PYTHON_ROOT = path.join(import.meta.dir, "..", "python");
const DECK_CLI = path.join(import.meta.dir, "..", "bin", "deck-v2");

function freshHome(): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "deck-python-home-"));
	fs.mkdirSync(path.join(home, "state"), { recursive: true });
	return home;
}

function writeEffort(home: string, taskId: string, runId?: string, status = "working: in flight"): void {
	const state = path.join(home, "state");
	fs.writeFileSync(path.join(state, `${taskId}.meta`), `id=${taskId}\n${runId === undefined ? "" : `run_id=${runId}\n`}`);
	fs.writeFileSync(path.join(state, `${taskId}.status`), `${status}\n`);
}

function writeTerminalWakeProfile(home: string, runId: string): void {
	const profile = {
		id: "demo",
		repo: "example/demo",
		primary: "/tmp/demo",
		pipeline: "yolo-ship",
		yolo: true,
		stamp: false,
		wakeOnTerminal: true,
		knowledge: [],
		reviewPolicy: { requireHuman: false, requiredBots: [] },
		depsWarm: true,
	};
	const config = path.join(home, "config", "projects.json");
	fs.mkdirSync(path.dirname(config), { recursive: true });
	fs.writeFileSync(config, `${JSON.stringify([profile])}\n`);
	const input = path.join(home, "state", "ship", `${runId}.input.json`);
	fs.mkdirSync(path.dirname(input), { recursive: true });
	fs.writeFileSync(input, `${JSON.stringify({ profile: "demo" })}\n`);
}

function liveDeckEnv(home: string): Record<string, string> {
	return { DECK_CLI, DECK_V2_HOME: home };
}

function runPython(source: string, env: Record<string, string> = {}): { status: number; out: string } {
	const result = spawnSync("python3", ["-c", source], {
		env: { ...process.env, PYTHONPATH: PYTHON_ROOT, ...env },
		encoding: "utf8",
	});
	return { status: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

function drainHomeOnce(home: string): { status: number; out: string } {
	const result = spawnSync(DECK_CLI, ["wake-drain", "--once"], {
		env: { ...process.env, DECK_V2_HOME: home },
		encoding: "utf8",
		timeout: 10_000,
	});
	return { status: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

function wakeOutbox(home: string): Array<Record<string, unknown>> {
	const dir = path.join(home, "state", ".wake-queue.jsonl.d");
	try {
		return fs.readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Record<string, unknown>);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

describe("the deck code surface", () => {
	test("survives non-UTF-8 output from the CLI it shells to", () => {
		// A single Windows-1252 smart quote (byte 0x91) in tool output raised
		// UnicodeDecodeError from inside subprocess and killed four pipeline runs.
		// An encoding accident must never be reported as a Deck failure.
		const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deck-cli-")), "deck-v2");
		fs.writeFileSync(fake, "#!/bin/sh\nprintf '\\221{\"runs\": []}'\n");
		fs.chmodSync(fake, 0o755);

		const { status, out } = runPython(
			"import deck; print('called:', deck.runs() is not None or True)",
			{ DECK_CLI: fake },
		);
		expect(out).not.toContain("UnicodeDecodeError");
		expect(status).toBe(0);
	});

	test("a failing CLI raises DeckError carrying the reason, not a bare crash", () => {
		const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deck-cli-")), "deck-v2");
		fs.writeFileSync(fake, "#!/bin/sh\necho 'no Smithers workspace at /nope' >&2\nexit 1\n");
		fs.chmodSync(fake, 0o755);

		const { out } = runPython(
			"import deck\ntry:\n    deck.runs()\nexcept deck.DeckError as e:\n    print('DeckError:', e)",
			{ DECK_CLI: fake },
		);
		expect(out).toContain("DeckError: no Smithers workspace");
	});

	test("a missing session id fails loudly instead of misrouting an answer", () => {
		// Question ids are scoped to the asking session; a wrong id delivers the
		// user's answer to a different agent, so guessing is not an option.
		const { out } = runPython(
			"import deck\ntry:\n    deck.session_id()\nexcept deck.DeckError as e:\n    print('DeckError:', e)",
			{ RLM_SESSION_DIR: "" },
		);
		expect(out).toContain("RLM_SESSION_DIR is unset");
	});

	test("the kernel tolerates non-UTF-8 tool output without being asked to", () => {
		// The failure that killed four runs was NOT in deck: it was a seat's own
		// `subprocess.run(["rg", ...], text=True)` over a repo containing one
		// Windows-1252 byte. Seats write that shape constantly, so the kernel has to
		// be safe by default rather than every prompt remembering `errors=`.
		const probe = "import subprocess\n"
			+ "r = subprocess.run(['/bin/sh','-c',\"printf 'good\\\\221bad'\"], capture_output=True, text=True)\n"
			+ "print('survived:', r.stdout)";
		const withFix = runPython(probe);
		expect(withFix.out).not.toContain("UnicodeDecodeError");
		expect(withFix.status).toBe(0);

		// And an explicit errors= is still honoured, so nothing is silently masked.
		const explicit = runPython(
			"import subprocess\n"
			+ "try:\n"
			+ "    subprocess.run(['/bin/sh','-c',\"printf 'x\\\\221'\"], capture_output=True, text=True, errors='strict')\n"
			+ "except UnicodeDecodeError:\n"
			+ "    print('strict still raises')",
		);
		expect(explicit.out).toContain("strict still raises");
	});

	test("duration wake registers a durable per-effort condition", () => {
		const home = freshHome();
		writeEffort(home, "effort-one");
		const { status, out } = runPython(
			"import deck, json\nprint(json.dumps(deck.wake_me('30m', 'check the rollout', task='effort-one')))",
			liveDeckEnv(home),
		);
		expect(status).toBe(0);
		const registration = JSON.parse(out);
		expect(registration).toMatchObject({
			key: "agent-requested",
			when: "30m",
			note: "check the rollout",
			tier: "T0",
			taskId: "effort-one",
		});
		expect(Date.parse(registration.dueAt)).toBeGreaterThan(Date.now());

		const files = fs.readdirSync(path.join(home, "state", ".wake-conditions"));
		expect(files).toEqual([`${registration.id}.json`]);
		expect(JSON.parse(fs.readFileSync(path.join(home, "state", ".wake-conditions", files[0] as string), "utf8"))).toEqual(registration);
	});

	test("run terminal wake resolves and registers the owning effort", () => {
		const home = freshHome();
		writeEffort(home, "effort-two", "run-42");
		const { status, out } = runPython(
			"import deck, json\nprint(json.dumps(deck.wake_me('run:run-42:terminal', 'resume after landing', tier='T1')))",
			liveDeckEnv(home),
		);
		expect(status).toBe(0);
		expect(JSON.parse(out)).toMatchObject({
			key: "agent-requested",
			when: "run:run-42:terminal",
			note: "resume after landing",
			tier: "T1",
			runId: "run-42",
			taskId: "effort-two",
		});
	});

	test("due duration wake promotes with a stable id across crash-style retry", () => {
		const home = freshHome();
		const registered = runPython(
			"import deck, json\nprint(json.dumps(deck.wake_me('1ms', 'duration became due')))",
			liveDeckEnv(home),
		);
		expect(registered.status).toBe(0);
		const registration = JSON.parse(registered.out);
		const conditions = path.join(home, "state", ".wake-conditions");
		const registrationFile = path.join(conditions, `${registration.id}.json`);
		expect(fs.existsSync(registrationFile)).toBe(true);

		expect(drainHomeOnce(home).status).toBe(0);
		expect(fs.existsSync(registrationFile)).toBe(false);
		expect(wakeOutbox(home)).toEqual([
			expect.objectContaining({
				id: `wake-once-${registration.id}`,
				taskId: "orchestrator",
				verb: "agent-requested",
				note: "duration became due",
			}),
		]);

		// Simulate a crash after durable outbox write but before registration
		// removal. Stable promotion must not mint a second logical wake.
		fs.writeFileSync(registrationFile, `${JSON.stringify(registration)}\n`);
		expect(drainHomeOnce(home).status).toBe(0);
		expect(fs.existsSync(registrationFile)).toBe(false);
		expect(wakeOutbox(home)).toHaveLength(1);
		expect(wakeOutbox(home)[0]?.id).toBe(`wake-once-${registration.id}`);
	});

	test("concurrent drains preserve every same-note registration", async () => {
		const home = freshHome();
		const registered = runPython(
			"import deck\nfor _ in range(8):\n    deck.wake_me('1ms', 'same note')",
			liveDeckEnv(home),
		);
		expect(registered.status).toBe(0);
		const conditions = path.join(home, "state", ".wake-conditions");
		expect(fs.readdirSync(conditions).filter((name) => name.endsWith(".json"))).toHaveLength(8);

		const env = { ...process.env, DECK_V2_HOME: home };
		const first = Bun.spawn([DECK_CLI, "wake-drain", "--once"], { env, stdout: "pipe", stderr: "pipe" });
		const second = Bun.spawn([DECK_CLI, "wake-drain", "--once"], { env, stdout: "pipe", stderr: "pipe" });
		const [firstExit, secondExit] = await Promise.all([first.exited, second.exited]);
		expect([firstExit, secondExit]).toEqual([0, 0]);
		expect(fs.readdirSync(conditions).filter((name) => name.endsWith(".json"))).toHaveLength(0);
		const outbox = wakeOutbox(home);
		expect(outbox).toHaveLength(8);
		expect(new Set(outbox.map((entry) => entry.id)).size).toBe(8);
	});

	test("run terminal wake promotes only after that run's terminal ledger record", () => {
		const home = freshHome();
		writeEffort(home, "run-effort", "run-lifecycle");
		const registered = runPython(
			"import deck\ndeck.wake_me('run:run-lifecycle:terminal', 'run reached terminal')",
			liveDeckEnv(home),
		);
		expect(registered.status).toBe(0);
		const conditions = path.join(home, "state", ".wake-conditions");
		expect(drainHomeOnce(home).status).toBe(0);
		expect(fs.readdirSync(conditions).filter((name) => name.endsWith(".json"))).toHaveLength(1);
		expect(wakeOutbox(home)).toHaveLength(0);

		const ledger = path.join(home, "state", "run-effort.observed");
		fs.writeFileSync(ledger, `${JSON.stringify({ emitted: "corrupt" })}\n`);
		const corrupt = drainHomeOnce(home);
		expect(corrupt.status).toBe(1);
		expect(corrupt.out).toContain("emitted must be an array of strings");
		expect(fs.readdirSync(conditions).filter((name) => name.endsWith(".json"))).toHaveLength(1);
		expect(wakeOutbox(home)).toHaveLength(0);

		fs.writeFileSync(
			ledger,
			`${JSON.stringify({ emitted: ["run::run-lifecycle::succeeded:0"] })}\n`,
		);
		expect(drainHomeOnce(home).status).toBe(0);
		expect(fs.readdirSync(conditions).filter((name) => name.endsWith(".json"))).toHaveLength(0);
		expect(wakeOutbox(home)).toEqual([
			expect.objectContaining({
				taskId: "run-effort",
				verb: "agent-requested",
				note: "run reached terminal",
			}),
		]);
	});

	test("wake registration failure raises instead of returning soft success", () => {
		const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deck-cli-")), "deck-v2");
		fs.writeFileSync(fake, "#!/bin/sh\necho 'wake registry is read-only' >&2\nexit 1\n");
		fs.chmodSync(fake, 0o755);
		const { status, out } = runPython(
			"import deck\ntry:\n    deck.wake_me('30m', 'must survive')\nexcept deck.DeckError as e:\n    print('raised:', e)\nelse:\n    raise AssertionError('wake failure returned soft success')",
			{ DECK_CLI: fake },
		);
		expect(status).toBe(0);
		expect(out).toContain("raised: wake registry is read-only");
	});

	test("wake_ack removes a delivered id and repeated or unknown ids are no-ops", () => {
		const home = freshHome();
		const outbox = path.join(home, "state", ".wake-queue.jsonl.d");
		fs.mkdirSync(outbox, { recursive: true });
		const entry = {
			id: "wake-test",
			taskId: "effort-one",
			key: "agent-requested",
			tier: "T0",
			raw: "agent-requested:resume",
			note: "resume",
			verb: "agent-requested",
			deliveredAt: Date.now(),
		};
		fs.writeFileSync(path.join(outbox, "wake-test.json"), `${JSON.stringify(entry)}\n`);
		const { status, out } = runPython(
			"import deck, json\n"
			+ "first = deck.wake_ack('wake-test')\n"
			+ "again = deck.wake_ack(['wake-test', 'wake-unknown'])\n"
			+ "print(json.dumps({'first': first, 'again': again}))",
			liveDeckEnv(home),
		);
		expect(status).toBe(0);
		expect(JSON.parse(out)).toEqual({
			first: { acked: ["wake-test"] },
			again: { acked: ["wake-test", "wake-unknown"] },
		});
		expect(fs.existsSync(path.join(outbox, "wake-test.json"))).toBe(false);
	});

	test("parked_ok distinguishes missing coverage from terminal-only coverage", () => {
		const home = freshHome();
		writeEffort(home, "uncovered-effort", "uncovered-run");
		writeEffort(home, "terminal-covered", "terminal-run");
		writeEffort(home, "finished-effort", "done-run", "done: landed");
		fs.writeFileSync(
			path.join(home, "state", "finished-effort.observed"),
			`${JSON.stringify({ emitted: ["run::done-run::succeeded:0"] })}\n`,
		);
		writeTerminalWakeProfile(home, "terminal-run");
		const { status, out } = runPython(
			"import deck, json\n"
			+ "before = deck.parked_ok()\n"
			+ "deck.wake_me('30m', 'global nudge only')\n"
			+ "after_global = deck.parked_ok()\n"
			+ "deck.wake_me('30m', 'cover hard gap', task='uncovered-effort')\n"
			+ "after_hard_covered = deck.parked_ok()\n"
			+ "deck.wake_me('30m', 'guard against a stall', task='terminal-covered')\n"
			+ "after_guarded = deck.parked_ok()\n"
			+ "print(json.dumps({'before': before, 'after_global': after_global, 'after_hard_covered': after_hard_covered, 'after_guarded': after_guarded}))",
			liveDeckEnv(home),
		);
		expect(status).toBe(0);
		const verdicts = JSON.parse(out.split("\n")[0] as string);
		expect(out).toContain("Deck warning: terminal-only wake coverage has no stall guard for terminal-covered");
		expect(verdicts.before).toEqual({
			uncovered: [{ taskId: "uncovered-effort", runId: "uncovered-run", lastVerb: "working" }],
			noStallGuard: [{ taskId: "terminal-covered", runId: "terminal-run", lastVerb: "working" }],
		});
		expect(verdicts.after_global).toEqual(verdicts.before);
		expect(verdicts.after_hard_covered).toEqual({
			uncovered: [],
			noStallGuard: [{ taskId: "terminal-covered", runId: "terminal-run", lastVerb: "working" }],
		});
		expect(verdicts.after_guarded).toEqual({
			uncovered: [],
			noStallGuard: [],
		});
	});

	test("wake_me returns without sleeping", () => {
		const home = freshHome();
		const { status, out } = runPython(
			"import deck, time\n"
			+ "def forbidden_sleep(*args, **kwargs):\n"
			+ "    raise AssertionError('wake_me slept')\n"
			+ "time.sleep = forbidden_sleep\n"
			+ "started = time.monotonic()\n"
			+ "deck.wake_me('30m', 'return now')\n"
			+ "print(time.monotonic() - started)",
			liveDeckEnv(home),
		);
		expect(status).toBe(0);
		expect(Number(out.trim())).toBeLessThan(3);
	});

	test("help() names every callable it exports", () => {
		const { out, status } = runPython(
			"import deck\nmissing = [n for n in deck.__all__ if n not in ('DeckError','help','session_id') and f'deck.{n}' not in deck.help()]\nprint('missing:', missing)",
		);
		expect(status).toBe(0);
		expect(out).toContain("missing: []");
	});
});
