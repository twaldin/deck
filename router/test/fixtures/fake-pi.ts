import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { openEffort } from "@deck/core";

const environmentSchema = z.object({
	FAKE_PI_HEARTBEAT_DELAY_MS: z.coerce.number().int().nonnegative().optional(),
	FAKE_PI_NEVER_HEARTBEAT: z.enum(["0", "1"]).optional(),
	FAKE_PI_PROMPT_LOG: z.string().min(1).optional(),
	FAKE_PI_PARK_AFTER_PROMPT: z.enum(["0", "1"]).optional(),
	DECK_ACTOR: z.string().min(1).optional(),
	DECK_EFFORT: z.string().min(1).optional(),
	DECK_LEASE_TOKEN: z.string().min(1).optional(),
}).loose();
const commandSchema = z.object({
	id: z.string().optional(),
	type: z.string().min(1),
	message: z.string().optional(),
}).loose();

const environment = environmentSchema.parse(process.env);
const args = Bun.argv.slice(2);
const sessionDirIndex = args.indexOf("--session-dir");
if (sessionDirIndex < 0 || args[sessionDirIndex + 1] === undefined) {
	throw new Error("fake pi requires --session-dir");
}
const sessionDir = z.string().min(1).parse(args[sessionDirIndex + 1]);
const resumeIndex = args.indexOf("--session");
const sessionId = resumeIndex >= 0 && args[resumeIndex + 1] !== undefined
	? z.string().min(1).parse(args[resumeIndex + 1])
	: randomUUID();
const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
fs.mkdirSync(sessionDir, { recursive: true });
let streaming = false;
let buffer = Buffer.alloc(0);
let parked = false;

process.stdin.on("data", (chunk: Buffer) => {
	buffer = Buffer.concat([buffer, chunk]);
	let newline = buffer.indexOf(0x0a);
	while (newline >= 0) {
		const line = buffer.subarray(0, newline).toString("utf8");
		buffer = buffer.subarray(newline + 1);
		if (line.length > 0) {
			const decoded: unknown = JSON.parse(line);
			handle(commandSchema.parse(decoded));
		}
		newline = buffer.indexOf(0x0a);
	}
});
process.stdin.resume();

function handle(command: z.infer<typeof commandSchema>): void {
	if (command.type === "get_state") {
		respond(command, {
			model: { provider: "deck", id: "fake" },
			thinkingLevel: "off",
			isStreaming: streaming,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionFile,
			sessionId,
			messageCount: 0,
			pendingMessageCount: 0,
		});
		return;
	}
	if (command.type === "prompt" || command.type === "steer" || command.type === "follow_up") {
		streaming = true;
		if (environment.FAKE_PI_PROMPT_LOG !== undefined) {
			fs.appendFileSync(environment.FAKE_PI_PROMPT_LOG, `${command.message ?? ""}\n---\n`);
		}
		respond(command);
		if (environment.FAKE_PI_NEVER_HEARTBEAT !== "1") {
			setTimeout(() => {
				fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
				process.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant" } })}\n`);
				process.stdout.write(`${JSON.stringify({ type: "turn_end" })}\n`);
				streaming = false;
				if (environment.FAKE_PI_PARK_AFTER_PROMPT === "1" && !parked) {
					parked = true;
					const effortId = z.string().min(1).parse(environment.DECK_EFFORT);
					const leaseToken = z.string().min(1).parse(environment.DECK_LEASE_TOKEN);
					const store = openEffort(effortId);
					const manifest = store.readManifest();
					store.mutate(manifest.revision, leaseToken, (current) => ({
						manifest: { ...current, digest: "Fake owner parked." },
						event: {
							plane: "lifecycle",
							type: "lifecycle.park",
							actor: environment.DECK_ACTOR ?? "owner",
							data: { digest: "Fake owner parked." },
						},
					}));
					process.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
				}
			}, environment.FAKE_PI_HEARTBEAT_DELAY_MS ?? 0);
		}
		return;
	}
	respond(command);
}

function respond(command: z.infer<typeof commandSchema>, data?: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({
		type: "response",
		id: command.id,
		command: command.type,
		success: true,
		...(data === undefined ? {} : { data }),
	})}\n`);
}
