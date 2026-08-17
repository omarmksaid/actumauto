/**
 * Service-due engine (PLAN.md §4).
 *
 * For a vehicle, project current mileage (anchored to mileage_as_of, not "now", using the
 * derived avg_miles_per_day) and age from sold_on. Find the minimum UNMET service interval —
 * whichever of mileage OR months comes first — and compute when that service is projected to
 * come due. The touchpoint is scheduled `window` days before that.
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

  // For each interval, compute the date it's projected to be reached; keep the earliest FUTURE one.
  // "Unmet" = we haven't passed it yet on the axis it triggers on.
  let best: { dueOn: DateTime; interval: ServiceInterval; reason: "mileage" | "months" } | null = null;

  for (const iv of intervals) {
    const candidates: { dueOn: DateTime; reason: "mileage" | "months" }[] = [];

    // Mileage axis.
    if (iv.mileage != null && rate > 0) {
      const milesRemaining = iv.mileage - mileageSinceService;
      if (milesRemaining > -rate * 30) {
        // include recently-passed (within ~a month) as "due now"
        const daysOut = Math.max(0, Math.round(milesRemaining / rate));
        candidates.push({ dueOn: today.plus({ days: daysOut }), reason: "mileage" });
      }
    }

    // Time axis.
    if (iv.months != null && monthsSinceAnchor != null) {
      const monthsRemaining = iv.months - monthsSinceAnchor;
      if (monthsRemaining > -1) {
        const dueOn = today.plus({ months: Math.max(0, monthsRemaining) });
        candidates.push({ dueOn, reason: "months" });
      }
    }

    for (const c of candidates) {
      if (!best || c.dueOn < best.dueOn) best = { dueOn: c.dueOn, interval: iv, reason: c.reason };
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
