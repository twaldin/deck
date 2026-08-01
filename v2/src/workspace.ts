import * as fs from "node:fs";
import * as path from "node:path";
import { deckV2Home } from "./home";

/** The single Smithers workspace used by every deck-v2 reader and spawner. */
export function smithersWorkspaceRoot(home = deckV2Home()): string {
	return path.resolve(home, "workflows", ".smithers");
}

/** Parent directory from which Smithers must be invoked to use this workspace. */
export function smithersWorkspaceCwd(home = deckV2Home()): string {
	return path.dirname(smithersWorkspaceRoot(home));
}

/**
 * Find every Smithers state directory used by this deck installation. The
 * search roots are deliberately configurable so the home-sync layout can
 * replace the repository scan without changing the observer.
 */
let discoveryCache: { key: string; expiresAt: number; workspaces: string[] } | undefined;
const DISCOVERY_CACHE_MS = 30_000;

export function discoverSmithersWorkspaces(home = deckV2Home()): string[] {
	const configured = process.env.DECK_SMITHERS_ROOTS?.split(path.delimiter)
		.map((root) => root.trim()).filter(Boolean);
	const roots = configured?.length
		? configured
		: [home, process.env.DECK_REPO_ROOT ?? process.cwd()];
	const key = JSON.stringify([home, ...roots.map((root) => path.resolve(root))]);
	if (discoveryCache?.key === key && discoveryCache.expiresAt > Date.now()) {
		return [...discoveryCache.workspaces];
	}
	const found = new Set<string>();
	const visit = (directory: string, depth: number): void => {
		if (depth > 6) return;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
			const child = path.join(directory, entry.name);
			if (entry.name === ".smithers") { found.add(path.dirname(child)); continue; }
			visit(child, depth + 1);
		}
	};
	for (const root of roots) visit(path.resolve(root), 0);
	found.add(smithersWorkspaceCwd(home));
	const workspaces = [...found].sort();
	discoveryCache = { key, expiresAt: Date.now() + DISCOVERY_CACHE_MS, workspaces };
	return [...workspaces];
}

/** Report the old per-workflow workspace without deleting operator-owned runs. */
export function warnOnShadowWorkspace(home = deckV2Home(), log = console.warn): string[] {
	const shadow = path.join(home, "workflows", "pr-pipeline", ".smithers");
	if (!fs.existsSync(shadow)) return [];
	const ids = shadowRunIds(shadow);
	if (ids.length > 0) {
		log(`[deck-v2] WARNING: shadow Smithers workspace has orphaned runs: ${ids.join(", ")}. Workspace: ${shadow}. Finish or migrate them manually; nothing was deleted.`);
	}
	return ids;
}

function shadowRunIds(workspace: string): string[] {
	try {
		const executions = path.join(workspace, "executions");
		return fs
			.readdirSync(executions, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.length > 0)
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}
