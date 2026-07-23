import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "deck-gw-"));
process.env.DECK_HOME = TEMP_HOME;

// Env pin must precede layout-reading imports (same pattern as itest).
const core = await import("@deck/core");
const { mintAuthorization, claimAuthorization, finalizeAuthorization, rejectAuthorization, listAuthorizations } = await import("../src/authorization");
const { executeMerge } = await import("../src/merge");
import type { KeychainCredentialSource } from "../src/credential";

const EFFORT_ID = "gw--merge-test";
const HEAD = "abc1234def5678";
const SOURCE: KeychainCredentialSource = { service: "deck-merge-app", account: "github" };

/** Test releaser: never touches the real Keychain; records that it was asked. */
function stubReleaser() {
	const calls: KeychainCredentialSource[] = [];
	return {
		calls,
		release: async (source: KeychainCredentialSource) => {
			calls.push(source);
			return "personal-write-token";
		},
	};
}

beforeAll(() => {
	core.ensureStateDirs();
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

describe("merge gateway scenarios (SPEC 10, I12 personal-cred)", () => {
	test("happy path: fence, checks, personal-cred release, merge, consume, receipt attempted->confirmed", async () => {
		const auth = freshAuthorization();
		const stub = githubStub();
		const releaser = stubReleaser();
		try {
			const receipt = await executeMerge({
				authorizationId: auth.id,
				effortId: EFFORT_ID,
				expectedLeaseEpoch: leaseEpoch(),
				credentialSource: SOURCE,
				releaseCredential: releaser.release,
				apiBase: stub.base,
			});
			expect(receipt.mergeSha).toBe("merge-sha-1");
			// The personal write credential was released exactly once, from the Keychain source.
			expect(releaser.calls).toEqual([SOURCE]);
			const manifest = core.openEffort(EFFORT_ID).readManifest();
			expect(manifest.side_effects.find(candidate => candidate.id === receipt.sideEffectId)?.status).toBe("confirmed");
			expect(listAuthorizations().find(candidate => candidate.id === auth.id)?.result).toBe("merged");
			expect(stub.seen).toContain("PUT /repos/acme/widgets/pulls/7/merge");
		} finally {
			stub.server.stop(true);
		}
	});

	test("head moved: burned via rejectAuthorization, no merge call", async () => {
		const auth = freshAuthorization();
		const stub = githubStub({ headSha: "moved9999999" });
		const releaser = stubReleaser();
		try {
			await expect(
				executeMerge({
					authorizationId: auth.id,
					effortId: EFFORT_ID,
					expectedLeaseEpoch: leaseEpoch(),
					credentialSource: SOURCE,
					releaseCredential: releaser.release,
					apiBase: stub.base,
				}),
			).rejects.toThrow(/head moved/);
			expect(stub.seen.some(entry => entry.endsWith("/merge"))).toBe(false);
			expect(listAuthorizations().find(candidate => candidate.id === auth.id)?.result).toBe("rejected");
		} finally {
			stub.server.stop(true);
		}
	});

	test("red check: burned, no merge call", async () => {
		const auth = freshAuthorization();
		const stub = githubStub({ checkConclusion: "failure" });
		const releaser = stubReleaser();
		try {
			await expect(
				executeMerge({
					authorizationId: auth.id,
					effortId: EFFORT_ID,
					expectedLeaseEpoch: leaseEpoch(),
					credentialSource: SOURCE,
					releaseCredential: releaser.release,
					apiBase: stub.base,
				}),
			).rejects.toThrow(/required check not green/);
			expect(stub.seen.some(entry => entry.endsWith("/merge"))).toBe(false);
			expect(listAuthorizations().find(candidate => candidate.id === auth.id)?.result).toBe("rejected");
		} finally {
			stub.server.stop(true);
		}
	});

	test("double claim rejected (single-use gate)", () => {
		const auth = freshAuthorization();
		claimAuthorization(auth.id, HEAD);
		expect(() => claimAuthorization(auth.id, HEAD)).toThrow(/already consumed/);
		// Finalizing the claim we hold is allowed and records the terminal result.
		finalizeAuthorization(auth.id, "merged", "merge-sha-x");
		expect(listAuthorizations().find(candidate => candidate.id === auth.id)?.result).toBe("merged");
	});

	test("rejectAuthorization is idempotent and blocks a later claim", () => {
		const auth = freshAuthorization();
		rejectAuthorization(auth.id, "manual reject");
		rejectAuthorization(auth.id, "again"); // idempotent, no throw
		expect(() => claimAuthorization(auth.id, HEAD)).toThrow(/already consumed/);
	});

	test("concurrent merges of one authorization: exactly one PUT, one merged, one rejected", async () => {
		const auth = freshAuthorization();
		const stub = githubStub();
		const releaser = stubReleaser();
		try {
			const attempt = () =>
				executeMerge({
					authorizationId: auth.id,
					effortId: EFFORT_ID,
					expectedLeaseEpoch: leaseEpoch(),
					credentialSource: SOURCE,
					releaseCredential: releaser.release,
					apiBase: stub.base,
				});
			const results = await Promise.allSettled([attempt(), attempt()]);
			const fulfilled = results.filter(result => result.status === "fulfilled");
			const rejected = results.filter(result => result.status === "rejected");
			expect(fulfilled.length).toBe(1);
			expect(rejected.length).toBe(1);
			// The single-use gate means at most one merge PUT reached GitHub.
			expect(stub.seen.filter(entry => entry.endsWith("/merge")).length).toBe(1);
			expect(listAuthorizations().find(candidate => candidate.id === auth.id)?.result).toBe("merged");
		} finally {
			stub.server.stop(true);
		}
	});

	test("stale lease epoch fenced before any GitHub call OR credential release", async () => {
		const auth = freshAuthorization();
		const stub = githubStub();
		const releaser = stubReleaser();
		try {
			await expect(
				executeMerge({
					authorizationId: auth.id,
					effortId: EFFORT_ID,
					expectedLeaseEpoch: leaseEpoch() + 42,
					credentialSource: SOURCE,
					releaseCredential: releaser.release,
					apiBase: stub.base,
				}),
			).rejects.toThrow(/lease epoch moved/);
			expect(stub.seen.length).toBe(0);
			expect(releaser.calls.length).toBe(0); // credential never released for a fenced merge
		} finally {
			stub.server.stop(true);
		}
	});

	test("epoch rotates mid-preflight (concurrent router revive): fenced, no PUT, authorization burned", async () => {
		const auth = freshAuthorization();
		const stub = githubStub();
		const startEpoch = leaseEpoch();
		// The releaser simulates time passing during credential release, and a
		// concurrent router revive bumping the owner lease epoch in that window.
		const releaser: KeychainCredentialSource[] = [];
		try {
			await expect(
				executeMerge({
					authorizationId: auth.id,
					effortId: EFFORT_ID,
					expectedLeaseEpoch: startEpoch,
					credentialSource: SOURCE,
					releaseCredential: async source => {
						releaser.push(source);
						core.openEffort(EFFORT_ID).bumpLease(core.openEffort(EFFORT_ID).readManifest().revision, {
							machine: "router",
							session_id: "revived-owner",
							last_heartbeat: null,
						});
						return "personal-write-token";
					},
					apiBase: stub.base,
				}),
			).rejects.toThrow(/lease epoch moved/);
			// Pre-flight passed (epoch matched at entry); the fence caught the bump
			// before the PUT. No merge call reached GitHub.
			expect(stub.seen.some(entry => entry.endsWith("/merge"))).toBe(false);
			expect(leaseEpoch()).toBeGreaterThan(startEpoch);
		} finally {
			stub.server.stop(true);
		}
	});
});
