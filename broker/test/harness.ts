/**
 * Conformance-battery harness (SPEC §6.5): exercises the LIVE deck-broker
 * through its two public surfaces only — the 127.0.0.1 gateway and the
 * capability-auth'd control socket. Burns a few tokens per run by design;
 * quota attribution is the thing under test.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { BROKER_DIR, BROKER_SOCK } from "../src/paths";

/**
 * Live-broker credentials, read on demand.
 *
 * Reading these at import time made the battery unrunnable next to the unit
 * tests. `bun test` shares ONE process, `paths.ts` resolves DECK_HOME once at
 * first import, and `tmp-home.ts` repoints DECK_HOME as an import side effect,
 * so BROKER_DIR became a throwaway directory for every file in the run and the
 * battery died on a missing broker.meta.json before a single test executed.
 *
 * Resolving lazily lets the battery report the honest state instead: skipped
 * when no live broker is reachable, run when there is one.
 */
function readLive(): { gateway: string; gatewayToken: string; controlCap: string } | null {
	try {
		const meta = JSON.parse(fs.readFileSync(path.join(BROKER_DIR, "broker.meta.json"), "utf8")) as { gateway: string };
		return {
			gateway: meta.gateway,
			gatewayToken: fs.readFileSync(path.join(BROKER_DIR, "gateway.token"), "utf8").trim(),
			controlCap: fs.readFileSync(path.join(BROKER_DIR, "control.token"), "utf8").trim(),
		};
	} catch {
		return null;
	}
}

let cached: ReturnType<typeof readLive> | undefined;
function live(): NonNullable<ReturnType<typeof readLive>> {
	cached ??= readLive();
	if (cached === null) throw new Error(`no live broker under ${BROKER_DIR}: run the battery on its own against a running deck-broker`);
	return cached;
}

let warned = false;

/** True when a live broker is reachable, so the battery can skip instead of failing. */
export function hasLiveBroker(): boolean {
	cached ??= readLive();
	if (cached === null && !warned) {
		warned = true;
		// Say why, once. A battery that skips without a reason reads as a battery
		// that passed.
		console.warn(
			`[battery] SKIP: no live broker under ${BROKER_DIR}. Start deck-broker and run the conformance files on their own; in a shared \`bun test\` run DECK_HOME points at a throwaway home.`,
		);
	}
	return cached !== null;
}

/** Cheap default for battery calls; thinking tests pick a reasoning model. */
export const CHEAP_MODEL = "claude-haiku-4-5";

export async function gatewayPost(pathname: string, body: unknown, init?: { signal?: AbortSignal }): Promise<Response> {
	const { gateway, gatewayToken } = live();
	return fetch(`${gateway}${pathname}`, {
		method: "POST",
		headers: { authorization: `Bearer ${gatewayToken}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: init?.signal,
	});
}

export async function gatewayGet(pathname: string): Promise<Response> {
	const { gateway, gatewayToken } = live();
	return fetch(`${gateway}${pathname}`, { headers: { authorization: `Bearer ${gatewayToken}` } });
}

/** One-shot control request over the NDJSON unix socket. */
export async function controlRequest<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let buffer = "";
		void Bun.connect({
			unix: BROKER_SOCK,
			socket: {
				open(socket) {
					socket.write(`${JSON.stringify({ id: "battery", cap: live().controlCap, op, ...args })}\n`);
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
