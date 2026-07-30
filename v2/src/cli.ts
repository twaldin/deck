/**
 * The CLI face. A thin argv parser over the same exports the extension imports:
 * no subprocess hop, no duplicated logic, no second implementation to drift.
 *
 * Crews and scripts use this from a shell. The orchestrator uses the extension
 * tools. Both are faces on @deck/v2.
 */
import * as path from "node:path";
import {
	assertDispatchable,
	closeInternal,
	createInternal,
	externalize,
	internalSummary,
	openItems,
	sweepExpired,
} from "./backlog";
import { bootstrapHome, formatBootstrap } from "./bootstrap";
import { appendStatus, readStatus } from "./events";
import { buildFrame, renderFrame, renderStatusline } from "./fleet";
import { assertHomeIsNotACheckout, deckV2Home, stateFiles } from "./home";
import { readMeta } from "./meta";
import { enqueue, pending } from "./queue";
import { peekSession, startRun } from "./spawn";
import { STATUS_VERBS, type StatusVerb } from "./status";
import { evaluateTeardown, formatVerdict } from "./teardown";
import { detectStale, foldBatched, reconcile } from "./wake";

const USAGE = `deck-v2 — fleet primitives

  bootstrap                        create the orchestrator home (not a checkout)
  spawn <id> --task <text> --accept <text> --worktree <path> [--kind ship|scout]
             [--project <name>] [--branch <name>] [--model <deck/model>]
  send <id> <message>              queue a message for the task's next run
  status <id> [--json]             the task's events and current reconciliation
  peek <id> [--limit N]            tail the task's session transcript
  fleet [--json] [--statusline]    the fleet frame
  wake [--json]                    one reconcile pass (T0 now, T1 folded, T2 silent)
  stale                            runs that vanished without a terminal status
  teardown <id> [--pr N]           evaluate the teardown guard (never destructive)
  note <id> <verb> <text>          append a status event as the orchestrator
  backlog ls|add|close|externalize|sweep|check
  home                             print the resolved home

Every command reads and writes the same records the pi extension does.`;

type Args = { _: string[]; flags: Record<string, string | boolean> };

function parse(argv: string[]): Args {
	const out: Args = { _: [], flags: {} };
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === undefined) continue;
		if (token.startsWith("--")) {
			const key = token.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) out.flags[key] = true;
			else {
				out.flags[key] = next;
				i += 1;
			}
		} else out._.push(token);
	}
	return out;
}

function str(flags: Args["flags"], key: string): string | undefined {
	const value = flags[key];
	return typeof value === "string" ? value : undefined;
}

function need(flags: Args["flags"], key: string): string {
	const value = str(flags, key);
	if (value === undefined) throw new Error(`--${key} is required`);
	return value;
}

export async function runCli(argv: string[]): Promise<number> {
	const args = parse(argv);
	const command = args._[0];
	if (command === undefined || command === "help" || args.flags.help === true) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}

	// A checkout home is the fm2 mistake; refuse it before any state write.
	if (command !== "home" && command !== "help") {
		try {
			assertHomeIsNotACheckout();
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			return 1;
		}
	}

	try {
		switch (command) {
			case "home":
				process.stdout.write(`${deckV2Home()}\n`);
				return 0;

			case "bootstrap": {
				// import.meta.dir is v2/src, so the package root is one level up.
				const repoV2Dir = path.resolve(import.meta.dir, "..");
				process.stdout.write(
					`${formatBootstrap(bootstrapHome({ repoV2Dir, home: str(args.flags, "home") ?? deckV2Home() }))}\n`,
				);
				return 0;
			}

			case "spawn": {
				const id = args._[1];
				if (id === undefined) throw new Error("spawn needs a task id");
				const accept = str(args.flags, "accept");
				const result = startRun(
					{
						taskId: id,
						task: need(args.flags, "task"),
						acceptance: accept === undefined ? [] : accept.split(";").map((s) => s.trim()),
						worktree: path.resolve(need(args.flags, "worktree")),
						kind: str(args.flags, "kind") === "scout" ? "scout" : "ship",
						...(str(args.flags, "project") === undefined
							? {}
							: { project: need(args.flags, "project") }),
						...(str(args.flags, "branch") === undefined
							? {}
							: { branch: need(args.flags, "branch") }),
						...(str(args.flags, "model") === undefined
							? {}
							: { model: need(args.flags, "model") }),
					},
					deckV2Home(),
				);
				process.stdout.write(
					`spawned ${result.taskId} epoch=${result.epoch} pid=${result.pid} model=${result.model}\nbrief: ${result.briefPath}\n`,
				);
				return 0;
			}

			case "send": {
				const id = args._[1];
				const message = args._.slice(2).join(" ");
				if (id === undefined || message.length === 0) throw new Error("send needs an id and a message");
				const queued = enqueue(id, message, "captain");
				process.stdout.write(
					`queued ${queued.id} for ${id}; delivered to its next run (${pending(id).length} pending)\n`,
				);
				return 0;
			}

			case "status": {
				const id = args._[1];
				if (id === undefined) throw new Error("status needs a task id");
				const read = readStatus(id);
				if (args.flags.json === true) {
					process.stdout.write(`${JSON.stringify({ ...read, meta: readMeta(id) }, null, 2)}\n`);
					return 0;
				}
				for (const event of read.events) process.stdout.write(`${event.raw.trim()}\n`);
				for (const bad of read.malformed) {
					process.stderr.write(`MALFORMED: ${bad.raw.trim()} (${bad.reason})\n`);
				}
				return read.malformed.length > 0 ? 1 : 0;
			}

			case "peek": {
				const id = args._[1];
				if (id === undefined) throw new Error("peek needs a task id");
				const limitFlag = str(args.flags, "limit");
				const entries = peekSession(id, limitFlag === undefined ? 12 : Number.parseInt(limitFlag, 10));
				if (entries.length === 0) {
					process.stdout.write(`no session yet for ${id}\n`);
					return 0;
				}
				for (const entry of entries) {
					process.stdout.write(`[${entry.role}] ${entry.text.slice(0, 400)}\n`);
				}
				return 0;
			}

			case "fleet": {
				const frame = await buildFrame({
					workflowCwd: str(args.flags, "workflows") ?? path.join(deckV2Home(), "workflows", ".smithers"),
				});
				if (args.flags.json === true) process.stdout.write(`${JSON.stringify(frame, null, 2)}\n`);
				else if (args.flags.statusline === true) process.stdout.write(`${renderStatusline(frame)}\n`);
				else process.stdout.write(`${renderFrame(frame)}\n`);
				return 0;
			}

			case "wake": {
				const result = reconcile();
				if (args.flags.json === true) {
					process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
					return 0;
				}
				for (const item of result.interrupt) {
					process.stdout.write(`T0 ${item.taskId}: ${item.event.verb} — ${item.event.note}\n`);
				}
				const folded = foldBatched(result.batched);
				if (folded !== null) process.stdout.write(`T1 ${folded}\n`);
				process.stdout.write(
					`(${result.silent.length} silent, ${result.rescanned.length} rescanned, ${result.malformed.length} malformed)\n`,
				);
				return 0;
			}

			case "stale": {
				const verdicts = detectStale();
				for (const verdict of verdicts) {
					process.stdout.write(`${verdict.taskId}: ${verdict.reason}\n`);
				}
				if (verdicts.length === 0) process.stdout.write("no stale runs\n");
				return 0;
			}

			case "teardown": {
				const id = args._[1];
				if (id === undefined) throw new Error("teardown needs a task id");
				const prFlag = str(args.flags, "pr");
				const verdict = evaluateTeardown(id, {
					...(prFlag === undefined ? {} : { prNumber: Number.parseInt(prFlag, 10) }),
				});
				process.stdout.write(`${formatVerdict(id, verdict)}\n`);
				return verdict.allowed ? 0 : 1;
			}

			case "note": {
				const id = args._[1];
				const verb = args._[2];
				const text = args._.slice(3).join(" ");
				if (id === undefined || verb === undefined || text.length === 0) {
					throw new Error("note needs an id, a verb and text");
				}
				if (!STATUS_VERBS.includes(verb as StatusVerb)) {
					throw new Error(`${verb} is not a status verb (${STATUS_VERBS.join(", ")})`);
				}
				process.stdout.write(`${appendStatus(id, verb as StatusVerb, text)}\n`);
				return 0;
			}

			case "backlog":
				return backlog(args);

			default:
				process.stderr.write(`unknown command ${command}\n\n${USAGE}\n`);
				return 2;
		}
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

function backlog(args: Args): number {
	const sub = args._[1] ?? "ls";
	switch (sub) {
		case "ls": {
			const items = openItems();
			const summary = internalSummary();
			process.stdout.write(
				`internal items ${summary.open}/${summary.cap} open${
					summary.nearestExpiry === null ? "" : `, nearest expiry ${summary.nearestExpiry}`
				}\n`,
			);
			for (const item of items) {
				process.stdout.write(
					`  ${item.id}  ${item.type}  expires ${item.expires_at}  holds ${item.holds}  ${item.intent}\n`,
				);
			}
			process.stdout.write(
				"\nDelivery work is not here: it is a query over PRs and tickets.\n",
			);
			return 0;
		}
		case "add": {
			const id = args._[2];
			if (id === undefined) throw new Error("backlog add needs an id");
			const item = createInternal({
				id,
				type: need(args.flags, "type"),
				intent: need(args.flags, "intent"),
				owner: str(args.flags, "owner") ?? "orchestrator",
				...(str(args.flags, "hours") === undefined
					? {}
					: { expiryHours: Number.parseInt(need(args.flags, "hours"), 10) }),
			});
			process.stdout.write(`added ${item.id} (${item.type}), expires ${item.expires_at}\n`);
			return 0;
		}
		case "close": {
			const id = args._[2];
			if (id === undefined) throw new Error("backlog close needs an id");
			const item = closeInternal(id, args._.slice(3).join(" ") || need(args.flags, "reason"));
			process.stdout.write(`closed ${item.id}: ${item.close_reason}\n`);
			return 0;
		}
		case "externalize": {
			const id = args._[2];
			const ref = args._[3];
			if (id === undefined || ref === undefined) {
				throw new Error("backlog externalize needs an id and the ticket/PR reference");
			}
			const item = externalize(id, ref);
			process.stdout.write(`externalized ${item.id} -> ${item.external_ref}\n`);
			return 0;
		}
		case "sweep": {
			const closed = sweepExpired();
			process.stdout.write(`swept ${closed.length} expired item(s)\n`);
			return 0;
		}
		case "check": {
			const ref = args._[2];
			if (ref === undefined) throw new Error("backlog check needs a reference");
			assertDispatchable(ref);
			process.stdout.write(`${ref} is dispatchable\n`);
			return 0;
		}
		default:
			process.stderr.write(`unknown backlog subcommand ${sub}\n`);
			return 2;
	}
}

/** Path to a task's status file, for briefs and shell use. */
export function statusPathFor(taskId: string): string {
	return stateFiles(taskId).status;
}
