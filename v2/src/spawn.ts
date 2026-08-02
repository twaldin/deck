/**
 * Spawn: one-shot, event-driven crew runs. No idle agents.
 *
 * A crew's identity is its SESSION FILE, not a process. Verified: three
 * consecutive `pi -p -c --session-dir` processes behave as one continuous agent,
 * so a run can end and the next event resumes the same agent with its history.
 * That is what removes the need to supervise anything between events, and with
 * it every pane-poll, delivery-ack and idle-heuristic mechanism.
 *
 * The brief is generated here (prompts.ts), not hand-written per task.
 */
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { appendStatus } from "./events";
import { ensureTaskDirs, stateFiles, taskFiles } from "./home";
import { bumpEpoch, readMeta, updateMeta, type TaskKind } from "./meta";
import { findProfile, loadProfiles, type ModelSeat, type ProjectProfile } from "./projects";
import { workerBrief } from "./prompts";
import { assertDeckModel } from "../../workflows/pr-pipeline/lib/models";
import { buildHydration } from "./hydrate";
import { ack as ackMessages } from "./queue";

/** Captain policy 2026-07-31: one-shot/spawn bread-and-butter is luna (high TPS). */
export const DEFAULT_WORKER_MODEL = "deck/gpt-5.6-luna";

/**
 * Tools a worker must not have.
 *
 * `ask_captain` is excluded structurally, not merely forbidden in prose: workers
 * escalate through their status file and the orchestrator relays. A prompt rule
 * would decay; an absent tool cannot be called.
 */
/**
 * Tools a worker must not have.
 *
 * `ask_captain` is excluded structurally, not by instruction: two channels to the
 * captain race, and the loser is a decision nobody sees.
 *
 * `web_search` is excluded because a rate-limited search is an infinite retry
 * trap. Observed on a live worker: nine consecutive 429s, and it was STILL
 * retrying — it had already fixed the code and written its test, and burned the
 * rest of the run re-confirming a fact it stated correctly from memory
 * ("I don't need to search this"). A worker's job is bounded work in a repo it can
 * read; if a task genuinely needs the web, that research belongs in a scout whose
 * deliverable is a report.
 */
export const WORKER_EXCLUDED_TOOLS = ["ask_captain", "web_search"] as const;

/** A worker exceeding this has stopped making progress; see run_deadline. */
export const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;

export type SpawnRequest = {
	taskId: string;
	task: string;
	acceptance: string[];
	/** Absolute path to an existing disposable worktree (escape hatch). */
	worktree?: string;
	/** Repo to allocate a fresh worktree from: absolute path or alias. */
	repo?: string;
	/** Base branch/commit for allocation. Default: origin/main. */
	base?: string;
	/** Short label recorded on the allocated worktree entry. */
	desc?: string;
	kind: TaskKind;
	project?: string;
	/** Wall-clock budget for the run. Default DEFAULT_DEADLINE_MS. */
	deadlineMs?: number;
	/**
	 * Escape hatch: this ship spawn deliberately bypasses the project's PR
	 * pipeline (a worker inside a pipeline stage, or captain-authorized bare
	 * work). Default false: profiled ship work goes through `deck-v2 ship`.
	 */
	noPipeline?: boolean;
	branch?: string;
	model?: string;
	context?: string;
	/**
	 * Native reasoning selector passed to Pi. Use a named effort (`minimal`,
	 * `low`, `medium`, `high`, `xhigh`, or `max`) or an Anthropic budget as
	 * `budget:<tokens>`; Pi sends the provider-native value without remapping.
	 */
	reasoning?: "low" | "medium" | "high" | "xhigh" | "max";
	thinking?: string;
};

export type SpawnResult = {
	taskId: string;
	epoch: number;
	briefPath: string;
	sessionDir: string;
	pid: number;
	model: string;
	worktree: string;
	wtId?: string;
	branch?: string;
};

/**
 * Resolve a repo alias to its primary checkout via the project profiles
 * (config/projects.json). An absolute path always works too.
 */
export function resolveRepo(repo: string): string {
	if (path.isAbsolute(repo)) return repo;
	const profile = findProfile(repo);
	if (profile === null) {
		const known = loadProfiles().map((p) => p.id);
		throw new Error(
			`unknown repo alias "${repo}"; use an absolute path or one of: ${known.join(", ")}`,
		);
	}
	return profile.primary;
}

/** Realpath when the path exists; the input otherwise. */
function realpathIfExists(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

function profileByPrimary(candidate: string): ProjectProfile | null {
	const resolved = realpathIfExists(candidate);
	for (const profile of loadProfiles()) {
		if (realpathIfExists(profile.primary) === resolved) return profile;
	}
	return null;
}

/**
 * The primary checkout a worktree belongs to. A linked worktree's
 * --git-common-dir is <primary>/.git, so its parent is the primary. Null when
 * the path is not a git worktree (isolation checks refuse that later anyway).
 */
function worktreePrimary(worktree: string): string | null {
	const run = spawnSync(
		"git",
		["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"],
		{ encoding: "utf8", env: { ...process.env } },
	);
	if (run.status !== 0) return null;
	const commonDir = run.stdout.trim();
	if (commonDir.length === 0) return null;
	return path.dirname(commonDir);
}

/**
 * The profile a ship spawn would belong to, if any: match by project name,
 * repo alias, the repo's primary checkout path, or — for the worktree escape
 * hatch — the primary checkout the worktree was created from. The worktree
 * path matters: without it, `spawn --kind ship --worktree <wt>` on a profiled
 * project would bypass the pipeline the other two paths enforce.
 */
function seatModel(seat: ModelSeat | undefined): { model: string; reasoning?: string } {
	if (seat === undefined) return { model: DEFAULT_WORKER_MODEL };
	return typeof seat === "string" ? { model: seat } : seat;
}

export function workerModelFor(request: SpawnRequest): string {
	const model = request.model ?? seatModel(shipProfileFor(request)?.models?.implementer).model;
	assertDeckModel(model);
	return model;
}

export function workerReasoningFor(request: SpawnRequest): string | undefined {
	return request.reasoning ?? request.thinking ?? seatModel(shipProfileFor(request)?.models?.implementer).reasoning;
}

export function shipProfileFor(request: SpawnRequest): ProjectProfile | null {
	if (request.project !== undefined) {
		const byProject = findProfile(request.project);
		if (byProject !== null) return byProject;
	}
	if (request.repo !== undefined) {
		if (!path.isAbsolute(request.repo)) return findProfile(request.repo);
		return profileByPrimary(request.repo);
	}
	if (request.worktree !== undefined) {
		const primary = worktreePrimary(request.worktree);
		if (primary !== null) return profileByPrimary(primary);
	}
	return null;
}

/**
 * Machine enforcement of the default ship path (doctrine PR #26865: a bare
 * spawn shipped a PR with no adversarial review). A ship spawn on a profiled
 * project is refused unless noPipeline is explicit: the effort ships through
 * the pr-pipeline (`deck-v2 ship`), where the PR open is a compute node hard-
 * gated behind the adversarial review. Raw spawn stays available for workers
 * inside a pipeline stage, scouts, and captain-authorized escapes.
 */
export function assertShipGoesThroughPipeline(request: SpawnRequest): void {
	if (request.kind !== "ship" || request.noPipeline === true) return;
	const profile = shipProfileFor(request);
	if (profile === null) return;
	throw new Error(
		`refusing a bare ship spawn on profiled project "${profile.id}" (pipeline: ${profile.pipeline}).\n` +
			`Ship the effort through its pipeline instead: deck-v2 ship <ticket> --profile ${profile.id} ... \n` +
			`(adversarial review is a hard gate before the PR opens there).\n` +
			`spawn is for workers inside a pipeline stage and for scouts; pass --no-pipeline only with the captain's word.`,
	);
}

export type AllocatedWorktree = { wtId: string; worktree: string; branch: string };

/**
 * Allocate an isolated worktree via `deck wt alloc` (the sole allocator; state
 * and locking live there). Machine-readable stdout: `id\tpath\tbranch`.
 */
export function allocateWorktree(request: SpawnRequest): AllocatedWorktree {
	if (request.repo === undefined) throw new Error("allocateWorktree needs a repo");
	const args = [
		"wt",
		"alloc",
		"--repo",
		resolveRepo(request.repo),
		"--effort",
		request.taskId,
	];
	if (request.base !== undefined) args.push("--base", request.base);
	if (request.branch !== undefined) args.push("--branch", request.branch);
	if (request.desc !== undefined) args.push("--desc", request.desc);
	const bin = process.env.DECK_CLI_BIN ?? "deck";
	// env passed explicitly: under bun, spawnSync without it hands the child the
	// process's ORIGINAL environment, not the current process.env (verified).
	const run = spawnSync(bin, args, { encoding: "utf8", env: { ...process.env } });
	if (run.error !== undefined) {
		throw new Error(`cannot run ${bin}: ${run.error.message}; is the deck CLI installed?`);
	}
	if (run.status !== 0) {
		throw new Error(`deck wt alloc failed: ${(run.stderr ?? "").trim() || `exit ${run.status}`}`);
	}
	const [wtId, worktree, branch] = run.stdout.trim().split("\t");
	if (wtId === undefined || worktree === undefined || branch === undefined) {
		throw new Error(`unparseable deck wt alloc output: ${run.stdout.trim()}`);
	}
	return { wtId, worktree, branch };
}

/** Isolation assertion. A worker must never run in the primary checkout. */
export function assertIsolatedWorktree(worktree: string, primaryCheckout: string): void {
	const resolved = fs.existsSync(worktree) ? fs.realpathSync(worktree) : path.resolve(worktree);
	const primary = fs.existsSync(primaryCheckout)
		? fs.realpathSync(primaryCheckout)
		: path.resolve(primaryCheckout);
	if (resolved === primary) {
		throw new Error(
			`refusing to spawn in the primary checkout ${primary}: workers require a disposable worktree`,
		);
	}
	const gitMarker = path.join(resolved, ".git");
	if (!fs.existsSync(gitMarker)) {
		throw new Error(`${resolved} is not a git worktree (no .git); refusing to spawn`);
	}
	// A main checkout has a .git DIRECTORY; a linked (disposable) worktree has a
	// .git file. Refusing the directory form refuses every repo's primary
	// checkout, not just the orchestrator home.
	if (fs.statSync(gitMarker).isDirectory()) {
		throw new Error(
			`${resolved} is a repository's primary checkout: workers require a disposable linked worktree`,
		);
	}
}

/** Best-effort release of a just-allocated worktree after a failed launch. */
function releaseAllocated(wtId: string): void {
	const bin = process.env.DECK_CLI_BIN ?? "deck";
	try {
		spawnSync(bin, ["wt", "release", wtId, "--delete-branch"], {
			encoding: "utf8",
			env: { ...process.env },
		});
	} catch {
		// The original failure propagates; the slot stays visible in `deck wt ls`.
	}
}

/**
 * Write the generated brief. Immutable once dispatched.
 *
 * `checkoutBranch` is the branch the brief tells the worker to create; an
 * allocated worktree already sits on its branch, so it passes undefined.
 */
export function writeBrief(
	request: SpawnRequest,
	worktree: string,
	checkoutBranch?: string,
): string {
	ensureTaskDirs(request.taskId);
	const files = taskFiles(request.taskId);
	const brief = workerBrief({
		taskId: request.taskId,
		task: request.task,
		acceptance: request.acceptance,
		worktree,
		statusFile: stateFiles(request.taskId).status,
		kind: request.kind,
		...(request.project === undefined ? {} : { project: request.project }),
		...(checkoutBranch === undefined ? {} : { branch: checkoutBranch }),
		...(request.kind === "scout" ? { reportPath: files.report } : {}),
		...(request.context === undefined ? {} : { context: request.context }),
	});
	fs.writeFileSync(files.brief, `${brief}\n`, { mode: 0o600 });
	return files.brief;
}

export function piArgs(sessionDir: string, model: string, thinking: string | undefined, resume: boolean) {
	const args = ["-p", "--session-dir", sessionDir, "--model", model];
	if (resume) args.push("-c");
	if (thinking !== undefined && thinking.length > 0) args.push("--thinking", thinking);
	// Structural single-channel enforcement (see WORKER_EXCLUDED_TOOLS).
	args.push("--exclude-tools", WORKER_EXCLUDED_TOOLS.join(","));
	return args;
}

/**
 * Start a run for a task. Bumps the epoch first, so any still-moving prior run
 * is fenced out of the task's state before this one writes.
 *
 * Returns once the child is launched; the run is terminal by design and its exit
 * is the completion signal. Liveness is proven by the session file appearing,
 * not by a status line.
 */
export function startRun(request: SpawnRequest, primaryCheckout: string): SpawnResult {
	if ((request.worktree === undefined) === (request.repo === undefined)) {
		throw new Error("spawn needs exactly one of worktree (absolute path) or repo (path or alias)");
	}
	assertShipGoesThroughPipeline(request);
	const allocated = request.worktree === undefined ? allocateWorktree(request) : undefined;
	const worktree = allocated?.worktree ?? (request.worktree as string);
	const branch = allocated?.branch ?? request.branch;
	try {
		return launchRun(request, worktree, branch, allocated, primaryCheckout);
	} catch (error) {
		// A failed launch must not strand a fresh allocation as an active slot.
		if (allocated !== undefined) releaseAllocated(allocated.wtId);
		throw error;
	}
}

function launchRun(
	request: SpawnRequest,
	worktree: string,
	branch: string | undefined,
	allocated: AllocatedWorktree | undefined,
	primaryCheckout: string,
): SpawnResult {
	assertIsolatedWorktree(worktree, primaryCheckout);
	ensureTaskDirs(request.taskId);

	const model = workerModelFor(request);
	const sessionDir = stateFiles(request.taskId).sessions;
	fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

	// An allocated worktree is already on its branch; only an escape-hatch
	// worktree with an explicit branch needs the checkout instruction.
	const briefPath = writeBrief(request, worktree, allocated === undefined ? request.branch : undefined);
	const epoch = bumpEpoch(request.taskId);

	updateMeta(request.taskId, {
		kind: request.kind,
		worktree,
		model,
		session_dir: sessionDir,
		owner_system: "deck",
		created: readMeta(request.taskId)?.created ?? new Date().toISOString(),
		...(request.project === undefined ? {} : { project: request.project }),
		...(branch === undefined ? {} : { branch }),
		...(allocated === undefined ? {} : { wt_id: allocated.wtId }),
		...(request.desc === undefined ? {} : { desc: request.desc }),
	});

	const resume = hasSession(sessionDir);
	const hydration = buildHydration(request.taskId, epoch);
	const prompt = resume
		? hydration.text
		: `${fs.readFileSync(briefPath, "utf8")}\n\n${hydration.text}`;

	const child = spawnProcess("pi", piArgs(sessionDir, model, workerReasoningFor(request), resume), {
		cwd: worktree,
		detached: true,
		stdio: ["pipe", "ignore", "ignore"],
		env: { ...process.env, DECK_TASK_ID: request.taskId, DECK_RUN_EPOCH: String(epoch) },
	});
	// A spawn failure (e.g. pi not on PATH) is emitted async on this event; with
	// no listener it crashes the orchestrator process. The pid check below is the
	// synchronous detection path, so the event itself only needs absorbing.
	child.on("error", () => {});
	child.stdin?.end(prompt);
	child.unref();

	const pid = child.pid ?? -1;
	if (allocated !== undefined && pid <= 0) {
		throw new Error("pi did not launch; releasing the allocated worktree");
	}
	// Recorded so stale detection can tell "run finished" from "run vanished".
	// The deadline makes "bounded work" an enforced property rather than an
	// assumption: a live worker that loops writes no status and never dies, so
	// without a deadline it is invisible forever. Observed on a live run.
	if (pid > 0) {
		updateMeta(request.taskId, {
			run_pid: pid,
			run_deadline: Date.now() + (request.deadlineMs ?? DEFAULT_DEADLINE_MS),
		});
	}

	// Ack the queued messages only now, because the run exists and the prompt
	// carrying them has been written to it. Acking while building the prompt marked
	// the captain's steer delivered even when the spawn then failed, and a lost
	// steer is silent: he believes he redirected the work and it keeps going the
	// old way. A message left pending is redelivered, which is the safe direction.
	if (pid > 0) ackMessages(request.taskId, hydration.messageIds, epoch);

	return {
		taskId: request.taskId,
		epoch,
		briefPath,
		sessionDir,
		pid,
		model,
		worktree,
		...(allocated === undefined ? {} : { wtId: allocated.wtId }),
		...(branch === undefined ? {} : { branch }),
	};
}

export function hasSession(sessionDir: string): boolean {
	try {
		return fs.readdirSync(sessionDir).some((f) => f.endsWith(".jsonl"));
	} catch {
		return false;
	}
}

/** Newest session file, which is the task's current agent identity. */
export function latestSession(taskId: string): string | null {
	const dir = stateFiles(taskId).sessions;
	let entries: string[];
	try {
		entries = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return null;
	}
	if (entries.length === 0) return null;
	const sorted = entries
		.map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
		.sort((a, b) => b.m - a.m);
	const newest = sorted[0];
	return newest === undefined ? null : path.join(dir, newest.f);
}

export type PeekEntry = {
	role: string;
	text: string;
	ts?: string;
};

/**
 * Peek: the last N meaningful entries of a task's session.
 *
 * This replaces pane-scraping with the actual transcript, so there is no
 * rendering ambiguity to misread — the failure mode behind four dated fm2
 * incidents.
 */
export function peekSession(taskId: string, limit = 12): PeekEntry[] {
	const file = latestSession(taskId);
	if (file === null) return [];
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const entries: PeekEntry[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (parsed === null || typeof parsed !== "object") continue;
		const record = parsed as { type?: string; message?: { role?: string; content?: unknown }; timestamp?: string };
		if (record.type !== "message" || record.message === undefined) continue;
		const role = record.message.role ?? "unknown";
		const text = flattenContent(record.message.content);
		if (text.trim().length === 0) continue;
		entries.push({ role, text, ...(record.timestamp === undefined ? {} : { ts: record.timestamp }) });
	}
	return entries.slice(-limit);
}

function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block === null || typeof block !== "object") continue;
		const typed = block as { type?: string; text?: string; name?: string };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
		else if (typed.type === "toolCall") parts.push(`[tool: ${typed.name ?? "?"}]`);
		else if (typed.type === "thinking") parts.push("[thinking]");
	}
	return parts.join(" ");
}

/** Is a pid still alive? Used to tell "run finished" from "run vanished". */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Cancel a task's live run by process group, SIGTERM then SIGKILL after a grace
 * period, so a run gets the chance to finish a write in flight.
 */
export function cancelRun(pid: number, graceMs = 3000): void {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			return;
		}
	}
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) return;
		spawnSync("sleep", ["0.1"]);
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone
		}
	}
}

/** Record a task's own status append from the orchestrator side. */
export function noteSpawn(result: SpawnResult): void {
	appendStatus(result.taskId, "working", `run started (epoch ${result.epoch}, ${result.model})`, {
		epoch: result.epoch,
	});
}
