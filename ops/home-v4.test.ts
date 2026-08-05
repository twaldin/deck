import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bootstrapHome, ensureOptMem } from "../v2/src/bootstrap";
import { buildMemorySeed, runCli, writeReviewFile } from "./migrate-memory";

const sandboxes: string[] = [];

function sandbox(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deck-home-v4-"));
	sandboxes.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of sandboxes.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("memory migration", () => {
	test("extracts durable Markdown, rejects temporary sections, deduplicates, and enforces OptMem's byte limit", () => {
		const repeated = "Never bypass the delivery pipeline.";
		const seed = buildMemorySeed([
			{
				source: { label: "Captain", kind: "captain", path: "/captain.md" },
				markdown: `# Profile\n\n## Who & how\n- Prefer concise evidence first.\n- **Never** bypass the delivery pipeline.\n\n## Project autonomy\n| Project | Merge |\n|---|---|\n| Example | Always require an explicit word. |\n\n## Active priorities\n- Never keep this temporary item.\n\n## Rules\n- Never unset PI_SESSION_FILE in a worker.\n- Never mutate _private state or FOO_ identifiers.\n- Never ignore *.status or lindy-ai/* entries.\n- Only remember ${"界".repeat(200)}\n- ${"verification evidence ".repeat(30)}\n`,
			},
			{
				source: { label: "Learning", kind: "learnings", path: "/learnings.md" },
				markdown: `# Learnings\n\n## Landing and merge queues\n- ${repeated}\n- A queue result must be verified against the base branch.\n\n## 2026-01-01\n- Added a dashboard link.\n- A reviewer request silently no-opped.\n`,
			},
		]);

		const lines = seed.trimEnd().split("\n");
		expect(seed).toContain("Captain — Who & how: Prefer concise evidence first.");
		expect(seed).toContain("Project autonomy: Merge: Always require an explicit word.");
		expect(seed).toContain("Learning — Landing and merge queues: Never bypass the delivery pipeline.");
		expect(seed).not.toContain("Never keep this temporary item");
		expect(seed).not.toContain("Added a dashboard link");
		expect(seed).toContain("reviewer request silently no-opped");
		expect(seed).toContain("PI_SESSION_FILE");
		expect(seed).toContain("_private");
		expect(seed).toContain("FOO_");
		expect(seed).toContain("*.status");
		expect(seed).toContain("lindy-ai/*");
		expect(seed).not.toContain("�");
		expect(seed.match(/界/g)).toHaveLength(200);
		expect(lines.filter((line) => line.includes(repeated))).toHaveLength(1);
		expect(lines.every((line) => Buffer.byteLength(line, "utf8") <= 280)).toBe(true);
		expect(lines.filter((line) => line.includes("verification evidence")).length).toBeGreaterThan(1);
	});

	test("fails closed on wrong source paths and option tokens used as values", () => {
		const missing = path.join(sandbox(), "missing-captain.md");
		expect(() => runCli(["--captain", missing])).toThrow(`explicit memory source does not exist: ${missing}`);
		expect(() => runCli(["--output", "--write-review"])).toThrow("--output requires a path value");
	});

	test("writes atomically without overwriting a captain-reviewed edit", () => {
		const output = path.join(sandbox(), "data", "memory-seed.txt");
		expect(writeReviewFile(output, "one\n")).toBe("written");
		expect(fs.statSync(output).mode & 0o777).toBe(0o600);
		expect(writeReviewFile(output, "one\n")).toBe("unchanged");
		fs.writeFileSync(output, "captain edit\n");
		expect(() => writeReviewFile(output, "regenerated\n")).toThrow(/review edits were preserved/);
		expect(fs.readFileSync(output, "utf8")).toBe("captain edit\n");
		expect(writeReviewFile(output, "regenerated\n", true)).toBe("written");
	});
});

describe("OptMem setup", () => {
	test("bootstrap guard skips an existing memo and installs only when absent", () => {
		const root = sandbox();
		const installer = path.join(root, "install-optmem.sh");
		const memo = path.join(root, ".optmem", "memo");
		fs.writeFileSync(installer, "#!/bin/sh\n");
		fs.mkdirSync(path.dirname(memo), { recursive: true });
		fs.writeFileSync(memo, "present\n", { mode: 0o700 });
		let calls = 0;
		expect(
			ensureOptMem(path.join(root, "v2"), {
				memoPath: memo,
				installerPath: installer,
				runInstaller: () => {
					calls += 1;
				},
			}),
		).toBe("present");
		expect(calls).toBe(0);

		fs.rmSync(memo);
		expect(
			ensureOptMem(path.join(root, "v2"), {
				memoPath: memo,
				installerPath: installer,
				runInstaller: (script) => {
					expect(script).toBe(installer);
					calls += 1;
					fs.writeFileSync(memo, "installed\n", { mode: 0o700 });
				},
			}),
		).toBe("installed");
		expect(calls).toBe(1);
	});

	test("home bootstrap invokes OptMem setup before copying the plain-session seed", () => {
		const root = sandbox();
		const repoV2 = path.join(root, "repo", "v2");
		const installer = path.join(root, "repo", "ops", "install-optmem.sh");
		const memo = path.join(root, ".optmem", "memo");
		const home = path.join(root, "home");
		fs.mkdirSync(path.join(repoV2, "seed"), { recursive: true });
		fs.mkdirSync(path.dirname(installer), { recursive: true });
		fs.writeFileSync(path.join(repoV2, "seed", "AGENTS.md"), "# Deck home\nplain session\n");
		fs.writeFileSync(installer, "#!/bin/sh\n", { mode: 0o700 });

		const result = bootstrapHome({
			repoV2Dir: repoV2,
			home,
			optMem: {
				memoPath: memo,
				installerPath: installer,
				runInstaller: () => {
					expect(fs.existsSync(home)).toBe(false);
					expect(fs.existsSync(path.join(home, "AGENTS.md"))).toBe(false);
					fs.mkdirSync(path.dirname(memo), { recursive: true });
					fs.writeFileSync(memo, "#!/bin/sh\n", { mode: 0o700 });
				},
			},
		});

		expect(result.notes).toContain("installed OptMem and verified memo wake");
		expect(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8")).toBe("# Deck home\nplain session\n");
	});

	test("a failed OptMem install leaves no partially bootstrapped home", () => {
		const root = sandbox();
		const repoV2 = path.join(root, "repo", "v2");
		const installer = path.join(root, "repo", "ops", "install-optmem.sh");
		const home = path.join(root, "home");
		fs.mkdirSync(path.dirname(installer), { recursive: true });
		fs.writeFileSync(installer, "#!/bin/sh\n", { mode: 0o700 });

		expect(() =>
			bootstrapHome({
				repoV2Dir: repoV2,
				home,
				optMem: {
					memoPath: path.join(root, ".optmem", "memo"),
					installerPath: installer,
					runInstaller: () => {
						throw new Error("installer failed");
					},
				},
			}),
		).toThrow("installer failed");
		expect(fs.existsSync(home)).toBe(false);
	});

	test("wrapper runs the upstream curl installer, verifies wake, and prints placement guidance", () => {
		const home = sandbox();
		const bin = path.join(home, "bin");
		fs.mkdirSync(bin);
		const fakeCurl = path.join(bin, "curl");
		fs.writeFileSync(fakeCurl, `#!/usr/bin/env bash
cat <<'INSTALL'
#!/bin/sh
mkdir -p "$HOME/.optmem"
cat > "$HOME/.optmem/memo" <<'MEMO'
#!/bin/sh
case "$1" in
  init) printf '## Memory\\n' ;;
  wake) exit 0 ;;
  *) exit 2 ;;
esac
MEMO
chmod +x "$HOME/.optmem/memo"
"$HOME/.optmem/memo" init
INSTALL
`, { mode: 0o700 });
		const output = execFileSync("bash", [path.join(import.meta.dir, "install-optmem.sh")], {
			env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
			encoding: "utf8",
		});
		expect(output).toContain("## Memory");
		expect(output).toContain("memo wake` succeeded");
		expect(output).toContain("v2/seed/AGENTS.md");
		expect(fs.existsSync(path.join(home, ".optmem", "memo"))).toBe(true);
	});

	test("wrapper propagates curl, upstream installer, and memo wake failures", () => {
		const curlScripts = [
			`#!/usr/bin/env bash
cat <<'INSTALL'
#!/bin/sh
mkdir -p "$HOME/.optmem"
cat > "$HOME/.optmem/memo" <<'MEMO'
#!/bin/sh
case "$1" in
  init) printf '## Memory\\n' ;;
  wake) exit 0 ;;
  *) exit 2 ;;
esac
MEMO
chmod +x "$HOME/.optmem/memo"
"$HOME/.optmem/memo" init
INSTALL
exit 23
`,
			`#!/usr/bin/env bash
cat <<'INSTALL'
#!/bin/sh
exit 9
INSTALL
`,
			`#!/usr/bin/env bash
cat <<'INSTALL'
#!/bin/sh
mkdir -p "$HOME/.optmem"
cat > "$HOME/.optmem/memo" <<'MEMO'
#!/bin/sh
case "$1" in
  init) printf '## Memory\\n' ;;
  wake) exit 7 ;;
  *) exit 2 ;;
esac
MEMO
chmod +x "$HOME/.optmem/memo"
"$HOME/.optmem/memo" init
INSTALL
`,
		];

		for (const curlScript of curlScripts) {
			const home = sandbox();
			const bin = path.join(home, "bin");
			fs.mkdirSync(bin);
			fs.writeFileSync(path.join(bin, "curl"), curlScript, { mode: 0o700 });
			expect(() =>
				execFileSync("bash", [path.join(import.meta.dir, "install-optmem.sh")], {
					env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
					stdio: ["ignore", "pipe", "pipe"],
				}),
			).toThrow();
		}
	});
});

describe("home seed", () => {
	test("is compact and identifies the plain-session boundaries", () => {
		const seed = fs.readFileSync(path.join(import.meta.dir, "..", "v2", "seed", "AGENTS.md"), "utf8");
		expect(Buffer.byteLength(seed, "utf8")).toBeLessThan(12 * 1024);
		expect(seed).toContain("You are a plain pi session");
		expect(seed).toContain("## MEMORY CONTRACT");
		expect(seed).toContain("## THE FACTORY");
		expect(seed).toContain("## QUESTIONS DISCIPLINE");
		expect(seed).toContain("## LINDY DOCTRINE");
		expect(seed).toContain("## SUBAGENTS");
		expect(seed).toContain("## THIS SESSION NEVER");
		expect(seed).not.toContain("single point of contact");
		const expectedOptMem = fs.readFileSync(path.join(import.meta.dir, "fixtures", "optmem-prompt.txt"), "utf8").trimEnd();
		const optMemStart = seed.indexOf("## Memory\n");
		const optMemEnd = seed.indexOf("\n\n### Per-effort depth", optMemStart);
		expect(optMemStart).toBeGreaterThanOrEqual(0);
		expect(optMemEnd).toBeGreaterThan(optMemStart);
		expect(seed.slice(optMemStart, optMemEnd)).toBe(expectedOptMem);
	});
});
