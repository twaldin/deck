import * as os from "node:os";
import * as path from "node:path";

/** Fully-resolved runtime configuration for one dashboard invocation. */
export interface FleetConfig {
	/** Firstmate fleet home (FM_HOME), default ~/dev/fm2. */
	fmHome: string;
	/** Directories to scan for Smithers runs via the read-only CLI. */
	smithersWorkspaces: string[];
	/** Refresh interval, clamped to the [1s, 5s] band the brief mandates. */
	intervalMs: number;
	/** ANSI color on/off (off for capture, non-TTY, or NO_COLOR). */
	color: boolean;
	/** Render one frame then exit (capture/testing). */
	once: boolean;
	/** Width threshold below which the renderer switches to compact layout. */
	minWidth: number;
	/** Show per-source diagnostic detail instead of the compact health summary. */
	verbose?: boolean;
}

export const MIN_INTERVAL_SEC = 1;
export const MAX_INTERVAL_SEC = 5;
const DEFAULT_INTERVAL_SEC = 2;
const DEFAULT_MIN_WIDTH = 48;

/** Clamp a refresh interval (seconds) into the mandated 1–5s band. */
export function clampIntervalSec(seconds: number): number {
	if (!Number.isFinite(seconds)) return DEFAULT_INTERVAL_SEC;
	return Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, seconds));
}

export function defaultFmHome(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env.FM_HOME?.trim();
	if (fromEnv) return path.resolve(fromEnv);
	return path.join(os.homedir(), "dev", "fm2");
}

/**
 * Default Smithers workspaces. The current working directory almost always is
 * one (deck itself carries a smithers.db); `<fmHome>/workflows` is the other
 * canonical location. Both are probed read-only and missing ones just report
 * a diagnostic, so listing a non-existent path is harmless.
 */
export function defaultWorkspaces(fmHome: string, cwd: string): string[] {
	return dedupe([cwd, path.join(fmHome, "workflows")]);
}

export interface ParsedArgs {
	config: FleetConfig;
	help: boolean;
	error: string | null;
}

/**
 * Parse CLI argv into a {@link FleetConfig}. Pure over its inputs (argv + env +
 * cwd + a tty hint) so it is unit-testable without a real terminal.
 */
export function parseArgs(
	argv: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
	isTty = Boolean(process.stdout.isTTY),
): ParsedArgs {
	const fmHome = { value: defaultFmHome(env) };
	const workspaces: string[] = [];
	let intervalSec = DEFAULT_INTERVAL_SEC;
	let minWidth = DEFAULT_MIN_WIDTH;
	let once = false;
	let verbose = false;
	let help = false;
	// Color defaults on for a TTY, off when piped/captured or NO_COLOR is set.
	let color = isTty && !env.NO_COLOR;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "-h":
			case "--help":
				help = true;
				break;
			case "--once":
				once = true;
				break;
			case "--verbose":
				verbose = true;
				break;
			case "--no-color":
				color = false;
				break;
			case "--color":
				color = true;
				break;
			case "--fm-home": {
				const next = argv[++i];
				if (next === undefined) return fail("--fm-home requires a path");
				fmHome.value = path.resolve(cwd, next);
				break;
			}
			case "--workspace": {
				const next = argv[++i];
				if (next === undefined) return fail("--workspace requires a path");
				workspaces.push(path.resolve(cwd, next));
				break;
			}
			case "--interval": {
				const next = argv[++i];
				if (next === undefined) return fail("--interval requires seconds");
				const parsed = Number(next);
				if (!Number.isFinite(parsed)) return fail(`--interval not a number: ${next}`);
				intervalSec = parsed;
				break;
			}
			case "--min-width": {
				const next = argv[++i];
				if (next === undefined) return fail("--min-width requires a number");
				const parsed = Number(next);
				if (!Number.isFinite(parsed)) return fail(`--min-width not a number: ${next}`);
				minWidth = Math.max(20, Math.floor(parsed));
				break;
			}
			default:
				return fail(`unknown argument: ${arg}`);
		}
	}

	const resolved = workspaces.length > 0 ? dedupe(workspaces) : defaultWorkspaces(fmHome.value, cwd);
	return {
		help,
		error: null,
		config: {
			fmHome: fmHome.value,
			smithersWorkspaces: resolved,
			intervalMs: clampIntervalSec(intervalSec) * 1_000,
			color,
			once,
			minWidth,
			verbose,
		},
	};
}

function fail(message: string): ParsedArgs {
	return {
		help: false,
		error: message,
		config: {
			fmHome: defaultFmHome(),
			smithersWorkspaces: [],
			intervalMs: DEFAULT_INTERVAL_SEC * 1_000,
			color: false,
			once: true,
			minWidth: DEFAULT_MIN_WIDTH,
			verbose: false,
		},
	};
}

function dedupe(paths: readonly string[]): string[] {
	return [...new Set(paths.map((p) => path.resolve(p)))];
}

export const HELP_TEXT = `deck-fleet — read-only firstmate fleet + smithers dashboard

USAGE
  deck-fleet [options]

OPTIONS
  --fm-home <path>     Firstmate home (default: $FM_HOME or ~/dev/fm2)
  --workspace <path>   Smithers workspace to scan (repeatable; default: cwd + <fm-home>/workflows)
  --interval <sec>     Refresh interval, clamped to 1–5s (default: 2)
  --min-width <n>      Compact-layout threshold for narrow panes (default: 48)
  --once               Render a single frame and exit (capture/testing)
  --verbose            Show per-source diagnostic detail
  --no-color           Disable ANSI color (also implied when piped or NO_COLOR is set)
  --color              Force ANSI color even when not a TTY
  -h, --help           Show this help

The dashboard NEVER mutates state: it reads firstmate state/*.meta + status
tails and Smithers runs via read-only CLI queries only. No keybindings mutate.
`;
