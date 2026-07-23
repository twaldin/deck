import { z } from "zod";

export const worktreeIdSchema = z.string().regex(/^wt:[A-Za-z0-9._-]+:[1-9][0-9]*$/);
export const effortIdSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be safe for use in a git branch name");

export const worktreeEntrySchema = z
	.object({
		id: worktreeIdSchema,
		repo: z.string().min(1),
		path: z.string().min(1),
		effort: effortIdSchema,
		branch: z.string().min(1),
		created: z.string().datetime({ offset: true }),
		state: z.enum(["active", "free"]),
	})
	.strict();

export type WorktreeEntry = z.infer<typeof worktreeEntrySchema>;

export const worktreesStateSchema = z
	.object({
		v: z.literal(1),
		entries: z.array(worktreeEntrySchema),
	})
	.strict()
	.superRefine((state, context) => {
		const ids = new Set<string>();
		const paths = new Set<string>();
		for (const entry of state.entries) {
			if (ids.has(entry.id)) {
				context.addIssue({
					code: "custom",
					message: `duplicate worktree id: ${entry.id}`,
				});
			}
			if (paths.has(entry.path)) {
				context.addIssue({
					code: "custom",
					message: `duplicate worktree path: ${entry.path}`,
				});
			}
			ids.add(entry.id);
			paths.add(entry.path);
		}
	});

export type WorktreesState = z.infer<typeof worktreesStateSchema>;

const baseSchema = z
	.string()
	.min(1)
	.max(500)
	.refine((value) => !value.startsWith("-"), "must not start with '-'")
	.refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters");

export const allocCommandSchema = z
	.object({
		kind: z.literal("alloc"),
		repo: z.string().min(1),
		effort: effortIdSchema,
		base: baseSchema.optional(),
	})
	.strict();

export const releaseCommandSchema = z
	.object({
		kind: z.literal("release"),
		id: worktreeIdSchema,
		deleteBranch: z.boolean(),
	})
	.strict();

export const listCommandSchema = z
	.object({
		kind: z.literal("ls"),
		json: z.boolean(),
	})
	.strict();

export const reapCommandSchema = z.object({ kind: z.literal("reap") }).strict();

export const worktreeCommandSchema = z.discriminatedUnion("kind", [
	allocCommandSchema,
	releaseCommandSchema,
	listCommandSchema,
	reapCommandSchema,
]);

export type WorktreeCommand = z.infer<typeof worktreeCommandSchema>;
