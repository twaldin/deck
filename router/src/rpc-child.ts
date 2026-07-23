import * as fs from "node:fs";
import { z } from "zod";
import { killProcessGroup, spawnProcessGroup, type ProcessGroup, type SpawnGroupOptions } from "./process-group";

const rpcResponseSchema = z.object({
	type: z.literal("response"),
	id: z.string().optional(),
	command: z.string(),
	success: z.boolean(),
	error: z.string().optional(),
	data: z.unknown().optional(),
}).loose();
const rpcEventSchema = z.object({ type: z.string().min(1) }).loose();
const stateDataSchema = z.object({
	isStreaming: z.boolean(),
	sessionFile: z.string().min(1),
	sessionId: z.string().min(1),
}).loose();

export interface RpcState extends z.infer<typeof stateDataSchema> {}

interface PendingResponse {
	command: string;
	resolve: (response: z.infer<typeof rpcResponseSchema>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface RpcChildOptions extends SpawnGroupOptions {
	maxLineBytes?: number;
	onEvent?: (event: z.infer<typeof rpcEventSchema>) => void;
}

/** Direct-parent pi RPC transport with strict LF-only JSONL framing. */
export class RpcChild {
	readonly group: ProcessGroup;
	readonly pid: number;
	readonly pgid: number;
	lastEventAt: number;
	private readonly pending = new Map<string, PendingResponse>();
	private readonly onEvent: (event: z.infer<typeof rpcEventSchema>) => void;
	private readonly maxLineBytes: number;
	private stdoutBuffer = Buffer.alloc(0);
	private sequence = 0;
	private closed = false;
	private stderrTail = "";

	constructor(command: string, args: string[], options: RpcChildOptions = {}) {
		this.group = spawnProcessGroup(command, args, options);
		this.pid = this.group.pid;
		this.pgid = this.group.pgid;
		this.lastEventAt = 0;
		this.onEvent = options.onEvent ?? (() => undefined);
		this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
		this.group.child.stdout.on("data", (chunk: Buffer) => {
			this.consumeStdout(chunk);
		});
		this.group.child.stderr.on("data", (chunk: Buffer) => {
			this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-8_192);
		});
		void this.group.exited.then(({ code, signal }) => {
			this.closed = true;
			const suffix = this.stderrTail.length === 0 ? "" : `: ${this.stderrTail}`;
			this.rejectPending(new Error(`pi RPC exited ${code ?? signal ?? "unknown"}${suffix}`));
		});
		this.group.child.once("error", (error) => {
			this.closed = true;
			this.rejectPending(error);
		});
	}

	async getState(timeoutMs = 2_000): Promise<RpcState> {
		const response = await this.request("get_state", {}, timeoutMs);
		return stateDataSchema.parse(response.data);
	}

	async inject(message: string, timeoutMs = 5_000): Promise<void> {
		const state = await this.getState(timeoutMs);
		if (state.isStreaming) {
			await this.request("steer", { message }, timeoutMs);
			return;
		}
		await this.request("prompt", { message }, timeoutMs);
	}

	async request(
		command: string,
		fields: Record<string, unknown> = {},
		timeoutMs = 5_000,
	): Promise<z.infer<typeof rpcResponseSchema>> {
		if (this.closed) {
			throw new Error("pi RPC child is closed");
		}
		this.sequence += 1;
		const id = `router-${this.pid}-${this.sequence}`;
		const { promise, resolve, reject } = Promise.withResolvers<z.infer<typeof rpcResponseSchema>>();
		const timer = setTimeout(() => {
			this.pending.delete(id);
			reject(new Error(`${command} RPC timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref();
		this.pending.set(id, { command, resolve, reject, timer });
		const line = JSON.stringify({ id, type: command, ...fields });
		this.group.child.stdin.write(`${line}\n`, (error) => {
			if (error !== null && error !== undefined) {
				const pending = this.pending.get(id);
				if (pending !== undefined) {
					clearTimeout(pending.timer);
					this.pending.delete(id);
					pending.reject(error);
				}
			}
		});
		return promise;
	}

	async waitForHeartbeat(sessionFile: string, deadlineAt: number): Promise<number> {
		while (Date.now() < deadlineAt) {
			if (fs.existsSync(sessionFile)) {
				const stat = fs.statSync(sessionFile);
				return stat.mtimeMs;
			}
			const { promise, resolve } = Promise.withResolvers<boolean>();
			setTimeout(() => resolve(false), Math.min(25, Math.max(1, deadlineAt - Date.now())));
			const exited = await Promise.race([
				this.group.exited.then(() => true),
				promise,
			]);
			if (exited) {
				throw new Error("pi exited before first heartbeat");
			}
		}
		throw new Error("pi session file did not materialize before spawn deadline");
	}

	async terminate(graceMs = 5_000): Promise<void> {
		this.closed = true;
		this.group.child.stdin.end();
		await killProcessGroup(this.pgid, this.group.exited, graceMs);
	}

	private consumeStdout(chunk: Buffer): void {
		this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
		if (this.stdoutBuffer.byteLength > this.maxLineBytes && this.stdoutBuffer.indexOf(0x0a) < 0) {
			this.closed = true;
			this.rejectPending(new Error(`pi RPC line exceeded ${this.maxLineBytes} bytes`));
			void this.terminate();
			return;
		}
		let newline = this.stdoutBuffer.indexOf(0x0a);
		while (newline >= 0) {
			const raw = this.stdoutBuffer.subarray(0, newline);
			if (raw.byteLength > this.maxLineBytes) {
				this.closed = true;
				this.rejectPending(new Error(`pi RPC line exceeded ${this.maxLineBytes} bytes`));
				void this.terminate();
				return;
			}
			this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
			if (raw.byteLength > 0) {
				this.consumeLine(raw.toString("utf8"));
			}
			newline = this.stdoutBuffer.indexOf(0x0a);
		}
	}

	private consumeLine(line: string): void {
		let decoded: unknown;
		try {
			decoded = JSON.parse(line);
		} catch (error) {
			this.rejectPending(new Error(`invalid pi RPC JSON: ${error instanceof Error ? error.message : String(error)}`));
			return;
		}
		const event = rpcEventSchema.parse(decoded);
		if (event.type !== "response") {
			this.lastEventAt = Date.now();
			this.onEvent(event);
			return;
		}
		const response = rpcResponseSchema.parse(event);
		if (response.id === undefined) {
			return;
		}
		const pending = this.pending.get(response.id);
		if (pending === undefined) {
			return;
		}
		clearTimeout(pending.timer);
		this.pending.delete(response.id);
		if (pending.command !== response.command) {
			pending.reject(new Error(`pi RPC command mismatch: expected ${pending.command}, got ${response.command}`));
			return;
		}
		if (!response.success) {
			pending.reject(new Error(response.error ?? `${response.command} failed`));
			return;
		}
		pending.resolve(response);
	}

	private rejectPending(error: Error): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(id);
		}
	}
}

