import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PYTHON_ROOT = path.join(import.meta.dir, "..", "python");

function runPython(source: string, env: Record<string, string> = {}): { status: number; out: string } {
	const result = spawnSync("python3", ["-c", source], {
		env: { ...process.env, PYTHONPATH: PYTHON_ROOT, ...env },
		encoding: "utf8",
	});
	return { status: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

describe("the deck code surface", () => {
	test("survives non-UTF-8 output from the CLI it shells to", () => {
		// A single Windows-1252 smart quote (byte 0x91) in tool output raised
		// UnicodeDecodeError from inside subprocess and killed four pipeline runs.
		// An encoding accident must never be reported as a Deck failure.
		const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deck-cli-")), "deck-v2");
		fs.writeFileSync(fake, "#!/bin/sh\nprintf '\\221{\"runs\": []}'\n");
		fs.chmodSync(fake, 0o755);

		const { status, out } = runPython(
			"import deck; print('called:', deck.runs() is not None or True)",
			{ DECK_CLI: fake },
		);
		expect(out).not.toContain("UnicodeDecodeError");
		expect(status).toBe(0);
	});

	test("a failing CLI raises DeckError carrying the reason, not a bare crash", () => {
		const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deck-cli-")), "deck-v2");
		fs.writeFileSync(fake, "#!/bin/sh\necho 'no Smithers workspace at /nope' >&2\nexit 1\n");
		fs.chmodSync(fake, 0o755);

		const { out } = runPython(
			"import deck\ntry:\n    deck.runs()\nexcept deck.DeckError as e:\n    print('DeckError:', e)",
			{ DECK_CLI: fake },
		);
		expect(out).toContain("DeckError: no Smithers workspace");
	});

	test("a missing session id fails loudly instead of misrouting an answer", () => {
		// Question ids are scoped to the asking session; a wrong id delivers the
		// user's answer to a different agent, so guessing is not an option.
		const { out } = runPython(
			"import deck\ntry:\n    deck.session_id()\nexcept deck.DeckError as e:\n    print('DeckError:', e)",
			{ RLM_SESSION_DIR: "" },
		);
		expect(out).toContain("RLM_SESSION_DIR is unset");
	});

	test("the kernel tolerates non-UTF-8 tool output without being asked to", () => {
		// The failure that killed four runs was NOT in deck: it was a seat's own
		// `subprocess.run(["rg", ...], text=True)` over a repo containing one
		// Windows-1252 byte. Seats write that shape constantly, so the kernel has to
		// be safe by default rather than every prompt remembering `errors=`.
		const probe = "import subprocess\n"
			+ "r = subprocess.run(['/bin/sh','-c',\"printf 'good\\\\221bad'\"], capture_output=True, text=True)\n"
			+ "print('survived:', r.stdout)";
		const withFix = runPython(probe);
		expect(withFix.out).not.toContain("UnicodeDecodeError");
		expect(withFix.status).toBe(0);

		// And an explicit errors= is still honoured, so nothing is silently masked.
		const explicit = runPython(
			"import subprocess\n"
			+ "try:\n"
			+ "    subprocess.run(['/bin/sh','-c',\"printf 'x\\\\221'\"], capture_output=True, text=True, errors='strict')\n"
			+ "except UnicodeDecodeError:\n"
			+ "    print('strict still raises')",
		);
		expect(explicit.out).toContain("strict still raises");
	});

	test("help() names every callable it exports", () => {
		const { out, status } = runPython(
			"import deck\nmissing = [n for n in deck.__all__ if n not in ('DeckError','help','session_id') and f'deck.{n}' not in deck.help()]\nprint('missing:', missing)",
		);
		expect(status).toBe(0);
		expect(out).toContain("missing: []");
	});
});
