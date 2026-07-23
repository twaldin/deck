/**
 * Merge-authority credential release (SPEC §10, I12: NO GitHub App).
 *
 * The authority-tier credential is Tim's OWN `Contents: write` GitHub
 * credential (his `gh auth token` OAuth token or a dedicated personal
 * write-PAT) — user-scoped, invisible to lindy. It lives in the macOS Keychain
 * behind an ACL requiring his biometric/password, released PER MERGE. No App,
 * no JWT, no installation endpoint: the broker cannot silently obtain it, and
 * to lindy a merge is indistinguishable from Tim running `gh` himself.
 *
 * Keychain is the ONLY production source (§10). There is deliberately no env
 * or file source — either would enable unattended merge authority and defeat
 * the per-merge human gate. Tests inject a `CredentialReleaser` directly.
 *
 * Token bytes are never logged.
 */
import { DeckError } from "@deck/core";

export interface KeychainCredentialSource {
	service: string;
	account: string;
}

/** Injected in tests; production releases from the Keychain via security(1). */
export type CredentialReleaser = (source: KeychainCredentialSource) => Promise<string>;

export const releaseWriteCredential: CredentialReleaser = async source => {
	// macOS prompts per the item's ACL here (biometric / password), per merge.
	const proc = Bun.spawn(["security", "find-generic-password", "-s", source.service, "-a", source.account, "-w"], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const token = (await new Response(proc.stdout).text()).trim();
	if ((await proc.exited) !== 0 || token.length === 0) {
		throw new DeckError("E_CAP", `Keychain refused release of ${source.service}/${source.account}`);
	}
	return token;
};
