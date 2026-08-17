/**
 * Pre-dial gate (PLAN.md §4b). Re-checked at dial time — NOT slot time — so a backed-up queue
 * can't fire a 10pm robocall or ignore a just-flipped kill switch. Every check that fails returns
 * a directive to revert the touchpoint to `scheduled` with the right startAfter; the attempt
 * counter is never consumed by a gate failure.
 */

import { DateTime } from "luxon";
import { supabaseAdmin } from "../lib/supabase";

export type GateResult =
  | { ok: true }
  | { ok: false; reason: string; retryAfterSec: number };

const HOUR = 3600;

interface GateContext {
  companyId: string;
  timezone: string;              // dealership timezone (fallback for recipient-local quiet hours)
  quietStart: string;            // "20:00"
  quietEnd: string;              // "09:00"
  channel: "voice" | "sms" | "email";
}

/** Runs all gates. First failure short-circuits with a retry hint. */
export async function preDialGate(ctx: GateContext): Promise<GateResult> {
  // 1. Global + dealership kill switch (kill switch is seconds-to-effect, §12c).
  const { data: global } = await supabaseAdmin
    .from("global_settings").select("global_dial_enabled, max_concurrent_calls, daily_spend_cap_usd, monthly_spend_cap_usd")
    .eq("id", true).maybeSingle();
  if (global && !global.global_dial_enabled) {
    return { ok: false, reason: "global_dial_disabled", retryAfterSec: HOUR };
  }
  const { data: company } = await supabaseAdmin
    .from("companies").select("dial_enabled").eq("id", ctx.companyId).maybeSingle();
  if (company && !company.dial_enabled) {
    return { ok: false, reason: "dealership_dial_disabled", retryAfterSec: HOUR };
  }

  // 2. Provider circuit (a tripped circuit holds, doesn't fail — §13).
  const providerKey = ctx.channel === "voice" ? "vapi" : ctx.channel === "sms" ? "telnyx_sms" : "resend";
  const { data: circuit } = await supabaseAdmin
    .from("provider_circuits").select("state, retry_after").eq("provider", providerKey).maybeSingle();
  if (circuit && circuit.state === "open") {
    const retryAfterSec = circuit.retry_after
      ? Math.max(60, Math.round((DateTime.fromISO(circuit.retry_after).toMillis() - Date.now()) / 1000))
      : 5 * 60;
    return { ok: false, reason: `circuit_open:${providerKey}`, retryAfterSec };
  }

  // 3. Recipient-local quiet hours (voice + sms only; email is fine anytime).
  if (ctx.channel !== "email") {
    const now = DateTime.now().setZone(ctx.timezone);
    if (inQuietHours(now, ctx.quietStart, ctx.quietEnd)) {
      return { ok: false, reason: "quiet_hours", retryAfterSec: secondsUntilQuietEnd(now, ctx.quietEnd) };
    }
  }

  // 4. Spend caps (the third cap layer). Daily + monthly.
  if (global) {
    const spend = await spendSoFar(ctx.companyId);
    if (spend.today >= global.daily_spend_cap_usd) {
      return { ok: false, reason: "daily_spend_cap", retryAfterSec: secondsUntilTomorrow(ctx.timezone) };
    }
    if (spend.month >= global.monthly_spend_cap_usd) {
      return { ok: false, reason: "monthly_spend_cap", retryAfterSec: 12 * HOUR };
    }
  }

  // 5. Live-call concurrency semaphore (voice only).
  if (ctx.channel === "voice" && global) {
    const { count } = await supabaseAdmin
      .from("touchpoints").select("id", { count: "exact", head: true })
      .eq("status", "in_flight").eq("channel", "voice");
    if ((count ?? 0) >= global.max_concurrent_calls) {
      return { ok: false, reason: "concurrency_cap", retryAfterSec: 120 };
    }
  }

  return { ok: true };
}

/** True if `now` (zoned) falls within a quiet window that may wrap past midnight. */
export function inQuietHours(now: DateTime, startHHmm: string, endHHmm: string): boolean {
  const mins = now.hour * 60 + now.minute;
  const s = hhmmToMin(startHHmm), e = hhmmToMin(endHHmm);
  return s <= e ? mins >= s && mins < e : mins >= s || mins < e; // wrap
}

function secondsUntilQuietEnd(now: DateTime, endHHmm: string): number {
  const e = hhmmToMin(endHHmm);
  let end = now.startOf("day").plus({ minutes: e });
  if (end <= now) end = end.plus({ days: 1 });
  return Math.max(60, Math.round(end.diff(now, "seconds").seconds));
}

function secondsUntilTomorrow(tz: string): number {
  const now = DateTime.now().setZone(tz);
  return Math.max(60, Math.round(now.plus({ days: 1 }).startOf("day").diff(now, "seconds").seconds));
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
}

async function spendSoFar(companyId: string): Promise<{ today: number; month: number }> {
  const now = DateTime.now();
  const dayStart = now.startOf("day").toISO()!;
  const monthStart = now.startOf("month").toISO()!;
  const { data } = await supabaseAdmin
    .from("cost_events").select("amount_usd, created_at")
    .eq("company_id", companyId).gte("created_at", monthStart);
  let today = 0, month = 0;
  for (const r of data ?? []) {
    month += Number(r.amount_usd);
    if (r.created_at >= dayStart) today += Number(r.amount_usd);
  }
  return { today, month };
}
