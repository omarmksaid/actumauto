/**
 * Webhook-event processor (PLAN.md §5b). Consumes webhook_events rows written by the thin handler
 * and does the real work: store the recording, the transcript turns, and the call cost.
 *
 * INBOUND-ONLY. Previously this also drove the outbound cadence engine (no-answer retries, SMS
 * fallbacks, appointment reminders) off the call outcome. There is no outbound cadence any more,
 * so the processor now just records what happened on a call the customer placed to us.
 *
 * Idempotent: keyed off the webhook_events row, marks processed_at; safe to re-run.
 */

import { supabaseAdmin } from "../lib/supabase";
import { recordCost, RATES } from "../lib/costs";

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
        await handleEndOfCall(msg);
      }
    }
    await supabaseAdmin.from("webhook_events")
      .update({ processed_at: new Date().toISOString() }).eq("id", ev.id);
  } catch (e: any) {
    await supabaseAdmin.from("webhook_events")
      .update({ processing_error: e.message }).eq("id", ev.id);
    throw e; // let pg-boss retry
  }
}

async function handleEndOfCall(msg: any): Promise<void> {
  const vapiCallId: string | null = msg.call?.id ?? null;
  if (!vapiCallId) return;

  // The call row was created at assistant-request time (§16e), which is where company_id and the
  // resolved caller identity live.
  const { data: call } = await supabaseAdmin
    .from("calls").select("id, company_id, customer_id, direction")
    .eq("vapi_call_id", vapiCallId).maybeSingle();
  if (!call) return;

  const durationSec = Math.round(msg.durationSeconds ?? msg.duration ?? 0);
  const recordingUrl = msg.recordingUrl ?? msg.artifact?.recordingUrl ?? null;
  const costUsd = typeof msg.cost === "number" ? msg.cost : (durationSec / 60) * RATES.VOICE_PER_MIN;
  const outcome = deriveOutcome(msg);

  // book_service already stamped outcome="booked" when it actually booked, from first-hand
  // knowledge. deriveOutcome falls back to "answered", which would erase that — so never
  // downgrade a call that produced a booking.
  const { data: prior } = await supabaseAdmin
    .from("calls").select("outcome").eq("id", call.id).maybeSingle();
  const finalOutcome = prior?.outcome === "booked" ? "booked" : outcome.outcome;

  await supabaseAdmin.from("calls").update({
    recording_url: recordingUrl,
    duration_sec: durationSec,
    outcome: finalOutcome,
    cost_usd: Number(costUsd.toFixed(4)),
    metadata: { endedReason: msg.endedReason, analysis: msg.analysis ?? null },
  }).eq("id", call.id);

  // A handoff row exists to make sure nobody falls through the cracks. Once Vapi confirms the
  // leg actually moved to a human, there is nothing for an advisor to action — the advisor IS
  // the next step. Leaving it open buries the rows that DO need work (a transfer that rang out,
  // or a message taken because no transfer line is configured) in a pile of noise, which trains
  // people to ignore the queue.
  //
  // Note this is decided by the call's OUTCOME, not by whether a transfer number was configured:
  // "we tried to transfer" and "a human picked up" are different facts.
  if (msg.endedReason === "assistant-forwarded-call") {
    await supabaseAdmin.from("handoff_requests")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("call_id", call.id).eq("status", "open");
  }

  await recordCost({
    companyId: call.company_id, customerId: call.customer_id,
    category: "voice", amountUsd: costUsd,
    meta: { vapiCallId, durationSec, direction: call.direction },
  });

  await storeTranscript(call.company_id, call.id, call.customer_id, msg);

  // Vapi's summary only exists once the call ends, which is after book_service already wrote the
  // row. It's shaped by summaryPlan (see inbound/assistant.ts) to carry ONLY what the structured
  // fields don't already say. When there's nothing extra it returns a fixed sentinel, and
  // appending "No extra notes" to every appointment is just noise for the advisor to scroll past.
  const summary = String(msg.analysis?.summary ?? "").trim();
  const hasExtra = summary && !/^no extra notes\.?$/i.test(summary);
  if (hasExtra && call.customer_id) {
    const { data: appts } = await supabaseAdmin
      .from("appointments")
      .select("id, notes")
      .eq("customer_id", call.customer_id)
      .in("status", ["pending_confirmation", "confirmed"])
      .gte("created_at", new Date(Date.now() - 2 * 3600_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1);
    const appt = appts?.[0];
    if (appt && !String(appt.notes ?? "").includes("From the call:")) {
      await supabaseAdmin.from("appointments").update({
        notes: `${appt.notes ?? ""}\n\nFrom the call:\n${summary}`.trim(),
      }).eq("id", appt.id);
    }
  }

  // An opt-out on an inbound call still has to stick.
  if (outcome.optout && call.customer_id) {
    await supabaseAdmin.from("customers")
      .update({ opted_out: true }).eq("id", call.customer_id);
  }
}

export interface DerivedOutcome {
  /** answered | booked | declined — inbound has no no-answer/voicemail branch. */
  outcome: string;
  optout: boolean;
  handoff: boolean;
  booked: boolean;
  preferredTime?: string | null;
  notes?: string | null;
}

/**
 * Read Vapi's structured analysis. The transcript is stored for playback/FTS but is NOT trusted
 * for control decisions — structured fields and explicit tool calls are the source of truth.
 */
export function deriveOutcome(msg: any): DerivedOutcome {
  const analysis = msg.analysis ?? {};
  const structured = analysis.structuredData ?? {};
  const summaryText = String(analysis.summary ?? "").toLowerCase();

  const optout = !!structured.optout || summaryText.includes("[optout]") || summaryText.includes("do not call");
  const handoff = !!structured.handoff || summaryText.includes("[handoff]");
  const booked = !!structured.booked || structured.commitment_type === "booked";

  let outcome = "answered";
  if (booked) outcome = "booked";
  else if (structured.commitment_type === "declined") outcome = "declined";

  return {
    outcome, optout, handoff, booked,
    preferredTime: structured.preferred_time ?? null,
    notes: analysis.summary ?? null,
  };
}

async function storeTranscript(companyId: string, callId: string, customerId: string | null, msg: any) {
  // Idempotency: don't double-insert if we've already stored this call's transcript.
  const { count } = await supabaseAdmin.from("transcripts")
    .select("id", { count: "exact", head: true }).eq("call_id", callId);
  if ((count ?? 0) > 0) return;

  const turns: any[] = Array.isArray(msg.artifact?.messages) ? msg.artifact.messages
    : Array.isArray(msg.messages) ? msg.messages : [];
  const rows = turns
    .filter((t) => t.role && (t.message || t.content))
    .map((t) => ({
      company_id: companyId, call_id: callId, customer_id: customerId, channel: "voice",
      role: t.role === "bot" || t.role === "assistant" ? "ai" : t.role === "user" ? "customer" : "system",
      content: String(t.message ?? t.content ?? "").replace(/\[(OPTOUT|HANDOFF)\]/gi, "").trim(),
    }))
    .filter((r) => r.content);
  if (rows.length) await supabaseAdmin.from("transcripts").insert(rows);
}
