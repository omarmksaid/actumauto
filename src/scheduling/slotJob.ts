/**
 * pg-boss job wrapper around the slotter (PLAN.md §4). Launching a campaign enqueues one
 * `slot-campaign` job; the worker computes due vehicles and creates coalesced touchpoints.
 * Kept separate from slotter.ts so the slotting logic stays free of queue concerns.
 */

import { supabaseAdmin } from "../lib/supabase";
import { slotCampaign } from "./slotter";

interface SlotJob { campaignId: string; windowDays: number; }

export function registerSlotJob(boss: any) {
  return boss.work("slot-campaign", { batchSize: 1 }, async ([job]: any) => {
    const { campaignId, windowDays } = job.data as SlotJob;
    const { data: campaign } = await supabaseAdmin
      .from("campaigns").select("id, company_id, status").eq("id", campaignId).maybeSingle();
    if (!campaign || campaign.status !== "active") return;

    const summary = await slotCampaign({
      companyId: campaign.company_id,
      campaignId,
      windowDays,
      todayIso: new Date().toISOString().slice(0, 10),
    });

    await supabaseAdmin.from("campaigns")
      .update({ pacing: { last_slot: summary } }).eq("id", campaignId);
  });
}
