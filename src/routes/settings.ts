/**
 * Settings API (PLAN.md §6, §16). companyId from requireAuth context.
 * Mutations require owner/admin (requireAdmin). Reads are open to any member.
 *
 * INBOUND-ONLY: the outbound follow-up cadence (retry timing, SMS/email fallback, voicemail
 * branch, quiet hours) is gone along with outbound dialing.
 *
 *  GET  /settings                 company voice/persona + inbound config
 *  PUT  /settings                 update company.settings                     [admin]
 *  GET  /settings/numbers         the dealership's inbound numbers
 *  POST /settings/numbers         add a number                                [admin]
 *  PATCH/DELETE /settings/numbers/:id  update / remove a number               [admin]
 *  GET/POST/PATCH/DELETE /settings/services   the services catalog (§16c)     [admin to mutate]
 */

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";
import { requireAdmin } from "../lib/auth";

export const settingsRoutes = new Hono();
const cid = (c: any) => c.get("companyId") as string;

// ── Settings (voice/persona + inbound service line) ──────────────────────────
settingsRoutes.get("/", async (c) => {
  const companyId = cid(c);
  const { data: company } = await supabaseAdmin
    .from("companies").select("name, timezone, settings, business_hours, agent_enabled").eq("id", companyId).single();
  const settings = (company?.settings ?? {}) as any;
  return c.json({
    company: { name: company?.name, timezone: company?.timezone },
    // The agent quotes these to callers and refuses bookings outside them (§16d).
    business_hours: company?.business_hours ?? {},
    agent_enabled: company?.agent_enabled !== false,
    voice: settings.voice ?? { provider: "cartesia", voice_id: "" },
    persona_prompt: settings.persona_prompt ?? "",
    customer_types: settings.customer_types ?? ["loyal", "lapsed", "new", "vip"],
    // Inbound service line (§16). identify_mode defaults to caller_id_only: unmatched callers
    // get generic answers only and never have data read to them.
    inbound: {
      transfer_number: settings.inbound?.transfer_number ?? "",
      identify_mode: settings.inbound?.identify_mode ?? "caller_id_only",
      greeting: settings.inbound?.greeting ?? "",
      persona_prompt: settings.inbound?.persona_prompt ?? "",
      voice: settings.inbound?.voice ?? null,   // null ⇒ fall back to the default voice
    },
  });
});

settingsRoutes.put("/", requireAdmin, async (c) => {
  const companyId = cid(c);
  const body = await c.req.json<any>();

  if (body.business_hours) {
    const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const clean: Record<string, [string, string] | null> = {};
    for (const d of DAYS) {
      const v = (body.business_hours as any)[d];
      // A day is either a valid [open, close] pair or closed. Anything malformed becomes closed
      // rather than being stored half-formed — the agent would otherwise quote nonsense hours.
      if (Array.isArray(v) && v.length === 2 &&
          /^\d{2}:\d{2}$/.test(String(v[0])) && /^\d{2}:\d{2}$/.test(String(v[1])) &&
          String(v[0]) < String(v[1])) {
        clean[d] = [String(v[0]), String(v[1])];
      } else {
        clean[d] = null;
      }
    }
    await supabaseAdmin.from("companies").update({ business_hours: clean }).eq("id", companyId);
  }

  if (typeof body.agent_enabled === "boolean") {
    await supabaseAdmin.from("companies").update({ agent_enabled: body.agent_enabled }).eq("id", companyId);
  }

  if (body.voice || body.persona_prompt != null || body.customer_types || body.inbound) {
    const { data: company } = await supabaseAdmin
      .from("companies").select("settings").eq("id", companyId).single();
    const settings = { ...(company?.settings ?? {}) } as any;
    if (body.voice) settings.voice = body.voice;
    if (body.persona_prompt != null) settings.persona_prompt = body.persona_prompt;
    if (body.customer_types) settings.customer_types = body.customer_types;

    if (body.inbound) {
      const inb = body.inbound;
      const next = { ...(settings.inbound ?? {}) };
      if (inb.transfer_number != null) next.transfer_number = String(inb.transfer_number).trim();
      // Whitelisted — an arbitrary value here would change who the agent reads data to (§16a).
      if (inb.identify_mode && ["caller_id_only", "verbal_verify"].includes(inb.identify_mode)) {
        next.identify_mode = inb.identify_mode;
      }
      if (inb.greeting != null) next.greeting = String(inb.greeting);
      if (inb.persona_prompt != null) next.persona_prompt = String(inb.persona_prompt);
      if (inb.voice !== undefined) next.voice = inb.voice;
      settings.inbound = next;
    }

    await supabaseAdmin.from("companies").update({ settings }).eq("id", companyId);
  }

  return c.json({ ok: true });
});

// ── Services catalog: "the services we own" (§16c) ───────────────────────────
// Structured and dealership-edited. No price column by design — the no-invented-pricing guardrail
// holds on inbound, and a quoted price is a commitment the dealership has to honor.
settingsRoutes.get("/services", async (c) => {
  const companyId = cid(c);
  const { data } = await supabaseAdmin
    .from("service_offerings").select("*").eq("company_id", companyId)
    .order("category", { ascending: true }).order("name", { ascending: true });
  return c.json({ services: data ?? [] });
});

settingsRoutes.post("/services", requireAdmin, async (c) => {
  const companyId = cid(c);
  const b = await c.req.json<any>();
  if (!b.name?.trim()) return c.json({ error: "name required" }, 422);
  const { data, error } = await supabaseAdmin.from("service_offerings").insert({
    company_id: companyId,
    name: b.name.trim(),
    description: b.description ?? null,
    category: b.category ?? null,
    operations: Array.isArray(b.operations) ? b.operations : [],
    typical_duration_min: b.typical_duration_min ?? null,
    active: b.active ?? true,
  }).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ service: data });
});

settingsRoutes.patch("/services/:id", requireAdmin, async (c) => {
  const companyId = cid(c);
  const b = await c.req.json<any>();
  const patch: any = { updated_at: new Date().toISOString() };
  for (const k of ["name", "description", "category", "operations", "typical_duration_min", "active"]) {
    if (k in b) patch[k] = b[k];
  }
  const { data, error } = await supabaseAdmin.from("service_offerings")
    .update(patch).eq("id", c.req.param("id")).eq("company_id", companyId).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json({ service: data });
});

settingsRoutes.delete("/services/:id", requireAdmin, async (c) => {
  const companyId = cid(c);
  await supabaseAdmin.from("service_offerings")
    .delete().eq("id", c.req.param("id")).eq("company_id", companyId);
  return c.json({ ok: true });
});

// ── Inbound numbers (routing map, not a dialing pool) ────────────────────────
settingsRoutes.get("/numbers", async (c) => {
  const companyId = cid(c);
  // Inbound-only: these numbers are a ROUTING MAP (dialed number → dealership), not a dialing
  // pool. Caps, weights, warm-up ramp and answer-rate health were outbound pacing controls and
  // no longer apply.
  const { data } = await supabaseAdmin
    .from("phone_numbers")
    .select("id, e164, provider, vapi_phone_id, cnam, enabled, created_at")
    .eq("company_id", companyId).order("created_at");
  return c.json({ numbers: data ?? [] });
});

settingsRoutes.post("/numbers", requireAdmin, async (c) => {
  const companyId = cid(c);
  const b = await c.req.json<any>();
  if (!b.e164) return c.json({ error: "e164 required" }, 422);
  const { data, error } = await supabaseAdmin.from("phone_numbers").insert({
    company_id: companyId, e164: b.e164, provider: b.provider ?? "telnyx",
    vapi_phone_id: b.vapi_phone_id ?? null, cnam: b.cnam ?? null,
    enabled: b.enabled ?? true,
  }).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ number: data });
});

settingsRoutes.patch("/numbers/:id", requireAdmin, async (c) => {
  const companyId = cid(c);
  const b = await c.req.json<any>();
  const patch: any = {};
  for (const k of ["enabled", "vapi_phone_id", "cnam"]) {
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
