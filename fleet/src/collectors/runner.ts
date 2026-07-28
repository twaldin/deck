import type { CommandRunner } from "./backlog";

/**
 * Default {@link CommandRunner}: spawns a subprocess read-only and captures
 * stdout. Returns null when the binary is missing (ENOENT) so collectors can
 * degrade gracefully. A per-call timeout guards against a hung CLI stalling
 * the refresh loop.
 */
export function makeSubprocessRunner(timeoutMs = 15_000, maxOutputBytes = 2 * 1024 * 1024): CommandRunner {
	return async (command, args, cwd, signal) => {
		try {
			const proc = Bun.spawn([command, ...args], {
				cwd,
				stdout: "pipe",
				// The collector never renders stderr. Ignoring it avoids an
				// unread pipe blocking a verbose child process.
				stderr: "ignore",
				stdin: "ignore",
				signal,
				timeout: timeoutMs,
				maxBuffer: maxOutputBytes,
			});
			const [buffer, exitCode] = await Promise.all([
				new Response(proc.stdout).arrayBuffer(),
				proc.exited,
			]);
			// Bun's maxBuffer kills the child at the boundary. Slice as a second
			// defensive bound so callers never retain more than the advertised
			// output budget even if runtime behavior changes.
			const bounded = buffer.byteLength > maxOutputBytes ? buffer.slice(0, maxOutputBytes) : buffer;
			const stdout = new TextDecoder().decode(bounded);
			return { stdout, exitCode };
		} catch {
			// ENOENT, timeout, abort, output cap, or spawn failure: collectors
			// surface the source as unavailable/degraded without crashing.
			return null;
		}
	};
}
