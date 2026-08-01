import * as path from "node:path";
import {
	appendIntakeEvents,
	buildIntakeEvents,
	correlate,
	deckHome,
	intakeEventsFile,
	readTaskRefs,
} from "./deck";
import { formatChangeLine } from "./diff";
import { GhCliClient } from "./github";
import { unavailableLinearClient } from "./linear";
import { normalizePrUrl, poll } from "./poll";
import { renderMarkdown } from "./render";
import { readIntakeState, readTrackedUrls, writeFileAtomic, writeIntakeState } from "./state";

const USAGE = `deck-intake — durable PR/review intake poller

Usage:
  deck-intake --once [options]       single poll: fetch, diff, write, print, exit
  deck-intake --loop <seconds> [options]   long-lived poller (same poll on a fixed cadence)
  deck-intake ls [--state <file>] [--json]  list intake records with correlated task ids

Options:
  --login <login>       GitHub login to poll for (default: twaldin)
  --org <org>           Org scope, repeatable (default: lindy-ai)
  --include-user-repos  Also scope to the login's own repos (adds user:<login>)
  --state <file>        Durable JSON state file (default: $DECK_V2_HOME/intake/intake-prs.json)
  --out <file>          Markdown output path (default: $DECK_V2_HOME/intake/intake-prs.md)
  --events <file>       Durable event log, JSONL (default: $DECK_V2_HOME/intake/events.jsonl)
  --tracked <file>      File of known/tracked PR URLs (one per line, # comments); anything unlisted is flagged
  --json                Emit the diff as JSON lines instead of tab-separated lines
  --linear              Enable the Linear section (STUB — fails until a Linear auth path is configured)
  --help                Show this help

DECK_V2_HOME defaults to ~/.deck (the same home deck-v2 uses).

Exit codes: 0 ok (diff may be empty), 1 usage error, 2 poll/IO failure.

Output contract (stdout, one line per change):
  tab-separated: <kind>\\t<signal>\\t<url>\\t<detail...>
  kinds: new | removed | ci | review-decision | reviewers | buckets | untracked
  signal: REVIEW-REQUESTED when the polled login was newly asked for review
  (the high-signal wake condition), else "-".
  removed lines carry a resolution: merged | landed-squash | closed-without-landing | descoped | vanished
  (landed-squash = landing check resolved: the squash commit "(#N)" exists on the default
  branch).
  --json: same changes as JSON objects, one per line (schema: src/schema.ts diffChangeSchema).

Every non-untracked change is also appended to the event log with a correlated
deck task id when the PR's URL or head branch matches a task's .meta record.
deck-v2's wake reconcile consumes that log and wakes parked efforts.`;

interface CliOptions {
	login: string;
	orgs: string[];
	includeUserRepos: boolean;
	stateFile: string;
	outFile: string;
	eventsFile: string;
	trackedFile: string | null;
	json: boolean;
	linear: boolean;
	/** null = --once; a number = poll forever on this cadence (seconds). */
	loopSeconds: number | null;
}

function parseArguments(argv: string[]): CliOptions | "help" {
	const defaults: CliOptions = {
		login: "twaldin",
		orgs: [],
		includeUserRepos: false,
		stateFile: path.join(deckHome(), "intake", "intake-prs.json"),
		outFile: path.join(deckHome(), "intake", "intake-prs.md"),
		eventsFile: intakeEventsFile(),
		trackedFile: null,
		json: false,
		linear: false,
		loopSeconds: null,
	};
	let once = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		const next = (): string => {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new Error(`${argument} requires a value`);
			}
			index += 1;
			return value;
		};
		switch (argument) {
			case "--help":
			case "-h":
				return "help";
			case "--once":
				once = true;
				break;
			case "--loop": {
				const seconds = Number.parseInt(next(), 10);
				if (!Number.isInteger(seconds) || seconds < 10) {
					throw new Error("--loop takes a cadence in seconds (>= 10)");
				}
				defaults.loopSeconds = seconds;
				break;
			}
			case "--login":
				defaults.login = next();
				break;
			case "--org":
				defaults.orgs.push(next());
				break;
			case "--include-user-repos":
				defaults.includeUserRepos = true;
				break;
			case "--state":
				defaults.stateFile = path.resolve(next());
				break;
			case "--out":
				defaults.outFile = path.resolve(next());
				break;
			case "--events":
				defaults.eventsFile = path.resolve(next());
				break;
			case "--tracked":
				defaults.trackedFile = path.resolve(next());
				break;
			case "--json":
				defaults.json = true;
				break;
			case "--linear":
				defaults.linear = true;
				break;
			default:
				throw new Error(`unknown option: ${argument}`);
		}
	}
	if (!once && defaults.loopSeconds === null) {
		throw new Error("--once or --loop <seconds> is required");
	}
	if (once && defaults.loopSeconds !== null) {
		throw new Error("--once and --loop are mutually exclusive");
	}
	if (defaults.orgs.length === 0) {
		defaults.orgs.push("lindy-ai");
	}
	return defaults;
}

/** One poll: fetch, diff, append events, write markdown, advance state. */
async function pollOnce(options: CliOptions): Promise<void> {
	const scopes = options.orgs.map((org) => `org:${org}`);
	if (options.includeUserRepos) {
		scopes.push(`user:${options.login}`);
	}

	const tracked =
		options.trackedFile === null ? null : readTrackedUrls(options.trackedFile, normalizePrUrl);

	const previous = readIntakeState(options.stateFile);
	const client = new GhCliClient();
	const result = await poll(previous, { login: options.login, scopes, tracked }, client);

	// Emit outputs BEFORE advancing state: if the event append, markdown write
	// or stdout fails, the state file stays put and the next run re-detects the
	// same diff — a change is never silently consumed. (The converse crash
	// window means at-least-once event delivery; the consumer tolerates it.)
	const allChanges = [...result.changes, ...result.untracked];
	for (const change of allChanges) {
		console.log(options.json ? JSON.stringify(change) : formatChangeLine(change));
	}
	appendIntakeEvents(
		options.eventsFile,
		buildIntakeEvents(result.changes, result.state, previous, readTaskRefs()),
	);
	writeFileAtomic(
		options.outFile,
		renderMarkdown({
			state: result.state,
			login: options.login,
			tracked,
			untracked: result.untracked,
			newReviewRequests: result.newReviewRequests,
			linear: null,
		}),
	);
	writeIntakeState(options.stateFile, result.state);
}

/** List intake records: one line per known PR, with its correlated task id. */
function runLs(argv: string[]): number {
	let stateFile = path.join(deckHome(), "intake", "intake-prs.json");
	let json = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--json") json = true;
		else if (argument === "--state") {
			const value = argv[index + 1];
			if (value === undefined) throw new Error("--state requires a value");
			stateFile = path.resolve(value);
			index += 1;
		} else throw new Error(`unknown option: ${argument}`);
	}
	const state = readIntakeState(stateFile);
	const refs = readTaskRefs();
	for (const item of Object.values(state.items)) {
		const taskId = correlate(item, refs);
		if (json) {
			console.log(JSON.stringify({ ...item, taskId }));
		} else {
			console.log(
				`${taskId ?? "-"}\t${item.buckets.join(",")}\t${item.ci}\t${item.reviewDecision}\t${item.url}\t${item.title}`,
			);
		}
	}
	return 0;
}

export async function runCli(argv: string[]): Promise<number> {
	if (argv[0] === "ls") {
		try {
			return runLs(argv.slice(1));
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			return 1;
		}
	}

	let options: CliOptions | "help";
	try {
		options = parseArguments(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.error(USAGE);
		return 1;
	}
	if (options === "help") {
		console.log(USAGE);
		return 0;
	}

	try {
		if (options.linear) {
			// STUB: fails loudly by design — no verified Linear auth path yet.
			unavailableLinearClient().assignedTickets(options.login);
		}

		if (options.loopSeconds === null) {
			await pollOnce(options);
			return 0;
		}
		// Long-lived mode: durable state + events make a restart safe at any
		// point, so a crash-looped supervisor (process tool, launchd) is fine.
		for (;;) {
			try {
				await pollOnce(options);
			} catch (error) {
				// A transient poll failure (rate limit, network) must not kill the
				// poller; state did not advance, so nothing is lost.
				console.error(error instanceof Error ? error.message : String(error));
			}
			await new Promise((resolve) => setTimeout(resolve, options.loopSeconds! * 1000));
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
}
