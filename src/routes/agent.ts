/**
 * Authenticated dashboard API (PLAN.md §6). companyId/userId come from requireAuth context —
 * never the body (§8 invariant 1). Slice 4: funnel, calls + playback, customer directory.
 */

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";

export const agentRoutes = new Hono();

const cid = (c: any) => c.get("companyId") as string;

// ── Funnel (Today) ──────────────────────────────────────────────────────────
// called → booked → shown, plus in-flight/slotted and spam/other cancellations, per §6/§6b.
agentRoutes.get("/funnel", async (c) => {
  const companyId = cid(c);

  const [{ data: tps }, { data: appts }, { data: numbers }] = await Promise.all([
    supabaseAdmin.from("touchpoints").select("status, outcome, channel").eq("company_id", companyId),
    supabaseAdmin.from("appointments").select("status").eq("company_id", companyId),
    supabaseAdmin.from("phone_numbers")
      .select("e164, enabled, answer_rate_7d, health_score, quarantined_at, sent_today, daily_cap")
      .eq("company_id", companyId),
  ]);

  const t = tps ?? [];
  const calls = t.filter((x) => x.channel === "voice");
  const funnel = {
    slotted: t.filter((x) => x.status === "scheduled").length,
    in_flight: t.filter((x) => x.status === "in_flight").length,
    called: calls.filter((x) => ["completed", "in_flight"].includes(x.status)).length,
    answered: calls.filter((x) => x.outcome === "answered" || x.outcome === "booked").length,
    booked: calls.filter((x) => x.outcome === "booked").length,
    declined: calls.filter((x) => x.outcome === "declined").length,
    no_answer: calls.filter((x) => x.outcome === "no_answer").length,
    voicemail: calls.filter((x) => x.outcome === "voicemail_dropped").length,
    // "canceled due to spam/other issues" (§6 deliverability tile).
    spam_or_error: t.filter((x) =>
      x.status === "spam_blocked" || ["bad_number", "carrier_rejected", "provider_error"].includes(x.outcome ?? "")).length,
  };

  const appointments = {
    pending_confirmation: (appts ?? []).filter((a) => a.status === "pending_confirmation").length,
    confirmed: (appts ?? []).filter((a) => a.status === "confirmed").length,
    shown: (appts ?? []).filter((a) => a.status === "shown").length,   // the number the pitch is built on (§6b)
    no_show: (appts ?? []).filter((a) => a.status === "no_show").length,
  };

  return c.json({ funnel, appointments, numbers: numbers ?? [] });
});

// ── Calls list ───────────────────────────────────────────────────────────────
agentRoutes.get("/calls", async (c) => {
  const companyId = cid(c);
  const { data } = await supabaseAdmin
    .from("calls")
    .select("id, customer_id, vapi_call_id, duration_sec, outcome, cost_usd, created_at, customers(full_name, phone)")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(100);
  return c.json({ calls: data ?? [] });
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

  const [{ data: vehicles }, { data: recentCalls }, { data: recentMsgs }, { data: appts }] = await Promise.all([
    supabaseAdmin.from("vehicles")
      .select("id, make, model, year, mileage, mileage_as_of, avg_miles_per_day, last_service_on, vin, trim")
      .eq("customer_id", id),
    supabaseAdmin.from("calls")
      .select("id, outcome, duration_sec, created_at").eq("customer_id", id)
      .order("created_at", { ascending: false }).limit(5),
    supabaseAdmin.from("messages")
      .select("channel, direction, content, created_at").eq("customer_id", id)
      .order("created_at", { ascending: false }).limit(10),
    supabaseAdmin.from("appointments")
      .select("id, status, starts_at, preferred_time, created_at").eq("customer_id", id)
      .order("created_at", { ascending: false }).limit(5),
  ]);

  return c.json({
    customer, vehicles: vehicles ?? [],
    recentCalls: recentCalls ?? [], recentMessages: recentMsgs ?? [], appointments: appts ?? [],
  });
});
