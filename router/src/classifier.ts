import type { AdapterFact } from "./adapters";
import { z } from "zod";

export type RouteAction = "record" | "wake" | "record-wake-if-waiting";

export interface ClassificationContext {
	waiting: boolean;
}

export interface Classification {
	action: RouteAction;
	wake: boolean;
	flagged: boolean;
	flagReason: string | null;
}

type Classifier = (fact: AdapterFact, context: ClassificationContext) => Classification;

const ciDataSchema = z.object({ state: z.enum(["red", "green", "pending"]) }).loose();
const ticketStateDataSchema = z.object({
	ticket: z.string().min(1).optional(),
	previous_state: z.string().min(1),
	current_state: z.string().min(1),
}).loose();
const ticketPrLinkDataSchema = z.object({
	ticket: z.string().min(1).optional(),
	ticket_state: z.string().min(1),
	previous_pr_links: z.array(z.string()),
	current_pr_links: z.array(z.string()),
}).loose();

const CI_ACTION_BY_STATE: Record<z.infer<typeof ciDataSchema>["state"], RouteAction> = {
	red: "wake",
	green: "record-wake-if-waiting",
	pending: "record",
};

const CLASSIFIER_BY_TYPE: Record<string, Classifier> = {
	"fact.pr.ci_state": (fact, context) => {
		const data = ciDataSchema.parse(fact.data);
		const action = CI_ACTION_BY_STATE[data.state];
		return {
			action,
			wake: action === "wake" || (action === "record-wake-if-waiting" && context.waiting),
			flagged: false,
			flagReason: null,
		};
	},
	"fact.pr.review": () => ({
		action: "wake",
		wake: true,
		flagged: false,
		flagReason: null,
	}),
	"fact.ticket.state": (fact) => {
		const data = ticketStateDataSchema.parse(fact.data);
		const backwardFromDone = data.previous_state.toLowerCase() === "done"
			&& data.current_state.toLowerCase() !== "done";
		return {
			action: backwardFromDone ? "wake" : "record",
			wake: backwardFromDone,
			flagged: backwardFromDone,
			flagReason: backwardFromDone
				? `${data.ticket ?? "Ticket"} moved from Done to ${data.current_state}; decide whether to revert or accept.`
				: null,
		};
	},
	"fact.ticket.pr_link": (fact) => {
		const data = ticketPrLinkDataSchema.parse(fact.data);
		const previous = [...data.previous_pr_links].sort();
		const current = [...data.current_pr_links].sort();
		const changedOnDone = data.ticket_state.toLowerCase() === "done"
			&& JSON.stringify(previous) !== JSON.stringify(current);
		return {
			action: changedOnDone ? "wake" : "record",
			wake: changedOnDone,
			flagged: changedOnDone,
			flagReason: changedOnDone
				? `${data.ticket ?? "Done ticket"} PR links changed; decide whether to revert or accept.`
				: null,
		};
	},
};

/** Config-table classifier plus the Linear D-F safety hook (SPEC §5.3). */
export function classifyFact(fact: AdapterFact, context: ClassificationContext): Classification {
	const classifier = CLASSIFIER_BY_TYPE[fact.type];
	if (classifier === undefined) {
		return { action: "record", wake: false, flagged: false, flagReason: null };
	}
	return classifier(fact, context);
}
