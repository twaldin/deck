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
import { execFile as execFileCallback, spawn as spawnProcess } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DECK_OPERATIONAL_PREFIX, registerCalm } from "../calm";
import { appendStatus, readStatus } from "../events";
import {
	buildFactoryText,
	buildFactoryView,
	buildUsageText,
	buildFrame,
	collectPsSnapshot,
	collectRuns,
	type FleetTheme,
	PLAIN_FLEET_THEME,
	renderFrame,
	renderStatus,
	renderDeltaStatus,
	renderFooterLines,
	type FooterSessionBits,
	type PsRun,
} from "../monitor";
import { projectFleet } from "../herdr";
import { deckV2Home, stateFiles } from "../home";
import { standingRulesDigest } from "./standing-rules";
import { readMeta } from "../meta";
import { loadProfiles } from "../projects";
import { renderReasoning, setSeatReasoning, assertReasoningLevel } from "../reasoning";
import { observePsSnapshotWithInspect, type PsSnapshotRow } from "../observer";
import { gatewaySubscription } from "../gateway-subscription";
import { reconcileRecuts } from "../recut";
import { registerQuestions } from "../questions";
import { enqueue, pending } from "../queue";
import { pipelineDir, startShip } from "../ship";
import { peekSession, startRun } from "../spawn";
import { STATUS_VERBS, type StatusVerb } from "../status";
import { syncAuthDeadQuestions } from "../auth-dead";
import { queueFile } from "../questions-store";
import { mergeLiveAccounts, readLiveControlAccounts, readUsageRoster, usageStatusLine } from "../usage-roster";
import { discoverSmithersWorkspaces, smithersWorkspaceCwd, uiWarn, warnOnShadowWorkspace } from "../workspace";
import { evaluateTeardown, formatVerdict } from "../teardown";
import { ackWakes, detectStale, foldBatched, pendingWakes, reconcile } from "../wake";
import { reconcileWakeProducers } from "../wake-producers";
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

type DeckV2Dependencies = {
	/** Test seam for the raw ps command. Production uses the enriched collector below. */
	collectPsSnapshot?: typeof collectPsSnapshot;
	collectRuns?: typeof collectRuns;
	inspectRun?: (command: string, args: readonly string[], cwd: string) => Promise<{ stdout: string; exitCode: number } | null>;
	gatewayStream?: (workspace: string, onEvent: (event: import("../gateway-subscription").GatewayEvent) => void) => (() => void) | Promise<() => void>;
};

const inspectRun = promisify(execFile);
const INSPECT_TIMEOUT_MS = 15_000;
const INSPECT_MAX_BUFFER = 4_000_000;

export default function deckV2(pi: any, dependencies: DeckV2Dependencies = {}): void {
	// Keep the raw snapshot seam for focused extension tests, but never use it in
	// production. collectRuns performs the GitHub and Smithers enrichment needed
	// by every extension view and the statusline.
	const collectSnapshot = dependencies.collectPsSnapshot;
	const collectEnrichedRuns = dependencies.collectRuns ?? (collectSnapshot === undefined
		? collectRuns
		: async (cwd: string) => collectSnapshot(cwd));
	// Calm is presentation-only (see ../calm.ts); it never touches delivery.
	registerCalm(pi);
	// ask_captain + /questions live HERE, not in a globally installed extension:
	// deck-v2 only installs into the deck home's own .pi, so worker sessions
	// never register a competing question surface. See ../questions.ts.
	registerQuestions(pi);

	let unwatch: (() => void) | undefined;
	let refreshFactoryOverlay: (() => void) | undefined;
	let reconcileFallback: ReturnType<typeof setInterval> | undefined;
	let observing: Promise<void> = Promise.resolve();
	const RECONCILE_FALLBACK_MS = 60_000;
	let workflowCwd: string | undefined;
	let workflowWorkspaces: string[] = [];
	// Send-failure backoff protects against real queue transport errors. Wakes
	// remain durable in the outbox while a failed call is retried.
	let sendFailures = 0;
	let sendRetryAt = 0;
	const SEND_BACKOFF_BASE_MS = 60_000;
	const SEND_BACKOFF_MAX_MS = 15 * 60_000;
	// Busy fence prevents each watcher cycle from queueing another follow-up
	// during one turn. Events remain in the durable outbox until the turn settles.
	// This is intentional: follow-ups are queued only when pi is idle, then
	// acknowledged when the queued turn actually starts.
	let agentBusy = false;
	let pendingAckIds: string[] = [];
	// Re-entrancy lock: deliver() fires from the watcher and other lifecycle hooks
	// nudge; two overlapping async passes would drain the same outbox twice.
	let delivering = false;
	const warnedShadowFingerprints = new Set<string>();

	function busy(ctx: any): boolean {
		return (
			agentBusy ||
			pendingAckIds.length > 0 ||
			ctx?.isIdle?.() === false ||
			ctx?.hasPendingMessages?.() === true
		);
	}
	let lastFooterFrame = {
		generatedAt: new Date().toISOString(),
		tasks: [],
		workflows: [],
		counters: { tasks: 0, running: 0, blocked: 0, openDecisions: 0, queuedMessages: 0, openQuestions: 0, internalOpen: 0, internalCap: 0 },
		sources: [],
	} as Awaited<ReturnType<typeof buildFrame>>;

	let previousStatusFrame: Awaited<ReturnType<typeof buildFrame>> | null = null;
	const injectedCompactions = new Set<string>();
	let injectedSession = false;
	let compactionSequence = 0;

	async function injectStandingRules(ctx: any, key: string): Promise<void> {
		if (key === "session_start" ? injectedSession : injectedCompactions.has(key)) return;
		if (key === "session_start") injectedSession = true;
		else injectedCompactions.add(key);
		try {
			if (typeof pi.sendMessage !== "function") return;
			const result = pi.sendMessage(
				{ customType: "deck.standing-rules.v1", content: standingRulesDigest(), display: false },
				{ deliverAs: key === "session_start" ? "nextTurn" : "steer", triggerTurn: false },
			);
			if (result instanceof Promise) await result;
		} catch {
			if (key === "session_start") injectedSession = false;
			else injectedCompactions.delete(key);
		}
	}
	// ---- tools --------------------------------------------------------------

	pi.registerTool({
		name: "spawn",
		label: "Spawn",
		description:
			"Start a worker run for a task in an isolated worktree. Pass repo (path or alias) to allocate a fresh worktree; worktree (absolute path) is the escape hatch. The brief is generated from the task and acceptance criteria; do not write one by hand.",
		parameters: Type.Object({
			task_id: Type.String({ description: "slug: lowercase letters, digits, hyphens" }),
			task: Type.String({ description: "what to do, front-loaded and self-contained" }),
			acceptance: Type.Array(Type.String(), { description: "criteria that must pass" }),
			repo: Type.Optional(
				Type.String({ description: "repo to allocate a worktree from: absolute path or alias (lindy, deck)" }),
			),
			worktree: Type.Optional(
				Type.String({ description: "escape hatch: absolute path to an existing disposable worktree" }),
			),
			base: Type.Optional(Type.String({ description: "base branch/commit for allocation; default origin/main" })),
			desc: Type.Optional(Type.String({ description: "short label recorded on the worktree entry" })),
			kind: Type.Union([Type.Literal("ship"), Type.Literal("scout")]),
			no_pipeline: Type.Optional(
				Type.Boolean({
					description:
						"escape hatch: bare ship on a profiled project (refused otherwise). Ship efforts with the ship tool instead.",
				}),
			),
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
					kind: params.kind as "ship" | "scout",
					...(params.no_pipeline === true ? { noPipeline: true } : {}),
					...(params.worktree === undefined ? {} : { worktree: params.worktree as string }),
					...(params.repo === undefined ? {} : { repo: params.repo as string }),
					...(params.base === undefined ? {} : { base: params.base as string }),
					...(params.desc === undefined ? {} : { desc: params.desc as string }),
					...(params.project === undefined ? {} : { project: params.project as string }),
					...(params.branch === undefined ? {} : { branch: params.branch as string }),
					...(params.model === undefined ? {} : { model: params.model as string }),
					...(params.context === undefined ? {} : { context: params.context as string }),
				},
				deckV2Home(),
			);
			return text(
				`spawned ${result.taskId} (epoch ${result.epoch}, pid ${result.pid}, ${result.model})\nworktree: ${result.worktree}${result.wtId === undefined ? "" : ` (${result.wtId}, branch ${result.branch})`}\nbrief: ${result.briefPath}\nIt reports through its status file; it cannot contact the captain.`,
			);
		},
	});

	pi.registerTool({
		name: "ship",
		label: "Ship",
		description:
			"DEFAULT ship path for a profiled project: start its PR pipeline (adversarial review hard-gates the PR open; lindy-full parks for the captain's stamp, yolo-ship merges on green). The worktree must exist with the branch checked out and the work committed or described in the brief fields.",
		parameters: Type.Object({
			ticket: Type.String({ description: "ticket / effort id; seeds the run id" }),
			profile: Type.String({ description: "project profile id (lindy, deck, ...)" }),
			worktree: Type.String({ description: "absolute path to the task worktree" }),
			branch: Type.String(),
			title: Type.String(),
			summary: Type.String(),
			acceptance: Type.Array(Type.String(), { description: "concrete, checkable criteria" }),
			base: Type.Optional(Type.String({ description: "base branch; default main" })),
			break_signal: Type.Optional(Type.String({ description: "fallout signal to watch after landing" })),
			kill_switch: Type.Optional(Type.String({ description: "named kill-switch; omitted = explicit none" })),
			blast_radius: Type.Optional(Type.String()),
			reviewers: Type.Optional(Type.Array(Type.String())),
			deploy_evidence: Type.Optional(Type.String({ description: "shell command that proves the deploy" })),
			dry_run: Type.Optional(Type.Boolean({ description: "simulate side effects; default false" })),
			existing_pr: Type.Optional(
				Type.Integer({
					minimum: 1,
					description:
						"adopt an already-open PR by number: skip implement + local review, seed from gh, enter the same watch/stamp loop (never opens a second PR)",
				}),
			),
		}),
		async execute(_id: string, params: Record<string, unknown>, _signal: unknown, _onUpdate: unknown, ctx: any) {
			const result = await startShip({
				ticket: params.ticket as string,
				profile: params.profile as string,
				worktree: params.worktree as string,
				branch: params.branch as string,
				title: params.title as string,
				summary: params.summary as string,
				acceptance: (params.acceptance as string[]) ?? [],
				...(params.base === undefined ? {} : { baseBranch: params.base as string }),
				...(params.break_signal === undefined ? {} : { breakSignal: params.break_signal as string }),
				...(params.kill_switch === undefined ? {} : { killSwitch: params.kill_switch as string }),
				...(params.blast_radius === undefined ? {} : { blastRadius: params.blast_radius as string }),
				...(params.reviewers === undefined ? {} : { reviewers: params.reviewers as string[] }),
				...(params.deploy_evidence === undefined
					? {}
					: { deployEvidence: params.deploy_evidence as string }),
				...(params.dry_run === true ? { dryRun: true } : {}),
				...(params.existing_pr === undefined ? {} : { existingPr: params.existing_pr as number }),
				warningContext: ctx,
				warningFingerprints: warnedShadowFingerprints,
			});
			return text(
				`ship ${result.runId} started (pid ${result.pid}) \u2014 profile ${result.profile} (${result.pipeline})${result.dryRun ? " [DRY RUN]" : ""}\n` +
					`log: ${result.logPath}\n` +
					`watch from ${result.pipelineDir}: smithers ps; smithers why ${result.runId}\n` +
					`stamp parks resume with smithers approve + up --resume true. The pipeline owns the PR open, CI watch and merge; do not open a PR by hand.`,
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
		name: "factory",
		label: "Factory",
		description: "What every effort and workflow is doing right now.",
		parameters: Type.Object({}),
		async execute() {
			const frame = await getCurrentFrame();
			return text(buildFactoryText(frame, PLAIN_FLEET_THEME));
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

	pi.registerCommand("self-update", {
		description: "Pull deck and home updates, then reload the pi session atomically",
		handler: async (_args: string, ctx: any) => {
			const update = path.join(path.dirname(pipelineDir()), "..", "scripts", "update-home.sh");
			try {
				await new Promise<void>((resolve, reject) => {
					const child = spawnProcess("bash", [update], { stdio: "inherit" });
					child.once("error", reject);
					child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`update exited ${code}`)));
				});
				if (typeof ctx.reload === "function") await ctx.reload();
				else ctx.ui?.notify?.("Updated. Run /reload to activate the new extension.", "warning");
			} catch (error) {
				ctx.ui?.notify?.(`self-update failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	const factoryCommand = async (_args: string, ctx: any): Promise<void> => {
		// First paint is cache-only. Smithers ps is a slow shell-out and must
		// never delay opening the overlay.
		let frame = lastFooterFrame;
		// ctx.ui.custom is TUI-only; degrade to a printed frame elsewhere.
		if (ctx.mode !== "tui" || ctx.ui?.custom === undefined) {
			const liveFrame = await refreshStatusline(ctx);
			ctx.ui?.notify?.(buildFactoryText(liveFrame, asFleetTheme(ctx.ui?.theme ?? PLAIN_FLEET_THEME)), "info");
			return;
		}
		void refreshStatusline(ctx);
		await ctx.ui.custom(
			(tui: any, rawTheme: any, _kb: any, done: any) => {
				const theme = asFleetTheme(rawTheme);
				const box = new Box(2, 1, asBgFn(rawTheme));
				const maxBodyLines = (): number => Math.max(1, (tui.terminal?.rows ?? 40) - 8);
				const maxRowWidth = (): number => Math.floor((tui.terminal?.cols ?? 120) * 0.9) - 4;
				let scrollOffset = 0;
				let scrollable = false;
				const render = (): string => {
					const view = buildFactoryView(frame, theme, {
						maxBodyLines: maxBodyLines(),
						scrollOffset,
						maxRowWidth: maxRowWidth(),
						chrome: "bare",
					});
					scrollOffset = view.scrollOffset;
					scrollable = view.scrollable;
					return view.text;
				};
				const body = new Text(render(), 0, 0);
				box.addChild(body);
				let busy = false;
				const refresh = async (): Promise<void> => {
					if (busy) return;
					busy = true;
					try {
						frame = await getCurrentFrame();
						body.setText(render());
						tui.requestRender();
					} catch {
						// Keep the last good frame on a failed refresh.
					} finally {
						busy = false;
					}
				};
				refreshFactoryOverlay = () => void refresh();
				return {
					render: (width: number) => box.render(width),
					invalidate: () => box.invalidate(),
					handleInput: (data: string) => {
						if (data === "q" || data === "\u001b" || data === "\u0003") {
							done(undefined);
							return;
						}
						if (data === "j" || data === "\u001b[B") {
							if (!scrollable) return;
							scrollOffset += 1;
							body.setText(render());
							tui.requestRender();
							return;
						}
						if (data === "k" || data === "\u001b[A") {
							if (scrollOffset === 0) return;
							scrollOffset -= 1;
							body.setText(render());
							tui.requestRender();
							return;
						}
						if (data === "r") void refresh();
					},
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center", width: "90%", minWidth: 80, margin: 1, maxHeight: "100%" } },
		);
		refreshFactoryOverlay = undefined;
	};

	pi.registerCommand("factory", {
		description: "Factory overlay: live effort state (q/Esc close, r refresh, j/k scroll)",
		handler: factoryCommand,
	});

	pi.registerCommand("fleet", {
		description: "Deprecated alias for /factory",
		handler: async (args: string, ctx: any) => {
			ctx.ui?.notify?.("/fleet is now /factory.", "warning");
			await factoryCommand(args, ctx);
		},
	});

	pi.registerCommand("usage", {
		description: "Show broker quota by account and tier",
		handler: async (_args: string, ctx: any) => {
			const roster = readUsageRoster();
			// Read the atomic disk snapshot first. Broker status refresh is background
			// work, so a slow provider never delays the overlay.
			ctx.ui?.notify?.(buildUsageText(roster, asFleetTheme(ctx.ui?.theme ?? PLAIN_FLEET_THEME)), "info");
			void readLiveControlAccounts().then(() => {
				const fresh = readUsageRoster();
				if (fresh !== null && fresh.generatedAt !== roster?.generatedAt) {
					ctx.ui?.notify?.(buildUsageText(fresh, asFleetTheme(ctx.ui?.theme ?? PLAIN_FLEET_THEME)), "info");
				}
			}).catch(() => {});
		},
	});

	pi.registerCommand("reasoning", {
		description: "Show or set captain and worker reasoning levels",
		handler: async (rawArgs: string, ctx: any) => {
			const args = rawArgs.trim().split(/\s+/).filter(Boolean);
			try {
				const model = ctx.model as { id?: string; provider?: string } | undefined;
				const selfModel = model?.id === undefined
					? null
					: model.id.includes("/")
						? model.id
						: `${model.provider ?? "deck"}/${model.id}`;
				if (args.length === 0) {
					const selfLevel = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : "unknown";
					ctx.ui?.notify?.(renderReasoning(String(selfLevel), loadProfiles(), asFleetTheme(ctx.ui?.theme ?? PLAIN_FLEET_THEME), selfModel), "info");
					return;
				}
				if (args.length !== 2) throw new Error("usage: /reasoning [self|implementer|reviewer|watcher|fallout] <low|medium|high|xhigh|max>");
				const [target, requested] = args;
				const level = assertReasoningLevel(requested!);
				if (target === "self") {
					if (typeof pi.setThinkingLevel !== "function") throw new Error("pi thinking control is unavailable");
					pi.setThinkingLevel(level);
					const effective = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : level;
					ctx.ui?.notify?.(`deck reasoning\n  self  ${effective}`, "info");
					return;
				}
				const update = setSeatReasoning(target!, level);
				const lines = update.rows.map((row) => `  ${row.profile}/${row.seat}  ${row.level} · ${row.model}`);
				ctx.ui?.notify?.(["deck reasoning", ...update.warnings.map((warning) => `warning: ${warning}`), ...lines].join("\n"), update.warnings.length > 0 ? "warning" : "info");
			} catch (error) {
				ctx.ui?.notify?.(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("status", {
		description: "Show full diagnostic factory state, including completed and failed work",
		handler: async (_args: string, ctx: any) => {
			const current = await getCurrentFrame();
			ctx.ui?.notify?.(`${renderStatus(current)}\n${renderDeltaStatus(current, previousStatusFrame)}`, "info");
			previousStatusFrame = current;
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
	async function deliver(ctx: any): Promise<void> {
		if (delivering || busy(ctx) || Date.now() < sendRetryAt) {
			void refreshStatusline(ctx);
			return;
		}
		delivering = true;
		try {
			await deliverLocked(ctx);
		} finally {
			delivering = false;
		}
	}

	async function deliverLocked(ctx: any): Promise<void> {
		// Reconcile reads the status files and advances the durable cursor, then
		// persists whatever it found into the wake outbox. Delivery drains the
		// OUTBOX, not the reconcile result, and acknowledges only what was
		// actually sent. Delivering straight from the reconcile result made the
		// cursor advance the acknowledgement: if sendUserMessage was missing or
		// threw, the event was gone for good, and a lost `blocked:` is the worst
		// failure this system has.
		for (const workspace of workflowWorkspaces) reconcileWakeProducers(path.join(workspace, "wake-producers.json"));
		reconcile();
		// A dead OAuth grant needs the captain, so it becomes a durable question
		// rather than a chat line he can scroll past. Idempotent: one question per
		// account, auto-dismissed once the account authenticates again.
		try {
			syncAuthDeadQuestions(queueFile(), readUsageRoster(), {
				sessionId: ctx?.sessionManager?.getSessionId?.() ?? "deck-orchestrator",
				cwd: ctx?.sessionManager?.getCwd?.() ?? process.cwd(),
			});
		} catch {
			// The queue is best-effort here; never let it block wake delivery.
		}
		let attempted = 0;
		let sent = 0;
		for (const verdict of detectStale()) {
			// Staleness is derived from live facts, not from a status event, so it
			// is not an outbox entry; it is recomputed every cycle and is
			// therefore safe to send directly.
			attempted++;
			if (await send(ctx, `${DECK_OPERATIONAL_PREFIX}${verdict.taskId} stopped responding: ${verdict.reason}`)) sent++;
		}

		const pending = pendingWakes();
		const delivered: string[] = [];
		for (const entry of pending.filter((item) => item.tier === "T0")) {
			attempted++;
			if (await send(ctx, `${DECK_OPERATIONAL_PREFIX}${entry.taskId}: ${entry.verb} — ${entry.note}`)) {
				sent++;
				delivered.push(entry.id);
			}
		}
		// T1 folds into ONE message per cycle: six queued follow-ups each burning a
		// turn is the failure the captain screenshotted. The fold is acknowledged
		// as a unit because it was sent as a unit.
		const batched = pending.filter((item) => item.tier === "T1");
		if (batched.length > 0) {
			attempted++;
			const folded = foldBatched(
				batched.map((entry) => ({
					taskId: entry.taskId,
					tier: entry.tier,
					event: { verb: entry.verb as any, note: entry.note, raw: entry.raw },
				})) as any,
			);
			if (folded !== null && (await send(ctx, `${DECK_OPERATIONAL_PREFIX}${folded}`))) {
				sent++;
				delivered.push(...batched.map((entry) => entry.id));
			}
		}
		// sendMessage confirms queue acceptance, not turn delivery. Keep these
		// entries owed until pi reports that the queued follow-up has started.
		pendingAckIds.push(...delivered);
		if (sent < attempted) {
			// A send failed: back off exponentially, capped. Undelivered wakes stay
			// owed in the outbox and are retried when the window opens.
			sendFailures++;
			sendRetryAt =
				Date.now() + Math.min(SEND_BACKOFF_BASE_MS * 2 ** (sendFailures - 1), SEND_BACKOFF_MAX_MS);
		} else if (attempted > 0) {
			sendFailures = 0;
			sendRetryAt = 0;
		}
		void refreshStatusline(ctx);
	}

	/**
	 * Send one message through pi's queue. Pi queues follow-ups while busy and
	 * starts a turn when idle. A false return leaves the wake owed.
	 */
	async function send(_ctx: any, text: string): Promise<boolean> {
		try {
			if (typeof pi.sendMessage !== "function") return false;
			const out = pi.sendMessage(
				{ customType: "deck.wake", content: text, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			) as unknown;
			if (out instanceof Promise) await out;
			return true;
		} catch {
			return false;
		}
	}

	async function getCurrentFrame(): Promise<Awaited<ReturnType<typeof buildFrame>>> {
		const snapshots = workflowWorkspaces.length === 0
			? []
			: await Promise.all(workflowWorkspaces.map(async (workspace) => ({ workspace, snapshot: await collectEnrichedRuns(workspace) })));
		const workflowSnapshot = snapshots.find(({ workspace }) => workspace === workflowCwd)?.snapshot;
		const allRuns = snapshots.flatMap(({ snapshot: current }) => current.runs);
		const rows = snapshots.flatMap(({ workspace, snapshot: current }) => current.runs.map((run) => ({ ...run, workspace }))) as PsSnapshotRow[];
		if (workflowCwd !== undefined) void reconcileRecuts(workflowCwd, pipelineDir(), workflowSnapshot?.runs ?? []).catch(() => {});
		if (workflowCwd !== undefined && dependencies.gatewayStream !== undefined) {
			const subscription = gatewaySubscription(workflowCwd);
			if (!subscription.isRunning) {
				subscription.subscribe(({ observation }) => {
					void import("../observer").then(({ observeOnce }) => observeOnce(observation.run.id, observation));
				});
				subscription.start((onEvent) => dependencies.gatewayStream!(workflowCwd!, onEvent));
			}
		}
		if (workflowCwd !== undefined) {
			const observationKey = rows.map((row) => `${row.workspace}:${row.id}:${row.status}:${row.step ?? ""}`).join("|");
			observing = observing.then(() => gatewaySubscription(workflowCwd!).request(observationKey, () => observePsSnapshotWithInspect({
				rows,
				workspace: workflowCwd!,
				run: async (command, args, cwd) => {
					try {
						const result = await execFileAsync(command, [...args], { cwd, maxBuffer: 10 * 1024 * 1024 });
						return { stdout: result.stdout, exitCode: 0 };
					} catch (error: any) {
						return { stdout: typeof error?.stdout === "string" ? error.stdout : "", exitCode: error?.code ?? 1 };
					}
				},
			}))).then(() => undefined, () => undefined);
		}
		const frame = workflowCwd === undefined
			? await buildFrame({})
			: await buildFrame({
					workflowCwd,
					psRuns: allRuns,
				});
		lastFooterFrame = frame;
		return frame;
	}

	let refreshingStatusline: Promise<Awaited<ReturnType<typeof buildFrame>>> | undefined;
	async function refreshStatusline(ctx: any): Promise<Awaited<ReturnType<typeof buildFrame>>> {
		if (refreshingStatusline !== undefined) return refreshingStatusline;
		refreshingStatusline = (async () => {
			try {
				const frame = await getCurrentFrame();
				ctx.ui?.setStatus?.("deck-usage", undefined);
				// Herdr projection rides the same cadence: every reconcile cycle mirrors
				// worker state into herdr agents (smithers runs are fleet-only). Guarded
				// inside; herdr being down makes this a no-op, never a fault.
				await projectFleet(frame);
				return frame;
			} catch {
				// A statusline is decoration; never let it break a turn.
				return lastFooterFrame;
			} finally {
				refreshingStatusline = undefined;
			}
		})();
		return refreshingStatusline;
	}

	pi.on("session_start", async (_event: unknown, ctx: any) => {
		injectedSession = false;
		injectedCompactions.clear();
		compactionSequence = 0;
		warnedShadowFingerprints.clear();
		await injectStandingRules(ctx, "session_start");
		workflowCwd = smithersWorkspaceCwd();
		workflowWorkspaces = discoverSmithersWorkspaces();
		for (const workspace of workflowWorkspaces) reconcileWakeProducers(path.join(workspace, "wake-producers.json"));
		// Automatic wake is TUI-only by design. A future deck-notifier projection
		// can consume this same multi-workspace observation for no-TUI sessions.
		warnOnShadowWorkspace(
			undefined,
			(message) => uiWarn(ctx, message),
			warnedShadowFingerprints,
		);
		// The deck footer owns quota presentation. Block the legacy deck-usage
		// status slot so its timer cannot paint a second chrome strip.
		const setStatus = ctx.ui?.setStatus;
		if (typeof setStatus === "function") {
			ctx.ui.setStatus = function (id: string, value: unknown): void {
				if (id === "deck-usage") return;
				setStatus.call(ctx.ui, id, value);
			};
		}
		ctx.ui?.setFooter?.((tui: any, theme: any, footerData: any) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			const usage = (): FooterSessionBits => {
				let inputTokens = 0;
				let outputTokens = 0;
				let cacheReadTokens = 0;
				let cacheWriteTokens = 0;
				let cost = 0;
				for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
					const usage = entry.type === "message" ? entry.message?.usage : entry.usage;
					if (usage === undefined) continue;
					inputTokens += usage.input;
					outputTokens += usage.output;
					cacheReadTokens += usage.cacheRead;
					cacheWriteTokens += usage.cacheWrite;
					cost += usage.cost.total;
				}
				return {
					cwd: ctx.sessionManager?.getCwd?.() ?? ctx.cwd,
					branch: footerData.getGitBranch?.(),
					model: ctx.model?.id,
					contextPercent: ctx.getContextUsage?.()?.percent,
					inputTokens,
					outputTokens,
					cacheReadTokens,
					cacheWriteTokens,
					cost,
					usageLine: usageStatusLine(readUsageRoster(), asFleetTheme(theme)),
				};
			};
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const frame = lastFooterFrame;
					return renderFooterLines(frame, usage(), asFleetTheme(theme), width);
				},
			};
		});
		// The durable outbox is the delivery contract. The status directory watcher
		// wakes delivery when a workflow publishes a new item. A startup pass covers
		// items that arrived before the watcher was installed.
		if (ctx.mode === "tui") {
			void deliver(ctx);
			unwatch = (await import("../wake")).watchStatusDir(() => {
				void deliver(ctx);
				refreshFactoryOverlay?.();
			});
			// The watcher is the primary trigger. This low-rate fallback protects
			// delivery when fs.watch is unavailable or drops an event.
			reconcileFallback = setInterval(() => void deliver(ctx), RECONCILE_FALLBACK_MS);
			reconcileFallback.unref?.();
		}
	});

	// A queued follow-up is durable until the next turn starts. This avoids
	// acknowledging a wake that is still only in pi's in-memory queue.
	pi.on("before_agent_start", async () => {
		agentBusy = true;
	});
	pi.on("agent_start", async () => {
		agentBusy = true;
		if (pendingAckIds.length > 0) {
			ackWakes(pendingAckIds);
			pendingAckIds = [];
		}
	});
	pi.on("agent_settled", async () => {
		agentBusy = false;
	});

	pi.on("session_compact", async (event: any, ctx: any) => {
		const key = String(event?.compactionEntry?.id ?? event?.id ?? `compaction-${compactionSequence++}`);
		await injectStandingRules(ctx, key);
	});

	pi.on("session_shutdown", async () => {
		try {
			unwatch?.();
		} finally {
			if (reconcileFallback !== undefined) clearInterval(reconcileFallback);
		}
		unwatch = undefined;
		refreshFactoryOverlay = undefined;
		// Queue acceptance is not delivery. If shutdown happens before the
		// queued turn starts, leave the outbox entries owed and drop only the
		// in-memory fence so a later session can retry them.
		pendingAckIds = [];
		agentBusy = false;
	});
}

/**
 * Adapt pi's theme to the two calls the renderer uses. Method-style calls keep
 * the receiver (Theme.fg reads this.fgColors); see deck-usage.ts for the
 * incident that taught this.
 */
/**
 * Panel fill from pi's theme, so the overlay reads as a solid card over the
 * conversation instead of a border floating on noise. customMessageBg is the
 * theme's "distinct surface" key; missing/odd themes fall back to no fill.
 */
function asBgFn(source: unknown): ((text: string) => string) | undefined {
	if (typeof source !== "object" || source === null) return undefined;
	const probe = source as { bg?: unknown };
	if (typeof probe.bg !== "function") return undefined;
	const themed = source as { bg: (key: string, text: string) => unknown };
	return (text) => {
		const out = themed.bg("customMessageBg", text);
		return typeof out === "string" ? out : text;
	};
}

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

/** Exported for the installer's smoke test. */
export const TOOL_NAMES = [
	"ask_captain",
	"spawn",
	"ship",
	"send",
	"status",
	"peek",
	"factory",
	"fleet",
	"teardown_check",
	"note",
	"backlog",
] as const;

export { stateFiles };
