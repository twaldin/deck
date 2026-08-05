import type { z } from "zod";

import type { schemas } from "../pipeline.tsx";

export type OutputRows<K extends keyof typeof schemas> = Array<
	z.infer<(typeof schemas)[K]> & { nodeId: string }
>;

export type PipelineOutputFixtures = Partial<{
	[K in keyof typeof schemas]: OutputRows<K>;
}>;
