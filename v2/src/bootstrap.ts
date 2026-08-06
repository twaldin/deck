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
import {
	assertHomeIsNotACheckout,
	assertHomeIsNotAnotherFleet,
	deckV2Home,
	realpathOrNearest,
} from "./home";
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
	/** Host-local persistence root. It must live outside home. */
	durableRoot?: string;
	/** Pass false for an intentionally offline bootstrap; options are a test seam. */
	optMem?: EnsureOptMemOptions | false;
};

export type EnsureOptMemOptions = {
	memoPath?: string;
	installerPath?: string;
	runInstaller?: (installerPath: string) => void;
};

export const DURABLE_DIRECTORY_NAMES = [
	"archive",
	"backups",
	"broker",
	"config",
	"data",
	"efforts",
	"intake",
	"questions",
	"repos",
	"state",
	"wt",
] as const;

export const DURABLE_FILE_NAMES = [".deck-profile", ".env", "worktrees.json"] as const;
export const ARCHIVE_ONCE_NAMES = [".pi"] as const;
export const DURABLE_LINK_NAMES: readonly string[] = [
	...DURABLE_DIRECTORY_NAMES,
	...DURABLE_FILE_NAMES,
];

const DURABLE_MANIFEST_NAME = ".deck-durable.json";

type DurableManifest = {
	version: 1;
	home: string;
	host: string;
	entries: string[];
	archiveOnce: string[];
};

function statOrUndefined(file: string): fs.Stats | undefined {
	try {
		return fs.lstatSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}


export function durableRootForHome(home: string, configured?: string): string {
	const resolvedHome = path.resolve(home);
	const resolvedRoot = path.resolve(configured ?? process.env.DECK_DURABLE_HOME ?? `${resolvedHome}-durable`);
	const relative = path.relative(realpathOrNearest(resolvedHome), realpathOrNearest(resolvedRoot));
	if (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	) {
		throw new Error(`durable Deck data must live outside the wipe path ${resolvedHome}: ${resolvedRoot}`);
	}
	return resolvedRoot;
}

function filesEqual(left: string, right: string): boolean {
	const leftStat = fs.statSync(left);
	const rightStat = fs.statSync(right);
	if (leftStat.size !== rightStat.size) return false;
	const leftFd = fs.openSync(left, "r");
	const rightFd = fs.openSync(right, "r");
	const leftBuffer = Buffer.allocUnsafe(64 * 1024);
	const rightBuffer = Buffer.allocUnsafe(64 * 1024);
	try {
		let position = 0;
		while (position < leftStat.size) {
			const length = Math.min(leftBuffer.length, leftStat.size - position);
			const leftRead = fs.readSync(leftFd, leftBuffer, 0, length, position);
			const rightRead = fs.readSync(rightFd, rightBuffer, 0, length, position);
			if (
				leftRead !== rightRead ||
				!leftBuffer.subarray(0, leftRead).equals(rightBuffer.subarray(0, rightRead))
			) return false;
			position += leftRead;
		}
		return true;
	} finally {
		fs.closeSync(leftFd);
		fs.closeSync(rightFd);
	}
}

function movePath(source: string, target: string): void {
	try {
		fs.renameSync(source, target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		fs.cpSync(source, target, {
			recursive: true,
			force: false,
			errorOnExist: true,
			preserveTimestamps: true,
		});
		fs.rmSync(source, { recursive: true, force: true });
	}
}

/** Merge without choosing a winner: identical collisions collapse; divergent data aborts intact. */
function mergeWithoutClobber(source: string, target: string): void {
	const targetStat = statOrUndefined(target);
	if (targetStat === undefined) {
		movePath(source, target);
		return;
	}
	const sourceStat = fs.lstatSync(source);
	if (sourceStat.isDirectory() && targetStat.isDirectory()) {
		for (const name of fs.readdirSync(source)) {
			mergeWithoutClobber(path.join(source, name), path.join(target, name));
		}
		fs.rmdirSync(source);
		return;
	}
	if (sourceStat.isFile() && targetStat.isFile() && filesEqual(source, target)) {
		fs.rmSync(source);
		return;
	}
	if (
		sourceStat.isSymbolicLink() &&
		targetStat.isSymbolicLink() &&
		fs.readlinkSync(source) === fs.readlinkSync(target)
	) {
		fs.rmSync(source);
		return;
	}
	throw new Error(`refusing to choose between divergent durable Deck entries: ${source} and ${target}`);
}

function writeDurableManifest(root: string, home: string): void {
	const manifestPath = path.join(root, DURABLE_MANIFEST_NAME);
	const current = statOrUndefined(manifestPath);
	const expectedHome = path.resolve(home);
	const expectedHost = os.hostname();
	if (current !== undefined) {
		if (!current.isFile()) throw new Error(`durable Deck ownership manifest is not a file: ${manifestPath}`);
		let manifest: DurableManifest;
		try {
			manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as DurableManifest;
		} catch {
			throw new Error(`invalid durable Deck ownership manifest: ${manifestPath}`);
		}
		if (manifest.version !== 1 || manifest.home !== expectedHome || manifest.host !== expectedHost) {
			throw new Error(
				`durable Deck root belongs to another home or host: ${manifestPath} ` +
				`(expected ${expectedHost}:${expectedHome})`,
			);
		}
	}
	const manifest: DurableManifest = {
		version: 1,
		home: expectedHome,
		host: expectedHost,
		entries: [...DURABLE_LINK_NAMES],
		archiveOnce: [...ARCHIVE_ONCE_NAMES],
	};
	const staged = path.join(root, `${DURABLE_MANIFEST_NAME}.${process.pid}.tmp`);
	fs.writeFileSync(staged, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(staged, manifestPath);
	fs.chmodSync(manifestPath, 0o600);
}

function validateVisibleDurableEntries(home: string, root: string): void {
	const manifestExists = statOrUndefined(path.join(root, DURABLE_MANIFEST_NAME))?.isFile() === true;
	for (const name of DURABLE_DIRECTORY_NAMES) {
		const visible = path.join(home, name);
		const stat = statOrUndefined(visible);
		if (stat?.isSymbolicLink()) {
			const actual = path.resolve(path.dirname(visible), fs.readlinkSync(visible));
			if (!manifestExists || actual !== path.join(root, name)) {
				throw new Error(`refusing unowned durable Deck link ${visible} -> ${fs.readlinkSync(visible)}`);
			}
		} else if (stat !== undefined && !stat.isDirectory()) {
			throw new Error(`durable Deck entry is not a directory: ${visible}`);
		}
	}
	for (const name of DURABLE_FILE_NAMES) {
		const visible = path.join(home, name);
		const stat = statOrUndefined(visible);
		if (stat?.isSymbolicLink()) {
			const actual = path.resolve(path.dirname(visible), fs.readlinkSync(visible));
			if (!manifestExists || actual !== path.join(root, name)) {
				throw new Error(`refusing unowned durable Deck link ${visible} -> ${fs.readlinkSync(visible)}`);
			}
		} else if (stat !== undefined && !stat.isFile()) {
			throw new Error(`durable Deck entry is not a file: ${visible}`);
		}
	}
	const retiredPi = statOrUndefined(path.join(home, ".pi"));
	if (retiredPi !== undefined && (!retiredPi.isDirectory() || retiredPi.isSymbolicLink())) {
		throw new Error(`refusing to archive non-directory retired Pi profile: ${path.join(home, ".pi")}`);
	}
}

function adoptDirectory(
	home: string,
	root: string,
	name: string,
	created: string[],
	linked: string[],
	notes: string[],
): void {
	const visible = path.join(home, name);
	const durable = path.join(root, name);
	const visibleStat = statOrUndefined(visible);
	if (visibleStat?.isSymbolicLink()) {
		const actual = path.resolve(path.dirname(visible), fs.readlinkSync(visible));
		if (actual !== durable) {
			throw new Error(`refusing unowned durable Deck link ${visible} -> ${fs.readlinkSync(visible)}`);
		}
		if (!fs.statSync(durable).isDirectory()) {
			throw new Error(`durable Deck directory target is not a directory: ${durable}`);
		}
		fs.chmodSync(durable, 0o700);
		return;
	}
	if (visibleStat !== undefined && !visibleStat.isDirectory()) {
		throw new Error(`durable Deck entry is not a directory: ${visible}`);
	}
	if (visibleStat !== undefined) {
		mergeWithoutClobber(visible, durable);
		notes.push(`adopted durable ${visible} at ${durable}`);
	} else if (statOrUndefined(durable) === undefined) {
		fs.mkdirSync(durable, { recursive: true, mode: 0o700 });
		created.push(durable);
	}
	if (!fs.statSync(durable).isDirectory()) {
		throw new Error(`durable Deck directory target is not a directory: ${durable}`);
	}
	fs.chmodSync(durable, 0o700);
	fs.symlinkSync(durable, visible, "dir");
	linked.push(visible);
}

function adoptFile(
	home: string,
	root: string,
	name: string,
	initialBody: string,
	created: string[],
	linked: string[],
	notes: string[],
): void {
	const visible = path.join(home, name);
	const durable = path.join(root, name);
	const visibleStat = statOrUndefined(visible);
	if (visibleStat?.isSymbolicLink()) {
		const actual = path.resolve(path.dirname(visible), fs.readlinkSync(visible));
		if (actual !== durable) {
			throw new Error(`refusing unowned durable Deck link ${visible} -> ${fs.readlinkSync(visible)}`);
		}
		if (!fs.statSync(durable).isFile()) {
			throw new Error(`durable Deck file target is not a file: ${durable}`);
		}
		fs.chmodSync(durable, 0o600);
		return;
	}
	if (visibleStat !== undefined && !visibleStat.isFile()) {
		throw new Error(`durable Deck entry is not a file: ${visible}`);
	}
	if (visibleStat !== undefined) {
		mergeWithoutClobber(visible, durable);
		notes.push(`adopted durable ${visible} at ${durable}`);
	} else if (statOrUndefined(durable) === undefined) {
		fs.writeFileSync(durable, initialBody, { mode: 0o600, flag: "wx" });
		created.push(durable);
	}
	if (!fs.statSync(durable).isFile()) {
		throw new Error(`durable Deck file target is not a file: ${durable}`);
	}
	fs.chmodSync(durable, 0o600);
	fs.symlinkSync(durable, visible, "file");
	linked.push(visible);
}

function archiveRetiredPi(home: string, root: string, notes: string[]): void {
	const retired = path.join(home, ".pi");
	const retiredStat = statOrUndefined(retired);
	if (retiredStat === undefined) return;
	if (!retiredStat.isDirectory() || retiredStat.isSymbolicLink()) {
		throw new Error(`refusing to archive non-directory retired Pi profile: ${retired}`);
	}
	const archive = path.join(root, "archive", "retired-pi-profile");
	mergeWithoutClobber(retired, archive);
	notes.push(`archived retired Pi profile at ${archive}; it is not part of the live Prime home`);
}

function hardenCredentialStore(broker: string): void {
	const visit = (entry: string): void => {
		const stat = fs.lstatSync(entry);
		if (stat.isSymbolicLink()) {
			throw new Error(`broker credential store must not contain symlinks: ${entry}`);
		}
		if (stat.isDirectory()) {
			fs.chmodSync(entry, 0o700);
			for (const name of fs.readdirSync(entry)) visit(path.join(entry, name));
			return;
		}
		if (stat.isFile()) fs.chmodSync(entry, 0o600);
	};
	visit(broker);
}

function configureDurableHome(
	home: string,
	configuredRoot: string | undefined,
	created: string[],
	linked: string[],
	notes: string[],
): string {
	const root = durableRootForHome(home, configuredRoot);
	assertHomeIsNotACheckout(root);
	validateVisibleDurableEntries(home, root);
	if (statOrUndefined(root) === undefined) {
		fs.mkdirSync(root, { recursive: true, mode: 0o700 });
		created.push(root);
	}
	if (!fs.statSync(root).isDirectory()) throw new Error(`durable Deck root is not a directory: ${root}`);
	fs.chmodSync(root, 0o700);
	writeDurableManifest(root, home);
	for (const name of DURABLE_DIRECTORY_NAMES) {
		adoptDirectory(home, root, name, created, linked, notes);
	}
	archiveRetiredPi(home, root, notes);
	adoptFile(home, root, ".deck-profile", "", created, linked, notes);
	adoptFile(home, root, ".env", "", created, linked, notes);
	adoptFile(home, root, "worktrees.json", '{\n\t"v": 1,\n\t"entries": []\n}\n', created, linked, notes);
	hardenCredentialStore(path.join(root, "broker"));
	return root;
}

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
	const durableRoot = durableRootForHome(home, options.durableRoot);
	assertHomeIsNotACheckout(durableRoot);

	// Paths are derived from `home`, never from the env-reading helpers. Mixing the
	// two split a home in half: AGENTS.md landed in the requested directory while
	// durable records landed in whatever DECK_V2_HOME said.
	const created: string[] = [];
	const linked: string[] = [];
	if (!fs.existsSync(home)) {
		fs.mkdirSync(home, { recursive: true, mode: 0o700 });
		created.push(home);
	}
	if (!fs.statSync(home).isDirectory()) throw new Error(`Deck home is not a directory: ${home}`);
	fs.chmodSync(home, 0o700);
	configureDurableHome(home, durableRoot, created, linked, notes);

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

