/**
 * Resend email sender (PLAN.md §4). CAN-SPAM/CASL-style identification + a working unsubscribe on
 * every message (the /u/:customerId endpoint sets opted_out atomically). Fallback body when the
 * cadence didn't author one.
 */

import { Resend } from "resend";
import { env } from "../lib/env";
import { MessageContext, MessageSender, SendResult } from "./types";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

export const emailSender: MessageSender = {
  channel: "email",
  canReach: (ctx) => !!ctx.toEmail,

  async send(ctx: MessageContext): Promise<SendResult> {
    if (!resend) return { ok: false, error: "RESEND_API_KEY not configured" };
    if (!ctx.toEmail) return { ok: false, error: "no email" };

    const first = ctx.customerName.split(" ")[0] || "there";
    const body =
      ctx.body ??
      `Hi ${first},\n\nYour vehicle is coming due for service at ${ctx.dealershipName}. ` +
      `You can book a time that works for you here:\n${ctx.bookingLink}\n\n` +
      `We look forward to seeing you.\n\n${ctx.dealershipName} Service Team`;

    const unsub = `${env.WEB_URL}/u/${ctx.customerId}`;
    const footer =
      `\n\n—\n${ctx.dealershipName} Service Department\n` +
      `You're receiving this service reminder as a past customer. ` +
      `Unsubscribe: ${unsub}`;

    try {
      const { data, error } = await resend.emails.send({
        from: env.EMAIL_FROM,
        to: ctx.toEmail,
        subject: `${ctx.dealershipName} — your vehicle is due for service`,
        text: body + footer,
        headers: { "List-Unsubscribe": `<${unsub}>` },
      });
      if (error) return { ok: false, error: error.message, status: 502 };
      return { ok: true, providerMessageId: data?.id };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
};
