import * as os from "node:os";

/**
 * Environment for a detached spawn that must OUTLIVE this seat.
 *
 * The seat's own environment is the right base: PATH, HOME, tool configs,
 * API keys, nvm/gcloud/kube state all flow to workers, which is load-bearing
 * (a hand-written allowlist kept losing tools; see the daemon PATH incident).
 *
 * What must NOT flow are the variables that mark this process tree as an
 * INTERNAL RESOURCE of the Prime daemon worker that spawned the seat:
 *
 * - PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL: prime code inside the child
 *   tree (engine seat daemons) self-registers its detached pids into the
 *   SEAT's journal; on the next worker recovery (TUI abort, /reload, session
 *   eviction) the daemon SIGKILLs every journaled process group. Observed
 *   live 14x as silent engine deaths correlated with abort/reload events.
 * - The remaining PRIME_AGENT_INTERNAL_* worker plumbing (supervisor socket,
 *   worker token, session leases): a child tree carrying these can be
 *   mistaken for — or interfere with — the daemon's own worker.
 * - HERDR_*: stale pane/workspace bindings killed pipeline orchestrators
 *   minutes after spawn (twaldin/deck#143).
 *
 * Keep this a DENYLIST of seat-internal control state, never an allowlist of
 * capabilities: capability loss is silent and total, controlled inheritance
 * is auditable here.
 */
export function detachedSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined) continue;
		if (key.startsWith("PRIME_AGENT_INTERNAL_")) continue;
		if (key.startsWith("HERDR_")) continue;
		env[key] = value;
	}
	return env;
}

/** True when the current environment carries daemon-worker-internal state. */
export function seatInternalEnvKeys(base: NodeJS.ProcessEnv = process.env): string[] {
	return Object.keys(base).filter(
		(key) => key.startsWith("PRIME_AGENT_INTERNAL_") || key.startsWith("HERDR_"),
	);
}
