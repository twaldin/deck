import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { assertProductWorkspace } from "../workflows/pr-pipeline/lib/workspace-guard";
import type { ProjectProfile } from "../workflows/pr-pipeline/lib/profiles";
import { z } from "../broker/node_modules/zod";

const PINNED_VERSION = "0.7.0";
const PINNED_TAG = "v0.7.0";
const PINNED_COMMIT = "be9e2fa0714e7cd1c6bd9bdb1b554d2cc6550387";
const INSTALLER = path.join(import.meta.dir, "install-prime-conversation.sh");
const SEED = fs.readFileSync(path.join(import.meta.dir, "..", "v2", "seed", "AGENTS.md"), "utf8");
const liveBrokerTest = process.env.DECK_LIVE_BROKER_CHECK === "1" ? test : test.skip;

let root: string;
let home: string;
let deckHome: string;
let agentDir: string;
let wrapper: string;
let daemonSocket: string;
let primeBinary: string;
let installEnv: NodeJS.ProcessEnv;

function executableOnPath(name: string): string {
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		if (directory === "") continue;
		const candidate = path.join(directory, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// Continue through PATH.
		}
	}
	throw new Error(`${name} is required for the Prime conversation guard`);
}

function combinedOutput(command: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; output: string } {
	const result = spawnSync(command, args, { env, encoding: "utf8" });
	return {
		status: result.status,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
	};
}

const RpcFrameSchema = z.looseObject({
	command: z.string().optional(),
	success: z.boolean().optional(),
	data: z.unknown().optional(),
});
type RpcFrame = z.infer<typeof RpcFrameSchema>;

const ModelsDataSchema = z.object({
	models: z.array(z.looseObject({ provider: z.string() })),
});
const StateDataSchema = z.object({
	model: z.object({ provider: z.string() }),
});
const ProbeOutputSchema = z.object({
	cwd: z.string(),
	systemPrompt: z.string(),
	tools: z.array(z.string()),
	gatewayToken: z.string().nullable(),
	tokenStore: z.string().nullable(),
	stampToken: z.string().nullable(),
	publisherToken: z.string().nullable(),
	adminToken: z.string().nullable(),
	skipVersionCheck: z.string(),
	offline: z.string(),
	maxDepth: z.string(),
	agentDir: z.string(),
	sessionDir: z.string(),
});

const ManifestSchema = z.object({
	profile: z.string(),
	primeAgentVersion: z.string(),
	primeAgentTag: z.string(),
	primeAgentCommit: z.string(),
	primeAgentBin: z.string(),
	deckRepo: z.string(),
	custodySha256: z.string(),
});
const TranscriptEntrySchema = z.looseObject({
	type: z.string(),
	provider: z.string().optional(),
	modelId: z.string().optional(),
});

const SettingsSchema = z.object({
	defaultProvider: z.literal("deck"),
	enabledModels: z.tuple([z.literal("deck/*")]),
	autoRefine: z.object({ enabled: z.literal(false) }),
});
const AuthStoreSchema = z.record(z.string(), z.unknown());

function rpcFrames(output: string): RpcFrame[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("{"))
		.map((line) => RpcFrameSchema.parse(JSON.parse(line)));
}

function deckModels(frames: RpcFrame[]): Array<z.infer<typeof ModelsDataSchema>["models"][number]> {
	const response = frames.find((frame) => frame.command === "get_available_models" && frame.success === true);
	if (response === undefined) return [];
	const parsed = ModelsDataSchema.safeParse(response.data);
	return parsed.success ? parsed.data.models.filter((model) => model.provider === "deck") : [];
}

function selectedProvider(frames: RpcFrame[]): string | undefined {
	const response = frames.find((frame) => frame.command === "get_state" && frame.success === true);
	if (response === undefined) return undefined;
	const parsed = StateDataSchema.safeParse(response.data);
	return parsed.success ? parsed.data.model.provider : undefined;
}

type RpcResult = { stdout: string; stderr: string };

function runRpc(
	args: string[],
	requests: Record<string, unknown>[],
	env: NodeJS.ProcessEnv,
): Promise<RpcResult> {
	const { promise, resolve, reject } = Promise.withResolvers<RpcResult>();
	const child = spawn(wrapper, args, {
		cwd: root,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.once("error", reject);
	child.once("close", (code) => {
		if (code !== 0) {
			reject(new Error(`Prime RPC exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
			return;
		}
		resolve({ stdout, stderr });
	});
	child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
	return promise;
}

const HerdrRequestSchema = z.looseObject({
	method: z.string().optional(),
	params: z.looseObject({
		pane_id: z.string().optional(),
		workspace_id: z.string().optional(),
		tab_id: z.string().optional(),
		source: z.string().optional(),
		agent: z.string().optional(),
		state: z.enum(["working", "idle", "blocked"]).optional(),
	}).optional(),
});
type HerdrRequest = z.infer<typeof HerdrRequestSchema>;
type HerdrStub = {
	requests: HerdrRequest[];
	close(): Promise<void>;
};

function startHerdrStub(socketPath: string): Promise<HerdrStub> {
	const { promise, resolve, reject } = Promise.withResolvers<HerdrStub>();
	fs.rmSync(socketPath, { force: true });
	const requests: HerdrRequest[] = [];
	const server = net.createServer((connection) => {
		connection.setEncoding("utf8");
		let buffered = "";
		connection.on("data", (chunk: string) => {
			buffered += chunk;
			for (;;) {
				const newline = buffered.indexOf("\n");
				if (newline < 0) break;
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				requests.push(HerdrRequestSchema.parse(JSON.parse(line)));
				connection.end('{"ok":true}\n');
			}
		});
	});
	server.once("error", reject);
	server.listen(socketPath, () => {
		resolve({
			requests,
			close: () => {
				const settled = Promise.withResolvers<void>();
				server.close((error) => error === undefined ? settled.resolve() : settled.reject(error));
				return settled.promise;
			},
		});
	});
	return promise;
}

beforeAll(() => {
	primeBinary = process.env.PRIME_CONVERSATION_PRIME_BIN ?? executableOnPath("prime-agent");
	root = fs.mkdtempSync("/tmp/deck-prime-conv-");
	home = path.join(root, "home");
	deckHome = path.join(home, ".deck");
	agentDir = path.join(deckHome, ".prime", "agent");
	wrapper = path.join(deckHome, ".prime", "bin", "prime-conversation");
	daemonSocket = path.join(deckHome, ".prime", "run", "conversation.sock");
	fs.mkdirSync(deckHome, { recursive: true });
	fs.writeFileSync(path.join(deckHome, "AGENTS.md"), SEED);
	const memo = path.join(home, ".optmem", "memo");
	fs.mkdirSync(path.dirname(memo), { recursive: true });
	fs.writeFileSync(memo, `#!/bin/sh
if [ "\${1:-}" = wake ]; then
  printf 'wake\\n' >> "$HOME/.optmem/wake.log"
  printf 'PRIME_CONVERSATION_OPTMEM_WAKE\\n'
  exit 0
fi
exit 2
`, { mode: 0o700 });
	const brokerToken = path.join(deckHome, "broker", "gateway.token");
	fs.mkdirSync(path.dirname(brokerToken), { recursive: true });
	fs.writeFileSync(brokerToken, "sandbox-broker-token\n", { mode: 0o600 });
	installEnv = {
		...process.env,
		HOME: home,
		PRIME_CONVERSATION_HOME: deckHome,
		PRIME_CONVERSATION_PRIME_BIN: primeBinary,
		HERDR_ENV: "0",
		HERDR_PANE_ID: "",
		HERDR_SOCKET_PATH: "",
		HERDR_TAB_ID: "",
		HERDR_WORKSPACE_ID: "",
	};
	const first = combinedOutput("bash", [INSTALLER, "--apply"], installEnv);
	if (first.status !== 0) throw new Error(first.output);
	const second = combinedOutput("bash", [INSTALLER, "--apply"], installEnv);
	if (second.status !== 0) throw new Error(`idempotent reinstall failed: ${second.output}`);
}, 30_000);

afterAll(() => {
	if (wrapper !== undefined && fs.existsSync(wrapper)) {
		spawnSync(wrapper, ["shutdown"], {
			env: { ...installEnv, HERDR_ENV: "0" },
			encoding: "utf8",
			timeout: 10_000,
		});
	}
	if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

describe("Prime conversation installer", () => {
	test("is dry-run by default and claims no sandbox paths", () => {
		const dryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deck-prime-dry-"));
		try {
			const dryHome = path.join(dryRoot, "home");
			fs.mkdirSync(dryHome);
			const result = combinedOutput("bash", [INSTALLER], {
				...installEnv,
				HOME: dryHome,
				PRIME_CONVERSATION_HOME: path.join(dryHome, ".deck"),
			});
			expect(result.status).toBe(0);
			expect(result.output).toContain("DRY RUN — no files will be changed");
			expect(result.output).toContain(`${PINNED_VERSION}, ${PINNED_TAG}, ${PINNED_COMMIT}`);
			expect(fs.existsSync(path.join(dryHome, ".deck"))).toBe(false);
		} finally {
			fs.rmSync(dryRoot, { recursive: true, force: true });
		}
	});

	test("refuses apply when the Deck home seed is missing or stale", () => {
		const invalidRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deck-prime-seed-"));
		try {
			const invalidDeckHome = path.join(invalidRoot, "home", ".deck");
			fs.mkdirSync(invalidDeckHome, { recursive: true });
			fs.writeFileSync(path.join(invalidDeckHome, "AGENTS.md"), "stale seed\n");
			const result = combinedOutput("bash", [INSTALLER, "--apply"], {
				...installEnv,
				HOME: path.dirname(invalidDeckHome),
				PRIME_CONVERSATION_HOME: invalidDeckHome,
			});
			expect(result.status).toBe(1);
			expect(result.output).toContain("must exactly match the Deck v4 seed");
			expect(fs.existsSync(path.join(invalidDeckHome, ".prime"))).toBe(false);
		} finally {
			fs.rmSync(invalidRoot, { recursive: true, force: true });
		}
	});

	test("mirrors only the approved Deck extension layout", () => {
		const extensions = path.join(agentDir, "extensions");
		for (const name of ["deck-questions", "deck-ship", "deck-recall"]) {
			const entry = path.join(extensions, name, "index.ts");
			expect(fs.realpathSync(entry)).toBe(fs.realpathSync(path.join(import.meta.dir, "..", "extensions-pi", `${name}.ts`)));
		}
		expect(fs.realpathSync(path.join(extensions, "deck-provider.ts"))).toBe(
			fs.realpathSync(path.join(import.meta.dir, "..", "broker", "pi", "deck-provider.ts")),
		);
		expect(fs.realpathSync(path.join(extensions, "node_modules", "zod"))).toBe(
			fs.realpathSync(path.join(import.meta.dir, "..", "broker", "node_modules", "zod")),
		);
		expect(fs.existsSync(path.join(extensions, "deck-subagents"))).toBe(false);
		expect(fs.existsSync(path.join(extensions, "subagent"))).toBe(false);
		expect(fs.existsSync(path.join(extensions, "herdr-agent-state.ts"))).toBe(false);
	});
});

describe("Prime conversation runtime guards", () => {
	test("loads Deck tools/provider, OptMem wake, custody base prompt, and the cwd seed", async () => {
		const probePath = path.join(agentDir, "extensions", "profile-probe.ts");
		const probeOutput = path.join(root, "profile-probe.json");
		fs.writeFileSync(probePath, `import * as fs from "node:fs";
interface ToolInfo { name: string }
interface ProbeContext { getSystemPrompt(): string }
interface ProbeApi {
  getAllTools(): ToolInfo[];
  on(event: string, handler: (event: unknown, context: ProbeContext) => void): void;
}
export default function profileProbe(pi: ProbeApi): void {
  pi.on("session_start", (_event, context) => {
    const output = process.env.PRIME_CONVERSATION_PROBE;
    if (output === undefined) return;
    fs.writeFileSync(output, JSON.stringify({
      cwd: process.cwd(),
      systemPrompt: context.getSystemPrompt(),
      tools: pi.getAllTools().map((tool) => tool.name).sort(),
      gatewayToken: process.env.SMITHERS_GATEWAY_TOKEN ?? null,
      tokenStore: process.env.SMITHERS_TOKEN_STORE ?? null,
      stampToken: process.env.DECK_STAMP_TOKEN ?? null,
      publisherToken: process.env.DECK_PUBLISHER_TOKEN ?? null,
      adminToken: process.env.ADMIN_TOKEN ?? null,
      skipVersionCheck: process.env.PI_SKIP_VERSION_CHECK,
      offline: process.env.PI_OFFLINE,
      maxDepth: process.env.RLM_MAX_DEPTH,
      agentDir: process.env.PRIME_AGENT_CODING_AGENT_DIR,
      sessionDir: process.env.PRIME_AGENT_SESSION_DIR,
    }, null, 2));
  });
}
`);
		const herdrSocket = path.join(root, "herdr-probe.sock");
		const herdr = await startHerdrStub(herdrSocket);
		try {
			const result = await runRpc(
				["--mode", "rpc", "--no-session"],
				[
					{ id: "models", type: "get_available_models" },
					{ id: "state", type: "get_state" },
				],
				{
					...installEnv,
					PRIME_CONVERSATION_PROBE: probeOutput,
					SMITHERS_GATEWAY_TOKEN: "must-not-reach-prime",
					SMITHERS_TOKEN_STORE: path.join(root, "must-not-reach-prime.json"),
					DECK_STAMP_TOKEN: "must-not-reach-prime",
					DECK_PUBLISHER_TOKEN: "must-not-reach-prime",
					ADMIN_TOKEN: "must-not-reach-prime",
					HERDR_ENV: "1",
					HERDR_PANE_ID: "captain-probe",
					HERDR_SOCKET_PATH: herdrSocket,
					HERDR_WORKSPACE_ID: "prime-conversation-sandbox",
					HERDR_TAB_ID: "profile-probe",
				},
			);
			const frames = rpcFrames(result.stdout);
			expect(deckModels(frames).length).toBeGreaterThan(0);
			expect(selectedProvider(frames)).toBe("deck");
			const probe = ProbeOutputSchema.parse(JSON.parse(fs.readFileSync(probeOutput, "utf8")));
			expect(probe.cwd).toBe(fs.realpathSync(deckHome));
			expect(probe.agentDir).toBe(agentDir);
			expect(probe.sessionDir).toBe(path.join(deckHome, ".prime", "sessions"));
			expect(probe.gatewayToken).toBeNull();
			expect(probe.tokenStore).toBeNull();
			expect(probe.stampToken).toBeNull();
			expect(probe.publisherToken).toBeNull();
			expect(probe.adminToken).toBeNull();
			expect(probe.skipVersionCheck).toBe("1");
			expect(probe.offline).toBe("1");
			expect(probe.maxDepth).toBe("1");
			expect(probe.tools).toEqual(expect.arrayContaining([
				"list_questions",
				"answer_question",
				"ship",
				"adopt",
				"status",
				"recall_effort",
			]));
			expect(probe.tools).not.toContain("subagent");
			expect(typeof probe.systemPrompt).toBe("string");
			if (typeof probe.systemPrompt !== "string") throw new Error("system prompt missing from probe");
			const custody = fs.readFileSync(path.join(agentDir, "APPEND_SYSTEM.md"), "utf8").trim();
			expect(probe.systemPrompt).toContain(custody);
			expect(probe.systemPrompt).toContain(SEED.trim());
			expect(probe.systemPrompt).toContain("PRIME CONVERSATION CUSTODY CONTRACT v1");
			expect(fs.readFileSync(path.join(home, ".optmem", "wake.log"), "utf8")).toContain("wake");
			expect(fs.existsSync(daemonSocket)).toBe(true);
			const herdrReport = herdr.requests.find((request) => request.method === "pane.report_agent");
			expect(herdrReport?.params?.source).toBe("herdr:pi");
			expect(herdrReport?.params?.pane_id).toBe("captain-probe");
			expect(herdrReport?.params?.state).toBe("idle");
		} finally {
			fs.rmSync(probePath, { force: true });
			await herdr.close();
		}
	}, 30_000);

	test("keeps built-in Herdr reports scoped across concurrent RPC sessions", async () => {
		const herdrSocket = path.join(root, "herdr-concurrent.sock");
		const herdr = await startHerdrStub(herdrSocket);
		try {
			await Promise.all(["captain-a", "captain-b"].map((pane) =>
				runRpc(
					["--mode", "rpc", "--no-session"],
					[{ id: `state-${pane}`, type: "get_state" }],
					{
						...installEnv,
						HERDR_ENV: "1",
						HERDR_PANE_ID: pane,
						HERDR_SOCKET_PATH: herdrSocket,
						HERDR_WORKSPACE_ID: "prime-conversation-sandbox",
						HERDR_TAB_ID: `tab-${pane}`,
					},
				),
			));
			for (const pane of ["captain-a", "captain-b"]) {
				const requests = herdr.requests.filter((request) => request.params?.pane_id === pane);
				expect(requests.some((request) => request.method === "pane.report_agent")).toBe(true);
				expect(requests.some((request) => request.method === "pane.release_agent")).toBe(true);
				expect(requests.every((request) => request.params?.source === "herdr:pi")).toBe(true);
			}
		} finally {
			await herdr.close();
		}
	}, 30_000);

	liveBrokerTest("opt-in: routes a real pinned-model completion through the Deck broker", () => {
		const sessionsDir = path.join(deckHome, ".prime", "sessions");
		const suppliedToken = process.env.DECK_LIVE_BROKER_TOKEN;
		if (suppliedToken === undefined || suppliedToken.trim() === "") {
			throw new Error("DECK_LIVE_BROKER_TOKEN is required when DECK_LIVE_BROKER_CHECK=1");
		}
		const brokerToken = path.join(deckHome, "broker", "gateway.token");
		fs.writeFileSync(brokerToken, `${suppliedToken.trim()}\n`, { mode: 0o600 });
		const before = new Set(fs.readdirSync(sessionsDir).filter((name) => name.endsWith(".jsonl")));
		const result = combinedOutput(wrapper, [
			"--print",
			"--model",
			"claude-haiku-4-5",
			"Reply with exactly PRIME_BROKER_ROUTE_OK",
		], installEnv);
		expect(result.status).toBe(0);
		expect(result.output.length).toBeGreaterThan(0);
		const created = fs.readdirSync(sessionsDir)
			.filter((name) => name.endsWith(".jsonl") && !before.has(name));
		expect(created).toHaveLength(1);
		const entries = fs.readFileSync(path.join(sessionsDir, created[0]!), "utf8")
			.trim()
			.split("\n")
			.map((line) => TranscriptEntrySchema.parse(JSON.parse(line)));
		expect(entries).toContainEqual(expect.objectContaining({
			type: "model_change",
			provider: "deck",
			modelId: "claude-haiku-4-5",
		}));
		fs.writeFileSync(brokerToken, "sandbox-broker-token\n", { mode: 0o600 });
	}, 30_000);
	test("rejects the ship-bypass path and carries no stamp authority", () => {
		const productionProfile: ProjectProfile = {
			id: "lindy",
			repo: "lindy-ai/lindy",
			primary: path.join(root, "lindy"),
			pipeline: "lindy-full",
			yolo: false,
			stamp: true,
			production: true,
			knowledge: [],
			depsWarm: false,
		};
		expect(() => assertProductWorkspace({
			repo: productionProfile.repo,

			profile: productionProfile,
			dryRun: false,
			workspaceRoot: deckHome,
			home,
		})).toThrow("PRODUCT WORKSPACE REFUSED");
		const authStore = AuthStoreSchema.parse(
			JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")),
		);
		expect(authStore).toEqual({});
		expect(fs.existsSync(path.join(agentDir, "gateway.token"))).toBe(false);
		for (const command of ["update", "package"]) {
			const rejected = combinedOutput(wrapper, [command], installEnv);
			expect(rejected.status).not.toBe(0);
			expect(rejected.output).toContain(`${command} is disabled`);
		}
		for (const fixed of [
			"--daemon-socket",
			"--cwd",
			"--session-dir",
			"--system-prompt",
			"--append-system-prompt",
			"--provider",
			"--extension",
			"-e",
			"--models",
			"--resume",
			"-r",
			"--fork",
		]) {
			const rejected = combinedOutput(wrapper, [fixed, "bypass"], installEnv);
			expect(rejected.status).toBe(2);
			expect(rejected.output).toContain("is fixed by the prime conversation profile");
		}
	});

	test("keeps custody immutable while /refine owns writable supplemental state", () => {
		const custody = path.join(agentDir, "APPEND_SYSTEM.md");
		const harness = path.join(agentDir, "harness");
		expect(fs.statSync(custody).mode & 0o222).toBe(0);
		expect(fs.statSync(harness).mode & 0o700).toBe(0o700);
		const manifest = ManifestSchema.parse(
			JSON.parse(fs.readFileSync(path.join(agentDir, "deck-prime-conversation.json"), "utf8")),
		);
		const digest = createHash("sha256").update(fs.readFileSync(custody)).digest("hex");
		expect(manifest.custodySha256).toBe(digest);
		const settings = SettingsSchema.parse(
			JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")),
		);
		expect(settings).toEqual({
			defaultProvider: "deck",
			enabledModels: ["deck/*"],
			autoRefine: { enabled: false },
		});
		const originalCustody = fs.readFileSync(custody);
		try {
			fs.chmodSync(custody, 0o600);
			fs.appendFileSync(custody, "\nTAMPERED\n");
			fs.chmodSync(custody, 0o444);
			const rejected = combinedOutput(wrapper, ["--version"], installEnv);
			expect(rejected.status).toBe(1);
			expect(rejected.output).toContain("custody prompt failed its launch digest check");
		} finally {
			fs.chmodSync(custody, 0o600);
			fs.writeFileSync(custody, originalCustody);
			fs.chmodSync(custody, 0o444);
		}
		const guard = path.join(agentDir, "extensions", "prime-conversation-guard.ts");
		const originalGuard = fs.readFileSync(guard);
		try {
			fs.chmodSync(guard, 0o600);
			fs.appendFileSync(guard, "\n// tampered\n");
			fs.chmodSync(guard, 0o444);
			const rejected = combinedOutput(wrapper, ["--version"], installEnv);
			expect(rejected.status).toBe(1);
			expect(rejected.output).toContain("provider guard failed its launch digest check");
		} finally {
			fs.chmodSync(guard, 0o600);
			fs.writeFileSync(guard, originalGuard);
			fs.chmodSync(guard, 0o444);
		}
	});

	test("shuts down only the isolated conversation daemon", async () => {
		const unrelatedSocket = path.join(root, "unrelated.sock");
		const unrelated = await startHerdrStub(unrelatedSocket);
		try {
			const result = combinedOutput(wrapper, ["shutdown"], installEnv);
			expect(result.status).toBe(0);
			expect(result.output).toContain("Prime conversation daemon stopped");
			expect(fs.existsSync(daemonSocket)).toBe(false);
			expect(fs.existsSync(unrelatedSocket)).toBe(true);
		} finally {
			await unrelated.close();
		}
	}, 15_000);
});

describe("Prime upgrade tripwire", () => {
	test("fails unless both the global install and the profile are the reviewed pin", () => {
		const globalVersion = combinedOutput(primeBinary, ["--version"], installEnv);
		expect(globalVersion.status).toBe(0);
		expect(globalVersion.output).toBe(PINNED_VERSION);
		const profileVersion = combinedOutput(wrapper, ["--version"], installEnv);
		expect(profileVersion.status).toBe(0);
		expect(profileVersion.output).toBe(PINNED_VERSION);
		const manifest = ManifestSchema.parse(
			JSON.parse(fs.readFileSync(path.join(agentDir, "deck-prime-conversation.json"), "utf8")),
		);
		expect(manifest).toMatchObject({
			primeAgentVersion: PINNED_VERSION,
			primeAgentTag: PINNED_TAG,
			primeAgentCommit: PINNED_COMMIT,
		});

		const bumped = path.join(root, "prime-agent-bumped");
		fs.writeFileSync(bumped, "#!/bin/sh\nprintf '0.7.1\\n' >&2\n", { mode: 0o700 });
		const rejected = combinedOutput("bash", [INSTALLER], {
			...installEnv,
			PRIME_CONVERSATION_HOME: path.join(root, "bumped-home"),
			PRIME_CONVERSATION_PRIME_BIN: bumped,
		});
		expect(rejected.status).toBe(1);
		expect(rejected.output).toContain("Prime Agent upgrade tripwire");
		expect(rejected.output).toContain("expected 0.7.0");
		expect(fs.existsSync(path.join(root, "bumped-home"))).toBe(false);

		const impersonator = path.join(root, "prime-agent-impersonator");
		fs.writeFileSync(impersonator, "#!/bin/sh\nprintf '0.7.0\\n'\n", { mode: 0o700 });
		const provenanceRejected = combinedOutput("bash", [INSTALLER], {
			...installEnv,
			PRIME_CONVERSATION_HOME: path.join(root, "impersonator-home"),
			PRIME_CONVERSATION_PRIME_BIN: impersonator,
		});
		expect(provenanceRejected.status).toBe(1);
		expect(provenanceRejected.output).toContain("provenance tripwire");
	});
});
