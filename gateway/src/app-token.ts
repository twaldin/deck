/**
 * GitHub App installation-token minting (SPEC §10). Two PEM sources map the
 * two-tier trust model (SPEC §13):
 * - file: utility tier (deck-agent) — ~/.deck/gh/utility/deck-agent.pem
 * - keychain: authority tier (deck-merge) — released per use via security(1);
 *   the biometric ACL is attached when Tim imports the key, not here.
 * Token/PEM bytes are never logged and never returned to callers other than
 * as the minted short-lived installation token.
 */
import { createSign } from "node:crypto";
import * as fs from "node:fs";
import { DeckError } from "@deck/core";
import { z } from "zod";

export type PemSource =
	| { kind: "file"; path: string }
	| { kind: "keychain"; service: string; account: string };

export interface AppTokenRequest {
	appId: string;
	installationId: string;
	pem: PemSource;
	/** Injectable for tests; defaults to global fetch + api.github.com. */
	fetchImpl?: typeof fetch;
	apiBase?: string;
}

const tokenResponseSchema = z.looseObject({ token: z.string().min(1), expires_at: z.string() });
export interface InstallationToken {
	token: string;
	expiresAt: string;
}

async function loadPem(source: PemSource): Promise<string> {
	if (source.kind === "file") {
		try {
			return fs.readFileSync(source.path, "utf8");
		} catch {
			throw new DeckError("E_CAP", `no App private key at ${source.path}`, { path: source.path });
		}
	}
	// Authority tier: Keychain release — macOS prompts per the key's ACL here.
	const proc = Bun.spawn(["security", "find-generic-password", "-s", source.service, "-a", source.account, "-w"], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const pem = (await new Response(proc.stdout).text()).trim();
	if ((await proc.exited) !== 0 || pem.length === 0) {
		throw new DeckError("E_CAP", `Keychain refused release of ${source.service}/${source.account}`);
	}
	return pem;
}

function base64url(input: Buffer | string): string {
	return Buffer.from(input).toString("base64url");
}

/** RS256 App JWT: iat backdated 60s for clock skew, 9-min expiry (GitHub max 10). */
export function buildAppJwt(appId: string, pem: string, nowSec: number = Math.floor(Date.now() / 1000)): string {
	const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = base64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: appId }));
	const signer = createSign("RSA-SHA256");
	signer.update(`${header}.${payload}`);
	const signature = signer.sign(pem).toString("base64url");
	return `${header}.${payload}.${signature}`;
}

export async function mintInstallationToken(request: AppTokenRequest): Promise<InstallationToken> {
	const pem = await loadPem(request.pem);
	const jwt = buildAppJwt(request.appId, pem);
	const fetchImpl = request.fetchImpl ?? fetch;
	const apiBase = request.apiBase ?? "https://api.github.com";
	const response = await fetchImpl(`${apiBase}/app/installations/${request.installationId}/access_tokens`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${jwt}`,
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
		},
	});
	if (!response.ok) {
		throw new DeckError("E_CAP", `installation token mint failed: HTTP ${response.status}`, {
			body: (await response.text()).slice(0, 300),
		});
	}
	const parsed = tokenResponseSchema.parse(await response.json());
	return { token: parsed.token, expiresAt: parsed.expires_at };
}
