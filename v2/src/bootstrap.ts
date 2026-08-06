/**
 * Create or converge the Deck Prime conversation home.
 *
 * Bootstrap installs OptMem when it is absent, converges the
 * installer-managed public home contract (backing up any local drift), and
 * creates the runtime directories used by the factory.
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

	// AGENTS.md is Deck's public runtime contract, not operator configuration.
	// Keep one authority: every bootstrap converges it to the repository seed.
	// Local drift is preserved under backups/ before the atomic replacement.
	if (options.repoV2Dir.length > 0) {
		const source = path.join(options.repoV2Dir, "seed", "AGENTS.md");
		const target = path.join(home, "AGENTS.md");
		if (!fs.existsSync(source)) {
			notes.push(`no home contract seed at ${source}`);
		} else {
			const sourceBody = fs.readFileSync(source);
			let targetStat: fs.Stats | undefined;
			try {
				targetStat = fs.lstatSync(target);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (targetStat !== undefined && !targetStat.isFile() && !targetStat.isSymbolicLink()) {
				throw new Error(`installer-managed home contract is not a file or symlink: ${target}`);
			}
			const alreadyCurrent =
				targetStat?.isFile() === true && fs.readFileSync(target).equals(sourceBody);
			if (alreadyCurrent) {
				fs.chmodSync(target, 0o644);
			} else {
				if (targetStat !== undefined) {
					const backupRoot = path.join(home, "backups");
					fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
					const backupDir = fs.mkdtempSync(path.join(backupRoot, "AGENTS.md.pre-install-"));
					const backup = path.join(backupDir, "AGENTS.md");
					fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
					fs.chmodSync(backup, 0o600);
					notes.push(`backed up local AGENTS.md to ${backup}`);
				}
				const stageDir = fs.mkdtempSync(path.join(home, ".deck-agents-"));
				const staged = path.join(stageDir, "AGENTS.md");
				try {
					fs.writeFileSync(staged, sourceBody, { mode: 0o644, flag: "wx" });
					fs.renameSync(staged, target);
				} finally {
					fs.rmSync(stageDir, { recursive: true, force: true });
				}
				if (targetStat === undefined) created.push(target);
				else notes.push(`updated installer-managed home contract ${target}`);
			}
		}
	}

	// Machine-readable project profiles are private home configuration. Seed them
	// once; personal reviewer and routing details also stay under config/.
	const profilesSeeded = seedProfilesFile(home);
	if (profilesSeeded !== null) created.push(profilesSeeded);

	const reviewersPath = path.join(home, "config", "reviewers.json");
	if (!fs.existsSync(reviewersPath)) {
		fs.writeFileSync(
			reviewersPath,
			`${JSON.stringify(
				{
					selfLogins: [],
					excludedApprovers: [],
					reviewerDenylist: [],
					reviewers: [],
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600, flag: "wx" },
		);
		created.push(reviewersPath);
	}

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
	lines.push("This is a Prime conversation runtime home, not a code checkout.");
	return lines.join("\n");
}

