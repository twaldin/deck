/**
 * Installed-shape tests for the four standalone pi extensions.
 *
 * Source entrypoints import ../v2/src/*. Their directory symlinks and the
 * shared v2/src symlink tree must preserve that relative layout without
 * exposing a support module as another pi entrypoint.
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
	fs.mkdirSync(path.join(workflowsSource, ".smithers"), { recursive: true });
	fs.writeFileSync(path.join(workflowsSource, ".smithers", "package.json"), '{"name":"fixture","dependencies":{}}\n');
	for (const item of ["agents.ts", "bunfig.toml", "preload.ts", "smithers.config.ts", "smithers.toon"]) fs.writeFileSync(path.join(workflowsSource, ".smithers", item), item === "bunfig.toml" ? "logLevel = \"debug\"\n" : `fixture ${item}\n`);
	fs.copyFileSync(path.join(REPO_V2, "..", "workflows", ".smithers", "bun.lock"), path.join(workflowsSource, ".smithers", "bun.lock"));
	fs.mkdirSync(path.join(workflowsSource, ".smithers", "ui"));
	fs.writeFileSync(path.join(workflowsSource, ".smithers", "ui", "fixture.tsx"), "fixture\n");
	fs.mkdirSync(path.join(workflowsSource, ".smithers", "workflows"));
	fs.writeFileSync(path.join(workflowsSource, ".smithers", "workflows", "keep.tsx"), "fixture workflow\n");
	fs.mkdirSync(path.join(workflowsSource, "pr-pipeline", "lib"), { recursive: true });
	fs.writeFileSync(path.join(workflowsSource, "pr-pipeline", "lib", "models.ts"), "fixture models\n");
});

afterEach(() => {
	fs.rmSync(target, { recursive: true, force: true });
});

function install(): void {
	execFileSync(path.join(REPO_V2, "install.sh"), [], {
		env: {
			...process.env,
			DECK_V2_HOME: path.join(target, "home"),
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

const extensionDir = (name: string) => path.join(target, "agent", "extensions", name);

describe("installer layout", () => {
	test("installs four directory extensions with one entrypoint each", () => {
		install();
		for (const name of ["deck-questions", "deck-ship", "deck-recall", "deck-usage"]) {
			const entry = path.join(extensionDir(name), "index.ts");
			expect(fs.lstatSync(entry).isSymbolicLink()).toBe(true);
			expect(fs.realpathSync(entry)).toBe(
				path.join(REPO_V2, "..", "extensions-pi", `${name}.ts`),
			);
			expect(fs.existsSync(path.join(target, "agent", "extensions", `${name}.ts`))).toBe(false);
		}
		expect(fs.existsSync(extensionDir("deck-v2"))).toBe(false);
		expect(fs.realpathSync(path.join(target, "agent", "extensions", "node_modules", "typebox"))).toBe(
			fs.realpathSync(path.join(REPO_V2, "node_modules", "typebox")),
		);
	});

	test("entrypoint imports resolve through the shared v2 source tree", () => {
		install();
		const lib = path.join(target, "agent", "extensions", "v2", "src");
		for (const module of ["questions-store", "workflow-questions", "questions", "ship", "smithers", "workspace", "hydrate", "home", "meta"]) {
			const installed = path.join(lib, `${module}.ts`);
			expect(fs.lstatSync(installed).isSymbolicLink()).toBe(true);
			expect(fs.realpathSync(installed)).toBe(path.join(REPO_V2, "src", `${module}.ts`));
		}
		expect(fs.existsSync(path.join(lib, "index.ts"))).toBe(false);
	});

	test("refuses a foreign shared v2 support directory", () => {
		const foreign = path.join(target, "agent", "extensions", "v2");
		fs.mkdirSync(foreign, { recursive: true });
		fs.writeFileSync(path.join(foreign, "keep.txt"), "not Deck\n");
		expect(() => install()).toThrow();
		expect(fs.readFileSync(path.join(foreign, "keep.txt"), "utf8")).toBe("not Deck\n");
		expect(fs.existsSync(path.join(foreign, "src"))).toBe(false);
	});

	test("removes a provably owned retired deck-v2 extension", () => {
		const retired = extensionDir("deck-v2");
		fs.mkdirSync(path.join(retired, "extension"), { recursive: true });
		fs.symlinkSync(
			path.join(REPO_V2, "src", "extension", "index.ts"),
			path.join(retired, "extension", "index.ts"),
		);
		fs.writeFileSync(
			path.join(retired, "index.ts"),
			'export { default } from "./extension/index.ts";\n',
		);
		install();
		expect(fs.existsSync(retired)).toBe(false);
	});

	test("REGRESSION: installing does not overwrite the repo's own src/index.ts", () => {
		const before = fs.readFileSync(path.join(REPO_V2, "src", "index.ts"), "utf8");
		install();
		install();
		expect(fs.readFileSync(path.join(REPO_V2, "src", "index.ts"), "utf8")).toBe(before);
	});

	test("reruns converge", () => {
		install();
		const first = ["deck-questions", "deck-ship", "deck-recall", "deck-usage"].map((name) =>
			fs.realpathSync(path.join(extensionDir(name), "index.ts"))
		);
		install();
		expect(["deck-questions", "deck-ship", "deck-recall", "deck-usage"].map((name) =>
			fs.realpathSync(path.join(extensionDir(name), "index.ts"))
		)).toEqual(first);
	});

	test("installs the CLI shim", () => {
		install();
		const shim = path.join(target, "bin", "deck-v2");
		expect(fs.existsSync(shim)).toBe(true);
		expect(fs.realpathSync(shim)).toBe(path.join(REPO_V2, "bin", "deck-v2"));
	});

	test("installs the deck allocator shim pointing at cli/bin/deck", () => {
		install();
		const shim = path.join(target, "bin", "deck");
		expect(fs.lstatSync(shim).isSymbolicLink()).toBe(true);
		expect(fs.realpathSync(shim)).toBe(
			fs.realpathSync(path.join(REPO_V2, "..", "cli", "bin", "deck")),
		);
	});

	test("installs pinned pi without relying on a global Node package", () => {
		install();
		const shim = path.join(target, "bin", "pi");
		const expectedVersion = JSON.parse(
			fs.readFileSync(
				path.join(REPO_V2, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
				"utf8",
			),
		).version;
		expect(fs.readFileSync(shim, "utf8")).toContain("deck pi shim");
		expect(execFileSync(shim, ["--version"], { encoding: "utf8" }).trim()).toBe(expectedVersion);
		expect(fs.realpathSync(path.join(target, "agent", "extensions", "deck-subagents", "node_modules", "typebox"))).toBe(
			fs.realpathSync(path.join(REPO_V2, "node_modules", "typebox")),
		);
	});

	test("refuses a foreign non-symlink deck on the bin path", () => {
		const bin = path.join(target, "bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, "deck"), "#!/bin/sh\n# someone else's deck\n");
		expect(() => install()).toThrow();
		expect(fs.readFileSync(path.join(bin, "deck"), "utf8")).toContain("someone else's");
	});

	test("copies the isolated Smithers workspace and installs its dependencies", () => {
		install();
		const workspace = path.join(target, "home", "state", "smithers");
		for (const item of ["package.json", "agents.ts", "bunfig.toml", "preload.ts", "smithers.config.ts", "smithers.toon", "ui/fixture.tsx"]) expect(fs.existsSync(path.join(workspace, ".smithers", item))).toBe(true);
		expect(fs.readFileSync(path.join(workspace, "pr-pipeline", "lib", "models.ts"), "utf8")).toBe("fixture models\n");
		expect(fs.existsSync(path.join(workspace, ".smithers", "node_modules"))).toBe(true);
	});

	test("pack refresh removes seeded workflows deleted by Deck", () => {
		install();
		const installedWorkflows = path.join(target, "home", "state", "smithers", ".smithers", "workflows");
		fs.writeFileSync(path.join(installedWorkflows, "post-failure.tsx"), "stale seeded workflow\n");
		install();
		expect(fs.existsSync(path.join(installedWorkflows, "post-failure.tsx"))).toBe(false);
		expect(fs.readFileSync(path.join(installedWorkflows, "keep.tsx"), "utf8")).toBe("fixture workflow\n");
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
				DECK_V2_HOME: "",
				INSTALL_TARGET: "",
				BIN_TARGET: path.join(target, "bin"),
				WORKFLOWS_SOURCE: workflowsSource,
				WORKFLOWS_LINK: path.join(target, "home", "workflows"),
			},
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		for (const name of ["deck-questions", "deck-ship", "deck-recall", "deck-usage"]) {
			expect(fs.existsSync(path.join(target, ".deck", ".pi", "extensions", name, "index.ts"))).toBe(true);
		}
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
