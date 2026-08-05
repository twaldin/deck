/**
 * Packaging regression tests for Deck's two pi-extension installers.
 *
 * Both bugs guarded here actually shipped to a live ~/.pi and stopped pi from
 * loading the extension, and neither was caught by a unit test because both are
 * properties of the INSTALLED layout rather than of the source:
 *
 *   1. ponytail: CommonJS hooks copied under a `"type": "module"` package.json
 *      became ESM and threw `require is not defined in ES module scope`.
 *   2. idle-compaction: a single flat symlink resolved its relative
 *      `./idle-compaction-policy` import next to the symlink instead of the
 *      real source, and a flat sibling symlink was then discovered by pi as its
 *      own extension ("does not export a valid factory").
 *
 * These run the real installers into a temp INSTALL_TARGET, never ~/.pi.
 */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

const repoRoot = path.resolve(import.meta.dir, "../..");
const targets: string[] = [];

/**
 * Run a snippet under NODE, not bun. This matters: pi 0.82 ships as a
 * `#!/usr/bin/env node` CLI, and bun's loader is more forgiving about CommonJS
 * under a `"type": "module"` package than node is. Asserting through bun's own
 * `import`/`createRequire` passes even with the bug present, so it would not
 * catch the regression these tests exist for.
 */
function runInNode(source: string): { exitCode: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync([process.env.DECK_TEST_NODE ?? "node", "-e", source], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function runInstaller(
	script: string,
	target: string,
): { exitCode: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync([path.join(repoRoot, script)], {
		env: { ...process.env, INSTALL_TARGET: target },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function freshTarget(): string {
	const target = mkdtempSync(path.join(tmpdir(), "deck-installer-"));
	targets.push(target);
	return target;
}

function install(script: string): string {
	const target = freshTarget();
	const result = runInstaller(script, target);
	expect(result.stderr).toBe("");
	expect(result.exitCode).toBe(0);
	return target;
}

afterAll(() => {
	for (const target of targets) rmSync(target, { recursive: true, force: true });
});

describe("ponytail installer", () => {
	const target = install("ponytail/install.sh");
	const extensionDir = path.join(target, "extensions", "ponytail");

	test("installed entrypoint loads under node and exports a factory", () => {
		const entry = JSON.stringify(path.join(extensionDir, "index.js"));
		const probe = runInNode(
			`import(${entry}).then(m => { if (typeof m.default !== "function") { console.error("no factory"); process.exit(1); } process.stdout.write("factory"); }).catch(e => { console.error(e.message); process.exit(1); })`,
		);
		expect(probe.stderr).toBe("");
		expect(probe.exitCode).toBe(0);
		expect(probe.stdout).toBe("factory");
	});

	test("CommonJS hooks keep their exports under the ESM extension package", () => {
		// The bug's signature under node was silent export loss, so assert the real
		// exports are reachable rather than merely that the require resolved.
		const entry = JSON.stringify(path.join(extensionDir, "index.js"));
		const probe = runInNode(`
			const { createRequire } = require("node:module");
			const r = createRequire(${entry});
			const config = r("./hooks/ponytail-config.js");
			const instructions = r("./hooks/ponytail-instructions.js");
			const text = instructions.getPonytailInstructions("full");
			console.log(JSON.stringify({
				defaultMode: config.DEFAULT_MODE,
				exportCount: Object.keys(config).length,
				ladderChars: text.length,
				hasStdlib: /stdlib/i.test(text),
			}));
		`);
		expect(probe.stderr).toBe("");
		expect(probe.exitCode).toBe(0);
		const observed = JSON.parse(probe.stdout);
		expect(observed.defaultMode).toBe("full");
		expect(observed.exportCount).toBeGreaterThan(5);
		expect(observed.ladderChars).toBeGreaterThan(500);
		expect(observed.hasStdlib).toBe(true);
	});

	test("a hook file executed directly by node stays CommonJS", () => {
		// The exact live failure: `ReferenceError: require is not defined in ES
		// module scope`, which made pi refuse to load the extension entirely.
		// This must EXECUTE the file (node <file>) rather than require() it:
		// node's require(esm) interop swallows the error and reports success.
		const result = Bun.spawnSync(
			[
				process.env.DECK_TEST_NODE ?? "node",
				path.join(extensionDir, "hooks", "ponytail-config.js"),
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.stderr.toString()).not.toMatch(/require is not defined in ES module scope/);
		expect(result.exitCode).toBe(0);
	});

	test("hooks carry the commonjs scope marker that pins them", () => {
		const marker = Bun.file(path.join(extensionDir, "hooks", "package.json"));
		expect(existsSync(path.join(extensionDir, "hooks", "package.json"))).toBe(true);
		return marker.json().then((parsed) => expect(parsed.type).toBe("commonjs"));
	});

	test("all skills install at user scope for discovery", () => {
		for (const skill of [
			"ponytail",
			"ponytail-review",
			"ponytail-audit",
			"ponytail-debt",
			"ponytail-gain",
			"ponytail-help",
		]) {
			expect(existsSync(path.join(target, "skills", skill, "SKILL.md"))).toBe(true);
		}
	});
});

describe("idle-compaction installer", () => {
	const target = install("extensions/install.sh");
	const extensionDir = path.join(target, "extensions", "deck-idle-compaction");
	const nativeExtensionDir = path.join(target, "extensions", "deck-native-compaction");

	test("installs a directory extension whose sibling import resolves", () => {
		expect(lstatSync(extensionDir).isDirectory()).toBe(true);
		// index.ts imports "./idle-compaction-policy"; both must sit together
		// inside the extension directory for that relative import to resolve.
		expect(existsSync(path.join(extensionDir, "index.ts"))).toBe(true);
		expect(existsSync(path.join(extensionDir, "idle-compaction-policy.ts"))).toBe(true);
		expect(realpathSync(path.join(extensionDir, "index.ts"))).toBe(
			realpathSync(path.join(repoRoot, "extensions/src/idle-compaction.ts")),
		);
	});

	test("no flat sibling that pi would discover as its own extension", () => {
		// pi discovers extensions/*.ts as top-level extensions, so a stray
		// policy symlink beside the directory gets loaded and rejected.
		const entries = readdirSync(path.join(target, "extensions")).sort();
		expect(entries).toEqual(["deck-idle-compaction", "deck-native-compaction"]);
	});

	test("the installed entrypoints export factories", async () => {
		const loaded = await import(path.join(extensionDir, "index.ts"));
		const native = await import(path.join(nativeExtensionDir, "index.ts"));
		expect(typeof loaded.default).toBe("function");
		expect(typeof native.default).toBe("function");
	});

	test("reruns converge", () => {
		const before = readdirSync(extensionDir).sort();
		const result = runInstaller("extensions/install.sh", target);
		expect(result.exitCode).toBe(0);
		expect(readdirSync(extensionDir).sort()).toEqual(before);
	});
});

describe("questions retirement", () => {
	// Questions moved to the standalone Deck-home pack: a global install put
	// ask_captain and /questions into unrelated pi sessions.
	test("a previously installed deck-questions of ours is removed", () => {
		const target = freshTarget();
		const old = path.join(target, "extensions", "deck-questions");
		mkdirSync(old, { recursive: true });
		// The old installer symlinked index.ts at extensions/src/questions.ts;
		// point at a same-shaped path elsewhere since that file no longer exists.
		const fakeRepo = path.join(target, "old-repo", "extensions", "src");
		mkdirSync(fakeRepo, { recursive: true });
		writeFileSync(path.join(fakeRepo, "questions.ts"), "export default () => {};\n");
		symlinkSync(path.join(fakeRepo, "questions.ts"), path.join(old, "index.ts"));

		const result = runInstaller("extensions/install.sh", target);
		expect(result.exitCode).toBe(0);
		expect(existsSync(old)).toBe(false);
	});

	test("a deck-questions directory that is not ours is left alone", () => {
		const target = freshTarget();
		const foreign = path.join(target, "extensions", "deck-questions");
		mkdirSync(foreign, { recursive: true });
		writeFileSync(path.join(foreign, "index.ts"), "// someone else's extension\n");

		const result = runInstaller("extensions/install.sh", target);
		expect(result.exitCode).toBe(0);
		expect(existsSync(path.join(foreign, "index.ts"))).toBe(true);
	});
});

describe("idle-compaction installer migration from the old flat layout", () => {
	const flatEntrypoint = "deck-idle-compaction.ts";
	const flatPolicy = "idle-compaction-policy.ts";

	test("removes stale flat symlinks an earlier README told operators to create", () => {
		// Writing the good directory is not enough: pi discovers extensions/*.ts,
		// so a leftover flat entry keeps failing next to a correct install.
		const target = freshTarget();
		const extensions = path.join(target, "extensions");
		mkdirSync(extensions, { recursive: true });
		symlinkSync(
			path.join(repoRoot, "extensions/src/idle-compaction.ts"),
			path.join(extensions, flatEntrypoint),
		);
		symlinkSync(
			path.join(repoRoot, "extensions/src/idle-compaction-policy.ts"),
			path.join(extensions, flatPolicy),
		);

		const result = runInstaller("extensions/install.sh", target);
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(readdirSync(extensions).sort()).toEqual(["deck-idle-compaction", "deck-native-compaction"]);
	});

	test("refuses to delete a user-owned file it cannot prove is ours", () => {
		const target = freshTarget();
		const extensions = path.join(target, "extensions");
		mkdirSync(extensions, { recursive: true });
		const userFile = path.join(extensions, flatEntrypoint);
		writeFileSync(userFile, "export default function () {}\n");

		const result = runInstaller("extensions/install.sh", target);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/not a symlink into/);
		// The operator's file must survive so they can decide what to do with it.
		expect(existsSync(userFile)).toBe(true);
	});
});
