/**
 * pg-boss worker bootstrap. Starts the queue and registers job handlers.
 *
 * INBOUND-ONLY. The system no longer places calls, so there is no dispatch queue, no scheduler
 * tick, no reconciler, and no number-health cron — all of that existed to pace and de-duplicate
 * OUTBOUND dialing. What remains is genuinely asynchronous work:
 *
 *   import          — CSV of past customers + their vehicles, so an inbound caller is recognized.
 *   process-webhook — Vapi end-of-call events (recording, transcript, cost) off the durable inbox.
 */

import { boss } from "./queue";
import { registerImport } from "../imports/worker";
import { registerEventProcessor } from "../calls/events";
import { registerArchiver } from "../calls/archive";

/** Every queue this app sends to. Must be created up front (pg-boss v10). */
const QUEUES = ["import", "process-webhook", "archive-recordings", "retention-sweep"];

let started = false;

export async function startWorker() {
  if (started) return;
  started = true;

  await boss.start();

  // pg-boss v10 requires queues to EXIST before send() will accept a job. boss.work() alone does
  // not create them, and send() to an unknown queue fails without throwing — the symptom is
  // webhook_events piling up with processed_at null and an empty job table.
  for (const q of QUEUES) {
    await boss.createQueue(q).catch(() => { /* already exists */ });
  }

  await registerImport(boss);
  await registerEventProcessor(boss);
  await registerArchiver(boss);

  // Copy call audio out of Vapi into our own bucket. On a cron rather than inline after each
  // call: Vapi needs a moment to finalize the file, and retries belong outside the webhook path.
  await boss.schedule("archive-recordings", "*/5 * * * *");
  // Delete audio past its retention window (companies.recording_retention_days, default 180).
  await boss.schedule("retention-sweep", "30 3 * * *");

  console.log("worker started: [import, process-webhook, archive-recordings, retention-sweep]");
}

/** SIGTERM drain (PLAN.md §9): stop claiming new jobs, let in-flight work finish, exit. */
export async function stopWorker() {
  try {
    await boss.stop({ graceful: true, timeout: 30_000 });
  } catch (e) {
    console.error("worker stop error:", (e as Error).message);
  }
}
