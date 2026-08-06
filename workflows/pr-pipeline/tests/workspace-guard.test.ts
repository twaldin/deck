import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectProfile } from "../lib/profiles.ts";
import {
	assertProductWorkspace,
	canonicalProductWorkspace,
	isProductRepo,
} from "../lib/workspace-guard.ts";

const home = path.join(os.tmpdir(), "deck-workspace-guard-home");
const devWorkspace = path.join(home, "dev", "deck", "workflows");
const productionProfile: ProjectProfile = {
	id: "acme-api",
	repo: "acme/api",
	primary: "/tmp/acme-api",
	pipeline: "yolo-ship",
	yolo: true,
	stamp: false,
	production: true,
	knowledge: [],
	depsWarm: true,
};

describe("product Smithers workspace guard", () => {
	test("fails closed for a real Lindy run outside the canonical home workspace", () => {
		expect(() =>
			assertProductWorkspace({
				repo: "lindy-ai/lindy",
				profile: null,
				dryRun: false,
				workspaceRoot: devWorkspace,
				home,
				devWorkspaceAllowed: false,
			}),
		).toThrow(/PRODUCT WORKSPACE REFUSED.*deck ship\/adopt\/status.*DECK_DEV_WORKSPACE_OK=1/);
	});

	test("allows a real Lindy run from the canonical home workspace or a child", () => {
		for (const workspaceRoot of [
			canonicalProductWorkspace(home),
			path.join(canonicalProductWorkspace(home), ".smithers", "workflows"),
		]) {
			expect(() =>
				assertProductWorkspace({
					repo: "lindy-ai/lindy",
					profile: null,
					dryRun: false,
					workspaceRoot,
					home,
					devWorkspaceAllowed: false,
				}),
			).not.toThrow();
		}
	});

	test("treats an explicitly production-marked profile as a product repo", () => {
		expect(isProductRepo("acme/api", productionProfile)).toBe(true);
		expect(() =>
			assertProductWorkspace({
				repo: "acme/api",
				profile: productionProfile,
				dryRun: false,
				workspaceRoot: devWorkspace,
				home,
				devWorkspaceAllowed: false,
			}),
		).toThrow(/PRODUCT WORKSPACE REFUSED/);
	});

	test.each([
		["dry run", { repo: "lindy-ai/lindy", profile: null, dryRun: true, devWorkspaceAllowed: false }],
		["explicit development override", { repo: "lindy-ai/lindy", profile: null, dryRun: false, devWorkspaceAllowed: true }],
		["non-product repo", { repo: "twaldin/deck", profile: null, dryRun: false, devWorkspaceAllowed: false }],
	] as const)("allows a development workspace for %s", (_name, input) => {
		expect(() =>
			assertProductWorkspace({
				...input,
				workspaceRoot: devWorkspace,
				home,
			}),
		).not.toThrow();
	});
});
