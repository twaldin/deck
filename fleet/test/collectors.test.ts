import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import {
	collectBacklog,
	parseBacklogMarkdown,
	parseTasksAxiList,
	parseTasksAxiListResult,
	splitToonRow,
	MAX_BACKLOG_BYTES,
	type CommandRunner,
} from "../src/collectors/backlog";
import { collectBroker } from "../src/collectors/broker";
import { collectFleetState, parseMeta, parseStatusTail } from "../src/collectors/fleet";
import {
	collectSmithers,
	parseInspectJson,
	parseInspectJsonResult,
	parsePsJson,
	parsePsJsonResult,
	SMITHERS_RUN_LIMIT,
} from "../src/collectors/smithers";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const FM_HOME = path.join(FIXTURES, "fm-home");

async function fixture(rel: string): Promise<string> {
	return Bun.file(path.join(FIXTURES, rel)).text();
}

describe("fleet meta/status parsing", () => {
	test("parseMeta reads known keys and preserves raw", () => {
		const meta = parseMeta("window=default:w7:p3\nworktree=/tmp/x\nmodel=deck/gpt-5.6-sol\neffort=xhigh\n#comment\nfoo=bar\n");
		expect(meta.window).toBe("default:w7:p3");
		expect(meta.worktree).toBe("/tmp/x");
		expect(meta.model).toBe("deck/gpt-5.6-sol");
		expect(meta.raw.foo).toBe("bar");
		expect(meta.backend).toBeNull();
	});

	test("parseStatusTail takes the final non-blank event", () => {
		const ev = parseStatusTail("working: a\nblocked: b\n\n", 123);
		expect(ev?.state).toBe("blocked");
		expect(ev?.message).toBe("b");
		expect(ev?.mtimeMs).toBe(123);
	});

	test("parseStatusTail keeps a non-conforming line as unknown", () => {
		const ev = parseStatusTail("working: a\nrandom trailing text\n");
		expect(ev?.state).toBe("unknown");
		expect(ev?.message).toBe("random trailing text");
	});

	test("parseStatusTail returns null for empty input", () => {
		expect(parseStatusTail("\n\n")).toBeNull();
	});

	test("collectFleetState reads fixture dir, ignores dotfiles, unions ids", async () => {
		const state = await collectFleetState(FM_HOME);
		expect(state.ok).toBe(true);
		expect(state.ids).toEqual(["alpha", "beta", "gamma"]);
		expect(state.metas.get("alpha")?.worktree).toBe("/tmp/fleet-fixture/alpha");
		expect(state.statuses.get("beta")?.state).toBe("needs-decision");
		// gamma is status-only (no meta)
		expect(state.metas.has("gamma")).toBe(false);
		expect(state.statuses.get("gamma")?.state).toBe("unknown");
	});

	test("collectFleetState degrades on a missing home", async () => {
		const state = await collectFleetState("/nonexistent/fm-home-xyz");
		expect(state.ok).toBe(false);
		expect(state.ids).toEqual([]);
		expect(state.detail).toContain("unreadable");
	});

	test("collectFleetState keeps valid siblings and diagnoses an unreadable item", async () => {
		const tempHome = await fs.mkdtemp(path.join(FIXTURES, "scan-"));
		try {
			const stateDir = path.join(tempHome, "state");
			await fs.mkdir(stateDir);
			await fs.writeFile(path.join(stateDir, "valid.status"), "working: alive\n");
			// A directory with a matching suffix deterministically makes readFile fail.
			await fs.mkdir(path.join(stateDir, "broken.meta"));

			const state = await collectFleetState(tempHome);
			expect(state.ok).toBe(true);
			expect(state.ids).toEqual(["broken", "valid"]);
			expect(state.statuses.get("valid")?.state).toBe("working");
			expect(state.diagnostics).toHaveLength(1);
			expect(state.diagnostics[0]?.source).toContain("broken.meta");
			expect(state.detail).toContain("1 unreadable");
		} finally {
			await fs.rm(tempHome, { recursive: true, force: true });
		}
	});

	test("collectFleetState reads a bounded suffix while preserving the final status event", async () => {
		const tempHome = await fs.mkdtemp(path.join(FIXTURES, "tail-"));
		try {
			const stateDir = path.join(tempHome, "state");
			await fs.mkdir(stateDir);
			await fs.writeFile(
				path.join(stateDir, "large.status"),
				`${"x".repeat(100_000)}\nblocked: final bounded event\n`,
			);
			const state = await collectFleetState(tempHome);
			expect(state.statuses.get("large")?.state).toBe("blocked");
			expect(state.statuses.get("large")?.message).toBe("final bounded event");
			expect(state.diagnostics).toEqual([]);
		} finally {
			await fs.rm(tempHome, { recursive: true, force: true });
		}
	});

	test("collectFleetState stops before filesystem work when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const state = await collectFleetState("/definitely/not/a/fleet-home", controller.signal);
		expect(state.ok).toBe(false);
		expect(state.detail).toContain("aborted");
	});
});

describe("backlog parsing", () => {
	test("splitToonRow honors quotes and commas", () => {
		expect(splitToonRow('a,"b, still b",c')).toEqual(["a", "b, still b", "c"]);
		expect(splitToonRow('x,"quote ""inside""",y')).toEqual(["x", 'quote "inside"', "y"]);
	});

	test("parseTasksAxiList parses rows and strips truncation marker", async () => {
		const entries = parseTasksAxiList(await fixture("tasks-axi-list.txt"));
		expect(entries.map((e) => e.id)).toEqual(["alpha", "delta", "epsilon"]);
		const alpha = entries[0]!;
		expect(alpha.state).toBe("in_flight");
		expect(alpha.repo).toBe("deck");
		expect(alpha.detail).not.toContain("truncated");
		expect(alpha.detail).toContain("TUI showing all agents");
		expect(entries[1]!.hold).toBe("captain word pending");
		expect(entries[2]!.repo).toBe("deck");
	});

	test("parseTasksAxiList returns [] on unrecognized shape", () => {
		expect(parseTasksAxiList("not a table")).toEqual([]);
	});

	test("tasks-axi validation rejects a partial table instead of accepting a prefix", async () => {
		const truncated = (await fixture("tasks-axi-list.txt")).replace("tasks[3]", "tasks[4]");
		const parsed = parseTasksAxiListResult(truncated);
		expect(parsed.valid).toBe(false);
		expect(parsed.entries).toEqual([]);
		expect(parsed.detail).toContain("declared 4");
	});

	test("tasks-axi validation distinguishes a valid empty result", () => {
		const parsed = parseTasksAxiListResult("count: 0\ntasks: 0 tasks in this backlog\n");
		expect(parsed.valid).toBe(true);
		expect(parsed.entries).toEqual([]);
	});

	test("tasks-axi title truncation markers do not leak into the dashboard", () => {
		const parsed = parseTasksAxiListResult(
			'count: 1\ntasks[1]{id,state,kind,repo,title,body,created,hold_reason}:\n  alpha,queued,task,deck,"A long title\\n... (truncated, 90 chars total - use show alpha --full to see complete text)",body,2026-07-27,"-"\n',
		);
		expect(parsed.valid).toBe(true);
		expect(parsed.entries[0]?.title).toBe("A long title");
	});

	test("parseBacklogMarkdown parses sections, holds, repos, detail", async () => {
		const entries = parseBacklogMarkdown(await fixture("fm-home/data/backlog.md"));
		const byId = new Map(entries.map((e) => [e.id, e]));
		expect(byId.get("alpha")?.state).toBe("in_flight");
		expect(byId.get("alpha")?.repo).toBe("deck");
		expect(byId.get("alpha")?.detail).toContain("tree");
		expect(byId.get("delta")?.state).toBe("queued");
		expect(byId.get("delta")?.hold).toBe("captain word");
		expect(byId.get("epsilon")?.state).toBe("done");
	});

	test("markdown fallback strips every known metadata group but preserves title parentheses", () => {
		const entries = parseBacklogMarkdown(
			"## Queued\n- [ ] shadow - Shadow cutover (BLOCKED on captain) (since 2026-07-27) (hold: wait) (hold-kind: captain)\n",
		);
		expect(entries[0]?.title).toBe("Shadow cutover (BLOCKED on captain)");
		expect(entries[0]?.since).toBe("2026-07-27");
		expect(entries[0]?.hold).toBe("wait");
	});

	test("collectBacklog prefers tasks-axi when it returns rows", async () => {
		const listOut = await fixture("tasks-axi-list.txt");
		const run: CommandRunner = async (cmd) => (cmd === "tasks-axi" ? { stdout: listOut, exitCode: 0 } : null);
		const result = await collectBacklog(FM_HOME, run);
		expect(result.source).toBe("tasks-axi");
		expect(result.entries.map((e) => e.id)).toEqual(["alpha", "delta", "epsilon"]);
	});

	test("collectBacklog falls back to markdown when tasks-axi is absent", async () => {
		const run: CommandRunner = async () => null; // binary missing
		const result = await collectBacklog(FM_HOME, run);
		expect(result.source).toBe("markdown");
		expect(result.entries.length).toBe(4);
	});

	test("collectBacklog falls back when tasks-axi errors non-zero", async () => {
		const run: CommandRunner = async () => ({ stdout: "boom", exitCode: 1 });
		const result = await collectBacklog(FM_HOME, run);
		expect(result.source).toBe("markdown");
	});

	test("collectBacklog falls back when tasks-axi output is partial", async () => {
		const truncated = (await fixture("tasks-axi-list.txt")).replace("tasks[3]", "tasks[4]");
		const run: CommandRunner = async () => ({ stdout: truncated, exitCode: 0 });
		const result = await collectBacklog(FM_HOME, run);
		expect(result.source).toBe("markdown");
		expect(result.entries).toHaveLength(4);
		expect(result.detail).toContain("malformed");
	});

	test("collectBacklog fails loudly instead of buffering an oversized markdown fallback", async () => {
		const tempHome = await fs.mkdtemp(path.join(FIXTURES, "backlog-limit-"));
		try {
			const dataDir = path.join(tempHome, "data");
			await fs.mkdir(dataDir);
			await fs.writeFile(path.join(dataDir, "backlog.md"), Buffer.alloc(MAX_BACKLOG_BYTES + 1, 0x20));
			const result = await collectBacklog(tempHome, async () => null);
			expect(result.ok).toBe(false);
			expect(result.source).toBe("none");
			expect(result.detail).toContain("safety limit");
		} finally {
			await fs.rm(tempHome, { recursive: true, force: true });
		}
	});

	test("collectBacklog honors an already-aborted refresh", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await collectBacklog(FM_HOME, async () => null, controller.signal);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("aborted");
	});
});

describe("smithers parsing", () => {
	test("parsePsJson extracts runs with fallback fields", async () => {
		const runs = parsePsJson(await fixture("smithers/ps.json"));
		expect(runs.map((r) => r.id)).toEqual(["oneshot-abc123", "pr-pipeline-def456"]);
		expect(runs[0]!.status).toBe("running");
		expect(runs[1]!.step).toBe("review");
	});

	test("parsePsJson tolerates junk", () => {
		expect(parsePsJson("not json")).toEqual([]);
		expect(parsePsJson('{"runs":"nope"}')).toEqual([]);
		expect(parsePsJsonResult('{"runs":"nope"}').valid).toBe(false);
	});

	test("parseInspectJson returns rootDir + nodes", async () => {
		const parsed = parseInspectJson(await fixture("smithers/inspect-oneshot.json"));
		expect(parsed.rootDir).toBe("/tmp/fleet-fixture/alpha");
		expect(parsed.nodes.map((n) => n.id)).toEqual(["implement", "review"]);
		expect(parsed.nodes[0]!.attempt).toBe(2);
	});

	test("parseInspectJson safely rejects a JSON null payload", () => {
		expect(parseInspectJson("null")).toEqual({ rootDir: null, nodes: [] });
		const parsed = parseInspectJsonResult("null");
		expect(parsed.valid).toBe(false);
		expect(parsed.detail).toContain("inspect object");
	});

	test("collectSmithers runs ps then inspect per run via injected runner", async () => {
		const ps = await fixture("smithers/ps.json");
		const oneshot = await fixture("smithers/inspect-oneshot.json");
		const pipeline = await fixture("smithers/inspect-pipeline.json");
		const run: CommandRunner = async (cmd, args) => {
			if (args[1] === "ps") return { stdout: ps, exitCode: 0 };
			if (args[1] === "inspect" && args[2] === "oneshot-abc123") return { stdout: oneshot, exitCode: 0 };
			if (args[1] === "inspect" && args[2] === "pr-pipeline-def456") return { stdout: pipeline, exitCode: 0 };
			return null;
		};
		const result = await collectSmithers(["/ws"], run);
		expect(result.runs).toHaveLength(2);
		expect(result.runs[0]!.rootDir).toBe("/tmp/fleet-fixture/alpha");
		expect(result.runs[0]!.nodes).toHaveLength(2);
		expect(result.diagnostics[0]!.ok).toBe(true);
	});

	test("collectSmithers reports a diagnostic when ps fails", async () => {
		const run: CommandRunner = async () => null;
		const result = await collectSmithers(["/ws"], run);
		expect(result.runs).toEqual([]);
		expect(result.diagnostics[0]!.ok).toBe(false);
	});

	test("collectSmithers retains ps rows and diagnoses a malformed inspect", async () => {
		const ps = await fixture("smithers/ps.json");
		const pipeline = await fixture("smithers/inspect-pipeline.json");
		const run: CommandRunner = async (_cmd, args) => {
			if (args[1] === "ps") return { stdout: ps, exitCode: 0 };
			if (args[2] === "oneshot-abc123") return { stdout: "null", exitCode: 0 };
			if (args[2] === "pr-pipeline-def456") return { stdout: pipeline, exitCode: 0 };
			return null;
		};
		const result = await collectSmithers(["/ws"], run);
		expect(result.runs).toHaveLength(2);
		expect(result.runs[0]?.rootDir).toBeNull();
		expect(result.runs[1]?.rootDir).toBe("/tmp/some/other/workspace");
		expect(result.diagnostics.some((d) => d.source.includes("oneshot-abc123") && !d.ok)).toBe(true);
	});

	test("collectSmithers requests all statuses and warns when its bounded run ceiling is exceeded", async () => {
		const runs = Array.from({ length: SMITHERS_RUN_LIMIT + 1 }, (_, index) => ({
			id: `run-${index}`,
			workflow: "wf",
			status: "finished",
		}));
		let psArgs: readonly string[] = [];
		const run: CommandRunner = async (_command, args) => {
			if (args[1] === "ps") {
				psArgs = args;
				return { stdout: JSON.stringify({ runs }), exitCode: 0 };
			}
			return { stdout: '{"config":{},"nodes":[]}', exitCode: 0 };
		};
		const result = await collectSmithers(["/ws"], run);
		expect(psArgs).toContain("--all");
		expect(psArgs).toContain(String(SMITHERS_RUN_LIMIT + 1));
		expect(result.runs).toHaveLength(SMITHERS_RUN_LIMIT);
		expect(
			result.diagnostics.some(
				(diagnostic) => diagnostic.level === "warning" && diagnostic.detail.includes("more than"),
			),
		).toBe(true);
	});
});

describe("broker seam", () => {
	test("collectBroker skips cleanly with no auth (TODO seam)", async () => {
		const out = await collectBroker({ endpoint: "http://127.0.0.1:8377", auth: null });
		expect(out.roster).toEqual([]);
		expect(out.diagnostic.ok).toBe(true);
		expect(out.diagnostic.detail).toContain("TODO");
	});
});
