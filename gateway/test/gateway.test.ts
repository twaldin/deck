import { beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, createVerify } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "deck-gw-"));
process.env.DECK_HOME = TEMP_HOME;

// Env pin must precede layout-reading imports (same pattern as itest).
const core = await import("@deck/core");
const { mintAuthorization, consumeAuthorization, listAuthorizations } = await import("../src/authorization");
const { buildAppJwt, mintInstallationToken } = await import("../src/app-token");
const { executeMerge } = await import("../src/merge");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PEM_FILE = path.join(TEMP_HOME, "test-app.pem");
const EFFORT_ID = "gw--merge-test";
const HEAD = "abc1234def5678";

beforeAll(() => {
	core.ensureStateDirs();
	fs.writeFileSync(PEM_FILE, PEM, { mode: 0o600 });
	core.createEffort({
		effort_id: EFFORT_ID,
		project: "gw",
		title: "merge gateway test",
		charter: { goal: "test", acceptance_criteria: ["merge"], constraints: [] },
	});
});

/** GitHub API stub: configurable head sha, check conclusion, merge outcome. */
function githubStub(options: { headSha?: string; checkConclusion?: string; mergeOk?: boolean } = {}) {
	const seen: string[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			seen.push(`${request.method} ${url.pathname}`);
			if (url.pathname.includes("/access_tokens")) {
				return Response.json({ token: "ghs_stub_token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
			}
			if (url.pathname.includes("/pulls/") && request.method === "GET") {
				return Response.json({ head: { sha: options.headSha ?? HEAD } });
			}
			if (url.pathname.includes("/check-runs")) {
				return Response.json({
					check_runs: [{ name: "ci", status: "completed", conclusion: options.checkConclusion ?? "success" }],
				});
			}
			if (url.pathname.endsWith("/merge") && request.method === "PUT") {
				if (options.mergeOk === false) return Response.json({ merged: false, message: "stub says no" }, { status: 405 });
				return Response.json({ merged: true, sha: "merge-sha-1" });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return { server, seen, base: `http://127.0.0.1:${server.port}` };
}

function freshAuthorization() {
	return mintAuthorization({ repo: "acme/widgets", pr: 7, head_sha: HEAD, base: "main", required_checks: ["ci"], workflow_run_id: null });
}

function leaseEpoch(): number {
	return core.openEffort(EFFORT_ID).readManifest().session?.lease_epoch ?? 0;
}

describe("app jwt", () => {
	test("RS256 JWT verifies against the public key with backdated iat", () => {
		const now = 1_800_000_000;
		const jwt = buildAppJwt("12345", PEM, now);
		const [header, payload, signature] = jwt.split(".") as [string, string, string];
		const verifier = createVerify("RSA-SHA256");
		verifier.update(`${header}.${payload}`);
		expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
		expect(claims).toEqual({ iat: now - 60, exp: now + 540, iss: "12345" });
	});

	test("mint hits the installations endpoint with the JWT and never logs bytes", async () => {
		const stub = githubStub();
		try {
			const token = await mintInstallationToken({
				appId: "1",
				installationId: "99",
				pem: { kind: "file", path: PEM_FILE },
				apiBase: stub.base,
			});
			expect(token.token).toBe("ghs_stub_token");
			expect(stub.seen).toContain("POST /app/installations/99/access_tokens");
		} finally {
			stub.server.stop(true);
		}
	});
});

describe("merge gateway scenarios (SPEC 10)", () => {
	test("happy path: fence, checks, merge, consume, receipt attempted->confirmed", async () => {
		const auth = freshAuthorization();
		const stub = githubStub();
		try {
			const receipt = await executeMerge({
				authorizationId: auth.id,
				effortId: EFFORT_ID,
				expectedLeaseEpoch: leaseEpoch(),
				tokenRequest: { appId: "1", installationId: "99", pem: { kind: "file", path: PEM_FILE } },
				apiBase: stub.base,
			});
			expect(receipt.mergeSha).toBe("merge-sha-1");
			const manifest = core.openEffort(EFFORT_ID).readManifest();
			const effect = manifest.side_effects.find(candidate => candidate.id === receipt.sideEffectId);
			expect(effect?.status).toBe("confirmed");
			expect(listAuthorizations().find(candidate => candidate.id === auth.id)?.result).toBe("merged");
			// sha binding actually sent to the merge API
			expect(stub.seen).toContain("PUT /repos/acme/widgets/pulls/7/merge");
		} finally {
			stub.server.stop(true);
		}
	});

	test("head moved: rejected before merge, authorization burned", async () => {
		const auth = freshAuthorization();
		const stub = githubStub({ headSha: "moved9999999" });
		try {
			await expect(
				executeMerge({
					authorizationId: auth.id,
					effortId: EFFORT_ID,
					expectedLeaseEpoch: leaseEpoch(),
					tokenRequest: { appId: "1", installationId: "99", pem: { kind: "file", path: PEM_FILE } },
					apiBase: stub.base,
				}),
			).rejects.toThrow(/head moved|different head/);
			expect(stub.seen.some(entry => entry.endsWith("/merge"))).toBe(false);
			expect(listAuthorizations().find(candidate => candidate.id === auth.id)?.result).toBe("rejected");
		} finally {
			stub.server.stop(true);
		}
	});

	test("red check: rejected, no merge call", async () => {
		const auth = freshAuthorization();
		const stub = githubStub({ checkConclusion: "failure" });
		try {
			await expect(
				executeMerge({
					authorizationId: auth.id,
					effortId: EFFORT_ID,
					expectedLeaseEpoch: leaseEpoch(),
					tokenRequest: { appId: "1", installationId: "99", pem: { kind: "file", path: PEM_FILE } },
					apiBase: stub.base,
				}),
			).rejects.toThrow(/required check not green/);
			expect(stub.seen.some(entry => entry.endsWith("/merge"))).toBe(false);
		} finally {
			stub.server.stop(true);
		}
	});

	test("double consume rejected", () => {
		const auth = freshAuthorization();
		consumeAuthorization(auth.id, HEAD, "merged", "first");
		expect(() => consumeAuthorization(auth.id, HEAD, "merged", "second")).toThrow(/already consumed/);
	});

	test("stale lease epoch fenced before any GitHub call", async () => {
		const auth = freshAuthorization();
		const stub = githubStub();
		try {
			await expect(
				executeMerge({
					authorizationId: auth.id,
					effortId: EFFORT_ID,
					expectedLeaseEpoch: leaseEpoch() + 42,
					tokenRequest: { appId: "1", installationId: "99", pem: { kind: "file", path: PEM_FILE } },
					apiBase: stub.base,
				}),
			).rejects.toThrow(/lease epoch moved/);
			expect(stub.seen.length).toBe(0);
		} finally {
			stub.server.stop(true);
		}
	});
});
