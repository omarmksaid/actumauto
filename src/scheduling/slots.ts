/**
 * Appointment slotting (interim, until myKaarma owns availability).
 *
 * Callers speak times ("Friday at 10", "tomorrow morning"), not ISO timestamps. Storing that as
 * free text meant we could book six people into the same hour and only find out when they all
 * turned up. This resolves a spoken time against the dealership's real hours and existing
 * bookings, so the agent offers times the shop can actually take.
 *
 * Capacity is a concurrent-appointment count, NOT bay/technician modelling. It exists to stop
 * obvious double-booking, not to replace a scheduling system.
 */

import { supabaseAdmin } from "../lib/supabase";

export interface ShopConfig {
  timezone: string;
  hours: Record<string, [string, string] | null>;
  capacity: number;
  slotMinutes: number;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export async function loadShopConfig(companyId: string): Promise<ShopConfig> {
  const { data } = await supabaseAdmin
    .from("companies")
    .select("timezone, business_hours, concurrent_capacity, appointment_slot_minutes")
    .eq("id", companyId).maybeSingle();
  return {
    timezone: data?.timezone || "America/Los_Angeles",
    hours: (data?.business_hours ?? {}) as Record<string, [string, string] | null>,
    capacity: data?.concurrent_capacity ?? 4,
    slotMinutes: data?.appointment_slot_minutes ?? 30,
  };
}

/** Local wall-clock parts of an instant, in the shop's timezone. */
function localParts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(d).reduce((a: any, p) => (a[p.type] = p.value, a), {});
  return {
    date: `${f.year}-${f.month}-${f.day}`,
    hour: f.hour === "24" ? 0 : Number(f.hour),
    minute: Number(f.minute),
    dayKey: String(f.weekday).toLowerCase().slice(0, 3),
  };
}

/**
 * Turn a local date + minutes-since-midnight into a UTC instant.
 * Derived by probing the offset rather than assuming one — DST means a fixed offset is wrong
 * for half the year.
 */
function localToUtc(dateStr: string, minutes: number, tz: string): Date {
  const naive = new Date(`${dateStr}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00Z`);
  const p = localParts(naive, tz);
  const shownMinutes = p.hour * 60 + p.minute;
  const offset = shownMinutes - minutes;          // minutes the tz is ahead of UTC
  return new Date(naive.getTime() - offset * 60_000);
}

/** Open window for a given local date, as minutes since midnight. Null when closed. */
export function openWindow(cfg: ShopConfig, dateStr: string): [number, number] | null {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const key = localParts(probe, cfg.timezone).dayKey;
  const w = cfg.hours[key];
  if (!w || !Array.isArray(w)) return null;
  const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  return [toMin(w[0]), toMin(w[1])];
}

export interface Slot { startsAt: Date; endsAt: Date; label: string; }

/**
 * Bookable slots on a date, excluding ones already at capacity.
 * `durationMin` is the service's typical duration so a 2-hour job isn't offered at closing time.
 */
export async function availableSlots(
  companyId: string, cfg: ShopConfig, dateStr: string, durationMin: number, limit = 6
): Promise<Slot[]> {
  const window = openWindow(cfg, dateStr);
  if (!window) return [];
  const [open, close] = window;

  // Everything already on the books that day.
  const dayStart = localToUtc(dateStr, open, cfg.timezone);
  const dayEnd = localToUtc(dateStr, close, cfg.timezone);
  const { data: booked } = await supabaseAdmin
    .from("appointments")
    .select("starts_at, ends_at")
    .eq("company_id", companyId)
    .in("status", ["pending_confirmation", "confirmed", "in_service"])
    .not("starts_at", "is", null)
    .gte("starts_at", dayStart.toISOString())
    .lt("starts_at", dayEnd.toISOString());

  const existing = (booked ?? []).map((b: any) => ({
    s: new Date(b.starts_at).getTime(),
    e: new Date(b.ends_at ?? b.starts_at).getTime(),
  }));

  const out: Slot[] = [];
  const now = Date.now();
  for (let m = open; m + durationMin <= close && out.length < limit; m += cfg.slotMinutes) {
    const s = localToUtc(dateStr, m, cfg.timezone);
    const e = new Date(s.getTime() + durationMin * 60_000);
    if (s.getTime() <= now) continue;                       // never offer a time in the past
    const overlapping = existing.filter((x) => x.s < e.getTime() && x.e > s.getTime()).length;
    if (overlapping >= cfg.capacity) continue;
    out.push({ startsAt: s, endsAt: e, label: spokenTime(s, cfg.timezone) });
  }
  return out;
}

/** "Friday at 10:00 AM" — how the agent should say a slot out loud. */
export function spokenTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(d).replace(",", "");
}

/** Is a specific instant bookable? Returns why not, so the agent can explain. */
export async function checkSlot(
  companyId: string, cfg: ShopConfig, startsAt: Date, durationMin: number
): Promise<{ ok: boolean; reason?: string }> {
  if (startsAt.getTime() <= Date.now()) return { ok: false, reason: "that time has already passed" };

  const p = localParts(startsAt, cfg.timezone);
  const window = openWindow(cfg, p.date);
  if (!window) return { ok: false, reason: "we're closed that day" };

  const mins = p.hour * 60 + p.minute;
  if (mins < window[0] || mins + durationMin > window[1]) {
    return { ok: false, reason: "that's outside our opening hours" };
  }

  const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
  const { data: booked } = await supabaseAdmin
    .from("appointments")
    .select("starts_at, ends_at")
    .eq("company_id", companyId)
    .in("status", ["pending_confirmation", "confirmed", "in_service"])
    .not("starts_at", "is", null)
    .gte("starts_at", new Date(startsAt.getTime() - 4 * 3600_000).toISOString())
    .lte("starts_at", endsAt.toISOString());

  const overlapping = (booked ?? []).filter((b: any) => {
    const s = new Date(b.starts_at).getTime();
    const e = new Date(b.ends_at ?? b.starts_at).getTime();
    return s < endsAt.getTime() && e > startsAt.getTime();
  }).length;

  if (overlapping >= cfg.capacity) return { ok: false, reason: "we're fully booked then" };
  return { ok: true };
}

/** The appointment whose vehicle is in the shop right now, if any. */
export async function currentlyInService(companyId: string, customerId: string) {
  const { data } = await supabaseAdmin
    .from("appointments")
    .select("id, starts_at, ends_at, service_ops, status, checked_in_at, vehicles(year, make, model)")
    .eq("company_id", companyId).eq("customer_id", customerId)
    .eq("status", "in_service")
    .order("checked_in_at", { ascending: false })
    .limit(1).maybeSingle();
  return data ?? null;
}

/**
 * The soonest bookable slots, scanning forward day by day.
 *
 * `availableSlots` answers "what's open on this date", which is the wrong question when a caller
 * says "whenever you can take me" or "sometime next week" — the agent would have to guess a date,
 * and guessing a closed day gets it nothing. This walks real open days instead, so the first
 * result is genuinely the next available spot.
 *
 * `fromDate`/`days` let the agent look a week out for a caller who wants to plan ahead, without a
 * second round-trip per candidate date.
 */
export async function nextAvailableSlots(
  companyId: string, cfg: ShopConfig, fromDate: string, durationMin: number,
  days = 7, limit = 6
): Promise<{ date: string; slots: Slot[] }[]> {
  const out: { date: string; slots: Slot[] }[] = [];
  const cursor = new Date(`${fromDate}T12:00:00Z`);

  for (let i = 0; i < days && out.length < limit; i++) {
    const dateStr = cursor.toISOString().slice(0, 10);
    // Skip closed days silently — a caller doesn't need to hear which days we're shut.
    if (openWindow(cfg, dateStr)) {
      const slots = await availableSlots(companyId, cfg, dateStr, durationMin, 3);
      if (slots.length) out.push({ date: dateStr, slots });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}
