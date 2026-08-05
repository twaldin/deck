/**
 * Create or converge a plain pi home.
 *
 * The home is a private runtime directory, never a checkout. Bootstrap installs
 * OptMem when it is absent, copies the public home contract once, and creates
 * the runtime directories used by the factory. Existing operator-owned files
 * are never overwritten.
 */
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { assertHomeIsNotACheckout, assertHomeIsNotAnotherFleet, deckV2Home } from "./home";
import { seedProfilesFile } from "./projects";

export type BootstrapResult = {
	home: string;
	created: string[];
	linked: string[];
	notes: string[];
};

export type BootstrapOptions = {
	repoV2Dir: string;
	home?: string;
	/** Pass false for an intentionally offline bootstrap; options are a test seam. */
	optMem?: EnsureOptMemOptions | false;
};

export type EnsureOptMemOptions = {
	memoPath?: string;
	installerPath?: string;
	runInstaller?: (installerPath: string) => void;
};

/** Install OptMem once. The wrapper verifies `memo wake` before it returns. */
export function ensureOptMem(repoV2Dir: string, options: EnsureOptMemOptions = {}): "present" | "installed" {
	const memoPath = options.memoPath ?? path.join(os.homedir(), ".optmem", "memo");
	try {
		if (fs.statSync(memoPath).isFile()) {
			fs.accessSync(memoPath, fs.constants.X_OK);
			return "present";
		}
	} catch {
		// Missing or non-executable: run the installer below.
	}
	if (repoV2Dir.length === 0) throw new Error("cannot install OptMem without the deck v2 repository path");

	const installerPath = options.installerPath ?? path.resolve(repoV2Dir, "..", "ops", "install-optmem.sh");
	if (!fs.existsSync(installerPath)) throw new Error(`OptMem installer is missing: ${installerPath}`);
	const runInstaller =
		options.runInstaller ??
		((script: string) => {
			execFileSync(script, { stdio: "inherit" });
		});
	runInstaller(installerPath);
	try {
		if (!fs.statSync(memoPath).isFile()) throw new Error("not a file");
		fs.accessSync(memoPath, fs.constants.X_OK);
	} catch {
		throw new Error(`OptMem installer completed without creating executable ${memoPath}`);
	}
	return "installed";
}

/** Create or converge the home. Idempotent. */
export function bootstrapHome(options: BootstrapOptions = { repoV2Dir: "" }): BootstrapResult {
	const home = options.home ?? deckV2Home();
	// Both guards run against the RESOLVED home. The CLI preflight checks the
	// default home, which is a different path when --home is passed, so relying on
	// it would let `bootstrap --home <legacy fleet>` through.
	assertHomeIsNotACheckout(home);
	assertHomeIsNotAnotherFleet(home);

	const notes: string[] = [];
	if (options.optMem !== false && options.repoV2Dir.length > 0) {
		if (ensureOptMem(options.repoV2Dir, options.optMem) === "installed") {
			notes.push("installed OptMem and verified memo wake");
		}
	}

	// Paths are derived from `home`, never from the env-reading helpers. Mixing the
	// two split a home in half: AGENTS.md landed in the requested directory while
	// data/ and state/ landed in whatever DECK_V2_HOME said.
	const dataPath = path.join(home, "data");
	const statePath = path.join(home, "state");

	const created: string[] = [];
	const linked: string[] = [];

	for (const dir of [home, dataPath, statePath]) {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			created.push(dir);
		}
	}

	// Copy once. The home owner may refine their local contract; bootstrap never
	// turns those edits into a repository diff or overwrites them on an update.
	if (options.repoV2Dir.length > 0) {
		const source = path.join(options.repoV2Dir, "seed", "AGENTS.md");
		const target = path.join(home, "AGENTS.md");
		if (!fs.existsSync(source)) {
			notes.push(`no home contract seed at ${source}`);
		} else if (fs.existsSync(target)) {
			notes.push(`${target} already exists; left alone (it is yours to edit)`);
		} else {
			fs.copyFileSync(source, target);
			fs.chmodSync(target, 0o600);
			created.push(target);
		}
	}

	// Machine-readable project profiles are private home configuration. Seed them
	// once; personal reviewer and routing details also stay under config/.
	const profilesSeeded = seedProfilesFile(home);
	if (profilesSeeded !== null) created.push(profilesSeeded);

	return { home, created, linked, notes };
}

export function formatBootstrap(result: BootstrapResult): string {
	const lines = [`home: ${result.home}`];
	for (const item of result.created) lines.push(`  created ${item}`);
	for (const item of result.linked) lines.push(`  linked  ${item}`);
	for (const item of result.notes) lines.push(`  note    ${item}`);
	if (result.created.length === 0 && result.linked.length === 0) {
		lines.push("  already converged");
	}
	lines.push("");
	lines.push("This is a plain pi runtime home, not a code checkout.");
	return lines.join("\n");
}

