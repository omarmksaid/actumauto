/**
 * Service-due engine (PLAN.md §4).
 *
 * For a vehicle, project current mileage (anchored to mileage_as_of, not "now", using the
 * derived avg_miles_per_day) and age from sold_on. Find the minimum UNMET service interval —
 * whichever of mileage OR months comes first — and compute when that service is projected to
 * come due. On an inbound call this answers "what is my car due for?" (§16d); `windowDays` is how
 * far ahead we still count something as "coming up".
 *
 * Schedule matching: a company-specific service_schedule wins over the platform-global default
 * (company_id null), matched by make (+ model if the schedule specifies one) and year range.
 */

import { DateTime } from "luxon";

export interface VehicleForDue {
  id: string;
  make: string;
  model: string;
  year: number;
  sold_on: string | null;
  mileage: number | null;
  mileage_as_of: string | null;
  last_service_on: string | null;
  mileage_at_last_service: number | null;
  avg_miles_per_day: number | null;
}

export interface ServiceInterval {
  mileage: number | null;
  months: number | null;
  service_name: string;
  operations: string[];
  severity: string;
}

export interface DueResult {
  vehicleId: string;
  dueOn: string;             // ISO date the next service is projected due
  scheduledAt: string;       // ISO datetime to place the touchpoint (dueOn - window)
  interval: ServiceInterval; // the specific service that's coming up
  projectedMileage: number;
  reason: "mileage" | "months";
}

const FLEET_PRIOR_MI_PER_DAY = 32;

/** Project a vehicle's mileage as of `asOfIso` (default: today). */
export function projectMileage(v: VehicleForDue, asOfIso: string): number {
  const rate = v.avg_miles_per_day ?? FLEET_PRIOR_MI_PER_DAY;
  const anchorMi = v.mileage ?? 0;
  const anchorDate = v.mileage_as_of ?? v.sold_on;
  if (!anchorDate) return anchorMi;
  const days = DateTime.fromISO(asOfIso).diff(DateTime.fromISO(anchorDate), "days").days;
  if (!(days > 0)) return anchorMi;
  return Math.round(anchorMi + rate * days);
}

/**
 * Compute the next due service. Returns null if we can't (no schedule, no intervals, or the
 * vehicle has no usable mileage/date anchor).
 *
 * `todayIso` is injected (no Date.now() in pure logic → testable + deterministic).
 * `windowDays` is how far before due to start reaching out (§11 open item; caller supplies).
 */
export function computeDue(
  v: VehicleForDue,
  intervals: ServiceInterval[],
  todayIso: string,
  windowDays: number
): DueResult | null {
  if (!intervals.length) return null;

  // No odometer AND no dates ⇒ we know nothing about this vehicle's usage. Returning a confident
  // due date here would put a fabricated recommendation in the agent's mouth on a live call, so
  // we return null and the agent simply doesn't recommend (see §16d).
  const hasMileageAnchor = v.mileage != null && (v.mileage_as_of != null || v.sold_on != null);
  const hasDateAnchor = v.last_service_on != null || v.sold_on != null;
  if (!hasMileageAnchor && !hasDateAnchor) return null;

  const rate = v.avg_miles_per_day ?? FLEET_PRIOR_MI_PER_DAY;
  const currentMileage = projectMileage(v, todayIso);
  const today = DateTime.fromISO(todayIso);

  // Baselines for "months since" — prefer last service, else purchase.
  const ageAnchor = v.last_service_on ?? v.sold_on;
  const monthsSinceAnchor = ageAnchor
    ? today.diff(DateTime.fromISO(ageAnchor), "months").months
    : null;
  const mileageSinceService =
    v.mileage_at_last_service != null ? currentMileage - v.mileage_at_last_service : currentMileage;

  // Maintenance intervals REPEAT: a 5,000-mile service is due at 5k, 10k, 15k… and the schedule
  // lists the milestone, not a one-time event. So for each interval we find the NEXT multiple of it
  // that the vehicle hasn't reached yet — otherwise a car 5,594 miles past its last service gets
  // told it needs the 5,000-mile service it already had.
  //
  // We keep the interval whose next occurrence lands soonest; ties prefer the more thorough
  // service (a 30k major service at the same odometer reading supersedes the 5k oil change).
  const SEVERITY_RANK: Record<string, number> = { standard: 0, major: 1, safety: 2 };
  let best: { dueOn: DateTime; interval: ServiceInterval; reason: "mileage" | "months" } | null = null;

  for (const iv of intervals) {
    const candidates: { dueOn: DateTime; reason: "mileage" | "months" }[] = [];

    // Mileage axis — next unmet multiple of this interval.
    if (iv.mileage != null && iv.mileage > 0 && rate > 0 && hasMileageAnchor) {
      const cyclesDone = Math.floor(mileageSinceService / iv.mileage);
      const nextAt = (cyclesDone + 1) * iv.mileage;
      const milesRemaining = nextAt - mileageSinceService;
      const daysOut = Math.max(0, Math.round(milesRemaining / rate));
      candidates.push({ dueOn: today.plus({ days: daysOut }), reason: "mileage" });
    }

    // Time axis — next unmet multiple, measured from the last service (or purchase).
    if (iv.months != null && iv.months > 0 && monthsSinceAnchor != null) {
      const cyclesDone = Math.floor(monthsSinceAnchor / iv.months);
      const nextAt = (cyclesDone + 1) * iv.months;
      const monthsRemaining = Math.max(0, nextAt - monthsSinceAnchor);
      candidates.push({ dueOn: today.plus({ months: monthsRemaining }), reason: "months" });
    }

    for (const c of candidates) {
      if (!best) { best = { dueOn: c.dueOn, interval: iv, reason: c.reason }; continue; }
      const diffDays = c.dueOn.diff(best.dueOn, "days").days;
      const moreSevere =
        (SEVERITY_RANK[iv.severity] ?? 0) > (SEVERITY_RANK[best.interval.severity] ?? 0);
      // Within a week, prefer the bigger service; otherwise strictly the earlier one.
      if (diffDays < 0 || (Math.abs(diffDays) <= 7 && moreSevere)) {
        best = { dueOn: c.dueOn, interval: iv, reason: c.reason };
      }
    }
  }

  if (!best) return null;

  const scheduledAt = best.dueOn.minus({ days: windowDays });
  return {
    vehicleId: v.id,
    dueOn: best.dueOn.toISODate()!,
    scheduledAt: (scheduledAt < today ? today : scheduledAt).toISO()!,
    interval: best.interval,
    projectedMileage: currentMileage,
    reason: best.reason,
  };
}
