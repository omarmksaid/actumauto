/**
 * Vapi outbound call client (PLAN.md §5, §15). Config reflects the cost-optimized defaults:
 * BYO Anthropic key + Haiku for the live loop, Deepgram STT, Cartesia/Aura-2 TTS (A/B vs 11labs),
 * Telnyx number via Vapi.
 *
 * The `claim_id` is passed in metadata as the idempotency key — the reconciler (§4c) queries
 * Vapi by it before any retry, since Vapi has no native idempotency.
 */

import { env } from "../lib/env";

export interface PlaceCallInput {
  phoneNumberId: string;         // Vapi phone-number id (imported Telnyx number)
  toNumber: string;              // E.164
  systemPrompt: string;
  firstMessage: string;
  voiceId: string;
  ttsProvider: string;           // "cartesia" | "deepgram" | "11labs"
  claimId: string;               // idempotency key → metadata
  touchpointId: string;
  onMachine: "drop_message" | "hangup";
  voicemailMessage: string;
}

export interface PlaceCallResult {
  ok: boolean;
  vapiCallId?: string;
  error?: string;
  status?: number;               // HTTP status, so callers distinguish provider-down (5xx) from a bad request
}

export async function placeVapiCall(inp: PlaceCallInput): Promise<PlaceCallResult> {
  if (!env.VAPI_API_KEY) return { ok: false, error: "VAPI_API_KEY not configured" };

  const body = {
    phoneNumberId: inp.phoneNumberId,
    customer: { number: inp.toNumber },
    assistant: {
      firstMessage: inp.firstMessage,
      model: {
        provider: "anthropic",
        model: env.LLM_MODEL_CALL,               // Haiku for the live loop (§15)
        messages: [{ role: "system", content: inp.systemPrompt }],
      },
      voice: { provider: inp.ttsProvider, voiceId: inp.voiceId },
      transcriber: { provider: "deepgram", language: "multi" },
      voicemailDetection: { provider: "twilio" },
      voicemailMessage: inp.onMachine === "drop_message" ? inp.voicemailMessage : undefined,
      maxDurationSeconds: 420,
      endCallFunctionEnabled: true,
      recordingEnabled: true,
      // metadata carries ONLY identifiers — no per-customer content leaks across calls (§4).
      metadata: { touchpointId: inp.touchpointId, claimId: inp.claimId },
      server: { url: `${env.APP_URL}/webhooks/vapi`, secret: env.VAPI_WEBHOOK_SECRET },
    },
  };

  try {
    const res = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.VAPI_API_KEY}`,
        "Content-Type": "application/json",
        // BYO Anthropic key so LLM spend skips Vapi's markup and lands on our own bill (§15).
        ...(env.ANTHROPIC_API_KEY ? { "x-anthropic-api-key": env.ANTHROPIC_API_KEY } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `vapi ${res.status}: ${text.slice(0, 200)}`, status: res.status };
    }
    const data = await res.json();
    return { ok: true, vapiCallId: data.id, status: res.status };
  } catch (e: any) {
    return { ok: false, error: `network: ${e.message}` };
  }
}

/** Query Vapi for calls carrying a given claimId in metadata — the reconciler's dedup check (§4c). */
export async function findCallByClaimId(claimId: string): Promise<{ id: string } | null> {
  if (!env.VAPI_API_KEY) return null;
  try {
    const res = await fetch(`https://api.vapi.ai/call?limit=50`, {
      headers: { Authorization: `Bearer ${env.VAPI_API_KEY}` },
    });
    if (!res.ok) return null;
    const calls = await res.json();
    const match = (Array.isArray(calls) ? calls : []).find(
      (c: any) => c?.metadata?.claimId === claimId
    );
    return match ? { id: match.id } : null;
  } catch {
    return null;
  }
}
