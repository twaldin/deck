import { describe, expect, test } from "bun:test";

import { PiAgent } from "smithers-orchestrator";
import { createHostPiAgent, resolveHostPiBinary } from "../lib/host-pi.ts";

describe("pipeline Pi binary", () => {
	test("prefers the explicit host binary configured by the gateway", () => {
		expect(resolveHostPiBinary({ DECK_PI_BINARY: "/opt/deck/bin/pi" })).toBe("/opt/deck/bin/pi");
		expect(() => resolveHostPiBinary({ DECK_PI_BINARY: "pi" })).toThrow(/absolute path/);
	});

	test("uses the configured host binary instead of Smithers' bundled pi", async () => {
		const hostBinary = "/opt/deck/bin/pi";
		const agent = createHostPiAgent(
			PiAgent,
			{ provider: "deck", model: "claude-sonnet-5", noSession: true },
			hostBinary,
		);

		const command = await agent.buildCommand({ prompt: "resolve deck/gpt-5.6-luna", cwd: process.cwd() });
		expect(command.command).toBe(hostBinary);
		expect(command.args).toContain("--provider");
		expect(command.args).toContain("deck");
	});

	test("keeps Deck extensions on the host command", async () => {
		const agent = createHostPiAgent(
			PiAgent,
			{ provider: "deck", model: "gpt-5.6-luna", extension: ["/opt/deck/example-extension.ts"], noSession: true },
			"/opt/deck/bin/pi",
		);
		const command = await agent.buildCommand({ prompt: "use deck/gpt-5.6-luna", cwd: process.cwd() });
		expect(command.command).toBe("/opt/deck/bin/pi");
		expect(command.args).toEqual(expect.arrayContaining(["--extension", "/opt/deck/example-extension.ts"]));
	});
});
