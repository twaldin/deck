/**
 * Side-effect module: point DECK_HOME at a throwaway directory.
 *
 * `paths.ts` resolves DECK_HOME once, at import time. Import this FIRST in any
 * test that touches the roster — ESM evaluates imports in order, so this runs
 * before `paths.ts` and the test can never write into the live ~/.deck.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const TMP_DECK_HOME: string = mkdtempSync(path.join(tmpdir(), "deck-home-"));
process.env.DECK_HOME = TMP_DECK_HOME;
mkdirSync(path.join(TMP_DECK_HOME, "broker"), { recursive: true, mode: 0o700 });
process.on("exit", () => rmSync(TMP_DECK_HOME, { recursive: true, force: true }));
