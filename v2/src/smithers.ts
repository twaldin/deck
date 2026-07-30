/**
 * The ONE smithers CLI pin for deck code.
 *
 * Must match the workspace pins in workflows/.smithers/package.json and
 * workflows/pr-pipeline/package.json (asserted by test/smithers-pin.test.ts).
 * bunx from a directory without a package.json silently resolves a NEWER
 * cached CLI (observed: 0.31.0 vs 0.30.0), so every shell-out pins explicitly.
 *
 * v2/install.sh reads SMITHERS_VERSION from this file to generate the
 * `smithers` PATH shim, so the shim cannot skew either.
 */
export const SMITHERS_VERSION = "0.30.0";

export const SMITHERS_SPEC = `smithers-orchestrator@${SMITHERS_VERSION}`;
