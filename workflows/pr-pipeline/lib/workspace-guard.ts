import * as os from "node:os";
import * as path from "node:path";

import type { ProjectProfile } from "./profiles.ts";

export const DEV_WORKSPACE_OVERRIDE = "DECK_DEV_WORKSPACE_OK";

export type ProductWorkspaceAssertion = {
	repo: string;
	profile: ProjectProfile | null;
	dryRun: boolean;
	workspaceRoot: string;
	home?: string;
	devWorkspaceAllowed?: boolean;
};

export function isProductRepo(repo: string, profile: ProjectProfile | null): boolean {
	const inputRepoName = repo.trim().toLowerCase().replace(/\.git$/, "").split("/").at(-1);
	const profileRepoName = profile?.repo.trim().toLowerCase().replace(/\.git$/, "").split("/").at(-1);
	return (
		inputRepoName === "lindy" ||
		profile?.id.toLowerCase() === "lindy" ||
		profileRepoName === "lindy" ||
		profile?.production === true
	);
}

export function canonicalProductWorkspace(home = process.env.HOME ?? os.homedir()): string {
	return path.resolve(home, ".deck", "state", "smithers");
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/**
 * Return the stable refusal text without throwing so workflow rendering can
 * suppress every preflight side effect before the first task reports it.
 */
export function productWorkspaceViolation({
	repo,
	profile,
	dryRun,
	workspaceRoot,
	home,
	devWorkspaceAllowed = process.env[DEV_WORKSPACE_OVERRIDE] === "1",
}: ProductWorkspaceAssertion): string | null {
	if (dryRun || devWorkspaceAllowed || !isProductRepo(repo, profile)) return null;

	const actual = path.resolve(workspaceRoot);
	const canonical = canonicalProductWorkspace(home);
	if (isWithin(canonical, actual)) return null;

	return (
		`PRODUCT WORKSPACE REFUSED: repo "${repo}" must run under the canonical Smithers workspace "${canonical}", ` +
		`but this run started from "${actual}". Use deck ship/adopt/status for product work. ` +
		`Set ${DEV_WORKSPACE_OVERRIDE}=1 only for deliberate workflow development, or use dryRun=true.`
	);
}

export function assertProductWorkspace(assertion: ProductWorkspaceAssertion): void {
	const violation = productWorkspaceViolation(assertion);
	if (violation !== null) throw new Error(violation);
}
