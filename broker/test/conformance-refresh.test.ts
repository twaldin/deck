import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	AuthStorage,
	type AuthStorageOptions,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai";

type TempAuthStorage = {
	directory: string;
	storage: AuthStorage;
	store: SqliteAuthCredentialStore;
};

const tempStores: TempAuthStorage[] = [];

async function createTempAuthStorage(options: AuthStorageOptions = {}): Promise<TempAuthStorage> {
	const directory = mkdtempSync(path.join(tmpdir(), "deck-conformance-refresh-"));
	let store: SqliteAuthCredentialStore | undefined;
	try {
		store = await SqliteAuthCredentialStore.open(path.join(directory, "store.db"));
		const storage = new AuthStorage(store, options);
		await storage.reload();
		const result = { directory, storage, store };
		tempStores.push(result);
		return result;
	} catch (error) {
		store?.close();
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}

function requireCredential(rows: StoredAuthCredential[], id: number): StoredAuthCredential {
	const row = rows.find(candidate => candidate.id === id);
	if (!row) throw new Error(`Expected active credential id=${id}`);
	return row;
}

afterEach(() => {
	for (const resource of tempStores.splice(0)) {
		try {
			resource.storage.close();
		} finally {
			rmSync(resource.directory, { recursive: true, force: true });
		}
	}
});

describe("SPEC 6.5 credential refresh conformance", () => {
	test("(8) a definitive refresh failure disables only the revoked credential", async () => {
		const disabledCauses: string[] = [];
		const { storage, store } = await createTempAuthStorage({
			onCredentialDisabled: event => {
				disabledCauses.push(event.disabledCause);
			},
		});

		const revokedRows = store.upsertAuthCredentialForProvider("anthropic", {
			type: "oauth",
			refresh: "sk-ant-ort01-deck-battery-invalid",
			access: "sk-ant-oat01-deck-battery-invalid",
			expires: Date.now() - 60_000,
			email: "revoked@deck.invalid",
		});
		const revoked = revokedRows.find(row => row.credential.type === "oauth" && row.credential.email === "revoked@deck.invalid");
		if (!revoked) throw new Error("Failed to seed revoked credential");

		const siblingRows = store.upsertAuthCredentialForProvider("anthropic", {
			type: "oauth",
			refresh: "sk-ant-ort01-deck-battery-sibling-invalid",
			access: "sk-ant-oat01-deck-battery-sibling-invalid",
			expires: Date.now() + 3_600_000,
			email: "sibling@deck.invalid",
		});
		const sibling = siblingRows.find(row => row.credential.type === "oauth" && row.credential.email === "sibling@deck.invalid");
		if (!sibling) throw new Error("Failed to seed sibling credential");
		await storage.reload();

		await expect(storage.refreshCredentialById(revoked.id)).rejects.toThrow();

		const activeRows = store.listAuthCredentials("anthropic");
		expect(activeRows.some(row => row.id === revoked.id)).toBe(false);
		expect(requireCredential(activeRows, sibling.id).disabledCause).toBeNull();
		expect(storage.exportSnapshot().credentials.map(entry => entry.id)).toEqual([sibling.id]);
		expect(disabledCauses).toHaveLength(1);
		expect(disabledCauses[0]).toStartWith("oauth refresh failed:");
		expect(disabledCauses[0]).toContain("invalid_grant");
	}, 40_000);

	test("(9) concurrent refreshes single-flight each atomic token rotation", async () => {
		let refreshCalls = 0;
		const { storage, store } = await createTempAuthStorage({
			refreshOAuthCredential: async () => {
				const rotation = ++refreshCalls;
				// Real overlap is the contract: fake timers would also distort the SQLite lease clock.
				await Bun.sleep(150);
				return {
					refresh: `rot-${rotation}`,
					access: `acc-${rotation}`,
					expires: Date.now() + 3_600_000,
				};
			},
		});

		const seededRows = store.upsertAuthCredentialForProvider("anthropic", {
			type: "oauth",
			refresh: "seed-refresh",
			access: "seed-access",
			expires: Date.now() - 60_000,
			email: "single-flight@deck.invalid",
		});
		const seeded = seededRows.find(
			row => row.credential.type === "oauth" && row.credential.email === "single-flight@deck.invalid",
		);
		if (!seeded) throw new Error("Failed to seed single-flight credential");
		await storage.reload();

		const firstWave = await Promise.all(
			Array.from({ length: 8 }, () => storage.refreshCredentialById(seeded.id)),
		);
		expect(refreshCalls).toBe(1);
		for (const result of firstWave) {
			expect(result.credential.type).toBe("oauth");
			if (result.credential.type !== "oauth") throw new Error("Expected OAuth refresh result");
			expect(result.credential.access).toBe("acc-1");
		}
		const storedAfterFirst = requireCredential(store.listAuthCredentials("anthropic"), seeded.id);
		expect(storedAfterFirst.credential.type).toBe("oauth");
		if (storedAfterFirst.credential.type !== "oauth") throw new Error("Expected stored OAuth credential");
		expect(storedAfterFirst.credential.refresh).toBe("rot-1");
		expect(storedAfterFirst.credential.access).toBe("acc-1");

		const secondWave = await Promise.all(
			Array.from({ length: 8 }, () => storage.refreshCredentialById(seeded.id)),
		);
		expect(refreshCalls).toBe(2);
		for (const result of secondWave) {
			expect(result.credential.type).toBe("oauth");
			if (result.credential.type !== "oauth") throw new Error("Expected OAuth refresh result");
			expect(result.credential.access).toBe("acc-2");
		}
		const storedAfterSecond = requireCredential(store.listAuthCredentials("anthropic"), seeded.id);
		expect(storedAfterSecond.credential.type).toBe("oauth");
		if (storedAfterSecond.credential.type !== "oauth") throw new Error("Expected stored OAuth credential");
		expect(storedAfterSecond.credential.refresh).toBe("rot-2");
		expect(storedAfterSecond.credential.access).toBe("acc-2");
	}, 10_000);
});
