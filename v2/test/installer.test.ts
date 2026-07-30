/**
 * Installer tests. These exist because BOTH shipped deck extensions have broken
 * in ~/.pi while their sources were fine, so what matters is the INSTALLED shape,
 * not the source.
 *
 * Two traps are asserted here, both of which bit during this build:
 *   1. pi resolves an extension's relative imports against the symlink's
 *      directory, so a flat `index.ts -> src/extension/index.ts` cannot find
 *      `../events`.
 *   2. Writing the entrypoint shim over a symlink follows the link and destroys
 *      the repo's own src/index.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_V2 = path.resolve(import.meta.dir, "..");
let target: string;

beforeEach(() => {
	target = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-install-"));
});

afterEach(() => {
	fs.rmSync(target, { recursive: true, force: true });
});

function install(): void {
	execFileSync(path.join(REPO_V2, "install.sh"), [], {
		env: {
			...process.env,
			INSTALL_TARGET: path.join(target, "agent"),
			BIN_TARGET: path.join(target, "bin"),
		},
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

const extDir = () => path.join(target, "agent", "extensions", "deck-v2");

describe("installer layout", () => {
	test("installs a directory extension with exactly one entrypoint", () => {
		install();
		expect(fs.existsSync(path.join(extDir(), "index.ts"))).toBe(true);
		// pi discovers extensions/*.ts too; a flat sibling would load as its own
		// extension and be rejected.
		expect(fs.existsSync(path.join(target, "agent", "extensions", "deck-v2.ts"))).toBe(false);
	});

	// Trap 1: the failure mode observed live ("Cannot find module '../events'").
	test("the entrypoint's relative sibling imports resolve inside the install dir", () => {
		install();
		const entry = fs.readFileSync(path.join(extDir(), "index.ts"), "utf8");
		expect(entry).toContain("./extension/index.ts");
		// extension/index.ts imports ../events, ../fleet, ... — each must exist
		// one level up from it, i.e. at the install root.
		const real = fs.readFileSync(path.join(REPO_V2, "src", "extension", "index.ts"), "utf8");
		const siblings = [...real.matchAll(/from "\.\.\/([a-z-]+)"/g)].map((m) => m[1]);
		expect(siblings.length).toBeGreaterThan(3);
		for (const sibling of siblings) {
			expect(fs.existsSync(path.join(extDir(), `${sibling}.ts`))).toBe(true);
		}
	});

	// Trap 2: the bug this build actually hit. The shim must never be written
	// through a symlink into the repo.
	test("REGRESSION: installing does not overwrite the repo's own src/index.ts", () => {
		const before = fs.readFileSync(path.join(REPO_V2, "src", "index.ts"), "utf8");
		install();
		install(); // reruns must converge, not corrupt
		const after = fs.readFileSync(path.join(REPO_V2, "src", "index.ts"), "utf8");
		expect(after).toBe(before);
		// The lib entrypoint re-exports the modules; it is NOT the extension shim.
		expect(after).toContain("./status");
		expect(after).not.toBe('export { default } from "./extension/index.ts";\n');
	});

	test("the installed entrypoint is a real file, not a symlink", () => {
		install();
		expect(fs.lstatSync(path.join(extDir(), "index.ts")).isSymbolicLink()).toBe(false);
	});

	test("reruns converge", () => {
		install();
		const first = fs.readdirSync(extDir()).sort();
		install();
		expect(fs.readdirSync(extDir()).sort()).toEqual(first);
	});

	test("installs the CLI shim", () => {
		install();
		const shim = path.join(target, "bin", "deck-v2");
		expect(fs.existsSync(shim)).toBe(true);
		expect(fs.realpathSync(shim)).toBe(path.join(REPO_V2, "bin", "deck-v2"));
	});

	test("refuses a foreign flat entry rather than deleting it", () => {
		const extensions = path.join(target, "agent", "extensions");
		fs.mkdirSync(extensions, { recursive: true });
		fs.writeFileSync(path.join(extensions, "deck-v2.ts"), "// someone else's file\n");
		expect(() => install()).toThrow();
		// Still there: we never delete what we cannot prove is ours.
		expect(fs.existsSync(path.join(extensions, "deck-v2.ts"))).toBe(true);
	});
});
