import * as fs from "node:fs";
import * as path from "node:path";
import { deckV2Home } from "../home";

export const STANDING_RULES_DIGEST_MARKER = "[deck] STANDING-RULES-DIGEST v1";
export const STANDING_RULES_DIGEST_BUDGET = 6 * 1024;

const sourceFiles = (home: string): string[] => [
	path.join(home, "data", "captain.md"),
	path.join(home, "data", "ref", "distill", "STANDING-RULES.md"),
];

function readOrEmpty(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/** Build the newest-last rules digest, dropping oldest bytes when it exceeds its budget. */
export function standingRulesDigest(home = deckV2Home()): string {
	const source = sourceFiles(home).map(readOrEmpty).filter(Boolean).join("\n\n");
	const prefix = `${STANDING_RULES_DIGEST_MARKER}\n`;
	const available = STANDING_RULES_DIGEST_BUDGET - Buffer.byteLength(prefix);
	const bytes = Buffer.from(source);
	let content = source;
	if (bytes.length > available) {
		let start = bytes.length - available;
		content = bytes.subarray(start).toString("utf8");
		while (Buffer.byteLength(content) > available) content = content.slice(1);
	}
	return `${prefix}${content}`;
}
