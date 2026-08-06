import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";

import {
	buildSeatEnvironment,
	PrimeSeatAgent,
	resolveDeckPrimeProfilePaths,
	PrimeSeatError,
	type PrimeSeatFailureCode,
} from "../lib/engines/prime.ts";

const roots: string[] = [];
let herdrServer: Server;
let herdrRoot: string;
let herdrSocket: string;
let primeHome: string;
let primeDaemonSocket: string;
let herdrPaneSequence = 1;
const herdrRequests: Array<Record<string, unknown>> = [];
const herdrPanes = new Map<string, { paneId: string; tabId: string; workspaceId: string; label: string }>();
const herdrTabs = new Map<string, { tabId: string; workspaceId: string; label: string }>();
const captainPane = {
	paneId: "deck-test:captain",
	tabId: "deck-test:captain-tab",
	workspaceId: "deck-test",
	label: "captain",
};

beforeAll(async () => {
	herdrRoot = await fs.mkdtemp(path.join(os.tmpdir(), `deck-test-${process.pid}-`));
	herdrSocket = path.join(herdrRoot, "herdr.sock");
	primeHome = await fs.mkdtemp("/tmp/deck-prime-home-");
	primeDaemonSocket = resolveDeckPrimeProfilePaths(primeHome).daemonSocket;
	await fs.mkdir(primeHome, { recursive: true, mode: 0o700 });
	herdrPanes.set(captainPane.paneId, captainPane);
	herdrTabs.set(captainPane.tabId, {
		tabId: captainPane.tabId,
		workspaceId: captainPane.workspaceId,
		label: captainPane.label,
	});
	herdrServer = createServer((socket) => {
		let input = "";
		socket.on("data", (chunk) => {
			input += chunk.toString("utf8");
			let newline = input.indexOf("\n");
			while (newline >= 0) {
				const request = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
				input = input.slice(newline + 1);
				herdrRequests.push(request);
				const method = String(request.method);
				const params = request.params as Record<string, unknown>;
				let result: Record<string, unknown> = { type: "ok" };
				if (method === "workspace.list") {
					result = {
						type: "workspace_list",
						workspaces: [{
							workspace_id: "deck-test",
							label: "deck-test",
							pane_count: herdrPanes.size,
							tab_count: herdrTabs.size,
						}],
					};
				} else if (method === "workspace.get") {
					result = {
						type: "workspace_info",
						workspace: params.workspace_id === "deck-test"
							? { workspace_id: "deck-test", label: "deck-test" }
							: null,
					};
				} else if (method === "tab.create") {
					const sequence = ++herdrPaneSequence;
					const paneId = `deck-test:p${sequence}`;
					const tabId = `deck-test:t${sequence}`;
					const label = String(params.label ?? "");
					herdrPanes.set(paneId, { paneId, tabId, workspaceId: "deck-test", label });
					herdrTabs.set(tabId, { tabId, workspaceId: "deck-test", label });
					result = {
						type: "tab_created",
						root_pane: { pane_id: paneId, tab_id: tabId, workspace_id: "deck-test" },
						tab: { tab_id: tabId, workspace_id: "deck-test", label, pane_count: 1 },
					};
				} else if (method === "tab.rename") {
					const tab = herdrTabs.get(String(params.tab_id));
					if (tab !== undefined) tab.label = String(params.label ?? "");
				} else if (method === "pane.rename") {
					const pane = herdrPanes.get(String(params.pane_id));
					if (pane !== undefined) pane.label = String(params.label ?? "");
				} else if (method === "pane.close") {
					const pane = herdrPanes.get(String(params.pane_id));
					if (pane !== undefined && pane.paneId !== captainPane.paneId) {
						herdrPanes.delete(pane.paneId);
						herdrTabs.delete(pane.tabId);
					}
				}
				socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
				newline = input.indexOf("\n");
			}
		});
	});
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	herdrServer.once("error", reject);
	herdrServer.listen(herdrSocket, resolve);
	await promise;
});

afterAll(async () => {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	herdrServer.close((error) => error === undefined ? resolve() : reject(error));
	await promise;
	await stopFakePrimeDaemon();
	await fs.rm(primeHome, { recursive: true, force: true });
	await fs.rm(herdrRoot, { recursive: true, force: true });
});

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
	herdrRequests.length = 0;
	herdrPaneSequence = 1;
	herdrPanes.clear();
	herdrTabs.clear();
	herdrPanes.set(captainPane.paneId, captainPane);
	herdrTabs.set(captainPane.tabId, {
		tabId: captainPane.tabId,
		workspaceId: captainPane.workspaceId,
		label: captainPane.label,
	});
});

const runRecordSchema = z.object({
	providerMetadata: z.object({
		prime: z.object({
			engine: z.literal("prime"),
			version: z.literal("0.7.0"),
			requestedModel: z.string(),
			rootModel: z.object({ provider: z.string(), model: z.string(), source: z.string() }).passthrough(),
			herdr: z.object({
				attached: z.boolean(),
				paneId: z.string().nullable(),
				label: z.string(),
				warning: z.string().optional(),
			}),
			childModels: z.array(z.object({ provider: z.string(), model: z.string(), depth: z.number() }).passthrough()),
			exitStatus: z.object({ code: z.number().nullable(), signal: z.string().nullable() }),
			wallClockMs: z.number(),
			steers: z.number(),
			tokens: z.object({ input: z.number(), output: z.number(), total: z.number() }),
		}),
	}),
});

type FakeMode =
	| "success"
	| "success-slow"
	| "success-child"
	| "malformed"
	| "depth-two-child"
	| "missing"
	| "missing-transcript"
	| "no-model-provenance"
	| "transport-death"
	| "wrong-model"
	| "stall"
	| "version-mismatch";

async function fakePrime(mode: FakeMode, captureFile?: string) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-prime-fake-"));
	roots.push(root);
	const binary = path.join(root, "prime-agent");
	const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const net = require("node:net");
const mode = ${JSON.stringify(mode)};
const captureFile = ${JSON.stringify(captureFile)};
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write(mode === "version-mismatch" ? "0.6.9\\n" : "0.7.0\\n");
  process.exit(0);
}
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const provider = valueAfter("--provider");
const model = valueAfter("--model");
const sessionDir = valueAfter("--session-dir");
if (captureFile) fs.appendFileSync(captureFile, JSON.stringify({ args, env: process.env, homeTokenExists: fs.existsSync(path.join(process.env.HOME, ".deck", "broker", "gateway.token")), gitConfigExists: fs.existsSync(path.join(process.env.HOME, ".gitconfig")) }) + "\\n");
const daemonSocket = valueAfter("--daemon-socket");
if (valueAfter("--mode") === "daemon") {
  try { fs.unlinkSync(daemonSocket); } catch {}
  const server = net.createServer((socket) => {
    socket.write(JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 } }) + "\\n");
    let commands = "";
    socket.on("data", (chunk) => {
      commands += chunk.toString("utf8");
      if (commands.includes("\\n") && JSON.parse(commands.split("\\n")[0]).type === "shutdown") {
        socket.write(JSON.stringify({ id: "deck-seat-shutdown", type: "response", command: "shutdown", success: true }) + "\\n");
        socket.end();
        server.close(() => process.exit(0));
      }
    });
  });
  server.listen(daemonSocket);
  return;
}
if (args.includes("stop")) process.exit(0);
let stallDescendant;
if (mode === "stall") {
  // Deliberately real processes: this fault drill proves OS process-group teardown.
  stallDescendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  if (captureFile) fs.writeFileSync(captureFile + ".pid", String(stallDescendant.pid));
  process.on("SIGTERM", () => stallDescendant.once("exit", () => process.exit(0)));
}
let input = "";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
function persist(answer) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const rootId = "root-session";
  const rows = [
    { type: "session", version: 3, id: rootId, timestamp: new Date().toISOString(), cwd: process.cwd(), rlmDepth: 0 },
    { type: "message", id: "answer", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: answer }], ...(mode === "no-model-provenance" ? {} : { provider, model }), usage: { input: 12, output: 5, totalTokens: 17 }, stopReason: "stop" } },
  ];
  fs.writeFileSync(path.join(sessionDir, rootId + ".jsonl"), rows.map(JSON.stringify).join("\\n") + "\\n");
  if (mode === "success-child" || mode === "depth-two-child") {
    const childDir = path.join(sessionDir, "sub-child");
    fs.mkdirSync(childDir, { recursive: true });
    const childRows = [
      { type: "session", version: 3, id: "child-session", parentSession: rootId, timestamp: new Date().toISOString(), cwd: process.cwd(), rlmDepth: mode === "depth-two-child" ? 2 : 1 },
      { type: "message", id: "child-answer", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "child" }], provider: "deck", model: "gpt-5.6-terra", usage: { input: 3, output: 2, totalTokens: 5 }, stopReason: "stop" } },
    ];
    fs.writeFileSync(path.join(childDir, "child-session.jsonl"), childRows.map(JSON.stringify).join("\\n") + "\\n");
  }
}
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  let newline = input.indexOf("\\n");
  while (newline >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    const request = JSON.parse(line);
    if (request.type === "get_state") {
      send({ id: request.id, type: "response", command: "get_state", success: true, data: { model: { provider, id: mode === "wrong-model" ? "gpt-5.4" : model } } });
    } else if (request.type === "prompt") {
      send({ id: request.id, type: "response", command: "prompt", success: true });
      if (mode === "transport-death") {
        send({ type: "session", version: 3, id: "root-session", timestamp: new Date().toISOString(), cwd: process.cwd() });
        process.exit(7);
      }
      if (mode === "stall") {
        send({ type: "session", version: 3, id: "root-session", timestamp: new Date().toISOString(), cwd: process.cwd() });
        send({ type: "agent_start" });
      } else {
        const answer = mode === "malformed" ? "not-json" : mode === "missing" ? "" : "{\\"ok\\":true}";
        const finish = () => {
          if (mode !== "missing-transcript") persist(answer);
          send({ type: "session", version: 3, id: "root-session", timestamp: new Date().toISOString(), cwd: process.cwd() });
          send({ type: "agent_start" });
          send({ type: "agent_end", messages: answer ? [{ role: "assistant", content: [{ type: "text", text: answer }], provider, model }] : [] });
        };
        if (mode === "success-slow") {
          const gate = captureFile + ".release";
          const watcher = fs.watch(path.dirname(gate), (_event, filename) => {
            if (filename === path.basename(gate)) {
              watcher.close();
              finish();
            }
          });
          if (fs.existsSync(gate)) {
            watcher.close();
            finish();
          }
        } else finish();
      }
    }
    newline = input.indexOf("\\n");
  }
});
`;
	writeFileSync(binary, script, { mode: 0o700 });
	chmodSync(binary, 0o700);
	return binary;
}

function agent(binary: string, overrides: Partial<ConstructorParameters<typeof PrimeSeatAgent>[0]> = {}) {
	const { env: environmentOverrides, ...optionOverrides } = overrides;
	return new PrimeSeatAgent({
		provider: "deck",
		model: "gpt-5.6-sol",
		cwd: os.tmpdir(),
		timeoutMs: 2_000,
		idleTimeoutMs: 500,
		terminationGraceMs: 50,
		brokerApiKey: "test-broker-token",
		patchVerifierPath: path.join(primeHome, "missing-prime-patch-verifier"),
		herdrSocketPath: herdrSocket,
		herdrWorkspaceLabel: "deck-test",
		binary,
		env: { HOME: primeHome, ...environmentOverrides },
		...optionOverrides,
	});
}

async function expectPrimeError(promise: Promise<unknown>, code: PrimeSeatFailureCode) {
	let failure: unknown;
	try {
		await promise;
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(PrimeSeatError);
	const primeFailure = failure as PrimeSeatError;
	expect(primeFailure.code).toBe(code);
	return primeFailure;
}

type IsolatedHerdr = {
	process: ChildProcess;
	root: string;
	socketPath: string;
};

async function herdrApiRequest(
	socketPath: string,
	method: string,
	params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	const id = `prime-test:${crypto.randomUUID()}`;
	const socket = await new Promise<Socket>((resolve, reject) => {
		const connection = createConnection(socketPath);
		connection.once("connect", () => resolve(connection));
		connection.once("error", reject);
	});
	return new Promise<Record<string, unknown>>((resolve, reject) => {
		let input = "";
		socket.once("error", reject);
		socket.on("data", (chunk) => {
			input += chunk.toString("utf8");
			const newline = input.indexOf("\n");
			if (newline < 0) return;
			try {
				const response = JSON.parse(input.slice(0, newline)) as {
					id?: string;
					result?: Record<string, unknown>;
					error?: unknown;
				};
				socket.destroy();
				if (response.id !== id || response.result === undefined || response.error !== undefined) {
					reject(new Error(`Unexpected Herdr ${method} response: ${input.slice(0, newline)}`));
					return;
				}
				resolve(response.result);
			} catch (error) {
				socket.destroy();
				reject(error);
			}
		});
		socket.write(`${JSON.stringify({ id, method, params })}\n`);
	});
}

async function stopFakePrimeDaemon(): Promise<void> {
	await new Promise<void>((resolve) => {
		const socket = createConnection(primeDaemonSocket);
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve();
		};
		// This bounds cleanup of an external process fixture; fake timers cannot
		// drive Unix-socket/process exit behavior.
		const timer = setTimeout(finish, 2_000);
		socket.once("connect", () => {
			socket.write(`${JSON.stringify({ id: "deck-test-shutdown", type: "shutdown", force: true })}\n`);
		});
		socket.once("error", finish);

		socket.once("close", finish);
	});
	await fs.rm(primeDaemonSocket, { force: true });
}
async function fakePrimeDaemonReady(): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const socket = createConnection(primeDaemonSocket);
		let settled = false;
		const finish = (ready: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(ready);
		};
		const timer = setTimeout(() => finish(false), 1_000);
		socket.once("error", () => finish(false));
		socket.on("data", (chunk) => {
			const hello = chunk.toString("utf8");
			finish(hello.includes("\"name\":\"prime-agent.daemon\"") && hello.includes("\"version\":7"));
		});
	});
}

async function startIsolatedHerdr(): Promise<IsolatedHerdr | null> {
	const binary = Bun.which("herdr");
	if (binary === null) return null;
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `deck-prime-herdr-${process.pid}-`));
	const socketPath = path.join(root, "herdr.sock");
	const config = path.join(root, "config.toml");
	await fs.writeFile(
		config,
		'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[ui]\nconfirm_close = false\n',
	);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: root,
		XDG_CONFIG_HOME: path.join(root, "config"),
		XDG_RUNTIME_DIR: path.join(root, "runtime"),
		HERDR_CONFIG_PATH: config,
		HERDR_SOCKET_PATH: socketPath,
	};
	delete env.HERDR_ENV;
	delete env.HERDR_PANE_ID;
	delete env.HERDR_TAB_ID;
	delete env.HERDR_WORKSPACE_ID;
	const child = spawn(binary, ["server"], {
		cwd: root,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let startupOutput = "";
	try {
		await new Promise<void>((resolve, reject) => {
			const handleOutput = (chunk: Buffer) => {
				startupOutput += chunk.toString("utf8");
				if (startupOutput.includes(`api socket: ${socketPath}`)) resolve();
			};
			child.stdout?.on("data", handleOutput);
			child.stderr?.on("data", handleOutput);
			child.once("error", reject);
			child.once("exit", (code, signal) => {
				reject(new Error(`Isolated Herdr exited during startup (${String(code ?? signal)}): ${startupOutput}`));
			});
		});
		return { process: child, root, socketPath };
	} catch (error) {
		child.kill("SIGKILL");
		await fs.rm(root, { recursive: true, force: true });
		throw error;
	}
}

describe("Prime seat adapter fault contract", () => {
	test("records exact root and child broker model provenance with exit status and tokens", async () => {
		const binary = await fakePrime("success-child");
		const result = runRecordSchema.parse(await agent(binary, { effortLabel: "lindy#27140" }).generate({
			prompt: "Return the result",
			outputSchema: z.object({ ok: z.literal(true) }),
			taskContext: { runId: "run-abc", nodeId: "watch-fix", iteration: 0, attempt: 0 },
		}));
		const record = result.providerMetadata.prime;
		expect(record.requestedModel).toBe("deck/gpt-5.6-sol");
		expect(record.rootModel).toMatchObject({ provider: "deck", model: "gpt-5.6-sol", source: "transcript" });
		expect(record.herdr).toEqual({
			attached: true,
			paneId: expect.stringMatching(/^deck-test:p/),
			label: "lindy#27140 · watch-fix · run-abc",
		});
		expect(record.childModels).toEqual([
			expect.objectContaining({ provider: "deck", model: "gpt-5.6-terra", depth: 1 }),
		]);
		expect(record.exitStatus).toEqual({ code: 0, signal: null });
		expect(record.tokens).toEqual({ input: 15, output: 7, total: 22 });
		expect(herdrRequests.filter((request) => request.method === "pane.close")).toHaveLength(1);
	});

	test("kills a stalled root process group and returns a structured stalled result", async () => {
		const capture = path.join(os.tmpdir(), `prime-stall-${crypto.randomUUID()}`);
		roots.push(capture, `${capture}.pid`);
		const binary = await fakePrime("stall", capture);
		const failure = await expectPrimeError(agent(binary, { idleTimeoutMs: 100 }).generate({ prompt: "stall" }), "PRIME_STALLED");
		expect(failure.result.status).toBe("stalled");
		const descendantPid = Number.parseInt(readFileSync(`${capture}.pid`, "utf8"), 10);
		expect(() => process.kill(descendantPid, 0)).toThrow();
		const invocations = readFileSync(capture, "utf8").trim().split("\n")
			.map((line) => JSON.parse(line) as { args: string[] });
		expect(invocations.some(({ args }) => args.includes("stop") && args.includes("root-session"))).toBe(true);
		expect(invocations.some(({ args }) => args.includes("shutdown"))).toBe(false);
		expect(herdrRequests.filter((request) => request.method === "pane.close")).toHaveLength(1);
		expect(herdrPanes.has(captainPane.paneId)).toBe(true);
		expect(herdrPanes.size).toBe(1);
	});

	test("missing and malformed final yields are typed failures", async () => {
		const schema = z.object({ ok: z.literal(true) });
		const missing = await fakePrime("missing");
		await expectPrimeError(agent(missing).generate({ prompt: "missing", outputSchema: schema }), "PRIME_MISSING_YIELD");
		const malformed = await fakePrime("malformed");
		await expectPrimeError(agent(malformed).generate({ prompt: "malformed", outputSchema: schema }), "PRIME_MALFORMED_YIELD");
	});

	test("missing root transcript or model attestation fails closed", async () => {
		for (const mode of ["missing-transcript", "no-model-provenance"] as const) {
			const binary = await fakePrime(mode);
			await expectPrimeError(agent(binary).generate({ prompt: mode }), "PRIME_MISSING_PROVENANCE");
		}
	});

	test("missing broker authentication is a typed failure event", async () => {
		const binary = await fakePrime("success");
		const events: Array<Record<string, unknown>> = [];
		const depthTwo = await fakePrime("depth-two-child");
		await expectPrimeError(agent(depthTwo).generate({ prompt: "depth" }), "PRIME_CHILD_MODEL_INVALID");
		const failure = await expectPrimeError(
			agent(binary, { brokerApiKey: "" }).generate({
				prompt: "auth",
				onEvent: (event) => { events.push(event as Record<string, unknown>); },
			}),
			"PRIME_BROKER_AUTH_FAILED",
		);
		expect(failure.result.status).toBe("failed");
		expect(events).toContainEqual(expect.objectContaining({ type: "completed", ok: false }));
	});

	test("RPC transport death stops a reported shared-daemon session before returning a typed failure", async () => {
		const capture = path.join(os.tmpdir(), `prime-transport-death-${crypto.randomUUID()}`);
		roots.push(capture);
		const binary = await fakePrime("transport-death", capture);
		const failure = await expectPrimeError(agent(binary).generate({ prompt: "die" }), "PRIME_RPC_TRANSPORT_DIED");
		expect(failure.result.exitStatus.code).toBe(7);
		const invocations = readFileSync(capture, "utf8").trim().split("\n")
			.map((line) => JSON.parse(line) as { args: string[] });
		expect(invocations.some(({ args }) => args.includes("stop") && args.includes("root-session"))).toBe(true);
	});

	test("honors the exact pin and fails closed on invalid or substituted pins", async () => {
		const success = await fakePrime("success");
		const result = runRecordSchema.parse(await agent(success).generate({ prompt: "pin" }));
		expect(result.providerMetadata.prime.rootModel).toMatchObject({ provider: "deck", model: "gpt-5.6-sol" });
		const wrong = await fakePrime("wrong-model");
		await expectPrimeError(agent(wrong).generate({ prompt: "wrong" }), "PRIME_MODEL_MISMATCH");
		expect(() => agent(success, { model: "gpt-4o" })).toThrow(/PRIME_MODEL_MISMATCH/);
	});

	test("honors binary config and environment overrides, falls back to PATH, and explains a missing binary", async () => {
		const success = await fakePrime("success");
		const mismatch = await fakePrime("version-mismatch");
		await agent(success, {

			env: { PATH: `${path.dirname(mismatch)}${path.delimiter}${process.env.PATH ?? ""}` },
		}).preflight();

		const originalOverride = process.env.DECK_PRIME_AGENT_BINARY;
		process.env.DECK_PRIME_AGENT_BINARY = success;
		try {
			await agent(success, {
				binary: undefined,
				env: { PATH: `${path.dirname(mismatch)}${path.delimiter}${process.env.PATH ?? ""}` },
			}).preflight();
		} finally {
			if (originalOverride === undefined) delete process.env.DECK_PRIME_AGENT_BINARY;
			else process.env.DECK_PRIME_AGENT_BINARY = originalOverride;
		}

		await agent(success, {
			binary: undefined,
			brokerApiKey: "test-broker-token",
			env: { PATH: `${path.dirname(success)}${path.delimiter}${process.env.PATH ?? ""}` },
		}).generate({ prompt: "PATH fallback" });

		const missingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deck-prime-missing-"));
		roots.push(missingRoot);
		const failure = await expectPrimeError(agent(success, {
			binary: undefined,
			brokerApiKey: "test-broker-token",
			env: { PATH: missingRoot },
		}).preflight(), "PRIME_SPAWN_FAILED");
		expect(failure.message).toContain("DECK_PRIME_AGENT_BINARY");
		expect(failure.message).toContain("from PATH");

		const wrongVersion = await fakePrime("version-mismatch");
		await expectPrimeError(agent(wrongVersion).generate({ prompt: "version" }), "PRIME_VERSION_MISMATCH");
	});
	test("requires the repository patch fingerprint when its verifier is present", async () => {
		const binary = await fakePrime("success");
		const passing = path.join(primeHome, `prime-patches-pass-${crypto.randomUUID()}`);
		const failing = path.join(primeHome, `prime-patches-fail-${crypto.randomUUID()}`);
		writeFileSync(passing, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		writeFileSync(failing, "#!/bin/sh\necho 'patched package fingerprint mismatch' >&2\nexit 1\n", { mode: 0o700 });
		await agent(binary, { patchVerifierPath: passing }).preflight();
		const failure = await expectPrimeError(
			agent(binary, { patchVerifierPath: failing }).preflight(),
			"PRIME_VERSION_MISMATCH",
		);
		expect(failure.result.stderr).toContain("patched package fingerprint mismatch");
	});

	test("loads broker authentication when an absolute Prime binary override is configured", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-prime-token-"));
		roots.push(root);
		const tokenFile = path.join(root, "gateway.token");
		const capture = path.join(root, "capture.jsonl");
		await fs.writeFile(tokenFile, "broker-from-file\n", { mode: 0o600 });
		const binary = await fakePrime("success", capture);
		const originalTokenFile = process.env.DECK_GATEWAY_TOKEN_FILE;
		process.env.DECK_GATEWAY_TOKEN_FILE = tokenFile;
		try {
			await agent(binary, { brokerApiKey: undefined }).generate({ prompt: "authenticated override" });
			const captured = JSON.parse(readFileSync(capture, "utf8").trim()) as { env: Record<string, string> };
			expect(captured.env.DECK_GATEWAY_API_KEY).toBe("broker-from-file");
		} finally {
			if (originalTokenFile === undefined) delete process.env.DECK_GATEWAY_TOKEN_FILE;
			else process.env.DECK_GATEWAY_TOKEN_FILE = originalTokenFile;
		}
	});

	test("seat environment excludes publisher, merge, stamp, admin, provider, and SSH credentials", async () => {
		const capture = path.join(os.tmpdir(), `prime-env-${crypto.randomUUID()}`);
		roots.push(capture);
		const binary = await fakePrime("success", capture);
		const secrets = {
			GH_TOKEN: "push",
			GITHUB_TOKEN: "publish",
			SSH_AUTH_SOCK: "/tmp/ssh",
			SMITHERS_GATEWAY_TOKEN: "admin",
			DECK_STAMP_TOKEN: "stamp",
			DECK_PUBLISHER_TOKEN: "publisher",
			ADMIN_TOKEN: "admin",
			OPENAI_API_KEY: "provider",
		};
		await agent(binary, {
			env: { ...secrets, HERDR_ENV: "1", HERDR_PANE_ID: "captain-pane", HERDR_SOCKET_PATH: "/tmp/captain-herdr.sock" },
		}).generate({ prompt: "env" });
		const captured = JSON.parse(readFileSync(capture, "utf8").trim()) as {
			args: string[];
			env: Record<string, string>;
			homeTokenExists: boolean;
			gitConfigExists: boolean;
		};
		for (const key of Object.keys(secrets)) expect(captured.env[key], key).toBeUndefined();
		expect(captured.env.HERDR_PANE_ID).toStartWith("deck-test:p");
		expect(captured.env.HERDR_SOCKET_PATH).toBe(herdrSocket);
		expect(captured.env.HOME).toContain("deck-prime-seat-");
		expect(captured.homeTokenExists).toBe(false);
		expect(captured.gitConfigExists).toBe(true);
		expect(captured.env.RLM_DEPTH).toBe("0");
		expect(captured.env.RLM_MAX_DEPTH).toBe("1");
		const tools = captured.args[captured.args.indexOf("--tools") + 1].split(",");
		expect(tools).toContain("ipython");
		expect(tools.some((tool) => /dispatch|spawn|subagent|task/i.test(tool))).toBe(false);
	});

	test("concurrent seats share one supervisor while keeping distinct sessions and top-level panes", async () => {
		await stopFakePrimeDaemon();
		const capture = path.join(os.tmpdir(), `prime-isolation-${crypto.randomUUID()}`);
		roots.push(capture);
		const binary = await fakePrime("success", capture);
		await Promise.all([
			agent(binary, { effortLabel: "effort-a" }).generate({
				prompt: "a",
				taskContext: { runId: "run-a", nodeId: "stage-a", iteration: 0, attempt: 0 },
			}),
			agent(binary, { effortLabel: "effort-b" }).generate({
				prompt: "b",
				taskContext: { runId: "run-b", nodeId: "stage-b", iteration: 0, attempt: 0 },
			}),
		]);
		const capturedRows = readFileSync(capture, "utf8").trim().split("\n")
			.map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
		const daemonRows = capturedRows.filter((row) => row.args[row.args.indexOf("--mode") + 1] === "daemon");
		const rows = capturedRows.filter((row) => row.args[row.args.indexOf("--mode") + 1] === "rpc");
		expect(daemonRows).toHaveLength(1);
		expect(rows).toHaveLength(2);
		const values = (flag: string) => rows.map((row) => row.args[row.args.indexOf(flag) + 1]);
		expect(new Set(values("--daemon-socket"))).toEqual(new Set([primeDaemonSocket]));
		expect(new Set(values("--session-dir")).size).toBe(2);
		expect(new Set(rows.map((row) => row.env.PRIME_AGENT_CODING_AGENT_DIR))).toEqual(
			new Set([resolveDeckPrimeProfilePaths(primeHome).agentDir]),
		);
		expect(new Set(rows.map((row) => row.env.HERDR_PANE_ID)).size).toBe(2);
		expect(await fakePrimeDaemonReady()).toBe(true);
		const creates = herdrRequests.filter((request) => request.method === "tab.create");
		expect(creates).toHaveLength(2);
		expect(creates.map((request) => (request.params as Record<string, unknown>).label).sort()).toEqual([
			"effort-a · stage-a · run-a",
			"effort-b · stage-b · run-b",
		]);
		expect(herdrRequests.some((request) => request.method === "pane.split")).toBe(false);
		expect(herdrRequests.some((request) => (request.params as Record<string, unknown>).pane_id === captainPane.paneId)).toBe(false);
		expect(herdrPanes.has(captainPane.paneId)).toBe(true);
		expect(herdrPanes.size).toBe(1);
		for (const directory of values("--session-dir")) expect(existsSync(directory)).toBe(false);
	});

	test("workflow and spawn-agent profiles reject dispatch-capable tools and extensions", async () => {
		const binary = await fakePrime("success");
		for (const capabilityProfile of ["workflow-seat", "spawn-agent"] as const) {
			expect(() => agent(binary, { capabilityProfile, tools: ["read", "dispatch"] })).toThrow(/PRIME_CAPABILITY_VIOLATION/);
			expect(() => agent(binary, { capabilityProfile, extensions: ["/tmp/deck-subagents.ts"] })).toThrow(/PRIME_CAPABILITY_VIOLATION/);
		}
	});

	test("headless supervisor creates and cleans a labelled top-level pane in an isolated real Herdr workspace", async () => {
		const isolated = await startIsolatedHerdr();
		if (isolated === null) return;
		const herdrKeys = [
			"HERDR_ENV",
			"HERDR_SOCKET_PATH",
			"HERDR_PANE_ID",
			"HERDR_TAB_ID",
			"HERDR_WORKSPACE_ID",
			"DECK_HERDR_SOCKET_PATH",
			"DECK_HERDR_WORKSPACE_ID",
			"DECK_HERDR_WORKSPACE_LABEL",
			"DECK_HERDR_STRICT",
		] as const;
		const savedEnvironment = new Map(herdrKeys.map((key) => [key, process.env[key]]));
		for (const key of herdrKeys) delete process.env[key];
		const capture = path.join(isolated.root, "prime-capture.jsonl");
		const gate = `${capture}.release`;
		let running: Promise<unknown> | undefined;
		try {
			const binary = await fakePrime("success-slow", capture);
			const started = Promise.withResolvers<void>();
			running = agent(binary, {
				effortLabel: "lindy#27140",
				herdrSocketPath: isolated.socketPath,
				herdrWorkspaceLabel: `deck-prime-integration-${process.pid}`,
				idleTimeoutMs: 1_000,
			}).generate({
				prompt: "headless",
				taskContext: { runId: "run-headless", nodeId: "review", iteration: 0, attempt: 0 },
				onProcess: (event) => {
					if (event.phase === "started") started.resolve();
				},
			});
			await started.promise;
			const live = await herdrApiRequest(isolated.socketPath, "session.snapshot");
			const snapshot = live.snapshot as {
				panes: Array<{ pane_id: string; tab_id: string }>;
				tabs: Array<{ tab_id: string; label: string; pane_count: number }>;
				layouts: Array<{ tab_id: string; splits: unknown[] }>;
			};
			const label = "lindy#27140 · review · run-headless";
			const tab = snapshot.tabs.find((candidate) => candidate.label === label);
			expect(tab).toBeDefined();
			expect(tab?.pane_count).toBe(1);
			if (tab === undefined) throw new Error(`Herdr did not create top-level tab ${label}`);
			const pane = snapshot.panes.find((candidate) => candidate.tab_id === tab.tab_id);
			if (pane === undefined) throw new Error(`Herdr tab ${tab.tab_id} has no root pane`);
			expect(snapshot.layouts.find((layout) => layout.tab_id === tab.tab_id)?.splits).toEqual([]);

			writeFileSync(gate, "release");
			const result = runRecordSchema.parse(await running);
			expect(result.providerMetadata.prime.herdr).toEqual({
				attached: true,
				paneId: pane.pane_id,
				label,
			});
			const cleaned = await herdrApiRequest(isolated.socketPath, "session.snapshot");
			const cleanedSnapshot = cleaned.snapshot as { panes: Array<{ pane_id: string }> };
			expect(cleanedSnapshot.panes.some((candidate) => candidate.pane_id === pane.pane_id)).toBe(false);
		} finally {
			if (!existsSync(gate)) writeFileSync(gate, "release");
			await running?.catch(() => undefined);
			if (isolated.process.exitCode === null && isolated.process.signalCode === null) {
				const stopped = new Promise<void>((resolve) => isolated.process.once("close", () => resolve()));
				isolated.process.kill("SIGTERM");
				await stopped;
			}
			await fs.rm(isolated.root, { recursive: true, force: true });
			for (const [key, value] of savedEnvironment) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	test("runs without Herdr, logs a warning, and withholds ambient pane identity when the socket is unavailable", async () => {
		const capture = path.join(os.tmpdir(), `prime-no-herdr-${crypto.randomUUID()}`);
		roots.push(capture);
		const binary = await fakePrime("success", capture);
		const stderr: string[] = [];
		const warning = spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const result = runRecordSchema.parse(await agent(binary, {
				herdrSocketPath: path.join(herdrRoot, "unavailable.sock"),
				herdrStrict: false,
			}).generate({
				prompt: "ship without board",
				onStderr: (text) => { stderr.push(text); },
			}));
			expect(result.providerMetadata.prime.herdr).toMatchObject({
				attached: false,
				paneId: null,
				warning: expect.stringContaining("continuing without Herdr board visibility"),
			});
			expect(warning).toHaveBeenCalledWith(expect.stringContaining("continuing without Herdr board visibility"));
			expect(stderr.join("")).toContain("continuing without Herdr board visibility");
			const captured = JSON.parse(readFileSync(capture, "utf8").trim()) as { env: Record<string, string> };
			for (const key of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]) {
				expect(captured.env[key], key).toBeUndefined();
			}
		} finally {
			warning.mockRestore();
		}
	});

	test("keeps Herdr attachment fail-closed only behind explicit strict mode", async () => {
		const binary = await fakePrime("success");
		await expectPrimeError(agent(binary, {
			herdrSocketPath: path.join(herdrRoot, "strict-unavailable.sock"),
			herdrStrict: true,
		}).generate({ prompt: "strict" }), "PRIME_HERDR_ATTACH_FAILED");
	});

	test("environment builder is an allowlist rather than a secret-name redactor", () => {
		expect(buildSeatEnvironment({
			PATH: "/bin",
			HOME: "/home/seat",
			DECK_PRIME_DAEMON_SOCKET: "/tmp/deck-prime.sock",
			GH_TOKEN: "secret",
			UNEXPECTED_NON_SECRET_FLAG: "still-not-allowed",
		})).toEqual({
			PATH: "/bin",
			HOME: "/home/seat",
			DECK_PRIME_DAEMON_SOCKET: "/tmp/deck-prime.sock",
		});
	});
});
