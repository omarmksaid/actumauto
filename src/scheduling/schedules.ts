/**
 * Service-schedule lookup (DB side of the due engine). Kept separate from due.ts so the
 * projection math stays pure and unit-testable without touching env/supabase.
 */

import { supabaseAdmin } from "../lib/supabase";
import type { ServiceInterval, VehicleForDue } from "./due";

/**
 * Best-matching intervals for a vehicle: a company-specific schedule wins over the platform-global
 * default (company_id null), matched by make (+ model if the schedule specifies one) and year range.
 */
export async function loadIntervalsForVehicle(
  companyId: string,
  v: Pick<VehicleForDue, "make" | "model" | "year">
): Promise<ServiceInterval[]> {
  const { data: schedules } = await supabaseAdmin
    .from("service_schedules")
    .select("id, company_id, make, model, year_from, year_to")
    .or(`company_id.eq.${companyId},company_id.is.null`)
    .ilike("make", v.make);

  if (!schedules?.length) return [];

  const matches = schedules.filter((s) => {
    if (s.model && s.model.toLowerCase() !== v.model.toLowerCase()) return false;
    if (s.year_from && v.year < s.year_from) return false;
    if (s.year_to && v.year > s.year_to) return false;
    return true;
  });
  if (!matches.length) return [];

  // Prefer company-specific + model-specific over global/any-model.
  matches.sort((a, b) => {
    const score = (s: any) => (s.company_id ? 2 : 0) + (s.model ? 1 : 0);
    return score(b) - score(a);
  });
  const chosen = matches[0];

  const { data: intervals } = await supabaseAdmin
    .from("service_intervals")
    .select("mileage, months, service_name, operations, severity")
    .eq("schedule_id", chosen.id)
    .order("mileage", { ascending: true });

  return (intervals ?? []) as ServiceInterval[];
}
