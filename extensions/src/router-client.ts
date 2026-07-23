import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import * as path from "node:path";
import {
	DECK_HOME,
	DeckError,
	dispatchResultSchema,
	loadConfig,
	ROUTER_SOCK,
	routerRequestSchema,
	routerResponseSchema,
	type DispatchResult,
	type RouterResponse,
} from "@deck/core";
import { z } from "zod";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 2_000;
const RESPONSE_TIMEOUT_GRACE_MS = 5_000;

const capabilitySchema = z.string().trim().min(1);
const deckErrorCodeSchema = z.enum([
	"E_TOO_LONG",
	"E_CAS",
	"E_LEASE",
	"E_EVIDENCE",
	"E_ADMISSION",
	"E_CAP",
	"E_ARG",
	"E_STATE",
	"E_LIVENESS",
	"E_IO",
]);

export const ROUTER_CONTROL_TOKEN = path.join(DECK_HOME, "router", "control.token");

export interface RouterDispatchInput {
	effortId: string;
	leaseToken: string;
	kind: "workflow" | "subagent";
	target: string;
	brief: string;
}

export async function dispatchThroughRouter(
	input: RouterDispatchInput,
	signal: AbortSignal,
): Promise<DispatchResult> {
	const capability = readCapability();
	const request = routerRequestSchema.parse({
		op: "dispatch",
		id: crypto.randomUUID(),
		cap: capability,
		effort_id: input.effortId,
		kind: input.kind,
		target: input.target,
		brief: input.brief,
		lease_token: input.leaseToken,
	});
	let responseTimeoutMs: number;
	try {
		responseTimeoutMs = loadConfig().router.spawnDeadlineMs + RESPONSE_TIMEOUT_GRACE_MS;
	} catch (error) {
		throw new DeckError("E_IO", "cannot load router timeout configuration", {
			cause: error instanceof Error ? error.message : String(error),
		});
	}
	const response = await exchangeLine(`${JSON.stringify(request)}\n`, request.id, signal, responseTimeoutMs);
	if (!response.ok) {
		const code = deckErrorCodeSchema.safeParse(response.code);
		if (!code.success) {
			throw new DeckError("E_IO", "router returned an unknown error code", {
				router_request_id: request.id,
				code: response.code,
			});
		}
		throw new DeckError(code.data, response.error, { router_request_id: request.id });
	}
	const dispatched = dispatchResultSchema.safeParse(response.data);
	if (!dispatched.success) {
		throw new DeckError("E_IO", "router returned an invalid dispatch result", {
			router_request_id: request.id,
			issues: dispatched.error.issues,
		});
	}
	return dispatched.data;
}

function readCapability(): string {
	try {
		return capabilitySchema.parse(readFileSync(ROUTER_CONTROL_TOKEN, "utf8"));
	} catch (error) {
		if (error instanceof DeckError) {
			throw error;
		}
		throw new DeckError("E_CAP", "cannot read router control capability", {
			path: ROUTER_CONTROL_TOKEN,
			cause: error instanceof Error ? error.message : String(error),
		});
	}
}

function exchangeLine(
	payload: string,
	requestId: string,
	signal: AbortSignal,
	responseTimeoutMs: number,
): Promise<RouterResponse> {
	const resolvers = Promise.withResolvers<RouterResponse>();
	let socket: Socket | null = null;
	let buffer = "";
	let settled = false;
	let connectTimer: NodeJS.Timeout | undefined;
	let responseTimer: NodeJS.Timeout | undefined;

	const cleanup = (): void => {
		clearTimeout(connectTimer);
		clearTimeout(responseTimer);
		signal.removeEventListener("abort", onAbort);
		socket?.destroy();
	};

	const succeed = (response: RouterResponse): void => {
		if (settled) {
			return;
		}
		settled = true;
		cleanup();
		resolvers.resolve(response);
	};

	const fail = (error: Error): void => {
		if (settled) {
			return;
		}
		settled = true;
		cleanup();
		resolvers.reject(error);
	};

	const onAbort = (): void => {
		fail(new DeckError("E_IO", "router dispatch aborted"));
	};

	connectTimer = setTimeout(() => {
		fail(new DeckError("E_IO", "router connect timed out", { timeout_ms: CONNECT_TIMEOUT_MS }));
	}, CONNECT_TIMEOUT_MS);

	if (signal.aborted) {
		onAbort();
		return resolvers.promise;
	}
	signal.addEventListener("abort", onAbort, { once: true });

	try {
		socket = createConnection({ path: ROUTER_SOCK });
	} catch (error) {
		fail(toTransportError("cannot open router socket", error));
		return resolvers.promise;
	}

	socket.setEncoding("utf8");
	socket.once("connect", () => {
		clearTimeout(connectTimer);
		responseTimer = setTimeout(() => {
			fail(new DeckError("E_LIVENESS", "router dispatch response timed out", {
				timeout_ms: responseTimeoutMs,
			}));
		}, responseTimeoutMs);
		socket?.write(payload);
	});
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
			fail(new DeckError("E_IO", "router response exceeds size limit", { limit: MAX_RESPONSE_BYTES }));
			return;
		}
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (line.length === 0) {
				continue;
			}
			try {
				const decoded: unknown = JSON.parse(line);
				const response = routerResponseSchema.parse(decoded);
				if (response.id === requestId) {
					succeed(response);
					return;
				}
			} catch (error) {
				fail(toTransportError("invalid router response", error));
				return;
			}
		}
	});
	socket.once("error", (error) => {
		fail(toTransportError("router socket failed", error));
	});
	socket.once("end", () => {
		fail(new DeckError("E_IO", "router closed before responding", { request_id: requestId }));
	});
	return resolvers.promise;
}


function toTransportError(message: string, error: unknown): DeckError {
	return new DeckError("E_IO", message, {
		cause: error instanceof Error ? error.message : String(error),
	});
}
