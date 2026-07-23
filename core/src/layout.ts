/**
 * Deck runtime layout (SPEC §0). Code: ~/dev/deck. State: ~/.deck (0700).
 * This module is the single source of truth for state paths; the broker's
 * paths.ts predates it and is scheduled to consume this once the broker is
 * next touched (tracked in the phase ledger).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DECK_HOME = process.env.DECK_HOME ?? path.join(os.homedir(), ".deck");

export const EFFORTS_DIR = path.join(DECK_HOME, "efforts");
export const INTAKE_DIR = path.join(DECK_HOME, "intake");
export const SEEN_DIR = path.join(INTAKE_DIR, "seen");
export const BROKER_DIR = path.join(DECK_HOME, "broker");
export const CATALOG_DIR = path.join(DECK_HOME, "catalog");
export const RUN_DIR = path.join(DECK_HOME, "run");
export const WORKTREES_STATE = path.join(DECK_HOME, "worktrees.json");

export const ROUTER_SOCK = path.join(RUN_DIR, "router.sock");
export const BROKER_SOCK = path.join(RUN_DIR, "broker.sock");
export const CURSORS_FILE = path.join(INTAKE_DIR, "cursors.json");

/** Machine short-name for machine-qualified refs (I11). */
export const MACHINE = process.env.DECK_MACHINE ?? os.hostname().split(".")[0];

export function effortDir(effortId: string): string {
	return path.join(EFFORTS_DIR, effortId);
}

export const EFFORT_FILES = {
	manifest: "manifest.json",
	tail: "tail.jsonl",
	tailBad: "tail.bad",
	charter: "charter.json",
	lock: "manifest.lock",
	lease: "lease",
	inbox: "inbox.jsonl",
} as const;

export function ensureStateDirs(): void {
	for (const dir of [DECK_HOME, EFFORTS_DIR, INTAKE_DIR, SEEN_DIR, BROKER_DIR, CATALOG_DIR, RUN_DIR]) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.chmodSync(dir, 0o700);
	}
}
