/**
 * Inbound Vapi assistant config (PLAN.md §16e).
 *
 * Returned synchronously from the `assistant-request` webhook. Same provider defaults as outbound
 * (§15: BYO Anthropic key + Haiku for the live loop, Deepgram STT, Cartesia/Aura-2 TTS).
 *
 * THE TOOL CONTRACT (§8 invariant 2, extended to inbound): no tool takes a company_id or a
 * customer_id. Identity is resolved server-side from the Vapi call id and pinned to the call, so
 * the model cannot widen its own access by claiming to be someone else — and an anonymous call
 * gets nothing back regardless of what it asks for.
 */

import { env } from "../lib/env";
import type { InboundContext } from "./identify";
import { buildInboundSystemPrompt, buildInboundGreeting } from "./prompt";
import { getBookingProvider } from "../booking";

/** Tools the inbound agent can call. The server resolves identity; these carry only intent. */
function toolDefinitions(ctx: InboundContext) {
  const url = `${env.APP_URL}/inbound/tools`;
  // Vapi persists `headers`, not `secret` — a `secret` here is silently dropped and every tool
  // call would arrive unauthenticated (same failure mode as the phone-number config, see SETUP).
  const server = { url, headers: { "x-vapi-secret": env.VAPI_WEBHOOK_SECRET } };

  const tools: any[] = [
    {
      type: "function",
      function: {
        name: "lookup_services",
        description:
          "Look up services this dealership offers. Use when the caller asks whether we do " +
          "something, or what a service involves. Returns only real catalog entries — never prices.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What the caller asked about, e.g. 'brakes', 'alignment'." },
          },
          required: ["query"],
        },
      },
      server,
    },
    {
      type: "function",
      function: {
        name: "transfer_to_service",
        description:
          "Transfer the caller to a service employee. Use for: where is my car / is it ready, " +
          "pricing or billing, complaints, a request for a person, or anything you can't answer.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              enum: ["where_is_my_car", "pricing", "complaint", "requested_human", "out_of_scope", "other"],
              description: "Why you're transferring.",
            },
            vehicle_hint: {
              type: "string",
              description: "Any vehicle the caller mentioned, in their words (e.g. 'silver RAV4'). Optional.",
            },
            notes: { type: "string", description: "One line of context for the advisor picking up." },
          },
          required: ["reason"],
        },
      },
      server,
    },
  ];

  // Customer-scoped tools are only OFFERED on an identified call. They also refuse server-side on
  // an anonymous call (defense in depth) — but not advertising them keeps the model from trying.
  if (ctx.customerId) {
    tools.push(
      {
        type: "function",
        function: {
          name: "get_my_vehicles",
          description:
            "Get the caller's vehicles on file. Use if they ask what we have for them, or you " +
            "need to confirm which car they mean.",
          parameters: { type: "object", properties: {} },
        },
        server,
      },
      {
        type: "function",
        function: {
          name: "get_due_service",
          description:
            "Get what service is coming due on the caller's vehicles, and what it involves. Use " +
            "after resolving what they called about, to recommend service.",
          parameters: { type: "object", properties: {} },
        },
        server,
      },
      {
        type: "function",
        function: {
          name: "book_service",
          description:
            "Capture a service appointment request for the caller. Call once per vehicle. Use the " +
            "wording this tool returns — do not promise a firm time it didn't confirm.",
          parameters: {
            type: "object",
            properties: {
              preferred_time: {
                type: "string",
                description: "The day/time the caller asked for, in their words (e.g. 'Tuesday morning').",
              },
              vehicle_id: {
                type: "string",
                description: "The id from get_my_vehicles for the car being booked. Omit if only one vehicle.",
              },
              service_ops: {
                type: "array",
                items: { type: "string" },
                description: "What they're coming in for.",
              },
              notes: { type: "string", description: "Anything the advisor should know." },
            },
            required: ["preferred_time"],
          },
        },
        server,
      }
    );
  }

  return tools;
}


/**
 * Vapi's TTS block. A provider with an EMPTY voiceId fails the pipeline instantly
 * (`pipeline-error-<provider>-voice-failed`) and the caller hears silence, so never emit one:
 * fall back to a provider/voice pair that works out of the box with no extra credentials.
 */
function resolveVoice(voice: { provider: string; voice_id: string }) {
  if (voice.voice_id?.trim()) {
    return { provider: voice.provider, voiceId: voice.voice_id.trim() };
  }
  // Vapi-managed default — no per-provider key required.
  return { provider: "vapi", voiceId: "Elliot" };
}

export function buildInboundAssistant(ctx: InboundContext, voice: { provider: string; voice_id: string }) {
  const bookingMode = getBookingProvider().mode;

  return {
    name: `${ctx.companyName} — inbound service`,
    firstMessage: buildInboundGreeting(ctx),
    model: {
      provider: "anthropic",
      model: env.LLM_MODEL_CALL,                 // Haiku: cheaper AND lower latency in a voice loop (§15)
      messages: [{ role: "system", content: buildInboundSystemPrompt(ctx, bookingMode) }],
      tools: toolDefinitions(ctx),
    },
    voice: resolveVoice(voice),
    transcriber: { provider: "deepgram", language: "multi" },
    maxDurationSeconds: 900,                     // inbound runs longer than a reminder call
    endCallFunctionEnabled: true,
    recordingEnabled: true,
    // Identifiers only — no per-caller content in metadata (§4 no-leakage rule).
    metadata: {
      direction: "inbound",
      companyId: ctx.companyId,
      customerId: ctx.customerId,
    },
    server: {
      url: `${env.APP_URL}/webhooks/vapi`,
      headers: { "x-vapi-secret": env.VAPI_WEBHOOK_SECRET },
    },
  };
}
