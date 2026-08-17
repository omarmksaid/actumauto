/**
 * Derived average miles/day (PLAN.md §2 vehicles — the cold-start fix).
 *
 * Two-point case (real slope): if we have mileage at two known dates (e.g. sale→now, or
 * last-service→now), use the actual slope between them.
 *
 * One-point case (blend): with only a single (mileage, as-of) reading, the naive
 * `mileage / days_owned` is garbage for a car sold 4 months ago. Blend the observed rate with a
 * fleet prior (~32 mi/day), weighting the observed rate by ownership duration — a young car leans
 * on the prior; a 3-year-old car trusts its own history.
 */

import { DateTime } from "luxon";

const FLEET_PRIOR_MI_PER_DAY = 32;   // ~12k mi/yr
/** Ownership duration (days) at which we fully trust the observed rate. */
const FULL_TRUST_DAYS = 730;         // ~2 years

interface MileageInputs {
  mileage: number | null;
  soldOn: string | null;           // ISO date
  mileageAsOf: string | null;      // ISO date the odometer reading was taken
  lastServiceOn: string | null;
  mileageAtLastService: number | null;
}

function daysBetween(aIso: string, bIso: string): number | null {
  const a = DateTime.fromISO(aIso), b = DateTime.fromISO(bIso);
  if (!a.isValid || !b.isValid) return null;
  const d = b.diff(a, "days").days;
  return d > 0 ? d : null;
}

export function deriveAvgMilesPerDay(inp: MileageInputs): number | null {
  const asOf = inp.mileageAsOf ?? inp.soldOn;

  // Two-point: last service reading + current reading.
  if (
    inp.mileage != null && inp.mileageAtLastService != null &&
    inp.lastServiceOn && asOf
  ) {
    const days = daysBetween(inp.lastServiceOn, asOf);
    const deltaMi = inp.mileage - inp.mileageAtLastService;
    if (days && deltaMi > 0) return round(deltaMi / days);
  }

  // One-point: blend observed rate (from purchase) with the fleet prior by ownership duration.
  if (inp.mileage != null && inp.soldOn && asOf) {
    const days = daysBetween(inp.soldOn, asOf);
    if (days && inp.mileage > 0) {
      const observed = inp.mileage / days;
      const w = Math.min(1, days / FULL_TRUST_DAYS);  // trust weight for observed
      return round(w * observed + (1 - w) * FLEET_PRIOR_MI_PER_DAY);
    }
  }

  // No usable data → fall back to the prior so due-date projection still works.
  return FLEET_PRIOR_MI_PER_DAY;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
