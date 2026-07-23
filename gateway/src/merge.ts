/**
 * Fenced merge execution (SPEC §10, I7 mechanized). Sequence:
 *   authorization valid (unconsumed, head-bound)
 * → lease-epoch side-effect fence (SPEC §4.5) immediately before executing
 * → live head check (PR head must still equal the authorized sha)
 * → required checks green on that sha
 * → mint deck-merge installation token (Keychain source in prod)
 * → PUT merge with `sha` binding (GitHub rejects if head moved mid-flight)
 * → consume authorization atomically
 * → side-effect receipt attempted→confirmed on the effort (manifest + tail).
 */
import { DeckError, openEffort } from "@deck/core";
import { z } from "zod";
import { consumeAuthorization, listAuthorizations } from "./authorization";
import { mintInstallationToken, type AppTokenRequest } from "./app-token";

export interface MergeRequest {
	authorizationId: string;
	effortId: string;
	expectedLeaseEpoch: number;
	tokenRequest: AppTokenRequest;
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

export async function executeMerge(request: MergeRequest): Promise<MergeReceipt> {
	const fetchImpl = request.fetchImpl ?? fetch;
	const apiBase = request.apiBase ?? "https://api.github.com";

	const authorization = listAuthorizations().find(candidate => candidate.id === request.authorizationId);
	if (authorization === undefined) throw new DeckError("E_STATE", "no such authorization", { id: request.authorizationId });
	if (authorization.consumed_ts !== null) throw new DeckError("E_STATE", "authorization already consumed", { id: authorization.id });

	// Side-effect fence (SPEC §4.5): stale owner generations cannot merge.
	const store = openEffort(request.effortId);
	const manifest = store.readManifest();
	const liveEpoch = manifest.session?.lease_epoch ?? 0;
	if (liveEpoch !== request.expectedLeaseEpoch) {
		throw new DeckError("E_LEASE", "lease epoch moved; merge fenced", {
			expected: request.expectedLeaseEpoch,
			actual: liveEpoch,
		});
	}

	const [owner, repo] = authorization.repo.split("/") as [string, string];
	const ghHeaders = (token: string): Record<string, string> => ({
		authorization: `Bearer ${token}`,
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
	});

	// Pre-mint validation uses the same minted token (single credential path);
	// mint happens only after the cheap local rejections above.
	const installation = await mintInstallationToken({ ...request.tokenRequest, fetchImpl, apiBase });

	const prResponse = await fetchImpl(`${apiBase}/repos/${owner}/${repo}/pulls/${authorization.pr}`, {
		headers: ghHeaders(installation.token),
	});
	if (!prResponse.ok) throw new DeckError("E_IO", `PR fetch failed: HTTP ${prResponse.status}`);
	const pr = prSchema.parse(await prResponse.json());
	if (pr.head.sha !== authorization.head_sha) {
		consumeAuthorization(authorization.id, pr.head.sha, "rejected", "head moved before merge");
		throw new DeckError("E_STATE", "PR head moved since authorization; re-approve required", {
			authorized: authorization.head_sha,
			actual: pr.head.sha,
		});
	}

	const checksResponse = await fetchImpl(
		`${apiBase}/repos/${owner}/${repo}/commits/${authorization.head_sha}/check-runs?per_page=100`,
		{ headers: ghHeaders(installation.token) },
	);
	if (!checksResponse.ok) throw new DeckError("E_IO", `check-runs fetch failed: HTTP ${checksResponse.status}`);
	const checks = checkRunsSchema.parse(await checksResponse.json());
	for (const required of authorization.required_checks) {
		const run = checks.check_runs.find(candidate => candidate.name === required);
		if (run === undefined || run.status !== "completed" || run.conclusion !== "success") {
			throw new DeckError("E_STATE", `required check not green: ${required}`, {
				status: run?.status ?? "missing",
				conclusion: run?.conclusion ?? null,
			});
		}
	}

	// Receipt BEFORE the irreversible call (attempted), confirm after (SPEC §10).
	const sideEffectId = recordSideEffect(request.effortId, authorization.head_sha, request.expectedLeaseEpoch, "attempted");

	const mergeResponse = await fetchImpl(`${apiBase}/repos/${owner}/${repo}/pulls/${authorization.pr}/merge`, {
		method: "PUT",
		headers: { ...ghHeaders(installation.token), "content-type": "application/json" },
		body: JSON.stringify({ sha: authorization.head_sha, merge_method: "squash" }),
	});
	const mergeBody = mergeResponseSchema.parse(await mergeResponse.json().catch(() => ({ merged: false })));
	if (!mergeResponse.ok || !mergeBody.merged) {
		consumeAuthorization(authorization.id, authorization.head_sha, "rejected", `merge API HTTP ${mergeResponse.status}: ${mergeBody.message ?? ""}`);
		throw new DeckError("E_IO", `merge rejected upstream: HTTP ${mergeResponse.status} ${mergeBody.message ?? ""}`);
	}

	consumeAuthorization(authorization.id, authorization.head_sha, "merged", mergeBody.sha ?? "");
	confirmSideEffect(request.effortId, sideEffectId);
	return { sideEffectId, mergeSha: mergeBody.sha ?? authorization.head_sha };
}

function recordSideEffect(effortId: string, ref: string, leaseEpoch: number, status: "attempted"): string {
	const store = openEffort(effortId);
	const manifest = store.readManifest();
	let sideEffectId = "";
	store.mutate(manifest.revision, null, draft => {
		sideEffectId = crypto.randomUUID();
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
	return sideEffectId;
}

function confirmSideEffect(effortId: string, sideEffectId: string): void {
	const store = openEffort(effortId);
	const manifest = store.readManifest();
	store.mutate(manifest.revision, null, draft => ({
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
}
