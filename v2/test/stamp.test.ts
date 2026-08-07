import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { patchSeries, stampSurvives, stampSurvivesAt, type Stamp } from "../src/stamp";

const roots: string[] = [];

function git(repo: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

function gitWithInput(repo: string, input: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", input });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

function repoWith(file: string, content: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-stamp-"));
	roots.push(root);
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "captain@example.com");
	git(repo, "config", "user.name", "Captain");
	fs.writeFileSync(path.join(repo, file), content);
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "base");
	return repo;
}

function commitFile(repo: string, file: string, content: string, message: string): string {
	fs.writeFileSync(path.join(repo, file), content);
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", message);
	return git(repo, "rev-parse", "HEAD");
}

function stamp(repo: string, base: string, head: string): Stamp {
	return { patchIds: patchSeries(repo, base, head), base, head, at: Date.now() };
}

function patchSeriesWith(repo: string, base: string, head: string, mode: "--stable" | "--verbatim"): string[] {
	const patches = git(repo, "log", "--reverse", "--format=commit %H", "--patch", `${base}..${head}`);
	const output = gitWithInput(repo, `${patches}\n`, "patch-id", mode);
	return output === "" ? [] : output.split(/\r?\n/).map((line) => line.split(/\s+/)[0]!);
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("content-bound merge stamps", () => {
	test("a clean rebase onto nearby changes on moved main survives", () => {
		const baseSource = "zero\none\nmain target\nthree\nfour\nfeature target\nsix\nseven\neight\n";
		const featureSource = baseSource.replace("feature target", "feature reviewed");
		const mainSource = baseSource.replace("main target", "main moved");
		const combinedSource = featureSource.replace("main target", "main moved");
		const repo = repoWith("app.txt", baseSource);
		const base = git(repo, "rev-parse", "main");
		git(repo, "checkout", "-qb", "feature");
		commitFile(repo, "app.txt", featureSource, "feature one");
		const oldHead = commitFile(repo, "feature-b.txt", "two\n", "feature two");
		const authorized = stamp(repo, base, oldHead);

		git(repo, "checkout", "-q", "main");
		const movedMain = commitFile(repo, "app.txt", mainSource, "move main");
		git(repo, "checkout", "-q", "feature");
		git(repo, "rebase", "main");
		const rebasedHead = git(repo, "rev-parse", "HEAD");

		expect(rebasedHead).not.toBe(oldHead);
		expect(fs.readFileSync(path.join(repo, "app.txt"), "utf8")).toBe(combinedSource);
		expect(stampSurvivesAt(authorized, repo, movedMain, rebasedHead)).toBe(true);
	});

	test("a force-push with identical content survives", () => {
		const repo = repoWith("app.txt", "base\n");
		const base = git(repo, "rev-parse", "main");
		git(repo, "checkout", "-qb", "feature");
		const firstHead = commitFile(repo, "app.txt", "base\nfeature\n", "first history");
		const authorized = stamp(repo, base, firstHead);

		git(repo, "reset", "--hard", base);
		const replacementHead = commitFile(repo, "app.txt", "base\nfeature\n", "replacement history");
		const current = patchSeries(repo, base, replacementHead);

		expect(replacementHead).not.toBe(firstHead);
		expect(stampSurvives(authorized, current)).toBe(true);
		expect(stampSurvivesAt(authorized, repo, base, replacementHead)).toBe(true);
		expect(stampSurvivesAt({ ...authorized, revoked: 0 }, repo, base, replacementHead)).toBe(false);
	});

	test("fingerprints ignore mutable diff-prefix configuration", () => {
		const repo = repoWith("app.txt", "base\n");
		const base = git(repo, "rev-parse", "main");
		git(repo, "checkout", "-qb", "feature");
		const head = commitFile(repo, "app.txt", "base\nfeature\n", "feature");
		const before = patchSeries(repo, base, head);

		git(repo, "config", "diff.noprefix", "true");

		expect(patchSeries(repo, base, head)).toEqual(before);
	});

	test("ambient Git variables cannot alter fingerprints or inject replay hooks", () => {
		const repo = repoWith("app.txt", "base\n");
		const base = git(repo, "rev-parse", "main");
		git(repo, "checkout", "-qb", "feature");
		const head = commitFile(repo, "app.txt", "base\nfeature\n", "feature");
		const authorized = stamp(repo, base, head);
		const injectedHooks = path.join(path.dirname(repo), "injected-hooks");
		fs.mkdirSync(injectedHooks);
		const hook = path.join(injectedHooks, "post-checkout");
		fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n");
		fs.chmodSync(hook, 0o755);
		const savedCount = process.env.GIT_CONFIG_COUNT;
		const savedKey = process.env.GIT_CONFIG_KEY_0;
		const savedValue = process.env.GIT_CONFIG_VALUE_0;
		const savedDiffOptions = process.env.GIT_DIFF_OPTS;

		try {
			process.env.GIT_CONFIG_COUNT = "1";
			process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
			process.env.GIT_CONFIG_VALUE_0 = injectedHooks;
			process.env.GIT_DIFF_OPTS = "--unified=9";
			expect(stampSurvivesAt(authorized, repo, base, head)).toBe(true);
		} finally {
			if (savedCount === undefined) delete process.env.GIT_CONFIG_COUNT;
			else process.env.GIT_CONFIG_COUNT = savedCount;
			if (savedKey === undefined) delete process.env.GIT_CONFIG_KEY_0;
			else process.env.GIT_CONFIG_KEY_0 = savedKey;
			if (savedValue === undefined) delete process.env.GIT_CONFIG_VALUE_0;
			else process.env.GIT_CONFIG_VALUE_0 = savedValue;
			if (savedDiffOptions === undefined) delete process.env.GIT_DIFF_OPTS;
			else process.env.GIT_DIFF_OPTS = savedDiffOptions;
		}
	});

	test("an appended commit dies", () => {
		const repo = repoWith("app.txt", "base\n");
		const base = git(repo, "rev-parse", "main");
		git(repo, "checkout", "-qb", "feature");
		const stampedHead = commitFile(repo, "app.txt", "base\none\n", "one");
		const authorized = stamp(repo, base, stampedHead);
		const appendedHead = commitFile(repo, "other.txt", "unreviewed\n", "two");

		expect(stampSurvivesAt(authorized, repo, base, appendedHead)).toBe(false);
	});

	test("an amended commit dies", () => {
		const repo = repoWith("app.txt", "base\n");
		const base = git(repo, "rev-parse", "main");
		git(repo, "checkout", "-qb", "feature");
		const stampedHead = commitFile(repo, "app.txt", "base\nreviewed\n", "feature");
		const authorized = stamp(repo, base, stampedHead);

		fs.writeFileSync(path.join(repo, "app.txt"), "base\nunreviewed\n");
		git(repo, "add", "-A");
		git(repo, "commit", "--amend", "-qm", "feature");
		const amendedHead = git(repo, "rev-parse", "HEAD");

		expect(stampSurvivesAt(authorized, repo, base, amendedHead)).toBe(false);
	});

	test("a rebase whose conflict is resolved dies", () => {
		const repo = repoWith("mode.ts", "export function mode() {\n\treturn \"base\";\n}\n");
		const base = git(repo, "rev-parse", "main");
		git(repo, "checkout", "-qb", "feature");
		const stampedHead = commitFile(repo, "mode.ts", "export function mode() {\n\treturn \"feature\";\n}\n", "feature mode");
		const authorized = stamp(repo, base, stampedHead);

		git(repo, "checkout", "-q", "main");
		const movedMain = commitFile(repo, "mode.ts", "export function mode() {\n\treturn \"main\";\n}\n", "main mode");
		git(repo, "checkout", "-q", "feature");
		const conflicted = spawnSync("git", ["rebase", "main"], { cwd: repo, encoding: "utf8" });
		expect(conflicted.status).not.toBe(0);

		fs.writeFileSync(path.join(repo, "mode.ts"), "export function mode() {\n\treturn \"feature-main\";\n}\n");
		git(repo, "add", "-A");
		git(repo, "-c", "core.editor=true", "rebase", "--continue");
		const resolvedHead = git(repo, "rev-parse", "HEAD");

		expect(stampSurvivesAt(authorized, repo, movedMain, resolvedHead)).toBe(false);
	});

	test("moving a Python return across an indentation boundary dies", () => {
		const baseSource = "def choose(enabled):\n    if enabled:\n        print(\"yes\")\n";
		const inside = `${baseSource}        return 1\n`;
		const outside = `${baseSource}    return 1\n`;
		const repo = repoWith("choose.py", baseSource);
		const base = git(repo, "rev-parse", "main");
		git(repo, "checkout", "-qb", "feature");
		const insideHead = commitFile(repo, "choose.py", inside, "return inside if");
		const authorized = stamp(repo, base, insideHead);

		git(repo, "reset", "--hard", base);
		const outsideHead = commitFile(repo, "choose.py", outside, "return after if");
		const current = patchSeries(repo, base, outsideHead);

		// This proves the fixture guards the exact regression: stable collapses the
		// semantic indentation change while the production verbatim ids do not.
		expect(patchSeriesWith(repo, base, insideHead, "--stable")).toEqual(patchSeriesWith(repo, base, outsideHead, "--stable"));
		expect(stampSurvives(authorized, current)).toBe(false);
	});

	test("an identical hunk relocated between duplicate contexts dies", () => {
		const block = "alpha\nbeta\ntarget\ngamma\ndelta\n";
		const baseSource = `${block}filler one\nfiller two\nfiller three\nfiller four\n${block}`;
		const firstLocation = baseSource.replace("target", "authorized");
		const secondOffset = baseSource.lastIndexOf("target");
		const secondLocation = `${baseSource.slice(0, secondOffset)}authorized${baseSource.slice(secondOffset + "target".length)}`;
		const repo = repoWith("duplicate.txt", baseSource);
		const base = git(repo, "rev-parse", "main");
		git(repo, "checkout", "-qb", "feature");
		const stampedHead = commitFile(repo, "duplicate.txt", firstLocation, "change first block");
		const authorized = stamp(repo, base, stampedHead);

		git(repo, "reset", "--hard", base);
		const relocatedHead = commitFile(repo, "duplicate.txt", secondLocation, "change second block");
		const current = patchSeries(repo, base, relocatedHead);

		// Patch ids omit hunk line numbers, so the fast pre-filter collides. The
		// authoritative replay must still compare the resulting trees and deny.
		expect(stampSurvives(authorized, current)).toBe(true);
		expect(stampSurvivesAt(authorized, repo, base, relocatedHead)).toBe(false);
	});

	test("only an exact ordered non-empty sequence authorizes", () => {
		const authorized: Stamp = { patchIds: ["one", "two"], base: "base", head: "head", at: 1 };
		expect(stampSurvives(authorized, ["one", "two"])).toBe(true);
		expect(stampSurvives(authorized, ["one", "two", "three"])).toBe(false);
		expect(stampSurvives(authorized, ["one"])).toBe(false);
		expect(stampSurvives(authorized, ["two", "one"])).toBe(false);
		expect(stampSurvives(authorized, ["one", "changed"])).toBe(false);
		expect(stampSurvives({ ...authorized, revoked: 0 }, ["one", "two"])).toBe(false);
		expect(stampSurvives({ ...authorized, patchIds: [] }, [])).toBe(false);
	});

	test("an uncomputable current series fails closed", () => {
		const repo = repoWith("app.txt", "base\n");
		const base = git(repo, "rev-parse", "main");
		git(repo, "checkout", "-qb", "feature");
		const head = commitFile(repo, "app.txt", "base\nfeature\n", "feature");
		const authorized = stamp(repo, base, head);

		expect(() => patchSeries(repo, "missing-base", head)).toThrow();
		expect(stampSurvivesAt(authorized, repo, "missing-base", head)).toBe(false);
	});
});
