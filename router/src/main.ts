import { z } from "zod";
import { WakeRouter } from "./router";
import { loadRouterRuntimeConfig } from "./runtime-config";

const argumentsSchema = z.array(z.enum(["--once"])).max(1);
const argumentsList = argumentsSchema.parse(Bun.argv.slice(2));
const once = argumentsList.includes("--once");
const router = new WakeRouter(loadRouterRuntimeConfig());

await router.initialize();
if (once) {
	try {
		await router.runOnce();
	} finally {
		await router.shutdown();
	}
} else {
	await router.start();
	let stopping = false;
	const stop = async (): Promise<void> => {
		if (stopping) {
			return;
		}
		stopping = true;
		try {
			await router.shutdown();
			process.exitCode = 0;
		} catch (error) {
			console.error(error);
			process.exitCode = 1;
		}
	};
	process.once("SIGINT", () => {
		void stop();
	});
	process.once("SIGTERM", () => {
		void stop();
	});
}
