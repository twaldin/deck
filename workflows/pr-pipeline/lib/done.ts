/**
 * Evidence-gated done (SOP stage 10): done requires deploy evidence + a
 * fallout verdict recorded (+ complete migration evidence when the migration
 * gate triggered). Merged != done.
 */

import { migrationEvidenceComplete, missingMigrationStages } from "./migrations.ts";
import type { DoneEvidence, DoneVerdict } from "./types.ts";

export function evaluateDone(evidence: DoneEvidence): DoneVerdict {
	const missing: string[] = [];
	if (evidence.landedSha === null || evidence.landedSha === "") {
		missing.push("landing not verified: no squash commit (#N) found on main.");
	}
	if (evidence.deployEvidence === null || evidence.deployEvidence === "") {
		missing.push("no fallout evidence recorded.");
	}
	if (evidence.falloutVerdict === null) {
		missing.push("no fallout verdict recorded (fallout watch must run against the named break-signal).");
	}
	if (evidence.migrationRequired && !migrationEvidenceComplete(evidence.migrationEvidence)) {
		missing.push(
			`migration gate triggered but evidence incomplete: missing stage(s) ${missingMigrationStages(evidence.migrationEvidence).join(", ")}.`,
		);
	}
	if (missing.length > 0) return { done: false, missing };
	return { done: true };
}
