/**
 * Create the orchestrator's home.
 *
 * The home is a plain directory, deliberately not a checkout (see home.ts). It
 * holds what the orchestrator needs to do its JOB:
 *
 *   ~/deck/
 *     AGENTS.md   -> symlink into the repo's v2/AGENTS.md   (the contract)
 *     .pi/extensions/deck-v2/                               (its own tools)
 *     data/       captain.md · learnings.md · projects.md · <id>/brief.md
 *     state/      <id>.status · <id>.meta · <id>.queue · cursors
 *
 * The contract is a symlink, not a copy, so improving it is an ordinary repo
 * commit and every home picks the change up. data/ and state/ are private and
 * live only here.
 *
 * The repo is now just another project the orchestrator dispatches against, so
 * the repo's own AGENTS.md stays what it should be: project memory for whoever
 * works ON deck.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { assertHomeIsNotACheckout, dataDir, deckV2Home, memoryFiles, stateDir } from "./home";

export type BootstrapResult = {
	home: string;
	created: string[];
	linked: string[];
	notes: string[];
};

const CAPTAIN_SEED = `# Captain profile

How he works, what he wants, how to talk to him. Curated: rewrite on a change,
never append forever.

## Communication
- Catch-up first. He moves across many PRs fast and arrives with no context in
  his head: one-line summary, then the point. Short.
- Technical language is fine for him. Team-facing text is ASD-STE100 Simplified
  Technical English with zero internal jargon.
- Every PR reference carries its full https URL.

## Authority
- He gives the word on every merge. Nothing merges without it.
- Destructive, irreversible and security-sensitive actions are always his.
- Routine gates inside work he already authorized are yours.
`;

const LEARNINGS_SEED = `# Learnings

Dated, evidence-backed operational facts. Curated: rewrite and prune, never
append forever. A fact with no evidence is a guess.
`;

const PROJECTS_SEED = `# Projects

Navigation registry: where each project is checked out and how work reaches it.
The orchestrator reads projects; workers change them.
`;

/** Create or converge the home. Idempotent. */
export function bootstrapHome(options: { repoV2Dir: string; home?: string } = { repoV2Dir: "" }): BootstrapResult {
	const home = options.home ?? deckV2Home();
	assertHomeIsNotACheckout(home);

	const created: string[] = [];
	const linked: string[] = [];
	const notes: string[] = [];

	for (const dir of [home, dataDir(), stateDir()]) {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			created.push(dir);
		}
	}

	// The contract is COPIED once, not symlinked. The captain owns ~/.deck/AGENTS.md
	// and edits it in place; a symlink would make his edits a repo diff, and a
	// regenerating installer would silently overwrite them.
	if (options.repoV2Dir.length > 0) {
		const source = path.join(options.repoV2Dir, "seed", "orchestrator-contract.md");
		const target = path.join(home, "AGENTS.md");
		if (!fs.existsSync(source)) {
			notes.push(`no contract seed at ${source}`);
		} else if (fs.existsSync(target)) {
			notes.push(`${target} already exists; left alone (it is yours to edit)`);
		} else {
			// Strip the seed's build-time HTML comment: it explains why the file is
			// not named AGENTS.md in the repo, which is guidance for whoever works on
			// deck, not an operating instruction for the agent that reads it.
			const seeded = fs.readFileSync(source, "utf8").replace(/<!--[\s\S]*?-->\n\n?/, "");
			fs.writeFileSync(target, seeded, { mode: 0o600 });
			created.push(target);
		}
	}

	// Memory files are seeded once, then owned by the orchestrator.
	const memory = memoryFiles();
	for (const [file, seed] of [
		[memory.captain, CAPTAIN_SEED],
		[memory.learnings, LEARNINGS_SEED],
		[memory.projects, PROJECTS_SEED],
	] as const) {
		if (!fs.existsSync(file)) {
			fs.writeFileSync(file, seed, { mode: 0o600 });
			created.push(file);
		}
	}

	return { home, created, linked, notes };
}

function isLink(target: string): boolean {
	try {
		return fs.lstatSync(target).isSymbolicLink();
	} catch {
		return false;
	}
}

function readLink(target: string): string | null {
	try {
		return fs.readlinkSync(target);
	} catch {
		return null;
	}
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
	lines.push("This home is not a checkout. The deck repo is a project you dispatch against.");
	return lines.join("\n");
}

/**
 * The orchestrator's live contract: the captain's copy if the home has one, else
 * the shipped seed.
 *
 * Deliberately not in prompts.ts. That file generates DYNAMIC prompts — briefs
 * spliced per task — and holding a second copy of the contract there is what let
 * the two drift ("he wrote most of this" existed in only one of them).
 */
export function orchestratorContract(home = deckV2Home()): string {
	const live = path.join(home, "AGENTS.md");
	if (fs.existsSync(live)) return fs.readFileSync(live, "utf8");
	return fs.readFileSync(path.join(import.meta.dir, "..", "seed", "orchestrator-contract.md"), "utf8");
}
