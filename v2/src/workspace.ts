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
				// Store one physical workspace per state directory. The live
				// ~/.deck/workflows tree is commonly a symlink to this location.
				try {
					found.add(fs.realpathSync(path.dirname(child)));
				} catch {
					found.add(path.resolve(path.dirname(child)));
				}
				continue;
			}
			visit(child, depth + 1);
		}
	};
	for (const root of roots) visit(path.resolve(root), 0);
	try {
		found.add(fs.realpathSync(smithersWorkspaceCwd(home)));
	} catch {
		found.add(path.resolve(smithersWorkspaceCwd(home)));
	}
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

/**
 * Report old per-workflow state without warning for the canonical workspace.
 * Smithers may expose the same directory through ~/.deck/workflows symlinks.
 */
export function warnOnShadowWorkspace(
	home = deckV2Home(),
	log: (message: string) => void = (message) => uiWarn(undefined, message),
	warnedFingerprints = new Set<string>(),
): string[] {
	const canonical = (() => {
		try {
			return fs.realpathSync(smithersWorkspaceRoot(home));
		} catch {
			return path.resolve(smithersWorkspaceRoot(home));
		}
	})();
	const candidates = [
		path.join(home, "workflows", "pr-pipeline", ".smithers"),
		path.join(home, "workflows", ".smithers"),
	];
	const workspaces = candidates.filter((workspace) => {
		if (!fs.existsSync(workspace)) return false;
		try {
			return fs.realpathSync(workspace) !== canonical;
		} catch {
			return false;
		}
	});
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

function isTerminalExecution(executions: string, id: string): boolean {
	// Smithers 0.30 stores the authoritative terminal transition in the
	// append-only stream. State files are optional and are not present in many
	// real execution directories.
	const runDir = path.join(executions, id);
	const stream = path.join(runDir, "logs", "stream.ndjson");
	try {
		const lines = fs.readFileSync(stream, "utf8").split("\n").filter(Boolean);
		for (const line of lines.reverse()) {
			const event = JSON.parse(line) as Record<string, unknown>;
			// Only the envelope's event name and status are authoritative. Do not
			// search payload text: a review body can contain "RunFailed".
			const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : undefined;
			const frame = event.frame && typeof event.frame === "object" ? event.frame as Record<string, unknown> : undefined;
			const framePayload = frame?.payload && typeof frame.payload === "object" ? frame.payload as Record<string, unknown> : undefined;
			const kind = [event.type, event.event, event.kind, event.name, payload?.type, frame?.event, framePayload?.type].find((value) => typeof value === "string");
			const status = [event.status, payload?.status, frame?.status, framePayload?.status].find((value) => typeof value === "string");
			if (typeof status === "string" && /^(completed|succeeded|failed|cancelled|finished)$/i.test(status)) return true;
			if (typeof kind === "string" && /^(?:run[._-])?(completed|succeeded|failed|cancelled|finished)$/i.test(kind)) return true;
			if (typeof kind === "string" && /^(?:run[._-])?(started|resumed|paused)$/i.test(kind)) break;
		}
	} catch {
		// Fall through to optional state files.
	}
	for (const name of ["run.json", "state.json", "status.json"]) {
		try {
			const value: unknown = JSON.parse(fs.readFileSync(path.join(runDir, name), "utf8"));
			const status = value && typeof value === "object" ? (value as { status?: unknown; state?: unknown }).status ?? (value as { state?: unknown }).state : undefined;
			if (typeof status === "string" && /^(completed|failed|cancelled|succeeded|finished)$/i.test(status)) return true;
		} catch {
			// Missing or malformed canonical state means the run is still worth warning about.
		}
	}
	return false;
}

function shadowRunIds(workspace: string): string[] {
	try {
		const executions = path.join(workspace, "executions");
		return fs
			.readdirSync(executions, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.length > 0 && !isTerminalExecution(executions, entry.name))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}
