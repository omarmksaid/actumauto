/**
 * Settings + number-pool API (PLAN.md §6 Settings). companyId from requireAuth context.
 * Mutations require owner/admin (requireAdmin). Reads are open to any member.
 *
 *  GET  /settings                 cadence + company voice/persona/customer-types
 *  PUT  /settings                 update cadence + company.settings          [admin]
 *  GET  /settings/numbers         the dealership's number pool (with ramped cap)
 *  POST /settings/numbers         add a number                                [admin]
 *  PATCH/DELETE /settings/numbers/:id  update / remove a number               [admin]
 */

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";
import { requireAdmin } from "../lib/auth";
import { rampCap } from "../numbers/health";

export const settingsRoutes = new Hono();
const cid = (c: any) => c.get("companyId") as string;

// ── Settings (cadence + company voice/persona/customer-types) ────────────────
settingsRoutes.get("/", async (c) => {
  const companyId = cid(c);
  const [{ data: cadence }, { data: company }] = await Promise.all([
    supabaseAdmin.from("cadences").select("*").eq("company_id", companyId).limit(1).maybeSingle(),
    supabaseAdmin.from("companies").select("name, timezone, settings").eq("id", companyId).single(),
  ]);
  const settings = (company?.settings ?? {}) as any;
  return c.json({
    cadence: cadence ?? null,
    company: { name: company?.name, timezone: company?.timezone },
    voice: settings.voice ?? { provider: "cartesia", voice_id: "" },
    persona_prompt: settings.persona_prompt ?? "",
    customer_types: settings.customer_types ?? ["loyal", "lapsed", "new", "vip"],
  });
});

settingsRoutes.put("/", requireAdmin, async (c) => {
  const companyId = cid(c);
  const body = await c.req.json<any>();

  if (body.cadence) {
    const cad = body.cadence;
    const allowed = {
      no_answer_retry_after_min: cad.no_answer_retry_after_min,
      max_call_attempts: cad.max_call_attempts,
      sms_fallback_after_min: cad.sms_fallback_after_min,
      email_fallback_after_min: cad.email_fallback_after_min,
      reminder_offsets_min: cad.reminder_offsets_min,
      on_machine: cad.on_machine,
      voicemail_counts_as_attempt: cad.voicemail_counts_as_attempt,
      voicemail_sms_immediate: cad.voicemail_sms_immediate,
      quiet_start: cad.quiet_start,
      quiet_end: cad.quiet_end,
    };
    // Upsert the single per-dealership cadence.
    const { data: existing } = await supabaseAdmin
      .from("cadences").select("id").eq("company_id", companyId).limit(1).maybeSingle();
    if (existing) await supabaseAdmin.from("cadences").update(allowed).eq("id", existing.id);
    else await supabaseAdmin.from("cadences").insert({ company_id: companyId, ...allowed });
  }

  if (body.voice || body.persona_prompt != null || body.customer_types) {
    const { data: company } = await supabaseAdmin
      .from("companies").select("settings").eq("id", companyId).single();
    const settings = { ...(company?.settings ?? {}) } as any;
    if (body.voice) settings.voice = body.voice;
    if (body.persona_prompt != null) settings.persona_prompt = body.persona_prompt;
    if (body.customer_types) settings.customer_types = body.customer_types;
    await supabaseAdmin.from("companies").update({ settings }).eq("id", companyId);
  }

  return c.json({ ok: true });
});

// ── Number pool ──────────────────────────────────────────────────────────────
settingsRoutes.get("/numbers", async (c) => {
  const companyId = cid(c);
  const { data } = await supabaseAdmin
    .from("phone_numbers").select("*").eq("company_id", companyId).order("created_at");
  const today = new Date().toISOString().slice(0, 10);
  const numbers = (data ?? []).map((n) => ({
    ...n,
    effective_cap_today: rampCap(n.ramp_started_on, n.daily_cap ?? 400, today),
  }));
  return c.json({ numbers });
});

settingsRoutes.post("/numbers", requireAdmin, async (c) => {
  const companyId = cid(c);
  const b = await c.req.json<any>();
  if (!b.e164) return c.json({ error: "e164 required" }, 422);
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabaseAdmin.from("phone_numbers").insert({
    company_id: companyId, e164: b.e164, provider: b.provider ?? "telnyx",
    vapi_phone_id: b.vapi_phone_id ?? null, cnam: b.cnam ?? null,
    weight: b.weight ?? 1, daily_cap: b.daily_cap ?? 400,
    enabled: b.enabled ?? true, ramp_started_on: b.ramp_started_on ?? today,
  }).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ number: data });
});

settingsRoutes.patch("/numbers/:id", requireAdmin, async (c) => {
  const companyId = cid(c);
  const b = await c.req.json<any>();
  const patch: any = {};
  for (const k of ["enabled", "weight", "daily_cap", "vapi_phone_id", "cnam", "quarantined_at", "ramp_started_on"]) {
    if (k in b) patch[k] = b[k];
  }
  const { data, error } = await supabaseAdmin.from("phone_numbers")
    .update(patch).eq("id", c.req.param("id")).eq("company_id", companyId).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json({ number: data });
});

settingsRoutes.delete("/numbers/:id", requireAdmin, async (c) => {
  const companyId = cid(c);
  await supabaseAdmin.from("phone_numbers")
    .delete().eq("id", c.req.param("id")).eq("company_id", companyId);
  return c.json({ ok: true });
});
