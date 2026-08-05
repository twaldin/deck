import * as fs from "node:fs";
import * as path from "node:path";
import { deckV2Home, stateFiles } from "./home";
import { readMeta } from "./meta";

type JsonRecord = { type?: string; timestamp?: string; message?: { role?: string; content?: unknown; error?: unknown; isError?: boolean }; [key: string]: unknown };

export type TailLine = { text: string; timestamp?: string; error?: boolean; boundary?: boolean; tool?: boolean };

const MAX_TEXT_LINES = 4;
const MAX_TEXT_WIDTH = 240;

function oneLine(value: string, width = MAX_TEXT_WIDTH): string {
	return value.replace(/\s+/g, " ").trim().slice(0, width);
}

function toolArgument(record: Record<string, unknown>): string {
	const args = record.arguments ?? record.input ?? record.params;
	if (typeof args === "string") return args;
	if (args !== null && typeof args === "object") {
		const object = args as Record<string, unknown>;
		for (const key of ["command", "cmd", "file", "path", "filename"]) {
			if (typeof object[key] === "string") return object[key] as string;
		}
		try { return JSON.stringify(args); } catch { return ""; }
	}
	return "";
}

function toolLines(block: Record<string, unknown>): TailLine[] {
	const name = typeof block.name === "string" ? block.name : "tool";
	const detail = oneLine(toolArgument(block), 80);
	const line = `${name}: ${detail}`.trimEnd();
	return [{ text: line, error: false, tool: true }];
}

function contentLines(content: unknown): TailLine[] {
	if (typeof content === "string") {
		return content.split("\n").filter((line) => line.trim().length > 0).slice(0, MAX_TEXT_LINES).map((line) => ({ text: oneLine(line) }));
	}
	if (!Array.isArray(content)) return [];
	const lines: TailLine[] = [];
	for (const item of content) {
		if (item === null || typeof item !== "object") continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") {
			for (const line of block.text.split("\n").filter((value) => value.trim().length > 0).slice(0, MAX_TEXT_LINES)) {
				lines.push({ text: oneLine(line) });
			}
		} else if (block.type === "toolCall" || block.type === "tool_use") {
			lines.push(...toolLines(block));
		} else if (block.type === "toolResult" || block.type === "tool_result") {
			const error = block.isError === true || block.is_error === true || block.error !== undefined;
			const raw = typeof block.content === "string" ? block.content : typeof block.text === "string" ? block.text : Array.isArray(block.content) ? block.content.map((part) => part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join(" ") : "tool result";
			lines.push({ text: `${error ? "ERROR" : "result"}: ${oneLine(raw, 180)}`, error });
		}
	}
	return lines;
}

/** Format one pi session record without exposing the JSON wire format. */
export function formatSessionRecord(value: unknown, turn: number): TailLine[] {
	if (value === null || typeof value !== "object") return [];
	const record = value as JsonRecord;
	if (record.type !== "message" || record.message === undefined) return [];
	const message = record.message;
	const role = message.role ?? "message";
	const lines: TailLine[] = [];
	if (role === "assistant" || role === "user") lines.push({ text: `── turn ${turn} ${role} ──`, boundary: true });
	const content = contentLines(message.content);
	if (role === "tool" || role === "toolResult") {
		const isError = message.error !== undefined || message.isError === true;
		lines.push(...content.map((line) => ({ ...line, error: line.error || isError })));
	} else {
		lines.push(...content.map((line) => ({ ...line, text: line.tool === true ? line.text : `${role}: ${line.text}` })));
	}
	return lines;
}

export function formatSessionText(raw: string): string[] {
	const out: TailLine[] = [];
	let turn = 0;
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as JsonRecord;
			if (parsed.type === "message" && parsed.message?.role === "assistant") turn += 1;
			const timestamp = parsed.timestamp;
			out.push(...formatSessionRecord(parsed, turn).map((item) => ({ ...item, ...(timestamp === undefined ? {} : { timestamp }) })));
		} catch {
			// A partial final JSONL write is normal while pi is running.
		}
	}
	return out.map(renderTailLine);
}

function renderTailLine(line: TailLine): string {
	if (line.boundary) return line.text;
	return line.error ? `!! ${line.text}` : line.text;
}

function newestJsonl(dir: string): string | null {
	try {
		const files = fs.readdirSync(dir).filter((entry) => entry.endsWith(".jsonl"));
		let newest: { file: string; mtime: number } | null = null;
		for (const entry of files) {
			const file = path.join(dir, entry);
			const mtime = fs.statSync(file).mtimeMs;
			if (newest === null || mtime > newest.mtime) newest = { file, mtime };
		}
		return newest?.file ?? null;
	} catch { return null; }
}

export function sessionDirForTask(taskId: string): string {
	return readMeta(taskId)?.session_dir ?? stateFiles(taskId).sessions;
}

export function sessionFileForTask(taskId: string): string | null {
	return newestJsonl(sessionDirForTask(taskId));
}

export type TailOptions = { follow?: boolean; pollMs?: number; maxLines?: number; write?: (line: string) => void };

/** Follow a session, re-selecting the newest JSONL after rotation or inactivity. */
export async function tailSession(fileOrDir: string, options: TailOptions = {}): Promise<void> {
	const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	const follow = options.follow ?? true;
	const pollMs = options.pollMs ?? 500;
	const maxLines = options.maxLines ?? 40;
	const isDir = (() => { try { return fs.statSync(fileOrDir).isDirectory(); } catch { return false; } })();
	let file = isDir ? newestJsonl(fileOrDir) : fileOrDir;
	let offset = 0;
	let pending = "";
	let rendered: string[] = [];
	let initial = true;
	let turnCounter = 0;
	let lastActivity = Date.now();
	const emit = (text: string) => {
		for (const line of text.split("\n")) if (line.length > 0) {
			rendered.push(line);
			if (rendered.length > maxLines) rendered.shift();
			write(line);
		}
	};
	const readNew = () => {
		if (file === null) return;
		try {
			const stat = fs.statSync(file);
			if (stat.size < offset) { offset = 0; pending = ""; initial = true; }
			const start = initial ? Math.max(0, stat.size - 512 * 1024) : offset;
			const handle = fs.openSync(file, "r");
			const buffer = Buffer.alloc(Math.max(0, stat.size - start));
			if (buffer.length > 0) fs.readSync(handle, buffer, 0, buffer.length, start);
			fs.closeSync(handle);
			offset = stat.size;
			pending += buffer.toString("utf8");
			const complete = pending.split("\n");
			pending = complete.pop() ?? "";
			const batch: string[] = [];
			for (const raw of complete) {
				try {
					const record = JSON.parse(raw) as JsonRecord;
					if (record.type === "message" && record.message?.role === "assistant") turnCounter += 1;
					batch.push(...formatSessionRecord(record, turnCounter).map(renderTailLine));
					lastActivity = Date.now();
				} catch { /* partial or malformed records are ignored */ }
			}
			if (initial) {
				rendered = batch.slice(-maxLines);
				for (const line of rendered) write(line);
				initial = false;
			} else {
				emit(batch.join("\n"));
			}
		} catch { /* the writer may rotate between stat and read */ }
	};
	if (file !== null) readNew();
	if (!follow) return;
	while (true) {
		await new Promise((resolve) => setTimeout(resolve, pollMs));
		if (isDir && (file === null || Date.now() - lastActivity > pollMs * 2)) {
			const candidate = newestJsonl(fileOrDir);
			if (candidate !== null && candidate !== file) { file = candidate; offset = 0; pending = ""; }
		}
		readNew();
		if (lastActivity > 0 && Date.now() - lastActivity >= 1000) {
			const age = Math.floor((Date.now() - lastActivity) / 1000);
			// Keep the age visible without repainting the pane or using an alternate screen.
			if (age === 1 || age % 10 === 0) write(`… last activity ${age}s ago`);
		}
	}
}

export function tailUsageFile(file: string): string {
	return path.resolve(file);
}

export function defaultTailHome(): string { return deckV2Home(); }
