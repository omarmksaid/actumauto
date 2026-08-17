/**
 * Cadence engine (PLAN.md §4/§5). Given a completed touchpoint + its structured outcome, apply the
 * dealership cadence: voicemail branch, no-answer retries, SMS/email fallbacks, booked → reminders,
 * and the ATOMIC opt-out (cancel every scheduled touchpoint across all channels/vehicles).
 *
 * Follow-ups are new `touchpoints` enqueued with startAfter + singletonKey — same machinery as the
 * initial slot, so the dispatch protocol (§4b) applies uniformly.
 */

import { supabaseAdmin } from "../lib/supabase";
import { boss } from "../jobs/queue";
import { getBookingProvider } from "../booking";
import type { DerivedOutcome } from "./events";

export async function applyOutcome(tp: any, outcome: DerivedOutcome): Promise<void> {
  // 1. ATOMIC OPT-OUT — highest priority; nothing else should schedule after it.
  if (outcome.optout) {
    await optOutCustomer(tp.company_id, tp.customer_id);
    await markCompleted(tp.id, outcome.outcome);
    return;
  }

  const { data: cadence } = await supabaseAdmin
    .from("cadences").select("*").eq("company_id", tp.company_id).limit(1).maybeSingle();
  const cad = cadence ?? defaults();

  // 2. BOOKED — create the (soft) appointment(s) + schedule reminders.
  if (outcome.booked) {
    await createSoftAppointments(tp, outcome);
    await scheduleReminders(tp, cad);
    await markCompleted(tp.id, "booked");
    return;
  }

  // 3. VOICEMAIL — optional immediate booking-link SMS, then treat per attempt policy.
  if (outcome.outcome === "voicemail_dropped") {
    if (cad.voicemail_sms_immediate) await enqueueFallback(tp, "sms", 0);
    const countsAsAttempt = cad.voicemail_counts_as_attempt;
    await maybeRetryOrFallback(tp, cad, countsAsAttempt ? 1 : 0);
    await markCompleted(tp.id, "voicemail_dropped");
    return;
  }

  // 4. NO ANSWER — retry the call up to max, else fall back to SMS/email.
  if (outcome.outcome === "no_answer") {
    await maybeRetryOrFallback(tp, cad, 1);
    await markCompleted(tp.id, "no_answer");
    return;
  }

  // 5. ANSWERED but not booked (declined / undecided) — stop the voice cadence; leave a soft SMS.
  await enqueueFallback(tp, "sms", cad.sms_fallback_after_min * 60);
  await markCompleted(tp.id, outcome.outcome);
}

// ── steps ──

async function maybeRetryOrFallback(tp: any, cad: any, attemptIncrement: number): Promise<void> {
  const nextAttempt = (tp.attempt ?? 0) + attemptIncrement;
  if (nextAttempt < cad.max_call_attempts) {
    await enqueueFollowup(tp, "voice", "no_answer_retry", cad.no_answer_retry_after_min * 60, nextAttempt);
  } else {
    await enqueueFallback(tp, "sms", cad.sms_fallback_after_min * 60);
    await enqueueFallback(tp, "email", cad.email_fallback_after_min * 60);
  }
}

async function enqueueFollowup(tp: any, channel: string, kind: string, startAfterSec: number, attempt: number) {
  const { data } = await supabaseAdmin.from("touchpoints").insert({
    company_id: tp.company_id, customer_id: tp.customer_id, vehicle_ids: tp.vehicle_ids,
    campaign_id: tp.campaign_id, channel, kind,
    scheduled_at: new Date(Date.now() + startAfterSec * 1000).toISOString(),
    window_bucket: tp.window_bucket, status: "scheduled", attempt,
  }).select("id").single();
  if (data && channel === "voice") {
    await boss.send("dispatch-voice", { touchpointId: data.id },
      { startAfter: startAfterSec, singletonKey: `dispatch:${data.id}` });
  }
  // sms/email dispatch handlers arrive with the messaging slice; the row is created either way.
}

async function enqueueFallback(tp: any, channel: "sms" | "email", startAfterSec: number) {
  await enqueueFollowup(tp, channel, "no_answer_retry", startAfterSec, tp.attempt ?? 0);
}

async function scheduleReminders(tp: any, cad: any) {
  // Reminder offsets are minutes BEFORE the appointment; without a firm time (soft mode) we skip
  // until an advisor confirms and sets starts_at. The reminder job re-reads offsets at that point.
  // (Left as a marker so the booked path is explicit — real scheduling lands with the messaging slice.)
  return;
}

async function createSoftAppointments(tp: any, outcome: DerivedOutcome) {
  const booking = getBookingProvider();
  const due = ((tp.result as any)?.due ?? []) as any[];
  const vehicleIds: string[] = tp.vehicle_ids ?? [];
  // One appointment per due vehicle (multi-car household → multiple appointments).
  const targets = vehicleIds.length ? vehicleIds : [null];
  for (let i = 0; i < targets.length; i++) {
    await booking.createAppointment({
      companyId: tp.company_id, customerId: tp.customer_id, vehicleId: targets[i],
      touchpointId: tp.id,
      preferredTime: outcome.preferredTime ?? "their preferred time",
      serviceOps: due[i]?.operations ?? [],
      notes: outcome.notes ?? "",
    });
  }
}

/** Atomic opt-out: flag the customer + cancel every scheduled/claiming touchpoint for them. */
async function optOutCustomer(companyId: string, customerId: string) {
  await supabaseAdmin.from("customers")
    .update({ opted_out: true }).eq("id", customerId);
  const { data: pending } = await supabaseAdmin.from("touchpoints")
    .select("id").eq("customer_id", customerId).in("status", ["scheduled", "claiming"]);
  for (const p of pending ?? []) {
    await boss.cancel("dispatch-voice", `dispatch:${p.id}`).catch(() => {});
  }
  await supabaseAdmin.from("touchpoints")
    .update({ status: "canceled" }).eq("customer_id", customerId).in("status", ["scheduled", "claiming"]);
}

async function markCompleted(touchpointId: string, outcome: string) {
  await supabaseAdmin.from("touchpoints")
    .update({ status: "completed", outcome }).eq("id", touchpointId);
}

function defaults() {
  return {
    no_answer_retry_after_min: 1440, max_call_attempts: 2,
    sms_fallback_after_min: 120, email_fallback_after_min: 240,
    on_machine: "drop_message", voicemail_counts_as_attempt: false, voicemail_sms_immediate: true,
  };
}
