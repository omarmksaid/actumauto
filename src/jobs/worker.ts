/**
 * pg-boss worker bootstrap. Starts the queue and registers job handlers + crons.
 *
 * Slice 1: import worker.
 * Slice 2: dispatch (claim→gate→execute→confirm), webhook-event processor, reconciler cron,
 *          and the scheduler tick that claims due touchpoints with FOR UPDATE SKIP LOCKED.
 */

import { boss } from "./queue";
import { supabaseAdmin } from "../lib/supabase";
import { registerImport } from "../imports/worker";
import { registerDispatch } from "../dispatch/dispatch";
import { registerMessageDispatch } from "../dispatch/message";
import { registerEventProcessor } from "../dispatch/events";
import { reconcile } from "../dispatch/reconciler";

let started = false;

export async function startWorker() {
  if (started) return;
  started = true;

  await boss.start();

  // Handlers.
  await registerImport(boss);
  await registerDispatch(boss);
  await registerMessageDispatch(boss);
  await registerEventProcessor(boss);

  // Reconciler cron (§4c) — dedup backstop, every 5 min.
  await boss.work("reconcile", async () => { await reconcile(); });
  await boss.schedule("reconcile", "*/5 * * * *");

  // Scheduler tick — claims due touchpoints and enqueues dispatch. FOR UPDATE SKIP LOCKED via RPC
  // (claim_due_touchpoints) so concurrent scheduler instances never grab the same row (§4b).
  await boss.work("scheduler-tick", async () => { await schedulerTick(); });
  await boss.schedule("scheduler-tick", "* * * * *"); // every minute

  console.log("worker started: [import, dispatch-voice, process-webhook, reconcile, scheduler-tick]");
}

/**
 * Pull due, schedulable touchpoints and enqueue a dispatch job for each. Uses the
 * claim_due_touchpoints RPC (FOR UPDATE SKIP LOCKED) so two workers can't grab the same row.
 */
async function schedulerTick(): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc("claim_due_touchpoints", { p_limit: 50 });
  if (error) { console.error("scheduler-tick rpc error:", error.message); return; }
  for (const row of data ?? []) {
    const queue = row.channel === "voice" ? "dispatch-voice" : "dispatch-message";
    await boss.send(queue, { touchpointId: row.id }, { singletonKey: `dispatch:${row.id}` });
  }
}

/** SIGTERM drain (PLAN.md §9): stop claiming new jobs, let in-flight work finish, exit. */
export async function stopWorker() {
  try {
    await boss.stop({ graceful: true, timeout: 30_000 });
  } catch (e) {
    console.error("worker stop error:", (e as Error).message);
  }
}
