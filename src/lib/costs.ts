import { supabaseAdmin } from "./supabase";

/**
 * Cost recording. Rates are ESTIMATES for planning — update when providers reprice
 * (PLAN.md §15 says re-check quarterly). Vapi calls use the ACTUAL cost from the
 * end-of-call report when present, falling back to the per-minute estimate.
 * Everything lands in cost_events; the dashboard + daily_health aggregate.
 *
 * Provider defaults reflect §15: Telnyx telephony, Haiku live-loop model, Cartesia/Aura-2 TTS.
 */
export const RATES = {
  VOICE_PER_MIN: 0.13,        // all-in estimate: Vapi orchestration + Deepgram STT + Haiku + Cartesia TTS + Telnyx
  SMS: 0.004,                 // Telnyx outbound SMS
  EMAIL: 0.001,               // Resend
  LLM: {                      // USD per token
    "claude-haiku-4-5-20251001": { in: 1 / 1e6, out: 5 / 1e6 },
    "claude-sonnet-4-6": { in: 3 / 1e6, out: 15 / 1e6 },
    default: { in: 1 / 1e6, out: 5 / 1e6 },
  },
  EMBEDDING_PER_MTOK: 0.06,   // Voyage
};

export type CostCategory = "voice" | "sms" | "email" | "llm" | "embedding" | "analysis";

export async function recordCost(opts: {
  companyId: string;
  callId?: string | null;
  customerId?: string | null;
  category: CostCategory;
  amountUsd: number;
  meta?: Record<string, unknown>;
}) {
  if (!(opts.amountUsd > 0)) return;
  await supabaseAdmin.from("cost_events").insert({
    company_id: opts.companyId,
    call_id: opts.callId ?? null,
    customer_id: opts.customerId ?? null,
    category: opts.category,
    amount_usd: Number(opts.amountUsd.toFixed(6)),
    meta: opts.meta ?? {},
  }).then(({ error }) => { if (error) console.error("cost_events insert failed", error.message); });
}

export function llmCost(model: string, inputTokens: number, outputTokens: number): number {
  const r = (RATES.LLM as any)[model] ?? RATES.LLM.default;
  return inputTokens * r.in + outputTokens * r.out;
}
