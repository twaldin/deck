/**
 * Backlog contract, decided by Smithers <Debate> run-1785401356109 (verdict:
 * hybrid, cross-family proposer/opponent with a planning judge).
 *
 * The shape, and why:
 *
 * DELIVERY WORK IS A QUERY, NOT A TABLE. Open PRs and labelled tickets already
 * live in GitHub and Linear, and pr-pipeline already drives them end to end.
 * Mirroring that into a fleet-writable table is exactly what produced fm2's 90+
 * items in days and made the dashboard render stale rows. So there is no
 * delivery-task table here to insert into.
 *
 * INTERNAL ITEMS EXIST, BUT ARE STRUCTURALLY CRIPPLED. Four real work classes
 * have no external ticket: scout, investigation, chore, decision. Forcing those
 * into Linear is unsafe — Done is terminal, parent-close cascades, and its own
 * automation moves tickets — so a half-formed scout note can be silently killed.
 * They get a small internal list that cannot become a second delivery queue:
 * no dependencies, no children, no dispatch, a hard cap, and exactly two exits.
 *
 * THE BOUNDARY IS ENFORCED AT ONE DOOR, NOT BY POLICY. pr-pipeline requires an
 * external reference as input, so an internal item is undispatchable by
 * construction. The judge's decisive point: fm2 already ran the expiry doctrine
 * and still drowned, so policy cannot be the primary control.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { dataDir, ensureHomeDirs } from "./home";

/** The only four classes allowed an internal item. An enum, not free text. */
export const INTERNAL_TYPES = ["scout", "investigation", "chore", "decision"] as const;
export type InternalType = (typeof INTERNAL_TYPES)[number];

/** Churn circuit breaker fm2 lacked. Tunable; enforced at write time. */
export const INTERNAL_CAP = 20;
export const DEFAULT_EXPIRY_HOURS = 72;
export const MAX_HOLDS = 2;

export type InternalItem = {
	id: string;
	type: InternalType;
	intent: string;
	owner: string;
	expires_at: string;
	created_at: string;
	state: "open" | "closed";
	holds: number;
	closed_at?: string;
	close_reason?: string;
	/** Set when the item externalized: the ticket/PR it became. */
	external_ref?: string;
};

function itemsFile(): string {
	return path.join(dataDir(), "internal-items.json");
}

export function readItems(): InternalItem[] {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(itemsFile(), "utf8"));
		return Array.isArray(parsed) ? (parsed as InternalItem[]) : [];
	} catch {
		return [];
	}
}

function writeItems(items: InternalItem[]): void {
	ensureHomeDirs();
	const tmp = `${itemsFile()}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, itemsFile());
}

export class BacklogRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BacklogRefusal";
	}
}

/** Auto-close anything past its expiry. Runs before every read-for-decision. */
export function sweepExpired(now = new Date()): InternalItem[] {
	const items = readItems();
	const closed: InternalItem[] = [];
	const next = items.map((item) => {
		if (item.state !== "open") return item;
		if (new Date(item.expires_at).getTime() > now.getTime()) return item;
		const swept: InternalItem = {
			...item,
			state: "closed",
			closed_at: now.toISOString(),
			close_reason: "expired-unattended",
		};
		closed.push(swept);
		return swept;
	});
	if (closed.length > 0) writeItems(next);
	return closed;
}

export function openItems(): InternalItem[] {
	sweepExpired();
	return readItems().filter((item) => item.state === "open");
}

export type CreateInternalRequest = {
	id: string;
	type: string;
	intent: string;
	owner: string;
	expiryHours?: number;
};

/**
 * Create an internal item. Every field is required: a missing field is a
 * refusal, never a default-to-forever.
 */
export function createInternal(request: CreateInternalRequest, now = new Date()): InternalItem {
	if (!INTERNAL_TYPES.includes(request.type as InternalType)) {
		throw new BacklogRefusal(
			`type ${JSON.stringify(request.type)} is not allowed: internal items are ${INTERNAL_TYPES.join(", ")}. Delivery work belongs in a ticket or PR, which is a query, not an internal item.`,
		);
	}
	if (request.intent.trim().length === 0) {
		throw new BacklogRefusal("intent is required: one line saying what this is for");
	}
	if (request.owner.trim().length === 0) {
		throw new BacklogRefusal("owner is required");
	}

	const items = readItems();
	if (items.some((item) => item.id === request.id && item.state === "open")) {
		throw new BacklogRefusal(`${request.id} is already open`);
	}

	sweepExpired(now);
	const stillOpen = readItems().filter((item) => item.state === "open");
	if (stillOpen.length >= INTERNAL_CAP) {
		throw new BacklogRefusal(
			`internal list is at its cap of ${INTERNAL_CAP} open items. Close or externalize one first. The two exits are: externalize (create the ticket, close with a pointer) or close (with a one-line reason).`,
		);
	}

	const hours = request.expiryHours ?? DEFAULT_EXPIRY_HOURS;
	const item: InternalItem = {
		id: request.id,
		type: request.type as InternalType,
		intent: request.intent.trim(),
		owner: request.owner.trim(),
		created_at: now.toISOString(),
		expires_at: new Date(now.getTime() + hours * 3_600_000).toISOString(),
		state: "open",
		holds: 0,
	};
	writeItems([...readItems(), item]);
	return item;
}

/** Exit 1: the item became real work. Closes with a pointer. */
export function externalize(id: string, externalRef: string, now = new Date()): InternalItem {
	if (externalRef.trim().length === 0) {
		throw new BacklogRefusal("externalize requires the ticket or PR reference it became");
	}
	return closeWith(id, `externalized to ${externalRef.trim()}`, now, externalRef.trim());
}

/** Exit 2: it is not going to happen. Closes with a reason. */
export function closeInternal(id: string, reason: string, now = new Date()): InternalItem {
	if (reason.trim().length === 0) {
		throw new BacklogRefusal("close requires a one-line reason");
	}
	return closeWith(id, reason.trim(), now);
}

function closeWith(id: string, reason: string, now: Date, externalRef?: string): InternalItem {
	const items = readItems();
	const found = items.find((item) => item.id === id && item.state === "open");
	if (found === undefined) throw new BacklogRefusal(`no open internal item ${id}`);
	const closed: InternalItem = {
		...found,
		state: "closed",
		closed_at: now.toISOString(),
		close_reason: reason,
		...(externalRef === undefined ? {} : { external_ref: externalRef }),
	};
	writeItems(items.map((item) => (item.id === id && item.state === "open" ? closed : item)));
	return closed;
}

/** Holds are bounded, not renewable forever: the third would-be hold closes it. */
export function holdInternal(
	id: string,
	reason: string,
	reviewHours: number,
	now = new Date(),
): InternalItem {
	if (reason.trim().length === 0) throw new BacklogRefusal("a hold requires a reason");
	const items = readItems();
	const found = items.find((item) => item.id === id && item.state === "open");
	if (found === undefined) throw new BacklogRefusal(`no open internal item ${id}`);
	if (found.holds >= MAX_HOLDS) {
		return closeWith(id, `auto-closed after ${MAX_HOLDS} holds: ${reason.trim()}`, now);
	}
	const held: InternalItem = {
		...found,
		holds: found.holds + 1,
		expires_at: new Date(now.getTime() + reviewHours * 3_600_000).toISOString(),
	};
	writeItems(items.map((item) => (item.id === id && item.state === "open" ? held : item)));
	return held;
}

/**
 * The single enforcement point of the whole boundary.
 *
 * A delivery workflow takes an external reference. Call this with whatever a
 * caller believes is dispatchable; an internal id is refused here, so an
 * internal item can never grow into a delivery queue. Everything else in this
 * module is bookkeeping — this function is the design.
 */
export function assertDispatchable(reference: string): void {
	if (reference.trim().length === 0) {
		throw new BacklogRefusal(
			"a delivery run requires an external reference (PR number or ticket id). Internal items are not dispatchable: externalize it first.",
		);
	}
	const internal = readItems().find((item) => item.id === reference.trim());
	if (internal !== undefined) {
		throw new BacklogRefusal(
			`${reference} is an internal ${internal.type} item, not external work. Externalize it (create the ticket, then dispatch that) or close it.`,
		);
	}
	if (!isExternalRef(reference.trim())) {
		throw new BacklogRefusal(
			`${reference} does not look like an external reference. Expected a PR number (#123 or 123), an owner/repo#123, or a ticket key (ABC-123).`,
		);
	}
}

const PR_NUMBER = /^#?\d+$/;
const REPO_PR = /^[\w.-]+\/[\w.-]+#\d+$/;
const TICKET_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

export function isExternalRef(reference: string): boolean {
	return PR_NUMBER.test(reference) || REPO_PR.test(reference) || TICKET_KEY.test(reference);
}

/** Render summary for the fleet view: a count and the nearest expiry. */
export function internalSummary(): { open: number; cap: number; nearestExpiry: string | null } {
	const items = openItems();
	const sorted = [...items].sort(
		(a, b) => new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime(),
	);
	const nearest = sorted[0];
	return {
		open: items.length,
		cap: INTERNAL_CAP,
		nearestExpiry: nearest === undefined ? null : nearest.expires_at,
	};
}
