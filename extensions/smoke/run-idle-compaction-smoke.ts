#!/usr/bin/env bun
/**
 * Real pi smoke for the idle-compaction extension. This uses the configured
 * deck broker and writes bounded evidence under smoke/evidence/. It never
 * installs the extension into ~/.pi.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// Defaults to the in-repo source. Set SMOKE_EXTENSION_PATH to point the same
// smoke at an INSTALLED layout (e.g. ~/.pi/agent/extensions/deck-idle-compaction),
// which also proves the installed directory's relative policy import resolves.
const extensionPath = process.env.SMOKE_EXTENSION_PATH
	? resolve(process.env.SMOKE_EXTENSION_PATH)
	: resolve(import.meta.dir, "../src/idle-compaction.ts");
const sessionDir = resolve(import.meta.dir, ".sessions");
const evidenceDir = resolve(import.meta.dir, "evidence");
mkdirSync(sessionDir, { recursive: true });
mkdirSync(evidenceDir, { recursive: true });

const smokeConfig = {
	ttlMs: 20_000,
	marginMs: 5_000,
	floorPercent: 1,
	engine: "client",
} as const;
const smokeEnv = {
	PI_IDLE_COMPACTION_TTL_MS: String(smokeConfig.ttlMs),
	PI_IDLE_COMPACTION_MARGIN_MS: String(smokeConfig.marginMs),
	PI_IDLE_COMPACTION_FLOOR_PERCENT: String(smokeConfig.floorPercent),
	PI_IDLE_COMPACTION_NOTIFY: "1",
};
const versionProcess = Bun.spawnSync(["pi", "--version"], { stdout: "pipe", stderr: "pipe" });
if (versionProcess.exitCode !== 0) throw new Error("Could not determine pi version");
const piVersion = versionProcess.stdout.toString().trim();

const child = Bun.spawn(
	[
		"pi",
		"--mode",
		"rpc",
		"--provider",
		"deck",
		"--model",
		"claude-haiku-4-5",
		"--thinking",
		"off",
		"--session-dir",
		sessionDir,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--extension",
		extensionPath,
	],
	{
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...smokeEnv },
	},
);

interface RpcRecord {
	id?: string;
	type?: string;
	command?: string;
	success?: boolean;
	method?: string;
	message?: string;
	data?: any;
	result?: any;
	reason?: string;
	[key: string]: unknown;
}

let sequence = 0;
let buffer = "";
const records: RpcRecord[] = [];
const waiters = new Set<{
	predicate: (record: RpcRecord) => boolean;
	resolve: (record: RpcRecord) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}>();

function recordIsBoundedEvidence(record: RpcRecord): boolean {
	return (
		record.type === "agent_settled" ||
		record.type === "compaction_start" ||
		record.type === "compaction_end" ||
		(record.type === "extension_ui_request" && record.method === "notify") ||
		(record.type === "response" &&
			["get_session_stats", "get_state", "get_entries"].includes(record.command ?? ""))
	);
}

function consume(record: RpcRecord): void {
	if (recordIsBoundedEvidence(record)) records.push(record);
	for (const waiter of [...waiters]) {
		if (!waiter.predicate(record)) continue;
		waiters.delete(waiter);
		clearTimeout(waiter.timer);
		waiter.resolve(record);
	}
}

(async () => {
	for await (const chunk of child.stdout) {
		buffer += new TextDecoder().decode(chunk, { stream: true });
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (line !== "") consume(JSON.parse(line) as RpcRecord);
		}
	}
})().catch((error) => {
	console.error(error);
});

function waitFor(
	predicate: (record: RpcRecord) => boolean,
	timeoutMs = 120_000,
): Promise<RpcRecord> {
	return new Promise((resolvePromise, reject) => {
		const waiter = {
			predicate,
			resolve: resolvePromise,
			reject,
			timer: setTimeout(() => {
				waiters.delete(waiter);
				reject(new Error(`Timed out after ${timeoutMs}ms`));
			}, timeoutMs),
		};
		waiters.add(waiter);
	});
}

async function command(type: string, fields: Record<string, unknown> = {}): Promise<RpcRecord> {
	const id = `smoke-${++sequence}`;
	const response = waitFor((record) => record.type === "response" && record.id === id);
	child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
	await child.stdin.flush();
	const result = await response;
	if (!result.success) throw new Error(`${type} failed: ${JSON.stringify(result)}`);
	return result;
}

function compactEntries(record: RpcRecord): unknown[] {
	return (record.data?.entries ?? []).filter((entry: any) =>
		["compaction", "custom"].includes(entry.type),
	);
}

try {
	await command("get_state");
	// Four separately persisted direct-bash outputs produce >30k context tokens
	// without asking the model to generate filler. Each output remains below pi's
	// normal 50KB tool-output ceiling.
	for (let index = 0; index < 4; index += 1) {
		await command("bash", {
			command: `python3 -c 'print("context-block-${index} " * 3200)'`,
		});
	}

	const settled = waitFor((record) => record.type === "agent_settled");
	await command("prompt", {
		message: "Reply with exactly READY. Do not call tools.",
	});
	await settled;
	const before = await command("get_session_stats");
	const state = await command("get_state");

	const compaction = await waitFor(
		(record) => record.type === "compaction_end" && record.result !== null,
		90_000,
	);
	// A fresh provider turn replaces pi's immediate post-compaction null estimate
	// with provider-reported context usage, proving the next turn is smaller.
	const postCompactionSettled = waitFor((record) => record.type === "agent_settled");
	await command("prompt", {
		message: "Reply with exactly AFTER. Do not call tools.",
	});
	await postCompactionSettled;
	const after = await command("get_session_stats");
	const entries = await command("get_entries");

	const beforeTokens = before.data?.contextUsage?.tokens;
	const result = compaction.result as { tokensBefore?: number; estimatedTokensAfter?: number };
	if (!(typeof beforeTokens === "number" && beforeTokens >= 2_000)) {
		throw new Error(`Context did not reach smoke floor: ${beforeTokens}`);
	}
	if (
		!(
			typeof result.tokensBefore === "number" &&
			typeof result.estimatedTokensAfter === "number" &&
			result.estimatedTokensAfter < result.tokensBefore &&
			typeof after.data?.contextUsage?.tokens === "number" &&
			after.data.contextUsage.tokens < result.tokensBefore
		)
	) {
		throw new Error(
			`Compaction did not reduce the next turn's context: ${JSON.stringify({ result, after: after.data?.contextUsage })}`,
		);
	}

	const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	const evidence = {
		runAt: new Date().toISOString(),
		piVersion,
		model: "deck/claude-haiku-4-5",
		config: smokeConfig,
		extensionPath,
		sessionFile: basename(state.data?.sessionFile ?? "unknown"),
		before: before.data?.contextUsage,
		compaction: compaction.result,
		after: after.data?.contextUsage,
		transcript: records.filter((record) => record.command !== "get_entries"),
		sessionJsonlEvidence: compactEntries(entries),
	};
	const outputPath = join(evidenceDir, `${timestamp}.json`);
	const serialized = JSON.stringify(evidence, (key, value) => {
		if (key === "sessionFile" && typeof value === "string") return basename(value);
		if (typeof value === "string") {
			return value.replaceAll(resolve(import.meta.dir, "../.."), "<deck-worktree>");
		}
		return value;
	}, 2);
	writeFileSync(outputPath, `${serialized}\n`);
	console.log(`Smoke passed: ${result.tokensBefore} → ~${result.estimatedTokensAfter} tokens`);
	console.log(`Session: ${basename(state.data?.sessionFile ?? "unknown")}`);
	console.log(`Evidence: ${outputPath}`);
} finally {
	child.kill("SIGTERM");
	await child.exited;
	const stderr = await new Response(child.stderr).text();
	if (stderr.trim() !== "") console.error(stderr.trim());
}
