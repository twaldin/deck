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
