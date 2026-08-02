import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-wake-producers-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("main failure coordination", () => {
	test("releases a recovered incident so a later failure can claim it", async () => {
		const { claimMainFailure, releaseMainFailure } = await import("../src/wake-producers");
		const fingerprint = "repo:main";
		expect(claimMainFailure(root, fingerprint, "ticket-1")).toBe(true);
		releaseMainFailure(root, fingerprint);
		expect(claimMainFailure(root, fingerprint, "ticket-2")).toBe(true);
	});

	test("an abandoned claim expires", async () => {
		const { claimMainFailure } = await import("../src/wake-producers");
		const fingerprint = "repo:main";
		expect(claimMainFailure(root, fingerprint, "ticket-1")).toBe(true);
		const file = path.join(root, "main-failure.json");
		const claim = JSON.parse(fs.readFileSync(file, "utf8"));
		claim.claimedAt = Date.now() - 31 * 60_000;
		fs.writeFileSync(file, JSON.stringify(claim));
		expect(claimMainFailure(root, fingerprint, "ticket-2")).toBe(true);
	});
});
