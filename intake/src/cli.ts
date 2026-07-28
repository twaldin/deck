import * as os from "node:os";
import * as path from "node:path";
import { GhCliClient } from "./github";
import { normalizePrUrl, poll } from "./poll";
import { formatChangeLine } from "./diff";
import { renderMarkdown } from "./render";
import { readIntakeState, readTrackedUrls, writeFileAtomic, writeIntakeState } from "./state";
import { unavailableLinearClient } from "./linear";

const USAGE = `deck-intake — durable PR/review intake poller

Usage:
  deck-intake --once [options]

Options:
  --once                Single poll: fetch, diff, write state+markdown, print diff, exit. (Required; no daemon mode exists — the fleet watcher owns cadence.)
  --login <login>       GitHub login to poll for (default: twaldin)
  --org <org>           Org scope, repeatable (default: lindy-ai)
  --include-user-repos  Also scope to the login's own repos (adds user:<login>)
  --state <file>        Durable JSON state file (default: ~/.deck/intake/intake-prs.json)
  --out <file>          Markdown output path (default: ~/.deck/intake/intake-prs.md)
  --tracked <file>      File of known/tracked PR URLs (one per line, # comments); anything unlisted is flagged
  --json                Emit the diff as JSON lines instead of tab-separated lines
  --linear              Enable the Linear section (STUB — fails until a Linear auth path is configured)
  --help                Show this help

Exit codes: 0 ok (diff may be empty), 1 usage error, 2 poll/IO failure.

Output contract (stdout, one line per change):
  tab-separated: <kind>\\t<url>\\t<detail...>
  kinds: new | REVIEW-REQUESTED | removed | ci | review-decision | reviewers | buckets | untracked
  REVIEW-REQUESTED replaces the kind on new/reviewers/buckets lines when the
  polled login was newly asked for review — the high-signal wake condition.
  removed lines carry a resolution: merged | landed-squash | closed-without-landing | descoped | vanished
  (landed-squash = Graphite trap resolved: closed+unmerged but the squash
  commit "(#N)" exists on the default branch).
  --json: same changes as JSON objects, one per line (schema: src/schema.ts diffChangeSchema).`;

interface CliOptions {
	login: string;
	orgs: string[];
	includeUserRepos: boolean;
	stateFile: string;
	outFile: string;
	trackedFile: string | null;
	json: boolean;
	linear: boolean;
}

function parseArguments(argv: string[]): CliOptions | "help" {
	const defaults: CliOptions = {
		login: "twaldin",
		orgs: [],
		includeUserRepos: false,
		stateFile: path.join(os.homedir(), ".deck", "intake", "intake-prs.json"),
		outFile: path.join(os.homedir(), ".deck", "intake", "intake-prs.md"),
		trackedFile: null,
		json: false,
		linear: false,
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
	if (!once) {
		throw new Error("--once is required (this tool has no daemon mode; the fleet watcher owns cadence)");
	}
	if (defaults.orgs.length === 0) {
		defaults.orgs.push("lindy-ai");
	}
	return defaults;
}

export async function runCli(argv: string[]): Promise<number> {
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

		const scopes = options.orgs.map((org) => `org:${org}`);
		if (options.includeUserRepos) {
			scopes.push(`user:${options.login}`);
		}

		const tracked =
			options.trackedFile === null ? null : readTrackedUrls(options.trackedFile, normalizePrUrl);

		const previous = readIntakeState(options.stateFile);
		const client = new GhCliClient();
		const result = await poll(previous, { login: options.login, scopes, tracked }, client);

		writeIntakeState(options.stateFile, result.state);
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

		const allChanges = [...result.changes, ...result.untracked];
		for (const change of allChanges) {
			console.log(options.json ? JSON.stringify(change) : formatChangeLine(change));
		}
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
}
