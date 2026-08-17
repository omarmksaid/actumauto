/**
 * Channel senders (PLAN.md §4). SMS + email follow-ups go through the SAME claim → gate →
 * confirm discipline as voice (§4b) — a non-idempotent send under at-least-once delivery must not
 * double-fire. Voice is handled by src/dispatch (it's a longer flow with a live call); SMS/email
 * are short request/response sends and share this simpler adapter shape.
 *
 * Adding a channel later = one new file implementing MessageSender + a registry entry.
 */

export interface MessageContext {
  companyId: string;
  customerId: string;
  touchpointId: string;
  toPhone: string | null;
  toEmail: string | null;
  customerName: string;
  dealershipName: string;
  /** Deep link the customer taps to book (built by the dispatcher from WEB_URL). */
  bookingLink: string;
  /** Optional AI-authored body; adapters fall back to a default when absent. */
  body?: string;
}

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  /** HTTP status so callers separate provider-down (5xx / network) from a bad request. */
  status?: number;
}

export interface MessageSender {
  channel: "sms" | "email";
  canReach(ctx: MessageContext): boolean;
  send(ctx: MessageContext): Promise<SendResult>;
}

const registry = new Map<string, MessageSender>();
export const registerSender = (s: MessageSender) => registry.set(s.channel, s);
export const getSender = (channel: string) => registry.get(channel);
