#!/usr/bin/env bun
/**
 * deck-merge CLI (SPEC §10).
 *   deck-merge mint --repo o/r --pr N --head-sha SHA --base main --checks a,b
 *   deck-merge run --authorization ID --effort EFFORT --lease-epoch N \
 *     --app-id ID --installation-id ID [--pem-file PATH | --keychain svc:acct]
 * v1 note (judgment call, recorded): minting is local CLI; the TUI-signed
 * authorization path (Tim's Keychain-held signing key) lands with the board
 * merge action in Phase 3 TUI work.
 */
import { DeckError } from "@deck/core";
import { mintAuthorization } from "./authorization";
import { executeMerge } from "./merge";
import type { PemSource } from "./app-token";

function flag(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

function requireFlag(name: string): string {
	const value = flag(name);
	if (value === undefined) throw new DeckError("E_ARG", `--${name} is required`);
	return value;
}

async function run(): Promise<number> {
	const command = process.argv[2];
	if (command === "mint") {
		const record = mintAuthorization({
			repo: requireFlag("repo"),
			pr: Number(requireFlag("pr")),
			head_sha: requireFlag("head-sha"),
			base: requireFlag("base"),
			required_checks: requireFlag("checks").split(",").map(check => check.trim()).filter(check => check.length > 0),
			workflow_run_id: flag("workflow-run-id") ?? null,
		});
		console.log(record.id);
		return 0;
	}
	if (command === "run") {
		const pemFile = flag("pem-file");
		const keychain = flag("keychain");
		let pem: PemSource;
		if (pemFile !== undefined) pem = { kind: "file", path: pemFile };
		else if (keychain !== undefined) {
			const [service, account] = keychain.split(":");
			if (service === undefined || account === undefined || account.length === 0) {
				throw new DeckError("E_ARG", "--keychain expects service:account");
			}
			pem = { kind: "keychain", service, account };
		} else throw new DeckError("E_ARG", "one of --pem-file or --keychain is required");
		const receipt = await executeMerge({
			authorizationId: requireFlag("authorization"),
			effortId: requireFlag("effort"),
			expectedLeaseEpoch: Number(requireFlag("lease-epoch")),
			tokenRequest: { appId: requireFlag("app-id"), installationId: requireFlag("installation-id"), pem },
		});
		console.log(`merged ${receipt.mergeSha}; receipt ${receipt.sideEffectId}`);
		return 0;
	}
	console.error("usage: deck-merge mint|run …");
	return 2;
}

run()
	.then(code => process.exit(code))
	.catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(error instanceof DeckError && (error.code === "E_ARG" || error.code === "E_STATE") ? 2 : 4);
	});
