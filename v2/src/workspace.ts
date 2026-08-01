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
	if (!fs.existsSync(shadow)) return [];
	const ids = shadowRunIds(shadow);
	if (ids.length > 0) {
		const fingerprint = `${shadow}\0${ids.join("\0")}`;
		if (!warnedFingerprints.has(fingerprint)) {
			warnedFingerprints.add(fingerprint);
			log(`[deck-v2] WARNING: shadow Smithers workspace has orphaned runs: ${ids.join(", ")}. Workspace: ${shadow}. Finish or migrate them manually; nothing was deleted.`);
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
