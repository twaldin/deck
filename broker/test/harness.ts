/**
 * Conformance-battery harness (SPEC §6.5): exercises the LIVE deck-broker
 * through its two public surfaces only — the 127.0.0.1 gateway and the
 * capability-auth'd control socket. Burns a few tokens per run by design;
 * quota attribution is the thing under test.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { BROKER_DIR, BROKER_SOCK } from "../src/paths";

const meta = JSON.parse(fs.readFileSync(path.join(BROKER_DIR, "broker.meta.json"), "utf8")) as { gateway: string };

export const GATEWAY_URL: string = meta.gateway;
export const GATEWAY_TOKEN: string = fs.readFileSync(path.join(BROKER_DIR, "gateway.token"), "utf8").trim();
const CONTROL_CAP: string = fs.readFileSync(path.join(BROKER_DIR, "control.token"), "utf8").trim();

/** Cheap default for battery calls; thinking tests pick a reasoning model. */
export const CHEAP_MODEL = "claude-haiku-4-5";

export async function gatewayPost(pathname: string, body: unknown, init?: { signal?: AbortSignal }): Promise<Response> {
	return fetch(`${GATEWAY_URL}${pathname}`, {
		method: "POST",
		headers: { authorization: `Bearer ${GATEWAY_TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: init?.signal,
	});
}

export async function gatewayGet(pathname: string): Promise<Response> {
	return fetch(`${GATEWAY_URL}${pathname}`, { headers: { authorization: `Bearer ${GATEWAY_TOKEN}` } });
}

/** One-shot control request over the NDJSON unix socket. */
export async function controlRequest<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let buffer = "";
		void Bun.connect({
			unix: BROKER_SOCK,
			socket: {
				open(socket) {
					socket.write(`${JSON.stringify({ id: "battery", cap: CONTROL_CAP, op, ...args })}\n`);
				},
				data(socket, chunk) {
					buffer += chunk.toString("utf8");
					const newline = buffer.indexOf("\n");
					if (newline === -1) return;
					const line = JSON.parse(buffer.slice(0, newline)) as { ok?: boolean; data?: T; error?: string };
					socket.end();
					if (line.ok) resolve(line.data as T);
					else reject(new Error(line.error ?? "control error"));
				},
				error(_socket, error) {
					reject(error);
				},
			},
		}).catch(reject);
	});
}

/** Collect SSE events from a streaming response body. */
export async function readSse(response: Response): Promise<Array<{ event: string; data: unknown }>> {
	const text = await response.text();
	const events: Array<{ event: string; data: unknown }> = [];
	for (const block of text.split("\n\n")) {
		const eventLine = block.split("\n").find(line => line.startsWith("event: "));
		const dataLine = block.split("\n").find(line => line.startsWith("data: "));
		if (!dataLine) continue;
		const raw = dataLine.slice(6);
		if (raw === "[DONE]") continue;
		events.push({ event: eventLine?.slice(7) ?? "", data: JSON.parse(raw) });
	}
	return events;
}
