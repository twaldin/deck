/**
 * Prime-agent adoption debate.
 *
 * Captain's question, per directive: should prime-agent replace base pi as
 * the harness for ALL LLM slots in the v4 factory — workflow worker seats,
 * the captain's conversation session, and spawn slots — with NO separate
 * subagent layer (rlm() children are internal to each instance, and the
 * deck-subagents extension is retired)?
 *
 * Run detached:
 *   bunx smithers-orchestrator@0.30.0 up workflows/prime-adoption-debate.tsx -d
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
			.enum(["all-in-now", "conversation-first-seats-gated", "pi-native-hold"])
			.describe("the adoption shape to execute"),
		per_role: z.object({
			conversation: z.enum(["prime-now", "prime-after-gate", "pi"]),
			worker_seats: z.enum(["prime-now", "prime-after-gate", "pi"]),
			spawn_slots: z.enum(["prime-now", "prime-after-gate", "pi"]),
		}),
		rationale: z.string().describe("why this wins, in plain language"),
		decisive_evidence: z.string().describe("the fact that settled it"),
		gates: z
			.array(z.string())
			.describe("exact conditions that flip any prime-after-gate role to prime"),
		build_contract: z
			.array(z.string())
			.describe("concrete migration steps for the chosen shape"),
		rejected_because: z.string().describe("why the losing options lose"),
		residual_risk: z.string().describe("what could still go wrong with the chosen shape"),
	}),
};

const { Workflow, outputs, smithers } = createSmithers(schemas);

const SPIKE_EVIDENCE = `Empirical sandbox verification (prime-agent 0.7.0,
tag-pinned, 2026-08-06):
(a) EXTENSIONS: GO — all three deck extensions loaded via ExtensionAPI;
    list_questions executed against a sandbox queue and returned correctly.
(b) BROKER: GO — deck provider registered; model inventory + a completion
    routed through the live broker.
(c) KERNEL CONSTRAINT: NO — named-tool interception saw only "ipython";
    kernel code wrote KERNEL_ESCAPE_OK via pathlib past interception. Only
    mitigations: disable IPython entirely or external sandboxing.
(d) MUTABILITY: NO — autoRefine.enabled=false still allowed harness CRUD
    and manual refine.run; --no-skills still allowed global CRUD. No native
    full off switch.
(e) PER-CHILD MODEL: GO — a haiku parent launched an exact
    deck/gpt-5.6-terra rlm child; child transcript proves broker-routed
    request; invalid selections fail closed.
(liveness) PARTIAL — children visible + manually cancellable; parent
    teardown cancels; NO per-child deadline/stall watchdog.
Entry findings: deck installer targets .pi paths, prime needs .prime paths;
AGENTS.md precedence works from cwd ~/.deck; OptMem wake hook works; exact
release is installer-pinnable but "update" has no version selector; session
JSONL shares pi core format with a different root + prime-only artifacts;
daemon socket is per-UID outside HOME (use --daemon-socket to isolate).
Spike recommendation: AFTER FIXES — bare "cd ~/.deck && prime-agent" not
yet; conversation-only requires a wrapper profile.`;

const TOPIC = `prime-agent adoption across the v4 factory. Decide ONE shape.

CONTEXT
The v4 factory (built this week, all gates green): smithers pr-pipeline owns
every PR/stack (graph-gated stages, commit-bound captain stamps, rebase-only
push path with ancestry assert, cross-family adversarial review pinned at the
GRAPH level, questions bridge to ~/.deck/questions). Harness today: base pi.
Extensions: deck-questions (queued asks), deck-ship (factory-as-a-tool),
deck-recall (OptMem wake + dossier hydrate), deck-subagents (fail-closed
registry, stall-kill, broker-wired; ONE ephemeral awaited child per call,
cap 4, no retained children, no recursion, no A2A).

prime-agent (PrimeIntellect, released 2026-08-05, MIT, built ON pi, retains
pi's TypeScript ExtensionAPI): persistent IPython kernel as the model's only
tool; rlm() spawns real retained recursive child sessions as async calls;
A2A messaging (nuclear-family scope); Continual Harness CRUD + /refine
self-improvement (their own Factorio case: refinement promoted reward-hacking
into skills despite explicit heartbeat instructions); daemon-owned
recoverable sessions (Running/Idle/Inactive, reattach, Agents View);
autonomous mode with self-run shell gates; JSON/RPC headless modes. 884
stars and 45 open issues on day one. No model trained around it yet.

CAPTAIN'S POSITION
All-in: one prime-agent instance per slot (workflow seat, conversation,
spawn). NO separate subagent layer — rlm() children are internal
decomposition; deck-subagents is retired, not ported. "It's basically pi +
extras we already wanted, fully compat with our pi addons (broker,
questions)." He also retracts the no-model-trained-around-it objection,
citing the pi author: frontier models are terminal-competent; what matters
is context economy and clean primitives — prime-agent's exact thesis.

MEASURED HISTORY (argue from these; invent no facts)
- Deck's orchestrator died of custody in chat: 20 compactions erased rules;
  504/610 fleet errors in that one seat; it bypassed its own pipeline under
  pressure. The v4 razor: chat holds no state, no progress, no authority.
- Prompt-enforced process step-dropped in EVERY era; graph gates are the
  only mechanism that ever stopped it. The pipeline lives in the graph, not
  in any prompt or AGENTS.md.
- #27140: branch contamination happened via agent-discretionary bash INSIDE
  a fully gated pipeline; fixed this week by making a deterministic helper
  the ONLY push path. The IPython kernel makes every action agent-
  discretionary code unless kernel constraint exists (see SPIKE (c)).
- Both prior subagent generations failed on silent freezes and alias bugs;
  deck-subagents' fail-closed registry + stall-kill was the fix, one day old.
- Capability-asymmetry law: firstmate died because only the orchestrator had
  good tools; every seat gets role-profiled capabilities.
- The captain's completion criterion: cd ~/.deck, one command, start
  adopting the open lindy PRs by talking. The build is DONE and green on pi
  today.

SPIKE EVIDENCE (controlling where applicable)
${SPIKE_EVIDENCE}

OPTION ALL-IN-NOW
prime-agent for all three roles at cutover. deck-subagents retired. Argue:
extensions/broker port near-unchanged (per spike a/b); context-as-variable
kills the compaction class; one harness family everywhere IS the
one-execution-path lesson; the smithers graph + stamps + review hold the
merge boundary regardless of seat harness; day-zero churn is priced by pi
remaining installed as fallback.

OPTION CONVERSATION-FIRST-SEATS-GATED
prime-agent as the captain's conversation harness at cutover (zero custody
= novelty is free there); worker seats + spawn slots stay pi until a
measured non-lindy trial passes per-node readiness gates AND spike (c)/(d)
prove kernel constraint + refine-disable. deck-subagents survives until the
seat flip, then retires.

OPTION PI-NATIVE-HOLD
Ship the green pi build unchanged; prime-agent is a personal plaything only;
re-evaluate on maturity triggers.

RULES FOR THIS DEBATE
- Argue from the evidence above plus the spike matrix. Invent no new facts.
- The Factorio /refine case, the kernel-escape question, day-zero maturity,
  and seat determinism doctrine must each be argued BOTH ways.
- A hybrid verdict must name the exact per-role boundary and what prevents
  it rotting into two permanent execution paths.
- The verdict must be executable this week as concrete migration steps, and
  must state its effect on the captain's completion criterion.
- Judge on: supervision cost for the captain, survival under agent-driven
  churn, whether a seat can silently escape governance, and time-to-usable.`;

export default smithers(() => (
	<Workflow name="prime-adoption-debate">
		<Debate
			id="prime-adoption"
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
