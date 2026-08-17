/**
 * Voice dispatch (PLAN.md §4b): claim → gate → execute → confirm for a single touchpoint.
 *
 * Non-idempotent side effect (a phone call) under at-least-once delivery. The claim CAS makes a
 * double-delivery a no-op (second worker gets 0 rows); the reconciler (§4c) recovers a crash
 * between execute and confirm. A gate failure reverts to `scheduled` WITHOUT consuming an attempt.
 */

import { supabaseAdmin } from "../lib/supabase";
import { boss } from "../jobs/queue";
import { env } from "../lib/env";
import { preDialGate } from "./gate";
import { buildSystemPrompt, buildFirstMessage, DueVehicleForPrompt } from "./prompt";
import { placeVapiCall } from "./vapi";
import { getBookingProvider } from "../booking";
import { rampCap } from "../numbers/health";

interface DispatchJob { touchpointId: string; }

export async function dispatchVoice(touchpointId: string): Promise<void> {
  // 1. CLAIM (CAS): only one worker can move scheduled → claiming.
  const claimId = crypto.randomUUID();
  const { data: claimed } = await supabaseAdmin
    .from("touchpoints")
    .update({ status: "claiming", claim_id: claimId, claimed_at: new Date().toISOString() })
    .eq("id", touchpointId).eq("status", "scheduled")
    .select("id, company_id, customer_id, vehicle_ids, channel, result")
    .maybeSingle();
  if (!claimed) return; // someone else owns it (or it's not schedulable) — drop the job.

  const tp = claimed;

  // Load dealership + customer + cadence context.
  const { data: company } = await supabaseAdmin
    .from("companies").select("name, timezone, settings, dial_enabled").eq("id", tp.company_id).single();
  const { data: customer } = await supabaseAdmin
    .from("customers").select("full_name, phone, customer_type, personality, detected_language, opted_out, do_not_contact")
    .eq("id", tp.customer_id).single();
  const { data: cadence } = await supabaseAdmin
    .from("cadences").select("*").eq("company_id", tp.company_id).limit(1).maybeSingle();

  // Hard stops that should cancel, not retry.
  if (!customer || customer.opted_out || customer.do_not_contact || !customer.phone) {
    await revert(touchpointId, "canceled");
    return;
  }

  // 2. GATE (re-checked at dial time).
  const gate = await preDialGate({
    companyId: tp.company_id,
    timezone: company?.timezone ?? env.DEFAULT_TIMEZONE,
    quietStart: cadence?.quiet_start ?? "20:00",
    quietEnd: cadence?.quiet_end ?? "09:00",
    channel: "voice",
  });
  if (!gate.ok) {
    // Revert to scheduled and re-enqueue after the hint — attempt counter untouched.
    await revert(touchpointId, "scheduled");
    await boss.send("dispatch-voice", { touchpointId },
      { startAfter: gate.retryAfterSec, singletonKey: `dispatch:${touchpointId}` });
    return;
  }

  // Pick a pool number (enabled, not quarantined, under ramped cap) by weight.
  const number = await pickNumber(tp.company_id);
  if (!number) {
    await revert(touchpointId, "scheduled");
    await boss.send("dispatch-voice", { touchpointId },
      { startAfter: 15 * 60, singletonKey: `dispatch:${touchpointId}` });
    return;
  }

  // Assemble the per-call prompt FRESH from only this customer's data (no cross-call leakage).
  const settings = (company?.settings ?? {}) as any;
  const voice = settings.voice ?? { provider: env.DEFAULT_TTS_PROVIDER, voice_id: env.DEFAULT_VOICE_ID };
  const dueVehicles: DueVehicleForPrompt[] = ((tp.result as any)?.due ?? []).map((d: any) => ({
    make: d.make ?? "", model: d.model ?? "", year: d.year ?? 0,
    service: d.service, dueReason: d.reason, projectedMileage: d.projected_mileage ?? 0,
  }));
  // Fall back to fetching vehicle names if the slotter didn't denormalize them.
  const vehicles = await hydrateVehicleNames(tp.vehicle_ids as string[], dueVehicles);

  const bookingMode = getBookingProvider().mode;
  const promptInputs = {
    dealershipName: company?.name ?? "the dealership",
    customerName: customer.full_name,
    customerType: customer.customer_type,
    personalitySummary: (customer.personality as any)?.summary ?? null,
    language: customer.detected_language,
    vehicles,
    personaTemplate: settings.persona_prompt ?? null,
    bookingMode,
    knowledge: null,
  };

  // 3. EXECUTE.
  const result = await placeVapiCall({
    phoneNumberId: number.vapi_phone_id,
    toNumber: customer.phone,
    systemPrompt: buildSystemPrompt(promptInputs),
    firstMessage: buildFirstMessage(promptInputs),
    voiceId: voice.voice_id,
    ttsProvider: voice.provider,
    claimId,
    touchpointId,
    onMachine: cadence?.on_machine ?? "drop_message",
    voicemailMessage:
      `Hi ${customer.full_name.split(" ")[0]}, it's ${company?.name ?? "the dealership"} service — ` +
      `your vehicle is due for service. We'll send you a text with a link to book. Thanks!`,
  });

  if (!result.ok) {
    // Distinguish "provider down" (5xx / network) from a real failure.
    const providerDown = !result.status || result.status >= 500;
    if (providerDown) {
      await tripCircuit("vapi");
      await revert(touchpointId, "scheduled", { provider_error: result.error });
      await boss.send("dispatch-voice", { touchpointId },
        { startAfter: 5 * 60, singletonKey: `dispatch:${touchpointId}` });
    } else {
      await supabaseAdmin.from("touchpoints")
        .update({ status: "failed", outcome: "provider_error", provider_error: result.error })
        .eq("id", touchpointId);
    }
    return;
  }

  // 4. CONFIRM: scheduled/claiming → in_flight, keyed on claim_id so only our claim advances.
  await supabaseAdmin.from("touchpoints").update({
    status: "in_flight",
    phone_number_id: number.id,
    attempt: 1,
    result: { ...(tp.result as any), vapi_call_id: result.vapiCallId },
  }).eq("claim_id", claimId);

  // Call row shell; the webhook (§5b) fills in recording/duration/outcome/cost.
  await supabaseAdmin.from("calls").insert({
    company_id: tp.company_id, touchpoint_id: touchpointId, customer_id: tp.customer_id,
    vapi_call_id: result.vapiCallId,
  });
  await bumpNumberUsage(number.id);
}

export function registerDispatch(boss: any) {
  return boss.work("dispatch-voice", { batchSize: 1 }, async ([job]: any) => {
    await dispatchVoice((job.data as DispatchJob).touchpointId);
  });
}

// ── helpers ──

async function revert(id: string, status: string, extra: Record<string, unknown> = {}) {
  await supabaseAdmin.from("touchpoints")
    .update({ status, claim_id: null, claimed_at: null, ...extra }).eq("id", id);
}

async function pickNumber(companyId: string) {
  const { data } = await supabaseAdmin
    .from("phone_numbers")
    .select("id, vapi_phone_id, weight, daily_cap, sent_today, quarantined_at, ramp_started_on")
    .eq("company_id", companyId).eq("enabled", true).is("quarantined_at", null)
    .not("vapi_phone_id", "is", null);
  const today = new Date().toISOString().slice(0, 10);
  // Respect the WARM-UP RAMP: effective cap is min(daily_cap, ramp_cap(today)) so unwarmed
  // numbers don't blow past their ramp and get flagged (§2).
  const usable = (data ?? [])
    .map((n) => ({ ...n, cap: rampCap(n.ramp_started_on, n.daily_cap ?? 400, today) }))
    .filter((n) => (n.sent_today ?? 0) < n.cap);
  if (!usable.length) return null;
  // Weighted pick, favoring lower utilization.
  usable.sort((a, b) => (a.sent_today ?? 0) / a.cap - (b.sent_today ?? 0) / b.cap);
  return usable[0];
}

async function bumpNumberUsage(numberId: string) {
  await supabaseAdmin.rpc("increment_number_sent", { p_id: numberId }).then(
    () => {},
    // RPC optional; fall back to a read-modify-write if it doesn't exist.
    async () => {
      const { data } = await supabaseAdmin.from("phone_numbers").select("sent_today").eq("id", numberId).single();
      await supabaseAdmin.from("phone_numbers").update({ sent_today: (data?.sent_today ?? 0) + 1 }).eq("id", numberId);
    }
  );
}

async function tripCircuit(provider: string) {
  const retryAfter = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await supabaseAdmin.from("provider_circuits").upsert({
    provider, state: "open", opened_at: new Date().toISOString(), retry_after: retryAfter,
  });
}

/** If the slotter denormalized vehicle names into result.due they're used as-is; otherwise fetch. */
async function hydrateVehicleNames(vehicleIds: string[], due: DueVehicleForPrompt[]): Promise<DueVehicleForPrompt[]> {
  if (due.every((d) => d.make && d.model && d.year)) return due;
  const { data } = await supabaseAdmin
    .from("vehicles").select("id, make, model, year").in("id", vehicleIds);
  const byId = new Map((data ?? []).map((v) => [v.id, v]));
  // Re-attach names positionally where missing.
  return due.map((d, i) => {
    const v = byId.get(vehicleIds[i]);
    return v ? { ...d, make: v.make, model: v.model, year: v.year } : d;
  });
}
