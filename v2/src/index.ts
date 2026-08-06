/**
 * @deck/v2 — the one lib behind both faces.
 *
 * Architecture: ONE LIB, TWO FACES. Prime extensions import this module
 * directly and the CLI is a thin argv parser over the same exports, avoiding
 * subprocess hops and duplicated behavior.
 */
export * from "./home";
export * from "./home-sync";
export * from "./projects";
export * from "./prompts";
export * from "./reasoning";
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
export * from "./monitor";
export * from "./questions-store";
export * from "./workflow-questions";
