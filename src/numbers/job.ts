/**
 * Number-health cron (PLAN.md §2). Runs a few times a day: for each enabled number, compute the
 * 7-day answer rate from its voice touchpoints, update health, and auto-quarantine on decay.
 * Also resets sent_today counters at the day boundary.
 */

import { DateTime } from "luxon";
import { supabaseAdmin } from "../lib/supabase";
import { answerRate, healthScore, shouldQuarantine, OutcomeCounts } from "./health";

const ANSWERED = ["answered", "booked"];

export async function runNumberHealth(todayIso: string): Promise<{ updated: number; quarantined: number }> {
  const { data: numbers } = await supabaseAdmin
    .from("phone_numbers").select("id, answer_rate_7d, last_reset").eq("enabled", true);

  let updated = 0, quarantined = 0;
  const sevenDaysAgo = DateTime.fromISO(todayIso).minus({ days: 7 }).toISO()!;

  for (const n of numbers ?? []) {
    // Count this number's voice touchpoint outcomes over the last 7 days.
    const { data: tps } = await supabaseAdmin
      .from("touchpoints").select("outcome")
      .eq("phone_number_id", n.id).eq("channel", "voice")
      .gte("created_at", sevenDaysAgo);

    const counts: OutcomeCounts = {
      total: (tps ?? []).filter((t) => t.outcome).length,
      answered: (tps ?? []).filter((t) => ANSWERED.includes(t.outcome ?? "")).length,
    };
    const rate = answerRate(counts);
    const baseline = n.answer_rate_7d; // prior value acts as the baseline for decay detection
    const health = healthScore(rate, baseline);
    const quarantine = shouldQuarantine(rate, baseline);

    const patch: any = { answer_rate_7d: rate, health_score: health };
    if (quarantine) { patch.quarantined_at = new Date().toISOString(); quarantined++; }

    // Daily reset of the send counter.
    if (n.last_reset !== DateTime.fromISO(todayIso).toISODate()) {
      patch.sent_today = 0;
      patch.last_reset = DateTime.fromISO(todayIso).toISODate();
    }

    await supabaseAdmin.from("phone_numbers").update(patch).eq("id", n.id);
    updated++;
  }
  return { updated, quarantined };
}
