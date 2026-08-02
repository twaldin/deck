import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { controlRequest, gatewayPost, hasLiveBroker } from "./harness";

const ACCOUNT_ID = "879eaffd-053c-424b-9782-dd76aa8bad3b";
const RESET_TOLERANCE_MS = 120_000;
const USED_PERCENT_TOLERANCE = 5;
const BURN_WORD_COUNT = 30_000;
const BURN_ENABLED = process.env.BATTERY_BURN === "1";

const ATTRIBUTION_LIMITS = ["anthropic:5h", "anthropic:7d"] as const;
type AttributionLimitId = (typeof ATTRIBUTION_LIMITS)[number];

const WINDOW_DURATION_MS: Record<AttributionLimitId, number> = {
	"anthropic:5h": 5 * 60 * 60 * 1_000,
	"anthropic:7d": 7 * 24 * 60 * 60 * 1_000,
};

const BURN_WORDS = [
	"red",
	"blue",
	"green",
	"yellow",
	"purple",
	"orange",
	"white",
	"black",
	"cyan",
	"magenta",
	"teal",
	"coral",
	"navy",
	"beige",
	"pink",
	"gray",
] as const;

const usageLimitSchema = z.looseObject({
	id: z.string(),
	window: z.looseObject({
		id: z.string(),
		resetsAt: z.number(),
	}),
	amount: z.looseObject({
		used: z.number(),
		limit: z.number(),
		unit: z.string(),
	}),
});

const usageReportSchema = z.looseObject({
	provider: z.string(),
	limits: z.array(usageLimitSchema),
	metadata: z
		.looseObject({
			accountId: z.string().optional(),
		})
		.optional(),
});

const usageRosterSchema = z.looseObject({
	generatedAt: z.string(),
	reports: z.array(usageReportSchema),
});

const ompCacheRowSchema = z.looseObject({
	value: z.looseObject({
		limits: z.array(usageLimitSchema),
	}),
	expiresAt: z.number(),
});

type UsageLimit = z.infer<typeof usageLimitSchema>;
type UsageReport = z.infer<typeof usageReportSchema>;

const OMP_CACHE_SQL = "select value from cache where key like 'usage_cache:report:2:anthropic:default:oauth|account:879eaffd%'";

async function readOmpCachedLimits(): Promise<UsageLimit[] | null> {
	const home = process.env.HOME;
	if (!home) throw new Error("HOME is required to locate omp's read-only agent database");

	const processHandle = Bun.spawn(
		["sqlite3", "-readonly", `file:${home}/.omp/agent/agent.db?mode=ro`, OMP_CACHE_SQL],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
		processHandle.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`sqlite3 failed with exit code ${exitCode}: ${stderr.trim()}`);
	}

	const row = stdout.trim();
	if (row.length === 0) return null;
	return ompCacheRowSchema.parse(JSON.parse(row)).value.limits;
}

function requiredBatteryAccount(reports: UsageReport[], source: string): UsageReport {
	const report = reports.find(
		candidate => candidate.provider === "anthropic" && candidate.metadata?.accountId === ACCOUNT_ID,
	);
	if (!report) throw new Error(`${source} did not report Anthropic account ${ACCOUNT_ID}`);
	return report;
}

function requiredLimit(limits: Map<string, UsageLimit>, id: AttributionLimitId, source: string): UsageLimit {
	const limit = limits.get(id);
	if (!limit) throw new Error(`${source} did not report required limit ${id}`);
	return limit;
}

function usedPercent(limit: UsageLimit): number {
	if (limit.amount.limit <= 0) throw new Error(`${limit.id} reported a non-positive quota limit`);
	return (limit.amount.used / limit.amount.limit) * 100;
}

function sameWindowOrForwardRollover(deck: UsageLimit, omp: UsageLimit, id: AttributionLimitId): boolean {
	const resetDelta = deck.window.resetsAt - omp.window.resetsAt;
	const sameWindow = Math.abs(resetDelta) <= RESET_TOLERANCE_MS;
	const forwardRollover =
		resetDelta >= 0 && Math.abs(resetDelta - WINDOW_DURATION_MS[id]) <= RESET_TOLERANCE_MS;
	expect(sameWindow || forwardRollover).toBe(true);
	return sameWindow;
}

function makeUniqueBurnPrompt(): string {
	const entropy = crypto.getRandomValues(new Uint8Array(BURN_WORD_COUNT));
	const words = Array.from(entropy, byte => {
		const word = BURN_WORDS[byte % BURN_WORDS.length];
		if (!word) throw new Error("burn-prompt word table is empty");
		return word;
	});
	return `This is harmless synthetic color-word data. Do not analyze the data. Reply exactly OK. Unique run ${crypto.randomUUID()}. Data: ${words.join(" ")}`;
}

const ompCachePreflight = await readOmpCachedLimits();
if (!ompCachePreflight) {
	console.warn(`[attribution] skipping omp agreement test; no cached Anthropic usage row for account ${ACCOUNT_ID}`);
}

if (!BURN_ENABLED) {
	console.info(
		"[attribution] skipping quota-burn test; set BATTERY_BURN=1 to opt into a ~30k-token call (small calls do not reliably move percent-granularity usage)",
	);
}

// The battery burns real tokens against a running deck-broker. It skips when
// none is reachable, which is also the case when a unit-test file in the same
// `bun test` process has repointed DECK_HOME at a throwaway home.
describe.skipIf(!hasLiveBroker())("SPEC 6.5 quota attribution", () => {
	test.skipIf(!ompCachePreflight)(
		"(1) reports the same Anthropic windows and usage as omp for account 1",
		async () => {
			const roster = usageRosterSchema.parse(await controlRequest("usage", { force: true }));
			const anthropic = requiredBatteryAccount(roster.reports, "deck usage roster");

			// Re-read after deck's forced observation. If omp evicts the row between
			// registration and execution, its millisecond-old preflight is still valid.
			const ompLimits = (await readOmpCachedLimits()) ?? ompCachePreflight;
			if (!ompLimits) throw new Error("omp cache row disappeared after test registration");

			const deckById = new Map(anthropic.limits.map(limit => [limit.id, limit]));
			const ompById = new Map(ompLimits.map(limit => [limit.id, limit]));
			for (const id of ATTRIBUTION_LIMITS) {
				const deck = requiredLimit(deckById, id, "deck");
				const omp = requiredLimit(ompById, id, "omp");
				expect(deck.window.id).toBe(omp.window.id);
				expect(deck.amount.unit).toBe(omp.amount.unit);

				const deckUsedPercent = usedPercent(deck);
				const ompUsedPercent = usedPercent(omp);
				const sameWindow = sameWindowOrForwardRollover(deck, omp, id);
				if (sameWindow) {
					// omp's cache may be about ten minutes stale. Usage accumulates within a
					// window, with five percentage points allowed for provider rounding/skew.
					expect(deckUsedPercent).toBeGreaterThanOrEqual(ompUsedPercent - USED_PERCENT_TOLERANCE);
				}

				console.info(
					`[attribution] ${id}: deck=${deckUsedPercent}% reset=${deck.window.resetsAt}; omp=${ompUsedPercent}% reset=${omp.window.resetsAt}`,
				);
			}
		},
		60_000,
	);

	test.skipIf(!BURN_ENABLED)(
		"(1) attributes one deck-brokered ~30k-token burn to the Anthropic account",
		async () => {
			const beforeRoster = usageRosterSchema.parse(await controlRequest("usage", { force: true }));
			const beforeAnthropic = requiredBatteryAccount(beforeRoster.reports, "deck before burn");
			const before = requiredLimit(
				new Map(beforeAnthropic.limits.map(limit => [limit.id, limit])),
				"anthropic:5h",
				"deck before burn",
			);

			// Percent-granularity usage does not move reliably for a cheap prompt, so
			// this opt-in battery lane sends a unique, non-cacheable ~30k-token input.
			const response = await gatewayPost("/v1/messages", {
				model: "claude-sonnet-4-5",
				max_tokens: 32,
				messages: [{ role: "user", content: makeUniqueBurnPrompt() }],
			});
			expect(response.status).toBe(200);
			await response.arrayBuffer();

			const afterRoster = usageRosterSchema.parse(await controlRequest("usage", { force: true }));
			const afterAnthropic = requiredBatteryAccount(afterRoster.reports, "deck after burn");
			const after = requiredLimit(
				new Map(afterAnthropic.limits.map(limit => [limit.id, limit])),
				"anthropic:5h",
				"deck after burn",
			);

			const beforeUsedPercent = usedPercent(before);
			const afterUsedPercent = usedPercent(after);
			console.info(`[attribution] burn: 5h deck before=${beforeUsedPercent}% after=${afterUsedPercent}%`);
			expect(afterUsedPercent).toBeGreaterThan(beforeUsedPercent);
		},
		180_000,
	);
});
