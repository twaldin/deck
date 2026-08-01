import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../pipeline.tsx", import.meta.url), "utf8");

test("polls the captain review-request queue programmatically", () => {
  expect(source).toContain('"--reviewer"');
  expect(source).toContain('"review-requested-poll"');
  expect(source).toContain("const proc = Bun.spawn"); // polling is a programmatic GH call
});

test("gate has a hard no-approval rule and verifies state before queueing", () => {
  expect(source).toContain("NEVER run any GitHub approve command");
  expect(source).not.toMatch(/gh[^\n]*approve/);
  expect(source).toContain("checked?.mergeable === true && checked?.ciGreen === true");
  expect(source).toContain('questionKind: "stamp"');
});

test("blockers dispatch a fix and rebase is an agent task", () => {
  expect(source).toContain("latest.blockers.length > 0");
  expect(source).toContain("gate-fix-");
  expect(source).toContain("Fix every finding from Sathira's Gate review");
  expect(source).toContain("rebaseModel");
  expect(source).toContain("Load the exact skills .agent/skills/sathiras-gate");
});

test("polling and every requested PR are durable workflow paths", () => {
  expect(source).toContain('maxIterations={polls}');
  expect(source).toContain("prs.map(reviewPath)");
  expect(source).toContain("pr.url");
});
