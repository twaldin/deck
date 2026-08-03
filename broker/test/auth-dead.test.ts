/**
 * Auth-dead conformance: a definitively revoked OAuth grant must leave routing
 * (never picked again) and must stay VISIBLE (roster + status), because a
 * silently vanished account reads as unexplained missing quota.
 */
import "./tmp-home"; // MUST be first: fixes DECK_HOME before paths.ts resolves it
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { AuthBrokerRefresher } from "@oh-my-pi/pi-ai/auth-broker";
import { NoQuotaError, pickAccount, snapshotQuotaAccounts } from "../src/quota";
import { isAuthDeadCause, refreshUsageRoster, shortCause } from "../src/usage";

const resources: Array<{ directory: string; storage: AuthStorage }> = [];

afterEach(() => {
	for (const resource of resources.splice(0)) {
		try {
			resource.storage.close();
		} finally {
			rmSync(resource.directory, { recursive: true, force: true });
		}
	}
});

async function seedStore() {
	const directory = mkdtempSync(path.join(tmpdir(), "deck-auth-dead-"));
	const store = await SqliteAuthCredentialStore.open(path.join(directory, "store.db"));
	const storage = new AuthStorage(store);
	await storage.reload();
	resources.push({ directory, storage });
	return { store, storage };
}

function seedOAuth(store: SqliteAuthCredentialStore, email: string, expires: number) {
	const rows = store.upsertAuthCredentialForProvider("anthropic", {
		type: "oauth",
		refresh: `sk-ant-ort01-${email}`,
		access: `sk-ant-oat01-${email}`,
		expires,
		email,
	});
	const row = rows.find(candidate => candidate.credential.type === "oauth" && candidate.credential.email === email);
	if (!row) throw new Error(`failed to seed ${email}`);
	return row;
}

describe("auth-dead accounts", () => {
	test("a revoked grant leaves routing while its sibling keeps serving", async () => {
		const { store, storage } = await seedStore();
		const revoked = seedOAuth(store, "revoked@deck.invalid", Date.now() - 60_000);
		const sibling = seedOAuth(store, "sibling@deck.invalid", Date.now() + 3_600_000);
		await storage.reload();

		const before = snapshotQuotaAccounts(storage.exportSnapshot(), ids => store.listCredentialBlocks(ids));
		expect(before.map(account => account.credentialId).sort()).toEqual([revoked.id, sibling.id].sort());

		// A real invalid_grant: pi-ai soft-disables only this row.
		await expect(storage.refreshCredentialById(revoked.id)).rejects.toThrow();

		const after = snapshotQuotaAccounts(storage.exportSnapshot(), ids => store.listCredentialBlocks(ids));
		expect(after.map(account => account.credentialId)).toEqual([sibling.id]);
		// Routing must never hand back the dead credential.
		for (let attempt = 0; attempt < 5; attempt++) {
			expect(pickAccount({ id: "claude-sonnet-4-5", provider: "anthropic" }, after).credentialId).toBe(sibling.id);
		}
	}, 40_000);

	test("an in-flight auth resolve fails over to a live sibling", async () => {
		const { store, storage } = await seedStore();
		const revoked = seedOAuth(store, "inflight-dead@deck.invalid", Date.now() - 60_000);
		const sibling = seedOAuth(store, "inflight-live@deck.invalid", Date.now() + 3_600_000);
		await storage.reload();
		expect(storage.pinSessionOAuthAccount("anthropic", "inflight-session", revoked.id)).toBe(true);
		expect(await storage.getApiKey("anthropic", "inflight-session")).toBe((sibling.credential as { access: string }).access);
		expect(storage.exportSnapshot().credentials.map(entry => entry.id)).toEqual([sibling.id]);
	}, 40_000);

	test("the background refresh marks auth-dead without an unhandled rejection", async () => {
		const { store, storage } = await seedStore();
		const revoked = seedOAuth(store, "background-dead@deck.invalid", Date.now() - 60_000);
		await storage.reload();
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		try {
			const refresher = new AuthBrokerRefresher({ storage, refreshSkewMs: 5 * 60_000 });
			await expect(refresher.tick()).resolves.toBeUndefined();
			await Bun.sleep(0);
			expect(unhandled).toEqual([]);
			const roster = await refreshUsageRoster(storage);
			expect(roster.dead).toContainEqual(expect.objectContaining({ id: revoked.id, email: "background-dead@deck.invalid" }));
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	}, 40_000);

	test("a live invalidated-token response becomes visible auth-dead state", async () => {
		const { store, storage } = await seedStore();
		const revoked = seedOAuth(store, "invalidated-live@deck.invalid", Date.now() + 3_600_000);
		await storage.reload();
		storage.pinSessionOAuthAccount("anthropic", "invalidated-session", revoked.id);
		await storage.getApiKey("anthropic", "invalidated-session");
		await storage.rotateSessionCredential("anthropic", "invalidated-session", {
			credentialId: revoked.id,
			error: new Error("provider reported invalidated OAuth token"),
		});
		const roster = await refreshUsageRoster(storage);
		expect(roster.dead).toContainEqual(expect.objectContaining({ id: revoked.id, email: "invalidated-live@deck.invalid" }));
	});

	test("the roster carries the dead account with its cause", async () => {
		const { store, storage } = await seedStore();
		const revoked = seedOAuth(store, "roster-dead@deck.invalid", Date.now() - 60_000);
		await storage.reload();
		await expect(storage.refreshCredentialById(revoked.id)).rejects.toThrow();

		const roster = await refreshUsageRoster(storage);
		expect(roster.dead).toHaveLength(1);
		expect(roster.dead[0]).toMatchObject({ id: revoked.id, provider: "anthropic", email: "roster-dead@deck.invalid" });
		expect(roster.dead[0]!.cause).toContain("invalid_grant");
		// The verbatim cause is a stack trace; the roster keeps one readable line.
		expect(roster.dead[0]!.cause).not.toContain("node_modules");
		expect(roster.dead[0]!.cause.length).toBeLessThanOrEqual(201);
	}, 40_000);

	test("an empty account pool for the provider is NO_QUOTA, not a silent pick", () => {
		expect(() => pickAccount({ id: "claude-sonnet-4-5", provider: "anthropic" }, [])).toThrow(NoQuotaError);
	});

	test("only definitive auth failures are auth-dead; a user logout is not", () => {
		expect(isAuthDeadCause("oauth refresh failed: invalid_grant")).toBe(true);
		expect(isAuthDeadCause("upstream reported invalidated OAuth token")).toBe(true);
		expect(isAuthDeadCause("Anthropic invalidated OAuth token")).toBe(true);
		expect(isAuthDeadCause("deleted by user")).toBe(false);
	});
});

describe("dead-account cause text", () => {
	test("keeps the provider error code and drops the stack trace", () => {
		const verbatim =
			'oauth refresh failed: OAuthError: Anthropic token refresh request failed. url=https://api.anthropic.com/v1/oauth/token; details=ProviderHttpError: HTTP request failed. status=400; body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}; stack=ProviderHttpError\n    at postJson (/Users/x/node_modules/@oh-my-pi/pi-ai/src/registry/oauth/anthropic.ts:65:21)\n    at async refreshAnthropicToken';
		const short = shortCause(verbatim);
		expect(short).toBe("invalid_grant: Refresh token not found or invalid");
		expect(short).not.toContain("node_modules");
		expect(short).not.toContain("\n");
	});

	test("falls back to a bounded first line when there is no provider code", () => {
		expect(shortCause("oauth refresh failed: socket hang up\n    at Foo")).toBe("oauth refresh failed: socket hang up");
		expect(shortCause(`oauth refresh failed: ${"x".repeat(500)}`).length).toBeLessThanOrEqual(201);
	});
});
