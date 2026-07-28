/**
 * Linear intake — INTERFACE ONLY (stub).
 *
 * The contract: when enabled, the poller adds a Linear section with
 * (a) tickets assigned to Tim, and (b) tickets in an active state that have
 * no matching PR in the tracked set. Implementation is gated behind --linear
 * (default off) because no Linear auth path is verified on this rig; we do
 * NOT guess at auth. When an auth path lands (API key env var, OAuth broker,
 * MCP…), implement LinearClient against it and wire it in cli.ts.
 */

export interface LinearTicket {
	identifier: string; // e.g. "LIN-123"
	url: string;
	title: string;
	state: string; // workflow state name, e.g. "In Progress"
	assignee: string | null;
	/** PR URLs Linear has attached to the ticket, normalized. */
	attachedPrUrls: string[];
}

export interface LinearClient {
	/** Open (non-terminal) tickets assigned to the given user. */
	assignedTickets(userEmail: string): Promise<LinearTicket[]>;
	/** Tickets in an "active" workflow state (started/in-progress class). */
	activeTickets(): Promise<LinearTicket[]>;
}

export interface LinearSection {
	assigned: LinearTicket[];
	/** Active tickets none of whose attached PRs appear in the tracked set. */
	activeWithoutPr: LinearTicket[];
}

/** Pure sectioning logic — implemented now so only the client is missing. */
export function buildLinearSection(
	assigned: LinearTicket[],
	active: LinearTicket[],
	trackedPrUrls: Set<string>,
): LinearSection {
	return {
		assigned,
		activeWithoutPr: active.filter(
			(ticket) => !ticket.attachedPrUrls.some((url) => trackedPrUrls.has(url)),
		),
	};
}

/** Placeholder that fails loudly if --linear is passed before auth exists. */
export function unavailableLinearClient(): LinearClient {
	const fail = (): never => {
		throw new Error(
			"Linear intake is stubbed: no verified Linear auth path on this rig. " +
				"Implement LinearClient in intake/src/linear.ts once auth is configured.",
		);
	};
	return { assignedTickets: fail, activeTickets: fail };
}
