import { z } from "zod";

/** CI rollup summarized from GitHub's statusCheckRollup. */
export const ciStateSchema = z.enum(["passing", "failing", "pending", "none"]);
export type CiState = z.infer<typeof ciStateSchema>;

/** GitHub review decision (REVIEW_REQUIRED | APPROVED | CHANGES_REQUESTED | none). */
export const reviewDecisionSchema = z.enum(["review-required", "approved", "changes-requested", "none"]);
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

/** Which intake bucket(s) an item belongs to. An item can be in both. */
export const bucketSchema = z.enum(["my-pr", "review-owed"]);
export type Bucket = z.infer<typeof bucketSchema>;

export const prItemSchema = z
	.object({
		/** Canonical html URL, primary key across runs. */
		url: z.string().min(1),
		/** "owner/name". */
		repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
		number: z.number().int().positive(),
		title: z.string(),
		author: z.string(),
		state: z.enum(["open", "closed", "merged"]),
		isDraft: z.boolean(),
		buckets: z.array(bucketSchema).min(1),
		ci: ciStateSchema,
		reviewDecision: reviewDecisionSchema,
		/** Logins with a pending review request, sorted. */
		requestedReviewers: z.array(z.string()),
		baseRef: z.string(),
		headRef: z.string(),
		updatedAt: z.string(),
	})
	.strict();

export type PrItem = z.infer<typeof prItemSchema>;

export const intakeStateSchema = z
	.object({
		v: z.literal(1),
		generatedAt: z.string(),
		/** Keyed by PR url. */
		items: z.record(z.string(), prItemSchema),
	})
	.strict();

export type IntakeState = z.infer<typeof intakeStateSchema>;

export const EMPTY_INTAKE_STATE: IntakeState = { v: 1, generatedAt: "", items: {} };

/**
 * How a tracked PR that is no longer open was resolved.
 * A closed or unmerged state does not prove the work was lost. The
 * "closed-without-landing" result requires an empty squash-commit search
 * against the default branch.
 */
export const removalResolutionSchema = z.enum([
	"merged", // GitHub reports merged=true
	"landed-squash", // closed+unmerged but squash commit "(#N)" found on default branch
	"closed-without-landing", // closed+unmerged AND no squash commit on default branch
	"descoped", // still open, just no longer matches any search bucket (e.g. review request withdrawn)
	"vanished", // could not resolve the PR at all (deleted repo, lost access, …)
]);
export type RemovalResolution = z.infer<typeof removalResolutionSchema>;

/** One machine-parseable change line. */
export const diffChangeSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("new"),
			url: z.string(),
			buckets: z.array(bucketSchema),
			/** True when this run introduced a review request aimed at us — high signal. */
			reviewRequested: z.boolean(),
			title: z.string(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("removed"),
			url: z.string(),
			resolution: removalResolutionSchema,
			title: z.string(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("ci"),
			url: z.string(),
			from: ciStateSchema,
			to: ciStateSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("review-decision"),
			url: z.string(),
			from: reviewDecisionSchema,
			to: reviewDecisionSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("reviewers"),
			url: z.string(),
			added: z.array(z.string()),
			removed: z.array(z.string()),
			/** True when the login we poll for was newly added — a review we now owe. */
			selfRequested: z.boolean(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("buckets"),
			url: z.string(),
			from: z.array(bucketSchema),
			to: z.array(bucketSchema),
			/** True when the review-owed bucket was newly entered — high signal. */
			reviewRequested: z.boolean(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("untracked"),
			url: z.string(),
			title: z.string(),
		})
		.strict(),
]);
export type DiffChange = z.infer<typeof diffChangeSchema>;
