#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_MEMO_BYTES = 280;

export type MemorySource = {
	label: string;
	kind: "captain" | "learnings";
	path: string;
	required?: boolean;
};

type Candidate = {
	body: string;
	heading: string;
	label: string;
};

const TEMPORARY_SECTION = /\b(active priorities|live priorities|standing knowledge load order|cutover seed|knowledge pack restored|finalized build|morning board|today's? status|current queue|in flight)\b/i;
const DURABLE_SECTION = /\b(identity|who|how|communications?|comms|voice|authority|autonomy|doctrine|rules?|preferences?|decisions?|rails?|merge|reviews?|memory|models?|tooling|dispatch|verification|landing|factory|evidence|incidents?|lessons?|traps?|north star|ownership|spawn|questions?|teams?|hygiene|auth|pipeline|prod)\b/i;
const DURABLE_SIGNAL = /\b(never|always|must|only|prefers?|requires?|forbidden|allowed|do not|don't|should|default|verify|verification|refuse|stop|escalate|approval|merged|stamp|rules?|lessons?)\b/i;
const INCIDENT_SIGNAL = /\b(measured|incident|root cause|failed|failure|bug|trap|caused|cost|repros?|silently|verified|wrong|fixed by|regression)\b/i;

function cleanMarkdown(value: string): string {
	return value
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)]\(([^)]+)\)/g, "$1 ($2)")
		.replace(/<!--.*?-->/g, "")
		.replace(/(^|[\s([{])\*\*([^*\n]+?)\*\*(?=$|[\s)\]}.!,;:])/g, "$1$2")
		.replace(/(^|[\s([{])(_{1,3})([^_\s\n]+?)\2(?=$|[\s)\]}.!,;:])/g, "$1$3")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
}

function keepCandidate(kind: MemorySource["kind"], heading: string, body: string, paragraph: boolean): boolean {
	if (body.length < 8 || TEMPORARY_SECTION.test(heading)) return false;
	if (kind === "learnings") {
		return DURABLE_SIGNAL.test(body) || INCIDENT_SIGNAL.test(body) || DURABLE_SECTION.test(heading);
	}
	if (DURABLE_SIGNAL.test(body)) return true;
	if (!DURABLE_SECTION.test(heading)) return false;
	return !paragraph || /\b(identity|who|how|voice|north star|decision)\b/i.test(heading);
}

function tableCells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cleanMarkdown(cell));
}


function extractCandidates(source: MemorySource, markdown: string): Candidate[] {
	const found: Candidate[] = [];
	let heading = "General";
	let bullet: string[] | null = null;
	let paragraph: string[] = [];
	let tableHeaders: string[] = [];

	const add = (raw: string, isParagraph = false) => {
		const body = cleanMarkdown(raw);
		if (keepCandidate(source.kind, heading, body, isParagraph)) {
			found.push({ body, heading: cleanMarkdown(heading), label: source.label });
		}
	};
	const flushBullet = () => {
		if (bullet !== null) add(bullet.join(" "));
		bullet = null;
	};
	const flushParagraph = () => {
		if (paragraph.length > 0) add(paragraph.join(" "), true);
		paragraph = [];
	};

	for (const line of `${markdown}\n`.split(/\r?\n/)) {
		const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (headingMatch !== null) {
			flushBullet();
			flushParagraph();
			heading = headingMatch[2] ?? "General";
			tableHeaders = [];
			continue;
		}

		const bulletMatch = /^\s*(?:[-+*]|\d+[.)])\s+(.+)$/.exec(line);
		if (bulletMatch !== null) {
			flushBullet();
			flushParagraph();
			bullet = [bulletMatch[1] ?? ""];
			tableHeaders = [];
			continue;
		}

		if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
			flushBullet();
			flushParagraph();
			const cells = tableCells(line);
			if (cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
			if (tableHeaders.length === 0) {
				tableHeaders = cells;
				continue;
			}
			for (let index = 0; index < cells.length; index += 1) {
				const cell = cells[index];
				if (cell === undefined || cell.length === 0) continue;
				const column = tableHeaders[index] ?? `column ${index + 1}`;
				add(`${column}: ${cell}`);
			}
			continue;
		}

		if (line.trim().length === 0) {
			flushBullet();
			flushParagraph();
			tableHeaders = [];
			continue;
		}

		if (bullet !== null) {
			bullet.push(line.trim());
		} else {
			paragraph.push(line.trim());
		}
		tableHeaders = [];
	}

	return found;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function shortenToBytes(value: string, maxBytes: number): string {
	let result = "";
	for (const character of value) {
		if (byteLength(result + character) > maxBytes) break;
		result += character;
	}
	return result.trim();
}

function splitWords(value: string, maxBytes: number): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const word of value.split(/\s+/)) {
		if (byteLength(word) > maxBytes) {
			if (current.length > 0) chunks.push(current);
			current = "";
			let piece = "";
			for (const character of word) {
				if (byteLength(piece + character) > maxBytes) {
					chunks.push(piece);
					piece = "";
				}
				piece += character;
			}
			if (piece.length > 0) current = piece;
			continue;
		}
		const joined = current.length === 0 ? word : `${current} ${word}`;
		if (byteLength(joined) <= maxBytes) {
			current = joined;
		} else {
			chunks.push(current);
			current = word;
		}
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

function splitBody(value: string, maxBytes: number): string[] {
	if (byteLength(value) <= maxBytes) return [value];
	const units = value.split(/(?<=[.!?;])\s+/);
	const chunks: string[] = [];
	let current = "";
	for (const unit of units) {
		if (byteLength(unit) > maxBytes) {
			if (current.length > 0) chunks.push(current);
			chunks.push(...splitWords(unit, maxBytes));
			current = "";
			continue;
		}
		const joined = current.length === 0 ? unit : `${current} ${unit}`;
		if (byteLength(joined) <= maxBytes) {
			current = joined;
		} else {
			chunks.push(current);
			current = unit;
		}
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

function candidateLines(candidate: Candidate): string[] {
	const heading = shortenToBytes(candidate.heading, 72);
	const prefix = `${candidate.label} — ${heading}: `;
	const available = MAX_MEMO_BYTES - byteLength(prefix);
	if (available < 40) throw new Error(`memory provenance prefix is too long: ${prefix}`);
	return splitBody(candidate.body, available).map((part) => `${prefix}${part}`);
}

/** Convert curated Markdown memories into deterministic, memo-note-ready lines. */
export function buildMemorySeed(inputs: Array<{ source: MemorySource; markdown: string }>): string {
	const byBody = new Map<string, Candidate>();
	for (const input of inputs) {
		for (const candidate of extractCandidates(input.source, input.markdown)) {
			const key = candidate.body.toLowerCase().replace(/\s+/g, " ");
			byBody.set(key, candidate);
		}
	}
	const lines = [...byBody.values()].flatMap(candidateLines);
	for (const line of lines) {
		if (line.includes("\n") || byteLength(line) > MAX_MEMO_BYTES) {
			throw new Error(`invalid memory line (${byteLength(line)} bytes): ${line}`);
		}
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Write the review artifact atomically. A reviewed edit is never overwritten implicitly. */
export function writeReviewFile(outputPath: string, contents: string, force = false): "written" | "unchanged" {
	if (fs.existsSync(outputPath)) {
		const existing = fs.readFileSync(outputPath, "utf8");
		if (existing === contents) return "unchanged";
		if (!force) {
			throw new Error(`${outputPath} already exists and differs; review edits were preserved. Use --force only to regenerate it.`);
		}
	}
	const directory = path.dirname(outputPath);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = path.join(directory, `.${path.basename(outputPath)}.tmp-${process.pid}-${randomUUID()}`);
	fs.writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
	try {
		if (force) {
			fs.renameSync(temporary, outputPath);
			return "written";
		}
		try {
			// A hard-link publish is atomic and, unlike rename, never replaces a
			// review file created after the initial existence check.
			fs.linkSync(temporary, outputPath);
			return "written";
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") throw error;
			const existing = fs.readFileSync(outputPath, "utf8");
			if (existing === contents) return "unchanged";
			throw new Error(`${outputPath} appeared during migration and was preserved; review it before retrying.`);
		}
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

type CliOptions = {
	sources: MemorySource[];
	output: string;
	writeReview: boolean;
	force: boolean;
};

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return path.resolve(value);
}

function usage(): string {
	return `Usage: bun ops/migrate-memory.ts [options]\n\n` +
		`Default mode is DRY RUN: proposed memo lines go to stdout and no file changes.\n\n` +
		`  --captain PATH             current deck captain profile\n` +
		`  --learnings PATH           current deck incident lessons\n` +
		`  --fm2-captain PATH         fm2 captain profile\n` +
		`  --firstmate-captain PATH   firstmate captain profile\n` +
		`  --output PATH              review file (default: ~/.deck/data/memory-seed.txt)\n` +
		`  --write-review             atomically write the review file\n` +
		`  --force                    replace a differing review file\n` +
		`  --help                     show this help\n\n` +
		`This command never calls memo note. Review and edit the file before seeding OptMem.\n`;
}

function parseCli(argv: string[]): CliOptions | null {
	const home = os.homedir();
	const deckHome = process.env.DECK_V2_HOME ?? path.join(home, ".deck");
	const values: Record<string, string> = {
		"--firstmate-captain": path.join(home, "firstmate", "data", "captain.md"),
		"--fm2-captain": path.join(home, "dev", "fm2", "data", "captain.md"),
		"--captain": path.join(deckHome, "data", "captain.md"),
		"--learnings": path.join(deckHome, "data", "learnings.md"),
		"--output": path.join(deckHome, "data", "memory-seed.txt"),
	};
	const explicitlySet = new Set<string>();
	let writeReview = false;
	let force = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") return null;
		if (argument === "--write-review") {
			writeReview = true;
			continue;
		}
		if (argument === "--force") {
			force = true;
			continue;
		}
		if (argument === undefined || !(argument in values)) throw new Error(`unknown option: ${argument ?? ""}`);
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("-")) throw new Error(`${argument} requires a path value`);
		values[argument] = expandHome(value);
		if (argument !== "--output") explicitlySet.add(argument);
		index += 1;
	}
	if (force && !writeReview) throw new Error("--force is valid only with --write-review");
	return {
		sources: [
			{
				label: "Firstmate captain",
				kind: "captain",
				path: values["--firstmate-captain"]!,
				required: explicitlySet.has("--firstmate-captain"),
			},
			{
				label: "FM2 captain",
				kind: "captain",
				path: values["--fm2-captain"]!,
				required: explicitlySet.has("--fm2-captain"),
			},
			{
				label: "Captain",
				kind: "captain",
				path: values["--captain"]!,
				required: explicitlySet.has("--captain"),
			},
			{
				label: "Learning",
				kind: "learnings",
				path: values["--learnings"]!,
				required: explicitlySet.has("--learnings"),
			},
		],
		output: values["--output"]!,
		writeReview,
		force,
	};
}

export function runCli(argv: string[]): number {
	const options = parseCli(argv);
	if (options === null) {
		process.stdout.write(usage());
		return 0;
	}
	const inputs: Array<{ source: MemorySource; markdown: string }> = [];
	for (const source of options.sources) {
		if (!fs.existsSync(source.path)) {
			if (source.required === true) throw new Error(`explicit memory source does not exist: ${source.path}`);
			process.stderr.write(`SKIP missing source: ${source.path}\n`);
			continue;
		}
		inputs.push({ source, markdown: fs.readFileSync(source.path, "utf8") });
	}
	if (inputs.length === 0) throw new Error("no memory source files exist");
	const contents = buildMemorySeed(inputs);
	const count = contents.length === 0 ? 0 : contents.trimEnd().split("\n").length;
	if (!options.writeReview) {
		process.stderr.write(`DRY RUN: ${count} proposed memories; ${options.output} was not written.\n`);
		process.stdout.write(contents);
		return 0;
	}
	const result = writeReviewFile(options.output, contents, options.force);
	process.stdout.write(`${result === "written" ? "Wrote" : "Unchanged"} ${options.output} (${count} lines).\n`);
	process.stdout.write("Review and edit every line before running memo note; this command never seeds OptMem.\n");
	return 0;
}

if (import.meta.main) {
	try {
		process.exitCode = runCli(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
