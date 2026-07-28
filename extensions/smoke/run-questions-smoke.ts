#!/usr/bin/env bun
/**
 * Real pi smoke for the questions extension: queue -> list -> answer -> asker
 * reads the answer, across TWO separate pi processes sharing only the queue
 * file. That separation is the whole point of the extension, so the check has
 * to span processes rather than call the store twice in one runtime.
 *
 * The asking side goes through the LLM so the tool is exercised the way an
 * agent actually reaches it. The captain side needs no LLM: /questions is an
 * extension command, and its dialogs arrive as RPC extension_ui_requests.
 *
 * Writes bounded evidence under smoke/evidence/. Never touches the live queue
 * or ~/.pi: DECK_QUESTIONS_FILE points both processes at a temp file.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { readQuestions } from "../src/questions-store";

const extensionPath = process.env.SMOKE_EXTENSION_PATH
	? resolve(process.env.SMOKE_EXTENSION_PATH)
	: resolve(import.meta.dir, "../src/questions.ts");
const sessionDir = resolve(import.meta.dir, ".sessions");
const evidenceDir = resolve(import.meta.dir, "evidence");
mkdirSync(sessionDir, { recursive: true });
mkdirSync(evidenceDir, { recursive: true });
const queuePath = join(mkdtempSync(join(tmpdir(), "deck-questions-smoke-")), "queue.jsonl");

const versionProcess = Bun.spawnSync(["pi", "--version"], { stdout: "pipe", stderr: "pipe" });
if (versionProcess.exitCode !== 0) throw new Error("Could not determine pi version");
const piVersion = versionProcess.stdout.toString().trim();

interface RpcRecord {
	id?: string;
	type?: string;
	command?: string;
	success?: boolean;
	method?: string;
	message?: any;
	data?: any;
	options?: string[];
	[key: string]: unknown;
}

/** One pi RPC process plus the line-framing and waiter plumbing to drive it. */
class PiProcess {
	readonly records: RpcRecord[] = [];
	private readonly child: ReturnType<typeof Bun.spawn>;
	private readonly waiters = new Set<{
		predicate: (record: RpcRecord) => boolean;
		resolve: (record: RpcRecord) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();
	private sequence = 0;
	private buffer = "";

	constructor(readonly label: string) {
		this.child = Bun.spawn(
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
				env: { ...process.env, DECK_QUESTIONS_FILE: queuePath },
			},
		);
		void this.pump();
	}

	private async pump(): Promise<void> {
		for await (const chunk of this.child.stdout) {
			this.buffer += new TextDecoder().decode(chunk, { stream: true });
			while (true) {
				const newline = this.buffer.indexOf("\n");
				if (newline < 0) break;
				const line = this.buffer.slice(0, newline).replace(/\r$/, "");
				this.buffer = this.buffer.slice(newline + 1);
				if (line === "") continue;
				const record = JSON.parse(line) as RpcRecord;
				this.records.push(record);
				for (const waiter of [...this.waiters]) {
					if (!waiter.predicate(record)) continue;
					this.waiters.delete(waiter);
					clearTimeout(waiter.timer);
					waiter.resolve(record);
				}
			}
		}
	}

	waitFor(predicate: (record: RpcRecord) => boolean, timeoutMs = 120_000): Promise<RpcRecord> {
		return new Promise((resolvePromise, reject) => {
			const waiter = {
				predicate,
				resolve: resolvePromise,
				timer: setTimeout(() => {
					this.waiters.delete(waiter);
					reject(new Error(`${this.label}: timed out after ${timeoutMs}ms`));
				}, timeoutMs),
			};
			this.waiters.add(waiter);
		});
	}

	async send(payload: Record<string, unknown>): Promise<void> {
		this.child.stdin.write(`${JSON.stringify(payload)}\n`);
		await this.child.stdin.flush();
	}

	async command(type: string, fields: Record<string, unknown> = {}): Promise<RpcRecord> {
		const id = `${this.label}-${++this.sequence}`;
		const response = this.waitFor((record) => record.type === "response" && record.id === id);
		await this.send({ id, type, ...fields });
		const result = await response;
		if (result.success !== true) throw new Error(`${type} failed: ${JSON.stringify(result)}`);
		return result;
	}

	kill(): void {
		this.child.kill();
	}
}

function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	return (message?.content ?? [])
		.map((part: any) => (typeof part?.text === "string" ? part.text : ""))
		.join("");
}

const asker = new PiProcess("asker");
const captain = new PiProcess("captain");

try {
	const askerState = await asker.command("get_state");
	await captain.command("get_state");

	// 1. QUEUE: the asking agent calls ask_captain through the LLM.
	const toolDone = asker.waitFor(
		(record) => record.type === "tool_execution_end" && record.toolName === "ask_captain",
	);
	await asker.command("prompt", {
		message:
			"Call the ask_captain tool exactly once with question " +
			'"Ship the questions extension behind a flag?", options ["flag", "unguarded"], ' +
			'recommendation "flag", urgency "high". Then stop.',
	});
	await toolDone;
	await asker.waitFor((record) => record.type === "agent_settled");

	const queued = readQuestions(queuePath);
	if (queued.length !== 1 || queued[0]?.status !== "open") {
		throw new Error(`Expected one open queued question, got ${JSON.stringify(queued)}`);
	}
	const questionId = queued[0]!.id;

	// 2. LIST: a different pi process sees it via /questions.
	const listed = captain.waitFor(
		(record) => record.type === "extension_ui_request" && record.method === "select",
	);
	// Deliberately not `command()`: pi emits the prompt response only after the
	// extension command handler RETURNS, and /questions blocks on this very
	// dialog. Awaiting the response first would deadlock the smoke.
	await captain.send({ id: "captain-questions", type: "prompt", message: "/questions" });
	const dialog = await listed;
	const title = String(dialog.title ?? "");
	if (!title.includes("Ship the questions extension behind a flag?")) {
		throw new Error(`Captain dialog did not show the question: ${JSON.stringify(dialog)}`);
	}
	if (!title.includes(askerState.data?.sessionId ?? "\u0000")) {
		throw new Error(`Captain dialog did not attribute the asking session: ${title}`);
	}
	if (!(dialog.options ?? []).includes("flag")) {
		throw new Error(`Captain dialog lost the agent's options: ${JSON.stringify(dialog.options)}`);
	}

	// 3. ANSWER: the captain picks one of the agent's options.
	const captainDone = captain.waitFor(
		(record) =>
			record.type === "extension_ui_request" &&
			record.method === "notify" &&
			String(record.message ?? "").includes("Resolved"),
	);
	await captain.send({ type: "extension_ui_response", id: dialog.id, value: "flag" });
	const summary = await captainDone;
	const answered = readQuestions(queuePath);
	if (answered[0]?.status !== "answered" || answered[0]?.answer !== "flag") {
		throw new Error(`Answer was not recorded: ${JSON.stringify(answered)}`);
	}

	// 4. ASKER READS THE ANSWER: no prompt from us. The extension's own poll
	//    must wake the parked asking session (poll interval is 15s).
	const delivered = await asker.waitFor(
		(record) =>
			(record.type === "message_start" || record.type === "message_end") &&
			messageText(record.message).includes("Captain answered your queued question"),
		90_000,
	);
	const deliveredText = messageText(delivered.message);
	if (!deliveredText.includes("A: flag") || !deliveredText.includes(questionId)) {
		throw new Error(`Delivered answer was not the captain's: ${deliveredText}`);
	}
	const finalState = readQuestions(queuePath);
	if (finalState[0]?.delivered !== true) {
		throw new Error(`Delivery was not recorded durably: ${JSON.stringify(finalState)}`);
	}

	const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	const evidence = {
		runAt: new Date().toISOString(),
		piVersion,
		model: "deck/claude-haiku-4-5",
		extensionPath,
		queueFile: basename(queuePath),
		askerSessionId: askerState.data?.sessionId,
		queued: queued[0],
		captainDialog: { title, options: dialog.options },
		captainSummary: summary.message,
		deliveredToAsker: deliveredText,
		finalRecord: finalState[0],
	};
	const evidencePath = join(evidenceDir, `questions-${timestamp}.json`);
	writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

	console.log("questions smoke PASSED");
	console.log(`  queued by      ${evidence.askerSessionId}`);
	console.log(`  captain saw    ${title.split("\n").slice(-1)[0]}`);
	console.log(`  answered       flag`);
	console.log(`  asker received ${deliveredText.split("\n").at(-1)}`);
	console.log(`  evidence       ${evidencePath}`);
} finally {
	asker.kill();
	captain.kill();
}
