/**
 * The control surface must SHOW an auth-dead account. Its identity leaves the
 * broker; its tokens never do.
 */
import "./tmp-home"; // MUST be first: fixes DECK_HOME before paths.ts resolves it
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { startControlSocket } from "../src/control";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
});

async function controlRequest(sock: string, cap: string, op: string): Promise<any> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		void Bun.connect({
			unix: sock,
			socket: {
				open(socket) { socket.write(`${JSON.stringify({ id: "t", cap, op })}\n`); },
				data(socket, chunk) {
					buffer += chunk.toString("utf8");
					const newline = buffer.indexOf("\n");
					if (newline === -1) return;
					socket.end();
					const line = JSON.parse(buffer.slice(0, newline));
					line.ok ? resolve(line.data) : reject(new Error(line.error));
				},
				error: (_s, error) => reject(error),
			},
		}).catch(reject);
	});
}

/** Read one NDJSON line, failing loudly instead of hanging on a truncated reply. */
async function controlLine(sock: string, cap: string, op: string, timeoutMs = 5_000): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const timer = setTimeout(() => reject(new Error(`no complete line after ${buffer.length} bytes`)), timeoutMs);
		void Bun.connect({
			unix: sock,
			socket: {
				open(socket) { socket.write(`${JSON.stringify({ id: "t", cap, op })}\n`); },
				data(socket, chunk) {
					buffer += chunk.toString("utf8");
					const newline = buffer.indexOf("\n");
					if (newline === -1) return;
					clearTimeout(timer);
					socket.end();
					resolve(buffer.slice(0, newline));
				},
				error: (_s, error) => { clearTimeout(timer); reject(error); },
			},
		}).catch(reject);
	});
}

describe("control surface auth-dead reporting", () => {
	test("status carries the dead account and never its tokens", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "deck-control-dead-"));
		const store = await SqliteAuthCredentialStore.open(path.join(directory, "store.db"));
		const storage = new AuthStorage(store);
		await storage.reload();
		const rows = store.upsertAuthCredentialForProvider("anthropic", {
			type: "oauth",
			refresh: "sk-ant-ort01-control-dead",
			access: "sk-ant-oat01-control-dead",
			expires: Date.now() - 60_000,
			email: "control-dead@deck.invalid",
		});
		const seeded = rows.find(row => row.credential.type === "oauth" && row.credential.email === "control-dead@deck.invalid")!;
		await storage.reload();
		await expect(storage.refreshCredentialById(seeded.id)).rejects.toThrow();

		const sock = path.join(directory, "broker.sock");
		const control = startControlSocket(sock, {
			storage,
			listBlocks: ids => store.listCredentialBlocks(ids),
			invalidateUsageCache: async () => {},
			capability: "cap-token",
			gatewayUrl: "http://127.0.0.1:0",
			version: "test",
			startedAt: Date.now(),
		});
		cleanup.push(() => {
			control.close();
			storage.close();
			rmSync(directory, { recursive: true, force: true });
		});

		const status = await controlRequest(sock, "cap-token", "status");
		expect(status.accounts).toEqual([]); // the dead row is out of the routable set
		expect(status.dead).toHaveLength(1);
		expect(status.dead[0]).toMatchObject({ id: seeded.id, provider: "anthropic", email: "control-dead@deck.invalid" });
		expect(JSON.stringify(status)).not.toContain("sk-ant-ort01");
		expect(JSON.stringify(status)).not.toContain("sk-ant-oat01");
	}, 40_000);

	test("status keeps accounts visible when usage refresh fails", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "deck-control-status-failure-"));
		const sock = path.join(directory, "broker.sock");
		const storage = {
			exportSnapshot: () => ({ generation: 1, generatedAt: Date.now(), credentials: [{ id: 1, provider: "anthropic", credential: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000, email: "live@deck.invalid" } }] }),
			fetchUsageReports: async () => { throw new Error("usage offline"); },
		} as unknown as AuthStorage;
		const control = startControlSocket(sock, { storage, listBlocks: () => [], invalidateUsageCache: async () => {}, capability: "cap-token", gatewayUrl: "u", version: "test", startedAt: Date.now() });
		cleanup.push(() => { control.close(); rmSync(directory, { recursive: true, force: true }); });
		const status = await controlRequest(sock, "cap-token", "status");
		expect(status.accounts).toEqual([expect.objectContaining({ id: 1, email: "live@deck.invalid" })]);
		expect(status.usage).toBeNull();
		expect(status.dead).toBeNull();
	});

	test("REGRESSION: a status reply larger than the socket buffer arrives whole", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "deck-control-big-"));
		const sock = path.join(directory, "broker.sock");
		// A stub storage keeps this deterministic and offline: the subject is the
		// socket write, not the provider probes.
		const credentials = Array.from({ length: 80 }, (_value, index) => ({
			id: index + 1,
			provider: "anthropic",
			credential: { type: "oauth" as const, access: "a", refresh: "r", expires: Date.now() + 3_600_000, email: `account-${index}@deck.invalid` },
		}));
		const storage = {
			exportSnapshot: () => ({ generation: 1, generatedAt: Date.now(), credentials }),
			fetchUsageReports: async () => [],
			listDisabledCredentials: async () => [],
		} as unknown as AuthStorage;
		const control = startControlSocket(sock, {
			storage,
			listBlocks: () => [],
			invalidateUsageCache: async () => {},
			capability: "cap-token",
			gatewayUrl: "http://127.0.0.1:0",
			version: "test",
			startedAt: Date.now(),
		});
		cleanup.push(() => {
			control.close();
			rmSync(directory, { recursive: true, force: true });
		});

		const line = await controlLine(sock, "cap-token", "status");
		// One socket write accepts at most 8KB here; a partial write used to
		// strand every reader on its own timeout with no error to show for it.
		expect(line.length).toBeGreaterThan(8192);
		const parsed = JSON.parse(line);
		expect(parsed.ok).toBe(true);
		expect(parsed.data.accounts).toHaveLength(80);
	}, 30_000);
});
