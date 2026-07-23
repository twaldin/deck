import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderSkillsBlock, resolveSkills, skillsCatalogSchema } from "../src/index";

function writeSkill(root: string, dir: string, name: string, description: string, body: string): void {
	const skillDir = path.join(root, dir);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

function fixtureTree(): { catalog: ReturnType<typeof skillsCatalogSchema.parse>; a: string; b: string } {
	const a = fs.mkdtempSync(path.join(os.tmpdir(), "skills-a-"));
	const b = fs.mkdtempSync(path.join(os.tmpdir(), "skills-b-"));
	writeSkill(a, "alpha", "alpha", "First skill", "Do alpha things.");
	writeSkill(a, "shared", "shared", "Shared skill from A", "Identical body.   \n");
	writeSkill(b, "shared-copy", "shared-b", "Shared skill from B", "Identical body.\n\n");
	writeSkill(b, "beta", "beta", "Second skill", "Do beta things.");
	const catalog = skillsCatalogSchema.parse({
		sources: [
			{ name: "a", path: a, policy: "worktree-pinned" },
			{ name: "b", path: b, policy: "main-fetched" },
		],
		visibility: { alpha: "auto", beta: "user-only", "big": "auto" },
	});
	return { catalog, a, b };
}

describe("skills overlay", () => {
	test("content-hash dedup keeps first source; unknown skills default name-only; user-only excluded", () => {
		const { catalog } = fixtureTree();
		const skills = resolveSkills(catalog);
		const names = skills.map(skill => skill.name);
		expect(names).toContain("alpha");
		expect(names).toContain("shared"); // from source a
		expect(names).not.toContain("shared-b"); // deduped by normalized content hash
		expect(names).not.toContain("beta"); // user-only excluded from agent view
		const shared = skills.find(skill => skill.name === "shared");
		expect(shared?.mode).toBe("name-only"); // unknown => name-only (SPEC 9)
		expect(shared?.source).toBe("a");
		const alpha = skills.find(skill => skill.name === "alpha");
		expect(alpha?.mode).toBe("auto");
		expect(alpha?.content).toContain("Do alpha things.");
	});

	test("scope filter intersects", () => {
		const { catalog } = fixtureTree();
		const skills = resolveSkills(catalog, ["alpha"]);
		expect(skills.map(skill => skill.name)).toEqual(["alpha"]);
	});

	test("renderSkillsBlock: name-only bullets + inline auto; oversized auto rejected", () => {
		const { catalog, a } = fixtureTree();
		const block = renderSkillsBlock(resolveSkills(catalog));
		expect(block).toContain("- shared: Shared skill from A");
		expect(block).toContain("## Skill: alpha");

		writeSkill(a, "big", "big", "Too big", "x".repeat(5_000));
		expect(() => renderSkillsBlock(resolveSkills(catalog))).toThrow(/E_TOO_LONG/);
	});

	test("frontmatter with the closing --- at EOF (no trailing newline) yields an empty body, not the whole file", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-eof-"));
		const dir = path.join(root, "eofskill");
		fs.mkdirSync(dir, { recursive: true });
		// No body and no trailing newline after the closing fence.
		fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: eof\ndescription: Ends at fence\n---");
		const catalog = skillsCatalogSchema.parse({
			sources: [{ name: "s", path: root, policy: "worktree-pinned" }],
			visibility: { eof: "auto" },
		});
		const skills = resolveSkills(catalog);
		const eof = skills.find(skill => skill.name === "eof");
		expect(eof?.description).toBe("Ends at fence");
		// The bug returned the ENTIRE file (fence markers + frontmatter) as body.
		expect(eof?.content ?? "").not.toContain("name: eof");
		expect(eof?.content ?? "").not.toContain("---");
	});
});
