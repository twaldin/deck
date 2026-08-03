/**
 * Broker control surface: unix socket at run/broker.sock (SPEC §6.1).
 *
 * Capability-authenticated (SPEC §6.1/§13 — same-UID alone doesn't grant):
 * every request must carry the capability from broker/control.token (0600).
 * NDJSON protocol, one JSON object per line:
 *   client → { id, cap, op, ...args }
 *   server → { id, ok: true, data } | { id, ok: false, error }
 * Interactive login uses server-initiated events on the same connection:
 *   server → { id, event: "auth" | "progress" | "prompt" | "code", ... }
 *   client → { id, reply: string }        (answers prompt/code events)
 *
 * Raw tokens NEVER cross this socket (SPEC §6.1): status/list responses carry
 * identity metadata only.
 */
import * as fs from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { AuthStorage, StoredCredentialBlock } from "@oh-my-pi/pi-ai";
import { getProviderCatalog } from "./models";
import { refreshUsageRoster } from "./usage";

interface ControlDeps {
	storage: AuthStorage;
	/** Non-expired usage-limit blocks for the given credential rows (store-backed). */
	listBlocks: (credentialIds: readonly number[]) => StoredCredentialBlock[];
	/** Drop cached usage reports so the next probe hits upstream (battery §6.5.1). */
	invalidateUsageCache: () => Promise<void>;
	capability: string;
	gatewayUrl: string;
	version: string;
	startedAt: number;
}

interface ControlRequest {
	id?: unknown;
	cap?: unknown;
	op?: unknown;
	provider?: unknown;
	credentialId?: unknown;
	force?: unknown;
	reply?: unknown;
}

type PendingReply = { resolve: (value: string) => void; reject: (err: Error) => void };

/** `out` holds bytes the kernel would not take yet; see {@link flush}. */
type ControlSocketData = {
	buffer: string;
	pending: Map<string, PendingReply>;
	loginActive: boolean;
	out: Uint8Array | null;
};

function capMatches(expected: string, supplied: unknown): boolean {
	if (typeof supplied !== "string" || supplied.length === 0) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(supplied);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** Identity-only projection of stored credentials — no token bytes. */
function describeAccounts(storage: AuthStorage, listBlocks: ControlDeps["listBlocks"]) {
	const snapshot = storage.exportSnapshot();
	const blocks = listBlocks(snapshot.credentials.map(entry => entry.id));
	return snapshot.credentials.map(entry => {
		const cred = entry.credential;
		return {
			id: entry.id,
			provider: entry.provider,
			type: cred.type,
			email: cred.type === "oauth" ? (cred.email ?? null) : null,
			accountId: cred.type === "oauth" ? (cred.accountId ?? null) : null,
			orgName: cred.type === "oauth" ? (cred.orgName ?? null) : null,
			expires: cred.type === "oauth" ? cred.expires : null,
			// Cooling state (SPEC §6.3): non-expired usage-limit blocks on this row.
			blocks: blocks
				.filter(block => block.credentialId === entry.id)
				.map(block => ({ providerKey: block.providerKey, blockScope: block.blockScope, blockedUntilMs: block.blockedUntilMs })),
		};
	});
}

export function startControlSocket(sockPath: string, deps: ControlDeps): { close(): void } {
	try {
		fs.unlinkSync(sockPath);
	} catch {
		// not present — fine
	}

	const server = Bun.listen<ControlSocketData>({
		unix: sockPath,
		socket: {
			open(socket) {
				socket.data = { buffer: "", pending: new Map(), loginActive: false, out: null };
			},
			drain(socket) {
				flush(socket);
			},
			data(socket, chunk) {
				socket.data.buffer += chunk.toString("utf8");
				let newline = socket.data.buffer.indexOf("\n");
				while (newline !== -1) {
					const line = socket.data.buffer.slice(0, newline).trim();
					socket.data.buffer = socket.data.buffer.slice(newline + 1);
					newline = socket.data.buffer.indexOf("\n");
					if (line.length === 0) continue;
					let request: ControlRequest;
					try {
						request = JSON.parse(line) as ControlRequest;
					} catch {
						send(socket, { ok: false, error: "malformed JSON line" });
						continue;
					}
					void handleRequest(socket, request);
				}
			},
			close(socket) {
				for (const pending of socket.data.pending.values()) {
					pending.reject(new Error("control connection closed"));
				}
				socket.data.pending.clear();
			},
			error() {
				// per-connection errors are non-fatal to the daemon
			},
		},
	});
	fs.chmodSync(sockPath, 0o600);

	type ControlSocket = Bun.Socket<ControlSocketData>;

	/**
	 * Drain queued bytes, keeping whatever the socket would not take.
	 *
	 * `socket.write` returns the number of bytes ACCEPTED, which is capped by the
	 * send buffer (8KB here). A `status` response carries the whole provider
	 * catalog and is far larger, so ignoring that count truncated the reply
	 * mid-JSON: the client waited for a newline that never arrived and every
	 * caller fell back to its timeout — which is why the TUI showed no accounts.
	 */
	function flush(socket: ControlSocket): void {
		const queued = socket.data.out;
		if (queued === null) return;
		let written: number;
		try {
			written = socket.write(queued);
		} catch {
			socket.data.out = null; // peer is gone; nothing to keep
			return;
		}
		if (written < 0) {
			socket.data.out = null;
			return;
		}
		socket.data.out = written >= queued.length ? null : queued.subarray(written);
	}

	function send(socket: ControlSocket, payload: Record<string, unknown>): void {
		const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
		const queued = socket.data.out;
		socket.data.out = queued === null ? bytes : Buffer.concat([queued, bytes]);
		flush(socket);
	}

	/** Ask the connected client for input (login prompt / pasted code). */
	function askClient(socket: ControlSocket, id: string, event: Record<string, unknown>): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			socket.data.pending.set(id, { resolve, reject });
			send(socket, { id, ...event });
		});
	}

	async function handleRequest(socket: ControlSocket, request: ControlRequest): Promise<void> {
		const id = typeof request.id === "string" ? request.id : String(request.id ?? "");

		// Reply to an in-flight server-initiated question — routed before auth
		// because the capability was already checked on the originating op.
		if (typeof request.reply === "string" && socket.data.pending.has(id)) {
			const pending = socket.data.pending.get(id);
			socket.data.pending.delete(id);
			pending?.resolve(request.reply);
			return;
		}

		if (!capMatches(deps.capability, request.cap)) {
			send(socket, { id, ok: false, error: "E_CAP: missing or invalid capability" });
			return;
		}

		const op = typeof request.op === "string" ? request.op : "";
		try {
			switch (op) {
				case "status": {
					const accounts = describeAccounts(deps.storage, deps.listBlocks);
					const usage = await refreshUsageRoster(deps.storage, undefined, { allowCachedProbeFailure: false }).catch(error => {
						console.error("broker status usage refresh failed:", error instanceof Error ? error.message : error);
						return undefined;
					});
					send(socket, {
						id,
						ok: true,
						data: {
							version: deps.version,
							pid: process.pid,
							uptimeMs: Date.now() - deps.startedAt,
							gateway: deps.gatewayUrl,
							accounts,
							// Accounts whose OAuth grant is definitively gone. Only a captain
							// re-login fixes these, so they are first-class status, not a
							// footnote inside the usage payload.
							dead: usage?.dead ?? null,
							providers: getProviderCatalog(new Set(accounts.map(account => account.provider))),
							usage: usage ?? null,
						},
					});
					return;
				}
				case "usage": {
					if (request.force === true) await deps.invalidateUsageCache();
					const roster = await refreshUsageRoster(deps.storage);
					send(socket, { id, ok: true, data: roster });
					return;
				}
				case "login": {
					const provider = typeof request.provider === "string" ? request.provider : "";
					if (provider.length === 0) {
						send(socket, { id, ok: false, error: "E_ARG: login requires provider" });
						return;
					}
					if (socket.data.loginActive) {
						send(socket, { id, ok: false, error: "E_BUSY: login already in progress on this connection" });
						return;
					}
					socket.data.loginActive = true;
					try {
						let promptSeq = 0;
						const identity = await deps.storage.login(provider, {
							onAuth(info) {
								send(socket, { id, event: "auth", url: info.url, launchUrl: info.launchUrl ?? null, instructions: info.instructions ?? null });
							},
							onProgress(message) {
								send(socket, { id, event: "progress", message });
							},
							onPrompt: prompt => askClient(socket, `${id}#p${++promptSeq}`, { event: "prompt", message: prompt.message, placeholder: prompt.placeholder ?? null }),
							onManualCodeInput: () => askClient(socket, `${id}#c${++promptSeq}`, { event: "code" }),
						});
						// A successful login replaces the dead grant, and pi-ai purges the
						// superseded tombstone on upsert. Rewrite the roster now so every
						// reader (TUI, statusline, question sync) stops warning at once
						// instead of on the next 5-minute sweep.
						const roster = await refreshUsageRoster(deps.storage).catch(error => {
							console.error("broker login roster refresh failed:", error instanceof Error ? error.message : error);
							return undefined;
						});
						send(socket, { id, ok: true, data: { identity: identity ?? null, accounts: describeAccounts(deps.storage, deps.listBlocks), dead: roster?.dead ?? null } });
					} finally {
						socket.data.loginActive = false;
					}
					return;
				}
				case "logout": {
					const provider = typeof request.provider === "string" ? request.provider : "";
					if (provider.length === 0) {
						send(socket, { id, ok: false, error: "E_ARG: logout requires provider" });
						return;
					}
					await deps.storage.remove(provider);
					const roster = await refreshUsageRoster(deps.storage).catch(error => {
						console.error("broker logout roster refresh failed:", error instanceof Error ? error.message : error);
						return undefined;
					});
					send(socket, { id, ok: true, data: { accounts: describeAccounts(deps.storage, deps.listBlocks), dead: roster?.dead ?? null } });
					return;
				}
				case "refresh": {
					const credentialId = typeof request.credentialId === "number" ? request.credentialId : Number.NaN;
					if (!Number.isInteger(credentialId)) {
						send(socket, { id, ok: false, error: "E_ARG: refresh requires numeric credentialId" });
						return;
					}
					const entry = await deps.storage.refreshCredentialById(credentialId);
					send(socket, {
						id,
						ok: true,
						data: { id: entry.id, provider: entry.provider, expires: entry.credential.type === "oauth" ? entry.credential.expires : null },
					});
					return;
				}
				default: {
					send(socket, { id, ok: false, error: `E_OP: unknown op ${JSON.stringify(op)}` });
					return;
				}
			}
		} catch (error) {
			send(socket, { id, ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	return {
		close() {
			server.stop(true);
			try {
				fs.unlinkSync(sockPath);
			} catch {
				// already gone
			}
		},
	};
}
