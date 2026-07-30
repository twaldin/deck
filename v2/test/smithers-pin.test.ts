/**
 * One pin, everywhere. bunx silently resolves a newer cached CLI from a
 * directory without a package.json (observed: 0.31.0 vs 0.30.0), so the code
 * pin in src/smithers.ts must equal every workspace pin — this goes red the
 * moment any single one is bumped alone.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SMITHERS_SPEC, SMITHERS_VERSION } from "../src/smithers";

const REPO = path.resolve(import.meta.dir, "..", "..");

function dep(pkgPath: string, name: string): string | undefined {
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
	return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
}

describe("smithers pin", () => {
	test("spec is derived from the version", () => {
		expect(SMITHERS_SPEC).toBe(`smithers-orchestrator@${SMITHERS_VERSION}`);
	});

	test("matches workflows/.smithers workspace pin", () => {
		const pkg = path.join(REPO, "workflows", ".smithers", "package.json");
		expect(dep(pkg, "smithers-orchestrator")).toBe(SMITHERS_VERSION);
		expect(dep(pkg, "@smithers-orchestrator/cli")).toBe(SMITHERS_VERSION);
	});

	test("matches workflows/pr-pipeline pin", () => {
		const pkg = path.join(REPO, "workflows", "pr-pipeline", "package.json");
		expect(dep(pkg, "smithers-orchestrator")).toBe(SMITHERS_VERSION);
	});

	test("no stray hardcoded smithers-orchestrator@ spec in v2 source", () => {
		const srcDir = path.join(REPO, "v2", "src");
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name.endsWith(".ts") && entry.name !== "smithers.ts") {
					if (/smithers-orchestrator@\d/.test(fs.readFileSync(full, "utf8"))) offenders.push(full);
				}
			}
		};
		walk(srcDir);
		expect(offenders).toEqual([]);
	});
});
