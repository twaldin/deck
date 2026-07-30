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
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DECK_OPERATIONAL_PREFIX, registerCalm } from "../calm";
import { appendStatus, readStatus } from "../events";
import {
	buildFleetText,
	buildFrame,
	type FleetTheme,
	PLAIN_FLEET_THEME,
	renderFrame,
	renderStatusline,
} from "../fleet";
import { projectFleet } from "../herdr";
import { deckV2Home, stateFiles } from "../home";
import { readMeta } from "../meta";
import { enqueue, pending } from "../queue";
import { peekSession, startRun } from "../spawn";
import { STATUS_VERBS, type StatusVerb } from "../status";
import { evaluateTeardown, formatVerdict } from "../teardown";
import { ackWakes, detectStale, foldBatched, pendingWakes, reconcile } from "../wake";
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
	// Calm is presentation-only (see ../calm.ts); it never touches delivery.
	registerCalm(pi);

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
		description: "Fleet overlay: runs, workflows, PRs, decisions (q/Esc close, r refresh, live)",
		handler: async (_args: string, ctx: any) => {
			const frameOptions = workflowCwd === undefined ? {} : { workflowCwd };
			const frame = await buildFrame(frameOptions);
			// ctx.ui.custom is TUI-only; degrade to a printed frame elsewhere.
			if (ctx.mode !== "tui" || ctx.ui?.custom === undefined) {
				ctx.ui?.notify?.(renderFrame(frame), "info");
				return;
			}
			await ctx.ui.custom(
				(tui: any, rawTheme: any, _kb: any, done: any) => {
					const theme = asFleetTheme(rawTheme);
					// Box paints a background across all children — that is what makes
					// the overlay opaque instead of layering over the transcript.
					const box = new Box(2, 1, backgroundFn(rawTheme));
					const body = new Text(buildFleetText(frame, theme), 0, 0);
					box.addChild(body);

					// In-flight guard: buildFrame shells out to smithers ps, which can
					// outlast a tick; overlapping rebuilds would pile up subprocesses.
					let busy = false;
					const refresh = async (): Promise<void> => {
						if (busy) return;
						busy = true;
						try {
							body.setText(buildFleetText(await buildFrame(frameOptions), theme));
							tui.requestRender();
						} catch {
							// keep the last good frame on a failed refresh
						} finally {
							busy = false;
						}
					};
					const timer = setInterval(() => void refresh(), 5_000);
					timer.unref?.();

					return {
						render: (width: number) => box.render(width),
						invalidate: () => box.invalidate(),
						handleInput: (data: string) => {
							if (data === "q" || data === "\u001b" || data === "\u0003") {
								clearInterval(timer);
								done(undefined);
								return;
							}
							if (data === "r") void refresh();
						},
					};
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: "80%", margin: 2 } },
			);
		},
	});

	pi.registerCommand("wake", {
		description: "Run one reconcile pass now and report what changed",
		handler: async (_args: string, ctx: any) => {
			// Reconcile, then report from the OUTBOX rather than the reconcile
			// result. Reporting from the result would show the captain events that
			// are still owed, and reconcile's cursor advance means a second reader
			// of the same result cannot see them again — this command must observe
			// the queue, not consume it.
			reconcile();
			const pending = pendingWakes();
			const parts = pending.map((entry) => `${entry.tier} ${entry.taskId}: ${entry.verb} — ${entry.note}`);
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
		// Reconcile reads the status files and advances the durable cursor, then
		// persists whatever it found into the wake outbox. Delivery drains the
		// OUTBOX, not the reconcile result, and acknowledges only what was
		// actually sent. Delivering straight from the reconcile result made the
		// cursor advance the acknowledgement: if sendUserMessage was missing or
		// threw, the event was gone for good, and a lost `blocked:` is the worst
		// failure this system has.
		reconcile();
		for (const verdict of detectStale()) {
			// Staleness is derived from live facts, not from a status event, so it
			// is not an outbox entry; it is recomputed every cycle and is
			// therefore safe to send directly.
			send(ctx, `${DECK_OPERATIONAL_PREFIX}${verdict.taskId} stopped responding: ${verdict.reason}`);
		}

		const pending = pendingWakes();
		if (pending.length === 0) {
			void refreshStatusline(ctx);
			return;
		}
		const delivered: string[] = [];
		for (const entry of pending.filter((item) => item.tier === "T0")) {
			if (send(ctx, `${DECK_OPERATIONAL_PREFIX}${entry.taskId}: ${entry.verb} — ${entry.note}`)) {
				delivered.push(entry.id);
			}
		}
		// T1 folds into ONE message per cycle: six queued follow-ups each burning a
		// turn is the failure the captain screenshotted. The fold is acknowledged
		// as a unit because it was sent as a unit.
		const batched = pending.filter((item) => item.tier === "T1");
		if (batched.length > 0) {
			const folded = foldBatched(
				batched.map((entry) => ({
					taskId: entry.taskId,
					tier: entry.tier,
					event: { verb: entry.verb as any, note: entry.note, raw: entry.raw },
				})) as any,
			);
			if (folded !== null && send(ctx, `${DECK_OPERATIONAL_PREFIX}${folded}`)) {
				delivered.push(...batched.map((entry) => entry.id));
			}
		}
		ackWakes(delivered);
		void refreshStatusline(ctx);
	}

	/**
	 * Send one message, reporting whether it actually went out. A false return
	 * leaves the wake owed, so the next cycle retries it.
	 */
	function send(ctx: any, text: string): boolean {
		try {
			if (typeof pi.sendUserMessage !== "function") return false;
			pi.sendUserMessage(text, { deliverAs: "followUp" });
			return true;
		} catch {
			return false;
		}
	}

	async function refreshStatusline(ctx: any): Promise<void> {
		try {
			const frame = await buildFrame(workflowCwd === undefined ? {} : { workflowCwd });
			ctx.ui?.setStatus?.("deck", renderStatusline(frame));
			// Herdr projection rides the same cadence: every reconcile cycle mirrors
			// worker + smithers state into herdr agents. Guarded inside; herdr being
			// down makes this a no-op, never a fault.
			await projectFleet(frame, workflowCwd === undefined ? {} : { workflowCwd });
		} catch {
			// A statusline is decoration; never let it break a turn.
		}
	}

	pi.on("session_start", async (_event: unknown, ctx: any) => {
		workflowCwd = `${deckV2Home()}/workflows/.smithers`;
		// The wake loop only runs for an interactive orchestrator.
		//
		// Waking means injecting a user message, which needs a live session with a
		// captain reading it. In print mode there is a single prompt and no one to
		// wake: the injection is rejected outright ("Agent is already processing")
		// because the run is already under way by the time a timer fires, and even
		// at session_start, when isIdle() is still true, the send lands mid-startup.
		// RPC has a caller driving the conversation, so unsolicited turns are the
		// caller's business, not ours.
		//
		// The tools still work in every mode; only the automatic waking is gated.
		if (ctx?.mode !== "tui") return;

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

/**
 * Adapt pi's theme to the two calls the renderer uses. Method-style calls keep
 * the receiver (Theme.fg reads this.fgColors); see deck-usage.ts for the
 * incident that taught this.
 */
function asFleetTheme(source: unknown): FleetTheme {
	if (typeof source !== "object" || source === null) return PLAIN_FLEET_THEME;
	const probe = source as { fg?: unknown; bold?: unknown };
	if (typeof probe.fg !== "function" || typeof probe.bold !== "function") return PLAIN_FLEET_THEME;
	const themed = source as {
		fg: (key: string, text: string) => unknown;
		bold: (text: string) => unknown;
	};
	return {
		fg: (key, text) => {
			const out = themed.fg(key, text);
			return typeof out === "string" ? out : text;
		},
		bold: (text) => {
			const out = themed.bold(text);
			return typeof out === "string" ? out : text;
		},
	};
}

/** Background fill so the overlay is opaque instead of transparent. */
function backgroundFn(source: unknown): ((text: string) => string) | undefined {
	if (typeof source !== "object" || source === null) return undefined;
	const probe = source as { bg?: unknown };
	if (typeof probe.bg !== "function") return undefined;
	const themed = source as { bg: (key: string, text: string) => unknown };
	return (text) => {
		const out = themed.bg("customMessageBg", text);
		return typeof out === "string" ? out : text;
	};
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
