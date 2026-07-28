/**
 * Conditional migration gate (SOP stage 5, mandatory when triggered).
 * Diff touches migrations/ or packages/database-migrations/ -> the landing
 * path REQUIRES the migration-run node (stg -> verify -> prod -> verify).
 * [Evidence: #25203 blocked repo-wide CI]
 */

import type { MigrationEvidenceEntry } from "./types.ts";

export const DEFAULT_MIGRATION_PATTERNS: readonly string[] = [
	"migrations/",
	"packages/database-migrations/",
];

/** Files in the diff that live under a migration path. */
export function detectMigrations(
	changedFiles: string[],
	patterns: readonly string[] = DEFAULT_MIGRATION_PATTERNS,
): string[] {
	return changedFiles.filter((file) =>
		patterns.some((pattern) => file === pattern || file.startsWith(pattern) || file.includes(`/${pattern}`)),
	);
}

export const MIGRATION_STAGES = ["stg-run", "stg-verify", "prod-run", "prod-verify"] as const;

/** Evidence is complete when all four stages are present and ok. */
export function migrationEvidenceComplete(evidence: MigrationEvidenceEntry[]): boolean {
	return MIGRATION_STAGES.every((stage) =>
		evidence.some((entry) => entry.stage === stage && entry.ok),
	);
}

export function missingMigrationStages(evidence: MigrationEvidenceEntry[]): string[] {
	return MIGRATION_STAGES.filter(
		(stage) => !evidence.some((entry) => entry.stage === stage && entry.ok),
	);
}
