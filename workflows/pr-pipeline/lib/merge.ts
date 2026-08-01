import type { ExecFn, ExecResult } from "./gh.ts";

export type MergePath = "github-merge-queue";

/** Enqueue a pull request through GitHub's native merge queue. */
export async function runMerge(options: {
	exec: ExecFn;
	gh: string;
	prNumber: number;
	cwd: string;
	args: string[];
}): Promise<{ path: MergePath; output: string }> {
	const result = await options.exec(
		[options.gh, "pr", "merge", String(options.prNumber), ...options.args],
		{ cwd: options.cwd },
	);
	if (result.code !== 0) {
		throw new Error(`GitHub merge queue submission failed (${result.code}): ${result.stderr.slice(0, 2000)}`);
	}
	return { path: "github-merge-queue", output: result.stdout };
}
