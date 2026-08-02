/**
 * The interactive login flow multiplexes server-initiated events and client
 * replies on ONE connection. The write queue must not reorder or drop those
 * events, and a big status reply queued behind them must not strand the prompt.
 */
import "./tmp-home"; // MUST be first: fixes DECK_HOME before paths.ts resolves it
import { afterEach, describe, expect, test } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { startControlSocket } from "../src/control";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
});

describe("control login prompt flow", () => {
	test("prompt events reach the client in order and the reply resolves the login", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "deck-control-login-"));
		const sock = path.join(directory, "broker.sock");
		const seen: Array<Record<string, unknown>> = [];
		// A big blob forces the queue past one 8KB socket write mid-login.
		const bulk = "x".repeat(20_000);
		let authDead = true;
		const storage = {
			exportSnapshot: () => ({ generation: 1, generatedAt: Date.now(), credentials: [] }),
			fetchUsageReports: async () => [],
			listDisabledCredentials: async () => authDead ? [{ id: 9, provider: "anthropic", type: "oauth", email: "new@deck.invalid", cause: "oauth refresh failed: invalid_grant" }] : [],
			async login(_provider: string, callbacks: any) {
				callbacks.onAuth({ url: `https://example.invalid/${bulk}` });
				callbacks.onProgress("waiting for the browser");
				const code = await callbacks.onManualCodeInput();
				callbacks.onProgress(`got code ${code}`);
				authDead = false;
				return { email: "new@deck.invalid" };
			},
		} as unknown as AuthStorage;
		const control = startControlSocket(sock, {
			storage,
			listBlocks: () => [],
			invalidateUsageCache: async () => {},
			capability: "cap",
			gatewayUrl: "u",
			version: "t",
			startedAt: Date.now(),
		});
		cleanup.push(() => {
			control.close();
			rmSync(directory, { recursive: true, force: true });
		});

		const done = await new Promise<Record<string, unknown>>((resolve, reject) => {
			let buffer = "";
			const timer = setTimeout(() => reject(new Error(`stalled after ${buffer.length} bytes, ${seen.length} events`)), 10_000);
			void Bun.connect({
				unix: sock,
				socket: {
					open(socket) { socket.write(`${JSON.stringify({ id: "L", cap: "cap", op: "login", provider: "anthropic" })}\n`); },
					data(socket, chunk) {
						buffer += chunk.toString("utf8");
						for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
							const message = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
							buffer = buffer.slice(nl + 1);
							seen.push(message);
							if (message.event === "code") socket.write(`${JSON.stringify({ id: message.id, reply: "pasted-code" })}\n`);
							if (message.ok === true) { clearTimeout(timer); socket.end(); resolve(message); }
						}
					},
					error(_s, error) { clearTimeout(timer); reject(error); },
				},
			}).catch(reject);
		});

		expect(seen.map(event => event.event ?? "result")).toEqual(["auth", "progress", "code", "progress", "result"]);
		expect((seen[0]!.url as string).length).toBeGreaterThan(20_000);
		expect(seen[3]).toMatchObject({ message: "got code pasted-code" });
		expect(done).toMatchObject({ ok: true });
		expect((done.data as any).identity).toMatchObject({ email: "new@deck.invalid" });
		expect((done.data as any).dead).toEqual([]);
	}, 30_000);
});
