import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";

import {
	buildSeatEnvironment,
	PrimeSeatAgent,
	PrimeSeatError,
	type PrimeSeatFailureCode,
} from "../lib/engines/prime.ts";

const roots: string[] = [];
let herdrServer: Server;
let herdrRoot: string;
let herdrSocket: string;
let herdrPaneSequence = 0;
const herdrRequests: Array<Record<string, unknown>> = [];
const originalHerdrEnv = {
	enabled: process.env.HERDR_ENV,
	socket: process.env.HERDR_SOCKET_PATH,
	pane: process.env.HERDR_PANE_ID,
};

beforeAll(async () => {
	herdrRoot = await fs.mkdtemp(path.join(os.tmpdir(), `deck-test-${process.pid}-`));
	herdrSocket = path.join(herdrRoot, "herdr.sock");
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
				const paneId = method === "pane.split" ? `deck-test:p${++herdrPaneSequence}` : String(params.pane_id ?? "");
				const result = method === "pane.split"
					? { type: "pane_info", pane: { pane_id: paneId, tab_id: "deck-test:t1", workspace_id: "deck-test" } }
					: { type: "ok" };
				socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
				newline = input.indexOf("\n");
			}
		});
	});
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	herdrServer.once("error", reject);
	herdrServer.listen(herdrSocket, resolve);
	await promise;
	process.env.HERDR_ENV = "1";
	process.env.HERDR_SOCKET_PATH = herdrSocket;
	process.env.HERDR_PANE_ID = "deck-test:parent";
});

afterAll(async () => {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	herdrServer.close((error) => error === undefined ? resolve() : reject(error));
	await promise;
	if (originalHerdrEnv.enabled === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = originalHerdrEnv.enabled;
	if (originalHerdrEnv.socket === undefined) delete process.env.HERDR_SOCKET_PATH;
	else process.env.HERDR_SOCKET_PATH = originalHerdrEnv.socket;
	if (originalHerdrEnv.pane === undefined) delete process.env.HERDR_PANE_ID;
	else process.env.HERDR_PANE_ID = originalHerdrEnv.pane;
	await fs.rm(herdrRoot, { recursive: true, force: true });
});

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
	herdrRequests.length = 0;
});

const runRecordSchema = z.object({
	providerMetadata: z.object({
		prime: z.object({
			engine: z.literal("prime"),
			version: z.literal("0.7.0"),
			requestedModel: z.string(),
			rootModel: z.object({ provider: z.string(), model: z.string(), source: z.string() }).passthrough(),
			herdr: z.object({ paneId: z.string(), label: z.string() }),
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
const daemonSocket = valueAfter("--daemon-socket");
if (valueAfter("--mode") === "daemon") {
  try { fs.unlinkSync(daemonSocket); } catch {}
  const server = net.createServer((socket) => {
    socket.write(JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent-daemon", version: 7 } }) + "\\n");
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
if (captureFile) fs.appendFileSync(captureFile, JSON.stringify({ args, env: process.env, homeTokenExists: fs.existsSync(path.join(process.env.HOME, ".deck", "broker", "gateway.token")), gitConfigExists: fs.existsSync(path.join(process.env.HOME, ".gitconfig")) }) + "\\n");
if (mode === "stall") {
  // Deliberately real processes: this fault drill proves OS process-group teardown.
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  if (captureFile) fs.writeFileSync(captureFile + ".pid", String(descendant.pid));
  process.on("SIGTERM", () => descendant.once("exit", () => process.exit(0)));
  setInterval(() => {}, 1000);
  return;
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
      if (mode === "transport-death") process.exit(7);
      const answer = mode === "malformed" ? "not-json" : mode === "missing" ? "" : "{\\"ok\\":true}";
      if (mode !== "missing-transcript") persist(answer);
      send({ type: "session", version: 3, id: "root-session", timestamp: new Date().toISOString(), cwd: process.cwd() });
      send({ type: "agent_start" });
      send({ type: "agent_end", messages: answer ? [{ role: "assistant", content: [{ type: "text", text: answer }], provider, model }] : [] });
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
	return new PrimeSeatAgent({
		provider: "deck",
		model: "gpt-5.6-sol",
		cwd: os.tmpdir(),
		timeoutMs: 2_000,
		idleTimeoutMs: 500,
		terminationGraceMs: 50,
		binary,
		...overrides,
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
		expect(herdrRequests.filter((request) => request.method === "pane.close")).toHaveLength(1);
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

	test("RPC transport death after prompt acceptance is a typed failure", async () => {
		const binary = await fakePrime("transport-death");
		const failure = await expectPrimeError(agent(binary).generate({ prompt: "die" }), "PRIME_RPC_TRANSPORT_DIED");
		expect(failure.result.exitStatus.code).toBe(7);
	});

	test("honors the exact pin and fails closed on invalid or substituted pins", async () => {
		const success = await fakePrime("success");
		const result = runRecordSchema.parse(await agent(success).generate({ prompt: "pin" }));
		expect(result.providerMetadata.prime.rootModel).toMatchObject({ provider: "deck", model: "gpt-5.6-sol" });
		const wrong = await fakePrime("wrong-model");
		await expectPrimeError(agent(wrong).generate({ prompt: "wrong" }), "PRIME_MODEL_MISMATCH");
		expect(() => agent(success, { model: "gpt-4o" })).toThrow(/PRIME_MODEL_MISMATCH/);
	});

	test("fails closed when the PATH-resolved binary is not the pinned release", async () => {
		const binary = await fakePrime("version-mismatch");
		await expectPrimeError(agent(binary).generate({ prompt: "version" }), "PRIME_VERSION_MISMATCH");
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
			env: { ...secrets, HERDR_ENV: "1", HERDR_PANE_ID: "seat-pane", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
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

	test("concurrent seats use distinct state, session, socket, and Herdr pane environments", async () => {
		const capture = path.join(os.tmpdir(), `prime-isolation-${crypto.randomUUID()}`);
		roots.push(capture);
		const binary = await fakePrime("success", capture);
		await Promise.all([
			agent(binary, { env: { HERDR_ENV: "1", HERDR_PANE_ID: "pane-a", HERDR_SOCKET_PATH: "/tmp/herdr-a.sock" } }).generate({ prompt: "a" }),
			agent(binary, { env: { HERDR_ENV: "1", HERDR_PANE_ID: "pane-b", HERDR_SOCKET_PATH: "/tmp/herdr-b.sock" } }).generate({ prompt: "b" }),
		]);
		const rows = readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
		expect(rows).toHaveLength(2);
		const values = (flag: string) => rows.map((row) => row.args[row.args.indexOf(flag) + 1]);
		expect(new Set(values("--daemon-socket")).size).toBe(2);
		expect(new Set(values("--session-dir")).size).toBe(2);
		expect(new Set(rows.map((row) => row.env.PRIME_AGENT_CODING_AGENT_DIR)).size).toBe(2);
		expect(new Set(rows.map((row) => row.env.HERDR_PANE_ID)).size).toBe(2);
		for (const directory of values("--session-dir")) expect(existsSync(directory)).toBe(false);
	});

	test("workflow and spawn-agent profiles reject dispatch-capable tools and extensions", async () => {
		const binary = await fakePrime("success");
		for (const capabilityProfile of ["workflow-seat", "spawn-agent"] as const) {
			expect(() => agent(binary, { capabilityProfile, tools: ["read", "dispatch"] })).toThrow(/PRIME_CAPABILITY_VIOLATION/);
			expect(() => agent(binary, { capabilityProfile, extensions: ["/tmp/deck-subagents.ts"] })).toThrow(/PRIME_CAPABILITY_VIOLATION/);
		}
	});

	test("fails closed instead of launching without automatic Herdr attachment", async () => {
		const binary = await fakePrime("success");
		const enabled = process.env.HERDR_ENV;
		const socket = process.env.HERDR_SOCKET_PATH;
		const pane = process.env.HERDR_PANE_ID;
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_SOCKET_PATH;
		delete process.env.HERDR_PANE_ID;
		try {
			await expectPrimeError(agent(binary).generate({ prompt: "no-herdr" }), "PRIME_HERDR_ATTACH_FAILED");
		} finally {
			process.env.HERDR_ENV = enabled;
			process.env.HERDR_SOCKET_PATH = socket;
			process.env.HERDR_PANE_ID = pane;
		}
	});

	test("environment builder is an allowlist rather than a secret-name redactor", () => {
		expect(buildSeatEnvironment({
			PATH: "/bin",
			HOME: "/home/seat",
			GH_TOKEN: "secret",
			UNEXPECTED_NON_SECRET_FLAG: "still-not-allowed",
		})).toEqual({ PATH: "/bin", HOME: "/home/seat" });
	});
});
