import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askIfAbsent, openQuestions } from "../../../v2/src/questions-store.ts";

const source = readFileSync(new URL("../pipeline.tsx", import.meta.url), "utf8");

test("atomic global asks queue one event under concurrent callers", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
  const file = join(dir, "queue.jsonl");
  const input = { id: "review-gate-pr-7-head", idScope: "global" as const, question: "Approve PR 7?", sessionId: "run", cwd: dir };
  const first = askIfAbsent(file, input);
  const second = askIfAbsent(file, input);
  expect(first.id).toBe(second.id);
  expect(openQuestions(file)).toHaveLength(1);
});

test("polls the captain review-request queue programmatically", () => {
  expect(source).toContain("review-requested:${login}");
  expect(source).toContain('"review-requested-poll"');
  expect(source).toContain("const proc = Bun.spawn"); // polling is a programmatic GH call
});

test("gate has a hard no-approval rule and verifies state before queueing", () => {
  expect(source).toContain("NEVER run any GitHub approve command");
  expect(source).toContain("<Approval");
  expect(source).toContain("review-approval-gate-");
  expect(source).not.toMatch(/"pr",\s*"merge"/);
  expect(source).toContain("mergeStateStatus");
  expect(source).toContain('questionKind: "stamp"');
});

test("blockers dispatch a fix and rebase is an agent task", () => {
  expect(source).toContain("latest.blockers.length > 0");
  expect(source).toContain("gate-fix-");
  expect(source).toContain("Fix every finding from Sathira's Gate review");
  expect(source).toContain("rebaseModel");
  expect(source).toContain("Load the exact skills .agent/skills/sathiras-gate");
});

test("each blocker round posts findings and requests changes", () => {
  expect(source).toContain('"pr", "review"');
  expect(source).toContain('"--request-changes"');
  expect(source).toContain("— Tim's agent");
  expect(source).toContain("Blockers remain");
});

test("clean and exhausted rounds use different captain decisions without self-approval", () => {
  expect(source).toContain('maxIterations={rounds}');
  expect(source).toContain('Math.min(input.limits?.rounds ?? 3, 3)');
  expect(source).toContain('questionKind: "stamp"');
  expect(source).toContain('options: ["Approve", "Hold"]');
  expect(source).toContain('blockers.length === 0 ? "--approve" : "--request-changes"');
});

test("polling and every requested PR are durable workflow paths", () => {
  expect(source).toContain('maxIterations={polls}');
  expect(source).toContain("reviewPrs.map((pr) =>");
  expect(source).toContain("pr.url");
});
