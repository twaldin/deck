import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, type DeckConfig } from "@deck/core";
import { z } from "zod";

const environmentSchema = z
	.object({
		DECK_PI_BIN: z.string().min(1).optional(),
		DECK_OWNER_MODEL: z.string().min(1).optional(),
		DECK_LIFECYCLE_EXTENSION: z.string().min(1).optional(),
		DECK_ROUTER_QUEUE_LIMIT: z.coerce.number().int().positive().max(10_000).optional(),
	})
	.loose();

export interface RouterRuntimeConfig {
	deck: DeckConfig;
	piCommand: string[];
	ownerModel: string;
	lifecycleExtensionPath: string;
	queueLimit: number;
}

export function loadRouterRuntimeConfig(): RouterRuntimeConfig {
	const environment = environmentSchema.parse(process.env);
	const piBin = environment.DECK_PI_BIN
		?? path.join(os.homedir(), ".nvm/versions/node/v24.8.0/bin/pi");
	return {
		deck: loadConfig(),
		piCommand: [piBin],
		ownerModel: environment.DECK_OWNER_MODEL ?? "gpt-5.6-sol",
		lifecycleExtensionPath: environment.DECK_LIFECYCLE_EXTENSION
			?? path.resolve(import.meta.dir, "../../extensions/src/deck-lifecycle.ts"),
		queueLimit: environment.DECK_ROUTER_QUEUE_LIMIT ?? 256,
	};
}
