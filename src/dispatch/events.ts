/**
 * Webhook-event processor (PLAN.md §5b). Consumes webhook_events rows written by the thin handler
 * and does the real work: store the call recording + transcript, apply the STRUCTURED outcome
 * (from Vapi's analysis/function-calls, not transcript guessing), record cost, run the atomic
 * opt-out, and trigger the cadence engine.
 *
 * Idempotent: keyed off the webhook_events row, marks processed_at; safe to re-run.
 */

import { supabaseAdmin } from "../lib/supabase";
import { recordCost, RATES } from "../lib/costs";
import { applyOutcome, optOutCustomer } from "./cadence";

interface ProcessJob { webhookEventId: string; }

export function registerEventProcessor(boss: any) {
  return boss.work("process-webhook", { batchSize: 1 }, async ([job]: any) => {
    await processWebhookEvent((job.data as ProcessJob).webhookEventId);
  });
}

export async function processWebhookEvent(eventId: string): Promise<void> {
  const { data: ev } = await supabaseAdmin
    .from("webhook_events").select("*").eq("id", eventId).maybeSingle();
  if (!ev || ev.processed_at) return;

  try {
    if (ev.provider === "vapi") {
      const msg = ev.raw_payload?.message ?? {};
      if (msg.type === "end-of-call-report") {
        await handleEndOfCall(ev.id, ev.touchpoint_id, msg);
      }
    } else if (ev.provider === "telnyx") {
      await handleTelnyxEvent(ev.raw_payload);
    }
    await supabaseAdmin.from("webhook_events")
      .update({ processed_at: new Date().toISOString() }).eq("id", ev.id);
  } catch (e: any) {
    await supabaseAdmin.from("webhook_events")
      .update({ processing_error: e.message }).eq("id", ev.id);
    throw e; // let pg-boss retry
  }
}

/** Telnyx events: inbound STOP → atomic opt-out; delivery failures could feed number health later. */
async function handleTelnyxEvent(payload: any): Promise<void> {
  const eventType = payload?.data?.event_type ?? "";
  if (eventType !== "message.received") return;

  const from: string | null = payload?.data?.payload?.from?.phone_number ?? null;
  const text: string = String(payload?.data?.payload?.text ?? "").trim().toLowerCase();
  const isStop = /^(stop|unsubscribe|cancel|quit|end)\b/.test(text);
  if (!from || !isStop) return;

  // Find the customer by phone across companies (a number is unique enough to opt out everywhere).
  const { data: customers } = await supabaseAdmin
    .from("customers").select("id, company_id").eq("phone", from);
  for (const cust of customers ?? []) {
    await optOutCustomer(cust.company_id, cust.id);
  }
}

async function handleEndOfCall(eventId: string, touchpointId: string | null, msg: any): Promise<void> {
  const vapiCallId: string | null = msg.call?.id ?? null;

  // The call row: for outbound it was created on confirm; for inbound (§16) at assistant-request.
  // Read company_id/direction from it so INBOUND calls — which have no touchpoint — still get
  // their recording, cost, and transcript stored.
  const { data: callRow } = vapiCallId
    ? await supabaseAdmin.from("calls")
        .select("touchpoint_id, company_id, customer_id, direction").eq("vapi_call_id", vapiCallId).maybeSingle()
    : { data: null };

  // Locate the touchpoint (metadata first, else via the call row). Inbound has none.
  const tpId = touchpointId ?? callRow?.touchpoint_id ?? null;

  const { data: tp } = tpId
    ? await supabaseAdmin.from("touchpoints").select("*").eq("id", tpId).maybeSingle()
    : { data: null };

  const durationSec = Math.round(msg.durationSeconds ?? msg.duration ?? 0);
  const recordingUrl = msg.recordingUrl ?? msg.artifact?.recordingUrl ?? null;
  const costUsd = typeof msg.cost === "number" ? msg.cost : (durationSec / 60) * RATES.VOICE_PER_MIN;

  // STRUCTURED outcome: prefer Vapi analysis + explicit function calls over transcript parsing.
  const outcome = deriveOutcome(msg);

  // Upsert the call row. Prefer the touchpoint's company (outbound) but fall back to the call row.
  const companyId = tp?.company_id ?? callRow?.company_id;
  const customerId = tp?.customer_id ?? callRow?.customer_id ?? null;
  if (vapiCallId && companyId) {
    await supabaseAdmin.from("calls").update({
      recording_url: recordingUrl, duration_sec: durationSec,
      outcome: outcome.outcome, cost_usd: Number(costUsd.toFixed(4)),
      metadata: { endedReason: msg.endedReason, analysis: msg.analysis ?? null },
    }).eq("vapi_call_id", vapiCallId);

    await recordCost({
      companyId, touchpointId: tpId, customerId,
      category: "voice", amountUsd: costUsd,
      meta: { vapiCallId, durationSec, direction: callRow?.direction ?? "outbound" },
    });

    // Store the transcript turns for playback + FTS (identical for inbound and outbound).
    await storeTranscript(companyId, vapiCallId, customerId, msg);
  }

  // Apply the structured outcome to the cadence engine (retries, fallbacks, reminders, opt-out).
  if (tp) {
    await applyOutcome(tp, outcome);
  }
}

export interface DerivedOutcome {
  outcome: string;               // answered|no_answer|voicemail_dropped|machine_hangup|booked|declined
  optout: boolean;
  handoff: boolean;
  booked: boolean;
  preferredTime?: string | null;
  notes?: string | null;
}

/** Read Vapi's structured analysis + endedReason. Transcript is stored but not trusted for control. */
export function deriveOutcome(msg: any): DerivedOutcome {
  const ended = String(msg.endedReason ?? "").toLowerCase();
  const analysis = msg.analysis ?? {};
  const structured = analysis.structuredData ?? {};
  const summaryText = String(analysis.summary ?? "").toLowerCase();

  const voicemail = ended.includes("voicemail") || ended.includes("machine");
  const noAnswer = ended.includes("no-answer") || ended.includes("customer-did-not-answer") || ended.includes("busy");

  const optout = !!structured.optout || summaryText.includes("[optout]") || summaryText.includes("do not call");
  const handoff = !!structured.handoff || summaryText.includes("[handoff]");
  const booked = !!structured.booked || structured.commitment_type === "booked";

  let outcome = "answered";
  if (voicemail) outcome = "voicemail_dropped";
  else if (noAnswer) outcome = "no_answer";
  else if (booked) outcome = "booked";
  else if (structured.commitment_type === "declined") outcome = "declined";

  return {
    outcome, optout, handoff, booked,
    preferredTime: structured.preferred_time ?? null,
    notes: analysis.summary ?? null,
  };
}

async function storeTranscript(companyId: string, vapiCallId: string, customerId: string | null, msg: any) {
  const { data: call } = await supabaseAdmin.from("calls")
    .select("id").eq("vapi_call_id", vapiCallId).maybeSingle();
  if (!call) return;

  // Idempotency: don't double-insert if we've already stored this call's transcript.
  const { count } = await supabaseAdmin.from("transcripts")
    .select("id", { count: "exact", head: true }).eq("call_id", call.id);
  if ((count ?? 0) > 0) return;

  const turns: any[] = Array.isArray(msg.artifact?.messages) ? msg.artifact.messages
    : Array.isArray(msg.messages) ? msg.messages : [];
  const rows = turns
    .filter((t) => t.role && (t.message || t.content))
    .map((t) => ({
      company_id: companyId, call_id: call.id, customer_id: customerId, channel: "voice",
      role: t.role === "bot" || t.role === "assistant" ? "ai" : t.role === "user" ? "customer" : "system",
      content: String(t.message ?? t.content ?? "").replace(/\[(OPTOUT|HANDOFF)\]/gi, "").trim(),
    }))
    .filter((r) => r.content);
  if (rows.length) await supabaseAdmin.from("transcripts").insert(rows);
}
