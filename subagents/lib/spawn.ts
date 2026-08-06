import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	discoverAgents,
	resolveAgent,
	type AgentDefinition,
	type AgentRole,
	AgentRegistryError,
} from "./agent-registry.ts";
import {
	loadAvailableDeckModels,
	validateModelName,
	validateThinkingLevel,
	type ThinkingLevel,
	ModelRegistryError,
} from "./model-registry.ts";
import { defaultModelPolicy, modelReasoningPolicy, resolveSeat } from "./model-policy.ts";

export const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1_000;
export const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1_000;
export const DEFAULT_MAX_CONCURRENCY = 4;
export const YIELD_MARKER = "DECK_SUBAGENT_YIELD ";
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_CHILD_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const STDERR_LIMIT_BYTES = 64 * 1024;

const canonicalPolicy = defaultModelPolicy();
const canonicalImplementer = resolveSeat(canonicalPolicy.implementer, canonicalPolicy.reasoningImplementer);
const canonicalReviewer = resolveSeat(canonicalPolicy.reviewer!, canonicalPolicy.reasoningReviewer);
const canonicalMechanical = resolveSeat(canonicalPolicy.mechanical, canonicalPolicy.reasoningMechanical);
const canonicalReasoningByModel = modelReasoningPolicy(canonicalPolicy);

/** Explicit frontmatter/request values win; this is a projection, not a second policy. */
export const DEFAULT_SPAWN_SELECTION: Record<AgentRole, { model: string; thinking: ThinkingLevel }> = {
	implementer: { model: canonicalImplementer.model, thinking: canonicalImplementer.reasoning },
	reviewer: { model: canonicalReviewer.model, thinking: canonicalReviewer.reasoning },
	mechanical: { model: canonicalMechanical.model, thinking: canonicalMechanical.reasoning },
};

export function defaultSpawnSelection(role: AgentRole | undefined): { model: string; thinking: ThinkingLevel } {
	return DEFAULT_SPAWN_SELECTION[role ?? "mechanical"];
}

export type SubagentRunStatus = "succeeded" | "failed" | "stalled" | "aborted";
export type SubagentErrorKind =
	| "invalid-agent"
	| "invalid-model"
	| "registry-unavailable"
	| "invalid-cwd"
	| "spawn"
	| "stalled"
	| "timeout"
	| "aborted"
	| "exit"
	| "invalid-yield";

export interface SubagentExitStatus {
	status: SubagentRunStatus;
	code: number | null;
	signal: NodeJS.Signals | null;
}

export interface SubagentResult {
	ok: boolean;
	agent: string;
	model: string | null;
	cwd: string;
	filesTouched: string[];
	summary: string;
	exitStatus: SubagentExitStatus;
	startedAt: string;
	lastActivityAt: string;
	durationMs: number;
	error?: {
		kind: SubagentErrorKind;
		reason: string;
		valid?: string[];
	};
}

export interface SpawnSubagentRequest {
	agent: string;
	task: string;
	cwd: string;
	model?: string;
	thinking?: ThinkingLevel;
	stallTimeoutMs?: number;
	maxRuntimeMs?: number;
	signal?: AbortSignal;
	onActivity?: (lastActivityAt: string) => void;
}

interface ChildProcessLike {
	pid?: number;
	exitCode: number | null;
	stdout: NodeJS.ReadableStream | null;
	stderr: NodeJS.ReadableStream | null;
	on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	kill(signal?: NodeJS.Signals): boolean;
}

export type ChildSpawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcessLike;

export interface TimerScheduler {
	setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
	clearTimeout(timer: NodeJS.Timeout | undefined): void;
	setInterval(callback: () => void, delayMs: number): NodeJS.Timeout;
	clearInterval(timer: NodeJS.Timeout | undefined): void;
}

export interface SubagentSpawnerDependencies {
	spawnChild?: ChildSpawner;
	discoverAgents?: (agentDirectory?: string) => Promise<AgentDefinition[]>;
	loadModels?: () => Promise<string[]>;
	agentDirectory?: string;
	piCommand?: string;
	extensionPath?: string;
	providerExtensionPath?: string;
	maxConcurrency?: number;
	killGraceMs?: number;
	now?: () => number;
	scheduler?: TimerScheduler;
}

interface ParsedYield {
	filesTouched: string[];
	summary: string;
}

class Semaphore {
	private active = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(private readonly limit: number) {}

	async run<T>(work: () => Promise<T>): Promise<T> {
		if (this.active >= this.limit) {
			const waiter = Promise.withResolvers<void>();
			this.waiters.push(waiter.resolve);
			await waiter.promise;
		}
		this.active += 1;
		try {
			return await work();
		} finally {
			this.active -= 1;
			this.waiters.shift()?.();
		}
	}
}

function positiveMilliseconds(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function extractText(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(extractText);
	if (value === null || typeof value !== "object") return [];
	const record = value as Record<string, unknown>;
	const ownText = typeof record.text === "string" ? [record.text] : [];
	return [...ownText, ...Object.entries(record).filter(([key]) => key !== "text").flatMap(([, child]) => extractText(child))];
}

function parseYieldPayload(value: unknown): ParsedYield | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const payload = value as Record<string, unknown>;
	if (!Array.isArray(payload.filesTouched) || !payload.filesTouched.every((file) => typeof file === "string")) return undefined;
	if (typeof payload.summary !== "string" || !payload.summary.trim()) return undefined;
	return { filesTouched: [...new Set(payload.filesTouched)], summary: payload.summary.trim() };
}

function structuredYieldFromEvent(event: Record<string, unknown>): ParsedYield | undefined {
	if (event.type === "tool_execution_end" && event.toolName === "deck_subagent_yield") {
		const result = event.result;
		if (result !== null && typeof result === "object") {
			const details = (result as Record<string, unknown>).details;
			if (details !== null && typeof details === "object") {
				return parseYieldPayload((details as Record<string, unknown>).deckSubagentYield);
			}
		}
	}
	if (event.type !== "message_end" || event.message === null || typeof event.message !== "object") return undefined;
	const message = event.message as Record<string, unknown>;
	if (message.role !== "toolResult" || message.toolName !== "deck_subagent_yield") return undefined;
	const details = message.details;
	if (details === null || typeof details !== "object") return undefined;
	return parseYieldPayload((details as Record<string, unknown>).deckSubagentYield);
}

function resultForFailure(
	request: SpawnSubagentRequest,
	cwd: string,
	model: string | null,
	startedAtMs: number,
	now: () => number,
	kind: SubagentErrorKind,
	reason: string,
	valid?: readonly string[],
): SubagentResult {
	const finishedAt = now();
	return {
		ok: false,
		agent: request.agent,
		model,
		cwd,
		filesTouched: [],
		summary: reason,
		exitStatus: { status: kind === "stalled" ? "stalled" : kind === "aborted" ? "aborted" : "failed", code: null, signal: null },
		startedAt: new Date(startedAtMs).toISOString(),
		lastActivityAt: new Date(startedAtMs).toISOString(),
		durationMs: Math.max(0, finishedAt - startedAtMs),
		error: { kind, reason, ...(valid === undefined ? {} : { valid: [...valid] }) },
	};
}

function childSystemPrompt(agent: AgentDefinition): string {
	return [
		agent.systemPrompt,
		"",
		"You are running as a headless Deck subagent in the caller's working directory.",
		"Finish the assigned task rather than only describing it. Before your final response, call deck_subagent_yield exactly once.",
		"Pass filesTouched as repository-relative paths you created, edited, moved, or deleted (empty for read-only work) and summary as a concise handoff of the completed result.",
		"The parent treats a missing or malformed deck_subagent_yield call as failure.",
	].join("\n");
}

async function validateCwd(cwd: string): Promise<string> {
	const resolved = await realpath(cwd);
	if (!(await stat(resolved)).isDirectory()) throw new Error(`${cwd} is not a directory`);
	return resolved;
}

function stderrReason(stderr: string): string {
	const trimmed = stderr.trim();
	return trimmed ? `: ${trimmed}` : "";
}

export function createSubagentSpawner(dependencies: SubagentSpawnerDependencies = {}): (request: SpawnSubagentRequest) => Promise<SubagentResult> {
	const environmentCap = Number(process.env.DECK_SUBAGENT_MAX_CONCURRENCY);
	const configuredCap = Number.isFinite(environmentCap) && environmentCap > 0 ? environmentCap : DEFAULT_MAX_CONCURRENCY;
	const maxConcurrency = Math.max(1, Math.floor(dependencies.maxConcurrency ?? configuredCap));
	const semaphore = new Semaphore(maxConcurrency);
	const spawnChild = dependencies.spawnChild ?? ((command, args, options) => nodeSpawn(command, [...args], options) as ChildProcess);
	const discover = dependencies.discoverAgents ?? discoverAgents;
	const loadModels = dependencies.loadModels ?? loadAvailableDeckModels;
	const now = dependencies.now ?? Date.now;
	const killGraceMs = positiveMilliseconds(dependencies.killGraceMs, DEFAULT_KILL_GRACE_MS);
	const scheduler = dependencies.scheduler ?? {
		setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
		clearTimeout: (timer: NodeJS.Timeout | undefined) => clearTimeout(timer),
		setInterval: (callback: () => void, delayMs: number) => setInterval(callback, delayMs),
		clearInterval: (timer: NodeJS.Timeout | undefined) => clearInterval(timer),
	};

	return async (request) => {
		const startedAtMs = now();
		let cwd: string;
		try {
			cwd = await validateCwd(request.cwd);
		} catch (error) {
			return resultForFailure(request, request.cwd, request.model ?? null, startedAtMs, now, "invalid-cwd", error instanceof Error ? error.message : String(error));
		}

		let agent: AgentDefinition;
		try {
			agent = resolveAgent(await discover(dependencies.agentDirectory), request.agent);
		} catch (error) {
			const valid = error instanceof AgentRegistryError ? error.validAgents : undefined;
			return resultForFailure(request, cwd, request.model ?? null, startedAtMs, now, "invalid-agent", error instanceof Error ? error.message : String(error), valid);
		}
		const roleDefault = defaultSpawnSelection(agent.role);
		if (!request.task.trim()) return resultForFailure(request, cwd, request.model ?? agent.model ?? roleDefault.model, startedAtMs, now, "spawn", "Subagent task must not be empty");

		let availableModels: string[];
		try {
			availableModels = await loadModels();
		} catch (error) {
			return resultForFailure(request, cwd, request.model ?? agent.model ?? roleDefault.model, startedAtMs, now, "registry-unavailable", error instanceof Error ? error.message : String(error));
		}
		const requestedModel = request.model ?? agent.model ?? roleDefault.model;
		const requestedThinking = request.thinking
			?? (request.model === undefined ? agent.thinking : undefined)
			?? canonicalReasoningByModel[requestedModel]
			?? roleDefault.thinking;
		let model: string;
		try {
			model = validateModelName(requestedModel, availableModels);
			validateThinkingLevel(model, requestedThinking);
		} catch (error) {
			const valid = error instanceof ModelRegistryError ? error.validModels : undefined;
			return resultForFailure(request, cwd, requestedModel, startedAtMs, now, "invalid-model", error instanceof Error ? error.message : String(error), valid);
		}

		return semaphore.run(async () => {
			const actualStartedAtMs = now();
			let promptDirectory: string | undefined;
			try {
				promptDirectory = await mkdtemp(path.join(os.tmpdir(), "deck-subagent-"));
				const promptPath = path.join(promptDirectory, "system.md");
				await writeFile(promptPath, childSystemPrompt(agent), { encoding: "utf8", mode: 0o600 });
				const piCommand = dependencies.piCommand ?? process.env.DECK_SUBAGENT_PI ?? "pi";
				const sourceExtensionPath = fileURLToPath(new URL("../deck-subagents.ts", import.meta.url));
				const installedExtensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
				const extensionPath = dependencies.extensionPath ?? (existsSync(sourceExtensionPath) ? sourceExtensionPath : installedExtensionPath);
				const sourceProviderExtensionPath = fileURLToPath(new URL("../../broker/pi/deck-provider.ts", import.meta.url));
				const adjacentProviderExtensionPath = fileURLToPath(new URL("../../deck-provider.ts", import.meta.url));
				const globalProviderExtensionPath = path.join(
					process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
					"extensions",
					"deck-provider.ts",
				);
				const detectedProviderExtensionPath = [
					sourceProviderExtensionPath,
					adjacentProviderExtensionPath,
					globalProviderExtensionPath,
				].find((candidate) => existsSync(candidate));
				const providerExtensionPath =
					dependencies.providerExtensionPath ?? detectedProviderExtensionPath;
				if (providerExtensionPath === undefined) {
					return resultForFailure(
						request,
						cwd,
						model,
						actualStartedAtMs,
						now,
						"spawn",
						"Cannot find the Deck provider extension; rerun subagents/install.sh",
					);
				}

				const args = [
					"-p",
					"--mode", "json",
					"--no-session",
					"--no-extensions",
					"--extension", providerExtensionPath,
					"--extension", extensionPath,
					"--append-system-prompt", promptPath,
					"--model", model,
				];
				args.push("--thinking", requestedThinking);
				const childTools = agent.tools ?? DEFAULT_CHILD_TOOLS;
				args.push("--tools", [...new Set([...childTools, "deck_subagent_yield"])].join(","));
				args.push(request.task);

				let child: ChildProcessLike;
				try {
					child = spawnChild(piCommand, args, {
						cwd,
						env: { ...process.env, DECK_SUBAGENT_CHILD: "1" },
						stdio: ["ignore", "pipe", "pipe"],
						shell: false,
					});
				} catch (error) {
					return resultForFailure(request, cwd, model, actualStartedAtMs, now, "spawn", `Cannot spawn pi: ${error instanceof Error ? error.message : String(error)}`);
				}
				const completion = Promise.withResolvers<SubagentResult>();
				const { resolve } = completion;

				let settled = false;
				let stdoutBuffer = "";
				let stderr = "";
				let parsedYield: ParsedYield | undefined;
				let finalAssistantText = "";
				let lastActivityAtMs = now();
				let terminalFailure: { kind: SubagentErrorKind; reason: string; status: SubagentRunStatus; signal: NodeJS.Signals } | undefined;
				let forceKillTimer: NodeJS.Timeout | undefined;
				let forcedSettleTimer: NodeJS.Timeout | undefined;
				const stallTimeoutMs = positiveMilliseconds(request.stallTimeoutMs ?? Number(process.env.DECK_SUBAGENT_STALL_TIMEOUT_MS), DEFAULT_STALL_TIMEOUT_MS);
				const maxRuntimeMs = positiveMilliseconds(request.maxRuntimeMs ?? Number(process.env.DECK_SUBAGENT_MAX_RUNTIME_MS), DEFAULT_MAX_RUNTIME_MS);
				const markActivity = () => {
					lastActivityAtMs = now();
					request.onActivity?.(new Date(lastActivityAtMs).toISOString());
				};
				const finish = (code: number | null, signal: NodeJS.Signals | null) => {
					if (settled) return;
					settled = true;
					scheduler.clearInterval(stallTimer);
					scheduler.clearTimeout(runtimeTimer);
					scheduler.clearTimeout(forceKillTimer);
					scheduler.clearTimeout(forcedSettleTimer);
					if (request.signal !== undefined) request.signal.removeEventListener("abort", abortChild);
					const durationMs = Math.max(0, now() - actualStartedAtMs);
					if (terminalFailure !== undefined) {
						resolve({
							ok: false,
							agent: agent.name,
							model,
							cwd,
							filesTouched: parsedYield?.filesTouched ?? [],
							summary: parsedYield?.summary ?? terminalFailure.reason,
							exitStatus: { status: terminalFailure.status, code, signal: signal ?? terminalFailure.signal },
							startedAt: new Date(actualStartedAtMs).toISOString(),
							lastActivityAt: new Date(lastActivityAtMs).toISOString(),
							durationMs,
							error: { kind: terminalFailure.kind, reason: terminalFailure.reason },
						});
						return;
					}
					if (code !== 0) {
						const reason = `Subagent exited with code ${code ?? "unknown"}${stderrReason(stderr)}`;
						resolve({ ok: false, agent: agent.name, model, cwd, filesTouched: parsedYield?.filesTouched ?? [], summary: parsedYield?.summary ?? reason, exitStatus: { status: "failed", code, signal }, startedAt: new Date(actualStartedAtMs).toISOString(), lastActivityAt: new Date(lastActivityAtMs).toISOString(), durationMs, error: { kind: "exit", reason } });
						return;
					}
					if (parsedYield === undefined) {
						const reason = `Subagent exited without a valid deck_subagent_yield result${finalAssistantText ? `: ${finalAssistantText}` : stderrReason(stderr)}`;
						resolve({ ok: false, agent: agent.name, model, cwd, filesTouched: [], summary: finalAssistantText || reason, exitStatus: { status: "failed", code, signal }, startedAt: new Date(actualStartedAtMs).toISOString(), lastActivityAt: new Date(lastActivityAtMs).toISOString(), durationMs, error: { kind: "invalid-yield", reason } });
						return;
					}
					resolve({ ok: true, agent: agent.name, model, cwd, filesTouched: parsedYield.filesTouched, summary: parsedYield.summary, exitStatus: { status: "succeeded", code, signal }, startedAt: new Date(actualStartedAtMs).toISOString(), lastActivityAt: new Date(lastActivityAtMs).toISOString(), durationMs });
				};
				const terminate = (kind: SubagentErrorKind, reason: string, status: SubagentRunStatus) => {
					if (settled || terminalFailure !== undefined) return;
					terminalFailure = { kind, reason, status, signal: "SIGTERM" };
					child.kill("SIGTERM");
					forceKillTimer = scheduler.setTimeout(() => child.kill("SIGKILL"), killGraceMs);
					forcedSettleTimer = scheduler.setTimeout(() => finish(null, "SIGKILL"), killGraceMs * 2);
				};
				const abortChild = () => terminate("aborted", "Parent aborted the subagent", "aborted");
				const processLine = (line: string) => {
					if (!line.trim()) return;
					try {
						const event = JSON.parse(line) as Record<string, unknown>;
						parsedYield ??= structuredYieldFromEvent(event);
						if (event.type === "message_end" && event.message !== null && typeof event.message === "object" && (event.message as Record<string, unknown>).role === "assistant") {
							finalAssistantText = extractText((event.message as Record<string, unknown>).content).join("\n").trim() || finalAssistantText;
						}
					} catch {
						// Pi JSON mode is line-delimited. Non-JSON diagnostics remain stderr-like noise.
					}
				};
				child.stdout?.on("data", (chunk: Buffer | string) => {
					markActivity();
					stdoutBuffer += chunk.toString();
					const lines = stdoutBuffer.split("\n");
					stdoutBuffer = lines.pop() ?? "";
					for (const line of lines) processLine(line);
				});
				child.stderr?.on("data", (chunk: Buffer | string) => {
					markActivity();
					stderr = `${stderr}${chunk.toString()}`.slice(-STDERR_LIMIT_BYTES);
				});
				child.on("error", (error) => terminate("spawn", `Subagent process error: ${error.message}`, "failed"));
				child.on("close", (code, signal) => {
					if (stdoutBuffer.trim()) processLine(stdoutBuffer);
					finish(code, signal);
				});
				const stallTimer = scheduler.setInterval(() => {
					if (now() - lastActivityAtMs >= stallTimeoutMs) terminate("stalled", `Subagent produced no stdout or stderr for ${stallTimeoutMs}ms`, "stalled");
				}, Math.min(1_000, Math.max(10, Math.floor(stallTimeoutMs / 4))));
				const runtimeTimer = scheduler.setTimeout(() => terminate("timeout", `Subagent exceeded ${maxRuntimeMs}ms wall-clock runtime`, "failed"), maxRuntimeMs);
				if (request.signal?.aborted) abortChild();
				else request.signal?.addEventListener("abort", abortChild, { once: true });
				return await completion.promise;
			} finally {
				if (promptDirectory !== undefined) await rm(promptDirectory, { recursive: true, force: true });
			}
		});
	};
}

const sharedSpawner = createSubagentSpawner();

/** Shared by the Pi extension and Smithers workflow seats: one bounded child path everywhere. */
export async function spawnSubagent(request: SpawnSubagentRequest): Promise<SubagentResult> {
	return sharedSpawner(request);
}
