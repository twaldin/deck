/**
 * @deck/v2 — the one lib behind both faces.
 *
 * Architecture (report decision, validated by probe): ONE LIB, TWO FACES.
 * The pi extension imports this module directly and the CLI is a thin argv
 * parser over the same exports. Neither face wraps the other, so there is no
 * subprocess hop in the orchestrator's hot path and no duplicated logic.
 */
export * from "./home";
export * from "./projects";
export * from "./status";
export * from "./meta";
export * from "./events";
export * from "./queue";
export * from "./side-effects";
export * from "./teardown";
export * from "./spawn";
export * from "./hydrate";
export * from "./wake";
export * from "./backlog";
export * from "./fleet";
export * from "./questions-store";
