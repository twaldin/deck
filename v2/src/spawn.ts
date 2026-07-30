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
import { workerBrief } from "./prompts";
import { buildHydration } from "./hydrate";

/** Captain policy: implementation work defaults to the fable/sol class. */
export const DEFAULT_WORKER_MODEL = "deck/claude-fable-5";

/**
 * Tools a worker must not have.
 *
 * `ask_captain` is excluded structurally, not merely forbidden in prose: workers
 * escalate through their status file and the orchestrator relays. A prompt rule
 * would decay; an absent tool cannot be called.
 */
export const WORKER_EXCLUDED_TOOLS = ["ask_captain"] as const;

export type SpawnRequest = {
	taskId: string;
	task: string;
	acceptance: string[];
	worktree: string;
	kind: TaskKind;
	project?: string;
	branch?: string;
	model?: string;
	context?: string;
	/** Reasoning level; per captain doctrine, high for gpt, medium for claude. */
	thinking?: string;
};

export type SpawnResult = {
	taskId: string;
	epoch: number;
	briefPath: string;
	sessionDir: string;
	pid: number;
	model: string;
};

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
	if (!fs.existsSync(path.join(resolved, ".git"))) {
		throw new Error(`${resolved} is not a git worktree (no .git); refusing to spawn`);
	}
}

/** Write the generated brief. Immutable once dispatched. */
export function writeBrief(request: SpawnRequest): string {
	ensureTaskDirs(request.taskId);
	const files = taskFiles(request.taskId);
	const brief = workerBrief({
		taskId: request.taskId,
		task: request.task,
		acceptance: request.acceptance,
		worktree: request.worktree,
		statusFile: stateFiles(request.taskId).status,
		kind: request.kind,
		...(request.project === undefined ? {} : { project: request.project }),
		...(request.branch === undefined ? {} : { branch: request.branch }),
		...(request.kind === "scout" ? { reportPath: files.report } : {}),
		...(request.context === undefined ? {} : { context: request.context }),
	});
	fs.writeFileSync(files.brief, `${brief}\n`, { mode: 0o600 });
	return files.brief;
}

function piArgs(sessionDir: string, model: string, thinking: string | undefined, resume: boolean) {
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
	assertIsolatedWorktree(request.worktree, primaryCheckout);
	ensureTaskDirs(request.taskId);

	const model = request.model ?? DEFAULT_WORKER_MODEL;
	const sessionDir = stateFiles(request.taskId).sessions;
	fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

	const briefPath = writeBrief(request);
	const epoch = bumpEpoch(request.taskId);

	updateMeta(request.taskId, {
		kind: request.kind,
		worktree: request.worktree,
		model,
		session_dir: sessionDir,
		owner_system: "deck",
		created: readMeta(request.taskId)?.created ?? new Date().toISOString(),
		...(request.project === undefined ? {} : { project: request.project }),
		...(request.branch === undefined ? {} : { branch: request.branch }),
	});

	const resume = hasSession(sessionDir);
	const prompt = resume
		? buildHydration(request.taskId, epoch)
		: `${fs.readFileSync(briefPath, "utf8")}\n\n${buildHydration(request.taskId, epoch)}`;

	const child = spawnProcess("pi", piArgs(sessionDir, model, request.thinking, resume), {
		cwd: request.worktree,
		detached: true,
		stdio: ["pipe", "ignore", "ignore"],
		env: { ...process.env, DECK_TASK_ID: request.taskId, DECK_RUN_EPOCH: String(epoch) },
	});
	child.stdin?.end(prompt);
	child.unref();

	const pid = child.pid ?? -1;
	// Recorded so stale detection can tell "run finished" from "run vanished".
	if (pid > 0) updateMeta(request.taskId, { run_pid: pid });

	return { taskId: request.taskId, epoch, briefPath, sessionDir, pid, model };
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
