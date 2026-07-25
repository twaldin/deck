#!/usr/bin/env bun
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
import {
	deriveSessionFindings,
	indexFromStore,
	loadSessionStore,
	saveSessionStore,
	updateSessionStore,
	type SessionRoots,
} from "./sessions.ts";

const CliOptionsSchema = z.object({
	json: z.boolean(),
	fmHome: z.string().min(1).optional(),
	watchSeconds: z.number().int().positive().optional(),
	outDir: z.string().min(1).optional(),
	noSessions: z.boolean(),
});

const MAX_CONCURRENT_POLLS = 4;
const SESSIONS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface ShadowDependencies {
	run?: CommandRunner;
	stdout?: (value: string) => void;
	stderr?: (value: string) => void;
	now?: () => number;
	sessionRoots?: SessionRoots;
	/** Where the persisted session cursor/token store lives. */
	sessionStorePath?: string;
}

function parseArgs(args: readonly string[], issues: ShadowIssue[]): z.infer<typeof CliOptionsSchema> {
	const parsedArgs = z.array(z.string()).safeParse(args);
	if (!parsedArgs.success) {
		issues.push({ source: "arguments", message: parsedArgs.error.message });
		return CliOptionsSchema.parse({ json: false });
	}
	let json = false;
	let fmHome: string | undefined;
	let watchSeconds: number | undefined;
	let outDir: string | undefined;
	let noSessions = false;
	const takeValue = (flag: string, index: number): string | undefined => {
		const value = parsedArgs.data[index + 1];
		if (value === undefined || value.startsWith("--") || value.trim() === "") {
			issues.push({ source: "arguments", message: `${flag} requires a value` });
			return undefined;
		}
		return value;
	};
	for (let index = 0; index < parsedArgs.data.length; index += 1) {
		const argument = parsedArgs.data[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument === "--no-sessions") {
			noSessions = true;
			continue;
		}
		if (argument === "--fm-home") {
			const value = takeValue("--fm-home", index);
			if (value !== undefined) {
				fmHome = value;
				index += 1;
			}
			continue;
		}
		if (argument === "--out") {
			const value = takeValue("--out", index);
			if (value !== undefined) {
				outDir = value;
				index += 1;
			}
			continue;
		}
		if (argument === "--watch") {
			const value = takeValue("--watch", index);
			if (value !== undefined) {
				const seconds = Number.parseInt(value, 10);
				if (Number.isInteger(seconds) && seconds > 0) {
					watchSeconds = seconds;
				} else {
					issues.push({ source: "arguments", message: "--watch requires a positive integer of seconds" });
				}
				index += 1;
			}
			continue;
		}
		issues.push({ source: "arguments", message: `unknown argument: ${argument}` });
	}
	return CliOptionsSchema.parse({ json, fmHome, watchSeconds, outDir, noSessions });
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

	let sessions = { scannedFiles: 0, windowMs: 0, findings: [] as ReturnType<typeof deriveSessionFindings> };
	if (!options.noSessions) {
		const storePath =
			dependencies.sessionStorePath ??
			join(options.outDir ?? join(homedir(), ".deck", "shadow"), "session-index.json");
		const store = loadSessionStore(storePath, issues);
		updateSessionStore(store, issues, {
			roots: dependencies.sessionRoots,
			windowMs: SESSIONS_WINDOW_MS,
			nowMs,
			fmHome,
			// deck repo root = parent of this shadow package
			deckHome: join(import.meta.dir, "..", ".."),
		});
		const index = indexFromStore(store);
		const statusMtimeByEffort = new Map(
			[...activityByEffort].map(([effortId, activity]) => [effortId, activity.statusMtimeMs]),
		);
		const derived = deriveSessionFindings(watchSet, statusMtimeByEffort, factsByUrl, index, { nowMs });
		// Resolve untracked-PR candidates against GitHub: only an OPEN PR is
		// "work in flight off the books". Terminal PRs (merged/landed/closed)
		// are cached in the store and never re-polled or reported.
		const terminal = new Set(store.terminalPrUrls);
		const findings: typeof derived = [];
		for (const finding of derived) {
			if (finding.kind !== "untracked_pr") {
				findings.push(finding);
				continue;
			}
			const url = finding.detail.split(" ")[0] ?? "";
			if (terminal.has(url)) {
				continue;
			}
			const fact = factsByUrl.get(url) ?? (await pollPr(url, dependencies.run, issues));
			if (fact === null) {
				findings.push(finding); // poll failed: keep the finding, honest uncertainty
				continue;
			}
			if (fact.landed || fact.state.toUpperCase() !== "OPEN") {
				terminal.add(url);
				continue;
			}
			findings.push(finding);
		}
		store.terminalPrUrls = [...terminal];
		saveSessionStore(storePath, store, issues);
		sessions = {
			scannedFiles: index.scannedFiles,
			windowMs: SESSIONS_WINDOW_MS,
			findings,
		};
	}

	const report = buildDivergenceReport(watchSet, factsByUrl, activityByEffort, liveness, {
		nowMs,
		sessions,
	});

	const stdout = dependencies.stdout ?? ((value: string) => console.log(value));
	const stderr = dependencies.stderr ?? ((value: string) => console.error(value));
	stdout(options.json ? JSON.stringify(report, null, 2) : formatHumanReport(report));
	for (const issue of issues) {
		stderr(`[deck-shadow] ${issue.source}: ${issue.message}`);
	}
	return report;
}

/** One compact JSONL record per watch tick - the accumulating divergence trail. */
function tickRecord(report: DivergenceReport): string {
	return JSON.stringify({
		ts: new Date(report.generatedAtMs).toISOString(),
		coverage: report.coverage,
		flagged: report.efforts
			.filter((effort) => effort.flagged)
			.map((effort) => ({ effortId: effort.effortId, reason: effort.flagReason })),
		watcherStall: report.watcherStall === null ? null : { ageSinceLatestMs: report.watcherStall.ageSinceLatestMs },
		sessionFindings: report.sessions.findings,
	});
}

async function runWatch(args: readonly string[], watchSeconds: number, outDir: string): Promise<void> {
	mkdirSync(outDir, { recursive: true, mode: 0o700 });
	const passArgs = args.filter((argument, index, all) => {
		if (argument === "--watch") return false;
		if (index > 0 && all[index - 1] === "--watch") return false;
		return true;
	});
	console.log(`[deck-shadow] watch mode: every ${watchSeconds}s -> ${outDir}`);
	for (;;) {
		try {
			const lines: string[] = [];
			const report = await runShadow(passArgs, {
				stdout: (value) => lines.push(value),
				stderr: (value) => lines.push(value),
			});
			writeFileSync(join(outDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
			writeFileSync(join(outDir, "latest.txt"), `${formatHumanReport(report)}\n`, { mode: 0o600 });
			appendFileSync(join(outDir, "divergences.jsonl"), `${tickRecord(report)}\n`, { mode: 0o600 });
			const flaggedCount = report.efforts.filter((effort) => effort.flagged).length;
			console.log(
				`[deck-shadow] ${new Date(report.generatedAtMs).toISOString()} tick: ${report.coverage.totalEfforts} efforts, ${report.coverage.resolvedPrs}/${report.coverage.totalPrs} PRs, ${flaggedCount} flagged, ${report.sessions.findings.length} session findings${report.watcherStall !== null ? ", WATCHER STALL" : ""}`,
			);
		} catch (error) {
			console.error(
				`[deck-shadow] watch tick failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		await Bun.sleep(watchSeconds * 1000);
	}
}

export async function main(args = Bun.argv.slice(2)): Promise<void> {
	const probeIssues: ShadowIssue[] = [];
	const options = parseArgs(args, probeIssues);
	if (options.watchSeconds !== undefined) {
		const outDir = options.outDir ?? join(homedir(), ".deck", "shadow");
		await runWatch(args, options.watchSeconds, outDir);
		return;
	}
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
