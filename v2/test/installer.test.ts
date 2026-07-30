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
let workflowsSource: string;

beforeEach(() => {
	target = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-install-"));
	workflowsSource = path.join(target, "workflows-src");
	fs.mkdirSync(workflowsSource, { recursive: true });
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
			WORKFLOWS_LINK: path.join(target, "home", "workflows"),
			// A fixture, not the real workflows workspace: without this the installer
			// would bun-install the checkout's .smithers on any machine where
			// node_modules is absent — a unit test mutating the repo.
			WORKFLOWS_SOURCE: workflowsSource,
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

	test("installs a pinned smithers shim that matches src/smithers.ts", () => {
		install();
		const shim = path.join(target, "bin", "smithers");
		const body = fs.readFileSync(shim, "utf8");
		const pin = fs
			.readFileSync(path.join(REPO_V2, "src", "smithers.ts"), "utf8")
			.match(/SMITHERS_VERSION = "([^"]+)"/)?.[1];
		expect(pin).toBeDefined();
		expect(body).toContain(`smithers-orchestrator@${pin}`);
		expect(fs.statSync(shim).mode & 0o111).not.toBe(0);
	});

	test("refuses a foreign smithers on the bin path rather than overwriting it", () => {
		const bin = path.join(target, "bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, "smithers"), "#!/bin/sh\n# someone else's smithers\n");
		expect(() => install()).toThrow();
		expect(fs.readFileSync(path.join(bin, "smithers"), "utf8")).toContain("someone else's");
	});

	test("links <home>/workflows to the workflows workspace", () => {
		install();
		const link = path.join(target, "home", "workflows");
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
		expect(fs.realpathSync(link)).toBe(fs.realpathSync(workflowsSource));
		install(); // reruns converge
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
	});

	test("leaves a real (non-symlink) workflows directory alone", () => {
		const link = path.join(target, "home", "workflows");
		fs.mkdirSync(link, { recursive: true });
		fs.writeFileSync(path.join(link, "keep.txt"), "mine\n");
		install();
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
		expect(fs.existsSync(path.join(link, "keep.txt"))).toBe(true);
	});

	test("the default install target is the runtime default home (~/.deck/.pi)", () => {
		// The installer default and deckV2Home() must name the SAME home, or the
		// extension lands in a pi home no orchestrator session ever starts from.
		execFileSync(path.join(REPO_V2, "install.sh"), [], {
			env: {
				...process.env,
				HOME: target,
				INSTALL_TARGET: "",
				DECK_V2_HOME: "",
				BIN_TARGET: path.join(target, "bin"),
			},
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(
			fs.existsSync(path.join(target, ".deck", ".pi", "extensions", "deck-v2", "index.ts")),
		).toBe(true);
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
