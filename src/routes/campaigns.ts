/**
 * Campaigns API (PLAN.md §6). A campaign is a service-reminder run: pick an import + a window,
 * launch it → the slotter creates coalesced touchpoints → the scheduler dispatches them.
 * companyId from context; mutations require owner/admin.
 */

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";
import { requireAdmin } from "../lib/auth";
import { boss } from "../jobs/queue";

export const campaignRoutes = new Hono();
const cid = (c: any) => c.get("companyId") as string;

const DEFAULT_WINDOW_DAYS = 30;

campaignRoutes.get("/", async (c) => {
  const companyId = cid(c);
  const { data } = await supabaseAdmin
    .from("campaigns")
    .select("id, name, status, import_id, pacing, created_at")
    .eq("company_id", companyId).order("created_at", { ascending: false });
  return c.json({ campaigns: data ?? [] });
});

campaignRoutes.post("/", requireAdmin, async (c) => {
  const companyId = cid(c);
  const b = await c.req.json<any>();
  if (!b.name) return c.json({ error: "name required" }, 422);

  // Default to the dealership's single cadence.
  const { data: cadence } = await supabaseAdmin
    .from("cadences").select("id").eq("company_id", companyId).limit(1).maybeSingle();

  const { data, error } = await supabaseAdmin.from("campaigns").insert({
    company_id: companyId, name: b.name,
    import_id: b.import_id ?? null, cadence_id: b.cadence_id ?? cadence?.id ?? null,
    status: "draft",
    pacing: { window_days: b.window_days ?? DEFAULT_WINDOW_DAYS },
  }).select("*").maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ campaign: data });
});

campaignRoutes.get("/:id", async (c) => {
  const companyId = cid(c);
  const id = c.req.param("id");
  const { data: campaign } = await supabaseAdmin
    .from("campaigns").select("*").eq("id", id).eq("company_id", companyId).maybeSingle();
  if (!campaign) return c.json({ error: "not found" }, 404);

  // Progress: touchpoint counts by status for this campaign.
  const { data: tps } = await supabaseAdmin
    .from("touchpoints").select("status, outcome").eq("campaign_id", id);
  const t = tps ?? [];
  const progress = {
    total: t.length,
    scheduled: t.filter((x) => x.status === "scheduled").length,
    in_flight: t.filter((x) => x.status === "in_flight").length,
    completed: t.filter((x) => x.status === "completed").length,
    booked: t.filter((x) => x.outcome === "booked").length,
    canceled: t.filter((x) => x.status === "canceled").length,
  };
  return c.json({ campaign, progress });
});

campaignRoutes.post("/:id/launch", requireAdmin, async (c) => {
  const companyId = cid(c);
  const id = c.req.param("id");
  const { data: campaign } = await supabaseAdmin
    .from("campaigns").select("id, pacing, status").eq("id", id).eq("company_id", companyId).maybeSingle();
  if (!campaign) return c.json({ error: "not found" }, 404);

  await supabaseAdmin.from("campaigns").update({ status: "active" }).eq("id", id);
  const windowDays = (campaign.pacing as any)?.window_days ?? DEFAULT_WINDOW_DAYS;
  await boss.send("slot-campaign", { campaignId: id, windowDays },
    { singletonKey: `slot:${id}` });
  return c.json({ ok: true });
});

campaignRoutes.post("/:id/pause", requireAdmin, async (c) => {
  const companyId = cid(c);
  const id = c.req.param("id");
  await supabaseAdmin.from("campaigns")
    .update({ status: "paused" }).eq("id", id).eq("company_id", companyId);
  // Cancel this campaign's still-scheduled touchpoints so a pause actually stops outreach.
  const { data: pending } = await supabaseAdmin
    .from("touchpoints").select("id").eq("campaign_id", id).in("status", ["scheduled", "claiming"]);
  for (const p of pending ?? []) await boss.cancel("dispatch-voice", `dispatch:${p.id}`).catch(() => {});
  await supabaseAdmin.from("touchpoints")
    .update({ status: "canceled" }).eq("campaign_id", id).in("status", ["scheduled", "claiming"]);
  return c.json({ ok: true });
});
