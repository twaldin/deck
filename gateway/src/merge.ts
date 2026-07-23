/**
 * Fenced merge execution (SPEC §10, I7 mechanized, I12 personal-cred model).
 * Sequence:
 *   authorization valid (unconsumed)
 * → lease-epoch side-effect fence (SPEC §4.5)
 * → live head check (PR head must still equal the authorized sha)
 * → required checks green on that sha
 * → release Tim's personal Contents:write credential from Keychain (per-merge)
 * → lease re-check IMMEDIATELY before the irreversible call (TOCTOU close)
 * → PUT merge with `sha` binding (GitHub rejects if head moved mid-flight)
 * → consume authorization atomically (merged) / burn it (rejected)
 * → side-effect receipt attempted→confirmed (manifest + tail), CAS-retried.
 */
import { DeckError, openEffort } from "@deck/core";
import { z } from "zod";
import { claimAuthorization, finalizeAuthorization, listAuthorizations, rejectAuthorization } from "./authorization";
import { releaseWriteCredential, type CredentialReleaser, type KeychainCredentialSource } from "./credential";

export interface MergeRequest {
	authorizationId: string;
	effortId: string;
	expectedLeaseEpoch: number;
	/** Keychain location of Tim's personal Contents:write credential (§10/I12). */
	credentialSource: KeychainCredentialSource;
	/** Injectable for tests; defaults to the real Keychain release. */
	releaseCredential?: CredentialReleaser;
	fetchImpl?: typeof fetch;
	apiBase?: string;
}

const prSchema = z.looseObject({ head: z.looseObject({ sha: z.string() }), merged: z.boolean().optional() });
const checkRunsSchema = z.looseObject({
	check_runs: z.array(z.looseObject({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })),
});
const mergeResponseSchema = z.looseObject({ merged: z.boolean(), sha: z.string().optional(), message: z.string().optional() });

export interface MergeReceipt {
	sideEffectId: string;
	mergeSha: string;
}

/** Read the effort's current owner lease epoch (the side-effect fence value). */
function currentLeaseEpoch(effortId: string): number {
	return openEffort(effortId).readManifest().session?.lease_epoch ?? 0;
}

function assertLeaseEpoch(effortId: string, expected: number, when: string): void {
	const live = currentLeaseEpoch(effortId);
	if (live !== expected) {
		throw new DeckError("E_LEASE", `lease epoch moved (${when}); merge fenced`, { expected, actual: live });
	}
}

export async function executeMerge(request: MergeRequest): Promise<MergeReceipt> {
	const fetchImpl = request.fetchImpl ?? fetch;
	const apiBase = request.apiBase ?? "https://api.github.com";
	const release = request.releaseCredential ?? releaseWriteCredential;

	const authorization = listAuthorizations().find(candidate => candidate.id === request.authorizationId);
	if (authorization === undefined) throw new DeckError("E_STATE", "no such authorization", { id: request.authorizationId });
	if (authorization.consumed_ts !== null) throw new DeckError("E_STATE", "authorization already consumed", { id: authorization.id });

	// Side-effect fence (SPEC §4.5): stale owner generations cannot merge.
	assertLeaseEpoch(request.effortId, request.expectedLeaseEpoch, "pre-flight");

	const [owner, repo] = authorization.repo.split("/") as [string, string];
	const ghHeaders = (token: string): Record<string, string> => ({
		authorization: `Bearer ${token}`,
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
	});

	// Release Tim's personal write credential (Keychain biometric in prod).
	const writeToken = await release(request.credentialSource);

	const prResponse = await fetchImpl(`${apiBase}/repos/${owner}/${repo}/pulls/${authorization.pr}`, {
		headers: ghHeaders(writeToken),
	});
	if (!prResponse.ok) throw new DeckError("E_IO", `PR fetch failed: HTTP ${prResponse.status}`);
	const pr = prSchema.parse(await prResponse.json());
	if (pr.head.sha !== authorization.head_sha) {
		rejectAuthorization(authorization.id, `head moved: authorized ${authorization.head_sha}, saw ${pr.head.sha}`);
		throw new DeckError("E_STATE", "PR head moved since authorization; re-approve required", {
			authorized: authorization.head_sha,
			actual: pr.head.sha,
		});
	}

	const checksResponse = await fetchImpl(
		`${apiBase}/repos/${owner}/${repo}/commits/${authorization.head_sha}/check-runs?per_page=100`,
		{ headers: ghHeaders(writeToken) },
	);
	if (!checksResponse.ok) throw new DeckError("E_IO", `check-runs fetch failed: HTTP ${checksResponse.status}`);
	const checks = checkRunsSchema.parse(await checksResponse.json());
	for (const required of authorization.required_checks) {
		const run = checks.check_runs.find(candidate => candidate.name === required);
		if (run === undefined || run.status !== "completed" || run.conclusion !== "success") {
			rejectAuthorization(authorization.id, `required check not green: ${required}`);
			throw new DeckError("E_STATE", `required check not green: ${required}`, {
				status: run?.status ?? "missing",
				conclusion: run?.conclusion ?? null,
			});
		}
	}

	// Atomic single-use CLAIM before the PUT (SPEC §10): concurrent merges of the
	// same authorization serialize here; the loser throws `already consumed` and
	// never reaches the merge call. Head re-verified inside the claim.
	claimAuthorization(authorization.id, authorization.head_sha);

	// Receipt BEFORE the irreversible call (attempted), confirm after (SPEC §10).
	// recordSideEffect ALSO fences inside its mutate: the receipt cannot be
	// written under a rotated owner epoch (stale-owner merge path).
	const sideEffectId = recordSideEffect(request.effortId, authorization.head_sha, request.expectedLeaseEpoch, "attempted");

	// FINAL fence, immediately before the irreversible PUT (SPEC §4.5 "checks
	// lease_epoch immediately before executing"). claim + receipt above did real
	// file I/O during which the router (a SEPARATE process) could have bumped the
	// epoch; this is the last synchronous check before we cross the point of no
	// return. A stale epoch here burns the (already-claimed) authorization —
	// safe failure, reauthorization required.
	try {
		assertLeaseEpoch(request.effortId, request.expectedLeaseEpoch, "pre-merge");
	} catch (error) {
		finalizeAuthorization(authorization.id, "rejected", "lease epoch rotated before merge");
		throw error;
	}

	const mergeResponse = await fetchImpl(`${apiBase}/repos/${owner}/${repo}/pulls/${authorization.pr}/merge`, {
		method: "PUT",
		headers: { ...ghHeaders(writeToken), "content-type": "application/json" },
		body: JSON.stringify({ sha: authorization.head_sha, merge_method: "squash" }),
	});
	const mergeBody = mergeResponseSchema.parse(await mergeResponse.json().catch(() => ({ merged: false })));
	if (!mergeResponse.ok || !mergeBody.merged) {
		// Claim already spent single-use; record the terminal rejection. The
		// attempted receipt stays (honest evidence a merge was tried and failed).
		finalizeAuthorization(authorization.id, "rejected", `merge API HTTP ${mergeResponse.status}: ${mergeBody.message ?? ""}`);
		throw new DeckError("E_IO", `merge rejected upstream: HTTP ${mergeResponse.status} ${mergeBody.message ?? ""}`);
	}

	finalizeAuthorization(authorization.id, "merged", mergeBody.sha ?? "");
	confirmSideEffect(request.effortId, sideEffectId);
	return { sideEffectId, mergeSha: mergeBody.sha ?? authorization.head_sha };
}

/** CAS-retry wrapper for a manifest mutation (merge already happened; the receipt MUST land). */
function mutateWithRetry(effortId: string, attempts: number, mutate: (revision: number) => void): void {
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			mutate(openEffort(effortId).readManifest().revision);
			return;
		} catch (error) {
			lastError = error;
			if (error instanceof DeckError && error.code === "E_CAS") continue; // concurrent writer; re-read + retry
			throw error;
		}
	}
	throw new DeckError("E_IO", "side-effect receipt could not be recorded after retries", {
		effortId,
		cause: lastError instanceof Error ? lastError.message : String(lastError),
	});
}

function recordSideEffect(effortId: string, ref: string, leaseEpoch: number, status: "attempted"): string {
	const sideEffectId = crypto.randomUUID();
	mutateWithRetry(effortId, 8, revision => {
		openEffort(effortId).mutate(revision, null, draft => {
			// Fence inside the CAS mutate: refuse to record an attempt under a
			// rotated owner epoch — closes the stale-owner merge path even against
			// a concurrent router bump between the pre-flight check and here.
			const liveEpoch = draft.session?.lease_epoch ?? 0;
			if (liveEpoch !== leaseEpoch) {
				throw new DeckError("E_LEASE", "lease epoch moved (receipt); merge fenced", { expected: leaseEpoch, actual: liveEpoch });
			}
			return {
				manifest: {
					...draft,
					side_effects: [
						...draft.side_effects,
						{ id: sideEffectId, kind: "merge" as const, ref, status, ts: Date.now(), lease_epoch: leaseEpoch },
					],
				},
				event: {
					plane: "lifecycle",
					type: "lifecycle.side_effect",
					actor: "gateway:merge",
					data: { id: sideEffectId, kind: "merge", ref, status },
				},
			};
		});
	});
	return sideEffectId;
}

function confirmSideEffect(effortId: string, sideEffectId: string): void {
	mutateWithRetry(effortId, 8, revision => {
		openEffort(effortId).mutate(revision, null, draft => ({
			manifest: {
				...draft,
				side_effects: draft.side_effects.map(effect =>
					effect.id === sideEffectId ? { ...effect, status: "confirmed" as const } : effect,
				),
			},
			event: {
				plane: "lifecycle",
				type: "lifecycle.side_effect",
				actor: "gateway:merge",
				data: { id: sideEffectId, kind: "merge", status: "confirmed" },
			},
		}));
	});
}
