/**
 * Backlog architecture debate.
 *
 * The captain's open question, per directive: should deck-v2's task list be a
 * VIEW over external reality (every task pairs 1:1/1:n with a real ticket or PR;
 * if none exists, create it), or an internal list with aggressive auto-expiry?
 *
 * Evidence on the table: fm2 accumulated 90+ tasks in days, with churn and
 * little use, and the captain observes the backlog and the intake->Smithers
 * pipeline are "one and the same but also different".
 *
 * Run detached:
 *   bunx smithers-orchestrator@0.30.0 up workflows/backlog-debate/debate.tsx -d
 */
import { Debate, createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { agents, providers } from "../agents.ts";

const schemas = {
	argument: z.object({
		round: z.number().int().describe("debate round, 1-based"),
		position: z.string().describe("the position argued, in one sentence"),
		strongest_point: z.string().describe("the single strongest argument this round"),
		concessions: z.array(z.string()).describe("points conceded to the other side"),
		evidence: z.array(z.string()).describe("concrete evidence cited, with source"),
	}),
	verdict: z.object({
		choice: z
			.enum(["mirror-external", "internal-with-expiry", "hybrid"])
			.describe("the architecture to build"),
		rationale: z.string().describe("why this wins, in plain language"),
		decisive_evidence: z.string().describe("the fact that settled it"),
		build_contract: z
			.array(z.string())
			.describe("concrete rules deck-v2's backlog must implement"),
		rejected_because: z.string().describe("why the losing option loses"),
		residual_risk: z.string().describe("what could still go wrong with the chosen shape"),
	}),
};

const { Workflow, outputs, smithers } = createSmithers(schemas);

const TOPIC = `deck-v2 backlog architecture. Decide ONE shape to build tonight.

CONTEXT
deck-v2 is the captain's whole agent fleet: one orchestrator session he talks to,
plus ephemeral event-driven crew runs. Work is delivered as PRs to real repos
(mainly a large TypeScript monorepo, "lindy"), tracked externally in GitHub PRs
and Linear tickets. A Smithers workflow (pr-pipeline) already exists and drives
each PR from implement -> adversarial review -> push -> CI/review loop ->
captain stamp -> merge -> deploy evidence -> fallout verdict.

EVIDENCE
- The predecessor system (fm2) accumulated 90+ backlog tasks within days. The
  captain's judgement: churn without use. Stale, superseded and duplicate items
  became a captain-visible UI bug because the fleet dashboard rendered them.
- fm2 doctrine already says: at every teardown and heartbeat, close items whose
  work is carried elsewhere; if an item is not dispatchable as-is, it is either
  held-with-reason or closed.
- The captain says the backlog and the intake->Smithers pipeline are "one and the
  same but also different".
- Some real work has no external ticket: scouts, investigations, infra chores,
  and captain-only decisions.
- Linear has hard rules in this org: Done is terminal, parent-close cascades to
  children, and some automation moves tickets on its own.

OPTION A - MIRROR EXTERNAL REALITY
Every task pairs 1:1 (or 1:n for a stack) with a real ticket or PR. If none
exists, create it. The task list becomes a VIEW over tickets + PRs, not a
parallel universe. Nothing untracked can exist.

OPTION B - INTERNAL WITH AGGRESSIVE EXPIRY
Keep an internal task list, but every item carries a time gate and an owner; an
item with no activity inside its window auto-closes with a pointer, and holds
must state a reason and a review date.

RULES FOR THIS DEBATE
- Argue from the evidence above. Invent no new facts about the systems.
- A "hybrid" verdict is allowed ONLY if you name the exact boundary: which class
  of work lives where, and what prevents the boundary from rotting.
- The verdict must be buildable tonight as concrete rules, not a principle.
- Judge on: does it reduce the captain's supervision cost, does it survive
  agent-driven churn, and can a crew get it wrong by accident?`;

export default smithers(() => (
		<Workflow name="backlog-architecture-debate">
			<Debate
				id="backlog"
				// Cross-family by construction: proposer anthropic, opponent openai.
				proposer={providers.claudeOpus}
				opponent={providers.gptSol}
				judge={agents.planning}
				rounds={2}
				argumentOutput={outputs.argument}
				verdictOutput={outputs.verdict}
				topic={TOPIC}
			/>
	</Workflow>
));
