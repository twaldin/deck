#!/usr/bin/env node
// Make prime-agent survive a malformed assistant `content` array.
//
// Two independent defects, both reproduced on 0.7.0 and on the nvm build:
//
// PROVEN (from the traceback): the TUI's AssistantMessageComponent reads
//    `content.type` on every element with no null check, in four places. One
//    null element therefore takes down the entire render loop, and because the
//    transcript replays on resume, the session crashes on EVERY reopen instead
//    of once. This patch fixes only that: a bad element degrades one block.
//
// UNPROVEN (deliberately NOT patched): the vendored openai ResponseAccumulator
//    appends on `content_part.added` while `content_part.done` and
//    `output_text.delta` write by absolute `event.content_index`. That mix can
//    in principle leave holes. No captured event sequence yet shows it produced
//    this null, and any "repair" there invents content parts the model did not
//    emit. Reproduce it with a recorded event stream before touching it.
//
// Usage: node null-safe-content.mjs <path-to-node_modules/prime-agent>
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root || !existsSync(root)) {
  console.error("usage: null-safe-content.mjs <path to node_modules/prime-agent>");
  process.exit(2);
}
const bundle = join(root, "dist", "bundle");
const files = readdirSync(bundle).filter((f) => f.endsWith(".js"));

const RENDER = [
  [`      const content = message.content[i];
      if (content.type === "text") {
        parts.push(\`\${i}:text:\${content.text.trim() ? 1 : 0}\`);`,
   `      const content = message.content[i];
      if (content == null) { parts.push(\`\${i}:null\`); continue; }
      if (content.type === "text") {
        parts.push(\`\${i}:text:\${content.text.trim() ? 1 : 0}\`);`],
  [`      const content = message.content[i];
      const text = content.type === "text" ?`,
   `      const content = message.content[i];
      if (content == null) { continue; }
      const text = content.type === "text" ?`],
  [`      const content = message.content[i];
      if (content.type === "text" && content.text.trim()) {`,
   `      const content = message.content[i];
      if (content == null) { continue; }
      if (content.type === "text" && content.text.trim()) {`],
];

let applied = 0, skipped = 0;
for (const f of files) {
  const p = join(bundle, f);
  let s = readFileSync(p, "utf8");
  const before = s;

  for (const [o, n] of RENDER) if (s.includes(o)) { s = s.replace(o, n); applied++; }

  const someCount = s.split(`.some((c) => c.type === "text"`).length - 1;
  if (someCount) {
    s = s.split(`.some((c) => c.type === "text"`).join(`.some((c) => c == null ? false : c.type === "text"`);
    applied += someCount;
  }

  if (s !== before) {
    if (!existsSync(p + ".orig")) writeFileSync(p + ".orig", before);
    writeFileSync(p, s);
    console.log(`  patched ${f}`);
  } else skipped++;
}
console.log(`edits applied: ${applied} (files unchanged: ${skipped})`);
if (applied === 0) {
  // Idempotent: a runtime already carrying the guards is success, not failure.
  // Only an unrecognised build shape is an error - that means the patch has
  // silently stopped covering the code it was written for.
  const already = files.some((f) => readFileSync(join(bundle, f), "utf8").includes("content == null"));
  if (already) { console.log("already patched - nothing to do"); process.exit(0); }
  console.error("nothing matched and no guards present - build shape changed, refusing to claim success");
  process.exit(1);
}
