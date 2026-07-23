import {
	Approval,
	PiAgent,
	Sequence,
	approvalDecisionSchema,
	createSmithers,
} from "smithers-orchestrator";
import { z } from "zod";

const draftSchema = z.object({
	subject: z.string().min(1).max(40),
	greeting: z.string().min(1).max(80),
});

const summarySchema = z.object({
	summary: z.string().min(1).max(120),
});

const { Workflow, Task, outputs, smithers } = createSmithers({
	input: z.object({
		name: z.string().min(1).max(40),
	}),
	draft: draftSchema,
	approval: approvalDecisionSchema,
	summary: summarySchema,
});

export const deckHaikuAgent = new PiAgent({
	provider: "deck",
	model: "claude-haiku-4-5",
	thinking: "off",
	noTools: true,
	noSkills: true,
	noPromptTemplates: true,
	noSession: true,
	timeoutMs: 120_000,
	maxOutputBytes: 16_384,
	instructions:
		"Return only the smallest JSON object satisfying the requested schema. Keep every string short.",
});

export default smithers((ctx) => {
	const draft = ctx.outputMaybe(outputs.draft, { nodeId: "draft-greeting" });
	const approval = ctx.outputMaybe(outputs.approval, {
		nodeId: "approve-summary",
	});

	return (
		<Workflow name="hello-deck">
			<Sequence>
				<Task
					id="draft-greeting"
					output={outputs.draft}
					agent={deckHaikuAgent}
					retries={0}
				>
					{`Create a friendly greeting for ${ctx.input.name}. Return subject and greeting.`}
				</Task>

				{draft ? (
					<Approval
						id="approve-summary"
						output={outputs.approval}
						request={{
							title: "Approve final summary generation?",
							summary: `Task A persisted: ${draft.greeting}`,
						}}
						onDeny="fail"
					/>
				) : null}

				{draft && approval?.approved ? (
					<Task
						id="summarize-greeting"
						output={outputs.summary}
						agent={deckHaikuAgent}
						retries={0}
					>
						{`Summarize this greeting in one short sentence: ${JSON.stringify(draft)}`}
					</Task>
				) : null}
			</Sequence>
		</Workflow>
	);
});
