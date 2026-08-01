/**
 * Thin adapter over deck's project profiles (v2/src/projects.ts).
 *
 * The pipeline accepts input.profile (a profile id or repo name, e.g. "lindy"
 * or "lindy-ai/lindy") and reads yolo/stamp from the resolved profile instead
 * of forking the workflow per project. The profile module is dependency-free
 * (node builtins only), so re-exporting it keeps lib/'s contract: unit-testable
 * without smithers, zod, or network access.
 */
export {
	findProfile,
	loadProfiles,
	mergeHint,
	profilesFile,
	seedProfiles,
	validateProfiles,
	type PipelineId,
	type ProjectProfile,
	type ModelSeat,
} from "../../../v2/src/projects.ts";
