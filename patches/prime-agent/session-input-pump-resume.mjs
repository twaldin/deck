#!/usr/bin/env node
// Resume a suspended session input pump, and stop losing a deferred heartbeat.
//
// TWO defects, both reproduced live on 0.7.0 and observed as "the orchestrator
// dequeues my input at random":
//
// 1. _admitSessionInput() resumes the input pump only for the dispositions that
//    start work immediately. A programmatic turn admitted while the pump is
//    suspended by a prior abort is therefore accepted and then never pumped, so
//    queued agent messages, heartbeats and wake prompts starve at idle until
//    something else happens to wake the pump. _prompt() already resumes the pump
//    on the same condition; this makes admission agree with it.
//
// 2. A heartbeat cron fire that is skipped (no error) is rescheduled to the next
//    full interval, so a deferral silently swallows that fire. It now retries at
//    the next scheduler tick instead.
//
// Both edits are applied to dist/core (library shape) and to dist/bundle (what
// the CLI actually executes). Idempotent: a tree already carrying the guards is
// success. An unrecognised build shape is a hard error, never a silent no-op.
//
// Usage: node session-input-pump-resume.mjs <path-to-node_modules/prime-agent>
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root || !existsSync(root)) {
  console.error("usage: session-input-pump-resume.mjs <path to node_modules/prime-agent>");
  process.exit(2);
}

const PUMP_MARKER = "Programmatic admissions resume a pump suspended by an abort";
const HEARTBEAT_MARKER = "heartbeatRetryAt";
const BUNDLE_PUMP_MARKER = `action.payload.kind === "turn" && !this.isStreaming && this._sessionInputPumpSuspended`;

// [file, find, replace] - `find` must occur exactly once in a shape we recognise.
const EDITS = [
  // --- 1. input pump, library shape -------------------------------------------
  [
    "dist/core/agent-session.js",
    `        return { accepted: true, disposition, ticket: controller.ticket };`,
    `        if (!options.restore &&
            options.wake !== false &&
            action.payload.kind === "turn" &&
            !this.isStreaming &&
            this._sessionInputPumpSuspended) {
            // ${PUMP_MARKER}, matching _prompt():
            // otherwise queued agent messages, heartbeats, and wake prompts starve at idle.
            this._sessionInputPumpSuspended = false;
            this._notifySessionInputCheckpointChange();
            this._scheduleSessionInputPump();
        }
        return { accepted: true, disposition, ticket: controller.ticket };`,
  ],
  // --- 2. heartbeat retry, library shape --------------------------------------
  [
    "dist/core/cron-jobs.js",
    `                if (result.outcome === "skipped" && result.error === undefined) {
                    const nextRunAt = nextRunAtForSchedule(job.schedule, now);`,
    `                if (result.outcome === "skipped" && result.error === undefined) {
                    const scheduledNextRunAt = nextRunAtForSchedule(job.schedule, now);
                    // A deferred heartbeat fire retries at the next scheduler tick instead of
                    // losing the fire until the following full interval.
                    const heartbeatRetryAt = isHeartbeatCronJob(job) && job.schedule.kind !== "once"
                        ? new Date(now.getTime() + ONE_MINUTE_MS)
                        : undefined;
                    const nextRunAt = heartbeatRetryAt && (!scheduledNextRunAt || heartbeatRetryAt < scheduledNextRunAt)
                        ? heartbeatRetryAt
                        : scheduledNextRunAt;`,
  ],
];

let applied = 0;
for (const [relative, find, replace] of EDITS) {
  const path = join(root, relative);
  if (!existsSync(path)) {
    console.error(`error: ${relative} is missing - build shape changed`);
    process.exit(1);
  }
  const before = readFileSync(path, "utf8");
  if (before.includes(PUMP_MARKER) && relative.endsWith("agent-session.js")) continue;
  if (before.includes(HEARTBEAT_MARKER) && relative.endsWith("cron-jobs.js")) continue;
  const hits = before.split(find).length - 1;
  if (hits !== 1) {
    console.error(`error: ${relative} anchor matched ${hits} times, expected 1 - refusing to guess`);
    process.exit(1);
  }
  if (!existsSync(`${path}.orig`)) writeFileSync(`${path}.orig`, before);
  writeFileSync(path, before.replace(find, replace));
  console.log(`  patched ${relative}`);
  applied++;
}

// The bundle is what the CLI executes, so it carries the same two edits in the
// bundler's minified shape. Its local names are bundler-assigned, so anchor on
// the surrounding statements and reuse whatever name the file already uses.
const bundleDir = join(root, "dist", "bundle");
for (const name of readdirSync(bundleDir).filter((f) => f.endsWith(".js"))) {
  const path = join(bundleDir, name);
  const before = readFileSync(path, "utf8");
  let s = before;

  // The bundle carries no comments, so its guard is detected by the code itself.
  if (!s.includes(BUNDLE_PUMP_MARKER)) {
    const admit = /_admitSessionInput\(action, (options\d*) = \{\}\) \{/.exec(s);
    const RETURN = `    return { accepted: true, disposition, ticket: controller.ticket };`;
    if (admit && s.split(RETURN).length - 1 === 1) {
      const opts = admit[1];
      s = s.replace(
        RETURN,
        `    if (!${opts}.restore && ${opts}.wake !== false && action.payload.kind === "turn" && !this.isStreaming && this._sessionInputPumpSuspended) {
      this._sessionInputPumpSuspended = false;
      this._notifySessionInputCheckpointChange();
      this._scheduleSessionInputPump();
    }
${RETURN}`,
      );
      applied++;
    }
  }

  if (!s.includes(HEARTBEAT_MARKER)) {
    const CRON = `        if (result.outcome === "skipped" && result.error === void 0) {
          const nextRunAt = nextRunAtForSchedule(job.schedule, now2);`;
    if (s.split(CRON).length - 1 === 1) {
      s = s.replace(
        CRON,
        `        if (result.outcome === "skipped" && result.error === void 0) {
          const scheduledNextRunAt = nextRunAtForSchedule(job.schedule, now2);
          const heartbeatRetryAt = isHeartbeatCronJob(job) && job.schedule.kind !== "once" ? new Date(now2.getTime() + ONE_MINUTE_MS) : void 0;
          const nextRunAt = heartbeatRetryAt && (!scheduledNextRunAt || heartbeatRetryAt < scheduledNextRunAt) ? heartbeatRetryAt : scheduledNextRunAt;`,
      );
      applied++;
    }
  }

  if (s !== before) {
    if (!existsSync(`${path}.orig`)) writeFileSync(`${path}.orig`, before);
    writeFileSync(path, s);
    console.log(`  patched dist/bundle/${name}`);
  }
}

if (applied === 0) {
  const core = readFileSync(join(root, "dist", "core", "agent-session.js"), "utf8");
  const bundle = readdirSync(bundleDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(bundleDir, f), "utf8"))
    .join("\n");
  if (core.includes(PUMP_MARKER) && bundle.includes("this._sessionInputPumpSuspended = false;")) {
    console.log("already patched - nothing to do");
    process.exit(0);
  }
  console.error("nothing matched and no guards present - build shape changed, refusing to claim success");
  process.exit(1);
}
console.log(`edits applied: ${applied}`);
