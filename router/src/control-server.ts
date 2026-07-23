import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	DECK_HOME,
	DeckError,
	ROUTER_SOCK,
	ensureStateDirs,
	routerRequestSchema,
	routerResponseSchema,
	type DeckErrorCode,
	type RouterRequest,
	type RouterResponse,
} from "@deck/core";
import { z } from "zod";
import type { OwnerSupervisor } from "./supervisor";
import type { PollScheduler } from "./scheduler";

const capabilitySchema = z.string().min(32).regex(/^[A-Za-z0-9_-]+$/);

export interface ControlServerOptions {
	supervisor: OwnerSupervisor;
	scheduler: PollScheduler;
	maxLineBytes?: number;
}

export class RouterControlServer {
	readonly capabilityFile: string;
	private readonly supervisor: OwnerSupervisor;
	private readonly scheduler: PollScheduler;
	private readonly maxLineBytes: number;
	private readonly capability: string;
	private server: net.Server | null = null;

	constructor(options: ControlServerOptions) {
		this.supervisor = options.supervisor;
		this.scheduler = options.scheduler;
		this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
		this.capabilityFile = path.join(DECK_HOME, "router", "control.token");
		this.capability = loadOrCreateCapability(this.capabilityFile);
	}

	async start(): Promise<void> {
		if (this.server !== null) {
			return;
		}
		ensureStateDirs();
		try {
			fs.unlinkSync(ROUTER_SOCK);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
				throw error;
			}
		}
		const server = net.createServer((socket) => {
			this.accept(socket);
		});
		this.server = server;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		server.once("listening", resolve);
		server.once("error", reject);
		server.listen(ROUTER_SOCK);
		await promise;
		fs.chmodSync(ROUTER_SOCK, 0o600);
	}

	async close(): Promise<void> {
		const server = this.server;
		if (server === null) {
			return;
		}
		this.server = null;
		const { promise, resolve } = Promise.withResolvers<void>();
		server.close(() => resolve());
		await promise;
		try {
			fs.unlinkSync(ROUTER_SOCK);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
				throw error;
			}
		}
	}

	private accept(socket: net.Socket): void {
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
			if (buffer.byteLength > this.maxLineBytes && buffer.indexOf(0x0a) < 0) {
				socket.destroy(new Error("router request line too large"));
				return;
			}
			let newline = buffer.indexOf(0x0a);
			while (newline >= 0) {
				const raw = buffer.subarray(0, newline);
				if (raw.byteLength > this.maxLineBytes) {
					socket.destroy(new Error("router request line too large"));
					return;
				}
				buffer = buffer.subarray(newline + 1);
				if (raw.byteLength > 0) {
					void this.handleLine(socket, raw.toString("utf8"));
				}
				newline = buffer.indexOf(0x0a);
			}
		});
		socket.on("error", () => undefined);
	}

	private async handleLine(socket: net.Socket, line: string): Promise<void> {
		let request: RouterRequest;
		try {
			const decoded: unknown = JSON.parse(line);
			request = routerRequestSchema.parse(decoded);
		} catch (error) {
			this.writeResponse(socket, {
				ok: false,
				id: extractRequestId(line),
				code: "E_ARG",
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		if (!capabilitiesMatch(request.cap, this.capability)) {
			this.writeResponse(socket, { ok: false, id: request.id, code: "E_CAP", error: "invalid router capability" });
			return;
		}
		const abortController = new AbortController();
		const abort = (): void => {
			abortController.abort();
		};
		socket.once("close", abort);
		try {
			const response = await this.execute(request, abortController.signal);
			this.writeResponse(socket, { ok: true, id: request.id, data: response });
		} catch (error) {
			const code: DeckErrorCode = error instanceof DeckError ? error.code : "E_IO";
			const message = error instanceof Error ? error.message : String(error);
			const prefix = `${code}: `;
			this.writeResponse(socket, {
				ok: false,
				id: request.id,
				code,
				error: message.startsWith(prefix) ? message.slice(prefix.length) : message,
			});
		} finally {
			socket.removeListener("close", abort);
		}
	}

	private async execute(request: RouterRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
		switch (request.op) {
			case "status":
				return {
					targets: this.scheduler.status(),
					children: await this.supervisor.status(),
				};
			case "wake": {
				const result = await this.supervisor.wake(request.effort_id, request.reason);
				return { effort_id: request.effort_id, queued: result.queued };
			}
			case "dispatch":
				if (request.kind === "workflow") {
					throw new DeckError("E_STATE", "workflows land Phase 3");
				}
				return await this.supervisor.dispatch(
					request.effort_id,
					request.target,
					request.brief,
					request.lease_token,
					signal,
				);
			case "cancel":
				await this.supervisor.cancel(request.effort_id, request.dispatch_id);
				return { dispatch_id: request.dispatch_id, state: "cancelled" };
		}
	}

	private writeResponse(socket: net.Socket, response: RouterResponse): void {
		const parsed = routerResponseSchema.parse(response);
		socket.write(`${JSON.stringify(parsed)}\n`);
	}
}

function loadOrCreateCapability(file: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.chmodSync(path.dirname(file), 0o700);
	if (fs.existsSync(file)) {
		const capability = capabilitySchema.parse(fs.readFileSync(file, "utf8").trim());
		fs.chmodSync(file, 0o600);
		return capability;
	}
	const capability = randomBytes(32).toString("base64url");
	fs.writeFileSync(file, `${capability}\n`, { mode: 0o600, flag: "wx" });
	fs.chmodSync(file, 0o600);
	return capabilitySchema.parse(capability);
}

function capabilitiesMatch(candidate: string, expected: string): boolean {
	const candidateHash = createHash("sha256").update(candidate).digest();
	const expectedHash = createHash("sha256").update(expected).digest();
	return timingSafeEqual(candidateHash, expectedHash);
}

function extractRequestId(line: string): string {
	try {
		const decoded: unknown = JSON.parse(line);
		const parsed = z.object({ id: z.string() }).safeParse(decoded);
		return parsed.success ? parsed.data.id : "unknown";
	} catch {
		return "unknown";
	}
}
