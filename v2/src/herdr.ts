/**
 * Best-effort Herdr projection. Deck state and Smithers remain authoritative.
 * Herdr only provides a useful presentation: one `deck-fleet` workspace and one
 * live tail pane for each running deck effort.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { FleetFrame, SourceHealth, TaskRow } from "./monitor";
import { deckV2Home, stateDir } from "./home";
import { readMeta, updateMeta } from "./meta";
import { reapOrphanedBunTests } from "./orphan-reaper";

const run = promisify(execFile);
const WORKSPACE_LABEL = "deck-fleet";

export type HerdrAgentState = "working" | "idle" | "blocked";

export function desiredState(task: TaskRow): HerdrAgentState {
	if (task.openDecisions > 0 || task.lastVerb === "needs-decision" || task.lastVerb === "blocked" || task.lastVerb === "failed") return "blocked";
	return task.runState === "running" ? "working" : "idle";
}

export function shouldReleasePane(input: { runState: TaskRow["runState"]; lastVerb: string | null; worktreeExists: boolean }): boolean {
	if (input.lastVerb === "done" || input.lastVerb === "failed") return true;
	if (input.runState === "running") return false;
	if (!input.worktreeExists) return true;
	return input.lastVerb === "paused" || input.lastVerb === "blocked";
}

export function projectionMessage(task: TaskRow): string {
	const body = task.lastVerb === null ? "no status yet" : `${task.lastVerb}: ${task.lastNote ?? ""}`;
	return body.length > 120 ? `${body.slice(0, 119)}…` : body;
}

async function herdr(args: string[]): Promise<Record<string, unknown> | null> {
	try {
		const { stdout } = await run(process.env.DECK_HERDR_BIN ?? "herdr", args, { timeout: 8_000, maxBuffer: 1_000_000 });
		if (stdout.trim().length === 0) return {};
		const parsed: unknown = JSON.parse(stdout);
		return parsed !== null && typeof parsed === "object" ? ((parsed as { result?: unknown }).result ?? {}) as Record<string, unknown> : null;
	} catch { return null; }
}

type PaneRecord = { pane: string; tab?: string; agent: string; kind: "spawn" | "workflow" };
type Projection = {
	workspaceId?: string;
	panes?: Record<string, PaneRecord>;
	/** Pane records from the pre-workflow projection. Release on upgrade. */
	smithersPane?: string;
	smithersTab?: string;
};

function projectionFile(): string { return path.join(stateDir(), ".herdr-projection.json"); }
function loadProjection(): Projection {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(projectionFile(), "utf8"));
		if (parsed === null || typeof parsed !== "object") return {};
		const value = parsed as Projection;
		return { ...value, panes: value.panes ?? {} };
	} catch { return { panes: {} }; }
}
function saveProjection(projection: Projection): void {
	const file = projectionFile();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

function resultWorkspace(result: Record<string, unknown> | null): { workspace_id?: string; label?: string } | null {
	return result?.workspace !== null && typeof result?.workspace === "object" ? result.workspace as { workspace_id?: string; label?: string } : null;
}

/** Reuse by exact label, including after the projection state file is lost. */
async function ensureWorkspace(projection: Projection): Promise<string | null> {
	if (projection.workspaceId !== undefined) {
		const found = await herdr(["workspace", "get", projection.workspaceId]);
		if (found?.workspace !== null && typeof found?.workspace === "object") return projection.workspaceId;
		delete projection.workspaceId;
	}
	const listed = await herdr(["workspace", "list"]);
	const workspaces = Array.isArray(listed?.workspaces) ? listed.workspaces : [];
	const matching = workspaces.filter((value) => value !== null && typeof value === "object" && (value as { label?: string }).label === WORKSPACE_LABEL) as Array<{ workspace_id?: string }>;
	// A label is not an ownership proof. Only adopt an unambiguous current
	// workspace; legacy `deck fleet` workspaces are never touched.
	if (matching.length === 1 && matching[0]?.workspace_id !== undefined) {
		projection.workspaceId = matching[0].workspace_id;
		saveProjection(projection);
		return matching[0].workspace_id;
	}
	const created = await herdr(["workspace", "create", "--label", WORKSPACE_LABEL, "--no-focus", "--cwd", stateDir()]);
	const workspace = resultWorkspace(created);
	if (workspace?.workspace_id === undefined) return null;
	projection.workspaceId = workspace.workspace_id;
	saveProjection(projection);
	return workspace.workspace_id;
}

export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

function effortKey(task: TaskRow): string { return task.runId === null ? `task:${task.taskId}` : `run:${task.runId}`; }
export function commandFor(task: Pick<TaskRow, "taskId" | "runId">): string {
	if (task.runId !== null) return `smithers status ${shellQuote(task.runId)}; exec smithers logs ${shellQuote(task.runId)} --follow --tail 30`;
	return `DECK_V2_HOME=${shellQuote(deckV2Home())} exec deck-v2 tail ${shellQuote(task.taskId)}`;
}
function agentFor(task: TaskRow): string { return task.runId === null ? task.taskId : `run:${task.runId}`; }
function cwdFor(task: TaskRow): string { return task.worktree !== null && fs.existsSync(task.worktree) ? task.worktree : stateDir(); }

type LivePane = { pane_id?: string; tab_id?: string; agent?: string };
async function workspacePanes(workspaceId: string): Promise<LivePane[]> {
	const listed = await herdr(["pane", "list", "--workspace", workspaceId]);
	return Array.isArray(listed?.panes) ? listed.panes.filter((value): value is LivePane => value !== null && typeof value === "object") : [];
}

async function createPane(workspaceId: string, task: TaskRow): Promise<PaneRecord | null> {
	const created = await herdr(["tab", "create", "--workspace", workspaceId, "--label", agentFor(task), "--no-focus", "--cwd", cwdFor(task), "--env", `DECK_V2_HOME=${deckV2Home()}`]);
	const root = created?.root_pane !== null && typeof created?.root_pane === "object" ? created.root_pane as { pane_id?: string } : null;
	const tab = created?.tab !== null && typeof created?.tab === "object" ? created.tab as { tab_id?: string } : null;
	if (root?.pane_id === undefined) return null;
	const record: PaneRecord = { pane: root.pane_id, agent: agentFor(task), kind: task.runId === null ? "spawn" : "workflow", ...(tab?.tab_id === undefined ? {} : { tab: tab.tab_id }) };
	const started = await herdr(["pane", "run", root.pane_id, commandFor(task)]);
	if (started === null) {
		await herdr(record.tab === undefined ? ["pane", "close", record.pane] : ["tab", "close", record.tab]);
		return null;
	}
	return record;
}

async function report(record: PaneRecord, task: TaskRow): Promise<boolean> {
	return (await herdr(["pane", "report-agent", record.pane, "--source", "deck", "--agent", record.agent, "--state", desiredState(task), "--message", task.runId === null ? projectionMessage(task) : `workflow ${task.runId}`])) !== null;
}

export function mayClosePane(info: { pane_id?: string; agent?: string } | null, pane: string, agent: string): boolean {
	return info !== null && info.pane_id === pane && info.agent === agent;
}

async function releasePane(record: PaneRecord): Promise<void> {
	const found = await herdr(["pane", "get", record.pane]);
	const info = found?.pane !== null && typeof found?.pane === "object" ? found.pane as { pane_id?: string; agent?: string } : null;
	if (!mayClosePane(info, record.pane, record.agent)) return;
	await herdr(["pane", "release-agent", record.pane, "--source", "deck", "--agent", record.agent]);
	await herdr(record.tab === undefined ? ["pane", "close", record.pane] : ["tab", "close", record.tab]);
}

let inFlight = false;
export async function projectFleet(frame: FleetFrame): Promise<SourceHealth> {
	if (inFlight) return { name: "herdr-projection", state: "skipped", detail: "pass already running" };
	inFlight = true;
	try { return await pass(frame); } catch (error) {
		return { name: "herdr-projection", state: "missing", detail: error instanceof Error ? error.message.split("\n")[0] ?? "failed" : "failed" };
	} finally { inFlight = false; }
}

async function pass(frame: FleetFrame): Promise<SourceHealth> {
	await reapOrphanedBunTests();
	if ((await herdr(["workspace", "list"])) === null) return { name: "herdr-projection", state: "skipped", detail: "herdr not running" };
	const projection = loadProjection();
	const panes = projection.panes ?? (projection.panes = {});
	const keep = new Set<string>();
	let projected = 0;
	let listedPanes: LivePane[] = [];

	for (const task of frame.tasks) {
		const key = effortKey(task);
		const active = task.runState === "running" && !shouldReleasePane({ runState: task.runState, lastVerb: task.lastVerb, worktreeExists: task.worktree !== null && fs.existsSync(task.worktree) });
		const recordedMeta = task.runId === null ? readMeta(task.taskId) : null;
		const oldPane = typeof recordedMeta?.herdr_pane === "string" ? recordedMeta.herdr_pane : undefined;
		let recoveredFromMeta = false;
		if (oldPane !== undefined && panes[key] === undefined) {
			panes[key] = { pane: oldPane, agent: agentFor(task), kind: task.runId === null ? "spawn" : "workflow", ...(typeof recordedMeta?.herdr_tab === "string" ? { tab: recordedMeta.herdr_tab } : {}) };
			recoveredFromMeta = true;
		}
		if (!active) {
			const release = shouldReleasePane({ runState: task.runState, lastVerb: task.lastVerb, worktreeExists: task.worktree !== null && fs.existsSync(task.worktree) }) || task.runId !== null;
			if (panes[key] !== undefined && release) {
				await releasePane(panes[key]);
				delete panes[key];
				if (task.runId === null) updateMeta(task.taskId, { herdr_pane: undefined, herdr_tab: undefined });
			} else if (panes[key] !== undefined) {
				keep.add(key);
				await report(panes[key], task);
				projected += 1;
			}
			continue;
		}
		keep.add(key);
		let record = panes[key];
		if (record === undefined) {
			const workspace = await ensureWorkspace(projection);
			if (workspace === null) continue;
			if (listedPanes.length === 0) listedPanes = await workspacePanes(workspace);
			const recovered = listedPanes.find((pane) => pane.agent === agentFor(task) && pane.pane_id !== undefined);
			if (recovered?.pane_id !== undefined) {
				record = { pane: recovered.pane_id, agent: agentFor(task), kind: task.runId === null ? "spawn" : "workflow", ...(recovered.tab_id === undefined ? {} : { tab: recovered.tab_id }) };
			} else {
				record = await createPane(workspace, task) ?? undefined;
			}

			if (record === undefined) continue;
			panes[key] = record;
			if (task.runId === null) updateMeta(task.taskId, { herdr_pane: record.pane, ...(record.tab === undefined ? {} : { herdr_tab: record.tab }) });
		}
		if (recoveredFromMeta) await herdr(["pane", "run", record.pane, commandFor(task)]);
		if (await report(record, task)) { projected += 1; } else {
			// The pane was ours if we just created it, even before report-agent
			// registered the identity. Close that tab directly to avoid a retry leak.
			if (!recoveredFromMeta && record.tab !== undefined) await herdr(["tab", "close", record.tab]);
			delete panes[key];
			if (task.runId === null) updateMeta(task.taskId, { herdr_pane: undefined, herdr_tab: undefined });
		}
	}

	for (const [key, record] of Object.entries(panes)) {
		if (keep.has(key)) continue;
		await releasePane(record);
		delete panes[key];
	}
	if (projection.smithersPane !== undefined) {
		await releasePane({ pane: projection.smithersPane, agent: "deck-smithers", kind: "workflow", ...(projection.smithersTab === undefined ? {} : { tab: projection.smithersTab }) });
		delete projection.smithersPane;
		delete projection.smithersTab;
	}
	// Recovering from a lost projection file must not leave old deck panes behind.
	// The agent label is the same identity proof used for recorded panes.
	if (projection.workspaceId !== undefined) {
		if (listedPanes.length === 0) listedPanes = await workspacePanes(projection.workspaceId);
		for (const pane of listedPanes) {
			if (pane.pane_id === undefined || pane.agent === undefined) continue;
			if (pane.agent !== "deck-smithers" && !pane.agent.startsWith("run:") && !frame.tasks.some((task) => task.taskId === pane.agent)) continue;
			const known = Object.values(panes).some((record) => record.pane === pane.pane_id);
			if (!known) await releasePane({ pane: pane.pane_id, agent: pane.agent, kind: pane.agent === "deck-smithers" || pane.agent.startsWith("run:") ? "workflow" : "spawn", ...(pane.tab_id === undefined ? {} : { tab: pane.tab_id }) });
		}
	}
	// Keep the workspace binding even when the last pane closes. This prevents a
	// later restart from adopting another same-label workspace.
	saveProjection(projection);
	return { name: "herdr-projection", state: "ok", detail: `${projected} effort(s) projected` };
}
