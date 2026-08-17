/**
 * pg-boss worker bootstrap. Starts the queue and registers the job handlers.
 *
 * Slice 1 registers the import worker. Later slices register: scheduler (cron), channel
 * dispatch (voice/sms/email via the claim→gate→execute→confirm protocol, §4b), reconciler
 * (§4c), webhook-event processor (§5b), cadence follow-ups, and the RO/shown loop.
 */

import { boss } from "./queue";
import { registerImport } from "../imports/worker";

let started = false;

export async function startWorker() {
  if (started) return;
  started = true;

  await boss.start();
  await registerImport(boss);

  console.log("worker started: [import]");
}

/** SIGTERM drain (PLAN.md §9): stop claiming new jobs, let in-flight work finish, exit. */
export async function stopWorker() {
  try {
    await boss.stop({ graceful: true, timeout: 30_000 });
  } catch (e) {
    console.error("worker stop error:", (e as Error).message);
  }
}
