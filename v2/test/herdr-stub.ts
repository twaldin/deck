import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type HerdrStubCall = {
	file: string;
	args: string[];
};

export class HerdrTestGuardError extends Error {
	constructor(args: string[]) {
		super(
			`test attempted to run the live herdr path: herdr ${args.join(" ")}\n` +
			"Enable the explicit herdr test stub before exercising projection intent.",
		);
		this.name = "HerdrTestGuardError";
	}
}

type Reply = Record<string, unknown> | null;

/**
 * Installs fake `herdr` and `ps` executables in a private PATH directory.
 * `herdr` exits loudly unless the test explicitly enables it. This protects
 * tests even when another module imported the production client before the
 * test could replace its child-process dependency.
 */
export function createHerdrTestStub() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-herdr-stub-"));
	const statePath = path.join(root, "state.json");
	const runner = path.join(root, "runner.mjs");
	const calls: HerdrStubCall[] = [];
	const replies = new Map<string, Reply>();
	let enabled = false;

	fs.writeFileSync(
		runner,
		`#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const file = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (file === "ps") process.exit(0);
if (process.env.DECK_V2_HERDR_STUB !== "1") {
  process.stderr.write("herdr test guard: refusing live mutation path\\n");
  process.exit(86);
}
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
state.calls.push({ file, args });
fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
const key = args.slice(0, 2).join(" ");
if (!(key in state.replies)) process.stdout.write(JSON.stringify({ result: {} }));
else if (state.replies[key] === null) process.exit(1);
else process.stdout.write(JSON.stringify({ result: state.replies[key] }));
`,		{ mode: 0o700 },
	);
	for (const name of ["herdr", "ps"]) {
		fs.symlinkSync(runner, path.join(root, name));
	}

	const writeState = () => {
		fs.writeFileSync(statePath, JSON.stringify({ replies: Object.fromEntries(replies), calls }));
	};
	const readCalls = () => {
		try {
			const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as { calls?: HerdrStubCall[] };
			return state.calls ?? calls;
		} catch {
			return calls;
		}
	};

	return {
		path: root,
		calls,
		install() {
			writeState();
			process.env.PATH = `${root}${path.delimiter}${process.env.PATH ?? ""}`;
		},
		enable() {
			enabled = true;
			process.env.DECK_V2_HERDR_STUB = "1";
		},
		disable() {
			enabled = false;
			delete process.env.DECK_V2_HERDR_STUB;
		},
		setReply(command: string, reply: Reply) {
			replies.set(command, reply);
			writeState();
		},
		reset() {
			calls.length = 0;
			replies.clear();
			writeState();
		},
		readCalls,
		assertEnabled() {
			if (!enabled) throw new HerdrTestGuardError(["workspace", "create"]);
		},
		remove() {
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}
