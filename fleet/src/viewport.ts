/**
 * Fit a rendered frame to the terminal's physical row count.
 *
 * The live TUI can call this after renderModel and before FramePainter.paint.
 * Keeping it pure makes row-budget behavior fixture-testable without terminal
 * IO and avoids coupling the renderer to process.stdout.
 */
export function fitFrame(lines: readonly string[], rows: number, width?: number): string[] {
	const rowBudget = Math.max(0, Math.floor(rows));
	if (rowBudget === 0) return [];
	if (lines.length <= rowBudget) return [...lines];

	const sourcesIndex = lines.findIndex((line) => stripAnsi(line).trim().startsWith("sources:"));
	let headCount = rowBudget - 1;
	let tail: readonly string[] = [];
	if (sourcesIndex > 0 && rowBudget >= 3) {
		const fullTail = lines.slice(sourcesIndex);
		const tailBudget = Math.min(fullTail.length, Math.max(1, Math.floor(rowBudget / 3)));
		tail = fullTail.slice(0, tailBudget);
		headCount = rowBudget - 1 - tail.length;
	}
	const omittedCount = lines.length - headCount - tail.length;
	const marker = `… ${omittedCount} line${omittedCount === 1 ? "" : "s"} omitted`;
	return [
		...lines.slice(0, headCount),
		width === undefined ? marker : truncate(marker, width),
		...tail,
	];
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
import { truncate } from "./render";
