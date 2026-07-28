/**
 * Differential in-place frame updates for a non-alternate-screen TUI.
 *
 * Invariant between renders: after any paint the cursor is parked at column 0
 * on the line directly BELOW the rendered block (block height == previous frame
 * length). From there the next update moves up to the top of the block and
 * rewrites ONLY the lines whose text changed, leaving unchanged lines
 * untouched (no clear-screen, no full redraw => no flicker).
 */

const CSI = "\x1b[";
const CLEAR_LINE = `${CSI}2K`;
/** Down one row, carriage-return to column 0. */
const NEXT_ROW = `${CSI}1B\r`;

export interface DiffFrame {
	/** Bytes to write to the terminal for this update. */
	output: string;
	/** Row indices whose content was (re)written — for tests/instrumentation. */
	changed: number[];
	/** Row indices that were cleared because they no longer exist. */
	cleared: number[];
}

/**
 * Compute the update to turn `prev` into `next`. When `prev` is null this is
 * the first paint: emit the whole frame. The result parks the cursor below the
 * NEW block so the next call's invariant holds regardless of height change.
 */
export function diffFrame(prev: readonly string[] | null, next: readonly string[], forceFull = false): DiffFrame {
	if (prev === null) {
		// First paint: use real newlines so the block scrolls into view when the
		// cursor sits near the screen bottom. Ends parked below the block.
		const output = `${next.map((line) => `${CLEAR_LINE}${line}`).join("\n")}\n`;
		return { output, changed: next.map((_, i) => i), cleared: [] };
	}

	const rows = Math.max(prev.length, next.length);
	const changed: number[] = [];
	const cleared: number[] = [];
	let output = prev.length > 0 ? `${CSI}${prev.length}A\r` : "";

	for (let i = 0; i < rows; i++) {
		const before = prev[i];
		const after = next[i];
		if (after !== undefined) {
			if (forceFull || after !== before) {
				output += `${CLEAR_LINE}${after}`;
				changed.push(i);
			}
			// else: unchanged — write nothing, just advance.
		} else {
			// Row removed (frame shrank): clear the leftover content.
			output += CLEAR_LINE;
			cleared.push(i);
		}
		output += NEXT_ROW;
	}

	// We advanced `rows` lines from the top; park just below the NEW block.
	const overshoot = rows - next.length;
	if (overshoot > 0) output += `${CSI}${overshoot}A`;

	return { output, changed, cleared };
}

/** Reusable stateful painter wrapping {@link diffFrame}. */
export class FramePainter {
	private prev: string[] | null = null;

	/** Produce the bytes to render `next`; pass forceFull to repaint (resize). */
	paint(next: readonly string[], forceFull = false): DiffFrame {
		// A resize repaint is not an initial paint: the cursor is still parked
		// below the old block, so preserve its height and return to its top before
		// rewriting every row.
		const frame = diffFrame(this.prev, next, forceFull);
		this.prev = [...next];
		return frame;
	}

	reset(): void {
		this.prev = null;
	}
}
