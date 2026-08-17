/**
 * Number-pool warm-up ramp + answer-rate health (PLAN.md §2 number pool).
 *
 * 400/day on an UNWARMED number gets it spam-flagged in days, so new numbers ramp their effective
 * cap over ~2 weeks. And since carriers don't report spam-labeling back to us, the shipping signal
 * is answer-rate DECAY: a sharp drop is the leading indicator, so it lowers health and can
 * auto-quarantine. (Pure helpers here; the cron that reads/writes the DB lives in job.ts.)
 */

import { DateTime } from "luxon";

/** Ramp curve: effective daily cap as a function of days since the number entered the pool. */
export function rampCap(rampStartedOn: string | null, fullCap: number, todayIso: string): number {
  if (!rampStartedOn) return fullCap;
  const days = Math.floor(DateTime.fromISO(todayIso).diff(DateTime.fromISO(rampStartedOn), "days").days);
  if (days < 0) return 0;
  if (days < 3) return Math.min(fullCap, 20);
  if (days < 6) return Math.min(fullCap, 50);
  if (days < 10) return Math.min(fullCap, 150);
  if (days < 14) return Math.min(fullCap, 300);
  return fullCap;
}

export interface OutcomeCounts { answered: number; total: number; }

/** Answer rate over a set of recent voice outcomes. null when there's not enough signal. */
export function answerRate(counts: OutcomeCounts): number | null {
  if (counts.total < 10) return null; // too few to be meaningful
  return Number((counts.answered / counts.total).toFixed(3));
}

/**
 * Health score in [0,1] from the current 7-day answer rate vs. a recent baseline. A sharp DROP
 * (decay) is what matters — a number that used to answer 40% and now answers 20% is being flagged.
 */
export function healthScore(rate7d: number | null, baselineRate: number | null): number | null {
  if (rate7d == null) return null;
  if (baselineRate == null || baselineRate <= 0) return clamp01(rate7d / 0.35); // no baseline: judge vs. a ~35% norm
  const ratio = rate7d / baselineRate;
  return clamp01(ratio); // 1.0 = holding steady; <1 = decaying
}

/** Auto-quarantine when the answer rate has dropped ≥ this fraction vs. baseline (a 20% drop). */
export function shouldQuarantine(rate7d: number | null, baselineRate: number | null): boolean {
  if (rate7d == null || baselineRate == null || baselineRate <= 0) return false;
  return rate7d <= baselineRate * 0.8;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number(n.toFixed(3))));
}
