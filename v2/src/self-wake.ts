/**
 * Durable wake registrations made by the orchestrator itself.
 *
 * A timer in the Prime process is not a wake condition: it disappears with the
 * process. Registrations are one file each so independent writers never share a
 * read-modify-write window, and the ordinary wake outbox takes over once a
 * condition becomes true.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readStatus } from "./events";
import { assertTaskId, ensureHomeDirs, stateDir } from "./home";
import { wakeOnTerminalForRun } from "./observer";
import { listEffortMetas } from "./recall";
import { TERMINAL_VERBS, type WakeTier } from "./status";
import { enqueueWakeOnce } from "./wake";

export type SelfWakeRegistration = {
	id: string;
	key: "agent-requested";
	when: string;
	note: string;
	tier: WakeTier;
	createdAt: string;
	dueAt?: string;
	runId?: string;
	/** Missing means a global nudge. It deliberately covers no effort. */
	taskId?: string;
};

type EffortWakeGap = { taskId: string; runId?: string; lastVerb: string | null };

export type ParkedVerdict = {
	uncovered: EffortWakeGap[];
	noStallGuard: EffortWakeGap[];
};

const DURATION_RE = /^([1-9]\d*)(ms|s|m|h|d)$/;
const RUN_TERMINAL_RE = /^run:(.+):terminal$/;
const REGISTRATION_ID_RE = /^[a-z0-9]+-[a-z0-9]+-[a-f0-9]{24}$/;
const DURATION_MS: Record<string, number> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};
const WAKE_TIERS: Record<string, true> = { T0: true, T1: true, T2: true };
const RUN_TERMINAL_STATES = ["succeeded", "failed", "cancelled"] as const;

function registrationsDir(): string {
	return path.join(stateDir(), ".wake-conditions");
}

function registrationPath(id: string): string {
	return path.join(registrationsDir(), `${id}.json`);
}


function parseDuration(value: string): number | null {
	const match = DURATION_RE.exec(value);
	if (match === null) return null;
	const amount = Number(match[1]);
	const multiplier = DURATION_MS[match[2] as string];
	if (multiplier === undefined || !Number.isSafeInteger(amount)) return null;
	const duration = amount * multiplier;
	return Number.isSafeInteger(duration) ? duration : null;
}

function validateRegistration(value: unknown, file: string): SelfWakeRegistration {
	if (value === null || typeof value !== "object") throw new Error(`invalid wake registration ${file}: expected an object`);
	const registration = value as Partial<SelfWakeRegistration>;
	if (
		typeof registration.id !== "string" ||
		!REGISTRATION_ID_RE.test(registration.id) ||
		path.basename(file) !== `${registration.id}.json` ||
		registration.key !== "agent-requested" ||
		typeof registration.when !== "string" ||
		registration.when.trim() === "" ||
		typeof registration.note !== "string" ||
		registration.note.trim() === "" ||
		typeof registration.createdAt !== "string" ||
		!Number.isFinite(Date.parse(registration.createdAt)) ||
		typeof registration.tier !== "string" ||
		WAKE_TIERS[registration.tier] !== true ||
		(registration.taskId !== undefined && typeof registration.taskId !== "string")
	) {
		throw new Error(`invalid wake registration ${file}: required fields are missing or malformed`);
	}
	if (registration.taskId !== undefined) assertTaskId(registration.taskId);
	const duration = parseDuration(registration.when);
	const run = RUN_TERMINAL_RE.exec(registration.when);
	const validDuration =
		duration !== null &&
		typeof registration.dueAt === "string" &&
		Number.isFinite(Date.parse(registration.dueAt)) &&
		registration.runId === undefined;
	const validRun =
		run !== null &&
		typeof registration.runId === "string" &&
		registration.runId === run[1]?.trim() &&
		registration.runId !== "" &&
		registration.taskId !== undefined &&
		registration.dueAt === undefined;
	if (!validDuration && !validRun) {
		throw new Error(`invalid wake registration ${file}: condition fields do not match ${JSON.stringify(registration.when)}`);
	}
	return registration as SelfWakeRegistration;
}

/** Every standing self-wake registration, including not-yet-due timers. */
export function registeredSelfWakes(): SelfWakeRegistration[] {
	let names: string[];
	try {
		names = fs.readdirSync(registrationsDir()).filter((name) => name.endsWith(".json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const registrations = names.map((name) => {
		const file = path.join(registrationsDir(), name);
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (error) {
			throw new Error(`cannot read wake registration ${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return validateRegistration(parsed, file);
	});
	return registrations.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Persist a condition and return immediately. No wait happens in this process. */
export function registerSelfWake(input: {
	when: string;
	note: string;
	tier?: WakeTier;
	taskId?: string;
}, now = Date.now()): SelfWakeRegistration {
	const when = input.when.trim();
	const note = input.note.trim();
	if (when === "") throw new Error("--when must not be empty");
	if (note === "") throw new Error("--note must not be empty");
	const tier = input.tier ?? "T0";
	if (WAKE_TIERS[tier] !== true) throw new Error(`invalid wake tier ${JSON.stringify(tier)}; expected T0, T1, or T2`);

	const efforts = listEffortMetas();
	const duration = parseDuration(when);
	const runMatch = RUN_TERMINAL_RE.exec(when);
	let taskId = input.taskId;
	let runId: string | undefined;
	let dueAt: string | undefined;

	if (duration !== null) {
		dueAt = new Date(now + duration).toISOString();
		if (taskId !== undefined) {
			assertTaskId(taskId);
			if (!efforts.some((effort) => effort.id === taskId)) throw new Error(`no Deck effort matches task ${JSON.stringify(taskId)}`);
		}
	} else if (runMatch !== null) {
		runId = runMatch[1]?.trim();
		if (runId === undefined || runId === "") throw new Error("run terminal condition needs a run id");
		const owners = efforts.filter((effort) => effort.run_id === runId);
		if (owners.length === 0) throw new Error(`no Deck effort owns run ${JSON.stringify(runId)}`);
		if (owners.length > 1) throw new Error(`run ${JSON.stringify(runId)} is owned by multiple efforts: ${owners.map((effort) => effort.id).join(", ")}`);
		const owner = owners[0] as (typeof owners)[number];
		if (taskId !== undefined && taskId !== owner.id) {
			throw new Error(`run ${JSON.stringify(runId)} belongs to ${owner.id}, not ${taskId}`);
		}
		taskId = owner.id;
	} else {
		throw new Error(`unsupported wake condition ${JSON.stringify(when)}; use a duration such as 30m or run:<id>:terminal`);
	}

	const id = `${now.toString(36)}-${process.pid.toString(36)}-${crypto.randomBytes(12).toString("hex")}`;
	const registration: SelfWakeRegistration = {
		id,
		key: "agent-requested",
		when,
		note,
		tier,
		createdAt: new Date(now).toISOString(),
		...(dueAt === undefined ? {} : { dueAt }),
		...(runId === undefined ? {} : { runId }),
		...(taskId === undefined ? {} : { taskId }),
	};

	ensureHomeDirs();
	fs.mkdirSync(registrationsDir(), { recursive: true, mode: 0o700 });
	const target = registrationPath(id);
	const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(registration, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	fs.renameSync(tmp, target);
	return registration;
}

function observedRunIsTerminal(taskId: string, runId: string): boolean {
	const file = path.join(stateDir(), `${taskId}.observed`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw new Error(`cannot read observer ledger ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		!("emitted" in parsed) ||
		!Array.isArray(parsed.emitted) ||
		parsed.emitted.some((key) => typeof key !== "string")
	) {
		throw new Error(`invalid observer ledger ${file}: emitted must be an array of strings`);
	}
	return parsed.emitted.some((key) =>
		key.startsWith("run:") && RUN_TERMINAL_STATES.some((state) => key.endsWith(`:${runId}::${state}:0`)));
}

function runConditionIsDue(registration: SelfWakeRegistration): boolean {
	if (registration.runId === undefined || registration.taskId === undefined) return false;
	const owner = listEffortMetas().find((effort) => effort.id === registration.taskId);
	// Deletion or replacement of the awaited run is itself actionable. Leaving the
	// registration asleep forever would turn a missing run into silent idleness.
	if (owner?.run_id !== registration.runId) return true;
	return observedRunIsTerminal(registration.taskId, registration.runId);
}

/** Promote due registrations into the ordinary at-least-once wake outbox. */
export function produceDueSelfWakes(now = Date.now()): SelfWakeRegistration[] {
	const due = registeredSelfWakes().filter((registration) => {
		if (registration.dueAt !== undefined) return Date.parse(registration.dueAt) <= now;
		return runConditionIsDue(registration);
	});
	for (const registration of due) {
		const taskId = registration.taskId ?? "orchestrator";
		// The registration id is storage identity, so a crash before unlink
		// retries the same wake without baseline races or a second outbox id.
		enqueueWakeOnce(registration.id, {
			key: "agent-requested",
			taskId,
			note: registration.note,
			tier: registration.tier,
		});
		try {
			fs.unlinkSync(registrationPath(registration.id));
		} catch (error) {
			// Another producer may have promoted the same stable id. Its unlink is
			// our success; every other removal failure must stay loud.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return due;
}

/**
 * The turn may park only when every live effort has a real wake path.
 *
 * Project terminal wakes are genuine coverage, but a terminal-only path cannot
 * detect a run that hangs forever. Report that weaker posture separately so the
 * invariant stays honest without requiring redundant terminal registrations.
 */
export function parkedVerdict(): ParkedVerdict {
	const registrations = registeredSelfWakes();
	const explicitlyCovered = new Set(
		registrations.flatMap((registration) => registration.taskId === undefined ? [] : [registration.taskId]),
	);
	const stallGuarded = new Set(
		registrations.flatMap((registration) =>
			registration.taskId !== undefined && registration.dueAt !== undefined ? [registration.taskId] : []),
	);
	const uncovered: EffortWakeGap[] = [];
	const noStallGuard: EffortWakeGap[] = [];
	for (const effort of listEffortMetas()) {
		const events = readStatus(effort.id).events;
		const latest = events[events.length - 1];
		const terminal = effort.run_id === undefined
			? latest !== undefined && TERMINAL_VERBS.includes(latest.verb)
			: observedRunIsTerminal(effort.id, effort.run_id);
		if (terminal) continue;
		const terminalCovered = effort.run_id !== undefined && wakeOnTerminalForRun(effort.run_id);
		const gap: EffortWakeGap = {
			taskId: effort.id,
			...(effort.run_id === undefined ? {} : { runId: effort.run_id }),
			lastVerb: latest?.verb ?? null,
		};
		if (!explicitlyCovered.has(effort.id) && !terminalCovered) uncovered.push(gap);
		else if (!stallGuarded.has(effort.id)) noStallGuard.push(gap);
	}
	uncovered.sort((a, b) => a.taskId.localeCompare(b.taskId));
	noStallGuard.sort((a, b) => a.taskId.localeCompare(b.taskId));
	return { uncovered, noStallGuard };
}
