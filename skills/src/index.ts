/**
 * Skills overlay loader (SPEC §9, PLAN D6): local visibility manifest ∩ scope,
 * content-hash auto-dedup in the LOADED VIEW only — upstream skill files are
 * never deleted or modified (bidirectional sharing stays safe).
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CATALOG_DIR, DeckError } from "@deck/core";
import { z } from "zod";

export const visibilityModeSchema = z.enum(["auto", "name-only", "user-only", "off"]);
export type VisibilityMode = z.infer<typeof visibilityModeSchema>;

export const skillsCatalogSchema = z.object({
	sources: z.array(
		z.object({
			name: z.string().min(1),
			path: z.string().min(1),
			policy: z.enum(["worktree-pinned", "main-fetched"]),
		}),
	),
	visibility: z.record(z.string(), visibilityModeSchema).default({}),
});
export type SkillsCatalog = z.infer<typeof skillsCatalogSchema>;

export interface ResolvedSkill {
	name: string;
	description: string;
	mode: VisibilityMode;
	contentHash: string;
	source: string;
	/** Present only for mode=auto. */
	content?: string;
}

/** Per-skill inline budget for auto skills inside a composed prompt. */
const AUTO_SKILL_MAX_BYTES = 4_096;

export function loadSkillsCatalog(file: string = path.join(CATALOG_DIR, "skills.json")): SkillsCatalog {
	try {
		return skillsCatalogSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return { sources: [], visibility: {} };
		}
		throw error;
	}
}

/**
 * Minimal frontmatter reader: only `name:` and `description:` string fields
 * from the leading `---` block. Deliberately NOT yaml — skill files are
 * third-party content; a yaml parser is attack/complexity surface we don't
 * need for two flat string keys.
 */
function parseFrontmatter(text: string): { name: string | null; description: string | null; body: string } {
	if (!text.startsWith("---\n")) return { name: null, description: null, body: text };
	const end = text.indexOf("\n---", 4);
	if (end === -1) return { name: null, description: null, body: text };
	const header = text.slice(4, end);
	const body = text.slice(text.indexOf("\n", end + 4) + 1);
	let name: string | null = null;
	let description: string | null = null;
	for (const line of header.split("\n")) {
		const match = /^(name|description):\s*(.+)$/.exec(line);
		if (match === null || match[2] === undefined) continue;
		const value = match[2].trim().replace(/^["']|["']$/g, "");
		if (match[1] === "name") name = value;
		else description = value;
	}
	return { name, description, body };
}

/** Hash normalization: strip trailing whitespace per line + trailing newlines. */
function contentHash(body: string): string {
	const normalized = body
		.split("\n")
		.map(line => line.replace(/\s+$/, ""))
		.join("\n")
		.replace(/\n+$/, "");
	return createHash("sha256").update(normalized).digest("hex");
}

interface DiscoveredSkill {
	name: string;
	description: string;
	source: string;
	file: string;
	body: string;
	hash: string;
}

function discoverSource(sourceName: string, root: string): DiscoveredSkill[] {
	const out: DiscoveredSkill[] = [];
	let entries: string[];
	try {
		entries = fs.readdirSync(root, { recursive: true }) as string[];
	} catch {
		return out; // missing source dir: skip, never fail the whole overlay
	}
	for (const entry of entries) {
		if (path.basename(entry) !== "SKILL.md") continue;
		const file = path.join(root, entry);
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const { name, description, body } = parseFrontmatter(text);
		const skillName = name ?? path.basename(path.dirname(file));
		out.push({
			name: skillName,
			description: description ?? "",
			source: sourceName,
			file,
			body,
			hash: contentHash(body),
		});
	}
	return out;
}

/**
 * Resolve the agent-visible skill set: discovery across sources (first source
 * wins on content-hash duplicates AND on name collisions), visibility mode
 * applied (unknown ⇒ name-only per SPEC §9), scope filter last.
 */
export function resolveSkills(catalog: SkillsCatalog, scope?: readonly string[]): ResolvedSkill[] {
	const byHash = new Map<string, DiscoveredSkill>();
	const byName = new Map<string, DiscoveredSkill>();
	for (const source of catalog.sources) {
		for (const skill of discoverSource(source.name, source.path)) {
			if (byHash.has(skill.hash) || byName.has(skill.name)) continue;
			byHash.set(skill.hash, skill);
			byName.set(skill.name, skill);
		}
	}
	const scopeSet = scope === undefined ? null : new Set(scope);
	const resolved: ResolvedSkill[] = [];
	for (const skill of [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))) {
		const mode = catalog.visibility[skill.name] ?? "name-only";
		if (mode === "off" || mode === "user-only") continue;
		if (scopeSet !== null && !scopeSet.has(skill.name)) continue;
		resolved.push({
			name: skill.name,
			description: skill.description,
			mode,
			contentHash: skill.hash,
			source: skill.source,
			...(mode === "auto" ? { content: skill.body } : {}),
		});
	}
	return resolved;
}

/** Prompt block renderer consumed by prompts/compose.ts. */
export function renderSkillsBlock(skills: readonly ResolvedSkill[]): string {
	const lines: string[] = [];
	const nameOnly = skills.filter(skill => skill.mode === "name-only");
	const auto = skills.filter(skill => skill.mode === "auto");
	if (nameOnly.length > 0) {
		lines.push("## Skills (ask to load by name)");
		for (const skill of nameOnly) lines.push(`- ${skill.name}: ${skill.description}`);
	}
	for (const skill of auto) {
		const content = skill.content ?? "";
		if (Buffer.byteLength(content, "utf8") > AUTO_SKILL_MAX_BYTES) {
			throw new DeckError("E_TOO_LONG", `auto skill ${skill.name} exceeds ${AUTO_SKILL_MAX_BYTES} bytes; set it name-only or trim it`, {
				field: skill.name,
				limit: AUTO_SKILL_MAX_BYTES,
			});
		}
		lines.push(`## Skill: ${skill.name}`, content.trimEnd());
	}
	return lines.join("\n");
}
