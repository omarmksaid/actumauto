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

let started = false;

export async function startWorker() {
  if (started) return;
  started = true;

  await boss.start();

  await registerImport(boss);
  await registerEventProcessor(boss);

  console.log("worker started: [import, process-webhook]");
}

/** SIGTERM drain (PLAN.md §9): stop claiming new jobs, let in-flight work finish, exit. */
export async function stopWorker() {
  try {
    await boss.stop({ graceful: true, timeout: 30_000 });
  } catch (e) {
    console.error("worker stop error:", (e as Error).message);
  }
}
