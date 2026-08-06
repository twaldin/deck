import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream, type Dirent } from "node:fs";
import { createConnection } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import type { AgentLike } from "smithers-orchestrator";

import { DECK_AGENT_CATALOG, DECK_PROVIDER } from "../models.ts";

export const PRIME_AGENT_VERSION = "0.7.0";
export const PRIME_AGENT_BINARY = path.join(
	os.homedir(),
	".nvm",
	"versions",
	"node",
	"v24.8.0",
	"bin",
	"prime-agent",
);
export const PRIME_SEAT_IDLE_TIMEOUT_MS = 5 * 60_000;
export const PRIME_SEAT_CAPABILITY_PROFILES = {
	"workflow-seat": {
		rlmDepth: 0,
		rlmMaxDepth: 1,
		dispatch: false,
		tools: ["ipython"],
	},
	"spawn-agent": {
		rlmDepth: 0,
		rlmMaxDepth: 1,
		dispatch: false,
		tools: ["ipython"],
	},
} as const;
export type PrimeSeatCapabilityProfile = keyof typeof PRIME_SEAT_CAPABILITY_PROFILES;
export const PRIME_WORKFLOW_SEAT_TOOLS = PRIME_SEAT_CAPABILITY_PROFILES["workflow-seat"].tools;

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const VERSION_TIMEOUT_MS = 10_000;
const DAEMON_SHUTDOWN_TIMEOUT_MS = 10_000;
const SAFE_ENV_KEYS: Record<string, true> = {
	PATH: true,
	HOME: true,
	SHELL: true,
	TMPDIR: true,
	TMP: true,
	TEMP: true,
	LANG: true,
	LC_ALL: true,
	LC_CTYPE: true,
	TERM: true,
	COLORTERM: true,
	NO_COLOR: true,
	FORCE_COLOR: true,
	USER: true,
	LOGNAME: true,
	TZ: true,
	GIT_AUTHOR_NAME: true,
	GIT_AUTHOR_EMAIL: true,
	GIT_COMMITTER_NAME: true,
	GIT_COMMITTER_EMAIL: true,
	DECK_PI_MAX_TOKENS: true,
	HERDR_ENV: true,
	HERDR_PANE_ID: true,
	HERDR_SOCKET_PATH: true,
	HERDR_TAB_ID: true,
	HERDR_WORKSPACE_ID: true,
	HERDR_PI_IDLE_DEBOUNCE_MS: true,
	HERDR_PI_RETRY_GRACE_MS: true,
};
const TASK_CONTEXT_KEYS = [
	"SMITHERS_RUN_ID",
	"SMITHERS_NODE_ID",
	"SMITHERS_ITERATION",
	"SMITHERS_ATTEMPT",
] as const;

export type PrimeSeatFailureCode =
	| "PRIME_ABORTED"
	| "PRIME_CHILD_MODEL_INVALID"
	| "PRIME_DAEMON_TEARDOWN_FAILED"
	| "PRIME_MALFORMED_YIELD"
	| "PRIME_HERDR_ATTACH_FAILED"
	| "PRIME_BROKER_AUTH_FAILED"
	| "PRIME_CAPABILITY_VIOLATION"
	| "PRIME_MISSING_PROVENANCE"
	| "PRIME_MISSING_YIELD"
	| "PRIME_MODEL_MISMATCH"
	| "PRIME_OUTPUT_LIMIT"
	| "PRIME_RPC_PROTOCOL"
	| "PRIME_RPC_TRANSPORT_DIED"
	| "PRIME_SPAWN_FAILED"
	| "PRIME_STALLED"
	| "PRIME_TTL_EXCEEDED"
	| "PRIME_VERSION_MISMATCH";

export type PrimeSeatExitStatus = {
	code: number | null;
	signal: NodeJS.Signals | null;
};

export type PrimeModelProvenance = {
	sessionId: string;
	parentSessionId?: string;
	depth: number;
	provider: string;
	model: string;
	source: "rpc-state" | "transcript";
	transcript?: string;
};

export type PrimeSeatRunRecord = {
	engine: "prime";
	version: typeof PRIME_AGENT_VERSION;
	requestedModel: string;
	rootModel: PrimeModelProvenance;
	herdr: {
		paneId: string;
		label: string;
	};
	childModels: PrimeModelProvenance[];
	exitStatus: PrimeSeatExitStatus;
	wallClockMs: number;
	steers: number;
	tokens: {
		input: number;
		output: number;
		total: number;
	};
};

export type PrimeSeatFailure = {
	status: "failed" | "stalled";
	code: PrimeSeatFailureCode;
	message: string;
	exitStatus: PrimeSeatExitStatus;
	wallClockMs: number;
	stderr: string;
};

export class PrimeSeatError extends Error {
	readonly code: PrimeSeatFailureCode;
	readonly result: PrimeSeatFailure;

	constructor(result: PrimeSeatFailure, options?: ErrorOptions) {
		super(`${result.code}: ${result.message}`, options);
		this.name = "PrimeSeatError";
		this.code = result.code;
		this.result = result;
	}
}

export type PrimeSeatAgentOptions = {
	provider: typeof DECK_PROVIDER;
	model: string;
	cwd: string;
	/** Effort prefix in the Herdr pane label, e.g. "lindy#27140". */
	effortLabel?: string;
	capabilityProfile?: PrimeSeatCapabilityProfile;
	tools?: readonly string[];
	/** Model-broker credential only; never a GitHub/publisher credential. */
	brokerApiKey?: string;
	timeoutMs: number;
	idleTimeoutMs?: number;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	binary?: string;
	env?: Record<string, string | undefined>;
	extensions?: string[];
	maxOutputBytes?: number;
	terminationGraceMs?: number;
};

type AgentGenerateOptions = Parameters<AgentLike["generate"]>[0] & {
	outputSchema?: {
		safeParseAsync?: (value: unknown) => Promise<{ success: boolean; data?: unknown; error?: unknown }>;
		safeParse?: (value: unknown) => { success: boolean; data?: unknown; error?: unknown };
	};
};

type RpcModel = { provider: string; model: string };
type TranscriptAttestation = {
	sessionId: string;
	parentSessionId?: string;
	depth: number;
	models: RpcModel[];
	transcript: string;
	usage: { input: number; output: number; total: number };
};

type HerdrSeatLease = {
	socketPath: string;
	parentPaneId: string;
	paneId: string;
	tabId?: string;
	workspaceId?: string;
	label: string;
};
type ForcedFailure = {
	code: PrimeSeatFailureCode;
	message: string;
	status?: "failed" | "stalled";
};

function defaultProviderExtension(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../broker/pi/deck-provider.ts");
}

/**
 * Build the complete environment for an untrusted workflow seat. This is an
 * allowlist, not a redaction list: raw provider keys, GitHub tokens, SSH agent
 * sockets, Smithers admin credentials, and publisher/merge/stamp credentials
 * never reach either seat engine.
 */
export function buildSeatEnvironment(
	source: NodeJS.ProcessEnv = process.env,
	overrides: Record<string, string | undefined> = {},
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of Object.keys(SAFE_ENV_KEYS)) {
		const value = overrides[key] ?? source[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

function withTaskContext(
	env: Record<string, string>,
	context: AgentGenerateOptions["taskContext"],
): Record<string, string> {
	if (context === undefined) return env;
	const values = [context.runId, context.nodeId, context.iteration, context.attempt];
	const next = { ...env };
	for (let index = 0; index < TASK_CONTEXT_KEYS.length; index += 1) {
		const value = values[index];
		if (value !== undefined) next[TASK_CONTEXT_KEYS[index]] = String(value);
	}
	return next;
}

function appendTail(current: string, chunk: string, maxBytes = 32 * 1024): string {
	const combined = current + chunk;
	return Buffer.byteLength(combined, "utf8") <= maxBytes
		? combined
		: Buffer.from(combined, "utf8").subarray(-maxBytes).toString("utf8");
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

async function herdrRequest(
	socketPath: string,
	method: string,
	params: Record<string, unknown>,
	timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
	const id = `deck-prime-seat:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
	const socket = createConnection(socketPath);
	let buffer = "";
	let settled = false;
	const finish = (error?: unknown, result?: Record<string, unknown>) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		socket.destroy();
		if (error === undefined && result !== undefined) resolve(result);
		else reject(error ?? new Error(`Herdr ${method} returned no result`));
	};
	const timer = setTimeout(
		() => finish(new Error(`Herdr ${method} timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);
	socket.once("connect", () => {
		socket.write(`${JSON.stringify({ id, method, params })}\n`);
	});
	socket.once("error", finish);
	socket.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			try {
				const response = asRecord(JSON.parse(line));
				if (response?.id !== id) {
					newline = buffer.indexOf("\n");
					continue;
				}
				const error = asRecord(response.error);
				if (error !== null) {
					finish(new Error(`Herdr ${method} failed: ${String(error.code)}: ${String(error.message)}`));
					return;
				}
				const result = asRecord(response.result);
				if (result === null) {
					finish(new Error(`Herdr ${method} returned a malformed result`));
					return;
				}
				finish(undefined, result);
				return;
			} catch (error) {
				finish(new Error(`Herdr ${method} returned malformed JSON: ${String(error)}`));
				return;
			}
		}
	});
	return promise;
}

function herdrLabelSegment(value: string): string {
	return value.replace(/\s+/g, " ").replaceAll(" · ", " / ").trim().slice(0, 80) || "unknown";
}

function extractText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("");
	const record = asRecord(value);
	if (record === null) return "";
	if (typeof record.text === "string") return record.text;
	if ("content" in record) return extractText(record.content);
	return "";
}

function modelFromRpcState(payload: Record<string, unknown>): RpcModel | null {
	const data = asRecord(payload.data);
	const model = asRecord(data?.model);
	if (model === null) return null;
	const provider = typeof model.provider === "string" ? model.provider : undefined;
	const id = typeof model.id === "string"
		? model.id
		: typeof model.modelId === "string"
			? model.modelId
			: undefined;
	return provider === undefined || id === undefined ? null : { provider, model: id };
}

function usageFromMessage(message: Record<string, unknown>): { input: number; output: number; total: number } {
	const usage = asRecord(message.usage);
	const input = typeof usage?.input === "number"
		? usage.input
		: typeof usage?.inputTokens === "number"
			? usage.inputTokens
			: 0;
	const output = typeof usage?.output === "number"
		? usage.output
		: typeof usage?.outputTokens === "number"
			? usage.outputTokens
			: 0;
	const total = typeof usage?.totalTokens === "number" ? usage.totalTokens : input + output;
	return { input, output, total };
}

function addUsage(
	left: { input: number; output: number; total: number },
	right: { input: number; output: number; total: number },
): { input: number; output: number; total: number } {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		total: left.total + right.total,
	};
}

function assertPinnedModel(actual: RpcModel | null, expectedProvider: string, expectedModel: string): RpcModel {
	if (actual === null) {
		throw new Error("Prime RPC get_state did not report an active model");
	}
	if (actual.provider !== expectedProvider || actual.model !== expectedModel) {
		throw new Error(
			`Prime routed ${actual.provider}/${actual.model}; expected ${expectedProvider}/${expectedModel}`,
		);
	}
	return actual;
}

function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
	if (pid === undefined) return;
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, signal);
			return;
		} catch {
			// The child may have exited between the timer and this signal.
		}
	}
	try {
		process.kill(pid, signal);
	} catch {
		// Already gone.
	}
}

async function collectJsonlFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	async function visit(dir: string): Promise<void> {
		let entries: Dirent<string>[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await visit(full);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
		}
	}
	await visit(root);
	return files;
}

async function readTranscript(file: string, root: string): Promise<TranscriptAttestation | null> {
	let sessionId: string | undefined;
	let parentSessionId: string | undefined;
	let depth = 0;
	const models = new Map<string, RpcModel>();
	let usage = { input: 0, output: 0, total: 0 };
	const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
	for await (const line of lines) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new Error(`Malformed Prime transcript ${path.relative(root, file)}: ${String(error)}`);
		}
		const entry = asRecord(parsed);
		if (entry === null) continue;
		if (entry.type === "session") {
			if (typeof entry.id === "string") sessionId = entry.id;
			if (typeof entry.parentSession === "string") parentSessionId = entry.parentSession;
			if (typeof entry.rlmDepth === "number") depth = entry.rlmDepth;
			continue;
		}
		if (entry.type === "model_change") {
			if (typeof entry.provider === "string" && typeof entry.modelId === "string") {
				models.set(`${entry.provider}/${entry.modelId}`, {
					provider: entry.provider,
					model: entry.modelId,
				});
			}
			continue;
		}
		if (entry.type === "message") {
			const message = asRecord(entry.message);
			if (message?.role === "assistant" && typeof message.provider === "string" && typeof message.model === "string") {
				models.set(`${message.provider}/${message.model}`, {
					provider: message.provider,
					model: message.model,
				});
				usage = addUsage(usage, usageFromMessage(message));
			}
		}
	}
	if (sessionId === undefined) return null;
	return {
		sessionId,
		...(parentSessionId === undefined ? {} : { parentSessionId }),
		depth,
		models: [...models.values()],
		transcript: path.relative(root, file),
		usage,
	};
}

async function attestTranscripts(
	root: string,
	requested: RpcModel,
	rpcSessionId: string | undefined,
	maxDepth: number,
): Promise<{
	rootModel: PrimeModelProvenance;
	childModels: PrimeModelProvenance[];
	usage: { input: number; output: number; total: number };
}> {
	const transcripts = (await Promise.all(
		(await collectJsonlFiles(root)).map((file) => readTranscript(file, root)),
	)).filter((entry): entry is TranscriptAttestation => entry !== null);
	const rootTranscript = transcripts.find((entry) =>
		entry.depth === 0 && (rpcSessionId === undefined || entry.sessionId === rpcSessionId));
	if (rootTranscript === undefined) {
		throw new Error(`Root session ${rpcSessionId ?? "unknown"} has no transcript attestation`);
	}
	if (rootTranscript.models.length === 0) {
		throw new Error(`Root session ${rootTranscript.sessionId} has no model attestation`);
	}
	for (const model of rootTranscript.models) assertPinnedModel(model, requested.provider, requested.model);
	const childTranscripts = transcripts.filter((entry) => entry.depth > 0 || entry.parentSessionId !== undefined);
	const childModels: PrimeModelProvenance[] = [];
	for (const transcript of childTranscripts) {
		if (transcript.depth > maxDepth) {
			throw new Error(`Child session ${transcript.sessionId} exceeds RLM max depth ${maxDepth}: ${transcript.depth}`);
		}
		if (transcript.models.length === 0) {
			throw new Error(`Child session ${transcript.sessionId} has no model attestation`);
		}
		for (const model of transcript.models) {
			if (model.provider !== DECK_PROVIDER || !DECK_AGENT_CATALOG.includes(model.model as never)) {
				throw new Error(`Child session ${transcript.sessionId} routed off-catalog model ${model.provider}/${model.model}`);
			}
			childModels.push({
				sessionId: transcript.sessionId,
				...(transcript.parentSessionId === undefined ? {} : { parentSessionId: transcript.parentSessionId }),
				depth: transcript.depth,
				provider: model.provider,
				model: model.model,
				source: "transcript",
				transcript: transcript.transcript,
			});
		}
	}
	return {
		rootModel: {
			sessionId: rootTranscript.sessionId,
			depth: 0,
			provider: requested.provider,
			model: requested.model,
			source: "transcript",
			transcript: rootTranscript.transcript,
		},
		childModels,
		usage: transcripts.reduce(
			(total, transcript) => addUsage(total, transcript.usage),
			{ input: 0, output: 0, total: 0 },
		),
	};
}

function buildGenerateResult(
	text: string,
	output: unknown,
	model: string,
	record: PrimeSeatRunRecord,
): Record<string, unknown> {
	const usage = {
		inputTokens: record.tokens.input,
		inputTokenDetails: {
			noCacheTokens: undefined,
			cacheReadTokens: undefined,
			cacheWriteTokens: undefined,
		},
		outputTokens: record.tokens.output,
		outputTokenDetails: { textTokens: record.tokens.output, reasoningTokens: undefined },
		totalTokens: record.tokens.total,
	};
	return {
		content: [{ type: "text", text }],
		text,
		reasoning: [],
		reasoningText: undefined,
		files: [],
		sources: [],
		toolCalls: [],
		staticToolCalls: [],
		dynamicToolCalls: [],
		toolResults: [],
		staticToolResults: [],
		dynamicToolResults: [],
		finishReason: "stop",
		rawFinishReason: undefined,
		usage,
		totalUsage: usage,
		warnings: undefined,
		request: {},
		response: {
			id: record.rootModel.sessionId,
			timestamp: new Date(),
			modelId: model,
			messages: [],
			body: { primeSeat: record },
		},
		providerMetadata: { prime: record },
		steps: [],
		output,
	};
}

async function parseStructuredYield(
	answer: string,
	schema: AgentGenerateOptions["outputSchema"],
): Promise<unknown> {
	if (schema === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(answer);
	} catch (error) {
		throw new Error(`Prime final yield is not a raw JSON value: ${String(error)}`);
	}
	const result = schema.safeParseAsync !== undefined
		? await schema.safeParseAsync(parsed)
		: schema.safeParse?.(parsed);
	if (result === undefined || !result.success) {
		throw new Error(`Prime final yield does not match the requested schema: ${String(result?.error ?? "validation unavailable")}`);
	}
	return result.data;
}

export class PrimeSeatAgent implements AgentLike {
	readonly cliEngine = "prime";
	readonly supportsNativeStructuredOutput = false;
	readonly tools = {};
	readonly model: string;
	readonly opts: PrimeSeatAgentOptions;
	private preflightPromise: Promise<void> | undefined;

	constructor(opts: PrimeSeatAgentOptions) {
		if (opts.provider !== DECK_PROVIDER) {
			throw new PrimeSeatError({
				status: "failed",
				code: "PRIME_MODEL_MISMATCH",
				message: `Prime seats must use provider ${DECK_PROVIDER}`,
				exitStatus: { code: null, signal: null },
				wallClockMs: 0,
				stderr: "",
			});
		}
		if (opts.binary !== undefined && !path.isAbsolute(opts.binary)) {
			throw new PrimeSeatError({
				status: "failed",
				code: "PRIME_VERSION_MISMATCH",
				message: "Prime seat binary overrides must be absolute paths",
				exitStatus: { code: null, signal: null },
				wallClockMs: 0,
				stderr: "",
			});
		}
		if (!DECK_AGENT_CATALOG.includes(opts.model as never)) {
			throw new PrimeSeatError({
				status: "failed",
				code: "PRIME_MODEL_MISMATCH",
				message: `Prime seat model ${opts.model} is not in the Deck agent catalog`,
				exitStatus: { code: null, signal: null },
				wallClockMs: 0,
				stderr: "",
			});
		}
		const profileName = opts.capabilityProfile ?? "workflow-seat";
		const profile = PRIME_SEAT_CAPABILITY_PROFILES[profileName];
		const requestedTools = opts.tools ?? profile.tools;
		const forbiddenTools = requestedTools.filter((tool) => !profile.tools.includes(tool as never));
		if (profile.dispatch || forbiddenTools.length > 0) {
			throw new PrimeSeatError({
				status: "failed",
				code: "PRIME_CAPABILITY_VIOLATION",
				message: `Prime ${profileName} requested tools outside its no-dispatch capability profile: ${forbiddenTools.join(", ") || "dispatch"}`,
				exitStatus: { code: null, signal: null },
				wallClockMs: 0,
				stderr: "",
			});
		}
		const providerExtension = path.resolve(defaultProviderExtension());
		const forbiddenExtensions = (opts.extensions ?? []).filter(
			(extension) => path.resolve(extension) !== providerExtension,
		);
		if (forbiddenExtensions.length > 0) {
			throw new PrimeSeatError({
				status: "failed",
				code: "PRIME_CAPABILITY_VIOLATION",
				message: `Prime ${profileName} cannot load unreviewed extensions: ${forbiddenExtensions.join(", ")}`,
				exitStatus: { code: null, signal: null },
				wallClockMs: 0,
				stderr: "",
			});
		}
		opts = { ...opts, capabilityProfile: profileName, tools: requestedTools, extensions: [providerExtension] };
		this.opts = opts;
		this.model = opts.model;
	}

	preflight = async (): Promise<void> => {
		this.preflightPromise ??= this.verifyVersion();
		return this.preflightPromise;
	};

	private async verifyVersion(): Promise<void> {
		const startedAt = Date.now();
		const binary = this.opts.binary ?? PRIME_AGENT_BINARY;
		const env = buildSeatEnvironment(process.env, this.opts.env);
		const result = await new Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			const child = spawn(binary, ["--version"], {
				cwd: this.opts.cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
			}, VERSION_TIMEOUT_MS);
			child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
			child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
			child.once("error", reject);
			child.once("close", (code, signal) => {
				clearTimeout(timer);
				resolve({ stdout, stderr, code, signal });
			});
		}).catch((cause) => {
			throw new PrimeSeatError({
				status: "failed",
				code: "PRIME_SPAWN_FAILED",
				message: `Cannot execute ${binary} from PATH`,
				exitStatus: { code: null, signal: null },
				wallClockMs: Date.now() - startedAt,
				stderr: "",
			}, { cause });
		});
		const actual = result.stdout.trim() || result.stderr.trim();
		if (result.code !== 0 || actual !== PRIME_AGENT_VERSION) {
			throw new PrimeSeatError({
				status: "failed",
				code: "PRIME_VERSION_MISMATCH",
				message: `Expected prime-agent ${PRIME_AGENT_VERSION}, got ${actual || `exit ${String(result.code)}`}`,
				exitStatus: { code: result.code, signal: result.signal },
				wallClockMs: Date.now() - startedAt,
				stderr: result.stderr.trim(),
			});
		}
	}

	async generate(options: AgentGenerateOptions = {}): Promise<unknown> {
		await this.preflight();
		const startedAt = Date.now();
		let brokerApiKey: string | undefined;
		try {
			brokerApiKey = await this.loadBrokerApiKey();
		} catch (cause) {
			const failure = new PrimeSeatError({
				status: "failed",
				code: "PRIME_BROKER_AUTH_FAILED",
				message: String(cause),
				exitStatus: { code: null, signal: null },
				wallClockMs: Date.now() - startedAt,
				stderr: "",
			}, { cause });
			await Promise.resolve(options.onEvent?.({
				type: "completed",
				engine: this.cliEngine,
				ok: false,
				error: JSON.stringify(failure.result),
			} as never)).catch(() => undefined);
			throw failure;
		}
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-prime-seat-"));
		const agentDir = path.join(root, "agent");
		const sessionDir = path.join(root, "sessions");
		const seatHome = path.join(root, "home");
		const daemonSocket = path.join(root, "daemon.sock");
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
		await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
		await fs.mkdir(seatHome, { recursive: true, mode: 0o700 });
		const sourceEnv = buildSeatEnvironment(process.env, this.opts.env);
		const gitName = (sourceEnv.GIT_AUTHOR_NAME ?? sourceEnv.USER ?? "deck-seat").replace(/[\r\n]/g, " ");
		const gitEmail = (sourceEnv.GIT_AUTHOR_EMAIL ?? "deck-seat@localhost").replace(/[\r\n]/g, " ");
		await fs.writeFile(
			path.join(seatHome, ".gitconfig"),
			`[user]\n\tname = ${gitName}\n\temail = ${gitEmail}\n[credential]\n\thelper =\n`,
			{ mode: 0o600 },
		);
		const runId = herdrLabelSegment(String(options.taskContext?.runId ?? path.basename(root)));
		const stage = herdrLabelSegment(String(options.taskContext?.nodeId ?? "seat"));
		const effort = herdrLabelSegment(this.opts.effortLabel ?? path.basename(this.opts.cwd));
		const herdrLabel = `${effort} · ${stage} · ${runId}`;
		let herdr: HerdrSeatLease;
		try {
			herdr = await this.attachHerdrSeat(herdrLabel);
		} catch (cause) {
			await fs.rm(root, { recursive: true, force: true });
			throw new PrimeSeatError({
				status: "failed",
				code: "PRIME_HERDR_ATTACH_FAILED",
				message: String(cause),
				exitStatus: { code: null, signal: null },
				wallClockMs: Date.now() - startedAt,
				stderr: "",
			}, { cause });
		}
		const env = withTaskContext({
			...sourceEnv,
			HOME: seatHome,
			GIT_TERMINAL_PROMPT: "0",
			GCM_INTERACTIVE: "never",
			PRIME_AGENT_CODING_AGENT_DIR: agentDir,
			PRIME_AGENT_SESSION_DIR: sessionDir,
			PI_SKIP_VERSION_CHECK: "1",
			RLM_DEPTH: "0",
			RLM_MAX_DEPTH: "1",
			...(brokerApiKey === undefined ? {} : { DECK_GATEWAY_API_KEY: brokerApiKey }),
			HERDR_ENV: "1",
			HERDR_PANE_ID: herdr.paneId,
			HERDR_SOCKET_PATH: herdr.socketPath,
			...(herdr.tabId === undefined ? {} : { HERDR_TAB_ID: herdr.tabId }),
			...(herdr.workspaceId === undefined ? {} : { HERDR_WORKSPACE_ID: herdr.workspaceId }),
		}, options.taskContext);
		const extensions = this.opts.extensions ?? [defaultProviderExtension()];
		const binary = this.opts.binary ?? PRIME_AGENT_BINARY;
		const args = [
			"--mode", "rpc",
			"--cwd", this.opts.cwd,
			"--provider", this.opts.provider,
			"--model", this.opts.model,
			"--thinking", this.opts.thinking ?? "medium",
			"--session-dir", sessionDir,
			"--daemon-socket", daemonSocket,
			"--tools", (this.opts.tools ?? PRIME_WORKFLOW_SEAT_TOOLS).join(","),
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
		];
		for (const extension of extensions) args.push("--extension", extension);
		const daemonArgs = [...args];
		daemonArgs[1] = "daemon";
		const prompt = typeof options.prompt === "string" ? options.prompt : extractText(options.prompt ?? options.messages);
		const timeoutMs = typeof options.timeout === "number" && Number.isFinite(options.timeout)
			? Math.min(options.timeout, this.opts.timeoutMs)
			: this.opts.timeoutMs;
		const idleTimeoutMs = Math.min(this.opts.idleTimeoutMs ?? PRIME_SEAT_IDLE_TIMEOUT_MS, timeoutMs);
		const maxOutputBytes = options.maxOutputBytes ?? this.opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		const terminationGraceMs = this.opts.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
		let stderrTail = "";
		let stdoutBytes = 0;
		let stdoutBuffer = "";
		let finalAnswer = "";
		let rpcSessionId: string | undefined;
		let promptAccepted = false;
		let agentEnded = false;
		let rootModel: RpcModel | null = null;
		let forcedFailure: ForcedFailure | undefined;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		let wallTimer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let steers = 0;
		let stateAfterRequested = false;
		let childExited = false;
		let child: ChildProcessWithoutNullStreams | undefined;
		let daemon: ChildProcessWithoutNullStreams | undefined;
		const emit = (event: Record<string, unknown>) => {
			if (options.onEvent !== undefined) void Promise.resolve(options.onEvent(event as never)).catch(() => undefined);
		};
		const armIdleTimer = () => {
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				void forceStop({
					code: "PRIME_STALLED",
					status: "stalled",
					message: `Prime seat produced no output for ${idleTimeoutMs}ms`,
				});
			}, idleTimeoutMs);
		};
		const forceStop = (failure: ForcedFailure): void => {
			if (forcedFailure !== undefined || childExited) return;
			forcedFailure = failure;
			if (child?.pid !== undefined) {
				signalProcessTree(child.pid, "SIGTERM");
				killTimer = setTimeout(() => signalProcessTree(child?.pid, "SIGKILL"), terminationGraceMs);
			}
		};
		const failProtocol = (code: PrimeSeatFailureCode, message: string): void => {
			void forceStop({ code, message });
		};
		let exitStatus: PrimeSeatExitStatus = { code: null, signal: null };
		let runError: unknown;
		let runRecord: PrimeSeatRunRecord | undefined;
		try {
			daemon = await this.launchIsolatedDaemon(
				binary,
				daemonArgs,
				env,
				Math.min(timeoutMs, DAEMON_SHUTDOWN_TIMEOUT_MS),
				(text) => {
					stderrTail = appendTail(stderrTail, text);
					options.onStderr?.(text);
				},
			);
			const remainingTtlMs = timeoutMs - (Date.now() - startedAt);
			if (remainingTtlMs <= 0) {
				throw new PrimeSeatError({
					status: "failed",
					code: "PRIME_TTL_EXCEEDED",
					message: `Prime seat exceeded its ${timeoutMs}ms root TTL during daemon startup`,
					exitStatus,
					wallClockMs: Date.now() - startedAt,
					stderr: stderrTail.trim(),
				});
			}
			const closed = new Promise<void>((resolve, reject) => {
				try {
					child = spawn(binary, args, {
						cwd: this.opts.cwd,
						env,
						detached: process.platform !== "win32",
						stdio: ["pipe", "pipe", "pipe"],
					});
				} catch (error) {
					reject(error);
					return;
				}
				options.onProcess?.({ phase: "started", pid: child.pid });
				armIdleTimer();
				wallTimer = setTimeout(() => {
					forceStop({
						code: "PRIME_TTL_EXCEEDED",
						message: `Prime seat exceeded its ${timeoutMs}ms root TTL`,
					});
				}, remainingTtlMs);
				const writeRpc = (payload: Record<string, unknown>) => {
					const stdin = child?.stdin;
					if (!stdin?.writable) {
						failProtocol("PRIME_RPC_TRANSPORT_DIED", "Prime RPC stdin closed before the command could be sent");
						return;
					}
					stdin.write(`${JSON.stringify(payload)}\n`);
				};
				const handleLine = (line: string) => {
					if (line.trim() === "") return;
					let parsed: unknown;
					try {
						parsed = JSON.parse(line);
					} catch (error) {
						failProtocol("PRIME_RPC_PROTOCOL", `Prime emitted malformed JSONL: ${String(error)}`);
						return;
					}
					const event = asRecord(parsed);
					if (event === null || typeof event.type !== "string") {
						failProtocol("PRIME_RPC_PROTOCOL", "Prime emitted a non-object RPC record");
						return;
					}
					if (event.type === "response") {
						const id = typeof event.id === "string" ? event.id : "";
						if (event.success !== true) {
							failProtocol("PRIME_RPC_PROTOCOL", `Prime rejected ${String(event.command ?? id)}: ${String(event.error ?? "unknown error")}`);
							return;
						}
						if (id === "deck-state-before") {
							try {
								rootModel = assertPinnedModel(modelFromRpcState(event), this.opts.provider, this.opts.model);
							} catch (error) {
								failProtocol("PRIME_MODEL_MISMATCH", String(error));
								return;
							}
							writeRpc({ id: "deck-prompt", type: "prompt", message: prompt });
						} else if (id === "deck-prompt") {
							promptAccepted = true;
						} else if (id === "deck-state-after") {
							try {
								rootModel = assertPinnedModel(modelFromRpcState(event), this.opts.provider, this.opts.model);
							} catch (error) {
								failProtocol("PRIME_MODEL_MISMATCH", String(error));
								return;
							}
							child?.stdin.end();
						}
						return;
					}
					if (event.type === "session") {
						rpcSessionId = typeof event.id === "string" ? event.id : rpcSessionId;
						emit({
							type: "started",
							engine: this.cliEngine,
							title: "Prime Agent",
							resume: rpcSessionId,
							detail: {
								version: PRIME_AGENT_VERSION,
								requestedModel: `${this.opts.provider}/${this.opts.model}`,
							},
						});
						return;
					}
					if (event.type === "message_update") {
						const assistantEvent = asRecord(event.assistantMessageEvent);
						if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
							finalAnswer += assistantEvent.delta;
						}
						return;
					}
					if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
						const phase = event.type === "tool_execution_start"
							? "started"
							: event.type === "tool_execution_update"
								? "updated"
								: "completed";
						emit({
							type: "action",
							engine: this.cliEngine,
							phase,
							entryType: "thought",
							action: {
								id: String(event.toolCallId ?? event.toolName ?? "prime-tool"),
								kind: "tool",
								title: String(event.toolName ?? "tool"),
								detail: phase === "completed" ? { result: extractText(event.result) } : { args: event.args },
							},
							ok: phase === "completed" ? event.isError !== true : undefined,
						});
						return;
					}
					if (event.type === "session_action_update") {
						const actions = asRecord(event.actions);
						const steering = Array.isArray(actions?.steering) ? actions.steering.length : 0;
						steers = Math.max(steers, steering);
						return;
					}
					if (event.type === "agent_end") {
						const messages = Array.isArray(event.messages) ? event.messages : [];
						for (let index = messages.length - 1; index >= 0; index -= 1) {
							const message = asRecord(messages[index]);
							if (message?.role === "assistant") {
								const text = extractText(message);
								if (text !== "") finalAnswer = text;
								break;
							}
						}
						agentEnded = true;
						if (!stateAfterRequested) {
							stateAfterRequested = true;
							writeRpc({ id: "deck-state-after", type: "get_state" });
						}
					}
				};
				child.stdout.on("data", (chunk: Buffer) => {
					const text = chunk.toString("utf8");
					stdoutBytes += chunk.byteLength;
					options.onStdout?.(text);
					armIdleTimer();
					if (stdoutBytes > maxOutputBytes) {
						forceStop({ code: "PRIME_OUTPUT_LIMIT", message: `Prime RPC output exceeded ${maxOutputBytes} bytes` });
						return;
					}
					stdoutBuffer += text;
					let newline = stdoutBuffer.indexOf("\n");
					while (newline >= 0) {
						const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
						stdoutBuffer = stdoutBuffer.slice(newline + 1);
						handleLine(line);
						newline = stdoutBuffer.indexOf("\n");
					}
				});
				child.stderr.on("data", (chunk: Buffer) => {
					const text = chunk.toString("utf8");
					stderrTail = appendTail(stderrTail, text);
					options.onStderr?.(text);
					armIdleTimer();
				});
				child.once("error", (error) => {
					forcedFailure ??= { code: "PRIME_SPAWN_FAILED", message: String(error) };
					reject(error);
				});
				child.once("spawn", () => {
					writeRpc({ id: "deck-state-before", type: "get_state" });
				});
				child.once("close", (code, signal) => {
					childExited = true;
					exitStatus = { code, signal };
					clearTimeout(idleTimer);
					clearTimeout(wallTimer);
					clearTimeout(killTimer);
					options.onProcess?.({ phase: "exited", pid: child?.pid });
					if (stdoutBuffer.trim() !== "" && forcedFailure === undefined) {
						forcedFailure = { code: "PRIME_RPC_PROTOCOL", message: "Prime RPC closed with an incomplete JSONL record" };
					}
					resolve();
				});
			});
			await closed;
			if (forcedFailure !== undefined) {
				throw new PrimeSeatError({
					status: forcedFailure.status ?? "failed",
					code: forcedFailure.code,
					message: forcedFailure.message,
					exitStatus,
					wallClockMs: Date.now() - startedAt,
					stderr: stderrTail.trim(),
				});
			}
			if (exitStatus.code !== 0 || exitStatus.signal !== null || !promptAccepted || !agentEnded) {
				throw new PrimeSeatError({
					status: "failed",
					code: "PRIME_RPC_TRANSPORT_DIED",
					message: !promptAccepted
						? "Prime RPC transport died before accepting the prompt"
						: !agentEnded
							? "Prime RPC transport died before agent_end"
							: `Prime exited with ${String(exitStatus.code ?? exitStatus.signal)}`,
					exitStatus,
					wallClockMs: Date.now() - startedAt,
					stderr: stderrTail.trim(),
				});
			}
			if (rootModel === null) {
				throw new PrimeSeatError({
					status: "failed",
					code: "PRIME_MISSING_PROVENANCE",
					message: "Prime completed without root model provenance",
					exitStatus,
					wallClockMs: Date.now() - startedAt,
					stderr: stderrTail.trim(),
				});
			}
			if (finalAnswer.trim() === "") {
				throw new PrimeSeatError({
					status: "failed",
					code: "PRIME_MISSING_YIELD",
					message: "Prime completed without a final assistant yield",
					exitStatus,
					wallClockMs: Date.now() - startedAt,
					stderr: stderrTail.trim(),
				});
			}
			let output: unknown;
			try {
				output = await parseStructuredYield(finalAnswer.trim(), options.outputSchema);
			} catch (cause) {
				throw new PrimeSeatError({
					status: "failed",
					code: "PRIME_MALFORMED_YIELD",
					message: String(cause),
					exitStatus,
					wallClockMs: Date.now() - startedAt,
					stderr: stderrTail.trim(),
				}, { cause });
			}
			let attestation: Awaited<ReturnType<typeof attestTranscripts>>;
			try {
				const profile = PRIME_SEAT_CAPABILITY_PROFILES[this.opts.capabilityProfile ?? "workflow-seat"];
				attestation = await attestTranscripts(root, rootModel, rpcSessionId, profile.rlmMaxDepth);
			} catch (cause) {
				const message = String(cause);
				throw new PrimeSeatError({
					status: "failed",
					code: message.includes("Child session") ? "PRIME_CHILD_MODEL_INVALID" : "PRIME_MISSING_PROVENANCE",
					message,
					exitStatus,
					wallClockMs: Date.now() - startedAt,
					stderr: stderrTail.trim(),
				}, { cause });
			}
			runRecord = {
				engine: "prime",
				version: PRIME_AGENT_VERSION,
				requestedModel: `${this.opts.provider}/${this.opts.model}`,
				rootModel: attestation.rootModel,
				herdr: {
					paneId: herdr.paneId,
					label: herdr.label,
				},
				childModels: attestation.childModels,
				exitStatus,
				wallClockMs: Date.now() - startedAt,
				steers,
				tokens: attestation.usage,
			};
			emit({
				type: "action",
				engine: this.cliEngine,
				phase: "completed",
				entryType: "thought",
				action: {
					id: "prime-model-provenance",
					kind: "turn",
					title: "Prime model provenance",
					detail: {
						root: runRecord.rootModel,
						children: runRecord.childModels,
						exitStatus: runRecord.exitStatus,
						wallClockMs: runRecord.wallClockMs,
					},
				},
				ok: true,
			});
			emit({
				type: "completed",
				engine: this.cliEngine,
				ok: true,
				answer: finalAnswer.trim(),
				resume: runRecord.rootModel.sessionId,
				usage: runRecord.tokens,
			});
			return buildGenerateResult(finalAnswer.trim(), output, this.opts.model, runRecord);
		} catch (error) {
			runError = error;
			const primeError = error instanceof PrimeSeatError
				? error
				: new PrimeSeatError({
					status: "failed",
					code: "PRIME_SPAWN_FAILED",
					message: String(error),
					exitStatus,
					wallClockMs: Date.now() - startedAt,
					stderr: stderrTail.trim(),
				}, { cause: error });
			emit({
				type: "completed",
				engine: this.cliEngine,
				ok: false,
				error: JSON.stringify(primeError.result),
			});
			throw primeError;
		} finally {
			try {
				await this.shutdownIsolatedDaemon(daemon, daemonSocket, terminationGraceMs);
				await herdrRequest(herdr.socketPath, "pane.close", { pane_id: herdr.paneId });
			} catch (cause) {
				if (runError === undefined && runRecord !== undefined) {
					throw new PrimeSeatError({
						status: "failed",
						code: "PRIME_DAEMON_TEARDOWN_FAILED",
						message: String(cause),
						exitStatus,
						wallClockMs: Date.now() - startedAt,
						stderr: stderrTail.trim(),
					}, { cause });
				}
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	}

	private async loadBrokerApiKey(): Promise<string | undefined> {
		if (this.opts.brokerApiKey !== undefined) {
			if (this.opts.brokerApiKey.trim() === "") throw new Error("Deck broker token is empty");
			return this.opts.brokerApiKey;
		}
		if (this.opts.binary !== undefined) return undefined;
		const tokenPath = process.env.DECK_GATEWAY_TOKEN_FILE
			?? path.join(os.homedir(), ".deck", "broker", "gateway.token");
		const token = (await fs.readFile(tokenPath, "utf8")).trim();
		if (token === "") throw new Error(`Deck broker token is empty: ${tokenPath}`);
		return token;
	}

	private async attachHerdrSeat(label: string): Promise<HerdrSeatLease> {
		const socketPath = process.env.HERDR_SOCKET_PATH;
		const parentPaneId = process.env.HERDR_PANE_ID;
		if (socketPath === undefined || parentPaneId === undefined || process.env.HERDR_ENV !== "1") {
			throw new Error("Prime seats require an active Herdr socket and parent pane");
		}
		const result = await herdrRequest(socketPath, "pane.split", {
			target_pane_id: parentPaneId,
			direction: "down",
			ratio: 0.2,
			cwd: this.opts.cwd,
			focus: false,
			env: {},
		});
		const pane = asRecord(result.pane);
		const paneId = typeof pane?.pane_id === "string" ? pane.pane_id : undefined;
		if (paneId === undefined) throw new Error("Herdr pane.split returned no pane id");
		try {
			await herdrRequest(socketPath, "pane.rename", { pane_id: paneId, label });
		} catch (cause) {
			await herdrRequest(socketPath, "pane.close", { pane_id: paneId }).catch(() => undefined);
			throw cause;
		}
		return {
			socketPath,
			parentPaneId,
			paneId,
			label,
			...(typeof pane?.tab_id === "string" ? { tabId: pane.tab_id } : {}),
			...(typeof pane?.workspace_id === "string" ? { workspaceId: pane.workspace_id } : {}),
		};
	}

	private async launchIsolatedDaemon(
		binary: string,
		args: string[],
		env: Record<string, string>,
		timeoutMs: number,
		onStderr: (text: string) => void,
	): Promise<ChildProcessWithoutNullStreams> {
		const daemon = spawn(binary, args, {
			cwd: this.opts.cwd,
			env,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		daemon.stderr.on("data", (chunk: Buffer) => onStderr(chunk.toString("utf8")));
		const socketPath = args[args.indexOf("--daemon-socket") + 1];
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				signalProcessTree(daemon.pid, "SIGKILL");
				reject(new Error(`isolated Prime daemon did not accept connections within ${timeoutMs}ms`));
			}, timeoutMs);
			const finish = (error?: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				daemon.off("error", finish);
				daemon.off("close", onClose);
				if (error === undefined) resolve();
				else reject(error);
			};
			const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
				finish(new Error(`isolated Prime daemon exited during startup (${String(code ?? signal)})`));
			};
			const probe = () => {
				if (settled) return;
				const socket = createConnection(socketPath);
				socket.once("connect", () => {
					socket.destroy();
					finish();
				});
				socket.once("error", () => {
					socket.destroy();
					setTimeout(probe, 20);
				});
			};
			daemon.once("error", finish);
			daemon.once("close", onClose);
			probe();
		});
		return daemon;
	}

	private async shutdownIsolatedDaemon(
		daemon: ChildProcessWithoutNullStreams | undefined,
		daemonSocket: string,
		terminationGraceMs: number,
	): Promise<void> {
		if (daemon === undefined || daemon.exitCode !== null || daemon.signalCode !== null) return;
		let shutdownAcknowledged = false;
		try {
			await fs.access(daemonSocket);
			shutdownAcknowledged = await new Promise<boolean>((resolve) => {
				const socket = createConnection(daemonSocket);
				let buffer = "";
				const timer = setTimeout(() => {
					socket.destroy();
					resolve(false);
				}, DAEMON_SHUTDOWN_TIMEOUT_MS);
				socket.once("connect", () => {
					socket.write(`${JSON.stringify({ id: "deck-seat-shutdown", type: "shutdown", force: true })}\n`);
				});
				socket.on("data", (chunk: Buffer) => {
					buffer += chunk.toString("utf8");
					let newline = buffer.indexOf("\n");
					while (newline >= 0) {
						const line = buffer.slice(0, newline).replace(/\r$/, "");
						buffer = buffer.slice(newline + 1);
						try {
							const response = asRecord(JSON.parse(line));
							if (response?.id === "deck-seat-shutdown" && response.success === true) {
								clearTimeout(timer);
								socket.end();
								resolve(true);
								return;
							}
						} catch {
							// Ignore daemon hello and unrelated lifecycle events.
						}
						newline = buffer.indexOf("\n");
					}
				});
				socket.once("error", () => {
					clearTimeout(timer);
					resolve(false);
				});
			});
		} catch {
			shutdownAcknowledged = false;
		}
		const waitForExit = (timeoutMs: number) => new Promise<boolean>((resolve) => {
			if (daemon.exitCode !== null || daemon.signalCode !== null) {
				resolve(true);
				return;
			}
			const timer = setTimeout(() => {
				daemon.off("close", onClose);
				resolve(false);
			}, timeoutMs);
			const onClose = () => {
				clearTimeout(timer);
				resolve(true);
			};
			daemon.once("close", onClose);
		});
		if (shutdownAcknowledged && await waitForExit(DAEMON_SHUTDOWN_TIMEOUT_MS)) return;
		signalProcessTree(daemon.pid, "SIGTERM");
		if (await waitForExit(terminationGraceMs)) return;
		signalProcessTree(daemon.pid, "SIGKILL");
		if (!await waitForExit(DAEMON_SHUTDOWN_TIMEOUT_MS)) {
			throw new Error(`isolated Prime daemon ${String(daemon.pid)} survived SIGKILL`);
		}
	}
}
