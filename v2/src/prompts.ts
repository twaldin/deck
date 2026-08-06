/**
 * Standing doctrine shared by Smithers seats. Worker-spawn briefs were retired
 * with the fire-and-forget v2 spawn path; Prime owns native RLM child prompting
 * and the PR pipeline owns its seat-specific contracts.
 */
import * as path from "node:path";
import { dataDir } from "./home";
import { findProfile, mergeHint } from "./projects";
/**
 * Standing doctrine for workflow seats, driven by the project's PROFILE
 * (config/projects.json): knowledge paths, project doctrine (e.g. the frozen
 * lindy traps), and the merge posture derived from yolo/stamp. Progressive
 * disclosure keeps this to paths and one-liners, never full pack contents.
 */
export function buildStandingDoctrine(project?: string): string {
	const data = dataDir();
	const distill = path.join(data, "ref", "distill");
	const profile = project === undefined ? null : findProfile(project);
	const workerMemoryContract =
		"Never run OptMem from a workflow seat or RLM child. Route decisions through the workflow's question result.";
	if (profile !== null && (profile.knowledge.length > 0 || profile.doctrine !== undefined)) {
		const parts = [
			`## Standing doctrine (${profile.id})`,
			`Read before you touch prod, a PR, or the tracker. Full doctrine (absolute paths):`,
			profile.knowledge.map((file) => `- ${file}`).join("\n"),
		];
		if (profile.doctrine !== undefined) parts.push(profile.doctrine);
		parts.push(`- ${mergeHint(profile)}`);
		return `${parts.filter((part) => part.length > 0).join("\n\n")}\n\n${workerMemoryContract}`;
	}
	const thin = `## Standing doctrine

Distilled project rules (absolute paths, open when the topic goes deep):

- ${path.join(distill, "STANDING-RULES.md")}
- ${path.join(data, "secrets-map.md")} (credential locations, names only — never values)`;
	// A profile with no knowledge pack still carries its merge posture.
	const doctrine = profile === null ? thin : `${thin}\n\n- ${mergeHint(profile)}`;
	return `${doctrine}\n\n${workerMemoryContract}`;
}

