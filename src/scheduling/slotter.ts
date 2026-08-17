/**
 * Slotter (PLAN.md §4): turn due vehicles into touchpoints, coalesced at the CUSTOMER level.
 *
 * A household with two Toyotas both coming due must get ONE call covering both — not two calls
 * the same week. We compute each vehicle's due date, group a customer's due vehicles into a single
 * per-customer + window touchpoint (vehicle_ids[]), and use a window_bucket so the dedupe holds
 * even across separate campaign/import runs.
 *
 * This runs when a campaign is launched (or on a periodic re-slot). It only CREATES scheduled
 * touchpoints; the dispatch cron later claims and places them (§4b).
 */

import { DateTime } from "luxon";
import { supabaseAdmin } from "../lib/supabase";
import { computeDue, DueResult, VehicleForDue } from "./due";
import { loadIntervalsForVehicle } from "./schedules";

const VEHICLE_COLS =
  "id, make, model, year, sold_on, mileage, mileage_as_of, last_service_on, mileage_at_last_service, avg_miles_per_day";

export interface SlotOptions {
  companyId: string;
  campaignId: string;
  windowDays: number;       // service-due window (§11)
  todayIso: string;         // injected for determinism
}

export interface SlotSummary {
  customersConsidered: number;
  vehiclesDue: number;
  touchpointsCreated: number;
  skippedOptedOut: number;
}

/** Coarse fortnight bucket so two cars due within ~2 weeks of each other coalesce into one call. */
export function windowBucket(scheduledAtIso: string): string {
  const dt = DateTime.fromISO(scheduledAtIso);
  const fortnight = Math.floor((dt.ordinal - 1) / 14); // 0-based 2-week block within the year
  return `${dt.year}-w${fortnight}`;
}

export async function slotCampaign(opts: SlotOptions): Promise<SlotSummary> {
  const { companyId, campaignId, windowDays, todayIso } = opts;

  // Customers in scope for this campaign. (Targeting refinement lives in campaign.targeting later;
  // for now: all contactable customers of the dealership.)
  const { data: customers } = await supabaseAdmin
    .from("customers")
    .select("id, opted_out, do_not_contact")
    .eq("company_id", companyId);

  const summary: SlotSummary = {
    customersConsidered: customers?.length ?? 0,
    vehiclesDue: 0, touchpointsCreated: 0, skippedOptedOut: 0,
  };
  if (!customers?.length) return summary;

  for (const cust of customers) {
    if (cust.opted_out || cust.do_not_contact) { summary.skippedOptedOut++; continue; }

    const { data: vehicles } = await supabaseAdmin
      .from("vehicles").select(VEHICLE_COLS).eq("customer_id", cust.id);
    if (!vehicles?.length) continue;

    // Compute due for each vehicle; keep only those actually due within the horizon.
    const due: DueResult[] = [];
    for (const v of vehicles as VehicleForDue[]) {
      const intervals = await loadIntervalsForVehicle(companyId, v);
      const d = computeDue(v, intervals, todayIso, windowDays);
      if (d) due.push(d);
    }
    if (!due.length) continue;
    summary.vehiclesDue += due.length;

    // Coalesce: earliest scheduled_at drives the single touchpoint; it covers every due vehicle.
    due.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    const lead = due[0];
    const bucket = windowBucket(lead.scheduledAt);

    // Idempotent per (customer, window): skip if a live touchpoint already exists for this bucket.
    const { data: existing } = await supabaseAdmin
      .from("touchpoints")
      .select("id")
      .eq("customer_id", cust.id)
      .eq("window_bucket", bucket)
      .not("status", "in", "(canceled,failed)")
      .maybeSingle();
    if (existing) continue;

    const { error } = await supabaseAdmin.from("touchpoints").insert({
      company_id: companyId,
      customer_id: cust.id,
      vehicle_ids: due.map((d) => d.vehicleId),
      campaign_id: campaignId,
      channel: "voice",
      kind: "initial",
      scheduled_at: lead.scheduledAt,
      window_bucket: bucket,
      status: "scheduled",
      result: {
        due: due.map((d) => ({
          vehicle_id: d.vehicleId, due_on: d.dueOn, reason: d.reason,
          service: d.interval.service_name, projected_mileage: d.projectedMileage,
        })),
      },
    });
    if (!error) summary.touchpointsCreated++;
  }

  return summary;
}
