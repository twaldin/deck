import { describe, expect, test } from "bun:test";
import { diffFrame, FramePainter } from "../src/diff";

describe("diffFrame", () => {
	test("first paint writes every line", () => {
		const frame = diffFrame(null, ["a", "b", "c"]);
		expect(frame.changed).toEqual([0, 1, 2]);
		expect(frame.cleared).toEqual([]);
		expect(frame.output).toContain("a");
		expect(frame.output).toContain("c");
	});

	test("only changed rows are (re)written on update", () => {
		const frame = diffFrame(["a", "b", "c"], ["a", "B", "c"]);
		expect(frame.changed).toEqual([1]);
		expect(frame.cleared).toEqual([]);
		// The unchanged "a"/"c" text is not re-emitted; only "B" is.
		expect(frame.output).toContain("B");
		expect(frame.output).not.toContain("2Ka"); // no clear+rewrite of row 0
	});

	test("moves cursor to top of block before diffing", () => {
		const frame = diffFrame(["a", "b"], ["a", "b"]);
		expect(frame.output.startsWith("\x1b[2A")).toBe(true);
		expect(frame.changed).toEqual([]);
	});

	test("shrinking frame clears leftover rows and parks below new block", () => {
		const frame = diffFrame(["a", "b", "c"], ["a"]);
		expect(frame.cleared).toEqual([1, 2]);
		// Overshoot correction: advanced 3 rows, block is 1 tall => up 2.
		expect(frame.output.endsWith("\x1b[2A")).toBe(true);
	});

	test("growing frame writes the new trailing rows", () => {
		const frame = diffFrame(["a"], ["a", "b"]);
		expect(frame.changed).toEqual([1]);
		expect(frame.output).toContain("b");
	});
});

describe("FramePainter", () => {
	test("tracks previous frame across paints", () => {
		const painter = new FramePainter();
		const first = painter.paint(["a", "b"]);
		expect(first.changed).toEqual([0, 1]); // initial full paint
		const second = painter.paint(["a", "z"]);
		expect(second.changed).toEqual([1]);
	});

	test("forceFull repaints everything (resize)", () => {
		const painter = new FramePainter();
		painter.paint(["a", "b"]);
		const resized = painter.paint(["a", "b"], true);
		expect(resized.changed).toEqual([0, 1]);
		expect(resized.output.startsWith("\x1b[2A\r")).toBe(true);
		expect(resized.output).toContain("\x1b[2Ka");
		expect(resized.output).toContain("\x1b[2Kb");
	});

	test("forceFull clears removed rows and parks below the resized block", () => {
		const painter = new FramePainter();
		painter.paint(["a", "b", "c"]);
		const resized = painter.paint(["A"], true);
		expect(resized.changed).toEqual([0]);
		expect(resized.cleared).toEqual([1, 2]);
		expect(resized.output.startsWith("\x1b[3A\r")).toBe(true);
		expect(resized.output.endsWith("\x1b[2A")).toBe(true);
	});
});
