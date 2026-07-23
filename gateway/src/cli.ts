#!/usr/bin/env bun
/**
 * deck-merge CLI (SPEC §10, I12 personal-credential model).
 *   deck-merge mint --repo o/r --pr N --head-sha SHA --base main --checks a,b
 *   deck-merge run --authorization ID --effort EFFORT --lease-epoch N \
 *     --keychain <service>:<account>
 * The Keychain item holds Tim's personal Contents:write credential; releasing
 * it prompts his biometric per merge. No GitHub App, no PEM, no installation
 * id — Deck is invisible to lindy (I12). v1 note (judgment call, recorded):
 * minting is local CLI; the TUI-signed authorization path lands with the board
 * merge action in later TUI work.
 */
import { DeckError } from "@deck/core";
import { mintAuthorization } from "./authorization";
import { executeMerge } from "./merge";
import type { KeychainCredentialSource } from "./credential";

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
		const keychain = flag("keychain");
		if (keychain === undefined) throw new DeckError("E_ARG", "--keychain <service>:<account> is required");
		const [service, account] = keychain.split(":");
		if (service === undefined || account === undefined || account.length === 0) {
			throw new DeckError("E_ARG", "--keychain expects service:account");
		}
		const credentialSource: KeychainCredentialSource = { service, account };
		const receipt = await executeMerge({
			authorizationId: requireFlag("authorization"),
			effortId: requireFlag("effort"),
			expectedLeaseEpoch: Number(requireFlag("lease-epoch")),
			credentialSource,
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
