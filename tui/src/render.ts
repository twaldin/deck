import { DEFAULT_CONFIG, type DeckEvent, type InboxCommand, type Manifest, type SessionRef, type Stage } from "@deck/core";
import type { AccountsViewData, BoardViewData, EffortViewData, LoadIssue, UsageReport } from "./types";

const STAGE_ORDER: Record<Stage, number> = {
	intake: 0,
	active: 1,
	review: 2,
	landed: 3,
	watching: 4,
	done: 5,
	abandoned: 6,
};

const SUMMARY_KEYS = ["summary", "message", "status", "reason", "result", "title"] as const;

function epochMs(value: number): number {
	return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function formatEpoch(value: number | null): string {
	if (value === null) return "-";
	return new Date(epochMs(value)).toISOString();
}

function formatUpdated(value: string): string {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return value;
	return new Date(parsed).toISOString().replace("T", " ").slice(0, 19);
}

function oneLine(value: string, limit = 110): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	if (collapsed.length <= limit) return collapsed;
	return `${collapsed.slice(0, Math.max(0, limit - 1))}…`;
}

function summarizeRecord(record: Record<string, unknown>): string {
	for (const key of SUMMARY_KEYS) {
		const value = record[key];
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			return oneLine(String(value));
		}
	}
	return oneLine(JSON.stringify(record));
}

function pad(value: string, width: number): string {
	const clipped = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
	return clipped.padEnd(width);
}

function sessionLiveness(session: SessionRef | null, now: number): string {
	if (session === null) return "-";
	if (session.last_heartbeat === null) return "NEVER";
	const age = Math.max(0, now - epochMs(session.last_heartbeat));
	const staleAfter = DEFAULT_CONFIG.router.heartbeatIntervalMs * 3;
	return `${age > staleAfter ? "STALE" : "live"} ${formatDuration(age)}`;
}

function overlayLabel(manifest: Manifest): string {
	const badges: string[] = [];
	if (manifest.overlays.needs_tim.length > 0) badges.push(`[needs_tim:${manifest.overlays.needs_tim.length}]`);
	if (manifest.overlays.blocked !== null) badges.push("[blocked]");
	return badges.length === 0 ? "-" : badges.join(" ");
}

function renderIssues(issues: readonly LoadIssue[]): string[] {
	if (issues.length === 0) return [];
	return ["", "READ ERRORS", ...issues.map(issue => `! ${issue.source}: ${oneLine(issue.message, 140)}`)];
}

export function sortBoardEfforts(efforts: readonly Manifest[]): Manifest[] {
	return [...efforts].sort((left, right) => {
		const leftNeedsTim = left.overlays.needs_tim.length > 0 ? 1 : 0;
		const rightNeedsTim = right.overlays.needs_tim.length > 0 ? 1 : 0;
		if (leftNeedsTim !== rightNeedsTim) return rightNeedsTim - leftNeedsTim;
		const stageDifference = STAGE_ORDER[left.stage] - STAGE_ORDER[right.stage];
		if (stageDifference !== 0) return stageDifference;
		const updatedDifference = (Date.parse(right.updated) || 0) - (Date.parse(left.updated) || 0);
		if (updatedDifference !== 0) return updatedDifference;
		return left.effort_id.localeCompare(right.effort_id);
	});
}

export function renderBoard(data: BoardViewData, selectedIndex: number, now: number): string[] {
	const efforts = sortBoardEfforts(data.efforts);
	const lines = [
		"DECK / BOARD",
		"",
		`  ${pad("stage", 10)} ${pad("effort", 30)} ${pad("title", 34)} ${pad("overlays", 24)} ${pad("cards", 5)} ${pad("heartbeat", 14)} updated`,
	];
	for (let index = 0; index < efforts.length; index += 1) {
		const effort = efforts[index];
		if (!effort) continue;
		const openCards = effort.cards.reduce((count, entry) => count + (entry.status === "open" ? 1 : 0), 0);
		const cursor = index === selectedIndex ? ">" : " ";
		lines.push(
			`${cursor} ${pad(effort.stage, 10)} ${pad(effort.effort_id, 30)} ${pad(effort.title, 34)} ${pad(overlayLabel(effort), 24)} ${pad(String(openCards), 5)} ${pad(sessionLiveness(effort.session, now), 14)} ${formatUpdated(effort.updated)}`,
		);
	}
	if (efforts.length === 0) lines.push("  No efforts found.");
	lines.push(...renderIssues(data.issues));
	return lines;
}

function renderEvent(event: DeckEvent): string {
	return `${event.ts}  ${event.type}  ${summarizeRecord(event.data)}`;
}

function renderInbox(command: InboxCommand): string[] {
	return [
		`${command.ts}  ${command.cmd_id}  from=${command.from}  delivered=${formatEpoch(command.delivered)}  acked=${formatEpoch(command.acked)}`,
		`    ${summarizeRecord(command.cmd)}`,
	];
}

export function renderEffort(data: EffortViewData, selectedCardIndex: number, now: number): string[] {
	const manifest = data.manifest;
	const lines = [`DECK / EFFORT / ${data.effortId}`, ""];
	if (manifest === null) {
		lines.push("Manifest unavailable.", ...renderIssues(data.issues));
		return lines;
	}

	lines.push(`title: ${manifest.title}`);
	lines.push(`stage: ${manifest.stage}`);
	lines.push(`heartbeat: ${sessionLiveness(manifest.session, now)}`);
	lines.push(`overlays: ${overlayLabel(manifest)}`);
	lines.push(`goal: ${data.charter?.goal ?? "(charter unavailable)"}`);

	const openCards = manifest.cards.filter(entry => entry.status === "open");
	lines.push("", `OPEN CARDS (${openCards.length})`);
	if (openCards.length === 0) lines.push("  none");
	for (let index = 0; index < openCards.length; index += 1) {
		const entry = openCards[index];
		if (!entry) continue;
		const cursor = index === selectedCardIndex ? ">" : " ";
		lines.push(`${cursor} [${index + 1}] ${entry.card.kind} ${entry.id}`);
		lines.push(`    question: ${entry.card.question}`);
		lines.push(`    recommendation: ${entry.card.recommendation}`);
		for (let optionIndex = 0; optionIndex < entry.card.options.length; optionIndex += 1) {
			lines.push(`    ${optionIndex + 1}. ${entry.card.options[optionIndex]}`);
		}
	}

	lines.push("", `DISPATCHES (${manifest.dispatches.length})`);
	if (manifest.dispatches.length === 0) lines.push("  none");
	for (const dispatch of manifest.dispatches) {
		lines.push(
			`  ${dispatch.state.padEnd(9)} ${dispatch.id}  ${dispatch.kind}:${dispatch.target}  started=${formatEpoch(dispatch.started)}  heartbeat=${sessionLiveness(dispatch.session, now)}`,
		);
	}

	lines.push("", `RECENT EVENTS (${data.events.length})`);
	if (data.events.length === 0) lines.push("  none");
	for (const event of data.events) lines.push(`  ${renderEvent(event)}`);

	lines.push("", `INBOX (${data.inbox.length})`);
	if (data.inbox.length === 0) lines.push("  none");
	for (const command of data.inbox) lines.push(...renderInbox(command).map(line => `  ${line}`));

	lines.push(...renderIssues(data.issues));
	return lines;
}

function usageIdentity(report: UsageReport): string {
	return report.metadata?.email ?? report.metadata?.accountId ?? report.metadata?.orgName ?? "unknown account";
}

export function renderAccounts(data: AccountsViewData, now: number): string[] {
	const lines = ["DECK / ACCOUNTS", ""];
	if (data.broker === null) {
		lines.push("broker: offline or unavailable");
	} else {
		lines.push(
			`broker: ${data.broker.version} pid=${data.broker.pid} uptime=${formatDuration(data.broker.uptimeMs)} gateway=${data.broker.gateway}`,
		);
		lines.push("", `CONTROL ACCOUNTS (${data.broker.accounts.length})`);
		if (data.broker.accounts.length === 0) lines.push("  none");
		for (const account of data.broker.accounts) {
			const identity = account.email ?? account.accountId ?? account.orgName ?? "unknown";
			lines.push(`  #${account.id} ${account.provider} ${identity} type=${account.type} expires=${formatEpoch(account.expires)}`);
			if (account.blocks.length === 0) {
				lines.push("    cooling: none");
			} else {
				for (const block of account.blocks) {
					const remaining = Math.max(0, epochMs(block.blockedUntilMs) - now);
					lines.push(
						`    cooling: ${block.providerKey}/${block.blockScope} until=${formatEpoch(block.blockedUntilMs)} (${formatDuration(remaining)} remaining)`,
					);
				}
			}
		}
	}

	lines.push("", `USAGE ROSTER${data.usage === null ? "" : ` generated=${data.usage.generatedAt}`}`);
	if (data.usage === null) {
		lines.push("  unavailable");
	} else if (data.usage.reports.length === 0) {
		lines.push("  none");
	} else {
		for (const report of data.usage.reports) {
			lines.push(`  ${report.provider} / ${usageIdentity(report)}  fetched=${formatEpoch(report.fetchedAt)}`);
			for (const limit of report.limits) {
				const usedPercent = Math.round(limit.amount.usedFraction * 100);
				lines.push(
					`    ${limit.label}: ${limit.amount.used}/${limit.amount.limit} ${limit.amount.unit} (${usedPercent}% used) status=${limit.status} resets=${formatEpoch(limit.window.resetsAt)}`,
				);
			}
		}
	}
	lines.push(...renderIssues(data.issues));
	return lines;
}
