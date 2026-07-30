/**
 * The deck-v2 pi extension: the orchestrator's face on @deck/v2.
 *
 * Architecture, decided and validated rather than assumed: ONE LIB, TWO FACES.
 * This module imports the lib in-process (probed: a pi extension resolves
 * ../events.ts and calls it directly), and the CLI is a thin argv parser over the
 * same exports. Neither wraps the other. Consequences:
 *   - no subprocess hop in the orchestrator's hot path
 *   - one implementation of the status grammar, epoch fencing and teardown, so
 *     the CLI a crew runs and the tool the orchestrator calls cannot disagree
 *   - the CLI still works headless, from a crew shell, with no pi session
 *
 * The wake engine runs here rather than as a daemon: it lives in the
 * orchestrator's own process, so there is no second thing that can die silently
 * while the orchestrator keeps running. fm2 lost a watcher for 23.8h that way.
 */
import { Type } from "typebox";
import { appendStatus, readStatus } from "../events";
import { buildFrame, renderFrame, renderStatusline } from "../fleet";
import { deckV2Home, stateFiles } from "../home";
import { readMeta } from "../meta";
import { enqueue, pending } from "../queue";
import { peekSession, startRun } from "../spawn";
import { STATUS_VERBS, type StatusVerb } from "../status";
import { evaluateTeardown, formatVerdict } from "../teardown";
import { detectStale, foldBatched, reconcile } from "../wake";
import {
	assertDispatchable,
	closeInternal,
	createInternal,
	externalize,
	internalSummary,
	openItems,
} from "../backlog";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

const text = (body: string): ToolResult => ({
	content: [{ type: "text", text: body }],
	details: {},
});

/** Poll cadence for the reconcile pass. A nudge shortens latency, never truth. */
const RECONCILE_MS = 30_000;

export default function deckV2(pi: any): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	let unwatch: (() => void) | undefined;
	let workflowCwd: string | undefined;

	// ---- tools --------------------------------------------------------------

	pi.registerTool({
		name: "spawn",
		label: "Spawn",
		description:
			"Start a worker run for a task in an isolated worktree. The brief is generated from the task and acceptance criteria; do not write one by hand.",
		parameters: Type.Object({
			task_id: Type.String({ description: "slug: lowercase letters, digits, hyphens" }),
			task: Type.String({ description: "what to do, front-loaded and self-contained" }),
			acceptance: Type.Array(Type.String(), { description: "criteria that must pass" }),
			worktree: Type.String({ description: "absolute path to the disposable worktree" }),
			kind: Type.Union([Type.Literal("ship"), Type.Literal("scout")]),
			project: Type.Optional(Type.String()),
			branch: Type.Optional(Type.String()),
			model: Type.Optional(Type.String({ description: "deck/<model>; defaults to the fable class" })),
			context: Type.Optional(Type.String({ description: "task-specific context only" })),
		}),
		async execute(_id: string, params: Record<string, unknown>) {
			const result = startRun(
				{
					taskId: params.task_id as string,
					task: params.task as string,
					acceptance: (params.acceptance as string[]) ?? [],
					worktree: params.worktree as string,
					kind: params.kind as "ship" | "scout",
					...(params.project === undefined ? {} : { project: params.project as string }),
					...(params.branch === undefined ? {} : { branch: params.branch as string }),
					...(params.model === undefined ? {} : { model: params.model as string }),
					...(params.context === undefined ? {} : { context: params.context as string }),
				},
				deckV2Home(),
			);
			return text(
				`spawned ${result.taskId} (epoch ${result.epoch}, pid ${result.pid}, ${result.model})\nbrief: ${result.briefPath}\nIt reports through its status file; it cannot contact the captain.`,
			);
		},
	});

	pi.registerTool({
		name: "send",
		label: "Send",
		description:
			"Queue a message for a task. Delivered at the start of its next run, not mid-turn. Use this to answer a worker's needs-decision or to steer it.",
		parameters: Type.Object({
			task_id: Type.String(),
			message: Type.String(),
		}),
		async execute(_id: string, params: Record<string, unknown>) {
			const taskId = params.task_id as string;
			const queued = enqueue(taskId, params.message as string, "orchestrator");
			return text(
				`queued ${queued.id} for ${taskId} (${pending(taskId).length} pending). It arrives when the task's next run starts.`,
			);
		},
	});

	pi.registerTool({
		name: "status",
		label: "Status",
		description:
			"A task's events plus its record. Status lines are events, not current state: check the run and workflow row when the live state matters.",
		parameters: Type.Object({ task_id: Type.String(), limit: Type.Optional(Type.Number()) }),
		async execute(_id: string, params: Record<string, unknown>) {
			const taskId = params.task_id as string;
			const limit = (params.limit as number | undefined) ?? 20;
			const read = readStatus(taskId);
			const meta = readMeta(taskId);
			const lines = read.events.slice(-limit).map((event) => event.raw.trim());
			const bad = read.malformed.map((m) => `MALFORMED: ${m.raw.trim()} (${m.reason})`);
			return text(
				[
					`task ${taskId}${meta === null ? " (no record)" : ` — ${meta.kind ?? "ship"}${meta.project === undefined ? "" : ` · ${meta.project}`}`}`,
					...lines,
					...bad,
					`(${pending(taskId).length} queued message(s))`,
				].join("\n"),
			);
		},
	});

	pi.registerTool({
		name: "peek",
		label: "Peek",
		description:
			"Tail a task's session transcript. This is the actual conversation, not a rendered pane, so there is no display ambiguity to misread.",
		parameters: Type.Object({ task_id: Type.String(), limit: Type.Optional(Type.Number()) }),
		async execute(_id: string, params: Record<string, unknown>) {
			const entries = peekSession(
				params.task_id as string,
				(params.limit as number | undefined) ?? 12,
			);
			if (entries.length === 0) return text(`no session yet for ${params.task_id as string}`);
			return text(entries.map((entry) => `[${entry.role}] ${entry.text.slice(0, 500)}`).join("\n"));
		},
	});

	pi.registerTool({
		name: "fleet",
		label: "Fleet",
		description: "What every task and workflow is doing right now.",
		parameters: Type.Object({}),
		async execute() {
			const frame = await buildFrame(workflowCwd === undefined ? {} : { workflowCwd });
			return text(renderFrame(frame));
		},
	});

	pi.registerTool({
		name: "teardown_check",
		label: "Teardown Check",
		description:
			"Evaluate whether a task may be torn down. Never destructive. A refusal is a stop-and-investigate result: do not work around it.",
		parameters: Type.Object({
			task_id: Type.String(),
			pr_number: Type.Optional(Type.Number()),
			active_run: Type.Optional(Type.Boolean()),
		}),
		async execute(_id: string, params: Record<string, unknown>) {
			const taskId = params.task_id as string;
			const verdict = evaluateTeardown(taskId, {
				...(params.pr_number === undefined ? {} : { prNumber: params.pr_number as number }),
				...(params.active_run === undefined ? {} : { activeRun: params.active_run as boolean }),
			});
			return text(formatVerdict(taskId, verdict));
		},
	});

	pi.registerTool({
		name: "note",
		label: "Note",
		description:
			"Append a status event for a task as the orchestrator. The line must start with a verb.",
		parameters: Type.Object({
			task_id: Type.String(),
			verb: Type.Union(STATUS_VERBS.map((verb) => Type.Literal(verb)) as any),
			note: Type.String(),
			key: Type.Optional(Type.String()),
		}),
		async execute(_id: string, params: Record<string, unknown>) {
			const line = appendStatus(
				params.task_id as string,
				params.verb as StatusVerb,
				params.note as string,
				params.key === undefined ? {} : { key: params.key as string },
			);
			return text(line);
		},
	});

	pi.registerTool({
		name: "backlog",
		label: "Backlog",
		description:
			"Internal items only: scout, investigation, chore, decision. Delivery work is a query over PRs and tickets, never an item here. Actions: ls, add, close, externalize, check.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("ls"),
				Type.Literal("add"),
				Type.Literal("close"),
				Type.Literal("externalize"),
				Type.Literal("check"),
			]),
			id: Type.Optional(Type.String()),
			type: Type.Optional(Type.String()),
			intent: Type.Optional(Type.String()),
			reason: Type.Optional(Type.String()),
			external_ref: Type.Optional(Type.String()),
		}),
		async execute(_id: string, params: Record<string, unknown>) {
			const action = params.action as string;
			if (action === "ls") {
				const summary = internalSummary();
				const items = openItems();
				return text(
					[
						`internal ${summary.open}/${summary.cap} open`,
						...items.map(
							(item) => `  ${item.id}  ${item.type}  expires ${item.expires_at}  ${item.intent}`,
						),
						"Delivery work is not here: query PRs and tickets.",
					].join("\n"),
				);
			}
			const id = params.id as string | undefined;
			if (id === undefined) return text("that action needs an id");
			if (action === "add") {
				const item = createInternal({
					id,
					type: (params.type as string) ?? "chore",
					intent: (params.intent as string) ?? "",
					owner: "orchestrator",
				});
				return text(`added ${item.id} (${item.type}); expires ${item.expires_at}`);
			}
			if (action === "close") {
				const item = closeInternal(id, (params.reason as string) ?? "");
				return text(`closed ${item.id}: ${item.close_reason}`);
			}
			if (action === "externalize") {
				const item = externalize(id, (params.external_ref as string) ?? "");
				return text(`externalized ${item.id} -> ${item.external_ref}`);
			}
			assertDispatchable(id);
			return text(`${id} is dispatchable`);
		},
	});

	// ---- commands -----------------------------------------------------------

	pi.registerCommand("fleet", {
		description: "Full-screen fleet board: runs, workflows, PRs, decisions",
		handler: async (_args: string, ctx: any) => {
			const frame = await buildFrame(workflowCwd === undefined ? {} : { workflowCwd });
			const body = renderFrame(frame);
			// ctx.ui.custom is TUI-only; degrade to a printed frame elsewhere.
			if (ctx.mode !== "tui" || ctx.ui?.custom === undefined) {
				ctx.ui?.notify?.(body, "info");
				return;
			}
			await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
				const lines = body.split("\n");
				return {
					render: () => lines,
					handleInput: (data: string) => {
						// Any key closes. A read-only board needs no other control.
						if (data.length > 0) done(undefined);
					},
				};
			});
		},
	});

	pi.registerCommand("wake", {
		description: "Run one reconcile pass now and report what changed",
		handler: async (_args: string, ctx: any) => {
			const result = reconcile();
			const parts: string[] = [];
			for (const item of result.interrupt) {
				parts.push(`T0 ${item.taskId}: ${item.event.verb} — ${item.event.note}`);
			}
			const folded = foldBatched(result.batched);
			if (folded !== null) parts.push(`T1 ${folded}`);
			if (parts.length === 0) parts.push("nothing actionable");
			ctx.ui?.notify?.(parts.join("\n"), "info");
		},
	});

	// ---- wake delivery ------------------------------------------------------

	/**
	 * Deliver a cycle's wakes: T0 one message per event, T1 as ONE folded
	 * message, T2 never. The fold is the fix for six queued follow-ups each
	 * burning a turn after the first drain had already handled them.
	 *
	 * Injection only happens while pi is IDLE. Injecting mid-turn is rejected
	 * ("Agent is already processing"), and forcing it through with a steer is
	 * exactly the interruption class this design removes. A wake deferred by one
	 * cycle is correct; the events are durable and reconcile is idempotent, so
	 * nothing is lost by waiting. Only the statusline updates while busy.
	 */
	function deliver(ctx: any): void {
		if (ctx?.isIdle?.() === false) {
			void refreshStatusline(ctx);
			return;
		}
		const result = reconcile();
		for (const item of result.interrupt) {
			pi.sendUserMessage?.(
				`[deck] ${item.taskId}: ${item.event.verb} — ${item.event.note}`,
				{ deliverAs: "followUp" },
			);
		}
		const folded = foldBatched(result.batched);
		if (folded !== null) {
			pi.sendUserMessage?.(`[deck] ${folded}`, { deliverAs: "followUp" });
		}
		for (const verdict of detectStale()) {
			pi.sendUserMessage?.(`[deck] ${verdict.taskId} stopped responding: ${verdict.reason}`, {
				deliverAs: "followUp",
			});
		}
		void refreshStatusline(ctx);
	}

	async function refreshStatusline(ctx: any): Promise<void> {
		try {
			const frame = await buildFrame(workflowCwd === undefined ? {} : { workflowCwd });
			ctx.ui?.setStatus?.("deck", renderStatusline(frame));
		} catch {
			// A statusline is decoration; never let it break a turn.
		}
	}

	pi.on("session_start", async (_event: unknown, ctx: any) => {
		workflowCwd = `${deckV2Home()}/workflows/.smithers`;
		// Reconcile at start: the durable baseline means this reports only what is
		// genuinely new, so a restart is quiet rather than a flood.
		deliver(ctx);
		timer = setInterval(() => deliver(ctx), RECONCILE_MS);
		unwatch = (await import("../wake")).watchStatusDir(() => deliver(ctx));
	});

	pi.on("session_shutdown", async () => {
		if (timer !== undefined) clearInterval(timer);
		unwatch?.();
		timer = undefined;
		unwatch = undefined;
	});
}

/** Exported for the installer's smoke test. */
export const TOOL_NAMES = [
	"spawn",
	"send",
	"status",
	"peek",
	"fleet",
	"teardown_check",
	"note",
	"backlog",
] as const;

export { stateFiles };
