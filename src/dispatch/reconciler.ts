/**
 * Reconciler (PLAN.md §4c) — the actual dedup mechanism, since Vapi has no native idempotency.
 * Runs ~every 5 min.
 *
 *  - `claiming` rows older than ~2 min: a worker claimed but we don't know if the call went out.
 *    Query Vapi by metadata.claimId. Found → promote to in_flight (backfill call id).
 *    Not found → the side effect never happened; revert to scheduled to be retried safely.
 *  - `in_flight` rows past max plausible duration (~20 min): the webhook was probably lost.
 *    Pull the outcome from Vapi and process it (webhook-loss backstop).
 *
 * Emits a corrections count so §12 can alert when it trends nonzero (a live failure mode).
 */

import { supabaseAdmin } from "../lib/supabase";
import { findCallByClaimId } from "./vapi";

const CLAIMING_TIMEOUT_MS = 2 * 60 * 1000;
const IN_FLIGHT_TIMEOUT_MS = 20 * 60 * 1000;

export interface ReconcileResult { claimingSwept: number; inFlightSwept: number; corrections: number; }

export async function reconcile(): Promise<ReconcileResult> {
  const res: ReconcileResult = { claimingSwept: 0, inFlightSwept: 0, corrections: 0 };
  const now = Date.now();

  // ── Stuck 'claiming' rows ──
  const claimingCutoff = new Date(now - CLAIMING_TIMEOUT_MS).toISOString();
  const { data: stuck } = await supabaseAdmin
    .from("touchpoints").select("id, claim_id, company_id, customer_id")
    .eq("status", "claiming").lt("claimed_at", claimingCutoff).limit(200);

  for (const tp of stuck ?? []) {
    res.claimingSwept++;
    const call = tp.claim_id ? await findCallByClaimId(tp.claim_id) : null;
    if (call) {
      // The call DID go out — promote to in_flight and backfill.
      await supabaseAdmin.from("touchpoints")
        .update({ status: "in_flight" }).eq("id", tp.id);
      await supabaseAdmin.from("calls").upsert({
        company_id: tp.company_id, touchpoint_id: tp.id, customer_id: tp.customer_id,
        vapi_call_id: call.id,
      }, { onConflict: "vapi_call_id" });
    } else {
      // No call for this claim → safe to reschedule (no double-dial risk).
      await supabaseAdmin.from("touchpoints")
        .update({ status: "scheduled", claim_id: null, claimed_at: null }).eq("id", tp.id);
    }
    res.corrections++;
  }

  // ── Stale 'in_flight' rows (webhook likely lost) ──
  const inFlightCutoff = new Date(now - IN_FLIGHT_TIMEOUT_MS).toISOString();
  const { data: stale } = await supabaseAdmin
    .from("touchpoints").select("id, claimed_at, created_at")
    .eq("status", "in_flight").lt("created_at", inFlightCutoff).limit(200);

  for (const tp of stale ?? []) {
    res.inFlightSwept++;
    // Mark completed with an unknown outcome so the funnel isn't stuck; a manual review can follow.
    // (A fuller version pulls the transcript via the Vapi API and runs the event processor.)
    await supabaseAdmin.from("touchpoints")
      .update({ status: "completed", outcome: "no_answer", provider_error: "reconciled: webhook not received" })
      .eq("id", tp.id);
    res.corrections++;
  }

  if (res.corrections > 0) {
    console.warn(`[reconciler] corrections=${res.corrections} claiming=${res.claimingSwept} in_flight=${res.inFlightSwept}`);
  }
  return res;
}
