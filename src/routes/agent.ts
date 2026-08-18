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

// ── Today (inbound) ─────────────────────────────────────────────────────────
// What came in, how much of it we could identify, what we booked, and who is waiting on a human.
agentRoutes.get("/funnel", async (c) => {
  const companyId = cid(c);
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();

  const [{ data: calls }, { data: appts }, { data: handoffs }] = await Promise.all([
    supabaseAdmin.from("calls")
      .select("customer_id, outcome, duration_sec, cost_usd, metadata, created_at")
      .eq("company_id", companyId).eq("direction", "inbound").gte("created_at", since),
    supabaseAdmin.from("appointments").select("status").eq("company_id", companyId),
    supabaseAdmin.from("handoff_requests")
      .select("reason, status, transferred").eq("company_id", companyId),
  ]);

  const c_ = calls ?? [];
  const identified = c_.filter((x) => !!x.customer_id).length;
  const today = new Date().toISOString().slice(0, 10);

  const inbound = {
    calls_30d: c_.length,
    calls_today: c_.filter((x) => (x.created_at ?? "").slice(0, 10) === today).length,
    identified,
    anonymous: c_.length - identified,
    // >1 phone match — the shared-number case, which we deliberately treat as anonymous (§16a).
    ambiguous: c_.filter((x) => Number((x.metadata as any)?.match_count ?? 0) > 1).length,
    identify_rate: c_.length ? Number((identified / c_.length).toFixed(3)) : null,
    booked: c_.filter((x) => x.outcome === "booked").length,
    avg_duration_sec: c_.length
      ? Math.round(c_.reduce((s, x) => s + Number(x.duration_sec ?? 0), 0) / c_.length) : 0,
    cost_usd_30d: Number(c_.reduce((s, x) => s + Number(x.cost_usd ?? 0), 0).toFixed(2)),
  };

  const h = handoffs ?? [];
  const byReason: Record<string, number> = {};
  for (const row of h) byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;

  return c.json({
    inbound,
    appointments: {
      pending_confirmation: (appts ?? []).filter((a) => a.status === "pending_confirmation").length,
      confirmed: (appts ?? []).filter((a) => a.status === "confirmed").length,
      shown: (appts ?? []).filter((a) => a.status === "shown").length,
      no_show: (appts ?? []).filter((a) => a.status === "no_show").length,
    },
    handoffs: {
      total: h.length,
      open: h.filter((x) => x.status === "open").length,
      // Transfer never connected → an advisor owes this caller a callback.
      needs_callback: h.filter((x) => x.status === "open" && !x.transferred).length,
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
