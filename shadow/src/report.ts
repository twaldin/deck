import { z } from "zod";
import type { EffortActivity, WatchedEffort, WatcherLiveness } from "./firstmate.ts";
import type { PrFact } from "./poll.ts";
import { SessionFindingSchema, type SessionFinding } from "./sessions.ts";

export const REPORT_HEADER =
	"Deck shadow validates ingestion/watch parity and corroborates watcher stalls only; it does not run deck owners and does not claim deck drives work better.";

export const DEFAULT_STATUS_STALE_THRESHOLD_MS = 15 * 60 * 1_000;
export const WATCHER_STALL_THRESHOLD_MS = 300 * 1_000;
export const ACTIONABLE_STALE_REASON =
	"deck holds a fresh actionable fact firstmate appears behind on";

const ResolvedPrRowSchema = z.object({
	url: z.string().url(),
	resolved: z.literal(true),
	state: z.string(),
	landed: z.boolean(),
	landedSha: z.string().nullable(),
	checksRollup: z.enum(["passing", "failing", "pending", "none"]),
	failingChecks: z.array(z.string()),
	reviewDecision: z.string().nullable(),
	deckFactUpdatedAtMs: z.number().finite().nonnegative(),
	mergeStateStatus: z.string().nullable(),
});

const ErroredPrRowSchema = z.object({
	url: z.string().url(),
	resolved: z.literal(false),
	error: z.literal("poll failed"),
});

export const DivergenceReportSchema = z.object({
	header: z.literal(REPORT_HEADER),
	generatedAtMs: z.number().finite().nonnegative(),
	statusStaleThresholdMs: z.number().finite().nonnegative(),
	coverage: z.object({
		totalEfforts: z.number().int().nonnegative(),
		totalPrs: z.number().int().nonnegative(),
		resolvedPrs: z.number().int().nonnegative(),
		erroredPrs: z.number().int().nonnegative(),
	}),
	efforts: z.array(
		z.object({
			effortId: z.string(),
			description: z.string(),
			statusMtimeMs: z.number().finite().nonnegative().nullable(),
			ageSinceStatusMs: z.number().finite().nullable(),
			statusTail: z.string().nullable(),
			prs: z.array(z.union([ResolvedPrRowSchema, ErroredPrRowSchema])),
			flagged: z.boolean(),
			flagReason: z.literal(ACTIONABLE_STALE_REASON).nullable(),
		}),
	),
	watcherStall: z
		.object({
			detected: z.literal(true),
			ageSinceLatestMs: z.number().finite(),
			thresholdMs: z.number().finite().nonnegative(),
			shadowPollSucceeded: z.boolean(),
			message: z.string(),
		})
		.nullable(),
	liveness: z.object({
		latestEndedAtMs: z.number().finite().nonnegative().nullable(),
		beaconAgeSec: z.number().finite().nonnegative().nullable(),
		ageSinceLatestMs: z.number().finite().nullable(),
	}),
	sessions: z.object({
		scannedFiles: z.number().int().nonnegative(),
		windowMs: z.number().finite().nonnegative(),
		findings: z.array(SessionFindingSchema),
	}),
});

export type DivergenceReport = z.infer<typeof DivergenceReportSchema>;

export interface SessionsSection {
	scannedFiles: number;
	windowMs: number;
	findings: SessionFinding[];
}

const EMPTY_SESSIONS: SessionsSection = { scannedFiles: 0, windowMs: 0, findings: [] };

export interface ReportOptions {
	nowMs?: number;
	statusStaleThresholdMs?: number;
	sessions?: SessionsSection;
}

function isActionable(fact: PrFact): boolean {
	if (fact.checksRollup === "failing") {
		return true;
	}
	if (fact.reviewDecision?.toUpperCase().replace(/[-\s]/g, "_") === "CHANGES_REQUESTED") {
		return true;
	}
	// Landed (merged OR Graphite lands-and-closes) while the effort is still open
	// => should advance to done.
	if (fact.landed) {
		return true;
	}
	// Closed with NO base-branch squash commit => possibly dropped (the real
	// divergence, now that Graphite-landed closes are resolved to landed above).
	if (fact.state.toUpperCase() === "CLOSED" && !fact.landed) {
		return true;
	}
	return false;
}

export function buildDivergenceReport(
	watchSet: readonly WatchedEffort[],
	factsByUrl: ReadonlyMap<string, PrFact | null>,
	activityByEffort: ReadonlyMap<string, EffortActivity>,
	liveness: WatcherLiveness,
	options: ReportOptions = {},
): DivergenceReport {
	const nowMs = options.nowMs ?? Date.now();
	const statusStaleThresholdMs =
		options.statusStaleThresholdMs ?? DEFAULT_STATUS_STALE_THRESHOLD_MS;
	const uniquePrUrls = [...new Set(watchSet.flatMap((effort) => effort.prUrls))];
	const resolvedPrs = uniquePrUrls.filter((url) => factsByUrl.get(url) != null).length;
	const erroredPrs = uniquePrUrls.length - resolvedPrs;

	const efforts = watchSet.map((effort) => {
		const activity = activityByEffort.get(effort.effortId) ?? {
			statusMtimeMs: null,
			statusTail: null,
		};
		const prs = effort.prUrls.map((url) => {
			const fact = factsByUrl.get(url);
			if (fact == null) {
				return ErroredPrRowSchema.parse({ url, resolved: false, error: "poll failed" });
			}
			return ResolvedPrRowSchema.parse({
				url,
				resolved: true,
				state: fact.state,
				landed: fact.landed,
				landedSha: fact.landedSha ?? null,
				checksRollup: fact.checksRollup,
				failingChecks: fact.failingChecks,
				reviewDecision: fact.reviewDecision ?? null,
				deckFactUpdatedAtMs: fact.updatedAtMs,
				mergeStateStatus: fact.mergeStateStatus ?? null,
			});
		});
		const flagged = effort.prUrls.some((url) => {
			const fact = factsByUrl.get(url);
			return (
				fact != null &&
				isActionable(fact) &&
				activity.statusMtimeMs !== null &&
				fact.updatedAtMs - activity.statusMtimeMs > statusStaleThresholdMs
			);
		});
		return {
			effortId: effort.effortId,
			description: effort.description,
			statusMtimeMs: activity.statusMtimeMs,
			ageSinceStatusMs:
				activity.statusMtimeMs === null ? null : nowMs - activity.statusMtimeMs,
			statusTail: activity.statusTail,
			prs,
			flagged,
			flagReason: flagged ? ACTIONABLE_STALE_REASON : null,
		};
	});

	let watcherStall: DivergenceReport["watcherStall"] = null;
	if (
		liveness.ageSinceLatestMs !== null &&
		liveness.ageSinceLatestMs > WATCHER_STALL_THRESHOLD_MS
	) {
		const shadowPollSucceeded = resolvedPrs > 0;
		watcherStall = {
			detected: true,
			ageSinceLatestMs: liveness.ageSinceLatestMs,
			thresholdMs: WATCHER_STALL_THRESHOLD_MS,
			shadowPollSucceeded,
			message: shadowPollSucceeded
				? "Firstmate watcher looks stalled; deck's shadow poll succeeded while firstmate was blind."
				: "Firstmate watcher looks stalled; no deck PR poll succeeded in this pass, so shadow coverage during the window is unproven.",
		};
	}

	return DivergenceReportSchema.parse({
		header: REPORT_HEADER,
		generatedAtMs: nowMs,
		statusStaleThresholdMs,
		coverage: {
			totalEfforts: watchSet.length,
			totalPrs: uniquePrUrls.length,
			resolvedPrs,
			erroredPrs,
		},
		efforts,
		watcherStall,
		liveness,
		sessions: options.sessions ?? EMPTY_SESSIONS,
	});
}

export function formatHumanReport(report: DivergenceReport): string {
	const lines = [
		report.header,
		"",
		`Coverage: ${report.coverage.totalEfforts} efforts, ${report.coverage.totalPrs} PRs, ${report.coverage.resolvedPrs} resolved, ${report.coverage.erroredPrs} errored`,
		"",
		"EFFORT\tSTATUS AGE\tPR\tSTATE\tMERGE\tCHECKS\tFAILING\tREVIEW\tFLAG",
	];
	for (const effort of report.efforts) {
		const age =
			effort.ageSinceStatusMs === null
				? "missing"
				: `${Math.max(0, Math.round(effort.ageSinceStatusMs / 1_000))}s`;
		if (effort.prs.length === 0) {
			lines.push(
				`${effort.effortId}\t${age}\t-\t-\t-\t-\t-\t-\t${effort.flagged ? "FLAGGED" : ""}`,
			);
		} else {
			for (const pr of effort.prs) {
				if (!pr.resolved) {
					lines.push(`${effort.effortId}\t${age}\t${pr.url}\tERROR\t-\t-\t-\t-\t`);
					continue;
				}
				// Show LANDED for a Graphite/squash land (state=CLOSED but on main),
				// so a landed PR never reads as a scary unmerged "CLOSED".
				const displayState = pr.landed && pr.state.toUpperCase() !== "MERGED" ? `LANDED(${pr.state})` : pr.state;
				lines.push(
					`${effort.effortId}\t${age}\t${pr.url}\t${displayState}\t${pr.mergeStateStatus ?? "-"}\t${pr.checksRollup}\t${pr.failingChecks.join(", ") || "-"}\t${pr.reviewDecision ?? "-"}\t${effort.flagged ? "FLAGGED" : ""}`,
				);
			}
		}
		if (effort.statusTail !== null) {
			lines.push(`  STATUS TAIL: ${effort.statusTail.replace(/\n/g, "\n  ")}`);
		}
		if (effort.flagReason !== null) {
			lines.push(`  FLAG REASON: ${effort.flagReason}`);
		}
	}
	if (report.watcherStall !== null) {
		lines.push("", `WATCHER STALL: ${report.watcherStall.message}`);
	}
	if (report.sessions.scannedFiles > 0 || report.sessions.findings.length > 0) {
		lines.push(
			"",
			`SESSION EVIDENCE: ${report.sessions.scannedFiles} mate session logs scanned (claude/codex/omp), ${report.sessions.findings.length} findings`,
		);
		for (const finding of report.sessions.findings) {
			lines.push(
				`  [${finding.severity.toUpperCase()}] ${finding.kind}${finding.effortId !== null ? ` ${finding.effortId}` : ""}: ${finding.detail}`,
			);
			for (const path of finding.evidencePaths.slice(0, 3)) {
				lines.push(`    evidence: ${path}`);
			}
		}
	}
	return lines.join("\n");
}
