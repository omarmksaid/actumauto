/**
 * Authenticated dashboard API (PLAN.md §6, §16). companyId/userId come from requireAuth context —
 * never the body (§8 invariant 1).
 *
 * INBOUND-ONLY. The old outbound conversion funnel (slotted → dialed → answered → booked) is gone
 * with outbound dialing; "Today" now describes the calls that CAME IN.
 */

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";
import { env } from "../lib/env";

/**
 * Ask Vapi for a playable recording URL. The webhook's `recordingUrl` points at private R2 and
 * returns 400 to a browser; only the presigned variant streams. It expires within hours, which is
 * why we fetch on demand instead of persisting it.
 *
 * Stereo is preferred: channel 0 is the assistant and channel 1 the customer, which lets the
 * player draw them as separate tracks — you can see who talked over whom at a glance.
 */
async function vapiPresignedRecording(vapiCallId: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.vapi.ai/call/${vapiCallId}`, {
      headers: { Authorization: `Bearer ${env.VAPI_API_KEY}` },
    });
    if (!r.ok) return null;
    const a = (await r.json())?.artifact ?? {};
    return a.presignedStereoUrl ?? a.presignedMonoUrl ?? null;
  } catch {
    return null;   // playback is a nice-to-have; never fail the page over it
  }
}

export const agentRoutes = new Hono();

const cid = (c: any) => c.get("companyId") as string;

// ── Who am I ────────────────────────────────────────────────────────────────
// The frontend needs the role to disable controls an advisor can't use. Server-side checks stay
// authoritative (requireAdmin); this only prevents showing buttons that would 403.
agentRoutes.get("/me", async (c) => {
  return c.json({ role: (c as any).get("role") ?? "advisor", companyId: cid(c) });
});

// ── Dashboard ───────────────────────────────────────────────────────────────
// Everything the service-line dashboard shows, for a selectable range: what came in, how much of
// it we recognized, what we booked, who is still waiting on a person, and what it cost.
agentRoutes.get("/funnel", async (c) => {
  const companyId = cid(c);
  const range = (c.req.query("range") ?? "1d").toLowerCase();

  // Everything below is bucketed in the DEALERSHIP's timezone, not the server's. Railway runs
  // UTC, so server-local hours would file a 7pm Pacific call under 02:00 the NEXT day — the
  // chart silently shows the wrong hours, and "today" starts at 5pm.
  const { data: company } = await supabaseAdmin
    .from("companies").select("timezone").eq("id", companyId).maybeSingle();
  const tz = company?.timezone || "America/Los_Angeles";

  /** Local wall-clock parts of an instant, in the dealership's timezone. */
  const parts = (d: Date) => {
    const f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
    }).formatToParts(d).reduce((a: any, p) => (a[p.type] = p.value, a), {});
    return { date: `${f.year}-${f.month}-${f.day}`, hour: f.hour === "24" ? "00" : f.hour };
  };

  const now = new Date();
  const DAY = 86400_000;
  // "1d" means today so far, not a rolling 24h — a service manager reads it as "today".
  // Midnight *in the dealership's timezone*, expressed as an instant.
  const localMidnight = () => {
    const today = parts(now).date;
    for (let guess = 0; guess < 48; guess++) {
      const t = new Date(now.getTime() - guess * 3600_000);
      if (parts(t).date !== today) return new Date(t.getTime() + 3600_000);
    }
    return new Date(now.getTime() - 24 * 3600_000);
  };

  const since =
    range === "1d" ? localMidnight()
    : range === "1w" ? new Date(now.getTime() - 7 * DAY)
    : range === "1m" ? new Date(now.getTime() - 30 * DAY)
    : range === "ytd" ? new Date(now.getFullYear(), 0, 1)
    : new Date(0);                                    // "all"

  const [{ data: calls }, { data: appts }, { data: handoffs }] = await Promise.all([
    supabaseAdmin.from("calls")
      .select("customer_id, outcome, duration_sec, metadata, created_at")
      .eq("company_id", companyId).eq("direction", "inbound")
      .gte("created_at", since.toISOString()),
    supabaseAdmin.from("appointments")
      .select("status, created_at").eq("company_id", companyId)
      .gte("created_at", since.toISOString()),
    supabaseAdmin.from("handoff_requests")
      .select("reason, status, transferred, created_at").eq("company_id", companyId),
  ]);

  const c_ = calls ?? [];
  const identified = c_.filter((x) => !!x.customer_id).length;
  const answered = c_.filter((x) => (x.duration_sec ?? 0) > 0);

  // Bucket by hour for a single day, by day for anything longer — a 30-day hourly chart is noise.
  const byHour = range === "1d";
  const buckets = new Map<string, number>();
  if (byHour) for (let h = 0; h < 24; h++) buckets.set(String(h).padStart(2, "0"), 0);
  else if (range === "1w" || range === "1m") {
    const days = range === "1w" ? 7 : 30;
    for (let i = days - 1; i >= 0; i--) {
      buckets.set(parts(new Date(now.getTime() - i * DAY)).date.slice(5), 0);
    }
  } else {
    // ytd / all: bucket by MONTH. A daily axis over a year is unreadable, and pre-seeding every
    // day since epoch for "all" would be absurd — so months are derived from the data itself.
    const months = new Set<string>();
    for (const x of c_) months.add(parts(new Date(x.created_at as string)).date.slice(0, 7));
    [...months].sort().forEach((m) => buckets.set(m, 0));
  }
  for (const x of c_) {
    const p = parts(new Date(x.created_at as string));
    const key = byHour ? p.hour
      : (range === "ytd" || range === "all") ? p.date.slice(0, 7)
      : p.date.slice(5);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  const h = handoffs ?? [];
  const inRange = h.filter((x) => new Date(x.created_at as string) >= since);
  const byReason: Record<string, number> = {};
  for (const row of inRange) byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;

  // Open handoffs are deliberately NOT range-filtered: someone waiting since yesterday is still
  // waiting, and hiding them behind a "today" filter is how a caller gets forgotten.
  const open = h.filter((x) => x.status === "open");
  const oldestOpen = open.length
    ? Math.round((now.getTime() - Math.min(...open.map((x) => new Date(x.created_at as string).getTime()))) / 60_000)
    : null;

  const a = appts ?? [];
  return c.json({
    range,
    inbound: {
      calls: c_.length,
      identified,
      anonymous: c_.length - identified,
      // >1 phone match — the shared-number case, deliberately treated as anonymous (§16a).
      ambiguous: c_.filter((x) => Number((x.metadata as any)?.match_count ?? 0) > 1).length,
      identify_rate: c_.length ? Number((identified / c_.length).toFixed(3)) : null,
      booked: c_.filter((x) => x.outcome === "booked").length,
      // Averaged over ANSWERED calls only — failed connections would drag it to nonsense.
      avg_duration_sec: answered.length
        ? Math.round(answered.reduce((s, x) => s + Number(x.duration_sec ?? 0), 0) / answered.length) : 0,
    },
    volume: [...buckets.entries()].map(([label, count]) => ({ label, count })),
    appointments: {
      pending_confirmation: a.filter((x) => x.status === "pending_confirmation").length,
      confirmed: a.filter((x) => x.status === "confirmed").length,
      shown: a.filter((x) => x.status === "shown").length,
      no_show: a.filter((x) => x.status === "no_show").length,
    },
    handoffs: {
      total: inRange.length,
      open: open.length,
      oldest_open_min: oldestOpen,
      // Transfer never connected → an advisor owes this caller a callback.
      needs_callback: open.filter((x) => !x.transferred).length,
      failed_transfers: inRange.filter((x) => !x.transferred).length,
      by_reason: byReason,
    },
  });
});

// ── Calls list ───────────────────────────────────────────────────────────────
// Returns everything the calls view renders: who called, what happened, and — for calls that
// never connected — a reason derived from Vapi's endedReason, plus repeat-attempt grouping.
agentRoutes.get("/calls", async (c) => {
  const companyId = cid(c);
  const q = (c.req.query("q") ?? "").trim();

  let query = supabaseAdmin
    .from("calls")
    .select("id, customer_id, vapi_call_id, from_number, duration_sec, outcome, recording_url, metadata, created_at, customers(full_name, phone)")
    .eq("company_id", companyId).eq("direction", "inbound");

  if (q) {
    // Search by number (digits only, so formatting doesn't matter) or by customer name.
    const digits = q.replace(/\D/g, "");
    const { data: named } = await supabaseAdmin
      .from("customers").select("id").eq("company_id", companyId).ilike("full_name", `%${q}%`);
    const ids = (named ?? []).map((x) => x.id);
    const clauses = [digits.length >= 3 ? `from_number.ilike.%${digits}%` : null,
                     ids.length ? `customer_id.in.(${ids.join(",")})` : null].filter(Boolean);
    if (!clauses.length) return c.json({ calls: [] });
    query = query.or(clauses.join(","));
  }

  const { data } = await query.order("created_at", { ascending: false }).limit(200);
  const rows = data ?? [];

  // Handoff reason per call — what makes "handed off · pricing" possible.
  const ids = rows.map((r) => r.id);
  const { data: handoffs } = ids.length
    ? await supabaseAdmin.from("handoff_requests").select("call_id, reason").in("call_id", ids)
    : { data: [] };
  const reasonByCall = new Map((handoffs ?? []).map((h) => [h.call_id, h.reason]));

  const calls = rows.map((r) => {
    const md = (r.metadata ?? {}) as any;
    const dur = r.duration_sec ?? 0;
    const ended = String(md.endedReason ?? "");
    const handoff = reasonByCall.get(r.id) ?? null;

    // A call that never produced audio is "missed". Vapi's endedReason explains WHY, which is the
    // difference between "the caller hung up" and "our pipeline broke" — worth distinguishing,
    // because one is a customer behaviour and the other is an outage.
    let status: string, detail: string | null = null;
    if (r.outcome === "booked") { status = "booked"; }
    else if (handoff) { status = "handed off"; detail = handoff; }
    else if (dur > 0) { status = "answered"; }
    else {
      status = "missed";
      detail = /pipeline-error/.test(ended) ? "call failed"
        : /customer-did-not-answer|no-answer/.test(ended) ? "no connect"
        : /customer-ended|hangup/.test(ended) ? "hung up <2s"
        : ended ? ended.replace(/-/g, " ") : "no connect";
    }

    return {
      id: r.id,
      customer_id: r.customer_id,
      name: (r.customers as any)?.full_name ?? null,
      phone: r.from_number ?? (r.customers as any)?.phone ?? null,
      status, detail,
      duration_sec: dur,
      has_recording: !!r.recording_url,
      created_at: r.created_at,
    };
  });

  // Collapse repeat attempts: same number, back-to-back misses within 10 minutes read as one
  // frustrated caller redialing, not four separate events.
  const collapsed: any[] = [];
  for (const call of calls) {
    const prev = collapsed[collapsed.length - 1];
    const gapMin = prev
      ? (new Date(prev.created_at).getTime() - new Date(call.created_at).getTime()) / 60_000 : Infinity;
    if (prev && prev.status === "missed" && call.status === "missed" &&
        prev.phone === call.phone && gapMin <= 10) {
      prev.attempts = (prev.attempts ?? 1) + 1;
      prev.attempt_span_min = Math.max(1, Math.round(
        (new Date(prev.created_at).getTime() - new Date(call.created_at).getTime()) / 60_000));
      continue;
    }
    collapsed.push({ ...call, attempts: 1 });
  }

  const counts = {
    all: collapsed.length,
    answered: collapsed.filter((x) => x.status === "answered").length,
    missed: collapsed.filter((x) => x.status === "missed").length,
    "handed off": collapsed.filter((x) => x.status === "handed off").length,
    booked: collapsed.filter((x) => x.status === "booked").length,
  };

  return c.json({ calls: collapsed, counts });
});

// ── Appointment calendar ────────────────────────────────────────────────────
// Day view for the shop. Appointments with a resolved starts_at are placed on the timeline;
// ones captured as free text ("Friday morning") are returned separately as unscheduled, because
// silently dropping them would hide real bookings an advisor still has to place.
agentRoutes.get("/calendar", async (c) => {
  const companyId = cid(c);
  const dateParam = (c.req.query("date") ?? "").trim();
  const view = c.req.query("view") === "day" ? "day" : "week";

  const { data: co } = await supabaseAdmin
    .from("companies").select("timezone, business_hours, concurrent_capacity")
    .eq("id", companyId).maybeSingle();
  const tz = co?.timezone || "America/Los_Angeles";

  /** The local calendar date of an instant, in the DEALERSHIP's timezone. */
  const localDay = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(d);
  const localDow = (d: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d).toLowerCase().slice(0, 3);

  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
    ? new Date(`${dateParam}T12:00:00Z`)     // midday avoids the date shifting under any offset
    : new Date();
  const anchorDay = localDay(anchor);

  // Build the visible days by walking calendar days, never by adding 24h to a timestamp — a DST
  // transition makes one day 23 or 25 hours long and would silently drop or duplicate a day.
  const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const days: string[] = [];
  if (view === "day") days.push(anchorDay);
  else {
    let cursor = new Date(anchor);
    while (localDow(cursor) !== "sun") cursor = new Date(cursor.getTime() - 86400_000);
    for (let i = 0; i < 7; i++) {
      days.push(localDay(cursor));
      cursor = new Date(cursor.getTime() + 86400_000);
    }
  }

  // Query bounds: ±36h around the visible range, so no appointment near a local midnight is
  // missed regardless of offset. Exact membership is decided by local day below.
  const from = new Date(`${days[0]}T00:00:00Z`);
  from.setUTCHours(from.getUTCHours() - 36);
  const to = new Date(`${days[days.length - 1]}T23:59:59Z`);
  to.setUTCHours(to.getUTCHours() + 36);

  const COLS = "id, starts_at, ends_at, status, preferred_time, service_ops, drop_off, checked_in_at, notes, customer_id, customers(full_name, phone), vehicles(year, make, model)";

  const [{ data: timed }, { data: untimed }] = await Promise.all([
    supabaseAdmin.from("appointments").select(COLS)
      .eq("company_id", companyId).not("status", "in", "(canceled)")
      .gte("starts_at", from.toISOString()).lte("starts_at", to.toISOString())
      .order("starts_at", { ascending: true }).limit(500),
    // Separate query: a range filter on starts_at excludes NULLs, which would hide exactly the
    // appointments that still need a human to place them.
    supabaseAdmin.from("appointments").select(COLS)
      .eq("company_id", companyId).in("status", ["pending_confirmation", "confirmed"])
      .is("starts_at", null).order("created_at", { ascending: true }).limit(100),
  ]);

  const shape = (a: any) => ({
    id: a.id, starts_at: a.starts_at, ends_at: a.ends_at, status: a.status,
    preferred_time: a.preferred_time, drop_off: a.drop_off, checked_in_at: a.checked_in_at,
    notes: a.notes, customer_id: a.customer_id,
    customer: a.customers?.full_name ?? null,
    phone: a.customers?.phone ?? null,
    vehicle: a.vehicles ? `${a.vehicles.year} ${a.vehicles.make} ${a.vehicles.model}` : null,
    ops: a.service_ops?.ops ?? [],
    // Local wall-clock, computed server-side so every client agrees.
    local_day: a.starts_at ? localDay(new Date(a.starts_at)) : null,
    local_time: a.starts_at
      ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
          .format(new Date(a.starts_at))
      : null,
  });

  const rows = (timed ?? []).map(shape);
  const hours = (co?.business_hours ?? {}) as Record<string, [string, string] | null>;

  return c.json({
    view,
    days: days.map((day) => {
      const dow = DOW[new Date(`${day}T12:00:00Z`).getUTCDay()];
      return {
        date: day,
        weekday: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" })
          .format(new Date(`${day}T12:00:00Z`)),
        closed: !hours[dow],
        appointments: rows.filter((r) => r.local_day === day),
      };
    }),
    timezone: tz,
    capacity: co?.concurrent_capacity ?? 4,
    today: localDay(new Date()),
    unscheduled: (untimed ?? []).map(shape),
    total: rows.length,
  });
});

/** Advisor actions: check a vehicle in, or mark the work complete. */
agentRoutes.patch("/appointments/:id", async (c) => {
  const companyId = cid(c);
  const b = await c.req.json<any>().catch(() => ({}));
  const patch: any = {};

  // Move the visit to right now AND check it in. Demoing the "your car is with us" greeting
  // otherwise means editing timestamps by hand: the agent only says it when something is
  // in_service, and an appointment sitting in next week's calendar reads as stale to everyone
  // looking at it. One action so the calendar and the phone agent agree.
  if (b.action === "start_now") {
    const now = new Date();
    patch.status = "in_service";
    patch.checked_in_at = now.toISOString();
    patch.starts_at = now.toISOString();
    patch.ends_at = new Date(now.getTime() + 45 * 60_000).toISOString();
  }
  else if (b.action === "check_in") { patch.status = "in_service"; patch.checked_in_at = new Date().toISOString(); }
  else if (b.action === "complete") { patch.status = "shown"; patch.completed_at = new Date().toISOString(); patch.shown_at = new Date().toISOString(); }
  else if (b.action === "confirm") { patch.status = "confirmed"; }
  else if (b.action === "cancel") { patch.status = "canceled"; patch.canceled_at = new Date().toISOString(); }
  else if (b.action === "no_show") { patch.status = "no_show"; }
  // Put a finished or cancelled visit back on the board — lets the same appointment drive the
  // demo more than once instead of accumulating throwaway rows.
  else if (b.action === "reopen") {
    patch.status = "confirmed";
    patch.checked_in_at = null; patch.completed_at = null; patch.shown_at = null; patch.canceled_at = null;
  }
  else return c.json({ error: "unknown action" }, 422);

  const { data, error } = await supabaseAdmin.from("appointments")
    .update(patch).eq("id", c.req.param("id")).eq("company_id", companyId).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json({ appointment: data });
});

// ── Recording archive health ────────────────────────────────────────────────
// Surfaced because the dangerous failure is a SILENT one: believing you have audio you don't.
agentRoutes.get("/archive/status", async (c) => {
  const companyId = cid(c);
  const { data } = await supabaseAdmin
    .from("calls").select("archive_status, recording_bytes, recording_expires_at, archive_error")
    .eq("company_id", companyId);
  const rows = data ?? [];
  const by: Record<string, number> = {};
  for (const r of rows) by[r.archive_status] = (by[r.archive_status] ?? 0) + 1;
  const bytes = rows.reduce((s, r) => s + Number(r.recording_bytes ?? 0), 0);
  const soonest = rows
    .filter((r) => r.recording_expires_at)
    .map((r) => r.recording_expires_at as string).sort()[0] ?? null;

  const { data: co } = await supabaseAdmin
    .from("companies").select("recording_retention_days").eq("id", companyId).maybeSingle();

  return c.json({
    by_status: by,
    stored_mb: Number((bytes / 1048576).toFixed(1)),
    retention_days: co?.recording_retention_days ?? 180,
    next_expiry: soonest,
    failures: rows.filter((r) => r.archive_status === "failed")
      .map((r) => r.archive_error).filter(Boolean).slice(0, 5),
  });
});

// ── Handoff queue (§16b) — callers the agent sent to a human ─────────────────
agentRoutes.get("/handoffs", async (c) => {
  const companyId = cid(c);
  const status = c.req.query("status") ?? "open";
  let q = supabaseAdmin
    .from("handoff_requests")
    .select("id, call_id, customer_id, caller_number, reason, vehicle_hint, notes, transferred, status, created_at, customers(full_name, phone)")
    .eq("company_id", companyId);
  if (status !== "all") q = q.eq("status", status);
  const { data } = await q.order("created_at", { ascending: false }).limit(100);
  return c.json({ handoffs: data ?? [] });
});

agentRoutes.patch("/handoffs/:id", async (c) => {
  const companyId = cid(c);
  const b = await c.req.json<any>().catch(() => ({}));
  const status = b.status === "resolved" ? "resolved" : "open";
  const { data, error } = await supabaseAdmin.from("handoff_requests")
    .update({ status, resolved_at: status === "resolved" ? new Date().toISOString() : null })
    .eq("id", c.req.param("id")).eq("company_id", companyId).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json({ handoff: data });
});

// ── One call: transcript turns + a signed recording URL ──────────────────────
agentRoutes.get("/calls/:id", async (c) => {
  const companyId = cid(c);
  const id = c.req.param("id");

  const { data: call } = await supabaseAdmin
    .from("calls")
    .select("id, customer_id, vapi_call_id, recording_url, recording_path, archive_status, duration_sec, outcome, created_at, metadata, customers(full_name, phone, email)")
    .eq("id", id).eq("company_id", companyId).maybeSingle();
  if (!call) return c.json({ error: "not found" }, 404);

  const { data: turns } = await supabaseAdmin
    .from("transcripts").select("role, content, ts").eq("call_id", id).order("ts", { ascending: true });

  // Recording URL. Vapi stores audio in private R2 — the `recordingUrl` it sends in the webhook
  // is NOT publicly fetchable (400), so playing it directly fails silently in an <audio> tag.
  // The playable form is `artifact.presignedMonoUrl`, which expires in hours, so it has to be
  // fetched fresh per view rather than stored.
  // Prefer OUR archived copy: it outlives Vapi's retention and is the system of record. Fall
  // back to a presigned Vapi URL while a call is still waiting to be archived.
  let recordingUrl: string | null = null;
  const archivedPath = (call as any).recording_path;
  if (archivedPath) {
    const { data: signed } = await supabaseAdmin.storage
      .from("recordings").createSignedUrl(archivedPath, 3600);
    recordingUrl = signed?.signedUrl ?? null;
  }
  if (!recordingUrl && call.recording_url && (call as any).vapi_call_id && env.VAPI_API_KEY) {
    recordingUrl = await vapiPresignedRecording((call as any).vapi_call_id);
  }
  recordingUrl = recordingUrl ?? null;

  return c.json({ call: { ...call, recording_url: recordingUrl }, transcript: turns ?? [] });
});

// ── Customer Directory: search by phone / name / VIN ─────────────────────────
agentRoutes.get("/directory", async (c) => {
  const companyId = cid(c);
  const q = (c.req.query("q") ?? "").trim();

  // An empty search used to return nothing, so the directory looked empty until you guessed a
  // name. Default to listing everyone alphabetically — browsing is the common case.
  if (!q) {
    const { data, error } = await supabaseAdmin
      .from("customers")
      .select("id, full_name, phone, email, customer_type, vehicles(id, year, make, model, mileage)")
      .eq("company_id", companyId)
      .order("full_name", { ascending: true })
      .limit(200);
    if (error) return c.json({ error: error.message }, 500);
    return c.json({ results: (data ?? []).map(toDirectoryRow), total: data?.length ?? 0 });
  }

  // The RPC returns a vehicle COUNT; the tiles show actual cars, so hydrate them for the matches.
  const { data, error } = await supabaseAdmin.rpc("search_customers", { p_company_id: companyId, p_query: q });
  if (error) return c.json({ error: error.message }, 500);
  const ids = (data ?? []).map((r: any) => r.customer_id);
  if (!ids.length) return c.json({ results: [] });

  const { data: full } = await supabaseAdmin
    .from("customers")
    .select("id, full_name, phone, email, customer_type, vehicles(id, year, make, model, mileage)")
    .in("id", ids)
    .order("full_name", { ascending: true });
  return c.json({ results: (full ?? []).map(toDirectoryRow) });
});

/** One directory tile's worth of data. Vehicles are capped — a fleet customer shouldn't render 40. */
function toDirectoryRow(r: any) {
  const vehicles = (r.vehicles ?? []).map((v: any) => ({
    id: v.id, year: v.year, make: v.make, model: v.model, mileage: v.mileage,
  }));
  return {
    customer_id: r.id,
    full_name: r.full_name,
    phone: r.phone,
    email: r.email,
    customer_type: r.customer_type,
    vehicle_count: vehicles.length,
    vehicles: vehicles.slice(0, 4),
  };
}

// ── One customer: profile + vehicles + upcoming service + recent conversations ─
agentRoutes.get("/customers/:id", async (c) => {
  const companyId = cid(c);
  const id = c.req.param("id");

  const { data: customer } = await supabaseAdmin
    .from("customers")
    .select("id, full_name, phone, email, customer_type, tags, detected_language, personality, notes, opted_out, do_not_contact")
    .eq("id", id).eq("company_id", companyId).maybeSingle();
  if (!customer) return c.json({ error: "not found" }, 404);

  const [{ data: vehicles }, { data: recentCalls }, { data: appts }] = await Promise.all([
    supabaseAdmin.from("vehicles")
      .select("id, make, model, year, mileage, mileage_as_of, avg_miles_per_day, last_service_on, vin, trim")
      .eq("customer_id", id),
    supabaseAdmin.from("calls")
      .select("id, outcome, duration_sec, created_at").eq("customer_id", id)
      .order("created_at", { ascending: false }).limit(5),
    supabaseAdmin.from("appointments")
      .select("id, status, starts_at, preferred_time, created_at").eq("customer_id", id)
      .order("created_at", { ascending: false }).limit(5),
  ]);

  return c.json({
    customer, vehicles: vehicles ?? [],
    recentCalls: recentCalls ?? [], appointments: appts ?? [],
  });
});
