/**
 * Operator-run prompt-cache TTL probe. NOT a CI test: it sleeps for the wait
 * intervals you ask for, so proving a 30m/1h TTL takes that long by design.
 *
 * Writes one large cacheable prefix through the live deck gateway, then
 * re-sends the identical request after each wait and reports whether the
 * prefix came back as a cache read (warm) or a fresh cache creation (cold).
 *
 *   bun run broker/test/cache-ttl-probe.ts --provider anthropic --waits 0,60
 *   bun run broker/test/cache-ttl-probe.ts --provider anthropic --ttl 5m --waits 0,240,360
 *   bun run broker/test/cache-ttl-probe.ts --provider openai --waits 0,300,1500,1900
 *
 * anthropic: native /v1/messages with cache_control on the system prefix.
 *   --ttl 1h|5m sets cache_control.ttl (default 1h, matching what pi-ai sends
 *   on deck's oauth path). Reports the ephemeral_5m/ephemeral_1h cache_creation
 *   breakdown when the wire exposes it.
 * openai: /v1/chat/completions with a fixed prompt_cache_key; --ttl is ignored
 *   (Codex-class caching is server-side, 30m minimum on GPT-5.6+).
 */
import { z } from "zod";
import { gatewayPost } from "./harness";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
	const key = process.argv[i];
	const value = process.argv[i + 1];
	if (!key?.startsWith("--") || value === undefined) {
		console.error("usage: --provider anthropic|openai [--ttl 5m|1h] [--waits 0,60,300]");
		process.exit(1);
	}
	args.set(key.slice(2), value);
}

const provider = args.get("provider") ?? "anthropic";
const ttl = args.get("ttl") ?? "1h";
const waits = (args.get("waits") ?? "0,60").split(",").map(Number);
if ((provider !== "anthropic" && provider !== "openai") || (ttl !== "5m" && ttl !== "1h") || waits.some(Number.isNaN)) {
	console.error("usage: --provider anthropic|openai [--ttl 5m|1h] [--waits 0,60,300]");
	process.exit(1);
}

// Distinct prefix per run so the first call MUST create, not read. Sized well
// past every minimum cacheable prefix (sonnet 1024 tokens, codex-class larger).
const noise = `ttl-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const bigPrefix = `${"You are a meticulous assistant. ".repeat(420)}[run ${noise}]`;

const anthropicUsage = z.looseObject({
	usage: z.looseObject({
		cache_creation_input_tokens: z.number().nullish(),
		cache_read_input_tokens: z.number().nullish(),
		cache_creation: z
			.looseObject({
				ephemeral_5m_input_tokens: z.number().nullish(),
				ephemeral_1h_input_tokens: z.number().nullish(),
			})
			.nullish(),
	}),
});
const openaiUsage = z.looseObject({
	usage: z.looseObject({
		prompt_tokens: z.number().nullish(),
		prompt_tokens_details: z.looseObject({ cached_tokens: z.number().nullish() }).nullish(),
	}),
});

interface Sample {
	read: number;
	created: number;
	detail: string;
}

async function call(): Promise<Sample> {
	if (provider === "anthropic") {
		const response = await gatewayPost("/v1/messages", {
			model: "claude-sonnet-4-5",
			max_tokens: 16,
			system: [{ type: "text", text: bigPrefix, cache_control: { type: "ephemeral", ttl } }],
			messages: [{ role: "user", content: "Say OK." }],
		});
		if (!response.ok) throw new Error(`gateway ${response.status}: ${await response.text()}`);
		const { usage } = anthropicUsage.parse(await response.json());
		const breakdown = usage.cache_creation;
		const detail =
			breakdown == null
				? ""
				: `5m=${breakdown.ephemeral_5m_input_tokens ?? 0} 1h=${breakdown.ephemeral_1h_input_tokens ?? 0}`;
		return { read: usage.cache_read_input_tokens ?? 0, created: usage.cache_creation_input_tokens ?? 0, detail };
	}
	const response = await gatewayPost("/v1/chat/completions", {
		model: "gpt-5.6-sol",
		max_tokens: 16,
		prompt_cache_key: noise,
		messages: [
			{ role: "system", content: bigPrefix },
			{ role: "user", content: "Say OK." },
		],
	});
	if (!response.ok) throw new Error(`gateway ${response.status}: ${await response.text()}`);
	const { usage } = openaiUsage.parse(await response.json());
	return { read: usage.prompt_tokens_details?.cached_tokens ?? 0, created: 0, detail: "" };
}

function verdict(sample: Sample, first: boolean): string {
	if (first) return sample.created > 0 || sample.read === 0 ? "write" : "unexpected-hit";
	return sample.read > 0 ? "HIT (warm)" : "MISS (cold)";
}

const seed = await call();
console.log(`provider=${provider} ttl=${provider === "anthropic" ? ttl : "server-side"} run=${noise}`);
console.log("wait_s\tcache_read\tcache_created\tverdict\tdetail");
console.log(`seed\t${seed.read}\t${seed.created}\t${verdict(seed, true)}\t${seed.detail}`);
for (const waitSeconds of waits) {
	await Bun.sleep(waitSeconds * 1000);
	const sample = await call();
	console.log(`${waitSeconds}\t${sample.read}\t${sample.created}\t${verdict(sample, false)}\t${sample.detail}`);
}
