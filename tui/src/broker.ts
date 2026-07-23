import * as fs from "node:fs";
import * as path from "node:path";
import { BROKER_DIR, BROKER_SOCK } from "@deck/core";
import { z } from "zod";
import { brokerEnvelopeSchema, brokerStatusSchema, type BrokerStatus } from "./types";

const capabilitySchema = z.string().min(1);

export type BrokerStatusResult = { ok: true; status: BrokerStatus } | { ok: false; error: string };

interface BrokerPaths {
	brokerDir: string;
	brokerSocket: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Capability-authenticated read-only status call over the SPEC §6.1 NDJSON socket. */
export class BrokerStatusClient {
	private readonly paths: BrokerPaths;
	private cachedCapability: { statKey: string; value: string } | null = null;
	private requestSequence = 0;

	constructor(paths: Partial<BrokerPaths> = {}) {
		this.paths = {
			brokerDir: paths.brokerDir ?? BROKER_DIR,
			brokerSocket: paths.brokerSocket ?? BROKER_SOCK,
		};
	}

	private readCapability(): string {
		const file = path.join(this.paths.brokerDir, "control.token");
		const stat = fs.statSync(file);
		const statKey = `${stat.mtimeMs}:${stat.size}`;
		if (this.cachedCapability?.statKey === statKey) return this.cachedCapability.value;
		const value = capabilitySchema.parse(fs.readFileSync(file, "utf8").trim());
		this.cachedCapability = { statKey, value };
		return value;
	}

	async status(timeoutMs = 1_000): Promise<BrokerStatusResult> {
		let capability: string;
		try {
			capability = this.readCapability();
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
		const id = `tui-status-${++this.requestSequence}`;
		const request = { id, cap: capability, op: "status" };
		let buffer = "";
		let settled = false;
		let activeSocket: Bun.Socket | null = null;

		return new Promise<BrokerStatusResult>(resolve => {
			const timer = setTimeout(() => {
				finish({ ok: false, error: `broker status timed out after ${timeoutMs}ms` });
			}, timeoutMs);

			function finish(result: BrokerStatusResult): void {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				activeSocket?.end();
				resolve(result);
			}

			void Bun.connect({
				unix: this.paths.brokerSocket,
				socket: {
					open(socket) {
						activeSocket = socket;
						if (settled) {
							socket.end();
							return;
						}
						socket.write(`${JSON.stringify(request)}\n`);
					},
					data(_socket, chunk) {
						buffer += chunk.toString("utf8");
						let newline = buffer.indexOf("\n");
						while (newline !== -1) {
							const line = buffer.slice(0, newline).trim();
							buffer = buffer.slice(newline + 1);
							newline = buffer.indexOf("\n");
							if (line.length === 0) continue;
							try {
								const envelope = brokerEnvelopeSchema.parse(JSON.parse(line));
								if (envelope.id !== id) continue;
								if (!envelope.ok) {
									finish({ ok: false, error: envelope.error });
									return;
								}
								finish({ ok: true, status: brokerStatusSchema.parse(envelope.data) });
								return;
							} catch (error) {
								finish({ ok: false, error: `invalid broker response: ${errorMessage(error)}` });
								return;
							}
						}
					},
					close() {
						if (!settled) finish({ ok: false, error: "broker closed before status response" });
					},
					error(_socket, error) {
						finish({ ok: false, error: errorMessage(error) });
					},
				},
			}).catch(error => finish({ ok: false, error: errorMessage(error) }));
		});
	}
}
