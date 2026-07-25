#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import {
	parseWatchSet,
	readEffortActivity,
	readWatcherLiveness,
	type ShadowIssue,
} from "./firstmate.ts";
import { pollPr, type CommandRunner, type PrFact } from "./poll.ts";
import {
	buildDivergenceReport,
	formatHumanReport,
	type DivergenceReport,
} from "./report.ts";

const CliOptionsSchema = z.object({
	json: z.boolean(),
	fmHome: z.string().min(1).optional(),
});

const MAX_CONCURRENT_POLLS = 4;

export interface ShadowDependencies {
	run?: CommandRunner;
	stdout?: (value: string) => void;
	stderr?: (value: string) => void;
	now?: () => number;
}

function parseArgs(args: readonly string[], issues: ShadowIssue[]): z.infer<typeof CliOptionsSchema> {
	const parsedArgs = z.array(z.string()).safeParse(args);
	if (!parsedArgs.success) {
		issues.push({ source: "arguments", message: parsedArgs.error.message });
		return CliOptionsSchema.parse({ json: false });
	}
	let json = false;
	let fmHome: string | undefined;
	for (let index = 0; index < parsedArgs.data.length; index += 1) {
		const argument = parsedArgs.data[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument === "--fm-home") {
			const value = parsedArgs.data[index + 1];
			if (value === undefined || value.startsWith("--")) {
				issues.push({ source: "arguments", message: "--fm-home requires a path" });
				continue;
			}
			if (value.trim() === "") {
				issues.push({ source: "arguments", message: "--fm-home path cannot be empty" });
				index += 1;
				continue;
			}
			fmHome = value;
			index += 1;
			continue;
		}
		issues.push({ source: "arguments", message: `unknown argument: ${argument}` });
	}
	return CliOptionsSchema.parse({ json, fmHome });
}


export async function runShadow(
	args: readonly string[],
	dependencies: ShadowDependencies = {},
): Promise<DivergenceReport> {
	const issues: ShadowIssue[] = [];
	const options = parseArgs(args, issues);
	const fmHome = options.fmHome ?? join(homedir(), "firstmate");
	const watchSet = parseWatchSet(fmHome, issues);
	const uniquePrUrls = [...new Set(watchSet.flatMap((effort) => effort.prUrls))];
	const factsByUrl = new Map<string, PrFact | null>();
	for (let offset = 0; offset < uniquePrUrls.length; offset += MAX_CONCURRENT_POLLS) {
		const batch = uniquePrUrls.slice(offset, offset + MAX_CONCURRENT_POLLS);
		await Promise.all(
			batch.map(async (url) => {
				factsByUrl.set(url, await pollPr(url, dependencies.run, issues));
			}),
		);
	}
	const activityByEffort = new Map(
		watchSet.map((effort) => [
			effort.effortId,
			readEffortActivity(fmHome, effort.effortId, issues),
		]),
	);
	const nowMs = dependencies.now?.() ?? Date.now();
	const liveness = readWatcherLiveness(fmHome, issues, nowMs);
	const report = buildDivergenceReport(watchSet, factsByUrl, activityByEffort, liveness, {
		nowMs,
	});

	const stdout = dependencies.stdout ?? ((value: string) => console.log(value));
	const stderr = dependencies.stderr ?? ((value: string) => console.error(value));
	stdout(options.json ? JSON.stringify(report, null, 2) : formatHumanReport(report));
	for (const issue of issues) {
		stderr(`[deck-shadow] ${issue.source}: ${issue.message}`);
	}
	return report;
}

export async function main(args = Bun.argv.slice(2)): Promise<void> {
	try {
		await runShadow(args);
	} catch (error) {
		console.error(
			`[deck-shadow] unexpected observer error: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		process.exitCode = 0;
	}
}

if (import.meta.main) {
	await main();
}
