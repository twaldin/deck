import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { EMPTY_INTAKE_STATE, type IntakeState, intakeStateSchema } from "./schema";

/** Read the durable state file; missing file = first run (empty state). */
export function readIntakeState(filePath: string): IntakeState {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return EMPTY_INTAKE_STATE;
		}
		throw new Error(`cannot read state file ${filePath}: ${String(error)}`);
	}
	return intakeStateSchema.parse(JSON.parse(text));
}

/** Atomic replace (tmp + rename + fsync), 0600, matching deck conventions. */
export function writeFileAtomic(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(temporary, "wx", 0o600);
		fs.writeFileSync(descriptor, content);
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = undefined;
		fs.renameSync(temporary, filePath);
		const directoryDescriptor = fs.openSync(path.dirname(filePath), "r");
		try {
			fs.fsyncSync(directoryDescriptor);
		} finally {
			fs.closeSync(directoryDescriptor);
		}
	} catch (error) {
		if (descriptor !== undefined) {
			fs.closeSync(descriptor);
		}
		fs.rmSync(temporary, { force: true });
		throw new Error(`cannot atomically write ${filePath}: ${String(error)}`);
	}
}

export function writeIntakeState(filePath: string, state: IntakeState): void {
	const validated = intakeStateSchema.parse(state);
	writeFileAtomic(filePath, `${JSON.stringify(validated, null, "\t")}\n`);
}

/**
 * Parse a tracked-work file: one PR URL per line. Blank lines and lines
 * starting with '#' are ignored; only the first whitespace-separated token
 * of each line is taken (so trailing annotations are allowed).
 */
export function readTrackedUrls(filePath: string, normalize: (url: string) => string): Set<string> {
	const text = fs.readFileSync(filePath, "utf8");
	const urls = new Set<string>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) {
			continue;
		}
		const token = trimmed.split(/\s+/, 1)[0];
		if (token !== undefined && token.length > 0) {
			urls.add(normalize(token));
		}
	}
	return urls;
}
