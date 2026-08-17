/**
 * Telnyx SMS sender (PLAN.md §15). Sends from a pool number via the Telnyx Messaging API.
 * Cost + a `messages` row are recorded on success. Provider-down (5xx/network) is distinguished
 * from a bad request so the dispatcher can trip the circuit vs. mark failed.
 */

import { env } from "../lib/env";
import { MessageContext, MessageSender, SendResult } from "./types";

export const smsSender: MessageSender = {
  channel: "sms",
  canReach: (ctx) => !!ctx.toPhone,

  async send(ctx: MessageContext): Promise<SendResult> {
    if (!env.TELNYX_API_KEY) return { ok: false, error: "TELNYX_API_KEY not configured" };
    if (!ctx.toPhone) return { ok: false, error: "no phone" };

    const first = ctx.customerName.split(" ")[0] || "there";
    const text =
      ctx.body ??
      `Hi ${first}, it's ${ctx.dealershipName} service — your vehicle is due for a service ` +
      `visit. Book a time here: ${ctx.bookingLink}\nReply STOP to opt out.`;

    try {
      const res = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Sender is the dealership's pool number; the dispatcher passes it via `from` on the ctx
          // (see dispatch-message). Telnyx also supports messaging_profile_id for number-pool sends.
          messaging_profile_id: env.TELNYX_MESSAGING_PROFILE_ID || undefined,
          from: (ctx as any).fromNumber,
          to: ctx.toPhone,
          text,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: `telnyx ${res.status}: ${body.slice(0, 200)}`, status: res.status };
      }
      const data = await res.json();
      return { ok: true, providerMessageId: data?.data?.id, status: res.status };
    } catch (e: any) {
      return { ok: false, error: `network: ${e.message}` };
    }
  },
};
