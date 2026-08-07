import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// A single null element in an assistant message's `content` array used to throw
// in AssistantMessageComponent, and because the transcript replays on resume it
// crashed the session on every reopen rather than once. The guard ships inside
// the reviewed artifact, so the thing worth defending is that an install still
// carries it - a plain reinstall of the pristine tarball would silently undo it.

const RUNTIME = path.join(
	process.env.HOME ?? "",
	".deck/.prime/runtime/lib/node_modules/prime-agent",
);
const installed = fs.existsSync(path.join(RUNTIME, "package.json"));

describe.if(installed)("installed Prime runtime", () => {
	test("carries the null-content guard in the renderer", () => {
		const bundle = path.join(RUNTIME, "dist/bundle");
		const guarded = fs
			.readdirSync(bundle)
			.filter((f) => f.endsWith(".js"))
			.some((f) => fs.readFileSync(path.join(bundle, f), "utf8").includes("content == null"));
		expect(guarded).toBe(true);
	});

	test("matches the manifest fingerprint", () => {
		const result = spawnSync(
			path.join(import.meta.dir, "prime-patches.sh"),
			["verify"],
			{
				encoding: "utf8",
				env: { ...process.env, PRIME_AGENT_ROOT: RUNTIME },
			},
		);
		expect(result.stdout + result.stderr).toContain("patched install verified");
		expect(result.status).toBe(0);
	});
});
