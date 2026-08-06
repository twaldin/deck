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
import { DURABLE_LINK_NAMES, bootstrapHome } from "../v2/src/bootstrap";

const PINNED_VERSION = "0.7.0";
const PINNED_TAG = "v0.7.0";
const PINNED_COMMIT = "be9e2fa0714e7cd1c6bd9bdb1b554d2cc6550387";
const PROCESS_PACKAGE = "npm:@aliou/pi-processes@0.10.4";
const INSTALLER = path.join(import.meta.dir, "install-prime-conversation.sh");
const SEED = fs.readFileSync(path.join(import.meta.dir, "..", "v2", "seed", "AGENTS.md"), "utf8");
const DECK_PRIME_PROFILE = z.strictObject({
	daemonSocketRelative: z.string().min(1),
}).parse(JSON.parse(
	fs.readFileSync(path.join(import.meta.dir, "prime-deck-profile.json"), "utf8"),
));
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

function combinedOutputInPty(command: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; output: string } {
	return combinedOutput(
		executableOnPath("python3"),
		["-c", "import pty, sys; pty.spawn(sys.argv[1:])", command, ...args],
		env,
	);
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
const CommandsDataSchema = z.object({
	commands: z.array(z.looseObject({
		name: z.string(),
		source: z.string(),
		sourceInfo: z.looseObject({
			path: z.string(),
			source: z.string(),
			scope: z.enum(["user", "project", "temporary"]),
			origin: z.enum(["package", "top-level"]),
		}),
	})),
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
	ambientSecret: z.string().nullable(),
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
	// The seat is pinned to the judgment model at high reasoning, and may only
	// select from the captain's canonical four. `deck/*` here is what let a
	// conversation drift onto a non-canonical model.
	defaultModel: z.literal("claude-fable-5"),
	defaultThinkingLevel: z.literal("high"),
	enabledModels: z.array(z.string()).nonempty(),
	// Empty on purpose: the process package stays pinned and installed but
	// unloaded, because a seat must never poll.
	packages: z.tuple([]),
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

function extensionCommands(frames: RpcFrame[]): z.infer<typeof CommandsDataSchema>["commands"] {
	const response = frames.find((frame) => frame.command === "get_commands" && frame.success === true);
	if (response === undefined) throw new Error(`commands missing from RPC frames: ${JSON.stringify(frames)}`);
	return CommandsDataSchema.parse(response.data).commands;
}

type RpcResult = { stdout: string; stderr: string };

function runRpc(
	args: string[],
	requests: Record<string, unknown>[],
	env: NodeJS.ProcessEnv,
	command = wrapper,
): Promise<RpcResult> {
	const { promise, resolve, reject } = Promise.withResolvers<RpcResult>();
	const child = spawn(command, args, {
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

function createHerdrCliStub(running: boolean, existingWorkspace = true, hangStatus = false): {
	root: string;
	binary: string;
	readCalls(): string[][];
} {
	const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deck-herdr-cli-"));
	const log = path.join(stubRoot, "calls.jsonl");
	const binary = path.join(stubRoot, "herdr");
	fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const send = (result) => process.stdout.write(JSON.stringify({ id: "stub", result }) + "\\n");
if (args.length === 0) process.exit(0);
if (args[0] === "status" && args[1] === "server") {
  if (${JSON.stringify(hangStatus)}) {
    require("node:net").createServer().listen(0);
  } else {
    process.stdout.write(JSON.stringify({
      status: ${JSON.stringify(running ? "running" : "not_running")},
      running: ${JSON.stringify(running)},
      version: ${JSON.stringify(running ? "0.8.0" : null)},
      protocol: ${JSON.stringify(running ? 19 : null)},
      compatible: ${JSON.stringify(running)},
      socket: "/tmp/herdr-stub.sock",
    }) + "\\n");
  }
} else if (args[0] === "workspace" && args[1] === "list") {
  send({
    type: "workspace_list",
    workspaces: ${JSON.stringify([{ workspace_id: "wTEST", label: "deck-fleet" }])}.slice(0, ${existingWorkspace ? 1 : 0}),
  });
} else if ((args[0] === "tab" && args[1] === "create") ||
           (args[0] === "workspace" && args[1] === "create")) {
  send({
    type: args[0] === "tab" ? "tab_created" : "workspace_created",
    workspace: { workspace_id: "wTEST", label: "deck-fleet" },
    root_pane: { pane_id: "wTEST:p2", tab_id: "wTEST:t2", workspace_id: "wTEST" },
    tab: { tab_id: "wTEST:t2", workspace_id: "wTEST", label: "deck · orch · conversation" },
  });
} else {
  send({ type: "ok" });
}
`, { mode: 0o700 });
	return {
		root: stubRoot,
		binary,
		readCalls: () => {
			if (!fs.existsSync(log)) return [];
			return fs.readFileSync(log, "utf8").trim().split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as string[]);
		},
	};
}

function herdrRelaunchScriptPath(calls: string[][]): string {
	const command = calls.find((args) => args[0] === "pane" && args[1] === "run")?.[3];
	const matched = /^\/bin\/bash (\/tmp\/deck-herdr-conversation\.[A-Za-z0-9]+)$/.exec(command ?? "");
	if (matched === null) throw new Error(`Missing safe Herdr relaunch command: ${String(command)}`);
	return matched[1];
}

beforeAll(() => {
	primeBinary = process.env.PRIME_CONVERSATION_PRIME_BIN ?? executableOnPath("prime-agent");
	root = fs.mkdtempSync("/tmp/deck-prime-conv-");
	home = path.join(root, "home");
	deckHome = path.join(home, ".deck");
	agentDir = path.join(deckHome, ".prime", "agent");
	wrapper = path.join(deckHome, ".prime", "bin", "prime-conversation");
	daemonSocket = path.join(deckHome, DECK_PRIME_PROFILE.daemonSocketRelative);
	bootstrapHome({
		repoV2Dir: path.join(import.meta.dir, "..", "v2"),
		home: deckHome,
		optMem: false,
	});
	const globalPrimeAgent = path.join(home, ".prime", "agent");
	fs.mkdirSync(globalPrimeAgent, { recursive: true });
	fs.writeFileSync(path.join(globalPrimeAgent, "settings.json"), JSON.stringify({
		defaultProvider: "openai-codex",
		defaultModel: "gpt-5.6-sol",
	}));
	fs.writeFileSync(path.join(globalPrimeAgent, "auth.json"), JSON.stringify({
		anthropic: { type: "oauth", access: "must-not-reach-profile" },
		"openai-codex": { type: "oauth", access: "must-not-reach-profile" },
	}));
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
		DECK_HERDR_AUTO_ATTACH: "0",
	};
	const first = combinedOutput("bash", [INSTALLER, "--apply"], installEnv);
	if (first.status !== 0) throw new Error(first.output);
	const second = combinedOutput("bash", [INSTALLER, "--apply"], installEnv);
	if (second.status !== 0) throw new Error(`idempotent reinstall failed: ${second.output}`);
}, 30_000);

/**
 * Stop ONLY the sandbox daemon.
 *
 * `prime-agent shutdown` is per-UID, not per-HOME: the supervisor registry lives
 * in /tmp/prime-agent-$UID, so an isolated HOME does not scope it and there is
 * no socket flag (`shutdown` takes only --force/--json). Running this suite used
 * to stop every daemon this user owns, which killed the captain's live
 * conversation mid-turn - observed as "The daemon stopped this agent session".
 * Talking to the fixture's own socket is the only scoped stop.
 */
function shutdownSandboxDaemon(): void {
	if (primeBinary === undefined || daemonSocket === undefined) return;
	if (!fs.existsSync(daemonSocket)) return;
	const clientModule = path.join(
		primeBinary.replace(/\/bin\/prime-agent$/, ""),
		"lib/node_modules/prime-agent/dist/modes/daemon/daemon-client.js",
	);
	if (!fs.existsSync(clientModule)) return;
	spawnSync("node", ["--input-type=module", "-", clientModule, daemonSocket], {
		input: `
import { pathToFileURL } from "node:url";
const [clientModule, socketPath] = process.argv.slice(2);
const { DaemonClient } = await import(pathToFileURL(clientModule).href);
const client = new DaemonClient(socketPath);
try {
  await client.connect();
  await client.waitForHello();
  await client.request({ type: "shutdown", force: true }, 10_000);
} finally {
  client.close();
}
`,
		encoding: "utf8",
		timeout: 15_000,
	});
}

afterAll(() => {
	shutdownSandboxDaemon();
	if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
}, 30_000);

	test("keeps bootstrap-owned durable links intact across the convergent reinstall", () => {
		for (const name of DURABLE_LINK_NAMES) {
			const visible = path.join(deckHome, name);
			expect(fs.lstatSync(visible).isSymbolicLink()).toBe(true);
			expect(fs.realpathSync(visible)).toBe(fs.realpathSync(path.join(`${deckHome}-durable`, name)));
		}
	});

describe("Prime conversation installer", () => {
	test("is dry-run by default and writes no profile", () => {
		const dryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deck-prime-dry-"));
		try {
			const dryHome = path.join(dryRoot, "home");
			fs.mkdirSync(dryHome);
			const dryDeckHome = path.join(dryHome, ".deck");
			fs.mkdirSync(dryDeckHome);
			fs.writeFileSync(path.join(dryDeckHome, "AGENTS.md"), SEED);
			const result = combinedOutput("bash", [INSTALLER], {
				...installEnv,
				HOME: dryHome,
				PRIME_CONVERSATION_HOME: dryDeckHome,
			});
			expect(result.status).toBe(0);
			expect(result.output).toContain("DRY RUN — no files will be changed");
			expect(result.output).toContain(`${PINNED_VERSION}, ${PINNED_TAG}, ${PINNED_COMMIT}`);
			expect(result.output).toContain(PROCESS_PACKAGE);
			expect(fs.existsSync(path.join(dryDeckHome, ".prime"))).toBe(false);
		} finally {
			fs.rmSync(dryRoot, { recursive: true, force: true });
		}
	});

	test("refuses to publish the profile over a live pre-boundary daemon", async () => {
		const started = await runRpc(
			[
				"--mode", "rpc",
				"--offline",
				"--no-session",
				"--daemon-socket", daemonSocket,
				"--provider", "deck",
				"--model", "gpt-5.6-sol",
				"--tools", "ipython",
				"--no-extensions",
				"--extension", path.join(import.meta.dir, "..", "broker", "prime", "deck-provider.ts"),
			],
			[{ id: "state", type: "get_state" }],
			{
				...installEnv,
				DECK_TEST_AMBIENT_SECRET: "pre-boundary-secret",
				PRIME_AGENT_CODING_AGENT_DIR: agentDir,
				PRIME_AGENT_SESSION_DIR: path.join(deckHome, ".prime", "sessions"),
			},
			primeBinary,
		);
		expect(rpcFrames(started.stdout)).toContainEqual(expect.objectContaining({
			command: "get_state",
			success: true,
		}));

		const refused = combinedOutput("bash", [INSTALLER, "--apply"], installEnv);
		expect(refused.status).toBe(1);
		expect(refused.output).toContain("existing shared Prime daemon predates this environment boundary");
		expect(refused.output).toContain("root installer drains idle seats and restarts the daemon safely");

		// Scoped to this fixture's socket. `prime-agent shutdown` is per-UID and
		// would stop the developer's live conversation too.
		shutdownSandboxDaemon();
		const reapplied = combinedOutput("bash", [INSTALLER, "--apply"], installEnv);
		expect(reapplied.status).toBe(0);
	}, 30_000);

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

	test("recovers an unmanaged partial install that already linked the exact package", () => {
		const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deck-prime-recovery-"));
		try {
			const recoveryHome = path.join(recoveryRoot, "home");
			const recoveryDeckHome = path.join(recoveryHome, ".deck");
			const packageLink = path.join(recoveryDeckHome, ".prime", "agent", "npm", "node_modules", "@aliou", "pi-processes");
			const packageSource = fs.realpathSync(
				path.join(agentDir, "npm", "node_modules", "@aliou", "pi-processes"),
			);
			fs.mkdirSync(path.dirname(packageLink), { recursive: true });
			fs.writeFileSync(path.join(recoveryDeckHome, "AGENTS.md"), SEED);
			fs.symlinkSync(packageSource, packageLink);
			const result = combinedOutput("bash", [INSTALLER, "--apply"], {
				...installEnv,
				HOME: recoveryHome,
				PRIME_CONVERSATION_HOME: recoveryDeckHome,
			});
			expect(result.status).toBe(0);
			expect(fs.realpathSync(packageLink)).toBe(packageSource);
			expect(fs.existsSync(path.join(recoveryDeckHome, ".prime", "agent", "deck-prime-conversation.json"))).toBe(true);
		} finally {
			fs.rmSync(recoveryRoot, { recursive: true, force: true });
		}
	});

	test("reconciles stale Deck-managed checkout symlinks without removing foreign paths", () => {
		const extensions = path.join(agentDir, "extensions");
		const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deck-legacy-checkout-"));
		const manifestPath = path.join(agentDir, "deck-prime-conversation.json");
		const legacyManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		const retiredExtensionRoot = `extensions-${String.fromCharCode(112, 105)}`;
		const staleExtension = path.join(legacyRoot, retiredExtensionRoot, "deck-questions.ts");
		const extensionLink = path.join(extensions, "deck-questions", "index.ts");
		const v2Root = path.join(extensions, "v2");
		const v2Marker = path.join(v2Root, ".deck-v2-lib");
		const v2Module = fs.readdirSync(path.join(import.meta.dir, "..", "v2", "src"))
			.find((name) => name.endsWith(".ts") && name !== "index.ts");
		expect(v2Module).toBeDefined();
		const v2Link = path.join(v2Root, "src", v2Module!);
		const staleV2Module = path.join(legacyRoot, "v2", "src", v2Module!);
			fs.chmodSync(manifestPath, 0o600);
			fs.writeFileSync(manifestPath, `${JSON.stringify({ ...legacyManifest, deckRepo: legacyRoot }, null, 2)}\n`);
			fs.chmodSync(manifestPath, 0o444);
		try {
			fs.mkdirSync(path.dirname(staleExtension), { recursive: true });
			fs.writeFileSync(staleExtension, "export default function legacy() {}\n");
			fs.mkdirSync(path.dirname(staleV2Module), { recursive: true });
			fs.writeFileSync(staleV2Module, "export const legacy = true;\n");
			fs.rmSync(extensionLink);
			fs.symlinkSync(staleExtension, extensionLink);
			fs.rmSync(v2Link);
			fs.symlinkSync(staleV2Module, v2Link);
			fs.writeFileSync(v2Marker, path.join(legacyRoot, "v2"));

			const result = combinedOutput("bash", [INSTALLER, "--apply"], installEnv);
			expect(result.status).toBe(0);
			expect(result.output).toContain("reconciling Deck-managed symlink");
			expect(result.output).toContain("reconciling Deck-managed v2 support root");
			expect(fs.readlinkSync(extensionLink)).toBe(
				path.join(import.meta.dir, "..", "extensions-prime", "deck-questions.ts"),
			);
			expect(fs.readlinkSync(v2Link)).toBe(path.join(import.meta.dir, "..", "v2", "src", v2Module!));
			expect(fs.readFileSync(v2Marker, "utf8").trim()).toBe(path.join(import.meta.dir, "..", "v2"));
		} finally {
			fs.chmodSync(manifestPath, 0o600);
			fs.writeFileSync(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
			fs.chmodSync(manifestPath, 0o444);
			fs.rmSync(legacyRoot, { recursive: true, force: true });
		}
	});

	test("preserves a foreign symlink placed at a Deck-managed destination", () => {
		const extensionLink = path.join(agentDir, "extensions", "deck-questions", "index.ts");
		const expected = fs.readlinkSync(extensionLink);
		const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deck-operator-extension-"));
		const foreign = path.join(foreignRoot, "operator-extension.ts");
		fs.writeFileSync(foreign, "export default function operatorExtension() {}\n");
		fs.rmSync(extensionLink);
		fs.symlinkSync(foreign, extensionLink);
		try {
			const result = combinedOutput("bash", [INSTALLER, "--apply"], installEnv);
			expect(result.status).toBe(1);
			expect(result.output).toContain(`preserving unowned symlink ${extensionLink} -> ${foreign}`);
			expect(fs.readlinkSync(extensionLink)).toBe(foreign);
			expect(fs.readFileSync(foreign, "utf8")).toContain("operatorExtension");
		} finally {
			fs.rmSync(extensionLink, { force: true });
			fs.symlinkSync(expected, extensionLink);
			fs.rmSync(foreignRoot, { recursive: true, force: true });
		}
	});

	test("reports and preserves user-added auto-discovery entries", () => {
		const foreign = path.join(agentDir, "extensions", "operator-extension.ts");
		fs.writeFileSync(foreign, "export default function operatorExtension() {}\n");
		try {
			const result = combinedOutput("bash", [INSTALLER, "--apply"], installEnv);
			expect(result.status).toBe(1);
			expect(result.output).toContain(`unapproved conversation-profile extension is present: ${foreign}`);
			expect(fs.readFileSync(foreign, "utf8")).toContain("operatorExtension");
		} finally {
			fs.rmSync(foreign, { force: true });
		}
	});

	test("mirrors only the approved Deck extensions and pinned process package", () => {
		const extensions = path.join(agentDir, "extensions");
		// deck-ship is gone: shipping is `deck.ship()`, not a registered tool.
		for (const name of ["deck-questions", "deck-recall", "deck-usage"]) {
			const entry = path.join(extensions, name, "index.ts");
			expect(fs.realpathSync(entry)).toBe(fs.realpathSync(path.join(import.meta.dir, "..", "extensions-prime", `${name}.ts`)));
		}
		expect(fs.realpathSync(path.join(extensions, "deck-provider.ts"))).toBe(
			fs.realpathSync(path.join(import.meta.dir, "..", "broker", "prime", "deck-provider.ts")),
		);
		expect(fs.realpathSync(path.join(extensions, "node_modules", "zod"))).toBe(
			fs.realpathSync(path.join(import.meta.dir, "..", "broker", "node_modules", "zod")),
		);
		const processPackage = path.join(agentDir, "npm", "node_modules", "@aliou", "pi-processes");
		expect(fs.lstatSync(processPackage).isSymbolicLink()).toBe(true);
		expect(JSON.parse(fs.readFileSync(path.join(processPackage, "package.json"), "utf8"))).toMatchObject({
			name: "@aliou/pi-processes",
			version: "0.10.4",
		});
		expect(fs.readdirSync(extensions).sort()).toEqual([
			"deck-provider.ts",
			"deck-questions",
			"deck-recall",
			"deck-usage",
			"node_modules",
			"prime-conversation-guard.ts",
			"v2",
		]);
		expect(fs.existsSync(path.join(extensions, "herdr-agent-state.ts"))).toBe(false);
	});
});

describe("Prime conversation runtime guards", () => {
	test("headless print mode bypasses Herdr relaunch and completes a continued conversation", async () => {
		let requests = 0;
		const toolProbe = path.join(root, "headless-ipython-tool.txt");
		fs.rmSync(toolProbe, { force: true });
		const gateway = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (request) => {
				requests += 1;
				await request.text();
				const envelope = {
					id: `headless-${requests}`,
					object: "chat.completion.chunk",
					created: 1,
					model: "gpt-5.6-sol",
				};
				const delta = requests === 2
					? {
						tool_calls: [{
							index: 0,
							id: "headless-ipython-probe",
							type: "function",
							function: {
								name: "ipython",
								arguments: JSON.stringify({
									code: `from pathlib import Path\nPath(${JSON.stringify(toolProbe)}).write_text("tool-ok")\n"tool-ok"`,
								}),
							},
						}],
					}
					: { role: "assistant", content: requests === 1 ? "INITIAL_OK" : "HEADLESS_OK" };
				const finishReason = requests === 2 ? "tool_calls" : "stop";
				const chunks = [
					{ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] },
					{ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
				];
				return new Response(
					`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		const run = async (args: string[]): Promise<{ status: number; stdout: string; stderr: string }> => {
			const child = Bun.spawn([wrapper, ...args], {
				env: {
					...installEnv,
					DECK_GATEWAY_ORIGIN: `http://127.0.0.1:${gateway.port}`,
					DECK_HERDR_AUTO_ATTACH: "1",
					HERDR_ENV: "0",
					HERDR_PANE_ID: "",
					HERDR_SOCKET_PATH: "",
					HERDR_TAB_ID: "",
					HERDR_WORKSPACE_ID: "",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, status] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { status, stdout, stderr };
		};
		try {
			const initial = await run(["-p", "Begin a headless test conversation."]);
			expect(initial.status, initial.stderr).toBe(0);
			const continued = await run(["-c", "-p", "Reply exactly HEADLESS_OK."]);
			expect(continued.status, continued.stderr).toBe(0);
			expect(continued.stdout).toContain("HEADLESS_OK");
			expect(requests).toBeGreaterThanOrEqual(3);
			expect(fs.readFileSync(toolProbe, "utf8")).toBe("tool-ok");
		} finally {
			gateway.stop(true);
		}
	}, 30_000);

	test("a plain-terminal conversation creates and enters its own labelled Herdr pane", () => {
		const herdr = createHerdrCliStub(true);
		let relaunchScript: string | undefined;
		const conversationArgs = [
			"--mode",
			"rpc",
			"--no-session",
			"--model",
			"hostile ; exit 77; ' argument",
		];
		try {
			const result = combinedOutputInPty(wrapper, conversationArgs, {
				...installEnv,
				DECK_HERDR_AUTO_ATTACH: "1",
				DECK_HERDR_BIN: herdr.binary,
				HERDR_ENV: "0",
				HERDR_PANE_ID: "",
				HERDR_SOCKET_PATH: "",
				HERDR_TAB_ID: "",
				HERDR_WORKSPACE_ID: "",
				PRIME_CONVERSATION_RLM_MAX_DEPTH: "0",
			});
			expect(result).toMatchObject({ status: 0 });
			const calls = herdr.readCalls();
			expect(calls.slice(0, 2)).toEqual([
				["status", "server", "--json"],
				["workspace", "list"],
			]);
			const create = calls.find((args) => args[0] === "tab" && args[1] === "create");
			expect(create).toEqual([
				"tab", "create",
				"--workspace", "wTEST",
				"--label", "deck · orch · conversation",
				"--cwd", deckHome,
				"--env", "DECK_HERDR_RELAUNCHED=1",
				"--no-focus",
			]);
			expect(calls).toContainEqual([
				"tab", "rename", "wTEST:t2", "deck · orch · conversation",
			]);
			expect(calls).toContainEqual([
				"pane", "rename", "wTEST:p2", "deck · orch · conversation",
			]);
			const run = calls.find((args) => args[0] === "pane" && args[1] === "run");
			expect(run?.[2]).toBe("wTEST:p2");
			relaunchScript = herdrRelaunchScriptPath(calls);
			const bootstrap = fs.readFileSync(relaunchScript, "utf8");
			expect(bootstrap).toContain(`exec ${wrapper}`);
			expect(bootstrap).toContain("--mode rpc --no-session");
			expect(bootstrap).toContain("export PRIME_CONVERSATION_RLM_MAX_DEPTH=0");
			const execLine = bootstrap.trimEnd().split("\n").at(-1);
			expect(execLine?.startsWith("exec ")).toBe(true);
			const argvProbe = spawnSync("/bin/bash", [
				"-c",
				`set -- ${execLine?.slice(5)}; node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$@"`,
			], { encoding: "utf8" });
			expect(argvProbe.status).toBe(0);
			expect(JSON.parse(argvProbe.stdout)).toEqual([wrapper, ...conversationArgs]);
			expect(run?.[3]).not.toContain("--mode");
			expect(calls).toContainEqual(["tab", "focus", "wTEST:t2"]);
			expect(calls.at(-1)).toEqual([]);
		} finally {
			if (relaunchScript !== undefined) fs.rmSync(relaunchScript, { force: true });
			fs.rmSync(herdr.root, { recursive: true, force: true });
		}
	}, 30_000);

	test("a fresh Herdr server labels both the new workspace root tab and pane", () => {
		const herdr = createHerdrCliStub(true, false);
		let relaunchScript: string | undefined;
		try {
			const result = combinedOutputInPty(wrapper, ["--mode", "rpc", "--no-session"], {
				...installEnv,
				DECK_HERDR_AUTO_ATTACH: "1",
				DECK_HERDR_BIN: herdr.binary,
				HERDR_ENV: "0",
				HERDR_PANE_ID: "",
				HERDR_SOCKET_PATH: "",
				HERDR_TAB_ID: "",
				HERDR_WORKSPACE_ID: "",
			});
			expect(result.status).toBe(0);
			const calls = herdr.readCalls();
			expect(calls).toContainEqual([
				"workspace", "create",
				"--label", "deck-fleet",
				"--cwd", deckHome,
				"--env", "DECK_HERDR_RELAUNCHED=1",
				"--no-focus",
			]);
			expect(calls).toContainEqual([
				"tab", "rename", "wTEST:t2", "deck · orch · conversation",
			]);
			expect(calls).toContainEqual([
				"pane", "rename", "wTEST:p2", "deck · orch · conversation",
			]);
			relaunchScript = herdrRelaunchScriptPath(calls);
		} finally {
			if (relaunchScript !== undefined) fs.rmSync(relaunchScript, { force: true });
			fs.rmSync(herdr.root, { recursive: true, force: true });
		}
	}, 30_000);


	test("a stale ambient socket without pane identity is cleared before server discovery", () => {
		const herdr = createHerdrCliStub(true);
		let relaunchScript: string | undefined;
		try {
			const result = combinedOutputInPty(wrapper, ["--mode", "rpc", "--no-session"], {
				...installEnv,
				DECK_HERDR_AUTO_ATTACH: "1",
				DECK_HERDR_BIN: herdr.binary,
				HERDR_ENV: "1",
				HERDR_PANE_ID: "",
				HERDR_SOCKET_PATH: "/tmp/stale-herdr.sock",
				HERDR_TAB_ID: "",
				HERDR_WORKSPACE_ID: "",
			});
			expect(result.status).toBe(0);
			const calls = herdr.readCalls();
			expect(calls.some((args) => args[0] === "pane" && args[1] === "get")).toBe(false);
			expect(calls.some((args) => args[0] === "tab" && args[1] === "create")).toBe(true);
			relaunchScript = herdrRelaunchScriptPath(calls);
		} finally {
			if (relaunchScript !== undefined) fs.rmSync(relaunchScript, { force: true });
			fs.rmSync(herdr.root, { recursive: true, force: true });
		}
	}, 30_000);
	test("a non-interactive conversation bypasses an unavailable Herdr server", async () => {
		const herdr = createHerdrCliStub(false);
		try {
			const result = await runRpc(
				["--mode", "rpc", "--no-session"],
				[{ id: "state", type: "get_state" }],
				{
					...installEnv,
					DECK_HERDR_AUTO_ATTACH: "1",
					DECK_HERDR_BIN: herdr.binary,
					HERDR_ENV: "0",
					HERDR_PANE_ID: "",
					HERDR_SOCKET_PATH: "",
					HERDR_TAB_ID: "",
					HERDR_WORKSPACE_ID: "",
				},
			);
			expect(rpcFrames(result.stdout)).toContainEqual(expect.objectContaining({
				command: "get_state",
				success: true,
			}));
			expect(herdr.readCalls()).toEqual([]);
		} finally {
			fs.rmSync(herdr.root, { recursive: true, force: true });
		}
	}, 30_000);

	test("a non-interactive conversation bypasses a wedged Herdr CLI", async () => {
		const herdr = createHerdrCliStub(true, true, true);
		try {
			const startedAt = Date.now();
			const result = await runRpc(
				["--mode", "rpc", "--no-session"],
				[{ id: "state", type: "get_state" }],
				{
					...installEnv,
					DECK_HERDR_AUTO_ATTACH: "1",
					DECK_HERDR_BIN: herdr.binary,
					HERDR_ENV: "0",
					HERDR_PANE_ID: "",
					HERDR_SOCKET_PATH: "",
					HERDR_TAB_ID: "",
					HERDR_WORKSPACE_ID: "",
				},
			);
			expect(Date.now() - startedAt).toBeLessThan(12_000);
			expect(rpcFrames(result.stdout)).toContainEqual(expect.objectContaining({
				command: "get_state",
				success: true,
			}));
			expect(herdr.readCalls()).toEqual([]);
		} finally {
			fs.rmSync(herdr.root, { recursive: true, force: true });
		}
	}, 30_000);
	test("real Prime excludes the configured process package from a workflow-filtered seat", async () => {
		const probeExtension = path.join(root, "workflow-tool-probe.ts");
		const probeOutput = path.join(root, "workflow-tool-probe.json");
		const workflowSessions = path.join(root, "workflow-sessions");
		fs.writeFileSync(probeExtension, `
import * as fs from "node:fs";
export default function workflowToolProbe(agent: { getAllTools(): Array<{ name: string }>; on(event: string, handler: () => void): void }): void {
  agent.on("session_start", () => {
    fs.writeFileSync(process.env.PRIME_WORKFLOW_PROBE!, JSON.stringify({
      tools: agent.getAllTools().map((tool) => tool.name).sort(),
    }));
  });
}
`);
		const result = await runRpc(
			[
				"--mode", "rpc",
				"--offline",
				"--no-session",
				"--cwd", deckHome,
				"--provider", "deck",
				"--model", "gpt-5.6-sol",
				"--session-dir", workflowSessions,
				"--daemon-socket", daemonSocket,
				"--tools", "ipython",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--extension", path.join(import.meta.dir, "..", "broker", "prime", "deck-provider.ts"),
				"--extension", probeExtension,
			],
			[
				{ id: "state", type: "get_state" },
				{ id: "commands", type: "get_commands" },
			],
			{
				...installEnv,
				PRIME_AGENT_CODING_AGENT_DIR: agentDir,
				PRIME_AGENT_SESSION_DIR: workflowSessions,
				PRIME_WORKFLOW_PROBE: probeOutput,
				DECK_V2_HOME: deckHome,
				RLM_DEPTH: "0",
				RLM_MAX_DEPTH: "1",
			},
			primeBinary,
		);
		expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/collision|conflicts with|already registered|duplicate command/i);
		const frames = rpcFrames(result.stdout);
		expect(frames.some((frame) => frame.command === "get_state" && frame.success === true)).toBe(true);
		const commands = extensionCommands(frames);
		expect(commands.some((command) => command.name === "ps" || command.name.startsWith("ps:"))).toBe(false);
		expect(JSON.parse(fs.readFileSync(probeOutput, "utf8"))).toEqual({ tools: ["ipython"] });
		expect(fs.existsSync(daemonSocket)).toBe(true);
	}, 30_000);

	test("loads the pinned process tool without a command collision alongside Deck tools and custody", async () => {
		const probeOutput = path.join(root, "profile-probe.json");
		const herdrSocket = path.join(root, "herdr-probe.sock");
		const herdr = await startHerdrStub(herdrSocket);
		try {
			const result = await runRpc(
				["--mode", "rpc", "--no-session"],
				[
					{ id: "models", type: "get_available_models" },
					{ id: "state", type: "get_state" },
					{ id: "commands", type: "get_commands" },
				],
				{
					...installEnv,
					PRIME_CONVERSATION_PROBE: probeOutput,
					SMITHERS_GATEWAY_TOKEN: "must-not-reach-prime",
					SMITHERS_TOKEN_STORE: path.join(root, "must-not-reach-prime.json"),
					DECK_STAMP_TOKEN: "must-not-reach-prime",
					DECK_PUBLISHER_TOKEN: "must-not-reach-prime",
					ADMIN_TOKEN: "must-not-reach-prime",
					DECK_TEST_AMBIENT_SECRET: "must-not-reach-prime",
					HERDR_ENV: "1",
					HERDR_PANE_ID: "captain-probe",
					HERDR_SOCKET_PATH: herdrSocket,
					HERDR_WORKSPACE_ID: "prime-conversation-sandbox",
					HERDR_TAB_ID: "profile-probe",
				},
			);
			expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/collision|conflicts with|already registered|duplicate command/i);
			const frames = rpcFrames(result.stdout);
			expect(deckModels(frames).length).toBeGreaterThan(0);
			expect(selectedProvider(frames)).toBe("deck");
			// The pi-processes package is installed and pinned, but deliberately NOT
			// loaded: a seat must never poll. Waiting is a durable workflow state,
			// and process inspection is `deck.procs()`.
			const processCommands = extensionCommands(frames).filter((command) =>
				command.name === "ps" || command.name.startsWith("ps:"));
			expect(processCommands).toEqual([]);
			const probe = ProbeOutputSchema.parse(JSON.parse(fs.readFileSync(probeOutput, "utf8")));
			expect(probe.cwd).toBe(fs.realpathSync(deckHome));
			expect(probe.agentDir).toBe(agentDir);
			expect(probe.sessionDir).toBe(path.join(deckHome, ".prime", "sessions"));
			expect(probe.gatewayToken).toBeNull();
			expect(probe.tokenStore).toBeNull();
			expect(probe.stampToken).toBeNull();
			expect(probe.publisherToken).toBeNull();
			expect(probe.adminToken).toBeNull();
			expect(probe.ambientSecret).toBeNull();
			expect(probe.maxDepth).toBe("1");
			// Code execution is the only tool. Deck's capabilities are Python calls
			// in the `deck` module, so a registered pi-tool here is a regression.
			// EXACT, not a denylist. The contract is that code execution is the only
			// tool, so an allowlist-by-omission would let a new pi-tool creep in
			// while this still passed.
			expect(probe.tools).toEqual(["ipython"]);
			expect(probe.tools.some((tool) => /agent|dispatch|spawn/i.test(tool))).toBe(false);
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
			await herdr.close();
		}
	}, 30_000);

	test("rejects non-Deck provider selection despite global native OAuth logins", async () => {
		expect(JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"))).toEqual({});
		expect(JSON.parse(fs.readFileSync(path.join(home, ".prime", "agent", "auth.json"), "utf8"))).toHaveProperty("anthropic");
		const result = await runRpc(
			["--mode", "rpc", "--no-session"],
			[
				{ id: "models", type: "get_available_models" },
				{ id: "state", type: "get_state" },
			],
			installEnv,
		);
		const frames = rpcFrames(result.stdout);
		const modelsResponse = frames.find((frame) =>
			frame.command === "get_available_models" && frame.success === true);
		const models = ModelsDataSchema.parse(modelsResponse?.data).models;
		expect(models.length).toBeGreaterThan(0);
		expect(models.every((model) => model.provider === "deck")).toBe(true);
		expect(selectedProvider(frames)).toBe("deck");
		const cliSelection = combinedOutput(wrapper, ["--provider", "anthropic"], installEnv);
		expect(cliSelection.status).toBe(2);
		expect(cliSelection.output).toContain("fixed by the prime conversation profile");
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
	}, 15_000);

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
			defaultModel: "claude-fable-5",
			defaultThinkingLevel: "high",
			// Exactly the canonical set, sourced from DECK_AGENT_CATALOG.
			enabledModels: [
				"deck/claude-fable-5",
				"deck/claude-opus-5",
				"deck/gpt-5.6-sol",
				"deck/gpt-5.6-luna",
			],
			packages: [],
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

	test("refuses to shut down the shared Deck daemon", () => {
		expect(fs.existsSync(daemonSocket)).toBe(true);
		const result = combinedOutput(wrapper, ["shutdown"], installEnv);
		expect(result.status).toBe(2);
		expect(result.output).toContain("shared Deck Prime daemon is not owned");
		expect(fs.existsSync(daemonSocket)).toBe(true);
	});
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
		expect(provenanceRejected.output).toContain("install-state tripwire");
	});
});

describe("daemon shutdowns never reach the live daemon", () => {
	// An unscoped `prime-agent shutdown --force` in this suite killed the captain's
	// running orch session on deckbox: the shared production daemon received the
	// shutdown and reported "The daemon stopped this agent session". Isolating HOME
	// is not sufficient — the socket must be named explicitly.
	test("every direct shutdown in this suite names a daemon socket", () => {
		const source = fs.readFileSync(import.meta.path, "utf8");
		const directShutdowns = source.match(/\[\s*"shutdown"[^\]]*\]/g) ?? [];
		expect(directShutdowns.length).toBeGreaterThan(0);
		for (const call of directShutdowns) {
			// Wrapper invocations supply --daemon-socket themselves; direct binary
			// invocations pass --force and must scope the socket.
			if (!call.includes("--force")) continue;
			expect(call, call).toContain("--daemon-socket");
		}
	});
});

describe("the code surface reaches the kernel", () => {
	// The tool surface was deleted in favour of a `deck` Python module. That is
	// only safe if the kernel can actually import it: the wrapper runs `env -i`,
	// so anything not exported AND allowlisted is silently dropped and the agent
	// would lose every capability at once.
	test("the wrapper exports PYTHONPATH and IPYTHONDIR past env -i", () => {
		const wrapper = fs.readFileSync(path.join(deckHome, ".prime", "bin", "prime-conversation"), "utf8");
		expect(wrapper).toContain("export PYTHONPATH=");
		expect(wrapper).toContain("export IPYTHONDIR=");
		// Exporting is not enough - env -i keeps only the allowlisted names.
		const allowlist = wrapper.slice(wrapper.indexOf("for name in PATH HOME"), wrapper.indexOf("do\n  if [[ -n"));
		expect(allowlist).toContain("PYTHONPATH");
		expect(allowlist).toContain("IPYTHONDIR");
	});

	test("the installed module imports and answers help()", () => {
		const pythonRoot = path.join(deckHome, ".prime", "python");
		expect(fs.existsSync(path.join(pythonRoot, "deck", "__init__.py"))).toBe(true);
		const probe = spawnSync("python3", ["-c", "import deck; print(deck.help())"], {
			env: { ...process.env, PYTHONPATH: pythonRoot },
			encoding: "utf8",
		});
		expect(probe.status).toBe(0);
		expect(probe.stdout).toContain("deck.ship");
		expect(probe.stdout).toContain("ask_captain->deck.ask");
	});

	test("the kernel startup file auto-imports the surface", () => {
		const startup = path.join(deckHome, ".prime", "ipython", "profile_default", "startup", "00-deck.py");
		expect(fs.readFileSync(startup, "utf8")).toContain("import deck");
	});
});
