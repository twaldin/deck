import type { ExecFn, ExecResult } from "./gh.ts";

export type MergePath = "graphite" | "gh-fallback";

export type MergeFailure = Error & { mergeResult?: ExecResult };

function isGraphiteUnavailable(result: ExecResult): boolean {
	return (
		result.code === 127 ||
		/command not found/i.test(`${result.stdout}\n${result.stderr}`) ||
		/\bCannot perform this operation on untracked branch\b/i.test(
			`${result.stdout}\n${result.stderr}`,
		)
	);
}

/** Run Graphite merge, falling back only when Graphite cannot operate here. */
export async function runMergeWithFallback(options: {
	runGraphite: () => Promise<ExecResult>;
	exec: ExecFn;
	gh: string;
	prNumber: number;
	cwd: string;
	fallbackArgs: string[];
}): Promise<{ path: MergePath; output: string }> {
	const graphite = await options.runGraphite();
	if (graphite.code === 0) {
		return { path: "graphite", output: graphite.stdout };
	}
	if (!isGraphiteUnavailable(graphite)) {
		throw new Error(
			`Graphite merge failed (${graphite.code}): ${graphite.stderr.slice(0, 2000)}`,
		);
	}

	const ghArgs = ["pr", "merge", String(options.prNumber), ...options.fallbackArgs];
	const fallback = await options.exec([options.gh, ...ghArgs], { cwd: options.cwd });
	if (fallback.code !== 0) {
		throw new Error(
			`Graphite merge failed (${graphite.code}): ${graphite.stderr.slice(0, 2000)}\n` +
				`gh fallback failed (${fallback.code}): ${fallback.stderr.slice(0, 2000)}`,
		);
	}
	return { path: "gh-fallback", output: fallback.stdout };
}
