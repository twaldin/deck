import * as path from "node:path";
import { DeckError, type DeckErrorCode } from "./core";
import { z } from "zod";
import {
	allocCommandSchema,
	listCommandSchema,
	reapCommandSchema,
	releaseCommandSchema,
	type WorktreeCommand,
	type WorktreeEntry,
} from "./schema";
import { allocateWorktree, listWorktrees, reapWorktrees, releaseWorktree } from "./worktrees";

const USAGE = `Usage:
  deck wt alloc --repo <path> --effort <effort_id> [--base <branch>] [--branch <name>] [--desc <text>]
  deck wt release <wt-id> [--delete-branch]
  deck wt ls [--json]
  deck wt reap`;

const EXIT_BY_ERROR_CODE: Record<DeckErrorCode, number> = {
	E_TOO_LONG: 2,
	E_CAS: 2,
	E_LEASE: 2,
	E_EVIDENCE: 2,
	E_ADMISSION: 3,
	E_CAP: 2,
	E_ARG: 2,
	E_STATE: 2,
	E_LIVENESS: 2,
	E_IO: 4,
};

function argumentError(message: string): DeckError {
	return new DeckError("E_ARG", `${message}\n${USAGE}`);
}

function parseAlloc(args: string[]): WorktreeCommand {
	const options: Record<string, string> = {};
	const optionNames: Record<string, string> = {
		"--repo": "repo",
		"--effort": "effort",
		"--base": "base",
		"--branch": "branch",
		"--desc": "desc",
	};
	for (let index = 0; index < args.length; index += 2) {
		const option = args[index];
		const value = args[index + 1];
		if (option === undefined || optionNames[option] === undefined) {
			throw argumentError(`unknown alloc option: ${option ?? "<missing>"}`);
		}
		if (value === undefined || value.startsWith("--")) {
			throw argumentError(`${option} requires a value`);
		}
		const property = optionNames[option];
		if (property === undefined) {
			throw argumentError(`unknown alloc option: ${option}`);
		}
		if (options[property] !== undefined) {
			throw argumentError(`duplicate alloc option: ${option}`);
		}
		options[property] = value;
	}

	const parsed = allocCommandSchema.safeParse({
		kind: "alloc",
		repo: options.repo,
		effort: options.effort,
		base: options.base,
		branch: options.branch,
		desc: options.desc,
	});
	if (!parsed.success) {
		throw argumentError(z.prettifyError(parsed.error));
	}
	return parsed.data;
}

function parseRelease(args: string[]): WorktreeCommand {
	const id = args[0];
	let deleteBranch = false;
	for (const option of args.slice(1)) {
		if (option !== "--delete-branch" || deleteBranch) {
			throw argumentError(`unknown or duplicate release option: ${option}`);
		}
		deleteBranch = true;
	}

	const parsed = releaseCommandSchema.safeParse({ kind: "release", id, deleteBranch });
	if (!parsed.success) {
		throw argumentError(z.prettifyError(parsed.error));
	}
	return parsed.data;
}

function parseList(args: string[]): WorktreeCommand {
	if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
		throw argumentError(`unknown ls option: ${args.join(" ")}`);
	}
	return listCommandSchema.parse({ kind: "ls", json: args[0] === "--json" });
}

function parseReap(args: string[]): WorktreeCommand {
	if (args.length !== 0) {
		throw argumentError(`reap does not accept arguments: ${args.join(" ")}`);
	}
	return reapCommandSchema.parse({ kind: "reap" });
}

function parseArguments(input: string[]): WorktreeCommand {
	const argvResult = z.array(z.string()).safeParse(input);
	if (!argvResult.success) {
		throw argumentError(z.prettifyError(argvResult.error));
	}
	const argv = argvResult.data;
	if (argv[0] !== "wt") {
		throw argumentError("expected 'wt' command group");
	}

	const command = argv[1];
	const args = argv.slice(2);
	switch (command) {
		case "alloc":
			return parseAlloc(args);
		case "release":
			return parseRelease(args);
		case "ls":
			return parseList(args);
		case "reap":
			return parseReap(args);
		default:
			throw argumentError(`unknown wt command: ${command ?? "<missing>"}`);
	}
}

function printHumanTable(entries: WorktreeEntry[]): void {
	if (entries.length === 0) {
		console.log("No worktrees.");
		return;
	}

	const headers = ["ID", "STATE", "REPO", "PATH", "EFFORT", "BRANCH", "DESC", "CREATED"];
	const rows = entries.map((entry) => [
		entry.id,
		entry.state,
		path.basename(entry.repo),
		entry.path,
		entry.effort,
		entry.branch,
		entry.desc ?? "",
		entry.created,
	]);
	const widths = headers.map((header, column) =>
		Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
	);
	const headerLine = headers.map((header, column) => header.padEnd(widths[column] ?? header.length)).join("  ");
	console.log(headerLine);
	console.log(widths.map((width) => "-".repeat(width)).join("  "));
	for (const row of rows) {
		console.log(row.map((value, column) => value.padEnd(widths[column] ?? value.length)).join("  "));
	}
}

async function execute(command: WorktreeCommand): Promise<void> {
	switch (command.kind) {
		case "alloc": {
			const entry = await allocateWorktree(command);
			console.log(`${entry.id}\t${entry.path}\t${entry.branch}`);
			return;
		}
		case "release": {
			const entry = await releaseWorktree(command.id, command.deleteBranch);
			console.log(`Released ${entry.id}.`);
			return;
		}
		case "ls": {
			const entries = listWorktrees();
			if (command.json) {
				console.log(JSON.stringify(entries, null, "\t"));
			} else {
				printHumanTable(entries);
			}
			return;
		}
		case "reap": {
			const entries = await reapWorktrees();
			console.log(`Reaped ${entries.length} worktree${entries.length === 1 ? "" : "s"}.`);
			return;
		}
	}
}

export async function runCli(argv: string[]): Promise<number> {
	try {
		const command = parseArguments(argv);
		await execute(command);
		return 0;
	} catch (error) {
		if (error instanceof DeckError) {
			console.error(error.message);
			return EXIT_BY_ERROR_CODE[error.code];
		}
		const message = error instanceof Error ? error.message : String(error);
		const deckError = new DeckError("E_IO", message);
		console.error(deckError.message);
		return EXIT_BY_ERROR_CODE.E_IO;
	}
}
