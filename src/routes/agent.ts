/**
 * Authenticated dashboard API (PLAN.md §6, §16). companyId/userId come from requireAuth context —
 * never the body (§8 invariant 1).
 *
 * INBOUND-ONLY. The old outbound conversion funnel (slotted → dialed → answered → booked) is gone
 * with outbound dialing; "Today" now describes the calls that CAME IN.
 */

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";

export const agentRoutes = new Hono();

const cid = (c: any) => c.get("companyId") as string;

// ── Dashboard ───────────────────────────────────────────────────────────────
// Everything the service-line dashboard shows, for a selectable range: what came in, how much of
// it we recognized, what we booked, who is still waiting on a person, and what it cost.
agentRoutes.get("/funnel", async (c) => {
  const companyId = cid(c);
  const range = (c.req.query("range") ?? "1d").toLowerCase();

  const now = new Date();
  const DAY = 86400_000;
  // "1d" means today so far, not a rolling 24h — a service manager reads it as "today".
  const since =
    range === "1d" ? new Date(new Date().toDateString())
    : range === "1w" ? new Date(now.getTime() - 7 * DAY)
    : range === "1m" ? new Date(now.getTime() - 30 * DAY)
    : range === "ytd" ? new Date(now.getFullYear(), 0, 1)
    : new Date(0);                                    // "all"

  const [{ data: calls }, { data: appts }, { data: handoffs }] = await Promise.all([
    supabaseAdmin.from("calls")
      .select("customer_id, outcome, duration_sec, cost_usd, metadata, created_at")
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
  const totalCost = c_.reduce((s, x) => s + Number(x.cost_usd ?? 0), 0);

  // Bucket by hour for a single day, by day for anything longer — a 30-day hourly chart is noise.
  const byHour = range === "1d";
  const buckets = new Map<string, number>();
  if (byHour) for (let h = 0; h < 24; h++) buckets.set(String(h).padStart(2, "0"), 0);
  else if (range === "1w" || range === "1m") {
    const days = range === "1w" ? 7 : 30;
    for (let i = days - 1; i >= 0; i--) {
      buckets.set(new Date(now.getTime() - i * DAY).toISOString().slice(5, 10), 0);
    }
  } else {
    // ytd / all: bucket by MONTH. A daily axis over a year is unreadable, and pre-seeding every
    // day since epoch for "all" would be absurd — so months are derived from the data itself.
    const months = new Set<string>();
    for (const x of c_) months.add(String(x.created_at).slice(0, 7));
    [...months].sort().forEach((m) => buckets.set(m, 0));
  }
  for (const x of c_) {
    const d = new Date(x.created_at as string);
    const key = byHour ? String(d.getHours()).padStart(2, "0")
      : (range === "ytd" || range === "all") ? d.toISOString().slice(0, 7)
      : d.toISOString().slice(5, 10);
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
      cost_usd: Number(totalCost.toFixed(2)),
      cost_per_call: c_.length ? Number((totalCost / c_.length).toFixed(3)) : 0,
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
agentRoutes.get("/calls", async (c) => {
  const companyId = cid(c);
  const { data } = await supabaseAdmin
    .from("calls")
    .select("id, customer_id, vapi_call_id, from_number, duration_sec, outcome, cost_usd, created_at, customers(full_name, phone)")
    .eq("company_id", companyId).eq("direction", "inbound")
    .order("created_at", { ascending: false }).limit(100);
  return c.json({ calls: data ?? [] });
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
    .select("id, customer_id, recording_url, duration_sec, outcome, cost_usd, created_at, metadata, customers(full_name, phone, email)")
    .eq("id", id).eq("company_id", companyId).maybeSingle();
  if (!call) return c.json({ error: "not found" }, 404);

  const { data: turns } = await supabaseAdmin
    .from("transcripts").select("role, content, ts").eq("call_id", id).order("ts", { ascending: true });

  // If the recording lives in our Storage bucket, hand back a short-lived signed URL (§8 invariant 6).
  let recordingUrl = call.recording_url;
  if (recordingUrl && recordingUrl.startsWith("recordings/")) {
    const { data: signed } = await supabaseAdmin.storage
      .from("recordings").createSignedUrl(recordingUrl.replace(/^recordings\//, ""), 3600);
    recordingUrl = signed?.signedUrl ?? recordingUrl;
  }

  return c.json({ call: { ...call, recording_url: recordingUrl }, transcript: turns ?? [] });
});

// ── Customer Directory: search by phone / name / VIN ─────────────────────────
agentRoutes.get("/directory", async (c) => {
  const companyId = cid(c);
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ results: [] });
  const { data, error } = await supabaseAdmin.rpc("search_customers", { p_company_id: companyId, p_query: q });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ results: data ?? [] });
});

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
