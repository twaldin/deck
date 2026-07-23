/**
 * deck-broker control client. Talks NDJSON over run/broker.sock with the
 * broker/control.token capability (SPEC §6.1).
 *
 *   bun src/cli.ts status
 *   bun src/cli.ts login <anthropic|openai-codex-device|zai>
 *   bun src/cli.ts logout <provider>
 *   bun src/cli.ts refresh <credentialId>
 *   bun src/cli.ts usage
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { BROKER_DIR, BROKER_SOCK } from "./paths";

const CONTROL_TOKEN_FILE = path.join(BROKER_DIR, "control.token");

interface ServerLine {
	id?: string;
	ok?: boolean;
	data?: unknown;
	error?: string;
	event?: string;
	url?: string;
	launchUrl?: string | null;
	instructions?: string | null;
	message?: string;
	placeholder?: string | null;
}

async function run(): Promise<void> {
	const [op, arg] = [process.argv[2] ?? "status", process.argv[3]];
	const cap = fs.readFileSync(CONTROL_TOKEN_FILE, "utf8").trim();
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

	const request: Record<string, unknown> = { id: "cli", cap, op };
	if (op === "login" || op === "logout") {
		if (!arg) {
			console.error(`${op} requires a provider argument`);
			process.exit(2);
		}
		request.provider = arg;
	}
	if (op === "refresh") {
		request.credentialId = Number(arg);
	}
	if (op === "usage" && arg === "--force") {
		request.force = true;
	}

	let buffer = "";
	let done = false;

	await new Promise<void>((resolve, reject) => {
		void Bun.connect({
			unix: BROKER_SOCK,
			socket: {
				open(socket) {
					socket.write(`${JSON.stringify(request)}\n`);
				},
				data(socket, chunk) {
					buffer += chunk.toString("utf8");
					let newline = buffer.indexOf("\n");
					while (newline !== -1) {
						const line = buffer.slice(0, newline).trim();
						buffer = buffer.slice(newline + 1);
						newline = buffer.indexOf("\n");
						if (line.length === 0) continue;
						void handleLine(socket, JSON.parse(line) as ServerLine);
					}
				},
				close() {
					if (!done) reject(new Error("connection closed before response"));
				},
				error(_socket, error) {
					reject(error);
				},
			},
		}).catch(reject);

		async function handleLine(socket: Bun.Socket, line: ServerLine): Promise<void> {
			if (line.event === "auth") {
				console.log(`\nOpen to authorize:\n  ${line.launchUrl ?? line.url}\n`);
				if (line.instructions) console.log(line.instructions);
				return;
			}
			if (line.event === "progress") {
				console.log(`… ${line.message}`);
				return;
			}
			if (line.event === "prompt" || line.event === "code") {
				const question = line.event === "code" ? "Paste the code: " : `${line.message ?? "Input"}: `;
				const answer = await rl.question(question);
				socket.write(`${JSON.stringify({ id: line.id, reply: answer.trim() })}\n`);
				return;
			}
			if (typeof line.ok === "boolean") {
				done = true;
				if (line.ok) {
					console.log(JSON.stringify(line.data, null, 2));
					resolve();
				} else {
					reject(new Error(line.error ?? "unknown broker error"));
				}
				socket.end();
			}
		}
	});

	rl.close();
}

run().catch(error => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
