/**
 * Resend email sender.
 *
 * Kept from the outbound era but rescoped: there are no more service-reminder campaigns, so this
 * is now a plain transactional sender for things that follow an INBOUND call — e.g. emailing a
 * caller their booking details after the agent captures a request.
 *
 * NOT CURRENTLY WIRED. Nothing calls it yet; it's here so the Resend integration doesn't have to
 * be rebuilt when the first transactional email is needed. Identification + a working unsubscribe
 * link are retained because any dealership email should carry them.
 */

import { Resend } from "resend";
import { env } from "../lib/env";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

export interface EmailInput {
  toEmail: string;
  customerId: string;
  customerName: string;
  dealershipName: string;
  subject: string;
  body: string;
}

export interface EmailResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  status?: number;
}

export async function sendEmail(inp: EmailInput): Promise<EmailResult> {
  if (!resend) return { ok: false, error: "RESEND_API_KEY not configured" };
  if (!inp.toEmail) return { ok: false, error: "no email" };

  const unsub = `${env.WEB_URL}/u/${inp.customerId}`;
  const footer =
    `\n\n—\n${inp.dealershipName} Service Department\n` +
    `Unsubscribe: ${unsub}`;

  try {
    const { data, error } = await resend.emails.send({
      from: env.EMAIL_FROM,
      to: inp.toEmail,
      subject: inp.subject,
      text: inp.body + footer,
      headers: { "List-Unsubscribe": `<${unsub}>` },
    });
    if (error) return { ok: false, error: error.message, status: 502 };
    return { ok: true, providerMessageId: data?.id };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
