/**
 * Vapi webhook — THIN durable handler (PLAN.md §5b).
 *
 * Does exactly three things: validate the shared secret, insert the raw payload into
 * webhook_events, return 200. NO inline processing — a bug in transcript parsing must never lose
 * the event. A pg-boss consumer (events.ts) does the real work off the stored payload, which is
 * the permanent replay log.
 */

import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { boss } from "../../jobs/queue";
import { env } from "../../lib/env";

export const vapiWebhooks = new Hono();

vapiWebhooks.post("/vapi", async (c) => {
  const secret = c.req.header("x-vapi-secret") ?? "";
  const valid = !!env.VAPI_WEBHOOK_SECRET && secret === env.VAPI_WEBHOOK_SECRET;

  let payload: any = {};
  try { payload = await c.req.json(); } catch { /* keep {} */ }

  const eventType = payload?.message?.type ?? "unknown";
  // Inbound calls carry no touchpoint (no scheduled work sits behind them) — the processor
  // resolves the call by its Vapi call id instead.

  const { data, error } = await supabaseAdmin.from("webhook_events").insert({
    provider: "vapi",
    event_type: eventType,
    raw_payload: payload,
    signature_valid: valid,
  }).select("id").single();

  // Even on an invalid signature we persist (for audit) but don't enqueue processing.
  if (!error && valid && data) {
    // Log enqueue failures. Swallowing them silently leaves rows in webhook_events forever with
    // processed_at null and no clue why — the event is safe, but nothing ever acts on it.
    await boss.send("process-webhook", { webhookEventId: data.id },
      { singletonKey: `webhook:${data.id}` })
      .catch((e) => console.error("[webhook] enqueue failed:", e?.message ?? e));
  }

  // Always 200 quickly so Vapi doesn't exhaust its limited retries.
  return c.json({ received: true });
});
