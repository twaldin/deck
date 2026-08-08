import { describe, expect, test } from "bun:test";
import { detachedSpawnEnv, seatInternalEnvKeys } from "../src/spawn-env";

describe("detached spawn environment", () => {
	test("strips daemon-worker-internal and herdr state, keeps capability env", () => {
		const base = {
			PATH: "/usr/bin:/opt/homebrew/bin",
			HOME: "/Users/cap",
			GOOGLE_APPLICATION_CREDENTIALS: "/Users/cap/gcp.json",
			KUBECONFIG: "/Users/cap/.kube/config",
			ANTHROPIC_API_KEY: "sk-x",
			PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL: "/j/orphans.jsonl",
			PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: "tok",
			PRIME_AGENT_INTERNAL_SESSION_LEASES: "1",
			HERDR_WORKSPACE_ID: "stale",
			HERDR_PANE_ID: "stale",
			HERDR_CONFIG_PATH: "/Users/cap/.config/herdr/config.toml",
			PRIME_AGENT_SESSION_DIR: "/Users/cap/.deck/.prime/sessions",
		};
		const env = detachedSpawnEnv(base);
		expect(env.PATH).toBe(base.PATH);
		expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe(base.GOOGLE_APPLICATION_CREDENTIALS);
		expect(env.KUBECONFIG).toBe(base.KUBECONFIG);
		expect(env.ANTHROPIC_API_KEY).toBe(base.ANTHROPIC_API_KEY);
		// Non-internal prime vars survive (session dir is plain config, not worker identity).
		expect(env.PRIME_AGENT_SESSION_DIR).toBe(base.PRIME_AGENT_SESSION_DIR);
		expect(env.PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL).toBeUndefined();
		expect(env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN).toBeUndefined();
		expect(env.PRIME_AGENT_INTERNAL_SESSION_LEASES).toBeUndefined();
		expect(env.HERDR_WORKSPACE_ID).toBeUndefined();
		expect(env.HERDR_PANE_ID).toBeUndefined();
		// Config inputs are capabilities, not identity: they must survive.
		expect(env.HERDR_CONFIG_PATH).toBe(base.HERDR_CONFIG_PATH);
	});

	test("names the internal keys present in an environment", () => {
		expect(seatInternalEnvKeys({ PATH: "x", HERDR_TAB_ID: "y", HERDR_CONFIG_PATH: "keep", PRIME_AGENT_INTERNAL_Z: "z" }).sort())
			.toEqual(["HERDR_TAB_ID", "PRIME_AGENT_INTERNAL_Z"]);
		expect(seatInternalEnvKeys({ PATH: "x" })).toEqual([]);
	});
});
