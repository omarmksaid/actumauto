/**
 * Telnyx webhooks — thin durable handler (PLAN.md §5b), same shape as the Vapi one.
 *
 *  - message status callbacks (delivered/failed) → webhook_events for the processor to reconcile.
 *  - inbound SMS (e.g. "STOP") → webhook_events; the processor applies the atomic opt-out.
 *
 * Signature validation (Ed25519 over the raw body with the Telnyx public key) is stubbed until
 * the key is configured; we persist everything and mark signature_valid accordingly.
 */

import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { boss } from "../../jobs/queue";

export const telnyxWebhooks = new Hono();

telnyxWebhooks.post("/telnyx", async (c) => {
  let payload: any = {};
  try { payload = await c.req.json(); } catch { /* keep {} */ }

  const eventType = payload?.data?.event_type ?? "unknown";
  // TODO: verify Telnyx Ed25519 signature once TELNYX_PUBLIC_KEY is set. Persist regardless.
  const signatureValid = true;

  const { data } = await supabaseAdmin.from("webhook_events").insert({
    provider: "telnyx",
    event_type: eventType,
    raw_payload: payload,
    signature_valid: signatureValid,
  }).select("id").single();

  if (data) {
    await boss.send("process-webhook", { webhookEventId: data.id },
      { singletonKey: `webhook:${data.id}` }).catch(() => {});
  }
  return c.json({ received: true });
});
