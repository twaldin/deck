import * as fs from "node:fs";
import * as path from "node:path";
import { deckV2Home } from "./home";

/** The single Smithers workspace used by every deck-v2 reader and spawner. */
export function smithersWorkspaceRoot(home = deckV2Home()): string {
	return path.resolve(smithersStateDirFor(home));
}

/** Resolve the durable, machine-local Smithers workspace. */
export function smithersStateDirFor(home = deckV2Home()): string {
	return path.join(home, "state", "smithers");
}

/** Parent directory from which Smithers must be invoked to use this workspace. */
export function smithersWorkspaceCwd(home = deckV2Home()): string {
	return smithersStateDirFor(home);
}

/**
 * Find Smithers state directories under the configured roots.
 *
 * This remains available to callers that need discovery. Deck-v2's live frame
 * uses the single shared workspace returned by smithersWorkspaceCwd().
 */
let discoveryCache: { key: string; expiresAt: number; workspaces: string[] } | undefined;
const DISCOVERY_CACHE_MS = 30_000;

export function discoverSmithersWorkspaces(home = deckV2Home()): string[] {
	const configured = process.env.DECK_SMITHERS_ROOTS?.split(path.delimiter)
		.map((root) => root.trim())
		.filter(Boolean);
	const roots = configured?.length ? configured : [home, process.env.DECK_REPO_ROOT ?? process.cwd()];
	const key = JSON.stringify([home, ...roots.map((root) => path.resolve(root))]);
	if (discoveryCache?.key === key && discoveryCache.expiresAt > Date.now()) {
		return [...discoveryCache.workspaces];
	}
	const found = new Set<string>();
	const visit = (directory: string, depth: number): void => {
		if (depth > 6) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
			const child = path.join(directory, entry.name);
			if (entry.name === ".smithers") {
				found.add(path.dirname(child));
				continue;
			}
			visit(child, depth + 1);
		}
	};
	for (const root of roots) visit(path.resolve(root), 0);
	found.add(smithersWorkspaceCwd(home));
	const workspaces = [...found].sort();
	discoveryCache = { key, expiresAt: Date.now() + DISCOVERY_CACHE_MS, workspaces };
	return [...workspaces];
}

/**
 * Send a warning through pi's UI when available. The fallback is stderr for
 * command-line callers. Keep this seam: the TUI revamp will define the
 * permanent notification surface here, so it can restyle one place.
 */
export function uiWarn(ctx: { ui?: { notify?: (message: string, type?: "warning") => void } } | undefined, message: string): void {
	if (typeof ctx?.ui?.notify === "function") {
		ctx.ui.notify(message, "warning");
		return;
	}
	process.stderr.write(`${message}\n`);
}

/** Report the old per-workflow workspace without deleting operator-owned runs. */
export function warnOnShadowWorkspace(
	home = deckV2Home(),
	log: (message: string) => void = (message) => uiWarn(undefined, message),
	warnedFingerprints = new Set<string>(),
): string[] {
	const shadow = path.join(home, "workflows", "pr-pipeline", ".smithers");
	const legacy = path.join(home, "workflows", ".smithers");
	const workspaces = [shadow, legacy].filter((workspace) => fs.existsSync(workspace));
	if (workspaces.length === 0) return [];
	const ids = workspaces.flatMap(shadowRunIds);
	if (ids.length > 0) {
		const fingerprint = `${workspaces.join("\0")}\0${ids.join("\0")}`;
		if (!warnedFingerprints.has(fingerprint)) {
			warnedFingerprints.add(fingerprint);
			log(`[deck-v2] WARNING: legacy Smithers workspace has orphaned runs: ${ids.join(", ")}. Workspaces: ${workspaces.join(", ")}. Finish or migrate them manually; nothing was deleted.`);
		}
	}
	return ids;
}

function shadowRunIds(workspace: string): string[] {
	try {
		const executions = path.join(workspace, "executions");
		return fs
			.readdirSync(executions, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.length > 0)
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}
