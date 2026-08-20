/**
 * Service schedules API (PLAN.md §2, §6).
 *
 * These are the maintenance intervals the due engine reads. On an INBOUND call they're what lets
 * the agent answer "what else is my car due for?" — `computeDue` matches the caller's vehicle to a
 * schedule and picks the next unmet interval (§16d). Editing them here directly changes what the
 * agent recommends, which is why dealership-verified data matters more than the seeded defaults.
 *
 * A company-owned schedule wins over the platform-global seed (company_id null), so a dealership
 * can correct the seeded Toyota data without it being overwritten.
 */

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";
import { requireAdmin } from "../lib/auth";

export const scheduleRoutes = new Hono();
const cid = (c: any) => c.get("companyId") as string;

// ── List schedules (this dealership's + the global seed) with their intervals ──
scheduleRoutes.get("/", async (c) => {
  const companyId = cid(c);

  const { data: schedules } = await supabaseAdmin
    .from("service_schedules")
    .select("id, company_id, make, model, year_from, year_to, source, notes")
    .or(`company_id.eq.${companyId},company_id.is.null`)
    .order("make").order("model", { nullsFirst: true });

  const ids = (schedules ?? []).map((s) => s.id);
  const { data: intervals } = ids.length
    ? await supabaseAdmin
        .from("service_intervals")
        .select("id, schedule_id, mileage, months, service_name, operations, severity")
        .in("schedule_id", ids)
        .order("mileage", { ascending: true, nullsFirst: false })
    : { data: [] };

  const bySchedule = new Map<string, any[]>();
  for (const iv of intervals ?? []) {
    if (!bySchedule.has(iv.schedule_id)) bySchedule.set(iv.schedule_id, []);
    bySchedule.get(iv.schedule_id)!.push(iv);
  }

  return c.json({
    schedules: (schedules ?? []).map((s) => ({
      ...s,
      // The seed is shared across dealerships — the UI must not offer to edit it in place.
      is_global: s.company_id === null,
      intervals: bySchedule.get(s.id) ?? [],
    })),
  });
});

// ── Create a dealership-owned schedule ───────────────────────────────────────
scheduleRoutes.post("/", requireAdmin, async (c) => {
  const companyId = cid(c);
  const b = await c.req.json<any>();
  if (!b.make?.trim()) return c.json({ error: "make required" }, 422);

  const { data, error } = await supabaseAdmin.from("service_schedules").insert({
    company_id: companyId,                      // never null — dealerships can't edit the global seed
    make: b.make.trim(),
    model: b.model?.trim() || null,
    year_from: b.year_from ?? null,
    year_to: b.year_to ?? null,
    source: b.source ?? "Dealership-provided",
    notes: b.notes ?? null,
  }).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ schedule: { ...data, is_global: false, intervals: [] } });
});

/** Guard: only this dealership's own schedules may be modified — never the shared global seed. */
async function ownsSchedule(companyId: string, scheduleId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("service_schedules").select("company_id").eq("id", scheduleId).maybeSingle();
  return !!data && data.company_id === companyId;
}

scheduleRoutes.delete("/:id", requireAdmin, async (c) => {
  const companyId = cid(c);
  const id = c.req.param("id");
  if (!(await ownsSchedule(companyId, id))) return c.json({ error: "not found" }, 404);
  await supabaseAdmin.from("service_schedules").delete().eq("id", id).eq("company_id", companyId);
  return c.json({ ok: true });
});

// ── Intervals ────────────────────────────────────────────────────────────────
scheduleRoutes.post("/:id/intervals", requireAdmin, async (c) => {
  const companyId = cid(c);
  const scheduleId = c.req.param("id");
  if (!(await ownsSchedule(companyId, scheduleId))) return c.json({ error: "not found" }, 404);

  const b = await c.req.json<any>();
  if (!b.service_name?.trim()) return c.json({ error: "service_name required" }, 422);
  // An interval with neither axis can never come due, so it would silently do nothing.
  if (b.mileage == null && b.months == null) {
    return c.json({ error: "set a mileage, a month interval, or both" }, 422);
  }

  const { data, error } = await supabaseAdmin.from("service_intervals").insert({
    schedule_id: scheduleId,
    mileage: b.mileage ?? null,
    months: b.months ?? null,
    service_name: b.service_name.trim(),
    operations: Array.isArray(b.operations) ? b.operations : [],
    severity: ["standard", "major", "safety"].includes(b.severity) ? b.severity : "standard",
  }).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ interval: data });
});

scheduleRoutes.patch("/:id/intervals/:intervalId", requireAdmin, async (c) => {
  const companyId = cid(c);
  const scheduleId = c.req.param("id");
  if (!(await ownsSchedule(companyId, scheduleId))) return c.json({ error: "not found" }, 404);

  const b = await c.req.json<any>();
  const patch: any = {};
  if ("mileage" in b) patch.mileage = b.mileage === null || b.mileage === "" ? null : Number(b.mileage);
  if ("months" in b) patch.months = b.months === null || b.months === "" ? null : Number(b.months);
  if (b.service_name?.trim()) patch.service_name = b.service_name.trim();
  if (Array.isArray(b.operations)) patch.operations = b.operations;
  if (["standard", "major", "safety"].includes(b.severity)) patch.severity = b.severity;

  // An interval with neither axis can never come due — it would silently do nothing.
  const mileage = "mileage" in patch ? patch.mileage : undefined;
  const months = "months" in patch ? patch.months : undefined;
  if (mileage === null && months === null) {
    return c.json({ error: "set a mileage, a month interval, or both" }, 422);
  }

  const { data, error } = await supabaseAdmin.from("service_intervals")
    .update(patch).eq("id", c.req.param("intervalId")).eq("schedule_id", scheduleId)
    .select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json({ interval: data });
});

scheduleRoutes.delete("/:id/intervals/:intervalId", requireAdmin, async (c) => {
  const companyId = cid(c);
  const scheduleId = c.req.param("id");
  if (!(await ownsSchedule(companyId, scheduleId))) return c.json({ error: "not found" }, 404);
  await supabaseAdmin.from("service_intervals")
    .delete().eq("id", c.req.param("intervalId")).eq("schedule_id", scheduleId);
  return c.json({ ok: true });
});
