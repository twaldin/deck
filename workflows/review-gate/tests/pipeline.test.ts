import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../pipeline.tsx", import.meta.url), "utf8");

test("polls the captain review-request queue programmatically", () => {
  expect(source).toContain('"--reviewer"');
  expect(source).toContain('"review-requested-poll"');
  expect(source).toContain("const proc = Bun.spawn"); // polling is a programmatic GH call
});

test("gate has a hard no-approval rule and only queues after approvable", () => {
  expect(source).toContain("NEVER run any GitHub approve command");
  expect(source).not.toMatch(/gh[^\n]*approve/);
  expect(source).toContain('latestReview?.approvable === true && question === undefined');
  expect(source).toContain('questionKind: "stamp"');
});

test("blockers dispatch a fix and prevent the captain question", () => {
  expect(source).toContain('latestReview && !latestReview.approvable && latestReview.blockers.length > 0');
  expect(source).toContain('id="gate-fix"');
  expect(source).toContain("Fix every finding from Sathira's Gate review");
});
